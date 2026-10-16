import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE, type OperationHistoryEntry, type RiskItem, type ScanKind } from '../src/shared/types.js'
import { groupScanCleanupHistory } from '../src/renderer/history-grouping.js'

function risk(id: string, scanKind: ScanKind, target = `D:\\cache\\${id}.tmp`): RiskItem {
  return {
    id,
    scanKind,
    kind: 'file',
    name: id,
    target,
    description: 'test fixture',
    reason: 'test fixture',
    severity: 'low',
    recommendedAction: 'quarantine',
    evidence: [],
    selectedByDefault: true,
    reversible: true,
  }
}

function entry(
  id: string,
  kind: OperationHistoryEntry['kind'],
  startedAt: number,
  risks: RiskItem[] = [],
  relatedOperationId?: string,
): OperationHistoryEntry {
  return {
    id,
    kind,
    title: id,
    status: 'completed',
    startedAt,
    summary: id,
    model: 'fixture-model',
    tokenUsage: { ...EMPTY_TOKEN_USAGE },
    targets: [],
    risks,
    ...(relatedOperationId === undefined ? {} : { relatedOperationId }),
  }
}

describe('scan and cleanup history grouping', () => {
  it('groups the scan with cleanups that explicitly reference it', () => {
    const scan = entry('scan-1', 'disk', 10, [risk('cache-a', 'disk')])
    const cleanup = entry('cleanup-1', 'cleanup', 20, [risk('cache-a', 'disk')], scan.id)
    const groups = groupScanCleanupHistory([cleanup, scan])

    expect(groups.cleanupsByScanId.get(scan.id)?.map(item => item.id)).toEqual([cleanup.id])
    expect(groups.groupedCleanupIds.has(cleanup.id)).toBe(true)
  })

  it('recovers legacy scan-cleanup pairs using matching risk identity and keeps both entries separate', () => {
    const scan = entry('scan-1', 'disk', 10, [risk('cache-a', 'disk'), risk('cache-b', 'disk')])
    const cleanup = entry('cleanup-1', 'cleanup', 20, [risk('cache-b', 'disk')])
    const groups = groupScanCleanupHistory([cleanup, scan])

    expect(groups.cleanupsByScanId.get(scan.id)?.map(item => item.id)).toEqual([cleanup.id])
    expect(groups.groupedCleanupIds).toEqual(new Set([cleanup.id]))
  })

  it('does not group cleanups with unrelated or future scans', () => {
    const unrelatedScan = entry('scan-1', 'disk', 10, [risk('cache-a', 'disk')])
    const futureScan = entry('scan-2', 'disk', 30, [risk('cache-b', 'disk')])
    const cleanup = entry('cleanup-1', 'cleanup', 20, [risk('cache-b', 'disk')])
    const groups = groupScanCleanupHistory([cleanup, unrelatedScan, futureScan])

    expect(groups.cleanupsByScanId.size).toBe(0)
    expect(groups.groupedCleanupIds.size).toBe(0)
  })

  it('groups memory optimization with the memory scan that produced its candidates', () => {
    const memoryRisk: RiskItem = { ...risk('memory-41', 'disk'), scanKind: 'memory', kind: 'process', target: 'PID 41' }
    const scan = entry('memory-1', 'memory', 10, [memoryRisk])
    const cleanup = entry('cleanup-1', 'cleanup', 20, [memoryRisk], scan.id)
    const groups = groupScanCleanupHistory([cleanup, scan])

    expect(groups.cleanupsByScanId.get(scan.id)?.map(item => item.id)).toEqual([cleanup.id])
    expect(groups.groupedCleanupIds.has(cleanup.id)).toBe(true)
  })
})
