import { createHash } from 'node:crypto'
import type { CleanupAuditDecision, CleanupAuditReport, CleanupReport, CleanupResultItem, OperationPlan, OperationPlanStep, RiskItem, RiskKind, ScanKind, Severity } from '../shared/types.js'

const RISK_KINDS = new Set<RiskKind>([
  'file',
  'directory',
  'process',
  'startup',
  'firewall',
  'service',
  'scheduled-task',
  'registry',
  'network',
  'browser-extension',
  'other',
])
const SEVERITIES = new Set<Severity>(['low', 'medium', 'high', 'critical'])
const CLEANUP_STATUSES = new Set<CleanupResultItem['status']>(['cleaned', 'quarantined', 'skipped', 'failed'])
const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value.trim()
  return cleaned.length === 0 ? fallback : cleaned.slice(0, maxLength)
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned.length === 0 ? undefined : cleaned.slice(0, maxLength)
}

function stringList(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .slice(0, maxItems)
    .map(entry => entry.trim().slice(0, 1000))
}

function markedJson(source: string, marker: string): unknown {
  const open = `<${marker}>`
  const close = `</${marker}>`
  const start = source.lastIndexOf(open)
  if (start < 0) throw new Error(`Agent 未返回 ${open} 结果块`)
  const end = source.indexOf(close, start + open.length)
  if (end < 0) throw new Error(`Agent 返回的 ${open} 结果块不完整`)
  const body = source.slice(start + open.length, end).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new Error(`Agent 返回的 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`)
  }
}

function stableRiskId(scanKind: ScanKind, kind: RiskKind, target: string): string {
  return `${scanKind}-${createHash('sha256').update(`${kind}\0${target.toLocaleLowerCase()}`).digest('hex').slice(0, 12)}`
}

function normalizedRisk(value: unknown, scanKind: ScanKind): RiskItem | undefined {
  const entry = record(value)
  if (entry === undefined) return undefined
  const target = text(entry.target, '', 4096)
  if (target.length === 0) return undefined
  const kind = typeof entry.kind === 'string' && RISK_KINDS.has(entry.kind as RiskKind)
    ? entry.kind as RiskKind
    : 'other'
  const severity = typeof entry.severity === 'string' && SEVERITIES.has(entry.severity as Severity)
    ? entry.severity as Severity
    : 'medium'
  const providedId = text(entry.id, '', 100).replace(/[^a-zA-Z0-9_-]/g, '-')
  const sizeBytes = typeof entry.sizeBytes === 'number'
    && Number.isSafeInteger(entry.sizeBytes)
    && entry.sizeBytes >= 0
    ? entry.sizeBytes
    : undefined
  const cleanupHint = optionalText(entry.cleanupHint, 2000)
  return {
    id: providedId.length > 0 ? providedId : stableRiskId(scanKind, kind, target),
    scanKind,
    kind,
    name: text(entry.name, target, 240),
    target,
    description: text(entry.description, 'Agent 未提供描述', 2000),
    reason: text(entry.reason, 'Agent 未提供判断理由', 3000),
    severity,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    recommendedAction: text(entry.recommendedAction, '人工复核', 1500),
    evidence: stringList(entry.evidence),
    selectedByDefault: entry.selectedByDefault === true,
    reversible: entry.reversible === true,
    ...(cleanupHint === undefined ? {} : { cleanupHint }),
  }
}

export interface ScanReport {
  summary: string
  risks: RiskItem[]
}

export function parseOperationPlan(source: string): OperationPlan {
  const result = record(markedJson(source, 'dsh-pc-manager-plan'))
  if (result === undefined) throw new Error('Agent 扫描计划不是 JSON 对象')
  const candidates = Array.isArray(result.steps) ? result.steps : []
  const steps: OperationPlanStep[] = []
  const ids = new Set<string>()
  for (const candidate of candidates.slice(0, 8)) {
    const entry = record(candidate)
    if (entry === undefined) continue
    const baseId = text(entry.id, `step-${steps.length + 1}`, 60).replace(/[^a-zA-Z0-9_-]/g, '-')
    let id = baseId
    let suffix = 2
    while (ids.has(id)) id = `${baseId}-${suffix++}`
    ids.add(id)
    const expectedTools = typeof entry.expectedTools === 'number' && Number.isFinite(entry.expectedTools)
      ? Math.min(20, Math.max(1, Math.round(entry.expectedTools)))
      : 2
    steps.push({
      id,
      title: text(entry.title, `检查步骤 ${steps.length + 1}`, 120),
      description: text(entry.description, '按只读边界核验相关系统状态。', 600),
      expectedTools,
    })
  }
  if (steps.length < 3) throw new Error('Agent 返回的扫描计划步骤不足')
  return {
    summary: text(result.summary, 'Agent 已制定只读扫描计划。', 1000),
    source: 'agent',
    steps,
  }
}

