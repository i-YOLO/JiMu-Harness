import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createStarterDirectory, parseStarterFolderName } from '../src/main/knowledge-setup.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jimu-starter-fixture-'))
  roots.push(root)
  const template = join(root, 'template')
  await mkdir(template)
  await writeFile(join(template, 'jimu-knowledge.json'), '{}')
  return { root, template }
}

const ready = async (root: string) => ({ phase: 'ready', root, compatibility: 'schema-1' })

describe('JiMu starter creation boundary', () => {
  it('rejects absolute paths, traversal and separators', () => {
    for (const value of ['/tmp/knowledge', '../knowledge', 'nested/knowledge', 'nested\\knowledge', '.', '..', '']) {
      expect(() => parseStarterFolderName(value)).toThrow()
    }
    expect(parseStarterFolderName('Fixture-Knowledge-001')).toBe('Fixture-Knowledge-001')
  })

  it('creates through a sibling temporary directory and refuses overwrite', async () => {
    const { root, template } = await fixture()
    const created = await createStarterDirectory({ parent: root, folderName: 'Fixture-Knowledge-001', templateRoot: template, inspectRoot: ready })
    expect(created.target).toBe(join(await realpath(root), 'Fixture-Knowledge-001'))
    await expect(createStarterDirectory({ parent: root, folderName: 'Fixture-Knowledge-001', templateRoot: template, inspectRoot: ready })).rejects.toThrow(/已存在/)
    expect((await readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('removes only its temporary directory when validation fails', async () => {
    const { root, template } = await fixture()
    let calls = 0
    await expect(createStarterDirectory({
      parent: root,
      folderName: 'Fixture-Knowledge-002',
      templateRoot: template,
      inspectRoot: async candidate => (++calls === 1 ? ready(candidate) : { phase: 'incompatible', root: candidate, error: 'fixture validation failure' }),
    })).rejects.toThrow(/fixture validation failure/)
    expect(await readdir(root)).toEqual(['template'])
  })

  it('omits locally disabled optional directories', async () => {
    const { root, template } = await fixture()
    await mkdir(join(template, '07-对标博主库'))
    await mkdir(join(template, '08-自媒体工厂'))
    const created = await createStarterDirectory({
      parent: root,
      folderName: 'Fixture-Knowledge-Modules',
      templateRoot: template,
      excludedDirectories: ['07-对标博主库', '08-自媒体工厂'],
      inspectRoot: ready,
    })
    expect(await readdir(created.target)).toEqual(['jimu-knowledge.json'])
  })
})
