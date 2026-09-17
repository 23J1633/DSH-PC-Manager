import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ReasoningEffort, TokenUsage } from '../shared/types.js'
import { EMPTY_TOKEN_USAGE } from '../shared/types.js'

interface JsonRpcResponse {
  jsonrpc?: unknown
  id?: unknown
  result?: unknown
  error?: unknown
  method?: unknown
  params?: unknown
}

export interface DshNotification {
  method: string
  params: Record<string, unknown>
}

export interface DshRunResult {
  sessionId: string
  finalResponse: string
  notifications: DshNotification[]
}

export interface DshRuntimeOptions {
  cwd: string
  dshHome: string
  patchPath: string
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
  apiKey: string
  baseUrl: string
  permissionMode: 'read-only' | 'danger-full-access'
  telemetryEnabled: boolean
  maxTokens?: number
  runtimeExecutable?: string
  initializeTimeoutMs?: number
  onNotification?: (notification: DshNotification) => void
}

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
}

interface DshPackageManifest {
  bin?: string | Record<string, string>
}

const require = createRequire(import.meta.url)

function resolveDshBinary(): string {
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DshPackageManifest
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (typeof bin !== 'string' || bin.length === 0) throw new Error('@deepseek-ai/dsh 未提供 dsh 可执行入口')
  return resolve(dirname(manifestPath), bin)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  const entry = asRecord(value)
  if (entry !== undefined && typeof entry.message === 'string') return entry.message
  return String(value)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))
}

export class DshRuntime {
  private child: ChildProcessWithoutNullStreams | undefined
  private stdoutBuffer = ''
  private stderrBuffer = ''
  private readonly stderrTail: string[] = []
  private requestId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly notificationListeners = new Set<(notification: DshNotification) => void>()
  private exitError: Error | undefined
  private exitPromise: Promise<void> | undefined
  private resolveExit: (() => void) | undefined
  private closing = false

  constructor(private readonly options: DshRuntimeOptions) {
    if (options.onNotification !== undefined) this.notificationListeners.add(options.onNotification)
  }

