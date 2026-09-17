import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  BootstrapData,
  ChatInput,
  CleanupInput,
  OperationEvent,
  OperationHistoryEntry,
  PathSuggestion,
  PcManagerApi,
  SaveSettingsInput,
  ScanKind,
  ScanTarget,
  StartOperationResult,
} from '../shared/types.js'

const api: PcManagerApi = {
  bootstrap: () => ipcRenderer.invoke('pc-manager:bootstrap') as Promise<BootstrapData>,
  saveSettings: (settings: SaveSettingsInput) => ipcRenderer.invoke('pc-manager:settings-save', settings) as Promise<AppSettings>,
  startScan: (kind: ScanKind, targets: ScanTarget[]) => ipcRenderer.invoke('pc-manager:scan-start', kind, targets) as Promise<StartOperationResult>,
  startCleanup: (input: CleanupInput) => ipcRenderer.invoke('pc-manager:cleanup-start', input) as Promise<StartOperationResult>,
  sendChat: (input: ChatInput) => ipcRenderer.invoke('pc-manager:chat-send', input) as Promise<StartOperationResult>,
  cancelOperation: (operationId: string) => ipcRenderer.invoke('pc-manager:operation-cancel', operationId) as Promise<void>,
  testConnection: settings => ipcRenderer.invoke('pc-manager:connection-test', settings) as Promise<string>,
  chooseDirectory: () => ipcRenderer.invoke('pc-manager:directory-choose') as Promise<ScanTarget | undefined>,
  suggestPaths: query => ipcRenderer.invoke('pc-manager:path-suggest', query) as Promise<PathSuggestion[]>,
  listHistory: () => ipcRenderer.invoke('pc-manager:history-list') as Promise<OperationHistoryEntry[]>,
  createDesktopShortcut: () => ipcRenderer.invoke('pc-manager:shortcut-create') as Promise<string>,
  requestElevation: () => ipcRenderer.invoke('pc-manager:elevation-request') as Promise<boolean>,
  openPath: path => ipcRenderer.invoke('pc-manager:path-open', path) as Promise<void>,
  openExternal: url => ipcRenderer.invoke('pc-manager:external-open', url) as Promise<void>,
  onOperationEvent(listener: (event: OperationEvent) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, payload: OperationEvent): void => { listener(payload) }
    ipcRenderer.on('pc-manager:operation-event', handler)
    return () => { ipcRenderer.off('pc-manager:operation-event', handler) }
  },
  window: {
    minimize: () => { ipcRenderer.send('pc-manager:window-minimize') },
    toggleMaximize: () => { ipcRenderer.send('pc-manager:window-toggle-maximize') },
    close: () => { ipcRenderer.send('pc-manager:window-close') },
  },
}

contextBridge.exposeInMainWorld('pcManager', api)
