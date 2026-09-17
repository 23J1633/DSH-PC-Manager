import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryStore } from '../src/main/history-store.js'
import { EMPTY_TOKEN_USAGE, type OperationEvent, type RiskItem } from '../src/shared/types.js'

describe('operation history', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      if (!root.startsWith(resolve(tmpdir()))) throw new Error(`Refusing to remove non-temporary path: ${root}`)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists model, token snapshot, and cleanup details', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-history-'))
    roots.push(root)
    const risk: RiskItem = {
      id: 'fixture-risk', scanKind: 'disk', kind: 'file', name: '测试文件', target: join(root, 'cache.tmp'),
      description: '测试', reason: '测试', severity: 'low', recommendedAction: '隔离', evidence: ['fixture'], selectedByDefault: true, reversible: true,
    }
    const events: OperationEvent[] = [
      { type: 'started', operationId: 'cleanup-1', kind: 'cleanup', title: 'Agent 二次研判与清理', startedAt: 10, model: 'deepseek-test', reasoningEffort: 'max', authorizedRisks: [risk], cleanupInstructions: [{ riskId: risk.id, mode: 'manual', instruction: '仅移动到隔离区' }] },
      { type: 'cleanup-report', operationId: 'cleanup-1', report: { summary: '已隔离', results: [{ id: risk.id, status: 'quarantined', action: '移动', detail: '完成', restorePath: join(root, 'quarantine', 'cache.tmp') }], rebootRecommended: false, followup: [] } },
      { type: 'completed', operationId: 'cleanup-1', summary: '已完成', finishedAt: 20, operationUsage: { ...EMPTY_TOKEN_USAGE, inputTokens: 12, outputTokens: 4, totalTokens: 16 } },
    ]
    const store = new HistoryStore(root)
    await store.load()
    for (const event of events) store.record(event)
    await store.flush()

    const reloaded = new HistoryStore(root)
    await reloaded.load()
    const [entry] = await reloaded.list()
    expect(entry).toMatchObject({ model: 'deepseek-test', reasoningEffort: 'max', status: 'completed', tokenUsage: { totalTokens: 16 } })
    expect(entry?.cleanupReport?.results[0]).toMatchObject({ id: risk.id, status: 'quarantined' })
    expect(entry?.cleanupInstructions?.[0]).toMatchObject({ riskId: risk.id, mode: 'manual', instruction: '仅移动到隔离区' })
  })
})
