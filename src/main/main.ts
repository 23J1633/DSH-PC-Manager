import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron'
import type { ChatInput, CleanupInput, SaveSettingsInput, ScanKind, ScanTarget } from '../shared/types.js'
import { BUILT_IN_PRESETS } from './prompt-library.js'
import { HistoryStore } from './history-store.js'
import { OperationController } from './operation-controller.js'
import { suggestLocalPaths } from './path-suggestions.js'
import { SettingsStore } from './settings-store.js'
import { systemOverview } from './system-overview.js'

app.setName('DSH PC Manager')

const UI_ZOOM_BASE = 1.25

let mainWindow: BrowserWindow | undefined
let operationController: OperationController | undefined
let settingsStore: SettingsStore | undefined
let historyStore: HistoryStore | undefined
let quitting = false

function assertRenderer(event: IpcMainInvokeEvent): void {
  const sender = event.senderFrame
  if (sender === null) throw new Error('拒绝未知来源的请求')
  const url = new URL(sender.url)
  if (url.protocol !== 'file:') throw new Error('拒绝非应用页面的请求')
}

function applicationPath(...parts: string[]): string {
  return join(app.getAppPath(), ...parts)
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function requestAdministratorRestart(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const executable = process.execPath
  const launchArguments = app.isPackaged ? [] : [app.getAppPath()]
  const argumentExpression = launchArguments.length === 0
    ? ''
    : ` -ArgumentList @(${launchArguments.map(powershellLiteral).join(',')})`
  const command = `Start-Process -FilePath ${powershellLiteral(executable)}${argumentExpression} -Verb RunAs`
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  app.releaseSingleInstanceLock()
  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    const powershellPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: 'ignore',
    })
    child.once('error', rejectPromise)
    child.once('exit', resolvePromise)
  }).catch(error => {
    app.requestSingleInstanceLock()
    throw error
  })
  if (exitCode !== 0) {
    app.requestSingleInstanceLock()
    return false
  }
  quitting = true
  app.quit()
  return true
}

function createWindow(fontScale: number): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 720,
    show: false,
    frame: false,
    title: 'DSH PC Manager',
    backgroundColor: '#f6f7fb',
    autoHideMenuBar: true,
    icon: applicationPath('dist', 'icon.png'),
    webPreferences: {
      preload: applicationPath('dist-electron', 'src', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })
  window.webContents.setZoomFactor(UI_ZOOM_BASE * fontScale)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => { event.preventDefault() })
  const smokeScreenshotPath = process.env.DSH_PC_MANAGER_SMOKE_SCREENSHOT
  if (smokeScreenshotPath !== undefined && smokeScreenshotPath.length > 0) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          let rendererReady = false
          for (let attempt = 0; attempt < 100; attempt += 1) {
            rendererReady = await window.webContents.executeJavaScript("document.querySelector('.app-shell') !== null") as boolean
            if (rendererReady) break
            await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
          }
          if (!rendererReady) throw new Error('Renderer did not become ready for smoke capture')
          const smokeClickSelector = process.env.DSH_PC_MANAGER_SMOKE_CLICK
          if (smokeClickSelector !== undefined && smokeClickSelector.length > 0) {
            const selector = JSON.stringify(smokeClickSelector)
            await window.webContents.executeJavaScript(`document.querySelector(${selector})?.click()`)
            await new Promise(resolvePromise => setTimeout(resolvePromise, 300))
          }
          const smokeActionsText = process.env.DSH_PC_MANAGER_SMOKE_ACTIONS
          if (smokeActionsText !== undefined && smokeActionsText.length > 0) {
            const parsed = JSON.parse(smokeActionsText) as unknown
            if (!Array.isArray(parsed) || parsed.length > 20) throw new Error('Invalid smoke action list')
            for (const candidate of parsed) {
              if (typeof candidate !== 'object' || candidate === null) throw new Error('Invalid smoke action')
              const action = candidate as Record<string, unknown>
              if (typeof action.selector !== 'string' || action.selector.length > 500) throw new Error('Invalid smoke selector')
              const payload = JSON.stringify({ type: action.type, selector: action.selector, value: action.value })
              await window.webContents.executeJavaScript(`(() => {
                const action = ${payload};
                const element = document.querySelector(action.selector);
                if (!element) throw new Error('Smoke element not found: ' + action.selector);
                if (action.type === 'click') element.click();
                else if (action.type === 'input' && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
                  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
                  setter?.call(element, String(action.value ?? ''));
                  element.dispatchEvent(new Event('input', { bubbles: true }));
                } else throw new Error('Unsupported smoke action');
              })()`)
              await new Promise(resolvePromise => setTimeout(resolvePromise, 450))
            }
            await new Promise(resolvePromise => setTimeout(resolvePromise, 700))
          }
          const outputPath = resolve(smokeScreenshotPath)
          await mkdir(dirname(outputPath), { recursive: true })
          const image = await window.webContents.capturePage()
          await writeFile(outputPath, image.toPNG())
          app.quit()
        })().catch(error => {
          console.error('UI smoke capture failed', error)
          app.exit(1)
        })
      }, 200)
    })
  }
  window.once('ready-to-show', () => { window.show() })
  void window.loadFile(applicationPath('dist', 'index.html'))
  return window
}

