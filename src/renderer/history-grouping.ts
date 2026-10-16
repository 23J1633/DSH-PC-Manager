import type { OperationHistoryEntry, RiskScanKind } from '../shared/types.js'

export interface ScanCleanupGroups {
  cleanupsByScanId: Map<string, OperationHistoryEntry[]>
  groupedCleanupIds: Set<string>
}

function relatedScan(cleanup: OperationHistoryEntry, scans: readonly OperationHistoryEntry[]): OperationHistoryEntry | undefined {
  if (cleanup.relatedOperationId !== undefined) {
    const explicit = scans.find(scan => scan.id === cleanup.relatedOperationId && scan.startedAt <= cleanup.startedAt)
    if (explicit !== undefined) return explicit
  }
  if (cleanup.risks.length === 0) return undefined

  const sourceKinds = new Set<RiskScanKind>(cleanup.risks.map(risk => risk.scanKind))
  let best: OperationHistoryEntry | undefined
  let bestOverlap = 0
  for (const scan of scans) {
    if (scan.startedAt > cleanup.startedAt || (sourceKinds.size > 0 && !sourceKinds.has(scan.kind as RiskScanKind))) continue
    const scanIds = new Set(scan.risks.map(risk => risk.id))
    const scanTargets = new Set(scan.risks.map(risk => risk.target.toLocaleLowerCase()))
    const overlap = cleanup.risks.reduce((count, risk) => count + Number(scanIds.has(risk.id) || scanTargets.has(risk.target.toLocaleLowerCase())), 0)
    if (overlap > bestOverlap || (overlap === bestOverlap && overlap > 0 && scan.startedAt > (best?.startedAt ?? 0))) {
      best = scan
      bestOverlap = overlap
    }
  }
  if (bestOverlap === 0) return undefined
  return best
}

export function groupScanCleanupHistory(entries: readonly OperationHistoryEntry[]): ScanCleanupGroups {
  const scans = entries.filter(entry => entry.kind === 'disk' || entry.kind === 'virus' || entry.kind === 'memory')
  const cleanupsByScanId = new Map<string, OperationHistoryEntry[]>()
  const groupedCleanupIds = new Set<string>()
  for (const cleanup of entries) {
    if (cleanup.kind !== 'cleanup') continue
    const scan = relatedScan(cleanup, scans)
    if (scan === undefined) continue
    cleanupsByScanId.set(scan.id, [...(cleanupsByScanId.get(scan.id) ?? []), cleanup])
    groupedCleanupIds.add(cleanup.id)
  }
  for (const cleanups of cleanupsByScanId.values()) cleanups.sort((left, right) => left.startedAt - right.startedAt)
  return { cleanupsByScanId, groupedCleanupIds }
}
