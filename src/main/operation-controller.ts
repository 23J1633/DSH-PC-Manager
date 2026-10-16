import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppSettings,
  AgentTraceEntry,
  ChatInput,
  CleanupAuditReport,
  CleanupInput,
  CleanupSteeringInput,
  InstalledSoftwareItem,
  MemoryOptimizationResult,
  MemoryProcessCandidate,
  OperationEvent,
  OperationKind,
  OperationPlan,
  OperationResumePhase,
  OperationResumeSnapshot,
  OperationResumeState,
  OperationResumeTask,
  PathReference,
  RiskItem,
  SaveSettingsInput,
  ScanKind,
  ScanTarget,
  TokenUsage,
} from '../shared/types.js'
import { EMPTY_TOKEN_USAGE } from '../shared/types.js'
import { addTokenUsage, assistantTextFromEvent, DshRuntime, sessionEventFromNotification, tokenUsageFromEvent, type DshNotification } from './dsh-runtime.js'
import { testModelConnection } from './connection-test.js'
import { installedSoftwareForTargets } from './installed-software.js'
import { inspectMemory, optimizeMemory } from './memory-optimizer.js'
import { BUILT_IN_PRESETS, chatPrompt, cleanupAuditPrompt, cleanupPrompt, fallbackScanPlan, memoryAnalysisPrompt, memoryOptimizationReviewPrompt, promptForScan, scanPlanningPrompt, selfRepairPrompt } from './prompt-library.js'
import { parseCleanupAuditReport, parseCleanupReport, parseMemoryAgentReview, parseMemoryOptimizationReview, parseOperationPlan, parseScanReport, stripStructuredBlocks } from './result-parser.js'
import type { SettingsStore } from './settings-store.js'

interface ControllerPaths {
  rootPath: string
  dshHome: string
  quarantinePath: string
  patchPath: string
  runtimeExecutable?: string
}

interface ActiveOperation {
  id: string
  kind: OperationKind
  runtime: DshRuntime
  usage: TokenUsage
  toolCount: number
  toolStartedAt: Map<string, { time: number; name: string; input: string }>
  pendingCleanupSteering?: { cleanup: CleanupInput; message: string; time: number }
  steeringNotes: string[]
  steeringInterrupted: boolean
  steeringRestartPromise?: Promise<void>
  execution?: Promise<void>
  model: string
  reasoningEffort: AppSettings['reasoningEffort']
  resumeState: OperationResumeState | undefined
  resumedFrom?: string
  relatedOperationId?: string
  plan?: OperationPlan
  cancelled: boolean
  suspending: boolean
  settled: boolean
}

type Publisher = (event: OperationEvent) => void

interface OperationContext {
  targets?: ScanTarget[]
  authorizedRisks?: RiskItem[]
  cleanupInstructions?: CleanupInput['instructions']
  relatedOperationId?: string
  resumeState?: OperationResumeState
  resumedFrom?: string
}

type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access'

function operationTitle(kind: OperationKind): string {
  switch (kind) {
    case 'disk': return '硬盘清理扫描'
    case 'virus': return '病毒扫描'
    case 'cleanup': return 'Agent 二次研判与清理'
    case 'chat': return '电脑管家对话'
    case 'repair': return '应用自我修复'
    case 'connection-test': return '模型连接测试'
    case 'memory': return 'Agent 内存优化'
  }
}

function compactArguments(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 360)
}