  async start(): Promise<void> {
    if (this.child !== undefined) return
    const dshBinary = resolveDshBinary()
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: this.options.dshHome,
      DSH_PERMISSION_MODE: this.options.permissionMode,
      DEEPSEEK_API_KEY: this.options.apiKey,
      DEEPSEEK_BASE_URL: this.options.baseUrl,
      ...(this.options.telemetryEnabled ? {} : { DSH_TELEMETRY_DISABLED: '1' }),
    }
    const child = spawn(this.options.runtimeExecutable ?? process.execPath, [
      dshBinary,
      '--profile',
      'sdk',
      '--patch',
      this.options.patchPath,
    ], {
      cwd: this.options.cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.exitPromise = new Promise(resolvePromise => { this.resolveExit = resolvePromise })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.consumeStdout(chunk) })
    child.stderr.on('data', (chunk: string) => { this.consumeStderr(chunk) })
    child.once('error', error => { this.fail(new Error(`无法启动 DSH：${error.message}`)) })
    child.once('exit', (code, signal) => {
      const expected = this.closing && (code === 0 || signal !== null)
      if (!expected) this.fail(new Error(`DSH 运行时已退出（code=${String(code)}, signal=${String(signal)}）${this.stderrSummary()}`))
      this.resolveExit?.()
    })
    await this.request('initialize', {
      cwd: this.options.cwd,
      provider: this.options.provider,
      model: this.options.model,
      reasoningEffort: this.options.reasoningEffort,
      ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
    }, this.options.initializeTimeoutMs ?? 120_000)
  }

  async run(prompt: string, sessionId = `pc-${randomUUID().replaceAll('-', '')}`): Promise<DshRunResult> {
    await this.start()
    const notifications: DshNotification[] = []
    const assistantMessages: string[] = []
    let settled = false
    let resolveIdle!: () => void
    const idle = new Promise<void>(resolvePromise => {
      resolveIdle = resolvePromise
    })
    const listener = (notification: DshNotification): void => {
      const relatedSession = notification.params.sessionId
      if (relatedSession !== sessionId) return
      notifications.push(notification)
      if (notification.method === 'session.event') {
        const event = asRecord(notification.params.event)
        const message = event === undefined ? undefined : assistantTextFromEvent(event)
        if (message !== undefined && message.length > 0) assistantMessages.push(message)
      }
      if (notification.method === 'session.status' && notification.params.status === 'idle' && !settled) {
        settled = true
        resolveIdle()
      }
    }
    this.notificationListeners.add(listener)
    try {
      const response = asRecord(await this.request('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text: prompt }],
      }))
      if (response === undefined || typeof response.messageId !== 'string') {
        throw new Error('DSH 未确认本次消息')
      }
      await Promise.race([
        idle,
        this.runtimeFailure().then(error => { throw error }),
      ])
      return {
        sessionId,
        finalResponse: assistantMessages.at(-1) ?? '',
        notifications,
      }
    } finally {
      this.notificationListeners.delete(listener)
    }
  }

  async close(force = false): Promise<void> {
    const child = this.child
    if (child === undefined) return
    this.closing = true
    if (!force && child.exitCode === null && child.signalCode === null) {
      await this.request('shutdown', {}, 2_000).catch(() => undefined)
      child.stdin.end()
      await Promise.race([this.exitPromise, wait(3_000)])
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await Promise.race([this.exitPromise, wait(2_000)])
    }
    if (child.exitCode === null && child.signalCode === null && process.platform === 'win32' && child.pid !== undefined) {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      await new Promise<void>(resolvePromise => killer.once('exit', () => { resolvePromise() }))
      await Promise.race([this.exitPromise, wait(2_000)])
    }
    const error = new Error(force ? '操作已取消' : 'DSH 运行时已关闭')
    for (const [id, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private request(method: string, params: object, timeoutMs?: number): Promise<unknown> {
    const child = this.child
    if (child === undefined) return Promise.reject(new Error('DSH 运行时尚未启动'))
    if (this.exitError !== undefined) return Promise.reject(this.exitError)
    const id = ++this.requestId
    return new Promise((resolvePromise, rejectPromise) => {
      const pending: PendingRequest = {
        method,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: undefined,
      }
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id)
          rejectPromise(new Error(`DSH ${method} 请求等待超过 ${timeoutMs}ms${this.stderrSummary()}`))
        }, timeoutMs)
      }
      this.pending.set(id, pending)
      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
      child.stdin.write(payload, error => {
        if (error === null || error === undefined) return
        const current = this.pending.get(id)
        if (current === undefined) return
        this.pending.delete(id)
        if (current.timer !== undefined) clearTimeout(current.timer)
        current.reject(new Error(`无法向 DSH 发送 ${method}：${error.message}`))
      })
    })
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk
    const lines = this.stdoutBuffer.split(/\r?\n/)
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let frame: JsonRpcResponse
      try {
        frame = JSON.parse(trimmed) as JsonRpcResponse
      } catch {
        this.fail(new Error(`DSH 返回了无效协议帧：${trimmed.slice(0, 300)}`))
        continue
      }
      this.consumeFrame(frame)
    }
  }

  private consumeFrame(frame: JsonRpcResponse): void {
    if (typeof frame.id === 'number') {
      const pending = this.pending.get(frame.id)
      if (pending === undefined) return
      this.pending.delete(frame.id)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      if (frame.error !== undefined) {
        pending.reject(new Error(`DSH ${pending.method} 失败：${errorMessage(frame.error)}${this.stderrSummary()}`))
      } else {
        pending.resolve(frame.result)
      }
      return
    }
    if (typeof frame.method !== 'string') return
    const notification: DshNotification = {
      method: frame.method,
      params: asRecord(frame.params) ?? {},
    }
    for (const listener of this.notificationListeners) {
      try {
        listener(notification)
      } catch (error) {
        console.error('DSH notification listener failed', error)
      }
    }
  }

  private consumeStderr(chunk: string): void {
    this.stderrBuffer += chunk
    const lines = this.stderrBuffer.split(/\r?\n/)
    this.stderrBuffer = lines.pop() ?? ''
    this.stderrTail.push(...lines.filter(line => line.trim().length > 0))
    if (this.stderrTail.length > 80) this.stderrTail.splice(0, this.stderrTail.length - 80)
  }

  private fail(error: Error): void {
    this.exitError ??= error
    for (const [id, pending] of this.pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      pending.reject(this.exitError)
      this.pending.delete(id)
    }
  }

  private stderrSummary(): string {
    const tail = [...this.stderrTail, this.stderrBuffer.trim()].filter(Boolean).slice(-20)
    return tail.length === 0 ? '' : `\nDSH 日志：\n${tail.join('\n')}`
  }

  private async runtimeFailure(): Promise<Error> {
    await this.exitPromise
    return this.exitError ?? new Error(`DSH 运行时提前退出${this.stderrSummary()}`)
  }
}

export function assistantTextFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'assistant/message') return undefined
  const data = asRecord(event.data)
  const message = asRecord(data?.message)
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  return content
    .map(block => {
      const entry = asRecord(block)
      return entry?.type === 'text' && typeof entry.text === 'string' ? entry.text : ''
    })
    .filter(Boolean)
    .join('')
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizedUsage(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value)
  if (usage === undefined) return undefined
  const inputTokens = token(usage.inputTokens)
  const outputTokens = token(usage.outputTokens)
  const totalTokens = token(usage.totalTokens) || inputTokens + outputTokens
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens: token(usage.cacheReadTokens),
    cacheWriteTokens: token(usage.cacheWriteTokens),
    reasoningTokens: token(usage.reasoningTokens),
  }
}

export function tokenUsageFromEvent(event: Record<string, unknown>): TokenUsage | undefined {
  const data = asRecord(event.data)
  if (event.type === 'assistant/message') return normalizedUsage(data?.usage)
  if (event.type !== 'assistant/attempt' || !Array.isArray(data?.stream)) return undefined
  let total: TokenUsage | undefined
  for (const item of data.stream) {
    const stream = asRecord(item)
    const chunk = asRecord(stream?.chunk)
    if (chunk?.type !== 'usage') continue
    const usage = normalizedUsage(chunk.usage)
    if (usage === undefined) continue
    total = addTokenUsage(total ?? EMPTY_TOKEN_USAGE, usage)
  }
  return total
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  }
}

export function sessionEventFromNotification(notification: DshNotification): Record<string, unknown> | undefined {
  return notification.method === 'session.event' ? asRecord(notification.params.event) : undefined
}
