/** JiMu plugin catalog parsing, proposal inspection, and staged profile mutation. */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { satisfies } from 'semver'

type JsonRecord = Record<string, unknown>

export type PluginCompatibility =
  | 'full'
  | 'host-only'
  | 'official-web-only'
  | 'terminal-only'
  | 'incompatible'

export interface PluginCatalogEntry {
  name: string
  owner: string
  repository: string
  page?: string
  category: string
  description: string
  npm?: string
  stars: number
  downloads?: number
  source: string
  added?: string
  compatibility: PluginCompatibility
}

export interface PluginProposal {
  proposalId: string
  packageName: string
  version: string
  resolvedSource: string
  integrityOrCommit: string
  license?: string
  compatibility: PluginCompatibility
  buildPackages: string[]
  expiresAt: number
}

export interface InstalledPlugin {
  packageName: string
  version: string
  enabled: boolean
  source?: string
  compatibility: PluginCompatibility
}

interface PackageManifest extends JsonRecord {
  name?: string
  version?: string
  license?: string
  scripts?: Record<string, string>
  os?: string[]
  cpu?: string[]
  engines?: { node?: string }
  peerDependencies?: Record<string, string>
  dsh?: {
    bundle?: { patch?: string }
    client?: { platform?: string; inject?: string[] }
    profile?: { bundles?: string[] }
  }
}

interface InspectResult {
  packageName: string
  version: string
  resolvedSource: string
  integrityOrCommit: string
  license?: string
  compatibility: PluginCompatibility
  buildPackages: string[]
  manifest: PackageManifest
}

interface PnpmRunOptions {
  cwd: string
  args: string[]
  signal?: AbortSignal
  onOutput?: (line: string) => void
}

export interface StagedProfile {
  root: string
  profileDir: string
}

const WINDOWS_FILE_RETRY_MS = 5_000

