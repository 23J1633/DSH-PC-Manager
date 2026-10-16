import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OperationEvent, OperationHistoryEntry, OperationResumeSnapshot, OperationResumeState } from '../shared/types.js'
import { EMPTY_TOKEN_USAGE } from '../shared/types.js'

const MAX_HISTORY_ENTRIES = 80

interface HistoryDocument {
  version: 1
  entries: OperationHistoryEntry[]
}

function isHistoryEntry(value: unknown): value is OperationHistoryEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.kind === 'string'
    && typeof entry.title === 'string'
    && typeof entry.startedAt === 'number'
    && typeof entry.model === 'string'
    && typeof entry.summary === 'string'
    && typeof entry.tokenUsage === 'object'
    && Array.isArray(entry.targets)
    && Array.isArray(entry.risks)
}

export class HistoryStore {
  private readonly path: string
  private entries: OperationHistoryEntry[] = []
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'operation-history.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      const document = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      this.entries = Array.isArray(document.entries)
        ? document.entries.filter(isHistoryEntry).slice(0, MAX_HISTORY_ENTRIES)
        : []
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    this.loaded = true
    let recovered = false
    this.entries = this.entries.map(entry => {
      if (entry.status !== 'running') return entry
      recovered = true
      return {
        ...entry,
        status: 'interrupted',
        finishedAt: Date.now(),
        summary: '应用在任务完成前退出。可以从原 DSH 会话继续。',
      }
    })
    if (recovered) this.persistSoon()
  }

  record(event: OperationEvent): void {
    this.assertLoaded()
    if (event.type === 'started') {
      const entry: OperationHistoryEntry = {
        id: event.operationId,
        kind: event.kind,
        title: event.title,
        status: 'running',
        startedAt: event.startedAt,
        summary: '任务正在进行',
        model: event.model,
        reasoningEffort: event.reasoningEffort,
        tokenUsage: { ...EMPTY_TOKEN_USAGE },
        targets: structuredClone(event.targets ?? []),
        risks: structuredClone(event.authorizedRisks ?? []),
        cleanupInstructions: structuredClone(event.cleanupInstructions ?? []),
        ...(event.resumeState === undefined ? {} : { resumeState: structuredClone(event.resumeState) }),
        ...(event.resumedFrom === undefined ? {} : { resumedFrom: event.resumedFrom }),
        ...(event.relatedOperationId === undefined ? {} : { relatedOperationId: event.relatedOperationId }),
        requestCount: 0,
        trajectory: [],
        selectedRiskIds: (event.authorizedRisks ?? []).map(risk => risk.id),
        steeringNotes: [],
      }
      if (event.resumedFrom !== undefined) {
        this.entries = this.entries.map(item => {
          if (item.id !== event.resumedFrom) return item
          const { resumeState: _resumeState, ...source } = item
          return { ...source, summary: `已由新任务 ${event.operationId} 继续。` }
        })
      }
      this.entries = [entry, ...this.entries.filter(item => item.id !== entry.id)].slice(0, MAX_HISTORY_ENTRIES)
      this.persistSoon()
      return
    }
    const index = this.entries.findIndex(item => item.id === event.operationId)
    if (index < 0) return
    const current = this.entries[index]
    if (current === undefined) return
    let next = current
    switch (event.type) {
      case 'checkpoint':
        next = { ...current, resumeState: structuredClone(event.resumeState) }
        break
      case 'plan':
        next = { ...current, plan: structuredClone(event.plan) }
        break
      case 'tokens':
        next = { ...current, tokenUsage: structuredClone(event.operationUsage) }
        break
      case 'risks':
        next = { ...current, summary: event.summary, risks: structuredClone(event.risks) }
        break
      case 'trace': {
        const trajectory = [...(current.trajectory ?? []), structuredClone(event.entry)].slice(-300)
        const requestCount = (current.requestCount ?? 0) + (event.entry.type === 'assistant/message' || event.entry.type === 'assistant/attempt' ? 1 : 0)
        next = { ...current, trajectory, requestCount }
        break
      }
      case 'steering': {
        const risks = [...current.risks]
        const byId = new Map(risks.map(risk => [risk.id, risk]))
        for (const risk of [...event.cleanup.risks, ...(event.cleanup.ignoredRisks ?? [])]) byId.set(risk.id, structuredClone(risk))
        next = {
          ...current,
          risks: [...byId.values()],
          cleanupInstructions: structuredClone(event.cleanup.instructions),
          selectedRiskIds: event.cleanup.risks.map(risk => risk.id),
          steeringNotes: [...(current.steeringNotes ?? []), event.message.slice(0, 2000)].slice(-100),
        }
        break
      }
      case 'audit-report':
        next = { ...current, auditReport: structuredClone(event.report), summary: event.report.summary }
        break
      case 'cleanup-report':
        next = { ...current, cleanupReport: structuredClone(event.report), summary: event.report.summary }
        break
      case 'completed':
        next = {
          ...current,
          status: 'completed',
          finishedAt: event.finishedAt,
          summary: event.summary,
          tokenUsage: structuredClone(event.operationUsage),
        }
        delete next.resumeState
        break
      case 'failed':
        next = {
          ...current,
          status: 'failed',
          finishedAt: event.finishedAt,
          summary: event.message,
          tokenUsage: structuredClone(event.operationUsage),
        }
        break
      case 'cancelled':
        next = {
          ...current,
          status: 'cancelled',
          finishedAt: event.finishedAt,
          summary: event.summary ?? '用户停止了本次任务',
          tokenUsage: structuredClone(event.operationUsage),
        }
        delete next.resumeState
        break
      case 'progress':
      case 'tool':
      case 'assistant-message':
      case 'statistics':
        return
    }
    this.entries[index] = next
    this.persistSoon()
  }

  async list(): Promise<OperationHistoryEntry[]> {
    this.assertLoaded()
    await this.writeQueue
    return this.entries.map(({ resumeState, ...entry }) => ({
      ...structuredClone(entry),
      ...(resumeState !== undefined && (entry.status === 'interrupted' || entry.status === 'failed') ? { canResume: true } : {}),
    }))
  }

  async getResumeSnapshot(entryId: string): Promise<OperationResumeSnapshot | undefined> {
    this.assertLoaded()
    await this.writeQueue
    const entry = this.entries.find(candidate => candidate.id === entryId)
    if (entry === undefined || (entry.status !== 'interrupted' && entry.status !== 'failed') || entry.resumeState === undefined) return undefined
    if (!isResumeState(entry.resumeState)) return undefined
    return { entry: structuredClone(entry), resumeState: structuredClone(entry.resumeState) }
  }

  async flush(): Promise<void> {
    await this.writeQueue
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('历史记录尚未加载')
  }

  private persistSoon(): void {
    this.writeQueue = this.writeQueue
      .then(async () => { await this.persist() })
      .catch(error => { console.error('Failed to persist operation history', error) })
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    const document: HistoryDocument = { version: 1, entries: this.entries }
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }
}

