import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export type KnowledgeModuleId = 'benchmarks' | 'factory'

export interface KnowledgeModuleSelection {
  benchmarks: boolean
  factory: boolean
}

export const KNOWLEDGE_MODULE_DIRECTORIES: Readonly<Record<KnowledgeModuleId, string>> = Object.freeze({
  benchmarks: '07-对标博主库',
  factory: '08-自媒体工厂',
})

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 4096
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const value of buffer) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function safeArchiveName(name: string): string {
  const normalized = name.replaceAll('\\', '/')
  const segments = normalized.split('/')
  if (!normalized || normalized.startsWith('/') || segments.includes('..') || segments.includes('')) {
    if (normalized.endsWith('/') && segments.at(-1) === '') segments.pop()
    else throw new Error('知识库压缩包包含不安全路径')
  }
  return normalized
}

function excludedDirectory(name: string, selection: KnowledgeModuleSelection): boolean {
  const top = name.replace(/\/$/u, '').split('/')[0]
  return (!selection.benchmarks && top === KNOWLEDGE_MODULE_DIRECTORIES.benchmarks)
    || (!selection.factory && top === KNOWLEDGE_MODULE_DIRECTORIES.factory)
}

export async function readBoundedArchive(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`下载知识库失败（HTTP ${response.status}）`)
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new Error('知识库压缩包超过大小限制')
  if (response.body === null) throw new Error('知识库下载响应为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_ARCHIVE_BYTES) throw new Error('知识库压缩包超过大小限制')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total)
}

export async function extractKnowledgeArchive(
  archive: Buffer,
  destination: string,
  selection: KnowledgeModuleSelection,
): Promise<void> {
  let offset = 0
  let entries = 0
  let extractedBytes = 0
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    entries += 1
    if (entries > MAX_ARCHIVE_ENTRIES) throw new Error('知识库压缩包文件数量超过限制')
    if (offset + 30 > archive.length) throw new Error('知识库压缩包头已截断')
    const flags = archive.readUInt16LE(offset + 6)
    const method = archive.readUInt16LE(offset + 8)
    const checksum = archive.readUInt32LE(offset + 14)
    const compressedSize = archive.readUInt32LE(offset + 18)
    const uncompressedSize = archive.readUInt32LE(offset + 22)
    const nameLength = archive.readUInt16LE(offset + 26)
    const extraLength = archive.readUInt16LE(offset + 28)
    if ((flags & 0x0008) !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error('知识库压缩包使用了不支持的编码')
    }
    extractedBytes += uncompressedSize
    if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error('知识库解压体积超过限制')
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > archive.length) throw new Error('知识库压缩包内容已截断')
    const name = safeArchiveName(archive.subarray(nameStart, nameStart + nameLength).toString('utf8'))
    const data = archive.subarray(dataStart, dataEnd)
    if (crc32(data) !== checksum) throw new Error(`知识库文件校验失败：${basename(name)}`)
    if (!excludedDirectory(name, selection)) {
      const target = join(destination, ...name.split('/'))
      if (name.endsWith('/')) await mkdir(target, { recursive: true })
      else {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, data, { mode: 0o644 })
      }
    }
    offset = dataEnd
  }
  if (offset === 0) throw new Error('知识库压缩包不包含文件')
}

async function copyBundledTemplate(
  templateRoot: string,
  destination: string,
  selection: KnowledgeModuleSelection,
): Promise<void> {
  await cp(templateRoot, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (source) => {
      const name = source.slice(templateRoot.length).replace(/^[/\\]+/u, '').replaceAll('\\', '/')
      return !name || !excludedDirectory(name, selection)
    },
  })
}

export async function installKnowledgeDirectory(options: {
  target: string
  templateRoot: string
  assetUrl: string
  sha256: string
  selection: KnowledgeModuleSelection
  download: (url: string) => Promise<Response>
  onProgress?: (phase: 'downloading' | 'verifying' | 'installing', progress: number) => void
  validate: (root: string) => Promise<void>
}): Promise<{ source: 'github-release' | 'bundled-fallback' }> {
  if (await exists(options.target)) throw new Error('默认知识库目录已存在；请选择已有知识库或更换目录')
  const temporary = join(dirname(options.target), `.${basename(options.target)}.jimu-${randomUUID()}.tmp`)
  let source: 'github-release' | 'bundled-fallback' = 'github-release'
  let renamed = false
  await mkdir(temporary, { recursive: true })
  try {
    try {
      options.onProgress?.('downloading', 15)
      const archive = await readBoundedArchive(await options.download(options.assetUrl))
      options.onProgress?.('verifying', 45)
      const digest = createHash('sha256').update(archive).digest('hex')
      if (digest !== options.sha256) throw new Error('知识库 Release 的 SHA-256 与锁文件不一致')
      options.onProgress?.('installing', 65)
      await extractKnowledgeArchive(archive, temporary, options.selection)
    } catch {
      source = 'bundled-fallback'
      await rm(temporary, { recursive: true, force: true })
      options.onProgress?.('installing', 65)
      await copyBundledTemplate(options.templateRoot, temporary, options.selection)
    }
    await options.validate(temporary)
    await rename(temporary, options.target)
    renamed = true
    return { source }
  } finally {
    if (!renamed) await rm(temporary, { recursive: true, force: true })
  }
}

export async function installMissingKnowledgeModules(options: {
  root: string
  templateRoot: string
  modules: readonly KnowledgeModuleId[]
}): Promise<void> {
  for (const id of options.modules) {
    const directory = KNOWLEDGE_MODULE_DIRECTORIES[id]
    const target = join(options.root, directory)
    if (await exists(target)) continue
    const temporary = join(options.root, `.${directory}.jimu-${randomUUID()}.tmp`)
    let renamed = false
    try {
      await cp(join(options.templateRoot, directory), temporary, { recursive: true, force: false, errorOnExist: true })
      await rename(temporary, target)
      renamed = true
    } finally {
      if (!renamed) await rm(temporary, { recursive: true, force: true })
    }
  }
}

export async function readKnowledgeTemplateLock(path: string): Promise<{
  assetUrl: string
  sha256: string
  templateVersion: string
}> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('知识库锁文件无效')
  const record = value as Record<string, unknown>
  if (typeof record.assetUrl !== 'string' || !record.assetUrl.startsWith('https://github.com/i-YOLO/JiMu-Knowledge/releases/')) {
    throw new Error('知识库锁文件下载地址无效')
  }
  if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256)) throw new Error('知识库锁文件摘要无效')
  if (typeof record.templateVersion !== 'string') throw new Error('知识库锁文件版本无效')
  return { assetUrl: record.assetUrl, sha256: record.sha256, templateVersion: record.templateVersion }
}
