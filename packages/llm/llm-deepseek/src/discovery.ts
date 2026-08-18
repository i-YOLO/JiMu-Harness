import {
  INVALID_CREDENTIAL_CODE,
  LlmError,
  normalizeApiKey,
  type LlmDiscoveredModel,
  type LlmModelDiscoveryRequest,
} from '@deepseek-ai/dsh-llm'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const DISCOVERY_TIMEOUT_MS = 15_000

function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/u, '')}/models`
}

async function readBounded(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new LlmError(`${url} returned an oversized model listing`, 'DISCOVERY_FAILED')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new LlmError(`${url} returned an oversized model listing`, 'DISCOVERY_FAILED')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/**
 * Verify one DeepSeek endpoint credential through its authenticated model list.
 * @param request - resolved endpoint and one-shot credential to test.
 * @param fetchImpl - injectable fetch used by keyless provider tests.
 * @returns model ids advertised by the endpoint.
 */
export async function discoverDeepSeekModels(
  request: LlmModelDiscoveryRequest & { baseURL: string; apiKey: string },
  fetchImpl: typeof fetch = fetch,
): Promise<readonly LlmDiscoveredModel[]> {
  const checked = normalizeApiKey(request.apiKey)
  if (!checked.ok) throw new LlmError('DeepSeek API Key 格式无效', INVALID_CREDENTIAL_CODE)
  const url = listingUrl(request.baseURL)
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${checked.value}`, accept: 'application/json' },
      redirect: 'manual',
      signal,
    })
  } catch (error) {
    if (request.signal?.aborted) throw new LlmError('DeepSeek 连接测试已取消', 'ABORTED', { cause: error })
    if (timeout.aborted) throw new LlmError('DeepSeek 连接测试超时，请检查网络后重试', 'TIMEOUT', { cause: error })
    throw new LlmError('无法连接 DeepSeek 服务，请检查网络和 API 地址', 'DISCOVERY_FAILED', { cause: error })
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel()
    throw new LlmError('DeepSeek API Key 无效或无权访问', INVALID_CREDENTIAL_CODE)
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel()
    throw new LlmError('DeepSeek 连接测试拒绝携带凭据跳转', 'DISCOVERY_FAILED')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LlmError(`DeepSeek 模型列表请求失败（HTTP ${response.status}）`, 'DISCOVERY_FAILED')
  }
  let value: unknown
  try {
    value = JSON.parse(await readBounded(response, url))
  } catch (error) {
    if (error instanceof LlmError) throw error
    throw new LlmError('DeepSeek 返回了无法识别的模型列表', 'DISCOVERY_FAILED', { cause: error })
  }
  const data = (value as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw new LlmError('DeepSeek 返回的模型列表缺少 data 数组', 'DISCOVERY_FAILED')
  const seen = new Set<string>()
  const models: LlmDiscoveredModel[] = []
  for (const item of data) {
    const id = (item as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    models.push({ id })
  }
  if (models.length === 0) throw new LlmError('DeepSeek 账户没有返回可用模型', 'DISCOVERY_FAILED')
  return models
}
