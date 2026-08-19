import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activateStagedProfile,
  inspectPluginSource,
  parsePluginCatalog,
  proposalFromInspection,
  searchPluginCatalog,
  stagePluginEnablement,
} from '../src/main/plugin-market.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('JiMu plugin catalog', () => {
  it('separates marketplace search from the running Loader inventory', () => {
    const catalog = parsePluginCatalog({
      updated: 'now',
      plugins: [
        { name: 'dshmarket', owner: 'market', url: 'https://github.com/dsh-market/dsh-market', category: 'ui', npm: 'dshmarket', description: { zh: '市场' }, stars: 8, install: 'dsh plugin --profile web add dshmarket' },
        { name: 'vision', owner: 'eyes', url: 'https://github.com/eyes/vision', category: 'multimodal', npm: 'vision', description: { zh: '图片分析' }, stars: 4, install: 'dsh plugin --profile web add vision' },
      ],
    })
    expect(catalog.updated).toBe('now')
    expect(searchPluginCatalog(catalog.entries, '图片')).toHaveLength(1)
    expect(searchPluginCatalog(catalog.entries, 'dshmarket')[0]).toMatchObject({ source: 'dshmarket', compatibility: 'official-web-only' })
  })

  it('resolves npm proposals to an exact version and rejects missing versions', async () => {
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('fixture-plugin')) return new Response('', { status: 404 })
      return Response.json({
        'dist-tags': { latest: '1.2.3' },
        versions: {
          '1.2.3': {
            name: 'fixture-plugin', version: '1.2.3', license: 'MIT',
            dist: { integrity: 'sha512-fixture' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
          },
        },
      })
    }
    const inspection = await inspectPluginSource('fixture-plugin', fetcher)
    expect(proposalFromInspection(inspection, 'proposal', 100)).toMatchObject({
      proposalId: 'proposal', resolvedSource: 'fixture-plugin@1.2.3', integrityOrCommit: 'sha512-fixture', expiresAt: 600_100,
    })
    await expect(inspectPluginSource('fixture-plugin@9.9.9', fetcher)).rejects.toThrow(/不存在该版本/)
  })
})

describe('JiMu staged plugin profiles', () => {
  async function profileFixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'jimu-plugin-profile-'))
    roots.push(root)
    const profile = join(root, 'web')
    const packageRoot = join(profile, 'node_modules', 'fixture-plugin')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' }, dsh: { profile: { bundles: ['fixture-plugin'] } } }))
    await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(packageRoot, 'cordis.patch.yml'), '[]\n')
    return profile
  }

  it('stages enablement without modifying the live profile', async () => {
    const profile = await profileFixture()
    const stage = await stagePluginEnablement(profile, 'fixture-plugin', false)
    const live = await readFile(join(profile, 'package.json'), 'utf8')
    const staged = await readFile(join(stage.profileDir, 'package.json'), 'utf8')
    expect(live).toContain('"bundles":["fixture-plugin"]')
    expect(staged).toContain('"bundles": []')
    await rm(stage.root, { recursive: true, force: true })
  })

  it('restores the previous profile when the new Harness start fails', async () => {
    const profile = await profileFixture()
    const stage = await stagePluginEnablement(profile, 'fixture-plugin', false)
    let starts = 0
    await expect(activateStagedProfile(profile, stage, async () => {
      starts += 1
      if (starts === 1) throw new Error('new profile failed')
    }, async () => {})).rejects.toThrow('new profile failed')
    const restored = await readFile(join(profile, 'package.json'), 'utf8')
    expect(restored).toContain('"bundles":["fixture-plugin"]')
    expect(starts).toBe(2)
  })
})
