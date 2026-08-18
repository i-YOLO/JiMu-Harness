import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  net,
  protocol,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import {
  InProcessApiClient,
  toFetchHandler,
  type ApiProxy,
  type IApiClient,
} from '@deepseek-ai/dsh-host-apiproxy'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import {
  ensurePluginOverlay,
  loadPluginPolicy,
  projectPluginSnapshot,
  readPluginOverlay,
  renderPluginOverlay,
  validatePluginOverlay,
  writePluginOverlay,
  type PluginInventoryEntry,
  type PluginManagementSnapshot,
  type PluginPolicy,
} from './plugin-manager.ts'
import { createStarterDirectory, parseStarterFolderName } from './knowledge-setup.ts'
import {
  KNOWLEDGE_MODULE_DIRECTORIES,
  installKnowledgeDirectory,
  installMissingKnowledgeModules,
  readKnowledgeTemplateLock,
  type KnowledgeModuleId,
  type KnowledgeModuleSelection,
} from './knowledge-installer.ts'

protocol.registerSchemesAsPrivileged([
  { scheme: 'jimu-app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'jimu-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'jimu-asset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

type JsonRecord = Record<string, unknown>
type HarnessCall = (payload: JsonRecord, signal?: AbortSignal) => Promise<unknown>

interface KnowledgeService {
  readonly root: string | null
  readonly indexPath: string
  readonly databasePath: string
  readonly snapshot: unknown
  initialize(options?: { backgroundCalibration?: boolean }): Promise<unknown>
  getClientSnapshot(): unknown
  listCards(request: unknown): unknown
  search(request: unknown): unknown
  readDocument(request: unknown): Promise<unknown>
  resolveLink(request: unknown): Promise<unknown>
  getGraph(filters?: unknown): unknown
  resolveAssetToken(token: string): Promise<string>
  startWatching(): void
  subscribe(listener: (snapshot: unknown) => void): () => void
  close(): void
}

interface KnowledgeModule {
  KnowledgeIndexService: new (options: {
    root: string
    indexPath: string
    databasePath: string
    useWorker: boolean
    excludedDirectories?: string[]
  }) => KnowledgeService
  inspectKnowledgeRoot(root: string, options?: { requiredModules?: KnowledgeModuleId[] }): Promise<KnowledgeRootInspection>
}

type KnowledgeSetupPhase = 'unconfigured' | 'initializing' | 'ready' | 'missing' | 'incompatible' | 'error'
type KnowledgeCompatibility = 'schema-1' | 'legacy-schema-1'

interface JimuKnowledgeManifest {
  schemaVersion: 1
  templateVersion: string
  name: string
  minimumHarnessVersion: string
  repositoryUrl: string
  categories: string[]
  optionalModules: Record<KnowledgeModuleId, {
    directory: string
    category?: string
    defaultEnabled: true
  }>
}

interface KnowledgeRootInspection {
  phase: KnowledgeSetupPhase
  root?: string
  compatibility?: KnowledgeCompatibility
  manifest?: JimuKnowledgeManifest
  error?: string
}

interface KnowledgeSetupSnapshot extends KnowledgeRootInspection {
  template: {
    repositoryUrl: string
    templateVersion: string
    bundled: boolean
  }
}

interface DesktopSettings {
  onboardingVersion?: 1
  knowledgeRoot?: string
  knowledgeModules?: KnowledgeModuleSelection
  knowledgeSource?: 'github-release' | 'bundled-fallback' | 'existing'
  deepSeekTested?: boolean
}

type OnboardingPhase = 'features' | 'knowledge' | 'credential' | 'testing' | 'complete' | 'error'

interface JimuOnboardingSnapshot {
  revision: string
  completed: boolean
  phase: OnboardingPhase
  modules: Record<KnowledgeModuleId, { enabled: boolean; installed: boolean }>
  knowledge: {
    phase: KnowledgeSetupPhase | 'downloading' | 'verifying' | 'installing' | 'indexing'
    root?: string
    source?: 'github-release' | 'bundled-fallback' | 'existing'
    progress?: number
    error?: string
  }
  credential: {
    configured: boolean
    writable: boolean
    source?: string
    tested: boolean
    error?: string
  }
}

interface KnowledgeModulesUpdateResult extends JimuOnboardingSnapshot {
  requiresConfirmation?: boolean
  missingModules?: KnowledgeModuleId[]
}

interface FactoryService {
  readonly factoryRoot: string | null
  initialize(): Promise<unknown>
  getSnapshot(): unknown
  listAssets(request: unknown): unknown
  createInspiration(request: unknown): Promise<unknown>
  promoteTopic(request: unknown): Promise<unknown>
  saveContentRevision(request: unknown): Promise<unknown>
  readContent(request: unknown): Promise<unknown>
  approveScript(request: unknown): Promise<unknown>
  linkAgentSession(request: unknown): Promise<unknown>
  savePublication(request: unknown): Promise<unknown>
  addMetricSnapshot(request: unknown): Promise<unknown>
  importMetricsCsv(request: unknown): Promise<unknown>
  importMetricsCsvFile(filePath: string, publicationId: string): Promise<unknown>
  importAssets(filePaths: string[], kind?: string): Promise<unknown>
  startWatching(): void
  subscribe(listener: (snapshot: unknown) => void): () => void
  close(): void
}

interface FactoryModule {
  FactoryService: new (options: { root: string }) => FactoryService
}

interface HarnessRuntime {
  client: IApiClient
  apiProxy: ApiProxy
  shutdown: { shutdown(code: number): Promise<void> }
  pluginInventory: () => PluginInventoryEntry[]
}

const APP_ID = 'com.iyolo.jimu'
const KNOWLEDGE_REPOSITORY_URL = 'https://github.com/i-YOLO/JiMu-Knowledge'
const KNOWLEDGE_TEMPLATE_VERSION = '1.0.1'
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:'])
const JIMU_ASSET_MIME: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}
const KNOWLEDGE_CHANNELS = [
  'jimu:knowledge:snapshot',
  'jimu:knowledge:list-cards',
  'jimu:knowledge:search',
  'jimu:knowledge:read-document',
  'jimu:knowledge:resolve-link',
  'jimu:knowledge:get-setup',
  'jimu:knowledge:create-starter',
  'jimu:knowledge:choose-root',
  'jimu:knowledge:graph',
] as const
const FACTORY_CHANNELS = [
  'jimu:factory:snapshot',
  'jimu:factory:list-assets',
  'jimu:factory:create-inspiration',
  'jimu:factory:promote-topic',
  'jimu:factory:save-content',
  'jimu:factory:read-content',
  'jimu:factory:approve-script',
  'jimu:factory:link-agent',
  'jimu:factory:save-publication',
  'jimu:factory:add-metrics',
  'jimu:factory:import-metrics-csv',
  'jimu:factory:import-assets',
] as const
const IPC_HANDLER_CHANNELS = [
  ...KNOWLEDGE_CHANNELS,
  ...FACTORY_CHANNELS,
  'jimu:harness:status',
  'jimu:harness:call',
  'jimu:harness:respond',
  'jimu:harness:choose-project',
  'jimu:harness:export-session',
  'jimu:onboarding:snapshot',
  'jimu:onboarding:set-modules',
  'jimu:onboarding:install-default',
  'jimu:onboarding:preview-existing',
  'jimu:onboarding:apply-existing',
  'jimu:onboarding:test-deepseek',
  'jimu:onboarding:update-modules',
  'jimu:plugins:snapshot',
  'jimu:plugins:apply-toggles',
  'jimu:plugins:restart',
  'jimu:project:list-files',
  'jimu:shell:open-external',
] as const

interface ProjectFileEntry {
  name: string
  relativePath: string
  directory: boolean
  size: number
  mtimeMs: number
}

const PROJECT_FILE_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'Caches', 'cache',
  '.DS_Store', '__pycache__', '.venv', 'venv', '.next', '.turbo', '.idea', '.vscode',
])

