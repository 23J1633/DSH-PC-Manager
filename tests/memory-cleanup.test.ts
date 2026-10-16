import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, AppStatisticsSnapshot, MemoryOptimizationResult, MemoryOverview, OperationEvent, RiskItem, TokenUsage } from '../src/shared/types.js'

const memoryHarness = vi.hoisted(() => ({ optimizedPids: [] as number[] }))
const overview: MemoryOverview = {
  totalBytes: 16 * 1024 ** 3,
  availableBytes: 4 * 1024 ** 3,
  checkedAt: 1,
  candidates: [{ pid: 41, name: 'Browser', memoryBytes: 700 * 1024 ** 2, reason: 'snapshot' }],
}

vi.mock('../src/main/memory-optimizer.js', () => ({
  inspectMemory: async () => structuredClone(overview),
  optimizeMemory: async (pids: readonly number[]): Promise<MemoryOptimizationResult> => {
    memoryHarness.optimizedPids = [...pids]
    return {
      requested: pids.length,
      optimized: pids.length,
      reclaimedBytes: 40 * 1024 ** 2,
      details: pids.map(pid => ({ pid, name: 'Browser', beforeBytes: 700 * 1024 ** 2, afterBytes: 660 * 1024 ** 2, success: true, message: 'working set trimmed' })),
    }
  },
}))

vi.mock('../src/main/dsh-runtime.js', () => ({
  addTokenUsage: (usage: TokenUsage, delta: TokenUsage): TokenUsage => ({
    inputTokens: usage.inputTokens + delta.inputTokens,
    outputTokens: usage.outputTokens + delta.outputTokens,
    totalTokens: usage.totalTokens + delta.totalTokens,
    cacheReadTokens: usage.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens + delta.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens + delta.reasoningTokens,
  }),
  assistantTextFromEvent: () => undefined,
  DshRuntime: class {
    async run(prompt: string): Promise<{ finalResponse: string }> {
      return prompt.includes('<memory-process-snapshot>')
        ? { finalResponse: '<dsh-pc-manager-memory>{"summary":"已评估一个普通应用进程。","candidates":[{"pid":41,"reason":"浏览器工作集较大，可在保存内容后尝试回收。"}]}</dsh-pc-manager-memory>' }
        : { finalResponse: '<dsh-pc-manager-memory-review>{"summary":"进程身份正常，可以回收工作集。","approvedPids":[41],"rejected":[]}</dsh-pc-manager-memory-review>' }
    }
    async close(): Promise<void> {}
  },
  sessionEventFromNotification: () => undefined,
  tokenUsageFromEvent: () => undefined,
}))

import { OperationController } from '../src/main/operation-controller.js'
import { EMPTY_TOKEN_USAGE } from '../src/shared/types.js'
import type { SettingsStore } from '../src/main/settings-store.js'

function statistics(): AppStatisticsSnapshot {
  return { lifetimeRequests: 0, lifetimeScans: 0, lifetimeScannedItems: 0, lifetimeCleanupRuns: 0, lifetimeCleanedItems: 0, daily: [] }
}

function waitForCompletion(events: OperationEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const poll = (): void => {
      const failure = events.find(event => event.type === 'failed')
      if (failure?.type === 'failed') {
        reject(new Error(failure.message))
        return
      }
      if (events.some(event => event.type === 'completed')) {
        resolve()
        return
      }
      if (Date.now() - startedAt > 5000) {
        reject(new Error('Timed out waiting for the operation'))
        return
      }
      setTimeout(poll, 10)
    }
    poll()
  })
}

describe('Agent-driven memory cleanup', () => {
  it('puts Agent-reviewed memory candidates in the shared cleanup flow without a quarantine directory', async () => {
    memoryHarness.optimizedPids = []
    const settings: AppSettings = {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high', baseUrl: 'https://api.deepseek.com',
      apiKeyConfigured: true, theme: 'system', fontScale: 1, activePresetId: 'balanced-cleaner', customPresets: [],
      scanDepth: 'standard', includeNetworkDrives: false, quarantineRetentionDays: 30, relaxedPermissions: false, telemetryEnabled: false,
    }
    const snapshot = statistics()
    const settingsStore = {
      publicSettings: () => settings,
      apiKey: () => 'test-key',
      lifetimeUsage: () => ({ ...EMPTY_TOKEN_USAGE }),
      statistics: () => snapshot,
      recordScan: async () => snapshot,
      recordCleanup: async () => snapshot,
    } as unknown as SettingsStore
    const events: OperationEvent[] = []
    const controller = new OperationController(settingsStore, {
      rootPath: process.cwd(), dshHome: process.cwd(), quarantinePath: '', patchPath: '',
    }, event => { events.push(event) })

    try {
      const scanId = controller.startMemoryAnalysis()
      await waitForCompletion(events)
      const riskEvent = events.find(event => event.type === 'risks')
      expect(riskEvent?.type === 'risks' ? riskEvent : undefined).toMatchObject({
        operationId: scanId,
        scanKind: 'memory',
        risks: [{ id: 'memory-41', kind: 'process', memoryCandidate: { pid: 41 }, selectedByDefault: false }],
      })

      events.length = 0
      const risk = riskEvent?.type === 'risks' ? riskEvent.risks[0] : undefined
      if (risk === undefined) throw new Error('Memory scan did not publish its candidate')
      const cleanupId = controller.startCleanup({
        sourceScanKind: 'memory', sourceOperationId: scanId, risks: [risk],
        instructions: [{ riskId: risk.id, mode: 'recommended' }],
      })
      await waitForCompletion(events)

      expect(memoryHarness.optimizedPids).toEqual([41])
      expect(events.find(event => event.type === 'started')).toMatchObject({ type: 'started', kind: 'cleanup', operationId: cleanupId })
      expect(events.some(event => event.type === 'audit-report')).toBe(false)
      expect(events.find(event => event.type === 'cleanup-report')).toMatchObject({
        type: 'cleanup-report', report: { results: [{ id: risk.id, status: 'cleaned', action: '回收工作集' }] },
      })
    } finally {
      await controller.close()
    }
  })
})