function toolPresentation(name: string, argumentsText: string): { label: string; stage: string; detail: string } {
  const lower = name.toLocaleLowerCase()
  const compact = compactArguments(argumentsText)
  const activePath = compact.match(/(?:[a-z]:\\|\\\\[^\\\s]+\\[^\\\s]+\\?)[^\s'"`,;|]*/iu)?.[0]
  const detail = activePath === undefined ? compact : `当前目标：${activePath}`
  if (lower.includes('pwsh') || lower.includes('bash')) {
    return { label: '系统检查', stage: '正在分析系统状态', detail: detail || '执行只读系统查询' }
  }
  if (lower.includes('search') || lower.includes('glob')) {
    return { label: '文件搜索', stage: '正在覆盖文件目录', detail: detail || '检索目录元数据' }
  }
  if (lower.includes('read') || lower.includes('view') || lower.includes('fs')) {
    return { label: '证据核验', stage: '正在核验风险证据', detail: detail || '读取目标元数据' }
  }
  return { label: name, stage: 'Agent 正在调用工具', detail }
}

function currentPreset(settings: AppSettings): string {
  return [...BUILT_IN_PRESETS, ...settings.customPresets]
    .find(preset => preset.id === settings.activePresetId)?.prompt
    ?? BUILT_IN_PRESETS[0]?.prompt
    ?? '采用保守策略，证据不足时不执行清理。'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatByteCount(bytes: number): string {
  const mebibytes = bytes / 1024 ** 2
  return `${mebibytes.toFixed(mebibytes < 10 ? 1 : 0)} MB`
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    if (typeof value !== 'object' || value === null) return ''
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (Array.isArray(record.content)) return contentText(record.content)
    return ''
  }
  return value.map(item => {
    if (typeof item !== 'object' || item === null) return ''
    const record = item as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (Array.isArray(record.content)) return contentText(record.content)
    if (record.type === 'image') return '[image]'
    return ''
  }).filter(Boolean).join('\n')
}

function createResumeState(task: OperationResumeTask, phase: OperationResumePhase): OperationResumeState {
  const newSessionId = (): string => `pc-${randomUUID().replaceAll('-', '')}`
  return {
    task: structuredClone(task),
    sessionIds: { readOnly: newSessionId(), writable: newSessionId(), repair: newSessionId() },
    phase,
  }
}

function resumePrompt(prompt: string, resuming: boolean): string {
  if (!resuming) return prompt
  return `此前同一任务因应用意外中断，现正从持久化的 DSH 会话继续。先检查已有对话、工具结果和当前状态，识别已经完成的步骤；不要重复已经完成或可能产生重复副作用的动作。只在原任务授权范围内完成尚未完成的部分，并按原定结果格式返回。

原阶段要求：
${prompt}`
}

function cleanupSteeringPrompt(prompt: string, notes: readonly string[]): string {
  if (notes.length === 0) return prompt
  return `这是一轮因用户在上一轮清理执行期间插话而更新的任务。新的用户勾选清单取代旧清单；只处理本次提示中列出的项目。先检查现场状态，确认上一轮可能已完成的动作，不得重复造成副作用。明确取消的项目不得继续处理。若用户要求新增项目，仍须按审核和用户授权边界逐项复核。

用户插话记录：
${notes.map((note, index) => `${index + 1}. ${note}`).join('\n')}

${prompt}`
}

function normalizeCleanupInput(value: CleanupInput, allowEmpty = false): { input: CleanupInput; ignoredRisks: RiskItem[]; normalizedInstructions: CleanupInput['instructions']; historyInstructions: CleanupInput['instructions'] } {
  if (value.sourceScanKind !== 'disk' && value.sourceScanKind !== 'virus' && value.sourceScanKind !== 'memory') throw new Error('清理来源无效')
  const risks = Array.isArray(value.risks) ? value.risks.slice(0, 200) : []
  if (!allowEmpty && risks.length === 0) throw new Error('请至少勾选一个待处理项目')
  if (Array.isArray(value.risks) && value.risks.length > 200) throw new Error('单次最多处理 200 个项目')
  const ignoredRisks = Array.isArray(value.ignoredRisks) ? value.ignoredRisks.slice(0, 200) : []
  if (Array.isArray(value.ignoredRisks) && value.ignoredRisks.length > 200) throw new Error('单次最多标记 200 个忽略项目')
  const riskIds = new Set(risks.map(risk => risk.id))
  const ignoredRiskIds = new Set(ignoredRisks.map(risk => risk.id))
  if (riskIds.size !== risks.length || ignoredRiskIds.size !== ignoredRisks.length) throw new Error('项目清单包含重复 ID')
  if ([...riskIds, ...ignoredRiskIds].some(id => typeof id !== 'string' || id.length === 0 || id.length > 100)) throw new Error('项目 ID 无效')
  if (ignoredRisks.some(risk => riskIds.has(risk.id))) throw new Error('同一项目不能同时清理和忽略')
  const instructions = Array.isArray(value.instructions) ? value.instructions : []
  if (new Set(instructions.map(instruction => instruction.riskId)).size !== instructions.length) throw new Error('同一项目只能设置一种处理方案')
  if (instructions.some(instruction => !riskIds.has(instruction.riskId) && !ignoredRiskIds.has(instruction.riskId))) throw new Error('处理方案包含未知项目')
  const normalizedInstructions = risks.map(risk => {
    const selected = instructions.find(instruction => instruction.riskId === risk.id)
    const mode = selected?.mode ?? 'recommended'
    if (mode !== 'recommended' && mode !== 'quarantine' && mode !== 'manual' && mode !== 'safe-clean') throw new Error('处理方案无效')
    const instruction = selected?.instruction?.trim().slice(0, 2000)
    if (mode === 'manual' && !instruction) throw new Error(`请填写“${risk.name}”的手动处理方案`)
    return { riskId: risk.id, mode, ...(instruction === undefined ? {} : { instruction }) }
  })
  const historyInstructions = [
    ...normalizedInstructions,
    ...ignoredRisks.map(risk => ({ riskId: risk.id, mode: 'ignore' as const })),
  ]
  const steeringNotes = Array.isArray(value.steeringNotes)
    ? value.steeringNotes.filter((note): note is string => typeof note === 'string').slice(-50).map(note => note.slice(0, 2000))
    : []
  const input: CleanupInput = {
    sourceScanKind: value.sourceScanKind,
    ...(typeof value.sourceOperationId === 'string' && value.sourceOperationId.length <= 200 ? { sourceOperationId: value.sourceOperationId } : {}),
    ...(steeringNotes.length === 0 ? {} : { steeringNotes }),
    risks,
    ignoredRisks,
    instructions: historyInstructions,
  }
  return { input, ignoredRisks, normalizedInstructions, historyInstructions }
}

export class OperationController {
  private active: ActiveOperation | undefined
  private usagePersistence: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly paths: ControllerPaths,
    private readonly publish: Publisher,
    private readonly flushHistory: () => Promise<void> = async () => {},
  ) {}

  async resume(snapshot: OperationResumeSnapshot): Promise<string> {
    const task = snapshot.resumeState.task
    switch (task.kind) {
      case 'scan': return this.startScan(task.scanKind, task.targets, snapshot)
      case 'cleanup': return this.startCleanup(task.input, snapshot)
      case 'chat': return this.startChat(task.input, snapshot)
      case 'repair': return this.startSelfRepair(task.errorText, snapshot)
    }
  }

  async startScan(kind: ScanKind, requestedTargets: ScanTarget[], resumeSnapshot?: OperationResumeSnapshot): Promise<string> {
    if (kind !== 'disk' && kind !== 'virus') throw new Error('扫描类型无效')
    const settings = this.settingsStore.publicSettings()
    const targets = await this.validateScanTargets(requestedTargets, settings.includeNetworkDrives)
    const resumeState = resumeSnapshot?.resumeState ?? createResumeState({ kind: 'scan', scanKind: kind, targets }, 'scan-planning')
    if (resumeState.task.kind !== 'scan' || resumeState.task.scanKind !== kind) throw new Error('历史任务与扫描类型不匹配')
    const operation = this.createOperation(kind, 'read-only', settings, { targets, resumeState, ...(resumeSnapshot === undefined ? {} : { resumedFrom: resumeSnapshot.entry.id }) })
    void this.execute(operation, async () => {
      const installedSoftware = kind === 'disk' ? await this.collectInstalledSoftware(operation, targets) : []
      const promptOptions = {
        rootPath: this.paths.rootPath,
        presetPrompt: currentPreset(settings),
        scanDepth: settings.scanDepth,
        includeNetworkDrives: settings.includeNetworkDrives,
        targets,
        installedSoftware,
      } as const
      let plan: OperationPlan
      const resumeFromExecution = resumeSnapshot?.resumeState.phase === 'scan-execution' && resumeSnapshot.entry.plan !== undefined
      if (resumeFromExecution) {
        plan = structuredClone(resumeSnapshot.entry.plan as OperationPlan)
      } else {
        await this.checkpoint(operation, 'scan-planning')
        this.publishProgress(operation, 'Agent 正在制定扫描计划', `正在根据 ${targets.length} 个用户选择范围规划只读检查步骤。`, 3)
        const planningResult = await operation.runtime.run(
          resumePrompt(scanPlanningPrompt(kind, { ...promptOptions, targets: [...targets] }), resumeSnapshot !== undefined),
          operation.resumeState!.sessionIds.readOnly,
        )
        try {
          plan = parseOperationPlan(planningResult.finalResponse)
        } catch (error) {
          plan = fallbackScanPlan(kind, { ...promptOptions, targets: [...targets] })
          this.publish({
            type: 'assistant-message',
            operationId: operation.id,
            content: `规划 Agent 的结构化计划无法使用，已切换到内置安全计划：${errorMessage(error)}`,
          })
        }
      }
      operation.plan = plan
      operation.toolCount = 0
      this.publish({ type: 'plan', operationId: operation.id, plan })
      const firstStep = plan.steps[0]
      this.publishProgress(
        operation,
        firstStep?.title ?? '执行只读扫描计划',
        firstStep?.description ?? 'Agent 正在按计划进行只读检查。',
        10,
        firstStep?.id,
        [],
      )
      await this.checkpoint(operation, 'scan-execution')
      const result = await operation.runtime.run(
        resumePrompt(promptForScan(kind, { ...promptOptions, targets: [...targets], plan }), resumeFromExecution),
        operation.resumeState!.sessionIds.readOnly,
      )
      this.publishProgress(operation, '整理并排序风险清单', 'Agent 已完成观察，正在校验结构化结果并按严重程度排序。', 96, plan.steps.at(-1)?.id, plan.steps.slice(0, -1).map(step => step.id))
      const report = parseScanReport(result.finalResponse, kind, installedSoftware)
      this.publish({
        type: 'risks',
        operationId: operation.id,
        scanKind: kind,
        summary: report.summary,
        risks: report.risks,
      })
      const statistics = await this.settingsStore.recordScan(report.risks.length)
      this.publish({ type: 'statistics', operationId: operation.id, statistics })
      const narrative = stripStructuredBlocks(result.finalResponse)
      if (narrative.length > 0) this.publish({ type: 'assistant-message', operationId: operation.id, content: narrative })
      this.complete(operation, report.summary)
    })
    return operation.id
  }

  startMemoryAnalysis(): string {
    const settings = this.settingsStore.publicSettings()
    const operation = this.createOperation('memory', 'read-only', settings, {})
    operation.execution = this.execute(operation, async () => {
      this.publishProgress(operation, 'Agent 正在评估内存候选项', '先读取只读进程快照，再由 Agent 逐项给出保守建议。', 8)
      const overview = await inspectMemory()
      this.publishProgress(operation, 'Agent 正在复核应用进程', `正在判断 ${overview.candidates.length} 个高占用普通应用进程是否适合释放工作集。`, 38)
      const result = await operation.runtime.run(memoryAnalysisPrompt(overview))
      const review = parseMemoryAgentReview(result.finalResponse, overview)
      const analyzedOverview = { ...overview, candidates: review.candidates, analysisSummary: review.summary }
      this.publish({ type: 'memory-overview', operationId: operation.id, overview: analyzedOverview })
      const risks: RiskItem[] = review.candidates.map(candidate => ({
        id: `memory-${candidate.pid}`,
        scanKind: 'memory',
        kind: 'process',
        name: candidate.name,
        target: `PID ${candidate.pid}`,
        description: `工作集约占用 ${formatByteCount(candidate.memoryBytes)}。释放工作集不会关闭应用。`,
        reason: candidate.reason,
        severity: 'low',
        sizeBytes: candidate.memoryBytes,
        recommendedAction: '交由 Agent 再次核对进程身份后回收工作集',
        evidence: [`PID：${candidate.pid}`, `当前工作集：${formatByteCount(candidate.memoryBytes)}`],
        selectedByDefault: false,
        reversible: true,
        memoryCandidate: structuredClone(candidate),
      }))
      this.publish({ type: 'risks', operationId: operation.id, scanKind: 'memory', summary: review.summary, risks })
      const statistics = await this.settingsStore.recordScan(risks.length)
      this.publish({ type: 'statistics', operationId: operation.id, statistics })
      const narrative = stripStructuredBlocks(result.finalResponse)
      if (narrative.length > 0) this.publish({ type: 'assistant-message', operationId: operation.id, content: narrative })
      this.complete(operation, `Agent 已评估内存快照，提供 ${review.candidates.length} 个可勾选候选项。`)
    })
    return operation.id
  }

  startMemoryOptimization(requestedCandidates: readonly MemoryProcessCandidate[]): string {
    if (!Array.isArray(requestedCandidates) || requestedCandidates.length === 0 || requestedCandidates.length > 40) {
      throw new Error('请选择 1 至 40 个内存优化项')
    }
    if (requestedCandidates.some(candidate => typeof candidate !== 'object' || candidate === null
      || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0
      || typeof candidate.name !== 'string' || candidate.name.trim().length === 0
      || !Number.isSafeInteger(candidate.memoryBytes) || candidate.memoryBytes <= 0
      || typeof candidate.reason !== 'string')) throw new Error('内存优化进程列表无效')
    const pids = requestedCandidates.map(candidate => candidate.pid)
    if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0) || new Set(pids).size !== pids.length) {
      throw new Error('内存优化进程列表无效')
    }
    const settings = this.settingsStore.publicSettings()
    const operation = this.createOperation('memory', 'read-only', settings, {})
    operation.execution = this.execute(operation, async () => {
      this.publishProgress(operation, 'Agent 正在复核用户选择', '先重新核对进程身份，再由 Agent 批准安全范围内的精确 PID。', 8)
      const latestOverview = await inspectMemory()
      const liveByPid = new Map(latestOverview.candidates.map(candidate => [candidate.pid, candidate]))
      const verified: MemoryProcessCandidate[] = []
      const unavailable = requestedCandidates.flatMap(candidate => {
        const current = liveByPid.get(candidate.pid)
        if (current === undefined || current.name.toLocaleLowerCase() !== candidate.name.toLocaleLowerCase()) {
          return [{ pid: candidate.pid, name: candidate.name.slice(0, 160), beforeBytes: candidate.memoryBytes, afterBytes: 0, success: false, message: '进程已退出或 PID 对应的进程身份已变化，未执行优化。' }]
        }
        verified.push({ ...current, reason: candidate.reason.slice(0, 800) })
        return []
      })
      let agentSummary = '已重新核对进程身份；没有仍符合条件的进程。'
      let optimized: MemoryOptimizationResult = { requested: 0, optimized: 0, reclaimedBytes: 0, details: [] }
      if (verified.length > 0) {
        this.publishProgress(operation, 'Agent 正在进行安全复核', `用户勾选 ${verified.length} 项；Agent 不会扩展 PID 清单，也不会关闭应用。`, 34)
        const reviewResult = await operation.runtime.run(memoryOptimizationReviewPrompt(verified))
        const review = parseMemoryOptimizationReview(reviewResult.finalResponse, verified)
        agentSummary = review.summary
        this.publish({ type: 'assistant-message', operationId: operation.id, content: `内存优化 Agent：${review.summary}` })
        this.publishProgress(operation, '回收获批进程工作集', `Agent 批准 ${review.approvedPids.length} 项；只调用 Windows 工作集回收接口，不会结束进程。`, 72)
        if (review.approvedPids.length > 0) optimized = await optimizeMemory(review.approvedPids)
        optimized = {
          ...optimized,
          requested: requestedCandidates.length,
          agentSummary,
          details: [
            ...optimized.details,
            ...review.rejected.map(item => {
              const candidate = verified.find(process => process.pid === item.pid)
              return { pid: item.pid, name: candidate?.name ?? '', beforeBytes: candidate?.memoryBytes ?? 0, afterBytes: candidate?.memoryBytes ?? 0, success: false, message: item.reason }
            }),
            ...unavailable,
          ],
        }
      } else {
        optimized = { ...optimized, requested: requestedCandidates.length, agentSummary, details: unavailable }
      }
      this.publish({ type: 'memory-result', operationId: operation.id, result: optimized })
      this.complete(operation, `内存优化处理完成：成功回收 ${optimized.optimized}/${optimized.requested} 项，估算回收 ${formatByteCount(optimized.reclaimedBytes)}。`)
    })
    return operation.id
  }

  private startMemoryCleanup(input: CleanupInput, resumeSnapshot?: OperationResumeSnapshot): string {
    const normalized = normalizeCleanupInput(input)
    input = normalized.input
    const candidates = input.risks.map(risk => risk.memoryCandidate)
    if (input.risks.some(risk => risk.scanKind !== 'memory')
      || candidates.some(candidate => candidate === undefined)
      || candidates.length === 0
      || candidates.length > 40
      || candidates.some(candidate => candidate === undefined || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0
        || typeof candidate.name !== 'string' || candidate.name.trim().length === 0
        || !Number.isSafeInteger(candidate.memoryBytes) || candidate.memoryBytes <= 0
        || typeof candidate.reason !== 'string')
      || new Set(candidates.map(candidate => candidate?.pid)).size !== candidates.length) {
      throw new Error('内存候选项无效，请重新扫描后再试')
    }
    const requested = candidates as MemoryProcessCandidate[]
    if (input.risks.some((risk, index) => risk.id !== `memory-${requested[index]?.pid}`)) throw new Error('内存候选项与进程 ID 不匹配')
    const settings = this.settingsStore.publicSettings()
    const resumeState = resumeSnapshot?.resumeState ?? createResumeState({
      kind: 'cleanup',
      input: structuredClone(input),
      quarantineId: `cleanup-${randomUUID()}`,
    }, 'cleanup-audit')
    if (resumeState.task.kind !== 'cleanup') throw new Error('历史任务不是清理任务')
    const operation = this.createOperation('cleanup', 'read-only', settings, {
      authorizedRisks: structuredClone(input.risks),
      cleanupInstructions: structuredClone(input.instructions),
      ...(input.sourceOperationId === undefined ? {} : { relatedOperationId: input.sourceOperationId }),
      resumeState,
      ...(resumeSnapshot === undefined ? {} : { resumedFrom: resumeSnapshot.entry.id }),
    })
    operation.execution = this.execute(operation, async () => {
      this.publishProgress(operation, 'Agent 正在复核内存选择', '重新检查当前进程身份；仅对你勾选的 PID 进行审核，不会关闭应用。', 8)
      const latestOverview = await inspectMemory()
      const liveByPid = new Map(latestOverview.candidates.map(candidate => [candidate.pid, candidate]))
      const verified: MemoryProcessCandidate[] = []
      const unavailable = requested.flatMap(candidate => {
        const current = liveByPid.get(candidate.pid)
        if (current === undefined || current.name.toLocaleLowerCase() !== candidate.name.toLocaleLowerCase()) {
          return [{ pid: candidate.pid, name: candidate.name.slice(0, 160), beforeBytes: candidate.memoryBytes, afterBytes: 0, success: false, message: '进程已退出或 PID 对应的进程身份已变化，未执行优化。' }]
        }
        verified.push({ ...current, reason: candidate.reason.slice(0, 800) })
        return []
      })
      let optimized: MemoryOptimizationResult = { requested: requested.length, optimized: 0, reclaimedBytes: 0, details: [...unavailable] }
      let agentSummary = '已重新核对进程身份；没有仍符合条件的进程。'
      if (verified.length > 0) {
        this.publishProgress(operation, 'Agent 正在进行安全复核', `正在逐项复核 ${verified.length} 个已选进程；只会批准清单内的 PID。`, 32)
        const reviewResult = await operation.runtime.run(
          resumePrompt(cleanupSteeringPrompt(memoryOptimizationReviewPrompt(verified), input.steeringNotes ?? []), resumeSnapshot !== undefined),
          operation.resumeState!.sessionIds.readOnly,
        )
        const review = parseMemoryOptimizationReview(reviewResult.finalResponse, verified)
        agentSummary = review.summary
        this.publish({ type: 'assistant-message', operationId: operation.id, content: `内存优化 Agent：${review.summary}` })
        this.publishProgress(operation, '回收获批进程工作集', `Agent 批准 ${review.approvedPids.length} 项；只调用 Windows 工作集回收接口，不会结束进程。`, 72)
        const released = review.approvedPids.length === 0
          ? { requested: 0, optimized: 0, reclaimedBytes: 0, details: [] }
          : await optimizeMemory(review.approvedPids)
        optimized = {
          ...released,
          requested: requested.length,
          agentSummary,
          details: [
            ...released.details,
            ...review.rejected.map(item => {
              const candidate = verified.find(process => process.pid === item.pid)
              return { pid: item.pid, name: candidate?.name ?? '', beforeBytes: candidate?.memoryBytes ?? 0, afterBytes: candidate?.memoryBytes ?? 0, success: false, message: item.reason }
            }),
            ...unavailable,
          ],
        }
      } else {
        optimized = { ...optimized, agentSummary }
      }
      this.publish({ type: 'memory-result', operationId: operation.id, result: optimized })
      const resultByPid = new Map(optimized.details.map(detail => [detail.pid, detail]))
      const report = {
        summary: `Agent 已复核 ${optimized.requested} 项，成功回收 ${optimized.optimized} 项工作集，估算释放 ${formatByteCount(optimized.reclaimedBytes)}。`,
        results: input.risks.map(risk => {
          const candidate = risk.memoryCandidate!
          const detail = resultByPid.get(candidate.pid)
          return {
            id: risk.id,
            status: detail?.success === true ? 'cleaned' as const : 'skipped' as const,
            action: '回收工作集',
            detail: detail === undefined ? 'Agent 未返回该进程的处理结果。' : `${detail.message}（${formatByteCount(detail.beforeBytes)} → ${formatByteCount(detail.afterBytes)}）`,
          }
        }),
        rebootRecommended: false,
        followup: [agentSummary],
      }
      this.publish({ type: 'cleanup-report', operationId: operation.id, report })
      const statistics = await this.settingsStore.recordCleanup(optimized.optimized)
      this.publish({ type: 'statistics', operationId: operation.id, statistics })
      this.complete(operation, report.summary)
    })
    return operation.id
  }

  startCleanup(input: CleanupInput, resumeSnapshot?: OperationResumeSnapshot): string {
    if (resumeSnapshot !== undefined) {
      if (resumeSnapshot.resumeState.task.kind !== 'cleanup') throw new Error('历史任务不是清理任务')
      input = resumeSnapshot.resumeState.task.input
    }
    if (input.sourceScanKind === 'memory') return this.startMemoryCleanup(input, resumeSnapshot)
    if (this.paths.quarantinePath.trim().length === 0) {
      throw new Error('找不到可用的非 C 盘隔离目录；清理功能已禁用，请连接可用磁盘后重启。')
    }
    const normalizedCleanup = normalizeCleanupInput(input)
    input = normalizedCleanup.input
    const ignoredRisks = normalizedCleanup.ignoredRisks
    let normalizedInstructions = normalizedCleanup.normalizedInstructions
    const safeCleanupIds = new Set(normalizedInstructions.filter(instruction => instruction.mode === 'safe-clean').map(instruction => instruction.riskId))
    let historyInstructions = normalizedCleanup.historyInstructions
    const settings = this.settingsStore.publicSettings()
    const resumeState = resumeSnapshot?.resumeState ?? createResumeState({
      kind: 'cleanup',
      input: structuredClone({ ...input, ignoredRisks, instructions: historyInstructions }),
      quarantineId: `cleanup-${randomUUID()}`,
      relaxedPermissions: settings.relaxedPermissions,
    }, 'cleanup-audit')
    if (resumeState.task.kind !== 'cleanup') throw new Error('历史任务不是清理任务')
    const relaxedPermissions = resumeState.task.relaxedPermissions === true && settings.relaxedPermissions
    const quarantinePath = join(this.paths.quarantinePath, resumeState.task.quarantineId)
    const operation = this.createOperation('cleanup', 'read-only', settings, {
      authorizedRisks: structuredClone([...input.risks, ...ignoredRisks]),
      cleanupInstructions: structuredClone(historyInstructions),
      ...(input.sourceOperationId === undefined ? {} : { relatedOperationId: input.sourceOperationId }),
      resumeState,
      ...(resumeSnapshot === undefined ? {} : { resumedFrom: resumeSnapshot.entry.id }),
    })
    operation.execution = this.execute(operation, async () => {
      await mkdir(this.paths.quarantinePath, { recursive: true })
      await mkdir(quarantinePath, { recursive: true })
      const resumedExecution = resumeSnapshot?.resumeState.phase === 'cleanup-execution'
      let auditReport: CleanupAuditReport | undefined = resumedExecution && resumeSnapshot.entry.auditReport !== undefined
        ? structuredClone(resumeSnapshot.entry.auditReport)
        : undefined
      let allowedRisks: RiskItem[]
      let allowedInstructions: CleanupInput['instructions']
      const shouldAudit = !relaxedPermissions || safeCleanupIds.size > 0
      if (!shouldAudit) {
        allowedRisks = input.risks
        allowedInstructions = normalizedInstructions
        this.publishProgress(operation, '放宽权限已启用', '按你勾选的目标和逐项处理方案启动清理；本次跳过独立审核。', 20)
      } else if (auditReport !== undefined) {
        this.publish({ type: 'audit-report', operationId: operation.id, report: auditReport })
        const allowedIds = new Set(auditReport.decisions.filter(decision => decision.verdict === 'allow').map(decision => decision.id))
        allowedRisks = input.risks.filter(risk => relaxedPermissions || allowedIds.has(risk.id) || safeCleanupIds.has(risk.id))
        allowedInstructions = normalizedInstructions.filter(instruction => relaxedPermissions || allowedIds.has(instruction.riskId) || safeCleanupIds.has(instruction.riskId))
        this.publishProgress(operation, '继续审核已完成的清理', '沿用中断前的只读审核结果，继续原清理会话并核对已完成项目。', 38)
      } else {
        await this.checkpoint(operation, 'cleanup-audit')
        this.publishProgress(operation, '独立审核 Agent 正在复核', safeCleanupIds.size > 0
          ? `只读审核会检查全部目标；${safeCleanupIds.size} 项安全清理将依据审核边界继续执行。`
          : '只读审核会逐项核验证据、误伤风险与可逆性；未通过的项目不会交给清理 Agent。', 5)
        const auditResult = await operation.runtime.run(resumePrompt(cleanupSteeringPrompt(cleanupAuditPrompt({
          rootPath: this.paths.rootPath,
          quarantinePath,
          presetPrompt: currentPreset(settings),
          sourceScanKind: input.sourceScanKind,
          risks: structuredClone(input.risks),
          instructions: structuredClone(normalizedInstructions),
        }), input.steeringNotes ?? []), resumeSnapshot?.resumeState.phase === 'cleanup-audit'), operation.resumeState!.sessionIds.readOnly)
        const currentAudit = parseCleanupAuditReport(auditResult.finalResponse, input.risks)
        auditReport = currentAudit
        this.publish({ type: 'audit-report', operationId: operation.id, report: currentAudit })
        const auditNarrative = stripStructuredBlocks(auditResult.finalResponse)
        if (auditNarrative.length > 0) this.publish({ type: 'assistant-message', operationId: operation.id, content: `审核 Agent：${auditNarrative}` })
        const allowedIds = new Set(currentAudit.decisions.filter(decision => decision.verdict === 'allow').map(decision => decision.id))
        allowedRisks = input.risks.filter(risk => relaxedPermissions || allowedIds.has(risk.id) || safeCleanupIds.has(risk.id))
        allowedInstructions = normalizedInstructions.filter(instruction => relaxedPermissions || allowedIds.has(instruction.riskId) || safeCleanupIds.has(instruction.riskId))
        if (allowedRisks.length === 0) {
          const report = {
            summary: '独立审核 Agent 未放行普通处理项目，本次未执行系统修改。',
            results: input.risks.map(risk => {
              const decision = currentAudit.decisions.find(item => item.id === risk.id)
              return {
                id: risk.id,
                status: 'skipped' as const,
                action: decision?.verdict === 'deny' ? '审核拒绝' : '需要人工确认',
                detail: decision?.reason ?? '审核结果缺失，安全跳过。',
              }
            }),
            rebootRecommended: false,
            followup: currentAudit.globalWarnings,
          }
          this.publish({ type: 'cleanup-report', operationId: operation.id, report })
          const statistics = await this.settingsStore.recordCleanup(0)
          this.publish({ type: 'statistics', operationId: operation.id, statistics })
          this.complete(operation, report.summary)
          return
        }
      }
      this.publishProgress(
        operation,
        '准备执行清理',
        !shouldAudit
          ? `放宽权限模式已开启，正在按你授权的 ${allowedRisks.length} 项启动清理 Agent。`
          : safeCleanupIds.size > 0
            ? `审核已完成，正在处理 ${allowedRisks.length} 项；安全清理会按审核边界尽力完成所选目标。`
            : `审核 Agent 放行 ${allowedRisks.length}/${input.risks.length} 项，正在启动隔离的清理 Agent。`,
        shouldAudit ? 38 : 20,
      )
      await this.checkpoint(operation, 'cleanup-execution')
      await operation.runtime.close()
      if (operation.cancelled) throw new Error('操作已取消')
      operation.runtime = this.createRuntime(operation, settings, 'danger-full-access')
      const result = await operation.runtime.run(resumePrompt(cleanupSteeringPrompt(cleanupPrompt({
        rootPath: this.paths.rootPath,
        quarantinePath,
        presetPrompt: currentPreset(settings),
        sourceScanKind: input.sourceScanKind,
        risks: structuredClone(allowedRisks),
        instructions: structuredClone(allowedInstructions),
        ...(auditReport === undefined ? {} : { auditReport }),
        relaxedPermissions,
      }), input.steeringNotes ?? []), resumeSnapshot?.resumeState.phase === 'cleanup-execution'), operation.resumeState!.sessionIds.writable)
      this.publishProgress(operation, '生成清理报告', '正在核对每个授权项目的实际结果。', 96)
      const executionReport = parseCleanupReport(result.finalResponse, allowedRisks)
      const executionById = new Map(executionReport.results.map(item => {
        if (safeCleanupIds.has(item.id) && item.status === 'skipped') {
          return [item.id, {
            ...item,
            status: 'failed' as const,
            action: '安全清理未完成',
            detail: `该项目选择了安全清理，Agent 未执行清理动作；原结果：${item.detail}`,
          }] as const
        }
        return [item.id, item] as const
      }))
      const decisionById = new Map(auditReport?.decisions.map(item => [item.id, item]) ?? [])
      const ordinaryAllowedCount = allowedRisks.filter(risk => !safeCleanupIds.has(risk.id)).length
      const ordinaryInputCount = input.risks.filter(risk => !safeCleanupIds.has(risk.id)).length
      const executionSummary = auditReport === undefined
        ? `放宽权限模式已启用，按用户授权的 ${allowedRisks.length} 项执行。${executionReport.summary}`
        : safeCleanupIds.size > 0
          ? `审核完成：普通方案放行 ${ordinaryAllowedCount}/${ordinaryInputCount} 项，${safeCleanupIds.size} 项安全清理按审核边界继续。${executionReport.summary}`
          : `审核 Agent 放行 ${allowedRisks.length}/${input.risks.length} 项。${executionReport.summary}`
      const report = {
        ...executionReport,
        summary: executionSummary,
        results: input.risks.map(risk => {
          const executed = executionById.get(risk.id)
          if (executed !== undefined) return executed
          const decision = decisionById.get(risk.id)
          return {
            id: risk.id,
            status: 'skipped' as const,
            action: decision?.verdict === 'deny' ? '审核拒绝' : '需要人工确认',
            detail: decision?.reason ?? '未通过独立审核，安全跳过。',
          }
        }),
        followup: [...(auditReport?.globalWarnings ?? []), ...executionReport.followup],
      }
      this.publish({ type: 'cleanup-report', operationId: operation.id, report })
      const statistics = await this.settingsStore.recordCleanup(report.results.filter(item => item.status === 'cleaned' || item.status === 'quarantined').length)
      this.publish({ type: 'statistics', operationId: operation.id, statistics })
      const narrative = stripStructuredBlocks(result.finalResponse)
      if (narrative.length > 0) this.publish({ type: 'assistant-message', operationId: operation.id, content: narrative })
      this.complete(operation, report.summary)
    })
    return operation.id
  }

  async startChat(input: ChatInput, resumeSnapshot?: OperationResumeSnapshot): Promise<string> {
    if (resumeSnapshot !== undefined) {
      if (resumeSnapshot.resumeState.task.kind !== 'chat') throw new Error('历史任务不是对话任务')
      input = resumeSnapshot.resumeState.task.input
    }
    const message = input.message.trim()
    if (message.length === 0) throw new Error('请输入消息')
    const referencedPaths = await this.validatePathReferences(Array.isArray(input.referencedPaths) ? input.referencedPaths : [])
    const settings = this.settingsStore.publicSettings()
    const operationMode = input.operationMode === true
    if (operationMode && !settings.relaxedPermissions) throw new Error('请先在设置中启用“放宽操作权限”')
    const normalizedInput: ChatInput = { message: message.slice(0, 20_000), relatedRisks: Array.isArray(input.relatedRisks) ? input.relatedRisks.slice(0, 50) : [], referencedPaths, operationMode }
    const resumeState = resumeSnapshot?.resumeState ?? createResumeState({ kind: 'chat', input: normalizedInput }, 'chat')
    if (resumeState.task.kind !== 'chat') throw new Error('历史任务不是对话任务')
    const operation = this.createOperation('chat', operationMode ? 'danger-full-access' : 'read-only', settings, {
      resumeState,
      ...(resumeSnapshot === undefined ? {} : { resumedFrom: resumeSnapshot.entry.id }),
    })
    void this.execute(operation, async () => {
      this.publishProgress(operation, operationMode ? '可操作模式' : '只读咨询', operationMode ? 'Agent 正在按你的明确指令操作；请检查每项系统变更。' : 'Agent 正在结合当前风险清单分析问题。', 12)
      await this.checkpoint(operation, 'chat')
      const result = await operation.runtime.run(
        resumePrompt(chatPrompt(message.slice(0, 20_000), normalizedInput.relatedRisks, currentPreset(settings), referencedPaths, operationMode), resumeSnapshot !== undefined),
        operationMode ? operation.resumeState!.sessionIds.writable : operation.resumeState!.sessionIds.readOnly,
      )
      const answer = result.finalResponse.trim() || 'Agent 未返回可显示的答复。'
      this.publish({ type: 'assistant-message', operationId: operation.id, content: answer })
      this.complete(operation, operationMode ? 'Agent 已完成可操作模式请求' : 'Agent 已完成只读答复')
    })
    return operation.id
  }

  async startSelfRepair(errorText: string, resumeSnapshot?: OperationResumeSnapshot): Promise<string> {
    if (resumeSnapshot !== undefined) {
      if (resumeSnapshot.resumeState.task.kind !== 'repair') throw new Error('历史任务不是自我修复任务')
      errorText = resumeSnapshot.resumeState.task.errorText
    }
    const settings = this.settingsStore.publicSettings()
    const normalizedError = errorText.trim().slice(0, 12_000)
    const task: OperationResumeTask = { kind: 'repair', errorText: normalizedError }
    const resumeState = resumeSnapshot?.resumeState ?? createResumeState(task, 'repair')
    if (resumeState.task.kind !== 'repair') throw new Error('历史任务不是自我修复任务')
    await mkdir(this.paths.dshHome, { recursive: true })
    const operation = this.createOperation('repair', 'workspace-write', settings, {
      resumeState,
      ...(resumeSnapshot === undefined ? {} : { resumedFrom: resumeSnapshot.entry.id }),
    }, this.paths.dshHome)
    void this.execute(operation, async () => {
      this.publishProgress(operation, '正在检查本机 DSH 运行环境', '修复 Agent 仅可写入 DSH_HOME 运行目录；应用安装文件和其他用户文件不在授权范围内。', 5)
      await this.checkpoint(operation, 'repair')
      const result = await operation.runtime.run(
        resumePrompt(selfRepairPrompt(this.paths.dshHome, normalizedError), resumeSnapshot !== undefined),
        operation.resumeState!.sessionIds.repair,
      )
      const response = result.finalResponse.trim() || 'Agent 没有返回修复说明。'
      this.publish({ type: 'assistant-message', operationId: operation.id, content: response })
      this.complete(operation, response.slice(0, 500))
    })
    return operation.id
  }

  async cancel(operationId: string): Promise<void> {
    const operation = this.active
    if (operation === undefined || operation.id !== operationId || operation.settled) return
    operation.cancelled = true
    this.publishProgress(operation, '正在停止', '正在终止本次 Agent 会话及其命令行子进程。')
    await operation.runtime.close(true)
    this.cancelled(operation)
  }

  async steerCleanup(input: CleanupSteeringInput): Promise<void> {
    const operation = this.active
    if (operation === undefined || operation.id !== input.operationId || operation.kind !== 'cleanup' || operation.settled) {
      throw new Error('当前没有可插话的清理任务')
    }
    const normalized = normalizeCleanupInput(input.cleanup, true)
    if (normalized.input.sourceOperationId === undefined && operation.relatedOperationId !== undefined) {
      normalized.input.sourceOperationId = operation.relatedOperationId
    }
    const message = input.message.trim().slice(0, 2000)
    if (message.length === 0) throw new Error('插话内容不能为空')
    const time = Date.now()
    operation.pendingCleanupSteering = { cleanup: normalized.input, message, time }
    operation.steeringNotes.push(message)
    this.publish({ type: 'steering', operationId: operation.id, message, cleanup: normalized.input, time })
    if (operation.steeringRestartPromise !== undefined) {
      await operation.steeringRestartPromise
      return
    }
    operation.steeringInterrupted = true
    operation.cancelled = true
    this.publishProgress(operation, '正在处理用户插话', message, undefined)
    operation.steeringRestartPromise = (async () => {
      await operation.runtime.close(true)
      await operation.execution
      const latest = operation.pendingCleanupSteering
      if (latest === undefined || latest.cleanup.risks.length === 0) return
      const updatedInput: CleanupInput = { ...latest.cleanup, steeringNotes: [...operation.steeringNotes].slice(-50) }
      this.startCleanup(updatedInput)
    })()
    await operation.steeringRestartPromise
  }

  async testConnection(input: Pick<SaveSettingsInput, 'provider' | 'model' | 'baseUrl' | 'apiKey'>): Promise<string> {
    const stored = this.settingsStore.publicSettings()
    const apiKey = input.apiKey?.trim() || this.settingsStore.apiKey()
    if (apiKey === undefined || apiKey.length === 0) throw new Error('请先填写 DeepSeek API Key')
    return testModelConnection({
      provider: input.provider.trim() || stored.provider,
      model: input.model.trim() || stored.model,
      apiKey,
      baseUrl: input.baseUrl.trim() || stored.baseUrl,
    })
  }

  async close(): Promise<void> {
    const operation = this.active
    if (operation === undefined) return
    operation.suspending = true
    operation.cancelled = true
    await operation.runtime.close(true)
  }

  private createOperation(
    kind: OperationKind,
    permissionMode: PermissionMode,
    settings: AppSettings,
    context: OperationContext,
    runtimeCwd = this.paths.rootPath,
  ): ActiveOperation {
    if (this.active !== undefined) throw new Error('已有任务正在运行，请先等待完成或取消')
    const apiKey = this.settingsStore.apiKey()
    if (apiKey === undefined || apiKey.trim().length === 0) throw new Error('请先在设置中配置 DeepSeek API Key')
    const id = `${kind}-${Date.now()}-${randomUUID().slice(0, 8)}`
    const operation: ActiveOperation = {
      id,
      kind,
      usage: { ...EMPTY_TOKEN_USAGE },
      toolCount: 0,
      toolStartedAt: new Map(),
      steeringNotes: [],
      steeringInterrupted: false,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      resumeState: context.resumeState === undefined ? undefined : structuredClone(context.resumeState),
      ...(context.resumedFrom === undefined ? {} : { resumedFrom: context.resumedFrom }),
      ...(context.relatedOperationId === undefined ? {} : { relatedOperationId: context.relatedOperationId }),
      cancelled: false,
      suspending: false,
      settled: false,
      runtime: undefined as unknown as DshRuntime,
    }
    operation.runtime = this.createRuntime(operation, settings, permissionMode, apiKey, runtimeCwd)
    this.active = operation
    this.publish({
      type: 'started',
      operationId: id,
      kind,
      title: operationTitle(kind),
      startedAt: Date.now(),
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      ...(context.targets === undefined ? {} : { targets: structuredClone(context.targets) }),
      ...(context.authorizedRisks === undefined ? {} : { authorizedRisks: structuredClone(context.authorizedRisks) }),
      ...(context.cleanupInstructions === undefined ? {} : { cleanupInstructions: structuredClone(context.cleanupInstructions) }),
      ...(operation.resumeState === undefined ? {} : { resumeState: structuredClone(operation.resumeState) }),
      ...(operation.resumedFrom === undefined ? {} : { resumedFrom: operation.resumedFrom }),
      ...(context.relatedOperationId === undefined ? {} : { relatedOperationId: context.relatedOperationId }),
    })
    return operation
  }

  private createRuntime(
    operation: ActiveOperation,
    settings: AppSettings,
    permissionMode: PermissionMode,
    providedApiKey?: string,
    cwd = this.paths.rootPath,
  ): DshRuntime {
    const apiKey = providedApiKey ?? this.settingsStore.apiKey()
    if (apiKey === undefined || apiKey.trim().length === 0) throw new Error('请先在设置中配置 DeepSeek API Key')
    return new DshRuntime({
      cwd,
      dshHome: this.paths.dshHome,
      patchPath: this.paths.patchPath,
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      apiKey,
      baseUrl: settings.baseUrl,
      permissionMode,
      telemetryEnabled: settings.telemetryEnabled,
      maxTokens: operation.kind === 'chat' || operation.kind === 'memory' ? 8192 : 65_536,
      ...(this.paths.runtimeExecutable === undefined ? {} : { runtimeExecutable: this.paths.runtimeExecutable }),
      onNotification: notification => { this.onNotification(operation, notification) },
    })
  }

  private async validateScanTargets(requested: readonly ScanTarget[], includeNetworkDrives: boolean): Promise<ScanTarget[]> {
    if (requested.length === 0) throw new Error('请先选择至少一个磁盘或目录')
    if (requested.length > 16) throw new Error('单次最多选择 16 个扫描范围')
    const seen = new Set<string>()
    const validated: ScanTarget[] = []
    for (const target of requested) {
      if (target.type !== 'drive' && target.type !== 'directory') throw new Error('扫描范围类型无效')
      if (typeof target.path !== 'string' || target.path.length === 0 || target.path.length > 4096 || !isAbsolute(target.path)) {
        throw new Error('扫描范围必须是有效的绝对路径')
      }
      if (!includeNetworkDrives && target.path.startsWith('\\\\')) throw new Error('设置中未允许扫描网络目录')
      const path = resolve(target.path)
      const key = process.platform === 'win32' ? path.toLocaleLowerCase() : path
      if (seen.has(key)) continue
      const info = await stat(path).catch(() => undefined)
      if (info === undefined || !info.isDirectory()) throw new Error(`扫描目录不存在或无法访问：${path}`)
      seen.add(key)
      validated.push({ type: target.type, path, label: target.label.trim().slice(0, 120) || path })
    }
    if (validated.length === 0) throw new Error('没有可用的扫描范围')
    return validated
  }

  private async collectInstalledSoftware(operation: ActiveOperation, targets: readonly ScanTarget[]): Promise<InstalledSoftwareItem[]> {
    this.publishProgress(operation, '读取大型软件清单', '正在只读检查 Windows 已安装软件信息，并按本次扫描范围筛选。', 2)
    try {
      return await installedSoftwareForTargets(targets)
    } catch (error) {
      this.publish({
        type: 'assistant-message',
        operationId: operation.id,
        content: `无法读取 Windows 已安装软件清单；硬盘扫描会继续，但大型软件项可能不完整：${errorMessage(error)}`,
      })
      return []
    }
  }

  private async validatePathReferences(requested: readonly PathReference[]): Promise<PathReference[]> {
    if (requested.length > 12) throw new Error('单次对话最多引用 12 个文件或目录')
    const seen = new Set<string>()
    const validated: PathReference[] = []
    for (const reference of requested) {
      if (reference.type !== 'file' && reference.type !== 'directory') throw new Error('引用路径类型无效')
      if (typeof reference.path !== 'string' || reference.path.length === 0 || reference.path.length > 4096 || !isAbsolute(reference.path)) {
        throw new Error('引用必须是有效的本机绝对路径')
      }
      const path = resolve(reference.path)
      const key = process.platform === 'win32' ? path.toLocaleLowerCase() : path
      if (seen.has(key)) continue
      const info = await stat(path).catch(() => undefined)
      if (info === undefined) throw new Error(`引用路径不存在或无法访问：${path}`)
      const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined
      if (type === undefined) throw new Error(`暂不支持引用此路径类型：${path}`)
      seen.add(key)
      validated.push({ path, type })
    }
    return validated
  }

  private async execute(operation: ActiveOperation, task: () => Promise<void>): Promise<void> {
    try {
      await task()
    } catch (error) {
      if (operation.suspending) return
      if (operation.steeringInterrupted) this.cancelled(operation, '用户插话已停止旧清理轮次；后续任务按更新后的勾选清单执行。')
      else if (operation.cancelled) this.cancelled(operation)
      else this.failed(operation, errorMessage(error))
    } finally {
      await operation.runtime.close(operation.cancelled).catch(error => {
        if (!operation.settled && !operation.suspending) this.failed(operation, `关闭 DSH 运行时时发生错误：${errorMessage(error)}`)
      })
      if (this.active === operation) this.active = undefined
    }
  }

  private onNotification(operation: ActiveOperation, notification: DshNotification): void {
    if (operation.settled || operation.cancelled) return
    const event = sessionEventFromNotification(notification)
    if (event === undefined) return
    const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
    if (event.type === 'tool/call') {
      const name = typeof data.name === 'string' ? data.name : 'tool'
      const argumentsText = typeof data.arguments === 'string' ? data.arguments : ''
      const presentation = toolPresentation(name, argumentsText)
      const callId = typeof data.callId === 'string' ? data.callId : `${Date.now()}-${operation.toolStartedAt.size}`
      operation.toolStartedAt.set(callId, { time: Date.now(), name, input: argumentsText })
      this.publish({
        type: 'tool',
        operationId: operation.id,
        tool: name,
        label: presentation.label,
        detail: presentation.detail,
        time: Date.now(),
      })
      this.publishProgress(operation, presentation.stage, `${presentation.detail} · 正在等待工具返回结果。`)
    } else if (event.type === 'tool/result') {
      const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : {}
      const source = typeof message.source === 'object' && message.source !== null ? message.source as Record<string, unknown> : {}
      const content = Array.isArray(message.content) ? message.content : []
      const firstBlock = typeof content[0] === 'object' && content[0] !== null ? content[0] as Record<string, unknown> : {}
      const callId = typeof source.callId === 'string' ? source.callId : typeof firstBlock.toolCallId === 'string' ? firstBlock.toolCallId : ''
      const started = callId.length === 0 ? undefined : operation.toolStartedAt.get(callId)
      operation.toolCount += 1
      const resultText = contentText(firstBlock.content ?? content).slice(0, 1000)
      const summary = started === undefined ? resultText : `${started.name} 已完成 · ${resultText}`
      if (operation.plan !== undefined) this.publishPlanProgress(operation, summary)
      else this.publishProgress(operation, '工具已返回结果', summary)
    }
    this.publishTrace(operation, event)
    if (event.type === 'tool/result') {
      const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : {}
      const source = typeof message.source === 'object' && message.source !== null ? message.source as Record<string, unknown> : {}
      const firstBlock = Array.isArray(message.content) && typeof message.content[0] === 'object' && message.content[0] !== null ? message.content[0] as Record<string, unknown> : {}
      const callId = typeof source.callId === 'string' ? source.callId : typeof firstBlock.toolCallId === 'string' ? firstBlock.toolCallId : ''
      if (callId.length > 0) operation.toolStartedAt.delete(callId)
    }
    const countedRequest = event.type === 'assistant/message' || event.type === 'assistant/attempt'
    const usage = tokenUsageFromEvent(event)
    if (usage === undefined && !countedRequest) return
    if (usage !== undefined) operation.usage = addTokenUsage(operation.usage, usage)
    this.usagePersistence = this.usagePersistence
      .then(async () => {
        if (countedRequest) await this.settingsStore.recordRequest()
        const lifetimeUsage = usage === undefined ? this.settingsStore.lifetimeUsage() : await this.settingsStore.addUsage(usage)
        const statistics = this.settingsStore.statistics()
        if (operation.settled && this.active !== operation) return
        if (usage !== undefined) this.publish({ type: 'tokens', operationId: operation.id, operationUsage: { ...operation.usage }, lifetimeUsage })
        if (countedRequest || usage !== undefined) this.publish({ type: 'statistics', operationId: operation.id, statistics })
      })
      .catch(error => { console.error('Failed to persist token usage', error) })
  }

  private publishTrace(operation: ActiveOperation, event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : 'event'
    if (!['user/message', 'system/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'turn/start', 'step/start', 'request/header'].includes(type)) return
    const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
    const turn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? Math.max(0, Math.floor(data.turn)) : 0
    const step = typeof data.step === 'number' && Number.isFinite(data.step) ? Math.max(0, Math.floor(data.step)) : 0
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
    const message = typeof data.message === 'object' && data.message !== null ? data.message as Record<string, unknown> : {}
    const callId = type === 'tool/call'
      ? typeof data.callId === 'string' ? data.callId : ''
      : type === 'tool/result'
        ? typeof (message.source as Record<string, unknown> | undefined)?.callId === 'string'
          ? String((message.source as Record<string, unknown>).callId)
          : ''
        : ''
    const started = callId.length === 0 ? undefined : operation.toolStartedAt.get(callId)
    const input = type === 'tool/call'
      ? typeof data.arguments === 'string' ? data.arguments : ''
      : type === 'user/message' || type === 'system/message'
        ? contentText(message.content)
        : ''
    const output = type === 'assistant/message'
      ? assistantTextFromEvent(event) ?? ''
      : type === 'tool/result'
        ? contentText(message.content)
        : ''
    const stream = Array.isArray(data.stream) ? data.stream : Array.isArray(message.content) ? message.content : []
    const usage = tokenUsageFromEvent(event)
    const thinking = stream.map(item => {
      const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
      const chunk = typeof record.chunk === 'object' && record.chunk !== null ? record.chunk as Record<string, unknown> : record
      const kind = typeof chunk.type === 'string' ? chunk.type : ''
      return kind.toLocaleLowerCase().includes('reason') || kind.toLocaleLowerCase().includes('think')
        ? typeof chunk.text === 'string' ? chunk.text : typeof chunk.content === 'string' ? chunk.content : ''
        : ''
    }).filter(Boolean).join('')
    const entry: AgentTraceEntry = {
      id: `${typeof event.seq === 'number' ? event.seq : time}-${type}`,
      type,
      turn,
      step,
      label: type === 'tool/call'
        ? typeof data.name === 'string' ? data.name : 'tool'
        : type === 'tool/result'
          ? started?.name ?? 'tool'
          : type === 'user/message' ? 'User' : type === 'system/message' ? 'System' : type === 'assistant/attempt' ? 'Thinking' : type === 'assistant/message' ? 'Assistant' : type,
      detail: type === 'assistant/attempt' ? thinking.slice(0, 20_000) : output.slice(0, 20_000),
      ...(input.length === 0 ? {} : { input: input.slice(0, 20_000) }),
      ...(output.length === 0 ? {} : { output: output.slice(0, 20_000) }),
      ...(thinking.length === 0 ? {} : { reasoning: thinking.slice(0, 20_000) }),
      time,
      ...(started === undefined ? {} : { durationMs: Math.max(0, Date.now() - started.time) }),
      ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
      ...(typeof data.error === 'object' && data.error !== null ? { isError: true } : {}),
    }
    this.publish({ type: 'trace', operationId: operation.id, entry })
  }

  private publishPlanProgress(operation: ActiveOperation, activityDetail: string): void {
    const plan = operation.plan
    if (plan === undefined || plan.steps.length === 0) return
    const totalBudget = plan.steps.reduce((total, step) => total + step.expectedTools, 0)
    let consumed = operation.toolCount
    let activeIndex = 0
    const completed: string[] = []
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]
      if (step === undefined) continue
      activeIndex = index
      if (index === plan.steps.length - 1 || consumed < step.expectedTools) break
      consumed -= step.expectedTools
      completed.push(step.id)
    }
    const completedBudget = plan.steps
      .filter(step => completed.includes(step.id))
      .reduce((total, step) => total + step.expectedTools, 0)
    const active = plan.steps[activeIndex] ?? plan.steps[0]
    if (active === undefined) return
    const withinStep = Math.min(active.expectedTools, consumed)
    const progress = 10 + Math.round((completedBudget + withinStep) / Math.max(1, totalBudget) * 82)
    this.publishProgress(
      operation,
      `第 ${activeIndex + 1}/${plan.steps.length} 步 · ${active.title}`,
      `${active.description} 当前活动：${activityDetail}`,
      Math.min(92, progress),
      active.id,
      completed,
    )
  }

  private publishProgress(
    operation: ActiveOperation,
    stage: string,
    message: string,
    progress?: number,
    planStepId?: string,
    completedPlanStepIds?: string[],
  ): void {
    this.publish({
      type: 'progress',
      operationId: operation.id,
      stage,
      message,
      ...(progress === undefined ? {} : { progress }),
      ...(planStepId === undefined ? {} : { planStepId }),
      ...(completedPlanStepIds === undefined ? {} : { completedPlanStepIds }),
    })
  }

  private async checkpoint(operation: ActiveOperation, phase: OperationResumePhase): Promise<void> {
    if (operation.resumeState === undefined) throw new Error('当前操作不支持会话断点')
    operation.resumeState = { ...operation.resumeState, phase }
    this.publish({ type: 'checkpoint', operationId: operation.id, resumeState: structuredClone(operation.resumeState) })
    await this.flushHistory()
  }

  private complete(operation: ActiveOperation, summary: string): void {
    if (operation.settled) return
    operation.settled = true
    this.publish({ type: 'completed', operationId: operation.id, summary, finishedAt: Date.now(), operationUsage: { ...operation.usage } })
  }

  private failed(operation: ActiveOperation, message: string): void {
    if (operation.settled) return
    operation.settled = true
    this.publish({ type: 'failed', operationId: operation.id, message, finishedAt: Date.now(), operationUsage: { ...operation.usage } })
  }

  private cancelled(operation: ActiveOperation, summary?: string): void {
    if (operation.settled) return
    operation.settled = true
    this.publish({ type: 'cancelled', operationId: operation.id, finishedAt: Date.now(), operationUsage: { ...operation.usage }, ...(summary === undefined ? {} : { summary }) })
  }
}

export function selectedRiskContext(risks: readonly RiskItem[]): RiskItem[] {
  return risks.slice(0, 50).map(risk => structuredClone(risk))
}
