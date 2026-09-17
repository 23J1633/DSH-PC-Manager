import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OperationEvent, OperationHistoryEntry } from '../shared/types.js'
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
      case 'plan':
        next = { ...current, plan: structuredClone(event.plan) }
        break
      case 'tokens':
        next = { ...current, tokenUsage: structuredClone(event.operationUsage) }
        break
      case 'risks':
        next = { ...current, summary: event.summary, risks: structuredClone(event.risks) }
        break
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
          summary: '用户停止了本次任务',
          tokenUsage: structuredClone(event.operationUsage),
        }
        break
      case 'progress':
      case 'tool':
      case 'assistant-message':
        return
    }
    this.entries[index] = next
    this.persistSoon()
  }

  async list(): Promise<OperationHistoryEntry[]> {
    this.assertLoaded()
    await this.writeQueue
    return structuredClone(this.entries)
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
