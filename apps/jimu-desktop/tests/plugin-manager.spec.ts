import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensurePluginOverlay,
  parsePluginPolicy,
  projectPluginSnapshot,
  renderPluginOverlay,
  validatePluginOverlay,
  writePluginOverlay,
  type PluginPolicy,
} from '../src/main/plugin-manager.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function policy(): PluginPolicy {
  return parsePluginPolicy({
    schemaVersion: 1,
    groups: [{
      id: 'search',
      label: 'Search',
      description: 'Search group',
      category: 'tools',
      entryIds: ['web-search-deepseek', 'tool-web'],
      management: 'toggleable',
      restartRequired: true,
    }],
  })
}

describe('JiMu plugin policy', () => {
  it('rejects duplicate group ids, duplicate entry ids and unknown management values', () => {
    const group = {
      id: 'search', label: 'Search', description: 'Search group', category: 'tools',
      entryIds: ['tool-web'], management: 'toggleable', restartRequired: true,
    }
    expect(() => parsePluginPolicy({ schemaVersion: 1, groups: [group, group] })).toThrow(/group id is duplicated/)
    expect(() => parsePluginPolicy({ schemaVersion: 1, groups: [group, { ...group, id: 'other' }] })).toThrow(/entry id is duplicated/)
    expect(() => parsePluginPolicy({ schemaVersion: 1, groups: [{ ...group, management: 'arbitrary' }] })).toThrow(/invalid management/)
  })

  it('locks every inventory entry absent from the explicit policy', () => {
    const snapshot = projectPluginSnapshot(policy(), [
      { entryId: 'include:tool-web', moduleName: '@deepseek-ai/dsh-tool-web', enabled: true, fiberPhase: 'active' },
      { entryId: 'jimu-core', moduleName: '@deepseek-ai/dsh-jimu-core', enabled: true, fiberPhase: 'active' },
    ], 'ready', '[]\n')
    expect(snapshot.entries.find(entry => entry.entryId === 'include:tool-web')?.management).toBe('toggleable')
    expect(snapshot.entries.find(entry => entry.entryId === 'jimu-core')).toMatchObject({ management: 'locked' })
    expect(snapshot.entries.find(entry => entry.entryId === 'jimu-core')?.lockedReason).toMatch(/未列入/)
  })

  it('leaves ambiguous Loader-tree leaf ids locked', () => {
    const snapshot = projectPluginSnapshot(policy(), [
      { entryId: 'first:tool-web', moduleName: '@deepseek-ai/dsh-tool-web', enabled: true, fiberPhase: 'active' },
      { entryId: 'second:tool-web', moduleName: '@example/tool-web', enabled: true, fiberPhase: 'active' },
    ], 'ready', '[]\n')
    expect(snapshot.entries.every(entry => entry.management === 'locked')).toBe(true)
    expect(snapshot.groups[0]?.presentEntryIds).toEqual([])
  })

  it('renders every member of a group with one atomic state', () => {
    const enabled = renderPluginOverlay(policy(), { search: true })
    const disabled = renderPluginOverlay(policy(), { search: false })
    expect(enabled.match(/disabled: false/g)).toHaveLength(2)
    expect(disabled.match(/disabled: true/g)).toHaveLength(2)
    expect(() => renderPluginOverlay(policy(), {})).toThrow(/state is missing/)
  })

  it('rejects overlay rows outside the reviewed toggleable policy', () => {
    expect(() => validatePluginOverlay(policy(), '- id: web-runtime\n  disabled: false\n')).toThrow(/locked or unknown/)
    expect(() => validatePluginOverlay(policy(), '- id: tool-web\n  disabled: true\n- id: tool-web\n  disabled: false\n')).toThrow(/duplicate/)
    expect(() => validatePluginOverlay(policy(), renderPluginOverlay(policy(), { search: false }))).not.toThrow()
  })

  it('atomically replaces the durable overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jimu-plugin-overlay-'))
    roots.push(root)
    const target = join(root, 'profiles', 'web', 'jimu.plugins.cordis.patch.yml')
    await writePluginOverlay(target, '[]\n')
    await writePluginOverlay(target, '- id: tool-web\n  disabled: true\n')
    expect(await readFile(target, 'utf8')).toBe('- id: tool-web\n  disabled: true\n')
  })

  it('initializes missing and blank overlay files as valid empty YAML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jimu-plugin-overlay-empty-'))
    roots.push(root)
    const target = join(root, 'profiles', 'web', 'jimu.plugins.cordis.patch.yml')
    await ensurePluginOverlay(target)
    expect(await readFile(target, 'utf8')).toBe('[]\n')
    await writeFile(target, '')
    await ensurePluginOverlay(target)
    expect(await readFile(target, 'utf8')).toBe('[]\n')
  })

  it.skipIf(process.platform === 'win32')('preserves the old overlay when an atomic write fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jimu-plugin-overlay-failure-'))
    roots.push(root)
    const target = join(root, 'jimu.plugins.cordis.patch.yml')
    await writeFile(target, '[]\n')
    await chmod(root, 0o500)
    try {
      await expect(writePluginOverlay(target, '- id: tool-web\n  disabled: true\n')).rejects.toThrow()
      expect(await readFile(target, 'utf8')).toBe('[]\n')
    } finally {
      await chmod(root, 0o700)
    }
  })
})
