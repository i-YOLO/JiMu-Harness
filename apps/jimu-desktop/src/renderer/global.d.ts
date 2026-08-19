export {}

declare global {
  interface Window {
    jimu?: {
      platform: 'macOS' | 'Windows'
      onboarding: {
        snapshot(): Promise<unknown>
        setModules(request: unknown): Promise<unknown>
        installDefault(request: unknown): Promise<unknown>
        chooseKnowledgeTarget(request: unknown): Promise<unknown>
        previewExisting(request: unknown): Promise<unknown>
        applyExisting(request: unknown): Promise<unknown>
        testAndSaveDeepSeek(request: unknown): Promise<unknown>
        updateModules(request: unknown): Promise<unknown>
        subscribe(listener: (payload: unknown) => void): () => void
      }
      knowledge: {
        getSetup(): Promise<unknown>
        createStarter(request: { folderName: string }): Promise<unknown>
        getOverview(): Promise<unknown>
        listCards(request: unknown): Promise<unknown>
        search(request: unknown): Promise<unknown>
        readDocument(request: unknown): Promise<unknown>
        resolveLink(request: unknown): Promise<unknown>
        chooseRoot(): Promise<unknown>
        getGraph(filters?: unknown): Promise<unknown>
        subscribeChanges(listener: (payload: unknown) => void): () => void
      }
      factory: {
        getOverview(): Promise<unknown>
        listAssets(request: unknown): Promise<unknown>
        createInspiration(request: unknown): Promise<unknown>
        promoteTopic(request: unknown): Promise<unknown>
        saveContentRevision(request: unknown): Promise<unknown>
        readContent(request: unknown): Promise<unknown>
        approveScript(request: unknown): Promise<unknown>
        linkAgentSession(request: unknown): Promise<unknown>
        savePublication(request: unknown): Promise<unknown>
        addMetricSnapshot(request: unknown): Promise<unknown>
        importMetricsCsv(publicationId: string): Promise<unknown>
        importAssets(kind: string): Promise<unknown>
        subscribeChanges(listener: (payload: unknown) => void): () => void
      }
      harness: {
        status(): Promise<unknown>
        call(method: string, payload?: unknown): Promise<unknown>
        respond(message: unknown): Promise<unknown>
        chooseProject(): Promise<unknown>
        exportSession(sessionId: string): Promise<unknown>
        subscribeEvents(listener: (payload: unknown) => void): () => void
        subscribeState(listener: (payload: unknown) => void): () => void
      }
      plugins: {
        snapshot(): Promise<unknown>
        applyToggles(request: unknown): Promise<unknown>
        restart(): Promise<unknown>
        subscribe(listener: (payload: unknown) => void): () => void
      }
      project: { listFiles(projectPath: string, dir?: string): Promise<unknown> }
      usage: { scanExternal(): Promise<unknown> }
      shell: { openExternal(url: string): Promise<unknown> }
      commands: {
        onSearch(listener: () => void): () => void
        onSettings(listener: () => void): () => void
      }
    }
  }
}