function isResumeState(value: unknown): value is OperationResumeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  const task = typeof state.task === 'object' && state.task !== null && !Array.isArray(state.task)
    ? state.task as Record<string, unknown>
    : undefined
  const sessions = typeof state.sessionIds === 'object' && state.sessionIds !== null && !Array.isArray(state.sessionIds)
    ? state.sessionIds as Record<string, unknown>
    : undefined
  if (task === undefined || sessions === undefined) return false
  const validSessionId = (value: unknown): value is string => typeof value === 'string' && /^pc-[a-f0-9]{32}$/u.test(value)
  if (!validSessionId(sessions.readOnly) || !validSessionId(sessions.writable) || !validSessionId(sessions.repair)) return false
  if (state.phase !== 'scan-planning' && state.phase !== 'scan-execution' && state.phase !== 'cleanup-audit'
    && state.phase !== 'cleanup-execution' && state.phase !== 'chat' && state.phase !== 'repair') return false
  if (task.kind === 'scan') return (state.phase === 'scan-planning' || state.phase === 'scan-execution')
    && (task.scanKind === 'disk' || task.scanKind === 'virus') && Array.isArray(task.targets)
    && task.targets.length > 0 && task.targets.length <= 16
  if (task.kind === 'cleanup') {
    const input = typeof task.input === 'object' && task.input !== null ? task.input as Record<string, unknown> : undefined
    return (state.phase === 'cleanup-audit' || state.phase === 'cleanup-execution')
      && typeof task.quarantineId === 'string' && /^cleanup-[a-f0-9-]{36}$/u.test(task.quarantineId)
      && input !== undefined && (input.sourceScanKind === 'disk' || input.sourceScanKind === 'virus' || input.sourceScanKind === 'memory')
      && (task.relaxedPermissions === undefined || typeof task.relaxedPermissions === 'boolean')
      && Array.isArray(input.risks) && input.risks.length > 0 && input.risks.length <= 200
      && Array.isArray(input.ignoredRisks) && Array.isArray(input.instructions)
  }
  if (task.kind === 'chat') {
    const input = typeof task.input === 'object' && task.input !== null ? task.input as Record<string, unknown> : undefined
    return state.phase === 'chat' && input !== undefined && typeof input.message === 'string'
      && Array.isArray(input.relatedRisks) && Array.isArray(input.referencedPaths)
      && typeof input.operationMode === 'boolean'
  }
  if (task.kind === 'repair') return state.phase === 'repair' && typeof task.errorText === 'string'
  return false
}