async function initialize(): Promise<void> {
  const userData = app.getPath('userData')
  const homePath = app.getPath('home')
  const quarantinePath = join(userData, 'quarantine')
  const overview = await systemOverview(homePath, quarantinePath)
  settingsStore = new SettingsStore(userData)
  await settingsStore.load()
  historyStore = new HistoryStore(userData)
  await historyStore.load()
  const patchPath = app.isPackaged
    ? join(process.resourcesPath, 'dsh', 'pc-manager.patch.yml')
    : applicationPath('resources', 'dsh', 'pc-manager.patch.yml')
  operationController = new OperationController(settingsStore, {
    rootPath: overview.rootPath,
    dshHome: join(userData, 'dsh-runtime'),
    quarantinePath,
    patchPath,
  }, event => {
    historyStore?.record(event)
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pc-manager:operation-event', event)
    }
  })

  ipcMain.handle('pc-manager:bootstrap', async event => {
    assertRenderer(event)
    return {
      appVersion: app.getVersion(),
      settings: settingsStore?.publicSettings(),
      system: overview,
      lifetimeUsage: settingsStore?.lifetimeUsage(),
      builtInPresets: BUILT_IN_PRESETS,
    }
  })
  ipcMain.handle('pc-manager:settings-save', async (event, input: SaveSettingsInput) => {
    assertRenderer(event)
    if (settingsStore === undefined) throw new Error('设置服务尚未就绪')
    const saved = await settingsStore.save(input)
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.setZoomFactor(UI_ZOOM_BASE * saved.fontScale)
    return saved
  })
  ipcMain.handle('pc-manager:scan-start', async (event, kind: ScanKind, targets: ScanTarget[]) => {
    assertRenderer(event)
    if (kind !== 'disk' && kind !== 'virus') throw new Error('未知扫描类型')
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    return { operationId: await operationController.startScan(kind, Array.isArray(targets) ? targets : []) }
  })
  ipcMain.handle('pc-manager:cleanup-start', (event, input: CleanupInput) => {
    assertRenderer(event)
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    return { operationId: operationController.startCleanup(input) }
  })
  ipcMain.handle('pc-manager:chat-send', async (event, input: ChatInput) => {
    assertRenderer(event)
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    return { operationId: await operationController.startChat(input) }
  })
  ipcMain.handle('pc-manager:operation-cancel', async (event, operationId: string) => {
    assertRenderer(event)
    if (typeof operationId !== 'string') throw new Error('无效任务 ID')
    await operationController?.cancel(operationId)
  })
  ipcMain.handle('pc-manager:connection-test', async (event, input: Pick<SaveSettingsInput, 'provider' | 'model' | 'baseUrl' | 'apiKey'>) => {
    assertRenderer(event)
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    return operationController.testConnection(input)
  })
  ipcMain.handle('pc-manager:directory-choose', async event => {
    assertRenderer(event)
    const parent = mainWindow
    const options: Electron.OpenDialogOptions = {
      title: '选择扫描目录',
      defaultPath: app.getPath('home'),
      properties: ['openDirectory', 'showHiddenFiles', 'dontAddToRecent'],
      buttonLabel: '选择此目录',
    }
    const result = parent === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(parent, options)
    const path = result.filePaths[0]
    if (result.canceled || path === undefined) return undefined
    return { type: 'directory', path, label: path } satisfies ScanTarget
  })
  ipcMain.handle('pc-manager:path-suggest', async (event, query: string) => {
    assertRenderer(event)
    return suggestLocalPaths(typeof query === 'string' ? query : '', homePath, overview.volumes)
  })
  ipcMain.handle('pc-manager:history-list', async event => {
    assertRenderer(event)
    if (historyStore === undefined) throw new Error('历史记录服务尚未就绪')
    return historyStore.list()
  })
  ipcMain.handle('pc-manager:shortcut-create', event => {
    assertRenderer(event)
    const shortcutPath = join(app.getPath('desktop'), 'DSH PC Manager.lnk')
    const created = shell.writeShortcutLink(shortcutPath, 'create', {
      target: process.execPath,
      cwd: app.isPackaged ? dirname(process.execPath) : app.getAppPath(),
      description: '启动 DSH PC Manager AI 智能体电脑管家',
      icon: process.execPath,
      iconIndex: 0,
    })
    if (!created) throw new Error('创建桌面快捷方式失败')
    return shortcutPath
  })
  ipcMain.handle('pc-manager:elevation-request', async event => {
    assertRenderer(event)
    return requestAdministratorRestart()
  })
  ipcMain.handle('pc-manager:path-open', async (event, input: string) => {
    assertRenderer(event)
    if (typeof input !== 'string' || input.length === 0 || input.length > 4096) throw new Error('无效路径')
    const target = resolve(input)
    const failure = await shell.openPath(target)
    if (failure.length > 0) throw new Error(failure)
  })
  ipcMain.handle('pc-manager:external-open', async (event, input: string) => {
    assertRenderer(event)
    if (typeof input !== 'string' || input.length === 0 || input.length > 4096) throw new Error('无效链接')
    const url = new URL(input)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('仅允许打开 HTTP 或 HTTPS 链接')
    await shell.openExternal(url.toString())
  })
  ipcMain.on('pc-manager:window-minimize', event => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('pc-manager:window-toggle-maximize', event => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window?.isMaximized()) window.unmaximize()
    else window?.maximize()
  })
  ipcMain.on('pc-manager:window-close', event => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  mainWindow = createWindow(settingsStore.publicSettings().fontScale)
  mainWindow.once('closed', () => {
    mainWindow = undefined
    if (!quitting) app.quit()
  })

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.dsh.pcmanager')
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: '',
        iconPath: process.execPath,
        iconIndex: 0,
        title: '打开 DSH PC Manager',
        description: '一键启动 AI 智能体电脑管家',
      },
    ])
  }
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    await initialize()
  }).catch(error => {
    console.error(error)
    app.quit()
  })
}

app.on('before-quit', () => {
  quitting = true
  void operationController?.close()
  void historyStore?.flush()
})

app.on('window-all-closed', () => { app.quit() })