const require = createRequire(import.meta.url)

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sourceFromInstall(command: string | undefined, npmName: string | undefined, repository: string): string {
  const marker = ' add '
  const index = command?.indexOf(marker) ?? -1
  if (command !== undefined && index >= 0) return command.slice(index + marker.length).trim().replace(/^['"]|['"]$/g, '')
  if (npmName !== undefined) return npmName
  const match = /^https:\/\/github\.com\/([^/]+\/[^/#]+?)(?:\.git)?$/u.exec(repository)
  return match === null ? repository : `github:${match[1]}`
}

export function catalogCompatibility(name: string, category: string): PluginCompatibility {
  const normalized = `${name} ${category}`.toLocaleLowerCase('en-US')
  if (name.replaceAll('-', '').toLocaleLowerCase('en-US') === 'dshmarket') return 'official-web-only'
  if (/\b(?:tui|terminal|cli)\b/u.test(normalized)) return 'terminal-only'
  return 'host-only'
}

/** Parse the public awesome-dsh-plugin document into JiMu's stable fields. */
export function parsePluginCatalog(value: unknown): { updated?: string; entries: PluginCatalogEntry[] } {
  const document = record(value)
  const rows = Array.isArray(document?.plugins) ? document.plugins : []
  const entries: PluginCatalogEntry[] = []
  for (const row of rows) {
    const item = record(row)
    const name = stringValue(item?.name)
    const repository = stringValue(item?.url)
    if (name === undefined || repository === undefined) continue
    const owner = stringValue(item?.owner) ?? 'unknown'
    const category = stringValue(item?.category) ?? 'other'
    const descriptions = record(item?.description)
    const npmName = stringValue(item?.npm)
    const page = stringValue(item?.page)
    const downloads = numberValue(item?.downloads)
    const added = stringValue(item?.added)
    entries.push({
      name,
      owner,
      repository,
      ...(page === undefined ? {} : { page }),
      category,
      description: stringValue(descriptions?.zh) ?? stringValue(descriptions?.en) ?? '暂无说明',
      ...(npmName === undefined ? {} : { npm: npmName }),
      stars: numberValue(item?.stars) ?? 0,
      ...(downloads === undefined ? {} : { downloads }),
      source: sourceFromInstall(stringValue(item?.install), npmName, repository),
      ...(added === undefined ? {} : { added }),
      compatibility: catalogCompatibility(name, category),
    })
  }
  const updated = stringValue(document?.updated)
  return { ...(updated === undefined ? {} : { updated }), entries }
}

export function searchPluginCatalog(entries: readonly PluginCatalogEntry[], query: string, category = 'all'): PluginCatalogEntry[] {
  const needle = query.trim().toLocaleLowerCase('zh-CN')
  return entries
    .filter(entry => category === 'all' || entry.category === category)
    .filter(entry => needle === '' || `${entry.name} ${entry.owner} ${entry.description} ${entry.npm ?? ''}`.toLocaleLowerCase('zh-CN').includes(needle))
    .sort((left, right) => right.stars - left.stars || left.name.localeCompare(right.name))
}

function parseNpmSource(source: string): { name: string; selector?: string } | undefined {
  const scoped = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9._-]+))?$/u.exec(source)
  if (scoped !== null && scoped[1] !== undefined) return { name: scoped[1], ...(scoped[2] === undefined ? {} : { selector: scoped[2] }) }
  const plain = /^([a-z0-9][a-z0-9._-]*)(?:@([a-zA-Z0-9._-]+))?$/u.exec(source)
  if (plain?.[1] === undefined) return undefined
  return { name: plain[1], ...(plain[2] === undefined ? {} : { selector: plain[2] }) }
}

function allowedByPlatform(list: readonly string[] | undefined, value: string): boolean {
  if (list === undefined || list.length === 0) return true
  if (list.includes(`!${value}`)) return false
  const positive = list.filter(item => !item.startsWith('!'))
  return positive.length === 0 || positive.includes(value)
}

function installedDshVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function manifestCompatibility(manifest: PackageManifest): PluginCompatibility {
  const name = manifest.name ?? ''
  if (name === 'dshmarket') return 'official-web-only'
  if (/\b(?:tui|terminal|cli)\b/iu.test(name)) return 'terminal-only'
  if (manifest.dsh?.bundle?.patch === undefined) return 'incompatible'
  if (!allowedByPlatform(manifest.os, process.platform) || !allowedByPlatform(manifest.cpu, process.arch)) return 'incompatible'
  if (manifest.engines?.node !== undefined && !satisfies(process.versions.node, manifest.engines.node, { includePrerelease: true })) return 'incompatible'
  const dshRange = manifest.peerDependencies?.['@deepseek-ai/dsh']
  if (dshRange !== undefined && !satisfies(installedDshVersion(), dshRange, { includePrerelease: true })) return 'incompatible'
  return manifest.dsh.client === undefined ? 'full' : 'host-only'
}

function buildPackages(manifest: PackageManifest, gitSource: boolean): string[] {
  const names = gitSource
    ? ['preinstall', 'install', 'postinstall', 'prepare']
    : ['preinstall', 'install', 'postinstall']
  return names.some(name => manifest.scripts?.[name] !== undefined) && manifest.name !== undefined ? [manifest.name] : []
}

async function inspectNpm(source: string, fetcher: typeof fetch, registryBase: string): Promise<InspectResult> {
  const parsed = parseNpmSource(source)
  if (parsed === undefined) throw new Error('插件来源必须是 npm 包名、精确版本或公开 GitHub 来源')
  const response = await fetcher(`${registryBase.replace(/\/$/u, '')}/${encodeURIComponent(parsed.name)}`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`npm Registry 未找到插件：${parsed.name}${parsed.selector === undefined ? '' : `@${parsed.selector}`}`)
  const metadata = record(await response.json())
  const tags = record(metadata?.['dist-tags'])
  const selector = parsed.selector ?? stringValue(tags?.latest)
  const versions = record(metadata?.versions)
  const manifest: PackageManifest | undefined = record(versions?.[selector ?? ''])
  if (selector === undefined || manifest === undefined) throw new Error(`npm Registry 不存在该版本：${source}`)
  const dist = record(manifest.dist)
  const integrity = stringValue(dist?.integrity) ?? stringValue(dist?.shasum)
  if (integrity === undefined) throw new Error(`npm 包缺少完整性摘要：${source}`)
  const packageName = stringValue(manifest.name)
  const version = stringValue(manifest.version)
  const license = stringValue(manifest.license)
  if (packageName === undefined || version === undefined) throw new Error(`npm 包清单不完整：${source}`)
  return {
    packageName,
    version,
    resolvedSource: `${packageName}@${version}`,
    integrityOrCommit: integrity,
    ...(license === undefined ? {} : { license }),
    compatibility: manifestCompatibility(manifest),
    buildPackages: buildPackages(manifest, false),
    manifest,
  }
}

async function inspectGithub(source: string, fetcher: typeof fetch): Promise<InspectResult> {
  const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#([A-Za-z0-9._/-]+))?$/u.exec(source)
  if (match === null) throw new Error('GitHub 插件来源必须使用 github:owner/repo#tag-or-commit')
  const owner = match[1]
  const repository = match[2]
  if (owner === undefined || repository === undefined) throw new Error('GitHub 插件来源缺少 owner 或 repository')
  const ref = match[3] ?? 'HEAD'
  const commitResponse = await fetcher(`https://api.github.com/repos/${owner}/${repository}/commits/${encodeURIComponent(ref)}`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!commitResponse.ok) throw new Error(`GitHub 未找到公开插件或版本：${owner}/${repository}#${ref}`)
  const commit = record(await commitResponse.json())
  const sha = stringValue(commit?.sha)
  if (sha === undefined) throw new Error(`GitHub 没有返回 commit SHA：${owner}/${repository}`)
  const manifestResponse = await fetcher(`https://raw.githubusercontent.com/${owner}/${repository}/${sha}/package.json`, { signal: AbortSignal.timeout(15_000) })
  if (!manifestResponse.ok) throw new Error(`GitHub 插件根目录缺少 package.json：${owner}/${repository}`)
  const manifest: PackageManifest | undefined = record(await manifestResponse.json())
  const packageName = stringValue(manifest?.name)
  const version = stringValue(manifest?.version)
  const license = stringValue(manifest?.license)
  if (manifest === undefined || packageName === undefined || version === undefined) throw new Error(`GitHub 插件清单不完整：${owner}/${repository}`)
  return {
    packageName,
    version,
    resolvedSource: `github:${owner}/${repository}#${sha}`,
    integrityOrCommit: sha,
    ...(license === undefined ? {} : { license }),
    compatibility: manifestCompatibility(manifest),
    buildPackages: buildPackages(manifest, true),
    manifest,
  }
}

/** Resolve a user source to an exact immutable package proposal. */
export async function inspectPluginSource(source: string, fetcher: typeof fetch = fetch, registryBase = 'https://registry.npmjs.org'): Promise<InspectResult> {
  const normalized = source.trim()
  if (normalized === '' || normalized.startsWith('-') || /\s/u.test(normalized)) throw new Error('插件来源为空或包含不允许的参数')
  if (normalized.startsWith('github:')) return await inspectGithub(normalized, fetcher)
  if (/^(?:file|link|git\+|https?:|ssh:)/iu.test(normalized)) throw new Error('JiMu 首期只支持 npm 包和公开 GitHub 来源')
  return await inspectNpm(normalized, fetcher, registryBase)
}

export function proposalFromInspection(inspection: InspectResult, proposalId: string, now = Date.now()): PluginProposal {
  return {
    proposalId,
    packageName: inspection.packageName,
    version: inspection.version,
    resolvedSource: inspection.resolvedSource,
    integrityOrCommit: inspection.integrityOrCommit,
    ...(inspection.license === undefined ? {} : { license: inspection.license }),
    compatibility: inspection.compatibility,
    buildPackages: [...inspection.buildPackages],
    expiresAt: now + 10 * 60_000,
  }
}

function pnpmCliPath(): string {
  return join(dirname(require.resolve('pnpm')), 'bin', 'pnpm.mjs')
}

async function terminate(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGTERM') } catch { /* process already exited */ }
    return
  }
  await new Promise<void>((resolveDone) => {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.once('close', () => { resolveDone() })
    killer.once('error', () => { resolveDone() })
  })
}