async function listProjectFiles(root: string, depth: number): Promise<ProjectFileEntry[]> {
  if (depth > 4) return []
  const entries: ProjectFileEntry[] = []
  let names: string[] = []
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  for (const name of names) {
    if (name.startsWith('.') || PROJECT_FILE_SKIP_DIRS.has(name)) continue
    const absolute = join(root, name)
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(absolute)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    const relativePath = relative(root, absolute)
    if (info.isDirectory()) {
      entries.push({ name, relativePath, directory: true, size: 0, mtimeMs: info.mtimeMs })
      entries.push(...await listProjectFiles(absolute, depth + 1))
    } else if (info.isFile()) {
      entries.push({ name, relativePath, directory: false, size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  return entries
}

// ---- external harness-home usage scan ------------------------------------
//
// JiMu's own sessions come through the harness API. Other DeepSeek Harness
// instances (e.g. the dsh Web GUI dev server, whose home is ~/.dsh) keep
// their own session logs; this read-only scan merges their usage into the
// JiMu usage page. Storage is never shared between running instances (two
// processes rewriting workspace metadata concurrently would race), but the
// logs are the same JSONL.zstd format and are safe to read at any time.

const ZSTD_MAGIC = 0xfd2fb528
const EXTERNAL_LOG_SIZE_LIMIT = 100 * 1024 * 1024
const EXTERNAL_REQUEST_LIMIT = 20_000

interface ExternalUsageRequest {
  time: number | null
  usage: JsonRecord
}

interface ExternalSessionScan {
  home: string
  sessionId: string
  createdAt: number | null
  updatedAt: number | null
  title: string | null
  requests: ExternalUsageRequest[]
}

/** Structural frame scan (mirrors dsh-session-persistence-jsonl). */
function scanZstdFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return frames
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return frames
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return frames
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

async function readExternalSessionLog(filePath: string): Promise<{
  createdAt: number | null
  updatedAt: number | null
  requests: ExternalUsageRequest[]
}> {
  const info = await stat(filePath)
  if (info.size > EXTERNAL_LOG_SIZE_LIMIT) return { createdAt: null, updatedAt: null, requests: [] }
  const buffer = await readFile(filePath)
  const lines: string[] = []
  for (const frame of scanZstdFrames(buffer)) {
    let text: string
    try {
      text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      continue
    }
    lines.push(...text.split('\n'))
  }
  let createdAt: number | null = null
  let updatedAt: number | null = null
  const requests: ExternalUsageRequest[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    let event: JsonRecord
    try {
      event = JSON.parse(line) as JsonRecord
    } catch {
      continue
    }
    if (Array.isArray(event)) continue
    if (event.type === 'session' && typeof event.createdAt === 'number' && createdAt === null) createdAt = event.createdAt
    const time = typeof event.time === 'number' ? event.time : null
    if (time !== null && (updatedAt === null || time > updatedAt)) updatedAt = time
    if (event.type !== 'assistant/message') continue
    const data = asRecord(event.data)
    const usage = data.usage
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) continue
    requests.push({ time, usage: usage as JsonRecord })
    if (requests.length >= EXTERNAL_REQUEST_LIMIT) break
  }
  return { createdAt, updatedAt, requests }
}

/** Read session titles from an external home's projection cache (best-effort). */
function readExternalTitles(home: string): Map<string, string> {
  const titles = new Map<string, string>()
  try {
    const raw = JSON.parse(readFileSync(join(home, 'storages', 'session_projcache.json'), 'utf8')) as JsonRecord
    const tables = raw.tables
    if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) return titles
    const sessions = (tables as JsonRecord).sessions
    if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) return titles
    for (const [sessionId, info] of Object.entries(sessions as Record<string, JsonRecord>)) {
      const rows = info.rows
      const title = rows === null || typeof rows !== 'object' || Array.isArray(rows)
        ? null
        : (rows as JsonRecord).title
      const value = title === null || typeof title !== 'object' || Array.isArray(title) ? null : (title as JsonRecord).val
      if (typeof value === 'string' && value.length > 0) titles.set(sessionId, value)
    }
  } catch {
    // Missing or unreadable projection cache: sessions keep timestamp titles.
  }
  return titles
}

async function scanExternalHomes(): Promise<ExternalSessionScan[]> {
  const extraHomes = (process.env.JIMU_EXTRA_HOMES ?? '')
    .split(':')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
  // External Harness homes are opt-in. JiMu never scans the user's home
  // directory merely because the usage page was opened.
  const homes = [...new Set(extraHomes)].filter(home => home !== harnessHome)
  const results: ExternalSessionScan[] = []
  for (const home of homes) {
    const sessionsRoot = join(home, 'sessions')
    let workspaceDirs: string[]
    try {
      workspaceDirs = await readdir(sessionsRoot)
    } catch {
      continue
    }
    const titles = readExternalTitles(home)
    for (const workspaceDir of workspaceDirs) {
      const workspacePath = join(sessionsRoot, workspaceDir)
      let sessionDirs: string[]
      try {
        sessionDirs = await readdir(workspacePath)
      } catch {
        continue
      }
      for (const sessionDir of sessionDirs) {
        if (!sessionDir.startsWith('session-')) continue
        const logPath = join(workspacePath, sessionDir, 'session.jsonl.zstd')
        let log
        try {
          log = await readExternalSessionLog(logPath)
        } catch {
          continue
        }
        if (log.requests.length === 0) continue
        results.push({
          home,
          sessionId: sessionDir,
          createdAt: log.createdAt,
          updatedAt: log.updatedAt,
          title: titles.get(sessionDir) ?? null,
          requests: log.requests,
        })
      }
    }
  }
  return results
}

let mainWindow: BrowserWindow | null = null
let knowledge: KnowledgeService | null = null
let unsubscribeKnowledge: (() => void) | null = null
let factory: FactoryService | null = null
let unsubscribeFactory: (() => void) | null = null
let knowledgeSetup: KnowledgeSetupSnapshot = {
  phase: 'unconfigured',
  template: {
    repositoryUrl: KNOWLEDGE_REPOSITORY_URL,
    templateVersion: KNOWLEDGE_TEMPLATE_VERSION,
    bundled: false,
  },
}
let harnessRuntime: HarnessRuntime | null = null
let harnessState: { phase: 'booting' | 'ready' | 'restarting' | 'error'; error?: string; notice?: string } = { phase: 'booting' }
let pluginPolicy: PluginPolicy | null = null
let lastPluginInventory: PluginInventoryEntry[] = []
let harnessRestarting = false
let pluginOperationPending = false
let desktopSettingsRevision = 0
let onboardingOperation: JimuOnboardingSnapshot['knowledge'] | null = null
let onboardingCredentialError: string | undefined
let onboardingTesting = false
let onboardingNotificationGeneration = 0
let pendingExistingKnowledge: {
  token: string
  root: string
  inspection: KnowledgeRootInspection
  missingModules: KnowledgeModuleId[]
} | null = null
let cleanupStarted = false
let cleanupFinished = false
let windowCreationReady = false
const streamControllers = new Set<AbortController>()

function redactDiagnostic(value: string): string {
  const home = homedir()
  return value
    .split(home).join('<user-home>')
    .replace(/\/Users\/[^/\s:'"`]+/gu, '<user-home>')
    .replace(/[A-Za-z]:\\Users\\[^\\\s:'"`]+/gu, '<user-home>')
}

function formatError(error: unknown, seen = new Set<unknown>()): string {
  if (error === null || error === undefined) return redactDiagnostic(String(error))
  if (seen.has(error)) return '[circular error]'
  seen.add(error)
  if (error instanceof AggregateError) {
    const nested = error.errors.map(item => formatError(item, seen)).join('\n')
    return redactDiagnostic(`${error.stack ?? error.message}${nested ? `\n${nested}` : ''}`)
  }
  if (error instanceof Error) {
    const cause = 'cause' in error ? (error as Error & { cause?: unknown }).cause : undefined
    return redactDiagnostic(`${error.stack ?? error.message}${cause === undefined ? '' : `\nCaused by: ${formatError(cause, seen)}`}`)
  }
  try {
    return redactDiagnostic(JSON.stringify(error))
  } catch {
    return '[unserializable error]'
  }
}

function defaultUserDataDirectory(): string {
  if (process.platform !== 'win32') return join(app.getPath('appData'), 'JiMu')
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) throw new Error('JiMu requires LOCALAPPDATA on Windows')
  return join(localAppData, 'JiMu')
}

const userData = process.env.JIMU_USER_DATA_DIR ?? defaultUserDataDirectory()
app.setPath('userData', userData)
app.setName('JiMu')

const configPath = join(userData, 'settings.json')
const knowledgeDirectory = join(userData, 'knowledge')
const knowledgeIndexPath = join(knowledgeDirectory, 'knowledge-index.json')
const knowledgeDatabasePath = join(knowledgeDirectory, 'knowledge-search.sqlite')
const harnessHome = join(userData, 'harness')
const pluginOverlayPath = join(harnessHome, 'profiles', 'web', 'jimu.plugins.cordis.patch.yml')
process.env.DSH_HOME = harnessHome
process.env.DSH_TELEMETRY_DISABLED = '1'

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && pathFromRoot !== '..' && !pathFromRoot.startsWith('../') && !pathFromRoot.startsWith('..\\'))
}

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('JiMu received an invalid request payload')
  return value as JsonRecord
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

function knowledgeTemplateDirectory(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'jimu-knowledge-template')
    : join(app.getAppPath(), 'build-cache', 'jimu-knowledge-template')
}

function projectKnowledgeSetup(next: KnowledgeRootInspection): KnowledgeSetupSnapshot {
  return {
    ...next,
    ...(next.error ? { error: redactDiagnostic(next.error) } : {}),
    template: {
      repositoryUrl: KNOWLEDGE_REPOSITORY_URL,
      templateVersion: KNOWLEDGE_TEMPLATE_VERSION,
      bundled: false,
    },
  }
}

async function setKnowledgeSetup(next: KnowledgeRootInspection): Promise<KnowledgeSetupSnapshot> {
  knowledgeSetup = projectKnowledgeSetup(next)
  knowledgeSetup.template.bundled = await pathExists(join(knowledgeTemplateDirectory(), 'jimu-knowledge.json'))
  mainWindow?.webContents.send('jimu:knowledge:changed', { setup: knowledgeSetup })
  notifyOnboarding()
  return knowledgeSetup
}

function assertTrustedEvent(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (mainWindow === null || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('JiMu rejected an IPC request from an untrusted frame')
  }
  const source = new URL(event.senderFrame.url)
  if (source.protocol !== 'jimu-app:') throw new Error('JiMu rejected an IPC request from an invalid origin')
}

function parseKnowledgeModules(value: unknown): KnowledgeModuleSelection | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as JsonRecord
  if (typeof record.benchmarks !== 'boolean' || typeof record.factory !== 'boolean') return undefined
  return { benchmarks: record.benchmarks, factory: record.factory }
}

