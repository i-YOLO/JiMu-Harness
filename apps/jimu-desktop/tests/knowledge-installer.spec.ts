import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractKnowledgeArchive,
  installKnowledgeDirectory,
  installMissingKnowledgeModules,
} from '../src/main/knowledge-installer.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; template: string }> {
  const root = await mkdtemp(join(tmpdir(), 'jimu-installer-fixture-'))
  roots.push(root)
  const template = join(root, 'template')
  await Promise.all([
    mkdir(join(template, '00-System'), { recursive: true }),
    mkdir(join(template, '07-对标博主库'), { recursive: true }),
    mkdir(join(template, '08-自媒体工厂', '03-素材库'), { recursive: true }),
  ])
  await writeFile(join(template, 'jimu-knowledge.json'), '{}\n')
  await writeFile(join(template, '07-对标博主库', '.gitkeep'), '')
  await writeFile(join(template, '08-自媒体工厂', '03-素材库', '.gitkeep'), '')
  return { root, template }
}

function storedZipEntry(name: string): Buffer {
  const encoded = Buffer.from(name)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(encoded.length, 26)
  return Buffer.concat([header, encoded])
}

describe('JiMu Knowledge installer', () => {
  it('falls back to the bundled template and omits disabled modules', async () => {
    const { root, template } = await fixture()
    const target = join(root, 'JiMu-Knowledge')
    const result = await installKnowledgeDirectory({
      target,
      templateRoot: template,
      assetUrl: 'https://example.invalid/knowledge.zip',
      sha256: '0'.repeat(64),
      selection: { benchmarks: false, factory: false },
      download: async () => new Response('', { status: 503 }),
      validate: async (candidate) => {
        expect(await readdir(candidate)).toEqual(expect.arrayContaining(['00-System', 'jimu-knowledge.json']))
        expect(await readdir(candidate)).not.toContain('07-对标博主库')
        expect(await readdir(candidate)).not.toContain('08-自媒体工厂')
      },
    })
    expect(result.source).toBe('bundled-fallback')
    expect(await readdir(target)).not.toContain('07-对标博主库')
    await expect(installKnowledgeDirectory({
      target,
      templateRoot: template,
      assetUrl: 'https://example.invalid/knowledge.zip',
      sha256: '0'.repeat(64),
      selection: { benchmarks: false, factory: false },
      download: async () => new Response('', { status: 503 }),
      validate: async () => {},
    })).rejects.toThrow(/已存在/)
  })

  it.each([
    [{ benchmarks: true, factory: true }, true, true],
    [{ benchmarks: true, factory: false }, true, false],
    [{ benchmarks: false, factory: true }, false, true],
    [{ benchmarks: false, factory: false }, false, false],
  ] as const)('materializes the selected module combination %#', async (selection, hasBenchmarks, hasFactory) => {
    const { root, template } = await fixture()
    const target = join(root, `knowledge-${String(hasBenchmarks)}-${String(hasFactory)}`)
    await installKnowledgeDirectory({
      target,
      templateRoot: template,
      assetUrl: 'https://example.invalid/knowledge.zip',
      sha256: '0'.repeat(64),
      selection,
      download: async () => new Response('', { status: 503 }),
      validate: async () => {},
    })
    const entries = await readdir(target)
    expect(entries.includes('07-对标博主库')).toBe(hasBenchmarks)
    expect(entries.includes('08-自媒体工厂')).toBe(hasFactory)
  })

  it('installs only confirmed missing module skeletons', async () => {
    const { root, template } = await fixture()
    const knowledge = join(root, 'knowledge')
    await mkdir(knowledge)
    await installMissingKnowledgeModules({ root: knowledge, templateRoot: template, modules: ['factory'] })
    expect(await readdir(knowledge)).toEqual(['08-自媒体工厂'])
    expect(await readdir(join(knowledge, '08-自媒体工厂'))).toEqual(['03-素材库'])
  })

  it('rejects archive path traversal before writing', async () => {
    const { root } = await fixture()
    await expect(extractKnowledgeArchive(
      storedZipEntry('../outside'),
      join(root, 'destination'),
      { benchmarks: true, factory: true },
    )).rejects.toThrow(/不安全路径/)
    expect(await readdir(root)).not.toContain('outside')
  })
})