async function runPnpm(options: PnpmRunOptions): Promise<void> {
  const runtime = process.execPath
  const child = spawn(runtime, [pnpmCliPath(), ...options.args], {
    cwd: options.cwd,
    detached: process.platform !== 'win32',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let output = ''
  const collect = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    output += text
    for (const line of text.split(/\r?\n/u)) if (line.trim() !== '') options.onOutput?.(line)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const onAbort = (): void => { if (child.pid !== undefined) void terminate(child.pid) }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('close', (code) => { resolveExit(code ?? 1) })
    })
    if (options.signal?.aborted === true) throw new Error('插件操作已取消')
    if (result !== 0) throw new Error(`pnpm 执行失败（exit ${result}）\n${output.slice(-4000)}`)
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

async function writeManifest(path: string, manifest: PackageManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith('../') && !fromRoot.startsWith('..\\'))
}

async function validateBundle(profileDir: string, packageName: string): Promise<PackageManifest> {
  const packageRoot = join(profileDir, 'node_modules', ...packageName.split('/'))
  const manifest = await readManifest(join(packageRoot, 'package.json'))
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || patch.trim() === '') throw new Error(`${packageName} 不是 DSH Bundle：缺少 dsh.bundle.patch`)
  const patchPath = resolve(packageRoot, patch)
  if (!isInside(packageRoot, patchPath)) throw new Error(`${packageName} 的 Bundle patch 逃逸插件目录`)
  const info = await stat(patchPath)
  if (!info.isFile()) throw new Error(`${packageName} 的 Bundle patch 不是文件`)
  return manifest
}

