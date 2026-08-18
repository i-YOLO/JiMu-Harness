/** JiMu-owned policy and durable overlay for Harness plugin management. */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type PluginManagement = 'locked' | 'toggleable' | 'configurable'
export type PluginCategory = 'agent' | 'tools' | 'knowledge' | 'workflow' | 'system'
export type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

export interface PluginPolicyGroup {
  id: string
  label: string
  description: string
  category: PluginCategory
  entryIds: string[]
  management: PluginManagement
  lockedReason?: string
  configurableNamespace?: 'shell' | 'agent-loop' | 'web-search-deepseek'
  restartRequired: true
}

export interface PluginPolicy {
  schemaVersion: 1
  groups: PluginPolicyGroup[]
}

export interface PluginInventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: PluginFiberPhase
}

export interface PluginManagementEntry extends PluginInventoryEntry {
  policyGroupId?: string
  management: PluginManagement
  lockedReason?: string
}

export interface PluginManagementGroup extends PluginPolicyGroup {
  enabled: boolean
  mixed: boolean
  presentEntryIds: string[]
}

export interface PluginManagementSnapshot {
  revision: string
  harnessPhase: 'booting' | 'ready' | 'restarting' | 'error'
  entries: PluginManagementEntry[]
  groups: PluginManagementGroup[]
}

const ENTRY_ID = /^[a-z0-9][a-z0-9._/-]*$/
const MANAGEMENT = new Set<PluginManagement>(['locked', 'toggleable', 'configurable'])
const CATEGORIES = new Set<PluginCategory>(['agent', 'tools', 'knowledge', 'workflow', 'system'])
const CONFIG_NAMESPACES = new Set(['shell', 'agent-loop', 'web-search-deepseek'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  return value
}

/** Parse and validate the shipped policy before any user-controlled state is read. */
export function parsePluginPolicy(value: unknown): PluginPolicy {
  const root = record(value, 'plugin policy')
  if (root.schemaVersion !== 1) throw new Error('plugin policy schemaVersion must be 1')
  if (!Array.isArray(root.groups)) throw new Error('plugin policy groups must be an array')
  const groupIds = new Set<string>()
  const entryIds = new Set<string>()
  const groups = root.groups.map((candidate, index): PluginPolicyGroup => {
    const group = record(candidate, `plugin policy group ${index}`)
    const id = requiredString(group.id, `plugin policy group ${index} id`)
    if (!ENTRY_ID.test(id)) throw new Error(`plugin policy group id is invalid: ${id}`)
    if (groupIds.has(id)) throw new Error(`plugin policy group id is duplicated: ${id}`)
    groupIds.add(id)
    if (!Array.isArray(group.entryIds) || group.entryIds.length === 0) throw new Error(`plugin policy group ${id} must name entries`)
    const ownedEntries = group.entryIds.map((entry, entryIndex) => {
      const entryId = requiredString(entry, `plugin policy group ${id} entry ${entryIndex}`)
      if (!ENTRY_ID.test(entryId)) throw new Error(`plugin policy entry id is invalid: ${entryId}`)
      if (entryIds.has(entryId)) throw new Error(`plugin policy entry id is duplicated: ${entryId}`)
      entryIds.add(entryId)
      return entryId
    })
    if (!MANAGEMENT.has(group.management as PluginManagement)) throw new Error(`plugin policy group ${id} has invalid management`)
    if (!CATEGORIES.has(group.category as PluginCategory)) throw new Error(`plugin policy group ${id} has invalid category`)
    if (group.restartRequired !== true) throw new Error(`plugin policy group ${id} must require restart`)
    const configurableNamespace = group.configurableNamespace
    if (configurableNamespace !== undefined
      && (typeof configurableNamespace !== 'string' || !CONFIG_NAMESPACES.has(configurableNamespace))) {
      throw new Error(`plugin policy group ${id} has invalid configurable namespace`)
    }
    return {
      id,
      label: requiredString(group.label, `plugin policy group ${id} label`),
      description: requiredString(group.description, `plugin policy group ${id} description`),
      category: group.category as PluginCategory,
      entryIds: ownedEntries,
      management: group.management as PluginManagement,
      ...(typeof group.lockedReason === 'string' ? { lockedReason: group.lockedReason } : {}),
      ...(typeof configurableNamespace === 'string' ? { configurableNamespace: configurableNamespace as 'shell' | 'agent-loop' | 'web-search-deepseek' } : {}),
      restartRequired: true,
    }
  })
  return { schemaVersion: 1, groups }
}

/** Load the application-owned policy file. */
export async function loadPluginPolicy(path: string): Promise<PluginPolicy> {
  return parsePluginPolicy(JSON.parse(await readFile(path, 'utf8')) as unknown)
}

/** Read a generated overlay; a missing file is the empty state. */
export async function readPluginOverlay(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return '[]\n'
    throw error
  }
}

/** Create the JiMu-owned layer as valid empty YAML without changing an existing state. */
export async function ensurePluginOverlay(path: string): Promise<void> {
  try {
    const current = await readFile(path, 'utf8')
    if (current.trim() === '') await writePluginOverlay(path, '[]\n')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      await writePluginOverlay(path, '[]\n')
      return
    }
    throw error
  }
}