export function parseScanReport(source: string, scanKind: ScanKind): ScanReport {
  const result = record(markedJson(source, 'dsh-pc-manager-result'))
  if (result === undefined) throw new Error('Agent 风险结果不是 JSON 对象')
  const candidates = Array.isArray(result.risks) ? result.risks : []
  const ids = new Set<string>()
  const risks: RiskItem[] = []
  for (const candidate of candidates.slice(0, 200)) {
    const risk = normalizedRisk(candidate, scanKind)
    if (risk === undefined) continue
    let id = risk.id
    let suffix = 2
    while (ids.has(id)) id = `${risk.id}-${suffix++}`
    ids.add(id)
    risks.push(id === risk.id ? risk : { ...risk, id })
  }
  risks.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1)
    || left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))
  return {
    summary: text(result.summary, risks.length === 0 ? '未发现明确风险项。' : `发现 ${risks.length} 个待复核项目。`, 4000),
    risks,
  }
}

export function parseCleanupReport(source: string, authorizedRisks: readonly RiskItem[]): CleanupReport {
  const result = record(markedJson(source, 'dsh-pc-manager-cleanup'))
  if (result === undefined) throw new Error('Agent 清理结果不是 JSON 对象')
  const authorized = new Map(authorizedRisks.map(risk => [risk.id, risk]))
  const seen = new Set<string>()
  const parsedResults: CleanupResultItem[] = []
  const candidates = Array.isArray(result.results) ? result.results : []
  for (const candidate of candidates) {
    const entry = record(candidate)
    if (entry === undefined) continue
    const id = text(entry.id, '', 100)
    if (!authorized.has(id) || seen.has(id)) continue
    seen.add(id)
    const status = typeof entry.status === 'string' && CLEANUP_STATUSES.has(entry.status as CleanupResultItem['status'])
      ? entry.status as CleanupResultItem['status']
      : 'failed'
    const restorePath = optionalText(entry.restorePath, 4096)
    parsedResults.push({
      id,
      status,
      action: text(entry.action, '未说明', 1000),
      detail: text(entry.detail, 'Agent 未提供可核验结果', 3000),
      ...(restorePath === undefined ? {} : { restorePath }),
    })
  }
  for (const risk of authorizedRisks) {
    if (seen.has(risk.id)) continue
    parsedResults.push({
      id: risk.id,
      status: 'failed',
      action: '结果缺失',
      detail: 'Agent 的结构化结果未包含该授权项目，已按失败处理。',
    })
  }
  return {
    summary: text(result.summary, '清理操作已结束。', 4000),
    results: parsedResults,
    rebootRecommended: result.rebootRecommended === true,
    followup: stringList(result.followup, 50),
  }
}

export function parseCleanupAuditReport(source: string, authorizedRisks: readonly RiskItem[]): CleanupAuditReport {
  const result = record(markedJson(source, 'dsh-pc-manager-audit'))
  if (result === undefined) throw new Error('审核 Agent 结果不是 JSON 对象')
  const authorizedIds = new Set(authorizedRisks.map(risk => risk.id))
  const seen = new Set<string>()
  const decisions: CleanupAuditDecision[] = []
  const candidates = Array.isArray(result.decisions) ? result.decisions : []
  for (const candidate of candidates) {
    const entry = record(candidate)
    if (entry === undefined) continue
    const id = text(entry.id, '', 100)
    if (!authorizedIds.has(id) || seen.has(id)) continue
    seen.add(id)
    const verdict = entry.verdict === 'allow' || entry.verdict === 'deny' || entry.verdict === 'manual'
      ? entry.verdict
      : 'manual'
    decisions.push({
      id,
      verdict,
      reason: text(entry.reason, '审核 Agent 未给出充分理由，转为人工确认。', 3000),
      constraints: stringList(entry.constraints, 30),
    })
  }
  for (const risk of authorizedRisks) {
    if (seen.has(risk.id)) continue
    decisions.push({
      id: risk.id,
      verdict: 'manual',
      reason: '审核 Agent 的结构化结果缺少该项目，安全起见不允许自动清理。',
      constraints: [],
    })
  }
  return {
    summary: text(result.summary, '独立审核已完成。', 4000),
    decisions,
    globalWarnings: stringList(result.globalWarnings, 50),
  }
}

export function stripStructuredBlocks(source: string): string {
  return source
    .replace(/<dsh-pc-manager-plan>[\s\S]*?<\/dsh-pc-manager-plan>/gi, '')
    .replace(/<dsh-pc-manager-result>[\s\S]*?<\/dsh-pc-manager-result>/gi, '')
    .replace(/<dsh-pc-manager-audit>[\s\S]*?<\/dsh-pc-manager-audit>/gi, '')
    .replace(/<dsh-pc-manager-cleanup>[\s\S]*?<\/dsh-pc-manager-cleanup>/gi, '')
    .trim()
}
