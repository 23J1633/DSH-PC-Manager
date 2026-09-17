import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AppSettings,
  ChatInput,
  CleanupInput,
  OperationEvent,
  OperationKind,
  OperationPlan,
  PathReference,
  RiskItem,
  SaveSettingsInput,
  ScanKind,
  ScanTarget,
  TokenUsage,
} from '../shared/types.js'
import { EMPTY_TOKEN_USAGE } from '../shared/types.js'
import { addTokenUsage, DshRuntime, sessionEventFromNotification, tokenUsageFromEvent, type DshNotification } from './dsh-runtime.js'
import { testModelConnection } from './connection-test.js'
import { BUILT_IN_PRESETS, chatPrompt, cleanupAuditPrompt, cleanupPrompt, fallbackScanPlan, promptForScan, scanPlanningPrompt } from './prompt-library.js'
import { parseCleanupAuditReport, parseCleanupReport, parseOperationPlan, parseScanReport, stripStructuredBlocks } from './result-parser.js'
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
  model: string
  reasoningEffort: AppSettings['reasoningEffort']
  plan?: OperationPlan
  cancelled: boolean
  settled: boolean
}

type Publisher = (event: OperationEvent) => void

interface OperationContext {
  targets?: ScanTarget[]
  authorizedRisks?: RiskItem[]
  cleanupInstructions?: CleanupInput['instructions']
}

function operationTitle(kind: OperationKind): string {
  switch (kind) {
    case 'disk': return '硬盘清理扫描'
    case 'virus': return '病毒扫描'
    case 'cleanup': return 'Agent 二次研判与清理'
    case 'chat': return '电脑管家对话'
    case 'connection-test': return '模型连接测试'
  }
}

function compactArguments(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, 360)
}

