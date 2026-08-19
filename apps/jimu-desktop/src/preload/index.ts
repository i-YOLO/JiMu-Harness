import { contextBridge, ipcRenderer } from 'electron'

type ChangeListener = (payload: unknown) => void
type JimuPlatform = 'macOS' | 'Windows'

const platform: JimuPlatform = process.platform === 'win32' ? 'Windows' : 'macOS'

const bridge = {
  platform,
  onboarding: {
    snapshot: () => ipcRenderer.invoke('jimu:onboarding:snapshot'),
    setModules: (request: unknown) => ipcRenderer.invoke('jimu:onboarding:set-modules', request),
    installDefault: (request: unknown) => ipcRenderer.invoke('jimu:onboarding:install-default', request),
    chooseKnowledgeTarget: (request: unknown) => ipcRenderer.invoke('jimu:onboarding:choose-knowledge-target', request),
    previewExisting: (request: unknown) => ipcRenderer.invoke('jimu:onboarding:preview-existing', request),
    applyExisting: (request: unknown) => ipcRenderer.invoke('jimu:onboarding:apply-existing', request),
    testAndSaveDeepSeek: (request: unknown) => ipcRenderer.invoke('jimu:onboarding:test-deepseek', request),
    updateModules: (request: unknown) => ipcRenderer.invoke('jimu:onboarding:update-modules', request),
    subscribe(listener: ChangeListener) {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => { listener(payload) }
      ipcRenderer.on('jimu:onboarding:changed', wrapped)
      return () => ipcRenderer.removeListener('jimu:onboarding:changed', wrapped)
    },
  },
  knowledge: {
    getSetup: () => ipcRenderer.invoke('jimu:knowledge:get-setup'),
    createStarter: (request: unknown) => ipcRenderer.invoke('jimu:knowledge:create-starter', request),
    getOverview: () => ipcRenderer.invoke('jimu:knowledge:snapshot'),
    listCards: (request: unknown) => ipcRenderer.invoke('jimu:knowledge:list-cards', request),
    search: (request: unknown) => ipcRenderer.invoke('jimu:knowledge:search', request),
    readDocument: (request: unknown) => ipcRenderer.invoke('jimu:knowledge:read-document', request),
    resolveLink: (request: unknown) => ipcRenderer.invoke('jimu:knowledge:resolve-link', request),
    chooseRoot: () => ipcRenderer.invoke('jimu:knowledge:choose-root'),
    getGraph: (filters?: unknown) => ipcRenderer.invoke('jimu:knowledge:graph', filters),
    subscribeChanges(listener: ChangeListener) {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => { listener(payload) }
      ipcRenderer.on('jimu:knowledge:changed', wrapped)
      return () => ipcRenderer.removeListener('jimu:knowledge:changed', wrapped)
    },
  },
  factory: {
    getOverview: () => ipcRenderer.invoke('jimu:factory:snapshot'),
    listAssets: (request: unknown) => ipcRenderer.invoke('jimu:factory:list-assets', request),
    createInspiration: (request: unknown) => ipcRenderer.invoke('jimu:factory:create-inspiration', request),
    promoteTopic: (request: unknown) => ipcRenderer.invoke('jimu:factory:promote-topic', request),
    saveContentRevision: (request: unknown) => ipcRenderer.invoke('jimu:factory:save-content', request),
    readContent: (request: unknown) => ipcRenderer.invoke('jimu:factory:read-content', request),
    approveScript: (request: unknown) => ipcRenderer.invoke('jimu:factory:approve-script', request),
    linkAgentSession: (request: unknown) => ipcRenderer.invoke('jimu:factory:link-agent', request),
    savePublication: (request: unknown) => ipcRenderer.invoke('jimu:factory:save-publication', request),
    addMetricSnapshot: (request: unknown) => ipcRenderer.invoke('jimu:factory:add-metrics', request),
    importMetricsCsv: (publicationId: string) => ipcRenderer.invoke('jimu:factory:import-metrics-csv', { publicationId }),
    importAssets: (kind: string) => ipcRenderer.invoke('jimu:factory:import-assets', { kind }),
    subscribeChanges(listener: ChangeListener) {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => { listener(payload) }
      ipcRenderer.on('jimu:factory:changed', wrapped)
      return () => ipcRenderer.removeListener('jimu:factory:changed', wrapped)
    },
  },
  harness: {
    status: () => ipcRenderer.invoke('jimu:harness:status'),
    call: (method: string, payload: unknown = {}) => ipcRenderer.invoke('jimu:harness:call', { method, payload }),
    respond: (message: unknown) => ipcRenderer.invoke('jimu:harness:respond', message),
    chooseProject: () => ipcRenderer.invoke('jimu:harness:choose-project'),
    exportSession: (sessionId: string) => ipcRenderer.invoke('jimu:harness:export-session', { sessionId }),
    subscribeEvents(listener: ChangeListener) {
      let port: MessagePort | undefined
      let disposed = false
      const receivePort = (event: Electron.IpcRendererEvent) => {
        port = event.ports[0]
        if (port === undefined) return
        if (disposed) {
          port.close()
          return
        }
        port.onmessage = ({ data }) => { listener(data) }
        port.start()
      }
      ipcRenderer.once('jimu:harness:event-port', receivePort)
      ipcRenderer.send('jimu:harness:open-events')
      return () => {
        disposed = true
        ipcRenderer.removeListener('jimu:harness:event-port', receivePort)
        port?.postMessage({ type: 'close' })
        port?.close()
      }
    },
    subscribeState(listener: ChangeListener) {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => { listener(payload) }
      ipcRenderer.on('jimu:harness:changed', wrapped)
      return () => ipcRenderer.removeListener('jimu:harness:changed', wrapped)
    },
  },
  plugins: {
    snapshot: () => ipcRenderer.invoke('jimu:plugins:snapshot'),
    applyToggles: (request: unknown) => ipcRenderer.invoke('jimu:plugins:apply-toggles', request),
    restart: () => ipcRenderer.invoke('jimu:plugins:restart'),
    subscribe(listener: ChangeListener) {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => { listener(payload) }
      ipcRenderer.on('jimu:plugins:changed', wrapped)
      return () => ipcRenderer.removeListener('jimu:plugins:changed', wrapped)
    },
  },
  project: {
    listFiles: (projectPath: string, dir?: string) => ipcRenderer.invoke('jimu:project:list-files', { projectPath, ...(dir ? { dir } : {}) }),
  },
  usage: {
    scanExternal: () => ipcRenderer.invoke('jimu:usage:scan-external'),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('jimu:shell:open-external', { url }),
  },
  commands: {
    onSearch(listener: () => void) {
      const wrapped = () => { listener() }
      ipcRenderer.on('jimu:command:search', wrapped)
      return () => ipcRenderer.removeListener('jimu:command:search', wrapped)
    },
    onSettings(listener: () => void) {
      const wrapped = () => { listener() }
      ipcRenderer.on('jimu:command:settings', wrapped)
      return () => ipcRenderer.removeListener('jimu:command:settings', wrapped)
    },
  },
}

contextBridge.exposeInMainWorld('jimu', bridge)