async function readSettings(): Promise<DesktopSettings> {
  try {
    const value = JSON.parse(await readFile(configPath, 'utf8')) as unknown
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as JsonRecord
      const settings: DesktopSettings = {}
      if (record.onboardingVersion === 1) settings.onboardingVersion = 1
      if (typeof record.knowledgeRoot === 'string') settings.knowledgeRoot = record.knowledgeRoot
      const modules = parseKnowledgeModules(record.knowledgeModules)
      if (modules) settings.knowledgeModules = modules
      if (record.knowledgeSource === 'github-release' || record.knowledgeSource === 'bundled-fallback' || record.knowledgeSource === 'existing') {
        settings.knowledgeSource = record.knowledgeSource
      }
      if (record.deepSeekTested === true) settings.deepSeekTested = true
      return settings
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
  }
  return {}
}

async function writeSettings(settings: DesktopSettings): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true })
  const temporary = `${configPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, configPath)
  desktopSettingsRevision += 1
}

async function updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
  const settings = { ...await readSettings(), ...patch }
  await writeSettings(settings)
  return settings
}

function assertSettingsRevision(value: unknown): void {
  if (value !== String(desktopSettingsRevision)) throw new Error('JiMu 设置已变化，请刷新后重试')
}

function knowledgeModulePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'jimu-knowledge', 'knowledge-index-service.mjs')
    : join(app.getAppPath(), '..', 'jimu-ui-preview', 'scripts', 'knowledge-index-service.mjs')
}

function factoryModulePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'jimu-knowledge', 'factory-service.mjs')
    : join(app.getAppPath(), '..', 'jimu-ui-preview', 'scripts', 'factory-service.mjs')
}

function applicationIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'jimu-icon.png')
    : join(app.getAppPath(), '..', 'jimu-ui-preview', 'public', 'assets', 'jimu-app-icon.png')
}

function pluginPolicyPath(): string {
  return join(app.getAppPath(), 'config', 'plugin-policy.json')
}

async function loadKnowledgeModule(): Promise<KnowledgeModule> {
  return await import(pathToFileURL(knowledgeModulePath()).href) as KnowledgeModule
}

async function loadFactoryModule(): Promise<FactoryModule> {
  return await import(pathToFileURL(factoryModulePath()).href) as FactoryModule
}

function selectedKnowledgeModules(settings: DesktopSettings): KnowledgeModuleSelection {
  return settings.knowledgeModules ?? { benchmarks: true, factory: true }
}

function requiredKnowledgeModules(selection: KnowledgeModuleSelection): KnowledgeModuleId[] {
  return (Object.keys(selection) as KnowledgeModuleId[]).filter(id => selection[id])
}

function excludedKnowledgeDirectories(selection: KnowledgeModuleSelection): string[] {
  return (Object.keys(selection) as KnowledgeModuleId[])
    .filter(id => !selection[id])
    .map(id => KNOWLEDGE_MODULE_DIRECTORIES[id])
}

async function replaceKnowledgeService(root: string, selection: KnowledgeModuleSelection): Promise<KnowledgeService> {
  const module = await loadKnowledgeModule()
  const next = new module.KnowledgeIndexService({
    root,
    indexPath: knowledgeIndexPath,
    databasePath: knowledgeDatabasePath,
    useWorker: true,
    excludedDirectories: excludedKnowledgeDirectories(selection),
  })
  await next.initialize({ backgroundCalibration: true })
  next.startWatching()
  let nextFactory: FactoryService | null = null
  if (selection.factory) {
    const factoryModule = await loadFactoryModule()
    nextFactory = new factoryModule.FactoryService({ root })
    await nextFactory.initialize()
    nextFactory.startWatching()
  }
  unsubscribeKnowledge?.()
  unsubscribeFactory?.()
  knowledge?.close()
  factory?.close()
  knowledge = next
  factory = nextFactory
  unsubscribeKnowledge = next.subscribe(() => {
    mainWindow?.webContents.send('jimu:knowledge:changed', {
      indexedAt: (next.getClientSnapshot() as JsonRecord).indexedAt,
    })
  })
  unsubscribeFactory = nextFactory?.subscribe((snapshot) => {
    const value = snapshot as JsonRecord
    mainWindow?.webContents.send('jimu:factory:changed', { generatedAt: value.generatedAt })
  }) ?? null
  return next
}

async function initializeKnowledge(): Promise<void> {
  const module = await loadKnowledgeModule()
  const settings = await readSettings()
  const selection = selectedKnowledgeModules(settings)
  const configuredRoot = settings.knowledgeRoot ?? process.env.JIMU_KNOWLEDGE_ROOT
  if (!configuredRoot) {
    await setKnowledgeSetup({ phase: 'unconfigured' })
    return
  }
  const inspection = await module.inspectKnowledgeRoot(configuredRoot, {
    requiredModules: requiredKnowledgeModules(selection),
  })
  if (inspection.phase !== 'ready' || !inspection.root) {
    await setKnowledgeSetup(inspection)
    return
  }
  await setKnowledgeSetup({ ...inspection, phase: 'initializing' })
  try {
    await replaceKnowledgeService(inspection.root, selection)
    await setKnowledgeSetup(inspection)
  } catch (error) {
    const failedSetup: KnowledgeRootInspection = {
      phase: 'error',
      root: inspection.root,
      error: formatError(error),
    }
    if (inspection.compatibility) failedSetup.compatibility = inspection.compatibility
    if (inspection.manifest) failedSetup.manifest = inspection.manifest
    await setKnowledgeSetup(failedSetup)
  }
}

async function activateKnowledgeRoot(
  inspection: KnowledgeRootInspection,
  selection: KnowledgeModuleSelection,
  source?: DesktopSettings['knowledgeSource'],
): Promise<KnowledgeSetupSnapshot> {
  if (inspection.phase !== 'ready' || !inspection.root || !inspection.compatibility) {
    throw new Error(inspection.error ?? 'Knowledge directory is incompatible')
  }
  const previousSetup = knowledgeSetup
  await setKnowledgeSetup({ ...inspection, phase: 'initializing' })
  try {
    await replaceKnowledgeService(inspection.root, selection)
    if (harnessRuntime !== null) await registerKnowledgeWorkspace(harnessRuntime.client, inspection.root)
    await updateSettings({
      knowledgeRoot: inspection.root,
      knowledgeModules: selection,
      ...(source ? { knowledgeSource: source } : {}),
    })
    return await setKnowledgeSetup(inspection)
  } catch (error) {
    if (previousSetup.phase === 'ready' && previousSetup.root) {
      try {
        const previousSettings = await readSettings()
        await replaceKnowledgeService(previousSetup.root, selectedKnowledgeModules(previousSettings))
        knowledgeSetup = previousSetup
        mainWindow?.webContents.send('jimu:knowledge:changed', { setup: knowledgeSetup })
      } catch (rollbackError) {
        await setKnowledgeSetup({ phase: 'error', error: `知识库切换和恢复都失败：${formatError(rollbackError)}` })
      }
    } else {
      await setKnowledgeSetup({ phase: 'error', root: inspection.root, error: formatError(error) })
    }
    throw error
  }
}

async function createKnowledgeStarter(request: unknown): Promise<unknown> {
  const payload = asRecord(request)
  const folderName = parseStarterFolderName(payload.folderName)
  const owner = mainWindow
  if (owner === null) throw new Error('JiMu window is unavailable')
  const selection = await dialog.showOpenDialog(owner, {
    title: '选择空白知识库的保存位置',
    buttonLabel: '在此创建',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (selection.canceled || selection.filePaths[0] === undefined) return { canceled: true }

  const templateRoot = knowledgeTemplateDirectory()
  const module = await loadKnowledgeModule()
  const settings = await readSettings()
  const modules = selectedKnowledgeModules(settings)
  const created = await createStarterDirectory({
    parent: selection.filePaths[0],
    folderName,
    templateRoot,
    excludedDirectories: excludedKnowledgeDirectories(modules),
    inspectRoot: root => module.inspectKnowledgeRoot(root, { requiredModules: requiredKnowledgeModules(modules) }),
  })
  const setup = await activateKnowledgeRoot(created.inspection as KnowledgeRootInspection, modules, 'bundled-fallback')
  return { canceled: false, created: true, root: created.target, setup }
}

function defaultKnowledgeTarget(): string {
  if (app.isPackaged) return join(homedir(), 'JiMu-Knowledge')
  const repositoryRoot = resolve(app.getAppPath(), '..', '..')
  return join(dirname(repositoryRoot), 'JiMu-Knowledge')
}

async function credentialSnapshot(): Promise<JimuOnboardingSnapshot['credential']> {
  if (harnessRuntime === null || harnessState.phase !== 'ready') {
    return {
      configured: false,
      writable: false,
      tested: false,
      ...(harnessState.error ? { error: harnessState.error } : {}),
    }
  }
  try {
    const value = unwrapResponse(await harnessRuntime.client.credentials.describe({ refs: ['DEEPSEEK_API_KEY'] })) as JsonRecord
    const credentials = value.credentials
    const view = credentials && typeof credentials === 'object' && !Array.isArray(credentials)
      ? (credentials as JsonRecord).DEEPSEEK_API_KEY
      : undefined
    const record = view && typeof view === 'object' && !Array.isArray(view) ? view as JsonRecord : {}
    const settings = await readSettings()
    return {
      configured: record.configured === true,
      writable: record.writable === true,
      ...(typeof record.source === 'string' ? { source: record.source } : {}),
      tested: settings.deepSeekTested === true,
      ...(onboardingCredentialError ? { error: onboardingCredentialError } : {}),
    }
  } catch (error) {
    return { configured: false, writable: false, tested: false, error: redactDiagnostic(formatError(error)) }
  }
}

async function onboardingSnapshot(): Promise<JimuOnboardingSnapshot> {
  const settings = await readSettings()
  const completed = settings.onboardingVersion === 1
  const selection = selectedKnowledgeModules(settings)
  const root = knowledgeSetup.root
  const installed = async (id: KnowledgeModuleId): Promise<boolean> => (
    root !== undefined && await pathExists(join(root, KNOWLEDGE_MODULE_DIRECTORIES[id]))
  )
  const [credential, benchmarksInstalled, factoryInstalled] = await Promise.all([
    credentialSnapshot(),
    installed('benchmarks'),
    installed('factory'),
  ])
  let phase: OnboardingPhase
  if (completed) phase = 'complete'
  else if (onboardingTesting) phase = 'testing'
  else if (settings.knowledgeModules === undefined) phase = 'features'
  else if (knowledgeSetup.phase !== 'ready') phase = 'knowledge'
  else phase = 'credential'
  return {
    revision: String(desktopSettingsRevision),
    completed,
    phase,
    modules: {
      benchmarks: { enabled: selection.benchmarks, installed: benchmarksInstalled },
      factory: { enabled: selection.factory, installed: factoryInstalled },
    },
    knowledge: onboardingOperation ?? {
      phase: knowledgeSetup.phase,
      ...(knowledgeSetup.root
        ? { root: knowledgeSetup.root }
        : settings.knowledgeModules ? { root: defaultKnowledgeTarget() } : {}),
      ...(settings.knowledgeSource ? { source: settings.knowledgeSource } : {}),
      ...(knowledgeSetup.error ? { error: knowledgeSetup.error } : {}),
    },
    credential,
  }
}

function notifyOnboarding(): void {
  const generation = ++onboardingNotificationGeneration
  void onboardingSnapshot().then((snapshot) => {
    if (generation !== onboardingNotificationGeneration) return
    mainWindow?.webContents.send('jimu:onboarding:changed', snapshot)
  }).catch(() => {
    // A closing window does not need a final onboarding projection.
  })
}

async function setOnboardingModules(request: unknown): Promise<JimuOnboardingSnapshot> {
  const payload = asRecord(request)
  assertSettingsRevision(payload.revision)
  const modules = parseKnowledgeModules(payload.modules)
  if (!modules) throw new Error('知识库模块选择无效')
  await updateSettings({ knowledgeModules: modules, deepSeekTested: false })
  onboardingCredentialError = undefined
  notifyOnboarding()
  return await onboardingSnapshot()
}

async function installDefaultKnowledge(request: unknown): Promise<JimuOnboardingSnapshot> {
  const payload = asRecord(request)
  assertSettingsRevision(payload.revision)
  const settings = await readSettings()
  if (!settings.knowledgeModules) throw new Error('请先选择需要的知识库能力')
  const selection = settings.knowledgeModules
  const target = defaultKnowledgeTarget()
  const module = await loadKnowledgeModule()
  if (await pathExists(target)) {
    const existing = await module.inspectKnowledgeRoot(target, { requiredModules: requiredKnowledgeModules(selection) })
    if (existing.phase !== 'ready') throw new Error('默认目录已存在，但不是兼容的 JiMu 知识库；请改用“选择已有知识库”')
    await activateKnowledgeRoot(existing, selection, 'existing')
    notifyOnboarding()
    return await onboardingSnapshot()
  }

  const lock = await readKnowledgeTemplateLock(join(app.getAppPath(), 'config', 'knowledge-template-lock.json'))
  try {
    const installed = await installKnowledgeDirectory({
      target,
      templateRoot: knowledgeTemplateDirectory(),
      assetUrl: lock.assetUrl,
      sha256: lock.sha256,
      selection,
      download: async url => await net.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }),
      validate: async (root) => {
        const inspection = await module.inspectKnowledgeRoot(root, { requiredModules: requiredKnowledgeModules(selection) })
        if (inspection.phase !== 'ready') throw new Error(inspection.error ?? '知识库模板校验失败')
      },
      onProgress: (phase, progress) => {
        onboardingOperation = { phase, root: target, progress }
        notifyOnboarding()
      },
    })
    onboardingOperation = { phase: 'indexing', root: target, source: installed.source, progress: 88 }
    notifyOnboarding()
    const inspection = await module.inspectKnowledgeRoot(target, { requiredModules: requiredKnowledgeModules(selection) })
    if (inspection.phase !== 'ready') throw new Error(inspection.error ?? '安装后的知识库校验失败')
    await activateKnowledgeRoot(inspection, selection, installed.source)
    onboardingOperation = null
    notifyOnboarding()
    return await onboardingSnapshot()
  } catch (error) {
    onboardingOperation = { phase: 'error', root: target, error: redactDiagnostic(formatError(error)) }
    notifyOnboarding()
    throw error
  }
}

async function previewExistingKnowledge(request: unknown): Promise<unknown> {
  const payload = asRecord(request)
  assertSettingsRevision(payload.revision)
  const owner = mainWindow
  if (owner === null) throw new Error('JiMu window is unavailable')
  const result = await dialog.showOpenDialog(owner, {
    title: '选择 JiMu 知识库',
    buttonLabel: '检查此知识库',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths[0] === undefined) return { canceled: true }
  const root = await realpath(result.filePaths[0])
  const module = await loadKnowledgeModule()
  const inspection = await module.inspectKnowledgeRoot(root)
  if (inspection.phase !== 'ready') return { canceled: false, accepted: false, setup: projectKnowledgeSetup(inspection) }
  const selection = selectedKnowledgeModules(await readSettings())
  const missingModules: KnowledgeModuleId[] = []
  for (const id of requiredKnowledgeModules(selection)) {
    if (!await pathExists(join(root, KNOWLEDGE_MODULE_DIRECTORIES[id]))) missingModules.push(id)
  }
  const token = randomUUID()
  pendingExistingKnowledge = { token, root, inspection, missingModules }
  return {
    canceled: false,
    accepted: true,
    token,
    root,
    missingModules,
    requiresConfirmation: missingModules.length > 0,
  }
}

async function applyExistingKnowledge(request: unknown): Promise<JimuOnboardingSnapshot> {
  const payload = asRecord(request)
  assertSettingsRevision(payload.revision)
  const pending = pendingExistingKnowledge
  if (pending === null || payload.token !== pending.token) throw new Error('所选知识库已过期，请重新选择')
  if (pending.missingModules.length > 0 && payload.confirmCreate !== true) throw new Error('需要确认创建所选模块的空目录')
  const settings = await readSettings()
  const selection = selectedKnowledgeModules(settings)
  if (pending.missingModules.length > 0) {
    await installMissingKnowledgeModules({
      root: pending.root,
      templateRoot: knowledgeTemplateDirectory(),
      modules: pending.missingModules,
    })
  }
  const module = await loadKnowledgeModule()
  const inspection = await module.inspectKnowledgeRoot(pending.root, { requiredModules: requiredKnowledgeModules(selection) })
  if (inspection.phase !== 'ready') throw new Error(inspection.error ?? '所选知识库不兼容')
  await activateKnowledgeRoot(inspection, selection, 'existing')
  pendingExistingKnowledge = null
  notifyOnboarding()
  return await onboardingSnapshot()
}

async function updateKnowledgeModules(request: unknown): Promise<KnowledgeModulesUpdateResult> {
  const payload = asRecord(request)
  assertSettingsRevision(payload.revision)
  const modules = parseKnowledgeModules(payload.modules)
  if (!modules) throw new Error('知识库模块选择无效')
  const settings = await readSettings()
  const activeRoot = settings.knowledgeRoot ?? knowledgeSetup.root
  if (!activeRoot || knowledgeSetup.phase !== 'ready') throw new Error('知识库尚未准备好')
  const missing: KnowledgeModuleId[] = []
  for (const id of requiredKnowledgeModules(modules)) {
    if (!await pathExists(join(activeRoot, KNOWLEDGE_MODULE_DIRECTORIES[id]))) missing.push(id)
  }
  if (missing.length > 0 && payload.confirmCreate !== true) {
    return {
      ...await onboardingSnapshot(),
      requiresConfirmation: true,
      missingModules: missing,
    }
  }
  if (missing.length > 0) {
    await installMissingKnowledgeModules({ root: activeRoot, templateRoot: knowledgeTemplateDirectory(), modules: missing })
  }
  const module = await loadKnowledgeModule()
  const inspection = await module.inspectKnowledgeRoot(activeRoot, { requiredModules: requiredKnowledgeModules(modules) })
  if (inspection.phase !== 'ready') throw new Error(inspection.error ?? '知识库模块校验失败')
  await activateKnowledgeRoot(inspection, modules, settings.knowledgeSource)
  notifyOnboarding()
  return await onboardingSnapshot()
}

async function testAndSaveDeepSeek(request: unknown): Promise<JimuOnboardingSnapshot> {
  const payload = asRecord(request)
  assertSettingsRevision(payload.revision)
  if (harnessRuntime === null || harnessState.phase !== 'ready') throw new Error('Harness 尚未准备好')
  const apiKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
  const before = await credentialSnapshot()
  if (!apiKey && !before.configured) throw new Error('请输入 DeepSeek API Key')
  onboardingTesting = true
  onboardingCredentialError = undefined
  notifyOnboarding()
  try {
    const discovered = unwrapResponse(await harnessRuntime.client.llm.discoverModels({
      settingsNs: 'llm-deepseek',
      provider: 'deepseek-official',
      ...(apiKey ? { apiKey } : {}),
    })) as JsonRecord
    if (!Array.isArray(discovered.models) || discovered.models.length === 0) throw new Error('DeepSeek 账户没有返回可用模型')
    if (apiKey) {
      unwrapResponse(await harnessRuntime.client.credentials.set({ ref: 'DEEPSEEK_API_KEY', value: apiKey }))
    }
    await updateSettings({ onboardingVersion: 1, deepSeekTested: true })
    onboardingTesting = false
    notifyOnboarding()
    return await onboardingSnapshot()
  } catch (error) {
    onboardingTesting = false
    onboardingCredentialError = redactDiagnostic(error instanceof Error ? error.message : String(error))
    notifyOnboarding()
    throw error
  }
}

function unwrapResponse(response: unknown): unknown {
  const envelope = asRecord(response)
  const result = asRecord(envelope.result)
  if (result.ok === true) return result.value
  const error = asRecord(result.error)
  const message = typeof error.message === 'string' ? error.message : 'Harness request failed'
  const code = typeof error.code === 'string' ? error.code : 'internal'
  throw new Error(`${message} (${code})`)
}

function harnessCalls(client: IApiClient): Readonly<Record<string, HarnessCall>> {
  return {
    'workspace.list': payload => client.workspace.list(payload),
    'workspace.create': payload => client.workspace.create(payload as Parameters<IApiClient['workspace']['create']>[0]),
    'workspace.rename': payload => client.workspace.rename(payload as Parameters<IApiClient['workspace']['rename']>[0]),
    'workspace.delete': payload => client.workspace.delete(payload as Parameters<IApiClient['workspace']['delete']>[0]),
    'workspace.insertBefore': payload => client.workspace.insertBefore(payload as Parameters<IApiClient['workspace']['insertBefore']>[0]),
    'workspace.insertSessionBefore': payload => client.workspace.insertSessionBefore(payload as Parameters<IApiClient['workspace']['insertSessionBefore']>[0]),
    'workspace.archiveSession': payload => client.workspace.archiveSession(payload as Parameters<IApiClient['workspace']['archiveSession']>[0]),
    'session.list': payload => client.sessions.list(payload),
    'session.search': (payload, signal) => client.sessions.search(payload as Parameters<IApiClient['sessions']['search']>[0], signal),
    'session.create': payload => client.sessions.create(payload),
    'session.history': payload => client.sessions.history(payload as Parameters<IApiClient['sessions']['history']>[0]),
    'session.models': payload => client.sessions.models(payload as Parameters<IApiClient['sessions']['models']>[0]),
    'session.selectModel': payload => client.sessions.selectModel(payload as Parameters<IApiClient['sessions']['selectModel']>[0]),
    'session.rename': payload => client.sessions.rename(payload as Parameters<IApiClient['sessions']['rename']>[0]),
    'session.fork': payload => client.sessions.fork(payload as Parameters<IApiClient['sessions']['fork']>[0]),
    'session.prompt': payload => client.sessions.prompt(payload as Parameters<IApiClient['sessions']['prompt']>[0]),
    'session.attachment': payload => client.sessions.attachment(payload as Parameters<IApiClient['sessions']['attachment']>[0]),
    'session.updateQueue': payload => client.sessions.updateQueue(payload as Parameters<IApiClient['sessions']['updateQueue']>[0]),
    'session.cancel': payload => client.sessions.cancel(payload as Parameters<IApiClient['sessions']['cancel']>[0]),
    'agentPreset.list': payload => client.agentPresets.list(payload),
    'agentPreset.select': payload => client.agentPresets.select(payload as Parameters<IApiClient['agentPresets']['select']>[0]),
    'agentPreset.read': payload => client.agentPresets.read(payload as Parameters<IApiClient['agentPresets']['read']>[0]),
    'agentPreset.copy': payload => client.agentPresets.copy(payload as Parameters<IApiClient['agentPresets']['copy']>[0]),
    'agentPreset.openDocument': (payload, signal) => client.agentPresets.openDocument(payload as Parameters<IApiClient['agentPresets']['openDocument']>[0], signal),
    'agentPreset.remove': payload => client.agentPresets.remove(payload as Parameters<IApiClient['agentPresets']['remove']>[0]),
    'skill.list': payload => client.skills.list(payload as Parameters<IApiClient['skills']['list']>[0]),
    'settings.describe': payload => client.settings.describe(payload),
    'settings.openDocument': (payload, signal) => client.settings.openDocument(payload, signal),
    'settings.update': payload => client.settings.update(payload as Parameters<IApiClient['settings']['update']>[0]),
    'settings.replace': payload => client.settings.replace(payload as Parameters<IApiClient['settings']['replace']>[0]),
    'settings.mutate': payload => client.settings.mutate(payload as Parameters<IApiClient['settings']['mutate']>[0]),
    'credentials.describe': payload => client.credentials.describe(payload as Parameters<IApiClient['credentials']['describe']>[0]),
    'credentials.set': payload => client.credentials.set(payload as Parameters<IApiClient['credentials']['set']>[0]),
    'credentials.unset': payload => client.credentials.unset(payload as Parameters<IApiClient['credentials']['unset']>[0]),
    'llm.providers': payload => client.llm.providers(payload),
    'llm.models': payload => client.llm.models(payload),
    'llm.discoverModels': payload => client.llm.discoverModels(payload as Parameters<IApiClient['llm']['discoverModels']>[0]),
  }
}

function notifyHarnessState(): void {
  mainWindow?.webContents.send('jimu:harness:changed', harnessState)
  mainWindow?.webContents.send('jimu:plugins:changed', { phase: harnessState.phase })
  notifyOnboarding()
}

async function ensurePluginManagementFiles(): Promise<void> {
  pluginPolicy ??= await loadPluginPolicy(pluginPolicyPath())
  await ensurePluginOverlay(pluginOverlayPath)
  const overlay = await readPluginOverlay(pluginOverlayPath)
  try {
    validatePluginOverlay(pluginPolicy, overlay)
  } catch {
    // A user-controlled file can never escape the reviewed policy boundary.
    await writePluginOverlay(pluginOverlayPath, '[]\n')
  }
}

async function registerKnowledgeWorkspace(client: IApiClient, root: string): Promise<void> {
  unwrapResponse(await client.workspace.create({ path: root }))
}

async function startHarnessRuntime(): Promise<HarnessRuntime> {
  await mkdir(harnessHome, { recursive: true })
  await ensurePluginManagementFiles()
  const desktopOverlay = join(app.getAppPath(), 'config', 'desktop.cordis.yml')
  const { ctx, shutdown } = await runProfile({
    profile: 'web',
    patchFiles: [desktopOverlay, pluginOverlayPath],
    args: [],
    environment: loadLayeredEnv('dsh'),
    // The profile fallback is a flat closure over every Harness plugin.
    // Electron lacks Node's private ESM loader, so resolve bare names from
    // that generated node_modules directory instead.
    bareModuleBaseUrl: join(harnessHome, 'profiles', 'package.json'),
    watchUserPatches: false,
    embedded: true,
  })
  const apiProxy = ctx.apiProxy
  const client = new InProcessApiClient(toFetchHandler(apiProxy))
  const root = knowledge?.root
  if (root !== null && root !== undefined) await registerKnowledgeWorkspace(client, root)
  const inventoryService = (ctx.get as unknown as (name: string) => unknown)('pluginInventory') as { list(): { entries: PluginInventoryEntry[] } } | undefined
  if (inventoryService === undefined) {
    await shutdown.shutdown(1)
    throw new Error('Harness plugin inventory service is unavailable')
  }
  return {
    apiProxy,
    client,
    shutdown,
    pluginInventory: () => inventoryService.list().entries.map(entry => ({
      entryId: entry.entryId,
      moduleName: entry.moduleName,
      enabled: entry.enabled,
      fiberPhase: entry.fiberPhase,
    })),
  }
}

async function initializeHarness(): Promise<void> {
  harnessState = { phase: 'booting' }
  notifyHarnessState()
  try {
    harnessRuntime = await startHarnessRuntime()
    lastPluginInventory = harnessRuntime.pluginInventory()
    harnessState = { phase: 'ready' }
  } catch (error) {
    const detail = formatError(error)
    console.error('[JiMu] Harness failed to start\n', detail)
    harnessRuntime = null
    harnessState = { phase: 'error', error: detail }
  }
  notifyHarnessState()
}

async function pluginSnapshot(): Promise<PluginManagementSnapshot> {
  pluginPolicy ??= await loadPluginPolicy(pluginPolicyPath())
  const inventory = harnessRuntime?.pluginInventory() ?? lastPluginInventory
  if (harnessRuntime !== null) lastPluginInventory = inventory
  return projectPluginSnapshot(pluginPolicy, inventory, harnessState.phase, await readPluginOverlay(pluginOverlayPath))
}

function stopHarnessStreams(): void {
  for (const controller of streamControllers) controller.abort(new Error('Harness runtime is restarting'))
  streamControllers.clear()
}

async function restartHarness(previousOverlay: string): Promise<{ restored: boolean }> {
  if (harnessRestarting) throw new Error('Harness is already restarting')
  harnessRestarting = true
  harnessState = { phase: 'restarting' }
  notifyHarnessState()
  stopHarnessStreams()
  const previousRuntime = harnessRuntime
  harnessRuntime = null
  try {
    await previousRuntime?.shutdown.shutdown(0)
    harnessRuntime = await startHarnessRuntime()
    lastPluginInventory = harnessRuntime.pluginInventory()
    harnessState = { phase: 'ready' }
    notifyHarnessState()
    return { restored: false }
  } catch (error) {
    const failedDetail = formatError(error)
    console.error('[JiMu] Harness plugin restart failed; restoring previous overlay\n', failedDetail)
    try {
      await writePluginOverlay(pluginOverlayPath, previousOverlay)
      harnessRuntime = await startHarnessRuntime()
      lastPluginInventory = harnessRuntime.pluginInventory()
      harnessState = { phase: 'ready', notice: '插件变更未应用，已恢复上一个可用配置。' }
      notifyHarnessState()
      return { restored: true }
    } catch (restoreError) {
      const detail = `${failedDetail}\nRollback failed:\n${formatError(restoreError)}`
      harnessRuntime = null
      harnessState = { phase: 'error', error: detail }
      notifyHarnessState()
      throw new Error(detail)
    }
  } finally {
    harnessRestarting = false
  }
}

function registerProtocolHandlers(): void {
  const rendererRoot = join(app.getAppPath(), 'dist', 'renderer')
  protocol.handle('jimu-app', async (request) => {
    const requestUrl = new URL(request.url)
    if (requestUrl.pathname.startsWith('/_asset/')) {
      if (knowledge === null) return new Response('Knowledge service unavailable', { status: 503 })
      try {
        const token = requestUrl.pathname.slice('/_asset/'.length)
        const file = await knowledge.resolveAssetToken(token)
        const info = await stat(file)
        const mime = JIMU_ASSET_MIME[extname(file).toLocaleLowerCase('zh-CN')] ?? 'application/octet-stream'
        if (!mime.startsWith('image/')) return new Response('Only image previews are available on this route', { status: 415 })
        return new Response(Readable.toWeb(createReadStream(file)) as never, {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(info.size),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      } catch (error) {
        return new Response(error instanceof Error ? error.message : String(error), { status: 403 })
      }
    }
    const requested = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '') || 'index.html'
    const file = resolve(rendererRoot, requested)
    if (!isInside(rendererRoot, file)) return new Response('Blocked', { status: 403 })
    return net.fetch(pathToFileURL(file).href)
  })
  protocol.handle('jimu-plugin', () => new Response('JiMu has no registered client plugin asset for this URL.', { status: 404 }))
  protocol.handle('jimu-asset', async (request) => {
    if (knowledge === null) return new Response('Knowledge service unavailable', { status: 503 })
    try {
      const token = new URL(request.url).pathname.replace(/^\/+/, '')
      const file = await knowledge.resolveAssetToken(token)
      // net.fetch(file://) ignores Range and reports no Content-Length, which
      // makes <video> reject the stream. Serve assets ourselves with proper
      // byte-range semantics so local media can play and seek.
      const info = await stat(file)
      const mime = JIMU_ASSET_MIME[extname(file).toLocaleLowerCase('zh-CN')] ?? 'application/octet-stream'
      const rangeHeader = request.headers.get('range')
      const rangeMatch = rangeHeader === null ? null : /^bytes=(\d*)-(\d*)$/.exec(rangeHeader)
      if (rangeMatch !== null) {
        const start = rangeMatch[1] === '' ? 0 : Number(rangeMatch[1])
        let end = rangeMatch[2] === '' ? info.size - 1 : Number(rangeMatch[2])
        if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Invalid range request')
        if (end >= info.size) end = info.size - 1
        if (start > end || start >= info.size) {
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
        }
        return new Response(Readable.toWeb(createReadStream(file, { start, end })) as never, {
          status: 206,
          headers: {
            'Content-Type': mime,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          },
        })
      }
      return new Response(Readable.toWeb(createReadStream(file)) as never, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(info.size),
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 403 })
    }
  })
}

function openHarnessEventPort(event: IpcMainEvent): void {
  assertTrustedEvent(event)
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('JiMu rejected an event stream without a sender frame')
  const { port1, port2 } = new MessageChannelMain()
  senderFrame.postMessage('jimu:harness:event-port', null, [port2])
  port1.start()
  if (harnessRuntime === null) {
    port1.postMessage({ stream: 'system', frame: { type: 'stream/error', error: { message: harnessState.error ?? 'Harness is still starting' } } })
    port1.close()
    return
  }
  const controller = new AbortController()
  streamControllers.add(controller)
  port1.on('message', ({ data }) => {
    if (data && typeof data === 'object' && (data as JsonRecord).type === 'close') controller.abort()
  })
  port1.on('close', () => { controller.abort() })
  const pump = async (stream: 'mux' | 'host'): Promise<void> => {
    const iterable = stream === 'mux'
      ? harnessRuntime?.client.events.mux({}, controller.signal)
      : harnessRuntime?.client.events.host({}, controller.signal)
    if (iterable === undefined) return
    try {
      for await (const frame of iterable) port1.postMessage({ stream, frame })
    } catch (error) {
      if (!controller.signal.aborted) port1.postMessage({ stream, frame: { type: 'stream/error', error: { message: formatError(error) } } })
    }
  }
  void Promise.all([pump('mux'), pump('host')]).finally(() => {
    streamControllers.delete(controller)
    port1.close()
  })
}

function installMenu(): void {
  const settings: Electron.MenuItemConstructorOptions = {
    label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('jimu:command:settings'),
  }
  const search: Electron.MenuItemConstructorOptions = {
    label: '搜索全部档案', accelerator: 'CmdOrCtrl+K', click: () => mainWindow?.webContents.send('jimu:command:search'),
  }
  const edit: Electron.MenuItemConstructorOptions = {
    label: '编辑',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' }, search,
    ],
  }
  const view: Electron.MenuItemConstructorOptions = {
    label: '显示',
    submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
  }
  const template: Electron.MenuItemConstructorOptions[] = process.platform === 'darwin'
    ? [
      {
        label: 'JiMu',
        submenu: [
          { role: 'about' }, { type: 'separator' }, settings, { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' }, { role: 'quit' },
        ],
      },
      edit,
      view,
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] },
    ]
    : [
      { label: '文件', submenu: [settings, { type: 'separator' }, { role: 'quit', label: '退出 JiMu' }] },
      edit,
      view,
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
      { label: '帮助', submenu: [{ label: '关于 JiMu', click: () => { app.showAboutPanel() } }] },
    ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpcHandlers(): void {
  ipcMain.handle('jimu:onboarding:snapshot', async (event) => {
    assertTrustedEvent(event)
    return await onboardingSnapshot()
  })
  ipcMain.handle('jimu:onboarding:set-modules', async (event, request: unknown) => {
    assertTrustedEvent(event)
    return await setOnboardingModules(request)
  })
  ipcMain.handle('jimu:onboarding:install-default', async (event, request: unknown) => {
    assertTrustedEvent(event)
    return await installDefaultKnowledge(request)
  })
  ipcMain.handle('jimu:onboarding:preview-existing', async (event, request: unknown) => {
    assertTrustedEvent(event)
    return await previewExistingKnowledge(request)
  })
  ipcMain.handle('jimu:onboarding:apply-existing', async (event, request: unknown) => {
    assertTrustedEvent(event)
    return await applyExistingKnowledge(request)
  })
  ipcMain.handle('jimu:onboarding:test-deepseek', async (event, request: unknown) => {
    assertTrustedEvent(event)
    return await testAndSaveDeepSeek(request)
  })
  ipcMain.handle('jimu:onboarding:update-modules', async (event, request: unknown) => {
    assertTrustedEvent(event)
    return await updateKnowledgeModules(request)
  })
  ipcMain.handle('jimu:knowledge:get-setup', async (event) => {
    assertTrustedEvent(event)
    knowledgeSetup.template.bundled = await pathExists(join(knowledgeTemplateDirectory(), 'jimu-knowledge.json'))
    return knowledgeSetup
  })
  ipcMain.handle('jimu:knowledge:create-starter', async (event, request: unknown) => {
    assertTrustedEvent(event)
    return await createKnowledgeStarter(request)
  })
  ipcMain.handle('jimu:knowledge:snapshot', (event) => {
    assertTrustedEvent(event)
    if (knowledge === null) throw new Error('Knowledge service is not ready')
    return knowledge.getClientSnapshot()
  })
  ipcMain.handle('jimu:knowledge:list-cards', (event, request: unknown) => {
    assertTrustedEvent(event)
    if (knowledge === null) throw new Error('Knowledge service is not ready')
    return knowledge.listCards(request)
  })
  ipcMain.handle('jimu:knowledge:search', (event, request: unknown) => {
    assertTrustedEvent(event)
    if (knowledge === null) throw new Error('Knowledge service is not ready')
    return knowledge.search(request)
  })
  ipcMain.handle('jimu:knowledge:read-document', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (knowledge === null) throw new Error('Knowledge service is not ready')
    return await knowledge.readDocument(request)
  })
  ipcMain.handle('jimu:knowledge:resolve-link', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (knowledge === null) throw new Error('Knowledge service is not ready')
    return await knowledge.resolveLink(request)
  })
  ipcMain.handle('jimu:knowledge:graph', (event, filters: unknown) => {
    assertTrustedEvent(event)
    if (knowledge === null) throw new Error('Knowledge service is not ready')
    return knowledge.getGraph(filters)
  })
  ipcMain.handle('jimu:knowledge:choose-root', async (event) => {
    assertTrustedEvent(event)
    const owner = mainWindow
    if (owner === null) throw new Error('JiMu window is unavailable')
    const result = await dialog.showOpenDialog(owner, {
      title: '选择 JiMu 知识库',
      buttonLabel: '选择此知识库',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths[0] === undefined) return { canceled: true }
    const root = await realpath(result.filePaths[0])
    const module = await loadKnowledgeModule()
    const settings = await readSettings()
    const modules = selectedKnowledgeModules(settings)
    const inspection = await module.inspectKnowledgeRoot(root, { requiredModules: requiredKnowledgeModules(modules) })
    if (inspection.phase !== 'ready') return { canceled: false, accepted: false, setup: projectKnowledgeSetup(inspection) }
    const setup = await activateKnowledgeRoot(inspection, modules, 'existing')
    return { canceled: false, accepted: true, root, setup, snapshot: knowledge?.getClientSnapshot() }
  })
  ipcMain.handle('jimu:factory:snapshot', (event) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return factory.getSnapshot()
  })
  ipcMain.handle('jimu:factory:list-assets', (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return factory.listAssets(request)
  })
  ipcMain.handle('jimu:factory:create-inspiration', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return await factory.createInspiration(request)
  })
  ipcMain.handle('jimu:factory:promote-topic', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return await factory.promoteTopic(request)
  })
  ipcMain.handle('jimu:factory:save-content', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return await factory.saveContentRevision(request)
  })
  ipcMain.handle('jimu:factory:read-content', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return await factory.readContent(request)
  })
  ipcMain.handle('jimu:factory:approve-script', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return await factory.approveScript(request)
  })
  ipcMain.handle('jimu:factory:link-agent', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return await factory.linkAgentSession(request)
  })
  ipcMain.handle('jimu:factory:save-publication', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return await factory.savePublication(request)
  })
  ipcMain.handle('jimu:factory:add-metrics', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    return await factory.addMetricSnapshot(request)
  })
  ipcMain.handle('jimu:factory:import-metrics-csv', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null || mainWindow === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    const value = asRecord(request)
    const publicationId = typeof value.publicationId === 'string' ? value.publicationId : ''
    if (!publicationId) throw new Error('Publication id is required')
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '导入自媒体数据 CSV',
      buttonLabel: '导入数据',
      filters: [{ name: 'CSV 数据', extensions: ['csv'] }],
      properties: ['openFile'],
    })
    if (selection.canceled || selection.filePaths[0] === undefined) return { canceled: true }
    return { canceled: false, ...await factory.importMetricsCsvFile(selection.filePaths[0], publicationId) as JsonRecord }
  })
  ipcMain.handle('jimu:factory:import-assets', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (factory === null || mainWindow === null) throw new Error('module-disabled: 自媒体工厂未启用或尚未准备好')
    const value = asRecord(request)
    const kind = typeof value.kind === 'string' ? value.kind : 'image'
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '导入自媒体素材',
      buttonLabel: '导入素材',
      filters: [
        { name: 'JiMu 素材', extensions: ['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mts', 'mxf', 'webm', 'aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav', 'ari', 'braw', 'crm', 'r3d', 'aep', 'drp', 'mogrt', 'prproj'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })
    if (selection.canceled || selection.filePaths.length === 0) return { canceled: true, imported: [] }
    return { canceled: false, ...await factory.importAssets(selection.filePaths, kind) as JsonRecord }
  })
  ipcMain.handle('jimu:harness:status', (event) => {
    assertTrustedEvent(event)
    return {
      ...harnessState,
      plugins: (harnessRuntime?.pluginInventory() ?? lastPluginInventory).map(entry => entry.moduleName),
    }
  })
  ipcMain.handle('jimu:plugins:snapshot', async (event) => {
    assertTrustedEvent(event)
    return await pluginSnapshot()
  })
  ipcMain.handle('jimu:plugins:apply-toggles', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (pluginOperationPending) throw new Error('Another plugin operation is already in progress')
    pluginOperationPending = true
    try {
      if (harnessRuntime === null || harnessState.phase !== 'ready') throw new Error('Harness must be ready before plugins can change')
      if (harnessRestarting) throw new Error('Harness is already restarting')
      const value = asRecord(request)
      const revision = typeof value.revision === 'string' ? value.revision : ''
      const requestedGroups = value.groups
      if (!Array.isArray(requestedGroups)) throw new Error('Plugin group changes must be an array')
      const current = await pluginSnapshot()
      if (revision !== current.revision) throw new Error('Plugin state changed; refresh the page before applying again')
      const running = unwrapResponse(await harnessRuntime.client.sessions.list({})) as { items: Array<{ running: boolean }> }
      if (running.items.some(session => session.running)) throw new Error('有 Agent 任务正在运行，请先完成或停止任务再应用插件变更。')
      pluginPolicy ??= await loadPluginPolicy(pluginPolicyPath())
      const toggleableGroups = pluginPolicy.groups.filter(group => group.management === 'toggleable')
      const toggleable = new Map(toggleableGroups.map(group => [group.id, group]))
      const desiredGroups = current.groups.filter(group => group.management === 'toggleable')
      const desired = Object.fromEntries(desiredGroups.map(group => [group.id, group.enabled]))
      const seen = new Set<string>()
      for (const candidate of requestedGroups) {
        const change = asRecord(candidate)
        const id = typeof change.id === 'string' ? change.id : ''
        if (!toggleable.has(id)) throw new Error(`Plugin group is locked or unknown: ${id}`)
        if (seen.has(id)) throw new Error(`Plugin group change is duplicated: ${id}`)
        if (typeof change.enabled !== 'boolean') throw new Error(`Plugin group must have a boolean state: ${id}`)
        seen.add(id)
        desired[id] = change.enabled
      }
      const previousOverlay = await readPluginOverlay(pluginOverlayPath)
      const nextOverlay = renderPluginOverlay(pluginPolicy, desired)
      if (nextOverlay === previousOverlay) return { applied: false, restored: false, snapshot: current }
      await writePluginOverlay(pluginOverlayPath, nextOverlay)
      const outcome = await restartHarness(previousOverlay)
      if (outcome.restored) throw new Error('插件变更未应用，已恢复上一个可用配置。')
      const snapshot = await pluginSnapshot()
      const mismatched = snapshot.groups.filter(group => group.management === 'toggleable'
        && (group.mixed || group.enabled !== desired[group.id] || group.presentEntryIds.length !== group.entryIds.length))
      if (mismatched.length > 0) {
        await writePluginOverlay(pluginOverlayPath, previousOverlay)
        await restartHarness(previousOverlay)
        harnessState = { phase: 'ready', notice: '插件状态校验失败，已恢复上一个可用配置。' }
        notifyHarnessState()
        const names = mismatched.map(group => group.label).join('、')
        throw new Error(`插件状态校验失败，已恢复上一个可用配置：${names}`)
      }
      return { applied: true, restored: false, snapshot }
    } finally {
      pluginOperationPending = false
    }
  })
  ipcMain.handle('jimu:plugins:restart', async (event) => {
    assertTrustedEvent(event)
    if (pluginOperationPending) throw new Error('Another plugin operation is already in progress')
    pluginOperationPending = true
    try {
      if (harnessState.phase === 'restarting') throw new Error('Harness is already restarting')
      if (harnessRuntime !== null) {
        const running = unwrapResponse(await harnessRuntime.client.sessions.list({})) as { items: Array<{ running: boolean }> }
        if (running.items.some(session => session.running)) throw new Error('有 Agent 任务正在运行，请先完成或停止任务再重启 Harness。')
      }
      const overlay = await readPluginOverlay(pluginOverlayPath)
      const outcome = await restartHarness(overlay)
      if (outcome.restored) throw new Error('Harness 重启失败，已恢复上一个可用配置。')
      return await pluginSnapshot()
    } finally {
      pluginOperationPending = false
    }
  })
  ipcMain.handle('jimu:harness:call', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (harnessRuntime === null) throw new Error(harnessState.error ?? 'Harness is still starting')
    const value = asRecord(request)
    const method = typeof value.method === 'string' ? value.method : ''
    const payload = asRecord(value.payload ?? {})
    const call = harnessCalls(harnessRuntime.client)[method]
    if (call === undefined) throw new Error(`Unsupported Harness operation: ${method}`)
    return unwrapResponse(await call(payload))
  })
  ipcMain.handle('jimu:harness:respond', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (harnessRuntime === null) throw new Error(harnessState.error ?? 'Harness is still starting')
    return await harnessRuntime.client.respond(asRecord(request) as never)
  })
  ipcMain.handle('jimu:harness:choose-project', async (event) => {
    assertTrustedEvent(event)
    const owner = mainWindow
    if (owner === null) throw new Error('JiMu window is unavailable')
    const result = await dialog.showOpenDialog(owner, {
      title: '导入 Harness 项目',
      buttonLabel: '导入项目',
      properties: ['openDirectory'],
    })
    return result.canceled || result.filePaths[0] === undefined
      ? { canceled: true }
      : { canceled: false, path: await realpath(result.filePaths[0]) }
  })
  ipcMain.handle('jimu:project:list-files', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (harnessRuntime === null) throw new Error(harnessState.error ?? 'Harness is still starting')
    const value = asRecord(request)
    const projectPath = typeof value.projectPath === 'string' ? value.projectPath : ''
    if (!projectPath) throw new Error('Project path is required')
    // Only enumerate real imported workspaces; the renderer never supplies
    // an arbitrary directory to walk.
    const workspaceState = await harnessRuntime.client.workspace.list({})
    const workspaceResult = unwrapResponse(workspaceState) as { items?: Array<{ path?: string }> }
    const real = await realpath(projectPath)
    let allowed = false
    for (const item of workspaceResult.items ?? []) {
      if (typeof item.path !== 'string' || item.path === '') continue
      try {
        if ((await realpath(item.path)) === real) {
          allowed = true
          break
        }
      } catch {
        // Missing or unreadable workspace path: skip it.
      }
    }
    if (!allowed) throw new Error('Project path is not an imported workspace')
    // Optional relative subdirectory: browsing a directory loads its full
    // subtree instead of whatever the project-wide recent cutoff retained.
    const rawDir = typeof value.dir === 'string' ? value.dir.trim() : ''
    const base = rawDir === '' ? real : join(real, ...rawDir.split('/').filter(Boolean))
    if (!isInside(real, base)) throw new Error('Directory escapes the project root')
    const files = await listProjectFiles(base, 0)
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const withPrefix = rawDir === '' ? files : files.map(file => ({ ...file, relativePath: `${rawDir.replace(/\/+$/, '')}/${file.relativePath}` }))
    return { files: withPrefix.slice(0, rawDir === '' ? 2000 : 1000) }
  })
  ipcMain.handle('jimu:usage:scan-external', async (event) => {
    assertTrustedEvent(event)
    return scanExternalHomes()
  })
  ipcMain.handle('jimu:harness:export-session', async (event, request: unknown) => {
    assertTrustedEvent(event)
    if (harnessRuntime === null || mainWindow === null) throw new Error('Harness is unavailable')
    const value = asRecord(request)
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
    if (!sessionId) throw new Error('Session id is required')
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出 Harness 会话',
      defaultPath: `${sessionId}.zip`,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    })
    if (result.canceled || result.filePath === '') return { canceled: true }
    const controller = new AbortController()
    const response = await harnessRuntime.apiProxy.downloads.sessionLog({ sessionId: sessionId as never }, controller.signal)
    if (!response.ok || response.body === null) throw new Error(`Session export failed (${response.status})`)
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(result.filePath, { mode: 0o600 }))
    return { canceled: false, path: result.filePath }
  })
  ipcMain.handle('jimu:shell:open-external', async (event, request: unknown) => {
    assertTrustedEvent(event)
    const value = asRecord(request)
    const url = typeof value.url === 'string' ? new URL(value.url) : null
    if (url === null || !ALLOWED_EXTERNAL_PROTOCOLS.has(url.protocol)) throw new Error('JiMu blocked an unsupported external URL')
    await shell.openExternal(url.href, { activate: true })
    return { opened: true }
  })
}

function createWindow(): BrowserWindow {
  const preferredDisplay = process.env.JIMU_PREFER_SECONDARY_DISPLAY === '1'
    ? screen.getAllDisplays().find(display => display.id !== screen.getPrimaryDisplay().id)
    : undefined
  const preferredArea = preferredDisplay?.workArea
  const initialWidth = Math.min(1512, preferredArea?.width ?? 1512)
  const initialHeight = Math.min(982, preferredArea?.height ?? 982)
  const window = new BrowserWindow({
    title: 'JiMu',
    width: initialWidth,
    height: initialHeight,
    ...(preferredArea === undefined ? {} : {
      x: preferredArea.x + Math.max(0, Math.floor((preferredArea.width - initialWidth) / 2)),
      y: preferredArea.y + Math.max(0, Math.floor((preferredArea.height - initialHeight) / 2)),
    }),
    minWidth: 1120,
    minHeight: 720,
    movable: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    backgroundColor: '#0e0d2b',
    show: false,
    ...(process.platform === 'win32'
      ? {
        titleBarStyle: 'hidden' as const,
        titleBarOverlay: { color: '#0e0d2b', symbolColor: '#fff', height: 48 },
      }
      : {
        titleBarStyle: 'hiddenInset' as const,
        trafficLightPosition: { x: 18, y: 18 },
      }),
    icon: applicationIconPath(),
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('jimu-app://')) event.preventDefault()
  })
  window.once('ready-to-show', () => { window.show() })
  window.on('closed', () => { if (mainWindow === window) mainWindow = null })
  void window.loadURL('jimu-app://app/index.html')
  return window
}

async function cleanup(): Promise<void> {
  if (cleanupStarted) return
  cleanupStarted = true
  unsubscribeKnowledge?.()
  unsubscribeKnowledge = null
  unsubscribeFactory?.()
  unsubscribeFactory = null
  knowledge?.close()
  knowledge = null
  factory?.close()
  factory = null
  for (const controller of streamControllers) controller.abort()
  streamControllers.clear()
  await harnessRuntime?.shutdown.shutdown(0)
  harnessRuntime = null
  ipcMain.removeListener('jimu:harness:open-events', openHarnessEventPort)
  for (const channel of IPC_HANDLER_CHANNELS) ipcMain.removeHandler(channel)
  cleanupFinished = true
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!windowCreationReady) return
    if (mainWindow === null) mainWindow = createWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('before-quit', (event) => {
    if (cleanupFinished) return
    event.preventDefault()
    void cleanup().finally(() => { app.quit() })
  })
  app.on('window-all-closed', () => { app.quit() })
  app.on('activate', () => {
    if (windowCreationReady && mainWindow === null) mainWindow = createWindow()
  })
  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)
    app.dock?.setIcon(applicationIconPath())
    registerProtocolHandlers()
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })
    installMenu()
    registerIpcHandlers()
    ipcMain.on('jimu:harness:open-events', openHarnessEventPort)
    await initializeKnowledge()
    windowCreationReady = true
    if (mainWindow === null) mainWindow = createWindow()
    void initializeHarness()
  })
}