function exactAllowed(actual: readonly string[], allowed: readonly string[]): boolean {
  return actual.length === allowed.length && actual.every(name => allowed.includes(name))
}

async function allowBuilds(profileDir: string, packages: readonly string[]): Promise<void> {
  if (packages.length === 0) return
  const path = join(profileDir, 'pnpm-workspace.yaml')
  const current = await readFile(path, 'utf8')
  if (/^allowBuilds:/mu.test(current)) throw new Error('Profile 已包含 allowBuilds；请先移除手工配置后重试')
  const rows = packages.map(name => `  ${JSON.stringify(name)}: true`).join('\n')
  await writeFile(path, `${current.trimEnd()}\n\nallowBuilds:\n${rows}\n`, { encoding: 'utf8', mode: 0o600 })
}

function readAllowedBuildPackages(workspace: string): string[] {
  const packages: string[] = []
  let inside = false
  for (const line of workspace.split(/\r?\n/u)) {
    if (!inside) {
      if (/^allowBuilds:\s*$/u.test(line)) inside = true
      continue
    }
    if (/^\S/u.test(line)) break
    const key = /^\s{2}("(?:[^"\\]|\\.)*"|[^:#][^:]*):\s*true\s*$/u.exec(line)?.[1]
    if (key !== undefined) packages.push(key.startsWith('"') ? JSON.parse(key) as string : key.trim())
  }
  return packages
}

async function copyProfile(profileDir: string): Promise<StagedProfile> {
  const parent = dirname(profileDir)
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, '.jimu-plugin-stage-'))
  const staged = join(root, basename(profileDir))
  await cp(profileDir, staged, { recursive: true, verbatimSymlinks: true })
  if (process.platform === 'win32') {
    const modulesPath = join(staged, 'node_modules', '.modules.yaml')
    try {
      await stat(modulesPath)
      await runPnpm({ cwd: staged, args: ['install', '--ignore-scripts', '--offline', '--force'] })
      const workspace = await readFile(join(staged, 'pnpm-workspace.yaml'), 'utf8')
      const allowedBuildPackages = readAllowedBuildPackages(workspace)
      if (allowedBuildPackages.length > 0) {
        await runPnpm({ cwd: staged, args: ['rebuild', ...allowedBuildPackages] })
      }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT') throw error
    }
  }
  return { root, profileDir: staged }
}

/** Remove a plugin staging tree, retrying transient Windows file locks for a bounded interval. */
export async function removePluginTree(target: string): Promise<void> {
  const deadline = Date.now() + (process.platform === 'win32' ? WINDOWS_FILE_RETRY_MS : 0)
  while (true) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (Date.now() >= deadline || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    }
  }
}

function setBundle(manifest: PackageManifest, packageName: string, enabled: boolean): void {
  const current = manifest.dsh?.profile?.bundles ?? []
  const next = current.filter(name => name !== packageName)
  if (enabled) next.push(packageName)
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
}

export async function stagePluginInstall(
  profileDir: string,
  proposal: PluginProposal,
  allowedBuildPackages: readonly string[],
  options: { signal?: AbortSignal; onOutput?: (line: string) => void; registry?: string } = {},
): Promise<StagedProfile> {
  if (proposal.expiresAt < Date.now()) throw new Error('插件安装提案已过期，请重新检查')
  if (!exactAllowed(proposal.buildPackages, allowedBuildPackages)) throw new Error('构建脚本授权与安装提案不一致')
  const stage = await copyProfile(profileDir)
  try {
    const registryArgs = options.registry === undefined ? [] : ['--registry', options.registry]
    await runPnpm({
      cwd: stage.profileDir,
      args: ['add', '--ignore-scripts', '--save-exact', ...registryArgs, proposal.resolvedSource],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    })
    const lock = await readFile(join(stage.profileDir, 'pnpm-lock.yaml'), 'utf8')
    if (!lock.includes(proposal.integrityOrCommit)) throw new Error(`${proposal.packageName} 安装结果与已确认的完整性摘要不一致`)
    await allowBuilds(stage.profileDir, allowedBuildPackages)
    if (allowedBuildPackages.length > 0) {
      await runPnpm({
        cwd: stage.profileDir,
        args: ['rebuild', ...allowedBuildPackages],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
      })
    }
    const installedManifest = await validateBundle(stage.profileDir, proposal.packageName)
    if (installedManifest.name !== proposal.packageName || installedManifest.version !== proposal.version) {
      throw new Error(`${proposal.packageName} 安装结果与已确认的名称或版本不一致`)
    }
    const profileManifestPath = join(stage.profileDir, 'package.json')
    const profileManifest = await readManifest(profileManifestPath)
    setBundle(profileManifest, proposal.packageName, true)
    await writeManifest(profileManifestPath, profileManifest)
    return stage
  } catch (error) {
    await removePluginTree(stage.root)
    throw error
  }
}