function toolPresentation(name: string, argumentsText: string): { label: string; stage: string; detail: string } {
  const lower = name.toLocaleLowerCase()
  if (lower.includes('pwsh') || lower.includes('bash')) {
    return { label: '系统检查', stage: '正在分析系统状态', detail: compactArguments(argumentsText) || '执行只读系统查询' }
  }
  if (lower.includes('search') || lower.includes('glob')) {
    return { label: '文件搜索', stage: '正在覆盖文件目录', detail: compactArguments(argumentsText) || '检索目录元数据' }
  }
  if (lower.includes('read') || lower.includes('view') || lower.includes('fs')) {
    return { label: '证据核验', stage: '正在核验风险证据', detail: compactArguments(argumentsText) || '读取目标元数据' }
  }
  return { label: name, stage: 'Agent 正在调用工具', detail: compactArguments(argumentsText) }
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

export class OperationController {
  private active: ActiveOperation | undefined
  private usagePersistence: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly paths: ControllerPaths,
    private readonly publish: Publisher,
  ) {}

  async startScan(kind: ScanKind, requestedTargets: ScanTarget[]): Promise<string> {
    const settings = this.settingsStore.publicSettings()
    const targets = await this.validateScanTargets(requestedTargets, settings.includeNetworkDrives)
    const operation = this.createOperation(kind, 'read-only', settings, { targets })
    void this.execute(operation, async () => {
      const promptOptions = {
        rootPath: this.paths.rootPath,
        presetPrompt: currentPreset(settings),
        scanDepth: settings.scanDepth,
        includeNetworkDrives: settings.includeNetworkDrives,
        targets,
      } as const
      this.publishProgress(operation, 'Agent 正在制定扫描计划', `正在根据 ${targets.length} 个用户选择范围规划只读检查步骤。`, 3)
      const planningResult = await operation.runtime.run(scanPlanningPrompt(kind, { ...promptOptions, targets: [...targets] }))
      let plan: OperationPlan
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
      const result = await operation.runtime.run(promptForScan(kind, { ...promptOptions, targets: [...targets], plan }))
      this.publishProgress(operation, '整理并排序风险清单', 'Agent 已完成观察，正在校验结构化结果并按严重程度排序。', 96, plan.steps.at(-1)?.id, plan.steps.slice(0, -1).map(step => step.id))
      const report = parseScanReport(result.finalResponse, kind)
      this.publish({
        type: 'risks',
        operationId: operation.id,
        scanKind: kind,
        summary: report.summary,
        risks: report.risks,
      })
      const narrative = stripStructuredBlocks(result.finalResponse)
      if (narrative.length > 0) this.publish({ type: 'assistant-message', operationId: operation.id, content: narrative })
      this.complete(operation, report.summary)
    })
    return operation.id
  }

  startCleanup(input: CleanupInput): string {
    if (input.risks.length === 0) throw new Error('请至少勾选一个待处理项目')
    if (input.risks.length > 200) throw new Error('单次最多处理 200 个项目')
    const ignoredRisks = Array.isArray(input.ignoredRisks) ? input.ignoredRisks.slice(0, 200) : []
    const riskIds = new Set(input.risks.map(risk => risk.id))
    const ignoredRiskIds = new Set(ignoredRisks.map(risk => risk.id))
    if (riskIds.size !== input.risks.length || ignoredRiskIds.size !== ignoredRisks.length) throw new Error('项目清单包含重复 ID')
    if (ignoredRisks.some(risk => riskIds.has(risk.id))) throw new Error('同一项目不能同时清理和忽略')
    const instructions = Array.isArray(input.instructions) ? input.instructions : []
    if (new Set(instructions.map(instruction => instruction.riskId)).size !== instructions.length) throw new Error('同一项目只能设置一种处理方案')
    if (instructions.some(instruction => !riskIds.has(instruction.riskId) && !ignoredRiskIds.has(instruction.riskId))) throw new Error('处理方案包含未知项目')
    const normalizedInstructions = input.risks.map(risk => {
      const selected = instructions.find(instruction => instruction.riskId === risk.id)
      const mode = selected?.mode ?? 'recommended'
      if (mode !== 'recommended' && mode !== 'quarantine' && mode !== 'manual') throw new Error('处理方案无效')
      const instruction = selected?.instruction?.trim().slice(0, 2000)
      if (mode === 'manual' && !instruction) throw new Error(`请填写“${risk.name}”的手动处理方案`)
      return { riskId: risk.id, mode, ...(instruction === undefined ? {} : { instruction }) }
    })
    const historyInstructions = [
      ...normalizedInstructions,
      ...ignoredRisks.map(risk => ({ riskId: risk.id, mode: 'ignore' as const })),
    ]
    const settings = this.settingsStore.publicSettings()
    const operation = this.createOperation('cleanup', 'read-only', settings, {
      authorizedRisks: structuredClone([...input.risks, ...ignoredRisks]),
      cleanupInstructions: structuredClone(historyInstructions),
    })
    void this.execute(operation, async () => {
      await mkdir(this.paths.quarantinePath, { recursive: true })
      this.publishProgress(operation, '独立审核 Agent 正在复核', '只读审核会逐项核验证据、误伤风险与可逆性；未通过的项目不会交给清理 Agent。', 5)
      const auditResult = await operation.runtime.run(cleanupAuditPrompt({
        rootPath: this.paths.rootPath,
        quarantinePath: join(this.paths.quarantinePath, operation.id),
        presetPrompt: currentPreset(settings),
        sourceScanKind: input.sourceScanKind,
        risks: structuredClone(input.risks),
        instructions: structuredClone(normalizedInstructions),
      }))
      const auditReport = parseCleanupAuditReport(auditResult.finalResponse, input.risks)
      this.publish({ type: 'audit-report', operationId: operation.id, report: auditReport })
      const auditNarrative = stripStructuredBlocks(auditResult.finalResponse)
      if (auditNarrative.length > 0) this.publish({ type: 'assistant-message', operationId: operation.id, content: `审核 Agent：${auditNarrative}` })
      const allowedIds = new Set(auditReport.decisions.filter(decision => decision.verdict === 'allow').map(decision => decision.id))
      const allowedRisks = input.risks.filter(risk => allowedIds.has(risk.id))
      const allowedInstructions = normalizedInstructions.filter(instruction => allowedIds.has(instruction.riskId))
      if (allowedRisks.length === 0) {
        const report = {
          summary: '独立审核 Agent 未放行任何项目，本次未执行系统修改。',
          results: input.risks.map(risk => {
            const decision = auditReport.decisions.find(item => item.id === risk.id)
            return {
              id: risk.id,
              status: 'skipped' as const,
              action: decision?.verdict === 'deny' ? '审核拒绝' : '需要人工确认',
              detail: decision?.reason ?? '审核结果缺失，安全跳过。',
            }
          }),
          rebootRecommended: false,
          followup: auditReport.globalWarnings,
        }
        this.publish({ type: 'cleanup-report', operationId: operation.id, report })
        this.complete(operation, report.summary)
        return
      }
      this.publishProgress(operation, '审核通过，准备执行', `审核 Agent 放行 ${allowedRisks.length}/${input.risks.length} 项，正在启动隔离的清理 Agent。`, 38)
      await operation.runtime.close()
      if (operation.cancelled) throw new Error('操作已取消')
      operation.runtime = this.createRuntime(operation, settings, 'danger-full-access')
      const result = await operation.runtime.run(cleanupPrompt({
        rootPath: this.paths.rootPath,
        quarantinePath: join(this.paths.quarantinePath, operation.id),
        presetPrompt: currentPreset(settings),
        sourceScanKind: input.sourceScanKind,
        risks: structuredClone(allowedRisks),
        instructions: structuredClone(allowedInstructions),
        auditReport,
      }))
      this.publishProgress(operation, '生成清理报告', '正在核对每个授权项目的实际结果。', 96)
      const executionReport = parseCleanupReport(result.finalResponse, allowedRisks)
      const executionById = new Map(executionReport.results.map(item => [item.id, item]))
      const decisionById = new Map(auditReport.decisions.map(item => [item.id, item]))
      const report = {
        ...executionReport,
        summary: `审核 Agent 放行 ${allowedRisks.length}/${input.risks.length} 项。${executionReport.summary}`,
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
        followup: [...auditReport.globalWarnings, ...executionReport.followup],
      }
      this.publish({ type: 'cleanup-report', operationId: operation.id, report })
      const narrative = stripStructuredBlocks(result.finalResponse)
      if (narrative.length > 0) this.publish({ type: 'assistant-message', operationId: operation.id, content: narrative })
      this.complete(operation, report.summary)
    })
    return operation.id
  }

  async startChat(input: ChatInput): Promise<string> {
    const message = input.message.trim()
    if (message.length === 0) throw new Error('请输入消息')
    const referencedPaths = await this.validatePathReferences(Array.isArray(input.referencedPaths) ? input.referencedPaths : [])
    const settings = this.settingsStore.publicSettings()
    const operation = this.createOperation('chat', 'read-only', settings)
    void this.execute(operation, async () => {
      this.publishProgress(operation, '只读咨询', 'Agent 正在结合当前风险清单分析问题。', 12)
      const relatedRisks = Array.isArray(input.relatedRisks) ? input.relatedRisks.slice(0, 50) : []
      const result = await operation.runtime.run(chatPrompt(message.slice(0, 20_000), relatedRisks, currentPreset(settings), referencedPaths))
      const answer = result.finalResponse.trim() || 'Agent 未返回可显示的答复。'
      this.publish({ type: 'assistant-message', operationId: operation.id, content: answer })
      this.complete(operation, 'Agent 已完成答复')
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
    operation.cancelled = true
    await operation.runtime.close(true)
  }

  private createOperation(
    kind: OperationKind,
    permissionMode: 'read-only' | 'danger-full-access',
    settings: AppSettings,
    context: OperationContext = {},
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
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      cancelled: false,
      settled: false,
      runtime: undefined as unknown as DshRuntime,
    }
    operation.runtime = this.createRuntime(operation, settings, permissionMode, apiKey)
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
    })
    return operation
  }

  private createRuntime(
    operation: ActiveOperation,
    settings: AppSettings,
    permissionMode: 'read-only' | 'danger-full-access',
    providedApiKey?: string,
  ): DshRuntime {
    const apiKey = providedApiKey ?? this.settingsStore.apiKey()
    if (apiKey === undefined || apiKey.trim().length === 0) throw new Error('请先在设置中配置 DeepSeek API Key')
    return new DshRuntime({
      cwd: this.paths.rootPath,
      dshHome: this.paths.dshHome,
      patchPath: this.paths.patchPath,
      provider: settings.provider,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      apiKey,
      baseUrl: settings.baseUrl,
      permissionMode,
      telemetryEnabled: settings.telemetryEnabled,
      maxTokens: operation.kind === 'chat' ? 4096 : 16_384,
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
      if (operation.cancelled) this.cancelled(operation)
      else this.failed(operation, errorMessage(error))
    } finally {
      await operation.runtime.close(operation.cancelled).catch(error => {
        if (!operation.settled) this.failed(operation, `关闭 DSH 运行时时发生错误：${errorMessage(error)}`)
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
      operation.toolCount += 1
      this.publish({
        type: 'tool',
        operationId: operation.id,
        tool: name,
        label: presentation.label,
        detail: presentation.detail,
        time: Date.now(),
      })
      if (operation.plan !== undefined) this.publishPlanProgress(operation, presentation.detail)
      else this.publishProgress(operation, presentation.stage, presentation.detail)
    }
    const usage = tokenUsageFromEvent(event)
    if (usage === undefined) return
    operation.usage = addTokenUsage(operation.usage, usage)
    this.usagePersistence = this.usagePersistence
      .then(async () => {
        const lifetimeUsage = await this.settingsStore.addUsage(usage)
        if (operation.settled && this.active !== operation) return
        this.publish({
          type: 'tokens',
          operationId: operation.id,
          operationUsage: { ...operation.usage },
          lifetimeUsage,
        })
      })
      .catch(error => { console.error('Failed to persist token usage', error) })
  }

  private publishPlanProgress(operation: ActiveOperation, activityDetail: string): void {
    const plan = operation.plan
    if (plan === undefined || plan.steps.length === 0) return
    const totalBudget = plan.steps.reduce((total, step) => total + step.expectedTools, 0)
    let consumed = Math.max(0, operation.toolCount - 1)
    let activeIndex = 0
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]
      if (step === undefined) continue
      activeIndex = index
      if (index === plan.steps.length - 1 || consumed < step.expectedTools) break
      consumed -= step.expectedTools
    }
    const completed = plan.steps.slice(0, activeIndex).map(step => step.id)
    const completedBudget = plan.steps.slice(0, activeIndex).reduce((total, step) => total + step.expectedTools, 0)
    const active = plan.steps[activeIndex] ?? plan.steps[0]
    if (active === undefined) return
    const withinStep = Math.min(active.expectedTools * 0.9, consumed + 0.45)
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

  private cancelled(operation: ActiveOperation): void {
    if (operation.settled) return
    operation.settled = true
    this.publish({ type: 'cancelled', operationId: operation.id, finishedAt: Date.now(), operationUsage: { ...operation.usage } })
  }
}

export function selectedRiskContext(risks: readonly RiskItem[]): RiskItem[] {
  return risks.slice(0, 50).map(risk => structuredClone(risk))
}
