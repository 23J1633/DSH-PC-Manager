import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent } from 'electron'
import type { ChatInput, CleanupInput, CleanupSteeringInput, MemoryProcessCandidate, SaveSettingsInput, ScanKind, ScanTarget } from '../shared/types.js'
import { BUILT_IN_PRESETS } from './prompt-library.js'
import { HistoryStore } from './history-store.js'
import { inspectMemory } from './memory-optimizer.js'
import { OperationController } from './operation-controller.js'
import { suggestLocalPaths } from './path-suggestions.js'
import { resolveQuarantinePath } from './quarantine-path.js'
import { SettingsStore } from './settings-store.js'
import { systemOverview } from './system-overview.js'

app.setName('DSH PC Manager')

const smokeUserDataPath = process.env.DSH_PC_MANAGER_USER_DATA
if (smokeUserDataPath !== undefined && smokeUserDataPath.trim().length > 0) {
  app.setPath('userData', resolve(smokeUserDataPath))
}

const UI_ZOOM_BASE = 1.25

let mainWindow: BrowserWindow | undefined
let operationController: OperationController | undefined
let settingsStore: SettingsStore | undefined
let historyStore: HistoryStore | undefined
let quitting = false
let shutdownInProgress = false
let shutdownComplete = false

async function clearQuarantineContents(quarantinePath: string): Promise<{ removedCount: number }> {
  if (quarantinePath.trim().length === 0) throw new Error('隔离区不可用，拒绝清空。')
  const root = resolve(quarantinePath)
  const rootInfo = await lstat(root).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (rootInfo === undefined) return { removedCount: 0 }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('隔离区路径不是安全的普通目录，拒绝清空。')

  const entries = await readdir(root)
  let removedCount = 0
  for (const entry of entries) {
    const target = resolve(root, entry)
    if (dirname(target) !== root) throw new Error('隔离区包含无效路径，拒绝清空。')
    await rm(target, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 })
    removedCount += 1
  }
  return { removedCount }
}

function assertRenderer(event: IpcMainInvokeEvent): void {
  const sender = event.senderFrame
  if (sender === null) throw new Error('拒绝未知来源的请求')
  const url = new URL(sender.url)
  if (url.protocol !== 'file:') throw new Error('拒绝非应用页面的请求')
}

function applicationPath(...parts: string[]): string {
  return join(app.getAppPath(), ...parts)
}