export async function stagePluginRemoval(
  profileDir: string,
  packageName: string,
  options: { signal?: AbortSignal; onOutput?: (line: string) => void } = {},
): Promise<StagedProfile> {
  const stage = await copyProfile(profileDir)
  try {
    await runPnpm({ cwd: stage.profileDir, args: ['remove', packageName], ...options })
    const manifestPath = join(stage.profileDir, 'package.json')
    const manifest = await readManifest(manifestPath)
    setBundle(manifest, packageName, false)
    await writeManifest(manifestPath, manifest)
    return stage
  } catch (error) {
    await removePluginTree(stage.root)
    throw error
  }
}

export async function stagePluginEnablement(profileDir: string, packageName: string, enabled: boolean): Promise<StagedProfile> {
  const stage = await copyProfile(profileDir)
  try {
    if (enabled) await validateBundle(stage.profileDir, packageName)
    const manifestPath = join(stage.profileDir, 'package.json')
    const manifest = await readManifest(manifestPath)
    setBundle(manifest, packageName, enabled)
    await writeManifest(manifestPath, manifest)
    return stage
  } catch (error) {
    await removePluginTree(stage.root)
    throw error
  }
}

export async function listInstalledPlugins(profileDir: string): Promise<InstalledPlugin[]> {
  let profile: PackageManifest
  try {
    profile = await readManifest(join(profileDir, 'package.json'))
  } catch {
    return []
  }
  const bundles = new Set(profile.dsh?.profile?.bundles ?? [])
  const dependencies = record(profile.dependencies) ?? {}
  const installed: InstalledPlugin[] = []
  for (const packageName of Object.keys(dependencies)) {
    try {
      const manifest = await readManifest(join(profileDir, 'node_modules', ...packageName.split('/'), 'package.json'))
      if (manifest.dsh?.bundle?.patch === undefined) continue
      const source = stringValue(dependencies[packageName])
      installed.push({
        packageName,
        version: manifest.version ?? String(dependencies[packageName]),
        enabled: bundles.has(packageName),
        ...(source === undefined ? {} : { source }),
        compatibility: manifestCompatibility(manifest),
      })
    } catch {
      // A dependency left half-installed is omitted and will be surfaced by the next mutation.
    }
  }
  return installed.sort((left, right) => left.packageName.localeCompare(right.packageName))
}

export async function activateStagedProfile(
  currentProfile: string,
  staged: StagedProfile,
  start: () => Promise<void>,
  stop: () => Promise<void>,
): Promise<void> {
  const renameProfile = async (from: string, to: string): Promise<void> => {
    const deadline = Date.now() + (process.platform === 'win32' ? 5_000 : 0)
    while (true) {
      try {
        await rename(from, to)
        return
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (Date.now() >= deadline || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw error
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      }
    }
  }
  const backup = `${currentProfile}.jimu-backup`
  await removePluginTree(backup)
  await stop()
  try {
    await renameProfile(currentProfile, backup)
    await renameProfile(staged.profileDir, currentProfile)
    await start()
    await removePluginTree(backup)
    await removePluginTree(staged.root)
  } catch (error) {
    await removePluginTree(currentProfile)
    try { await renameProfile(backup, currentProfile) } catch { /* start below reports the combined failure */ }
    try { await start() } catch (restoreError) {
      throw new AggregateError([error, restoreError], '插件 Profile 激活和回滚均失败')
    }
    throw error
  }
}

export function isolatedPluginLogPath(userData: string, operationId: string): string {
  return join(userData || tmpdir(), 'logs', 'plugin-operations', `${operationId}.log`)
}