/** Reject a hand-edited layer that targets anything outside toggleable policy. */
export function validatePluginOverlay(policy: PluginPolicy, content: string): void {
  const trimmed = content.trim()
  if (trimmed === '[]') return
  const allowed = new Set(policy.groups.filter(group => group.management === 'toggleable').flatMap(group => group.entryIds))
  const seen = new Set<string>()
  const lines = content.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '' && !line.startsWith('#'))
  for (let index = 0; index < lines.length; index += 2) {
    const id = lines[index]?.match(/^- id: ([a-z0-9][a-z0-9._/-]*)$/)?.[1]
    const disabled = lines[index + 1]?.match(/^disabled: (true|false)$/)?.[1]
    if (id === undefined || disabled === undefined) throw new Error('JiMu plugin overlay has an invalid structure')
    if (!allowed.has(id)) throw new Error(`JiMu plugin overlay targets a locked or unknown entry: ${id}`)
    if (seen.has(id)) throw new Error(`JiMu plugin overlay contains a duplicate entry: ${id}`)
    seen.add(id)
  }
}

/** Render the entire managed layer so one feature group can never be partially applied. */
export function renderPluginOverlay(policy: PluginPolicy, groupStates: Readonly<Record<string, boolean>>): string {
  const rows: string[] = []
  for (const group of policy.groups) {
    if (group.management !== 'toggleable') continue
    const enabled = groupStates[group.id]
    if (typeof enabled !== 'boolean') throw new Error(`plugin group state is missing: ${group.id}`)
    for (const entryId of group.entryIds) rows.push(`- id: ${entryId}\n  disabled: ${enabled ? 'false' : 'true'}`)
  }
  const output = rows.length === 0 ? '[]\n' : `# Generated by JiMu. Edit plugin state in Settings, not this file.\n${rows.join('\n')}\n`
  validatePluginOverlay(policy, output)
  return output
}

/** Atomically replace the JiMu-owned overlay. */
export async function writePluginOverlay(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

/** Combine live Loader truth with the application-owned management policy. */
export function projectPluginSnapshot(
  policy: PluginPolicy,
  inventory: readonly PluginInventoryEntry[],
  harnessPhase: PluginManagementSnapshot['harnessPhase'],
  overlay: string,
): PluginManagementSnapshot {
  const policyGroupsByLocalId = new Map<string, PluginPolicyGroup>()
  for (const group of policy.groups) for (const entryId of group.entryIds) policyGroupsByLocalId.set(entryId, group)
  // Loader tree identities include their owning subtree (for the shipped
  // bundle this is commonly `include:<configured id>`). Policy ids address
  // the stable id inside that containing tree, which is also what Cordis
  // patch overlays target. Only a unique leaf match is accepted; ambiguity
  // stays locked instead of guessing from a module name or prefix.
  const inventoryByLocalId = new Map<string, PluginInventoryEntry[]>()
  for (const entry of inventory) {
    const localId = entry.entryId.slice(entry.entryId.lastIndexOf(':') + 1)
    const matches = inventoryByLocalId.get(localId) ?? []
    matches.push(entry)
    inventoryByLocalId.set(localId, matches)
  }
  const policyGroupForEntry = (entry: PluginInventoryEntry): PluginPolicyGroup | undefined => {
    const exact = policyGroupsByLocalId.get(entry.entryId)
    if (exact !== undefined) return exact
    const localId = entry.entryId.slice(entry.entryId.lastIndexOf(':') + 1)
    return inventoryByLocalId.get(localId)?.length === 1 ? policyGroupsByLocalId.get(localId) : undefined
  }
  const entries = inventory.map((entry): PluginManagementEntry => {
    const group = policyGroupForEntry(entry)
    if (group === undefined) {
      return { ...entry, management: 'locked', lockedReason: '该插件未列入 JiMu 可管理策略，默认保持系统锁定。' }
    }
    return {
      ...entry,
      policyGroupId: group.id,
      management: group.management,
      ...(group.management === 'toggleable' ? {} : { lockedReason: group.lockedReason ?? '该插件不能在此停用。' }),
    }
  })
  const groups = policy.groups.map((group): PluginManagementGroup => {
    const present = group.entryIds.flatMap((entryId) => {
      const exact = inventory.find(entry => entry.entryId === entryId)
      if (exact !== undefined) return [exact]
      const matches = inventoryByLocalId.get(entryId) ?? []
      return matches.length === 1 ? matches : []
    })
    const enabledCount = present.filter(entry => entry.enabled).length
    return {
      ...group,
      enabled: present.length > 0 && enabledCount === present.length,
      mixed: enabledCount > 0 && enabledCount < present.length,
      presentEntryIds: present.map(entry => entry.entryId),
    }
  })
  const revisionInventory = entries.map(({ entryId, moduleName, enabled, fiberPhase }) => (
    { entryId, moduleName, enabled, fiberPhase }
  ))
  const revision = createHash('sha256')
    .update(JSON.stringify({ policy, inventory: revisionInventory, overlay }))
    .digest('hex')
  return { revision, harnessPhase, entries, groups }
}