function resolveDshPatchPath(): string {
  const candidates = [
    join(process.resourcesPath, 'dsh', 'pc-manager.patch.yml'),
    applicationPath('resources', 'dsh', 'pc-manager.patch.yml'),
  ]
  const patchPath = candidates.find(candidate => existsSync(candidate))
  if (patchPath === undefined) {
    throw new Error(`DSH 系统补丁文件缺失，已检查：${candidates.join('；')}`)
  }
  return patchPath
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
  window.webContents.once('did-finish-load', () => {
    window.webContents.setZoomFactor(UI_ZOOM_BASE * fontScale)
  })
  const smokeScreenshotPath = process.env.DSH_PC_MANAGER_SMOKE_SCREENSHOT
  if (smokeScreenshotPath !== undefined && smokeScreenshotPath.length > 0) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          let rendererReady = false
          for (let attempt = 0; attempt < 100; attempt += 1) {
            rendererReady = await window.webContents.executeJavaScript("document.querySelector('.app-shell') !== null && document.querySelector('.loading-screen') === null") as boolean
            if (rendererReady) break
            await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
          }
          if (!rendererReady) throw new Error('Renderer did not become ready for smoke capture')
          await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
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
                } else if (action.type === 'hover') {
                  const bounds = element.getBoundingClientRect();
                  const fraction = Math.max(0, Math.min(1, Number(action.value ?? 0.65)));
                  element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: bounds.left + bounds.width * fraction, clientY: bounds.top + bounds.height / 2, pointerType: 'mouse' }));
                } else throw new Error('Unsupported smoke action');
              })()`)
              await new Promise(resolvePromise => setTimeout(resolvePromise, 450))
            }
            await new Promise(resolvePromise => setTimeout(resolvePromise, 700))
          }
          if (process.env.DSH_PC_MANAGER_SMOKE_TRACE === '1') {
            const operationId = `smoke-trace-${Date.now()}`
            const startedAt = Date.now() - 12_000
            const now = Date.now()
            window.webContents.send('pc-manager:operation-event', {
              type: 'started', operationId, kind: 'disk', title: '硬盘清理扫描', startedAt,
              model: 'deepseek-v4-flash', reasoningEffort: 'high',
              targets: [{ type: 'drive', path: 'C:\\', label: '本机系统盘 (C:\\)' }],
            })
            window.webContents.send('pc-manager:operation-event', {
              type: 'plan', operationId, plan: {
                summary: '按目录枚举范围、核验候选项并生成只读风险清单。', source: 'agent',
                steps: [
                  { id: 'enumerate', title: '枚举所选目录', description: '按目录检查缓存、转储与大型文件来源。', expectedTools: 2 },
                  { id: 'verify', title: '核验候选证据', description: '复核路径、大小和可恢复条件。', expectedTools: 3 },
                ],
              },
            })
            const entries = [
              { id: 'smoke-user', type: 'user/message', turn: 1, step: 1, label: 'User', detail: '检查 C:\\Users\\29715\\AppData 下可清理的临时内容。', input: '检查 C:\\Users\\29715\\AppData 下可清理的临时内容。', time: startedAt + 100 },
              { id: 'smoke-thinking', type: 'assistant/attempt', turn: 1, step: 1, label: 'Thinking', detail: '先确认目标范围，再逐个目录只读核验。', reasoning: '先确认目标范围，再逐个目录只读核验。', time: startedAt + 850, reasoningTokens: 128 },
              { id: 'smoke-tool-call', type: 'tool/call', turn: 1, step: 1, label: 'PowerShell', detail: '', input: 'Get-ChildItem -LiteralPath C:\\Users\\29715\\AppData -Force', time: startedAt + 1400 },
              { id: 'smoke-tool-result', type: 'tool/result', turn: 1, step: 1, label: 'PowerShell', detail: '已枚举 6 个目录，发现 2 个缓存候选。', output: '已枚举 6 个目录，发现 2 个缓存候选。', time: startedAt + 7100, durationMs: 5700 },
              { id: 'smoke-assistant', type: 'assistant/message', turn: 1, step: 2, label: 'Assistant', detail: '已完成目录核验，生成 2 项供你复核。', output: '已完成目录核验，生成 2 项供你复核。', time: startedAt + 10_500, inputTokens: 840, outputTokens: 96, reasoningTokens: 128 },
            ]
            window.webContents.send('pc-manager:operation-event', {
              type: 'progress', operationId, stage: '第 1/2 步 · 枚举所选目录',
              message: '正在逐目录检查。工具执行期间进度条持续移动，并显示当前工具耗时。', progress: 38,
              planStepId: 'enumerate', completedPlanStepIds: [],
            })
            window.webContents.send('pc-manager:operation-event', {
              type: 'tool', operationId, tool: 'PowerShell', label: '文件搜索',
              detail: '当前目标：C:\\Users\\29715\\AppData', time: now - 5700,
            })
            for (const entry of entries) window.webContents.send('pc-manager:operation-event', { type: 'trace', operationId, entry })
            if (process.env.DSH_PC_MANAGER_SMOKE_TRACE_EXPAND === '1') {
              let trajectoryReady = false
              for (let attempt = 0; attempt < 40; attempt += 1) {
                trajectoryReady = await window.webContents.executeJavaScript("document.querySelector('.trajectory-panel') !== null") as boolean
                if (trajectoryReady) break
                await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
              }
              if (!trajectoryReady) throw new Error('Agent trajectory did not render for smoke capture')
              await window.webContents.executeJavaScript(`(() => {
                const panel = document.querySelector('.trajectory-panel');
                panel?.querySelector(':scope > summary')?.click();
                panel?.scrollIntoView({ block: 'center' });
              })()`)
              await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
            }
          }
          const outputPath = resolve(smokeScreenshotPath)
          await mkdir(dirname(outputPath), { recursive: true })
          const smokeMetrics = await window.webContents.executeJavaScript(`(() => {
            const dialog = document.querySelector('.memory-dialog')
            const bounds = dialog?.getBoundingClientRect()
            return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio, dialogFontSize: dialog ? getComputedStyle(dialog).fontSize : null, dialogWidth: bounds?.width ?? null, dialogHeight: bounds?.height ?? null }
          })()`)
          console.info(`UI smoke metrics: ${JSON.stringify({ zoomFactor: window.webContents.getZoomFactor(), fontScale: settingsStore?.publicSettings().fontScale, ...smokeMetrics })}`)
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
  const overview = await systemOverview(homePath)
  let quarantinePath = ''
  let quarantineMessage: string | undefined
  try {
    quarantinePath = await resolveQuarantinePath(userData, overview.volumes)
  } catch (error) {
    quarantineMessage = error instanceof Error ? error.message : String(error)
  }
  overview.quarantinePath = quarantinePath
  if (quarantineMessage !== undefined) overview.quarantineMessage = quarantineMessage
  settingsStore = new SettingsStore(userData)
  await settingsStore.load()
  historyStore = new HistoryStore(userData)
  await historyStore.load()
  const patchPath = resolveDshPatchPath()
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
  }, async () => { await historyStore?.flush() })

  ipcMain.handle('pc-manager:bootstrap', async event => {
    assertRenderer(event)
    return {
      appVersion: app.getVersion(),
      settings: settingsStore?.publicSettings(),
      system: overview,
      lifetimeUsage: settingsStore?.lifetimeUsage(),
      statistics: settingsStore?.statistics(),
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
  ipcMain.handle('pc-manager:cleanup-steer', async (event, input: CleanupSteeringInput) => {
    assertRenderer(event)
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    if (typeof input !== 'object' || input === null || typeof input.operationId !== 'string' || typeof input.message !== 'string') throw new Error('插话内容无效')
    await operationController.steerCleanup(input)
  })
  ipcMain.handle('pc-manager:chat-send', async (event, input: ChatInput) => {
    assertRenderer(event)
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    return { operationId: await operationController.startChat(input) }
  })
  ipcMain.handle('pc-manager:repair-start', async (event, errorText: string) => {
    assertRenderer(event)
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    return { operationId: await operationController.startSelfRepair(typeof errorText === 'string' ? errorText : '') }
  })
  ipcMain.handle('pc-manager:operation-resume', async (event, historyEntryId: string) => {
    assertRenderer(event)
    if (typeof historyEntryId !== 'string' || historyEntryId.length > 200) throw new Error('无效历史任务 ID')
    if (historyStore === undefined || operationController === undefined) throw new Error('Agent 服务尚未就绪')
    const snapshot = await historyStore.getResumeSnapshot(historyEntryId)
    if (snapshot === undefined) throw new Error('此历史任务没有可继续的中断状态')
    return { operationId: await operationController.resume(snapshot) }
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
  ipcMain.handle('pc-manager:memory-inspect', async event => {
    assertRenderer(event)
    return inspectMemory()
  })
  ipcMain.handle('pc-manager:memory-analysis-start', event => {
    assertRenderer(event)
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    return { operationId: operationController.startMemoryAnalysis() }
  })
  ipcMain.handle('pc-manager:memory-optimization-start', (event, candidates: MemoryProcessCandidate[]) => {
    assertRenderer(event)
    if (operationController === undefined) throw new Error('Agent 服务尚未就绪')
    if (!Array.isArray(candidates)) throw new Error('内存优化进程列表无效')
    return { operationId: operationController.startMemoryOptimization(candidates) }
  })
  ipcMain.handle('pc-manager:quarantine-clear', async event => {
    assertRenderer(event)
    return clearQuarantineContents(quarantinePath)
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
    const info = await stat(target).catch(() => undefined)
    if (info?.isFile()) {
      shell.showItemInFolder(target)
      return
    }
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
    dialog.showErrorBox('无法安全启动 DSH PC Manager', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}

app.on('before-quit', event => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownInProgress) return
  shutdownInProgress = true
  quitting = true
  void (async () => {
    try {
      await operationController?.close()
      await historyStore?.flush()
    } catch (error) {
      console.error('Failed to flush application state before exit', error)
    } finally {
      shutdownComplete = true
      app.quit()
    }
  })()
})

app.on('window-all-closed', () => { app.quit() })
