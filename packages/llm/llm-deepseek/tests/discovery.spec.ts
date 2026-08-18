import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as LlmDeepSeek from '../src/index.ts'
import { discoverDeepSeekModels } from '../src/discovery.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('DeepSeek credential discovery', () => {
  it('uses bearer auth and returns the authenticated model list', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer aaaa')
      expect(init?.redirect).toBe('manual')
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, fetcher)).resolves.toEqual([
      { id: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro' },
    ])
    expect(fetcher).toHaveBeenCalledWith('https://api.deepseek.test/models', expect.any(Object))
  })

  it('classifies rejected credentials without echoing the key', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 401 }))
    let error: Error | undefined
    try {
      await discoverDeepSeekModels({
        baseURL: 'https://api.deepseek.test',
        apiKey: 'zzzz',
      }, fetcher)
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause))
    }
    expect(error?.message).toMatch(/API Key 无效/)
    expect(error?.message).not.toContain('zzzz')
  })

  it('refuses credential-bearing redirects and malformed listings', async () => {
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response('', { status: 302 }))).rejects.toThrow(/拒绝.*跳转/)
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response(JSON.stringify({ models: [] }), { status: 200 }))).rejects.toThrow(/data 数组/)
  })

  it('rejects invalid key text, forbidden credentials and provider failures', async () => {
    const unused = vi.fn<typeof fetch>()
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: '   ',
    }, unused)).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(unused).not.toHaveBeenCalled()

    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response(null, { status: 403 }))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })

    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response(null, { status: 503 }))).rejects.toThrow(/HTTP 503/)
  })

  it('classifies caller cancellation, timeout and ordinary connection errors', async () => {
    const caller = new AbortController()
    caller.abort(new Error('fixture caller cancellation'))
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
      signal: caller.signal,
    }, async () => { throw new Error('fixture fetch failure') })).rejects.toMatchObject({ code: 'ABORTED' })

    const timedOut = new AbortController()
    timedOut.abort(new Error('fixture timeout'))
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timedOut.signal)
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => { throw new Error('fixture fetch failure') })).rejects.toMatchObject({ code: 'TIMEOUT' })

    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => { throw new Error('fixture fetch failure') })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('bounds declared and streamed response bodies', async () => {
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test/',
      apiKey: 'aaaa',
    }, async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    }))).rejects.toThrow(/oversized model listing/)

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1))
        controller.close()
      },
    })
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response(oversized, { status: 200 }))).rejects.toThrow(/oversized model listing/)
  })

  it('rejects empty and invalid JSON listings without leaking response details', async () => {
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response(null, { status: 200 }))).rejects.toThrow(/无法识别/)

    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response('{not-json', { status: 200 }))).rejects.toThrow(/无法识别/)

    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response('null', { status: 200 }))).rejects.toThrow(/data 数组/)
  })

  it('filters malformed, blank and duplicate model ids', async () => {
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response(JSON.stringify({
      data: [null, {}, { id: 7 }, { id: '' }, { id: 'valid-model' }, { id: 'valid-model' }],
    }), { status: 200, headers: { 'content-length': '128' } }))).resolves.toEqual([{ id: 'valid-model' }])

    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => new Response(JSON.stringify({ data: [null, { id: '' }] }), { status: 200 })))
      .rejects.toThrow(/没有返回可用模型/)
  })

  it('tolerates a reader whose final cancellation rejects', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ data: [{ id: 'reader-model' }] }))
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: bytes })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn().mockRejectedValue(new Error('fixture cancel rejection')),
    }
    const response = {
      headers: new Headers(),
      body: { getReader: () => reader },
      status: 200,
      ok: true,
    } as unknown as Response
    await expect(discoverDeepSeekModels({
      baseURL: 'https://api.deepseek.test',
      apiKey: 'aaaa',
    }, async () => response)).resolves.toEqual([{ id: 'reader-model' }])
    expect(reader.cancel).toHaveBeenCalledOnce()
  })

  it('registers discovery with configured defaults and request overrides', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'aaaa')
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ id: 'registered-model' }] }), {
      status: 200,
    }))
    vi.stubGlobal('fetch', fetcher)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { baseURL: 'https://configured.deepseek.test' })

    await expect(ctx.llm.discoverModels('llm-deepseek', {
      baseURL: 'https://request.deepseek.test',
      apiKey: 'bbbb',
    })).resolves.toEqual([{ id: 'registered-model' }])
    await expect(ctx.llm.discoverModels('llm-deepseek', {
      provider: 'deepseek-official',
    })).resolves.toEqual([{ id: 'registered-model' }])

    expect(fetcher.mock.calls[0]?.[0]).toBe('https://request.deepseek.test/models')
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer bbbb')
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://configured.deepseek.test/models')
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer aaaa')
  })
})
