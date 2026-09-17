import {
  Activity,
  AlertTriangle,
  AtSign,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  Coins,
  FileWarning,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  History,
  Info,
  KeyRound,
  LockKeyhole,
  Maximize2,
  Minimize2,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  User,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  AgentPreset,
  AppSettings,
  BootstrapData,
  CleanupAuditReport,
  CleanupInstruction,
  CleanupReport,
  DiskVolume,
  OperationEvent,
  OperationHistoryEntry,
  OperationKind,
  OperationPlan,
  OperationState,
  RiskItem,
  SaveSettingsInput,
  ScanKind,
  ScanTarget,
  PathReference,
  PathSuggestion,
  Severity,
  TokenUsage,
} from '../shared/types.js'
import { EMPTY_TOKEN_USAGE } from '../shared/types.js'

interface UiOperation {
  id: string
  kind: OperationKind
  title: string
  state: OperationState
  stage: string
  message: string
  progress: number
  startedAt: number
  plan?: OperationPlan
  activePlanStepId?: string
  completedPlanStepIds: string[]
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  time: number
}

interface ToolActivity {
  id: string
  label: string
  detail: string
  time: number
}

interface ToastState {
  id: number
  tone: 'success' | 'error' | 'info'
  message: string
}

type RiskResolutionMode = 'recommended' | 'ignore' | 'quarantine' | 'manual'

interface RiskResolution {
  mode: RiskResolutionMode
  instruction: string
}

const REASONING_LABELS: Record<AppSettings['reasoningEffort'], string> = {
  off: '关闭思考',
  low: '低思考',
  high: '高思考',
  max: '最高思考',
}

const RESOLUTION_LABELS: Record<RiskResolutionMode, string> = {
  recommended: '采用 AI 建议',
  ignore: '忽略',
  quarantine: '隔离',
  manual: '手动方案',
}

type SettingsTab = 'general' | 'model' | 'agent' | 'security' | 'about'

const SEVERITY_LABELS: Record<Severity, string> = {
  low: '低风险',
  medium: '需确认',
  high: '高风险',
  critical: '严重',
}

const KIND_LABELS: Record<RiskItem['kind'], string> = {
  file: '文件',
  directory: '目录',
  process: '进程',
  startup: '启动项',
  firewall: '防火墙',
  service: '服务',
  'scheduled-task': '计划任务',
  registry: '注册表',
  network: '网络',
  'browser-extension': '浏览器扩展',
  other: '其他',
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const amount = value / 1024 ** index
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(value)
}

function formatDateTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

export function MarkdownContent(props: { content: string }): ReactNode {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => href === undefined
            ? <span>{children}</span>
            : <a href={href} onClick={event => { event.preventDefault(); void window.pcManager.openExternal(href) }}>{children}</a>,
          img: ({ alt }) => <span className="blocked-image">[图片：{alt ?? '未命名'}]</span>,
        }}
      >
        {props.content}
      </ReactMarkdown>
    </div>
  )
}

interface MentionContext {
  start: number
  end: number
  query: string
}

function mentionContextAt(text: string, caret: number): MentionContext | undefined {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf('@')
  if (start < 0) return undefined
  if (start > 0 && !/\s|[(（]/.test(before[start - 1] ?? '')) return undefined
  const fragment = before.slice(start + 1)
  if (fragment.includes('\n') || fragment.includes(']')) return undefined
  if (fragment.length > 260) return undefined
  return { start, end: caret, query: fragment.replace(/^\[/, '') }
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function settingsInput(settings: AppSettings, overrides: Partial<SaveSettingsInput> = {}): SaveSettingsInput {
  return {
    provider: settings.provider,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    baseUrl: settings.baseUrl,
    theme: settings.theme,
    fontScale: settings.fontScale,
    activePresetId: settings.activePresetId,
    customPresets: settings.customPresets,
    scanDepth: settings.scanDepth,
    includeNetworkDrives: settings.includeNetworkDrives,
    quarantineRetentionDays: settings.quarantineRetentionDays,
    telemetryEnabled: settings.telemetryEnabled,
    ...overrides,
  }
}

function applyTheme(theme: AppSettings['theme']): void {
  const resolved = theme === 'system'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    : theme
  document.documentElement.dataset.theme = resolved
}

function WindowTitleBar(props: { configured: boolean; onHistory(): void; onSettings(): void }): ReactNode {
  return (
    <header className="titlebar">
      <div className="brand drag-region">
        <span className="brand-mark"><img src="./whale.svg" alt="" /></span>
        <span className="brand-title">DSH PC Manager</span>
        <span className={`connection-dot ${props.configured ? 'online' : ''}`} />
        <span className="connection-label">{props.configured ? 'Agent 就绪' : '待配置'}</span>
      </div>
      <div className="titlebar-center drag-region">AI 智能体电脑管家</div>
      <div className="window-actions">
        <button type="button" className="window-button" aria-label="操作历史" title="操作历史" onClick={props.onHistory}><History size={16} /></button>
        <button type="button" className="window-button" aria-label="设置" onClick={props.onSettings}><Settings2 size={16} /></button>
        <button type="button" className="window-button" aria-label="最小化" onClick={() => { window.pcManager.window.minimize() }}><Minus size={17} /></button>
        <button type="button" className="window-button" aria-label="最大化" onClick={() => { window.pcManager.window.toggleMaximize() }}><Maximize2 size={14} /></button>
        <button type="button" className="window-button close" aria-label="关闭" onClick={() => { window.pcManager.window.close() }}><X size={17} /></button>
      </div>
    </header>
  )
}

interface ActionCardProps {
  tone: 'blue' | 'violet' | 'ink'
  icon: LucideIcon
  eyebrow: string
  title: string
  description: string
  metric: string
  metricLabel: string
  busy?: boolean
  disabled?: boolean
  actionLabel?: string
  onClick?: () => void
  children?: ReactNode
}

function ActionCard(props: ActionCardProps): ReactNode {
  const Icon = props.icon
  return (
    <article className={`action-card ${props.tone}`}>
      <div className="card-glow" />
      <div className="action-card-head">
        <span className="action-icon"><Icon size={22} strokeWidth={1.9} /></span>
        <span className="action-eyebrow">{props.eyebrow}</span>
        {props.busy === true && <span className="live-pill"><i />运行中</span>}
      </div>
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.children ?? (
        <div className="action-card-foot">
          <div><strong>{props.metric}</strong><span>{props.metricLabel}</span></div>
          {props.onClick !== undefined && (
            <button type="button" disabled={props.disabled === true} onClick={props.onClick}>
              {props.actionLabel ?? '开始扫描'}<ChevronRight size={16} />
            </button>
          )}
        </div>
      )}
    </article>
  )
}

function TokenCard(props: { operation: TokenUsage; lifetime: TokenUsage; busy: boolean }): ReactNode {
  return (
    <ActionCard
      tone="ink"
      icon={Coins}
      eyebrow={props.busy ? 'LIVE TOKEN METER' : 'TOKEN METER'}
      title="Token 消耗"
      description="本次任务实时更新，并保留本机累计记录"
      metric=""
      metricLabel=""
      busy={props.busy}
    >
      <div className="token-dual">
        <div><span>本次</span><strong>{formatTokens(props.operation.totalTokens)}</strong><small>Token</small></div>
        <div><span>累计</span><strong>{formatTokens(props.lifetime.totalTokens)}</strong><small>Token</small></div>
      </div>
      <div className="token-breakdown">
        <span><i className="input" />输入 <b>{formatTokens(props.operation.inputTokens)}</b></span>
        <span><i className="output" />输出 <b>{formatTokens(props.operation.outputTokens)}</b></span>
        <span><i className="reasoning" />推理 <b>{formatTokens(props.operation.reasoningTokens)}</b></span>
      </div>
      <div className="token-meter-line"><span style={{ width: `${Math.min(100, props.operation.totalTokens / 200)}%` }} /></div>
    </ActionCard>
  )
}

function ProgressPanel(props: {
  operation: UiOperation | undefined
  activities: ToolActivity[]
  riskCount: number
  onCancel(): void
}): ReactNode {
  const { operation } = props
  if (operation === undefined) {
    return (
      <section className="progress-panel idle-panel">
        <div className="idle-visual"><Sparkles size={25} /></div>
        <div>
          <h3>等待开始一次智能扫描</h3>
          <p>选择硬盘清理或病毒扫描，DSH Agent 将在只读沙箱中检查这台电脑。</p>
        </div>
        <span className="safety-chip"><LockKeyhole size={14} />扫描阶段禁止写入</span>
      </section>
    )
  }
  const running = operation.state === 'running' || operation.state === 'starting' || operation.state === 'cancelling'
  return (
    <section className={`progress-panel ${running ? 'active' : operation.state}`}>
      <div className="progress-main">
        <div className={`progress-orb ${running ? 'spinning' : ''}`}>
          {operation.state === 'failed' ? <AlertTriangle size={24} /> : operation.state === 'cancelled' ? <CircleStop size={24} /> : <Activity size={24} />}
        </div>
        <div className="progress-copy">
          <div className="progress-title-row">
            <h3>{operation.stage}</h3>
            <span>{operation.progress}%</span>
          </div>
          <p>{operation.message}</p>
          <div className="progress-track"><span style={{ width: `${operation.progress}%` }} /></div>
        </div>
        {running && (
          <button type="button" className="ghost-button danger-text" disabled={operation.state === 'cancelling'} onClick={props.onCancel}>
            <CircleStop size={15} />{operation.state === 'cancelling' ? '正在停止' : '停止'}
          </button>
        )}
      </div>
      {operation.plan !== undefined && (
        <div className="plan-panel">
          <div className="plan-panel-head">
            <span><Sparkles size={14} />Agent 扫描计划</span>
            <small>{operation.plan.source === 'agent' ? '规划 Agent 生成' : '内置安全计划'}</small>
          </div>
          <p>{operation.plan.summary}</p>
          <ol className="plan-steps">
            {operation.plan.steps.map((step, index) => {
              const completed = operation.completedPlanStepIds.includes(step.id) || operation.state === 'completed'
              const active = operation.activePlanStepId === step.id && !completed
              return (
                <li key={step.id} className={completed ? 'completed' : active ? 'active' : ''}>
                  <span>{completed ? <Check size={12} /> : active ? <Activity size={12} /> : index + 1}</span>
                  <div><b>{step.title}</b><small>{step.description}</small></div>
                </li>
              )
            })}
          </ol>
        </div>
      )}
      <div className="activity-strip">
        <span className="activity-label"><Wrench size={14} />Agent 动态</span>
        <div className="activity-items">
          {props.activities.length === 0
            ? <span className="muted">正在建立安全会话…</span>
            : props.activities.slice(-3).map(item => (
                <span key={item.id} className="activity-item" title={item.detail}>
                  <i />{item.label}<small>{item.detail}</small>
                </span>
              ))}
        </div>
        <span className="risk-counter">已发现 <b>{props.riskCount}</b> 项</span>
      </div>
    </section>
  )
}

function RiskRow(props: {
  risk: RiskItem
  checked: boolean
  disabled: boolean
  cleanupStatus?: CleanupReport['results'][number]
  resolution: RiskResolution
  onToggle(): void
  onResolution(resolution: RiskResolution): void
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  return (
    <article className={`risk-row severity-${props.risk.severity} ${props.checked ? 'selected' : ''}`}>
      <label className="checkbox-wrap" aria-label={`选择 ${props.risk.name}`}>
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={props.onToggle} />
        <span><Check size={13} /></span>
      </label>
      <div className="risk-symbol">
        {props.risk.scanKind === 'virus' ? <ShieldCheck size={19} /> : props.risk.kind === 'directory' ? <FolderOpen size={19} /> : <FileWarning size={19} />}
      </div>
      <div className="risk-content">
        <div className="risk-title-line">
          <h4>{props.risk.name}</h4>
          <span className={`severity-badge ${props.risk.severity}`}>{SEVERITY_LABELS[props.risk.severity]}</span>
          <span className="kind-badge">{KIND_LABELS[props.risk.kind]}</span>
          {props.cleanupStatus !== undefined && <span className={`cleanup-status ${props.cleanupStatus.status}`}>{props.cleanupStatus.status === 'quarantined' ? '已隔离' : props.cleanupStatus.status === 'cleaned' ? '已清理' : props.cleanupStatus.status === 'skipped' ? '已跳过' : '失败'}</span>}
        </div>
        <p>{props.risk.description}</p>
        <code title={props.risk.target}>{props.risk.target}</code>
        {expanded && (
          <div className="risk-details">
            <div><b>判断理由</b><span>{props.risk.reason}</span></div>
            <div><b>建议动作</b><span>{props.risk.recommendedAction}</span></div>
            {props.risk.evidence.length > 0 && <div><b>证据</b><span>{props.risk.evidence.join('；')}</span></div>}
            {props.cleanupStatus !== undefined && <div><b>执行结果</b><span>{props.cleanupStatus.detail}</span></div>}
            {props.cleanupStatus === undefined && (
              <div className="resolution-editor">
                <b>处理方案</b>
                <div>
                  <div className="resolution-options" role="group" aria-label={`${props.risk.name} 的处理方案`}>
                    {(['recommended', 'ignore', 'quarantine', 'manual'] as const).map(mode => <button key={mode} type="button" disabled={props.disabled} className={props.resolution.mode === mode ? 'active' : ''} onClick={() => { props.onResolution({ mode, instruction: mode === 'manual' ? props.resolution.instruction : '' }) }}>{RESOLUTION_LABELS[mode]}</button>)}
                  </div>
                  {props.resolution.mode === 'manual' && <textarea rows={3} disabled={props.disabled} value={props.resolution.instruction} maxLength={2000} placeholder="请输入希望 Agent 执行的具体方案；审核 Agent 会先检查安全性和授权边界。" onChange={event => { props.onResolution({ mode: 'manual', instruction: event.target.value }) }} />}
                  <small>{props.resolution.mode === 'ignore' ? '此项不会进入清理会话。' : props.resolution.mode === 'quarantine' ? '只允许移动到可恢复隔离区，不允许永久删除。' : props.resolution.mode === 'manual' ? '方案会先交给独立审核 Agent，审核拒绝时不会执行。' : '清理 Agent 将基于扫描建议再次核验后决定动作。'}</small>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="risk-meta">
        <strong>{props.risk.sizeBytes === undefined ? '—' : formatBytes(props.risk.sizeBytes)}</strong>
        <span>{props.cleanupStatus === undefined ? RESOLUTION_LABELS[props.resolution.mode] : props.risk.reversible ? '可逆处理' : '需谨慎'}</span>
      </div>
      <button type="button" className="expand-risk" aria-label="展开详情" onClick={() => { setExpanded(value => !value) }}>
        <ChevronDown size={17} className={expanded ? 'rotated' : ''} />
      </button>
    </article>
  )
}

function RiskSection(props: {
  risks: RiskItem[]
  selectedIds: Set<string>
  busy: boolean
  cleanupReport?: CleanupReport
  resolutions: Record<string, RiskResolution>
  onToggle(id: string): void
  onSelectAll(ids: string[], selected: boolean): void
  onResolution(id: string, resolution: RiskResolution): void
  onCleanup(): void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [severity, setSeverity] = useState<'all' | Severity>('all')
  const filtered = useMemo(() => props.risks.filter(risk => {
    const matchesSeverity = severity === 'all' || risk.severity === severity
    const needle = query.trim().toLocaleLowerCase()
    const matchesQuery = needle.length === 0 || `${risk.name} ${risk.target} ${risk.description}`.toLocaleLowerCase().includes(needle)
    return matchesSeverity && matchesQuery
  }).sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || (right.sizeBytes ?? -1) - (left.sizeBytes ?? -1)
    || left.name.localeCompare(right.name, 'zh-CN', { numeric: true })), [props.risks, query, severity])
  const selectedRisks = props.risks.filter(risk => props.selectedIds.has(risk.id))
  const selectedBytes = selectedRisks.reduce((total, risk) => total + (risk.sizeBytes ?? 0), 0)
  const allFilteredSelected = filtered.length > 0 && filtered.every(risk => props.selectedIds.has(risk.id))
  const cleanupById = new Map(props.cleanupReport?.results.map(result => [result.id, result]))
  const incompleteManualCount = selectedRisks.filter(risk => props.resolutions[risk.id]?.mode === 'manual' && !props.resolutions[risk.id]?.instruction.trim()).length

  return (
    <section className="risk-section">
      <div className="section-heading">
        <div>
          <span className="section-kicker">SCAN RESULTS</span>
          <h3>风险与可清理项 <span>{props.risks.length}</span></h3>
        </div>
        <div className="risk-toolbar">
          <label className="search-field"><Search size={15} /><input value={query} onChange={event => { setQuery(event.target.value) }} placeholder="搜索名称或路径" /></label>
          <div className="filter-pills">
            {(['all', 'critical', 'high', 'medium', 'low'] as const).map(value => (
              <button key={value} type="button" className={severity === value ? 'active' : ''} onClick={() => { setSeverity(value) }}>
                {value === 'all' ? '全部' : SEVERITY_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      </div>
      {props.risks.length === 0 ? (
        <div className="empty-results">
          <span><ShieldCheck size={28} /></span>
          <h4>风险清单会显示在这里</h4>
          <p>Agent 完成扫描后，你可以逐项查看证据、勾选目标，再交给新的 Agent 会话二次研判。</p>
        </div>
      ) : (
        <>
          <div className="risk-list-head">
            <label className="select-all">
              <input type="checkbox" checked={allFilteredSelected} onChange={event => { props.onSelectAll(filtered.map(risk => risk.id), event.target.checked) }} />
              <span>选择当前筛选结果</span>
            </label>
            <span>显示 {filtered.length} 项</span>
          </div>
          <div className="risk-list">
            {filtered.map(risk => {
              const cleanupStatus = cleanupById.get(risk.id)
              return <RiskRow
                key={risk.id}
                risk={risk}
                checked={props.selectedIds.has(risk.id)}
                disabled={props.busy}
                resolution={props.resolutions[risk.id] ?? { mode: 'recommended', instruction: '' }}
                {...cleanupStatus === undefined ? {} : { cleanupStatus }}
                onToggle={() => { props.onToggle(risk.id) }}
                onResolution={resolution => { props.onResolution(risk.id, resolution) }}
              />
            })}
            {filtered.length === 0 && <div className="filter-empty">没有符合当前筛选条件的项目</div>}
          </div>
        </>
      )}
      <div className="cleanup-bar">
        <div className="selection-summary">
          <span className="selection-count">{selectedRisks.length}</span>
          <div><b>已选择项目</b><span>{selectedBytes > 0 ? `预计涉及 ${formatBytes(selectedBytes)}` : '最终动作由 Agent 二次判断'}</span></div>
        </div>
        <div className={`cleanup-note ${incompleteManualCount > 0 ? 'warning' : ''}`}><LockKeyhole size={14} />{incompleteManualCount > 0 ? `还有 ${incompleteManualCount} 项未填写手动方案` : '清理前会启动新会话重新核验，不会按清单盲删'}</div>
        <button type="button" className="primary-button cleanup-button" disabled={props.busy || selectedRisks.length === 0 || incompleteManualCount > 0} onClick={props.onCleanup}>
          <Sparkles size={16} />交给 Agent 一键清理
        </button>
      </div>
    </section>
  )
}

function ChatSection(props: {
  messages: ChatMessage[]
  settings: AppSettings
  presets: AgentPreset[]
  risks: RiskItem[]
  busy: boolean
  onSend(message: string, referencedPaths: PathReference[]): Promise<void>
  onQuickSetting(settings: SaveSettingsInput): Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [mention, setMention] = useState<MentionContext | undefined>()
  const [suggestions, setSuggestions] = useState<PathSuggestion[]>([])
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const [references, setReferences] = useState<PathReference[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [props.messages])
  useEffect(() => {
    if (!expanded) return
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [expanded])
  useEffect(() => {
    if (mention === undefined) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.pcManager.suggestPaths(mention.query).then(items => {
        if (cancelled) return
        setSuggestions(items)
        setSuggestionIndex(0)
      }).catch(() => {
        if (!cancelled) setSuggestions([])
      })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [mention])

  const updateDraft = (value: string, caret: number): void => {
    setDraft(value)
    setMention(mentionContextAt(value, caret))
    setReferences(current => current.filter(reference => value.includes(`@[${reference.path}]`)))
  }
  const chooseSuggestion = (suggestion: PathSuggestion): void => {
    if (mention === undefined) return
    const replacement = `@[${suggestion.path}]`
    const next = `${draft.slice(0, mention.start)}${replacement} ${draft.slice(mention.end)}`
    const caret = mention.start + replacement.length + 1
    setDraft(next)
    setMention(undefined)
    setSuggestions([])
    const type: PathReference['type'] = suggestion.type === 'file' ? 'file' : 'directory'
    setReferences(current => current.some(item => item.path.toLocaleLowerCase() === suggestion.path.toLocaleLowerCase())
      ? current
      : [...current, { path: suggestion.path, type }])
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(caret, caret)
    })
  }
  const submit = async (): Promise<void> => {
    const message = draft.trim()
    if (message.length === 0 || props.busy) return
    setDraft('')
    setMention(undefined)
    setSuggestions([])
    const submittedReferences = references
    setReferences([])
    await props.onSend(message, submittedReferences)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (suggestions.length > 0 && mention !== undefined) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSuggestionIndex(current => event.key === 'ArrowDown'
          ? (current + 1) % suggestions.length
          : (current - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        const selected = suggestions[suggestionIndex]
        if (selected !== undefined) chooseSuggestion(selected)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(undefined)
        setSuggestions([])
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }
  const models = [...new Set([props.settings.model, 'deepseek-v4-flash', 'deepseek-v4-pro'])]
  return (
    <section className={`chat-section ${expanded ? 'expanded' : ''}`}>
      <div className="chat-header">
        <div><span className="bot-avatar"><Bot size={17} /></span><h3>电脑管家对话</h3><span className="read-only-tag"><LockKeyhole size={12} />只读咨询</span></div>
        <div className="chat-header-actions"><span>可结合当前 {props.risks.length} 个风险项继续询问</span><button type="button" title={expanded ? '退出全屏对话' : '放大对话'} aria-label={expanded ? '退出全屏对话' : '放大对话'} onClick={() => { setExpanded(value => !value) }}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div>
      </div>
      <div className="chat-messages" ref={listRef}>
        {props.messages.length === 0 ? (
          <div className="chat-welcome">
            <Sparkles size={18} />
            <span><b>需要进一步判断？</b>可以问我某个风险项是否该清理，或让 Agent 解释扫描证据。</span>
          </div>
        ) : props.messages.map(message => (
          <div key={message.id} className={`chat-message ${message.role}`}>
            <span className="message-avatar">{message.role === 'user' ? <User size={15} /> : message.role === 'assistant' ? <Bot size={15} /> : <Info size={15} />}</span>
            <div className="message-content"><MarkdownContent content={message.content} /><time>{formatTime(message.time)}</time></div>
          </div>
        ))}
      </div>
      <div className="composer">
        {suggestions.length > 0 && mention !== undefined && (
          <div className="mention-suggestions" role="listbox" aria-label="文件和目录建议">
            <div className="mention-suggestions-head"><AtSign size={13} />选择要交给 Agent 只读查看的路径</div>
            {suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.type}-${suggestion.path}`}
                type="button"
                className={suggestionIndex === index ? 'active' : ''}
                onMouseDown={event => { event.preventDefault(); chooseSuggestion(suggestion) }}
              >
                <span>{suggestion.type === 'file' ? <File size={15} /> : suggestion.type === 'drive' ? <HardDrive size={15} /> : <Folder size={15} />}</span>
                <div><b>{suggestion.name}</b><small>{suggestion.path}</small></div>
              </button>
            ))}
          </div>
        )}
        {references.length > 0 && (
          <div className="reference-chips">
            {references.map(reference => <span key={reference.path}>{reference.type === 'file' ? <File size={12} /> : <Folder size={12} />}<b title={reference.path}>{reference.path}</b><button type="button" aria-label={`移除 ${reference.path}`} onClick={() => { setReferences(current => current.filter(item => item.path !== reference.path)); setDraft(current => current.replaceAll(`@[${reference.path}]`, '').replace(/ {2,}/g, ' ')) }}><X size={11} /></button></span>)}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          rows={2}
          disabled={props.busy}
          placeholder={props.busy ? 'Agent 正在执行任务…' : '询问扫描结果，或输入电脑管理问题…'}
          onChange={event => { updateDraft(event.target.value, event.target.selectionStart) }}
          onClick={event => { setMention(mentionContextAt(draft, event.currentTarget.selectionStart)) }}
          onKeyUp={event => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) setMention(mentionContextAt(draft, event.currentTarget.selectionStart)) }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-actions">
          <div className="composer-selects">
            <label><Sparkles size={14} /><select value={props.settings.activePresetId} disabled={props.busy} onChange={event => { void props.onQuickSetting(settingsInput(props.settings, { activePresetId: event.target.value })) }}>{props.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select><ChevronDown size={13} /></label>
            <label><Activity size={14} /><select value={props.settings.model} disabled={props.busy} onChange={event => { void props.onQuickSetting(settingsInput(props.settings, { model: event.target.value })) }}>{models.map(model => <option key={model} value={model}>{model}</option>)}</select><ChevronDown size={13} /></label>
            <label className="reasoning-select"><BrainCircuit size={14} /><select aria-label="思考等级" value={props.settings.reasoningEffort} disabled={props.busy} onChange={event => { void props.onQuickSetting(settingsInput(props.settings, { reasoningEffort: event.target.value as AppSettings['reasoningEffort'] })) }}>{(['off', 'low', 'high', 'max'] as const).map(effort => <option key={effort} value={effort}>{REASONING_LABELS[effort]}</option>)}</select><ChevronDown size={13} /></label>
          </div>
          <span className="send-hint"><AtSign size={11} />引用文件/目录 · Enter 发送</span>
          <button type="button" className="send-button" disabled={props.busy || draft.trim().length === 0} onClick={() => { void submit() }}><Send size={17} /></button>
        </div>
      </div>
    </section>
  )
}

function CleanupConfirmation(props: { risks: RiskItem[]; onCancel(): void; onConfirm(): void }): ReactNode {
  const [confirmed, setConfirmed] = useState(false)
  const critical = props.risks.filter(risk => risk.severity === 'critical' || risk.severity === 'high').length
  const totalBytes = props.risks.reduce((total, risk) => total + (risk.sizeBytes ?? 0), 0)
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) props.onCancel() }}>
      <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="cleanup-confirm-title">
        <button type="button" className="modal-close" onClick={props.onCancel}><X size={18} /></button>
        <span className="confirm-icon"><Sparkles size={24} /></span>
        <h2 id="cleanup-confirm-title">交给 Agent 二次研判并清理？</h2>
        <p>系统会先启动独立的只读审核 Agent。只有审核放行的项目，才会进入拥有写入能力的清理 Agent 会话，并优先隔离而非直接删除。</p>
        <div className="confirm-stats">
          <div><strong>{props.risks.length}</strong><span>授权项目</span></div>
          <div><strong>{critical}</strong><span>高风险项目</span></div>
          <div><strong>{totalBytes > 0 ? formatBytes(totalBytes) : '—'}</strong><span>涉及空间</span></div>
        </div>
        <div className="authorization-scope">
          <LockKeyhole size={17} />
          <div><b>双 Agent 审核门已启用</b><span>审核 Agent 可拒绝或转人工；执行 Agent 只能处理审核放行且由你勾选的目标。</span></div>
        </div>
        <label className="confirm-check">
          <input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked) }} />
          <span><Check size={13} /></span>
          我已核对所选项目，并同意 Agent 执行必要的命令行操作
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={props.onCancel}>返回检查</button>
          <button type="button" className="primary-button" disabled={!confirmed} onClick={props.onConfirm}><Sparkles size={16} />确认并开始</button>
        </div>
      </div>
    </div>
  )
}

function ElevationDialog(props: { kind: ScanKind; onCancel(): void; onLimited(): void; onElevate(): Promise<void> }): ReactNode {
  const [requesting, setRequesting] = useState(false)
  return (
    <div className="modal-backdrop">
      <div className="confirm-modal elevation-modal" role="dialog" aria-modal="true" aria-label="管理员权限确认">
        <button type="button" className="modal-close" aria-label="关闭" onClick={props.onCancel}><X size={18} /></button>
        <span className="confirm-icon"><ShieldCheck size={24} /></span>
        <h2>建议授予管理员权限</h2>
        <p>{props.kind === 'virus' ? '完整病毒扫描需要读取系统进程、服务、计划任务、防火墙和 Defender 配置。' : '扫描系统盘时，部分系统目录只有管理员权限才能读取。'} 未授权仍可继续，但历史记录会明确标注访问盲区。</p>
        <div className="elevation-note"><LockKeyhole size={17} /><span><b>由 Windows 官方 UAC 确认</b><small>应用会以管理员身份重新启动；只有你在系统窗口中选择“是”才会授权。</small></span></div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={requesting} onClick={props.onLimited}>继续受限扫描</button>
          <button type="button" className="primary-button" disabled={requesting} onClick={() => { setRequesting(true); void props.onElevate().finally(() => { setRequesting(false) }) }}>{requesting ? <span className="mini-spinner" /> : <ShieldCheck size={16} />}{requesting ? '等待 UAC 确认…' : '以管理员身份重启'}</button>
        </div>
      </div>
    </div>
  )
}

function ScanScopeDialog(props: {
  volumes: DiskVolume[]
  selected: ScanTarget[]
  onCancel(): void
  onSave(targets: ScanTarget[]): void
  onToast(tone: ToastState['tone'], message: string): void
}): ReactNode {
  const [targets, setTargets] = useState<ScanTarget[]>(() => structuredClone(props.selected))
  const selectedPaths = new Set(targets.map(target => target.path.toLocaleLowerCase()))
  const toggleDrive = (volume: DiskVolume): void => {
    const key = volume.root.toLocaleLowerCase()
    setTargets(current => selectedPaths.has(key)
      ? current.filter(target => target.path.toLocaleLowerCase() !== key)
      : [...current, { type: 'drive', path: volume.root, label: volume.name.trim().length > 0 ? `${volume.name} (${volume.root})` : volume.root }])
  }
  const chooseDirectory = async (): Promise<void> => {
    try {
      const chosen = await window.pcManager.chooseDirectory()
      if (chosen === undefined) return
      setTargets(current => current.some(target => target.path.toLocaleLowerCase() === chosen.path.toLocaleLowerCase()) ? current : [...current, chosen])
    } catch (error) {
      props.onToast('error', error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) props.onCancel() }}>
      <div className="scope-modal" role="dialog" aria-modal="true" aria-labelledby="scope-title">
        <button type="button" className="modal-close" onClick={props.onCancel}><X size={18} /></button>
        <span className="scope-icon"><HardDrive size={23} /></span>
        <h2 id="scope-title">选择扫描范围</h2>
        <p>Agent 只会递归检查你选择的磁盘或目录。病毒扫描的进程、防火墙和启动项仍属于全局运行态检查。</p>
        {props.volumes.length > 0 && (
          <div className="scope-group">
            <b>本机磁盘</b>
            <div className="drive-options">
              {props.volumes.map(volume => {
                const checked = selectedPaths.has(volume.root.toLocaleLowerCase())
                const used = volume.totalBytes <= 0 ? 0 : Math.round((volume.totalBytes - volume.freeBytes) / volume.totalBytes * 100)
                return (
                  <button key={volume.root} type="button" className={checked ? 'selected' : ''} onClick={() => { toggleDrive(volume) }}>
                    <span className="drive-check">{checked && <Check size={13} />}</span>
                    <HardDrive size={18} />
                    <div><strong>{volume.name.trim().length > 0 ? volume.name : '本地磁盘'} <em>{volume.root}</em></strong><span>{formatBytes(volume.freeBytes)} 可用 · 已使用 {used}%</span><i><u style={{ width: `${used}%` }} /></i></div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        <div className="scope-group">
          <div className="scope-group-head"><b>自定义目录</b><button type="button" onClick={() => { void chooseDirectory() }}><Plus size={14} />添加目录</button></div>
          <div className="directory-options">
            {targets.filter(target => target.type === 'directory').length === 0
              ? <span className="scope-empty">还没有添加自定义目录</span>
              : targets.filter(target => target.type === 'directory').map(target => (
                  <div key={target.path}><FolderOpen size={16} /><span title={target.path}>{target.path}</span><button type="button" onClick={() => { setTargets(current => current.filter(item => item.path !== target.path)) }}><X size={14} /></button></div>
                ))}
          </div>
        </div>
        <div className="scope-safety"><LockKeyhole size={16} /><span><b>只读边界</b>DSH 沙箱会禁止扫描 Agent 对所选范围和系统进行任何修改。</span></div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={props.onCancel}>取消</button><button type="button" className="primary-button" disabled={targets.length === 0} onClick={() => { props.onSave(targets) }}>使用 {targets.length} 个范围</button></div>
      </div>
    </div>
  )
}

function CleanupReportDialog(props: { report: CleanupReport; risks: RiskItem[]; quarantinePath: string; onClose(): void }): ReactNode {
  const riskMap = new Map(props.risks.map(risk => [risk.id, risk]))
  const success = props.report.results.filter(result => result.status === 'cleaned' || result.status === 'quarantined').length
  return (
    <div className="modal-backdrop">
      <div className="report-modal" role="dialog" aria-modal="true">
        <button type="button" className="modal-close" onClick={props.onClose}><X size={18} /></button>
        <span className="report-icon"><CheckCircle2 size={25} /></span>
        <h2>Agent 清理报告</h2>
        <p>{props.report.summary}</p>
        <div className="report-overview"><b>{success}</b> 项已处理 · <b>{props.report.results.length - success}</b> 项跳过或失败 {props.report.rebootRecommended && <span>· 建议重启电脑</span>}</div>
        <div className="report-list">
          {props.report.results.map(result => (
            <div key={result.id} className={`report-item ${result.status}`}>
              <span>{result.status === 'cleaned' || result.status === 'quarantined' ? <Check size={15} /> : result.status === 'skipped' ? <Minus size={15} /> : <AlertTriangle size={15} />}</span>
              <div><b>{riskMap.get(result.id)?.name ?? result.id}</b><p>{result.action} · {result.detail}</p></div>
              <em>{result.status === 'quarantined' ? '已隔离' : result.status === 'cleaned' ? '已清理' : result.status === 'skipped' ? '已跳过' : '失败'}</em>
            </div>
          ))}
        </div>
        {props.report.followup.length > 0 && <div className="followup-box"><b>后续建议</b>{props.report.followup.map((item, index) => <p key={index}>• {item}</p>)}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={() => { void window.pcManager.openPath(props.quarantinePath) }}><FolderOpen size={15} />打开隔离区</button>
          <button type="button" className="primary-button" onClick={props.onClose}>完成</button>
        </div>
      </div>
    </div>
  )
}

function HistoryPanel(props: { open: boolean; entries: OperationHistoryEntry[]; loading: boolean; onClose(): void; onRefresh(): void }): ReactNode {
  if (!props.open) return null
  const statusLabel: Record<OperationHistoryEntry['status'], string> = {
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已停止',
  }
  return (
    <div className="settings-backdrop history-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) props.onClose() }}>
      <aside className="history-panel" aria-label="操作历史">
        <header>
          <div><History size={20} /><div><h2>操作历史</h2><span>扫描、审核与清理结果保存在本机</span></div></div>
          <div><button type="button" title="刷新" onClick={props.onRefresh}><RotateCcw size={16} /></button><button type="button" title="关闭" onClick={props.onClose}><X size={19} /></button></div>
        </header>
        <div className="history-content">
          {props.loading ? (
            <div className="history-empty"><span className="mini-spinner" /><p>正在读取历史记录…</p></div>
          ) : props.entries.length === 0 ? (
            <div className="history-empty"><History size={30} /><h3>还没有操作记录</h3><p>完成一次扫描、对话或清理后会显示在这里。</p></div>
          ) : props.entries.map(entry => {
            const riskById = new Map(entry.risks.map(risk => [risk.id, risk]))
            const instructionById = new Map(entry.cleanupInstructions?.map(instruction => [instruction.riskId, instruction]) ?? [])
            const auditById = new Map(entry.auditReport?.decisions.map(decision => [decision.id, decision]) ?? [])
            const resultById = new Map(entry.cleanupReport?.results.map(result => [result.id, result]) ?? [])
            const handled = entry.cleanupReport?.results.filter(result => result.status === 'cleaned' || result.status === 'quarantined') ?? []
            return (
              <details key={entry.id} className={`history-entry ${entry.status}`}>
                <summary>
                  <span className="history-kind">{entry.kind === 'disk' ? <HardDrive size={17} /> : entry.kind === 'virus' ? <ShieldCheck size={17} /> : entry.kind === 'cleanup' ? <Sparkles size={17} /> : <Bot size={17} />}</span>
                  <div><b>{entry.title}</b><span>{formatDateTime(entry.startedAt)}{entry.finishedAt === undefined ? '' : ` · ${Math.max(1, Math.round((entry.finishedAt - entry.startedAt) / 1000))} 秒`}</span></div>
                  <div className="history-summary-metrics"><span className={`history-status ${entry.status}`}>{statusLabel[entry.status]}</span><strong>{formatTokens(entry.tokenUsage.totalTokens)} Token</strong><ChevronDown size={15} /></div>
                </summary>
                <div className="history-details">
                  <p>{entry.summary}</p>
                  <div className="history-facts">
                    <span><b>模型 / 思考</b>{entry.model} · {entry.reasoningEffort === undefined ? '旧记录未记录' : REASONING_LABELS[entry.reasoningEffort]}</span>
                    <span><b>本次 Token</b>{entry.tokenUsage.totalTokens.toLocaleString('zh-CN')}（输入 {entry.tokenUsage.inputTokens.toLocaleString('zh-CN')} / 输出 {entry.tokenUsage.outputTokens.toLocaleString('zh-CN')} / 推理 {entry.tokenUsage.reasoningTokens.toLocaleString('zh-CN')}）</span>
                    {entry.targets.length > 0 && <span><b>扫描范围</b>{entry.targets.map(target => target.path).join('；')}</span>}
                    {entry.risks.length > 0 && <span><b>风险项</b>{entry.risks.length} 项</span>}
                  </div>
                  {entry.plan !== undefined && <div className="history-plan"><b>执行计划</b><ol>{entry.plan.steps.map(step => <li key={step.id}>{step.title}</li>)}</ol></div>}
                  {entry.risks.length > 0 && (
                    <div className="history-risk-list">
                      <b>{entry.kind === 'cleanup' ? '项目与处理方式' : '扫描发现明细'} · {entry.risks.length} 项</b>
                      {entry.risks.map(risk => {
                        const instruction = instructionById.get(risk.id)
                        const audit = auditById.get(risk.id)
                        const result = resultById.get(risk.id)
                        return <details key={risk.id} className={`history-risk severity-${risk.severity}`}><summary><span className={`severity-badge ${risk.severity}`}>{SEVERITY_LABELS[risk.severity]}</span><strong>{risk.name}</strong><em>{instruction === undefined ? risk.recommendedAction : instruction.mode === 'ignore' ? '用户选择：忽略' : instruction.mode === 'quarantine' ? '用户选择：隔离' : instruction.mode === 'manual' ? '用户选择：手动方案' : '用户选择：AI 建议'}</em><ChevronDown size={13} /></summary><div><p><b>目标</b><code>{risk.target}</code></p><p><b>判断理由</b><span>{risk.reason}</span></p><p><b>AI 建议</b><span>{risk.recommendedAction}</span></p>{risk.evidence.length > 0 && <p><b>证据</b><span>{risk.evidence.join('；')}</span></p>}{instruction?.mode === 'manual' && <p><b>手动方案</b><span>{instruction.instruction}</span></p>}{audit !== undefined && <p><b>审核结果</b><span>{audit.verdict === 'allow' ? '放行' : audit.verdict === 'deny' ? '拒绝' : '需人工确认'} · {audit.reason}</span></p>}{result !== undefined && <p><b>实际处理</b><span>{result.action} · {result.detail}</span></p>}</div></details>
                      })}
                    </div>
                  )}
                  {entry.cleanupReport !== undefined && (
                    <div className="history-cleanup-results">
                      <b>清理明细 · 成功处理 {handled.length} 项</b>
                      {entry.cleanupReport.results.map(result => <div key={result.id} className={result.status}><span>{result.status === 'cleaned' ? '已清理' : result.status === 'quarantined' ? '已隔离' : result.status === 'skipped' ? '已跳过' : '失败'}</span><div><strong>{riskById.get(result.id)?.name ?? result.id}</strong><small>{result.action} · {result.detail}</small></div></div>)}
                    </div>
                  )}
                </div>
              </details>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

interface SettingsPanelProps {
  open: boolean
  initialTab: SettingsTab
  settings: AppSettings
  presets: AgentPreset[]
  quarantinePath: string
  version: string
  onClose(): void
  onSaved(settings: AppSettings): void
  onToast(tone: ToastState['tone'], message: string): void
}

function SettingsPanel(props: SettingsPanelProps): ReactNode {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab)
  const [draft, setDraft] = useState<SaveSettingsInput>(() => settingsInput(props.settings, { apiKey: '' }))
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved')
  const [testing, setTesting] = useState(false)
  const [editingPreset, setEditingPreset] = useState<AgentPreset | undefined>()
  const initializedRef = useRef(false)
  const previousOpenRef = useRef(false)
  const lastSavedRef = useRef('')
  const saveVersionRef = useRef(0)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    if (props.open && !previousOpenRef.current) {
      const next = settingsInput(props.settings, { apiKey: '' })
      initializedRef.current = false
      lastSavedRef.current = JSON.stringify(next)
      setTab(props.initialTab)
      setDraft(next)
      setSaveState('saved')
      setEditingPreset(undefined)
      queueMicrotask(() => { initializedRef.current = true })
    }
    if (!props.open) initializedRef.current = false
    previousOpenRef.current = props.open
  }, [props.open, props.initialTab, props.settings])

  const persistDraft = async (input: SaveSettingsInput, signature: string): Promise<boolean> => {
    const version = ++saveVersionRef.current
    setSaveState('saving')
    try {
      const saved = await window.pcManager.saveSettings(input)
      if (version === saveVersionRef.current) {
        if (JSON.stringify(draftRef.current) === signature) {
          const normalized = settingsInput(saved, { apiKey: '' })
          lastSavedRef.current = JSON.stringify(normalized)
          setDraft(normalized)
        } else {
          lastSavedRef.current = signature
        }
        setSaveState('saved')
        props.onSaved(saved)
      }
      return true
    } catch (error) {
      if (version === saveVersionRef.current) setSaveState('error')
      props.onToast('error', `自动保存失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  useEffect(() => {
    if (!props.open || !initializedRef.current) return
    const signature = JSON.stringify(draft)
    if (signature === lastSavedRef.current) return
    setSaveState('pending')
    const timer = window.setTimeout(() => { void persistDraft(draft, signature) }, 450)
    return () => { window.clearTimeout(timer) }
  }, [draft, props.open])

  if (!props.open) return null

  const allPresets = [...props.presets.filter(preset => preset.builtIn), ...draft.customPresets]
  const closePanel = async (): Promise<void> => {
    const current = draftRef.current
    const signature = JSON.stringify(current)
    if (signature !== lastSavedRef.current && !await persistDraft(current, signature)) return
    props.onClose()
  }
  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      const response = await window.pcManager.testConnection({
        provider: draft.provider,
        model: draft.model,
        baseUrl: draft.baseUrl,
        ...(draft.apiKey === undefined ? {} : { apiKey: draft.apiKey }),
      })
      props.onToast('success', response)
    } catch (error) {
      props.onToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }
  const saveCustomPreset = (): void => {
    if (editingPreset === undefined || editingPreset.name.trim().length === 0 || editingPreset.prompt.trim().length === 0) return
    const next = { ...editingPreset, name: editingPreset.name.trim(), prompt: editingPreset.prompt.trim(), builtIn: false }
    const exists = draft.customPresets.some(preset => preset.id === next.id)
    setDraft(current => ({
      ...current,
      customPresets: exists ? current.customPresets.map(preset => preset.id === next.id ? next : preset) : [...current.customPresets, next],
      activePresetId: next.id,
    }))
    setEditingPreset(undefined)
  }

  const navItems: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
    { id: 'general', label: '通用', icon: SlidersHorizontal },
    { id: 'model', label: '模型服务', icon: Activity },
    { id: 'agent', label: 'Agent 预设', icon: Sparkles },
    { id: 'security', label: '隔离与隐私', icon: ShieldCheck },
    { id: 'about', label: '关于', icon: Info },
  ]

  return (
    <div className="settings-backdrop">
      <aside className="settings-panel" aria-label="设置">
        <header><div><Settings2 size={20} /><h2>设置</h2></div><button type="button" onClick={() => { void closePanel() }}><X size={19} /></button></header>
        <div className="settings-layout">
          <nav>
            {navItems.map(item => {
              const Icon = item.icon
              return <button key={item.id} type="button" className={tab === item.id ? 'active' : ''} onClick={() => { setTab(item.id) }}><Icon size={17} />{item.label}<ChevronRight size={14} /></button>
            })}
          </nav>
          <div className="settings-content">
            {tab === 'general' && (
              <SettingsPage title="通用" description="调整外观与默认扫描行为。">
                <SettingRow title="外观" description="跟随系统或固定使用明暗主题。">
                  <div className="segmented">
                    {(['system', 'light', 'dark'] as const).map(value => <button key={value} type="button" className={draft.theme === value ? 'active' : ''} onClick={() => { setDraft(current => ({ ...current, theme: value })); applyTheme(value) }}>{value === 'system' ? '跟随系统' : value === 'light' ? '浅色' : '深色'}</button>)}
                  </div>
                </SettingRow>
                <SettingRow title="界面缩放" description="100% 已按原 125% 显示尺寸校准；可在此基础上继续缩放。">
                  <label className="scale-control"><input type="range" min={75} max={125} step={5} value={Math.round(draft.fontScale * 100)} onChange={event => { setDraft(current => ({ ...current, fontScale: Number(event.target.value) / 100 })) }} /><output>{Math.round(draft.fontScale * 100)}%</output></label>
                </SettingRow>
                <SettingRow title="扫描深度" description="深度扫描覆盖更多目录，耗时与 Token 使用也会增加。">
                  <div className="segmented"><button type="button" className={draft.scanDepth === 'standard' ? 'active' : ''} onClick={() => { setDraft(current => ({ ...current, scanDepth: 'standard' })) }}>标准</button><button type="button" className={draft.scanDepth === 'deep' ? 'active' : ''} onClick={() => { setDraft(current => ({ ...current, scanDepth: 'deep' })) }}>深度</button></div>
                </SettingRow>
                <SettingRow title="扫描网络磁盘" description="默认只检查本机固定磁盘，避免访问 NAS 或企业共享。">
                  <Switch checked={draft.includeNetworkDrives} onChange={checked => { setDraft(current => ({ ...current, includeNetworkDrives: checked })) }} />
                </SettingRow>
                <SettingRow title="匿名遥测" description="默认关闭。开启后由 DSH 按其策略记录匿名运行遥测，不包含 API Key。">
                  <Switch checked={draft.telemetryEnabled} onChange={checked => { setDraft(current => ({ ...current, telemetryEnabled: checked })) }} />
                </SettingRow>
                <SettingRow title="桌面快捷入口" description="安装程序会默认创建；也可以在这里重新生成，一键启动电脑管家。">
                  <button type="button" className="secondary-button" onClick={() => { void window.pcManager.createDesktopShortcut().then(path => { props.onToast('success', `快捷方式已创建：${path}`) }).catch(error => { props.onToast('error', error instanceof Error ? error.message : String(error)) }) }}><Plus size={15} />创建快捷方式</button>
                </SettingRow>
              </SettingsPage>
            )}
            {tab === 'model' && (
              <SettingsPage title="模型服务" description="设置会自动保存；连接测试直接请求模型接口，最长等待 12 秒。">
                <div className="provider-card">
                  <div className="provider-head"><span className="provider-logo"><img src="./whale.svg" alt="DeepSeek" /></span><div><b>DeepSeek</b><span>{props.settings.apiKeyConfigured ? '凭据已配置' : '需要 API Key'}</span></div><i className={props.settings.apiKeyConfigured ? 'ready' : ''} /></div>
                  <label className="form-field"><span>Provider route</span><input value={draft.provider} onChange={event => { setDraft(current => ({ ...current, provider: event.target.value })) }} /></label>
                  <label className="form-field"><span>Base URL</span><input value={draft.baseUrl} onChange={event => { setDraft(current => ({ ...current, baseUrl: event.target.value })) }} /></label>
                  <label className="form-field"><span>模型 ID</span><input value={draft.model} onChange={event => { setDraft(current => ({ ...current, model: event.target.value })) }} /></label>
                  <div className="reasoning-setting">
                    <div><BrainCircuit size={18} /><span><b>模型思考等级</b><small>会真实传入 DSH 的 reasoningEffort，扫描、审核与清理均按此等级运行。</small></span></div>
                    <div className="reasoning-levels">{(['off', 'low', 'high', 'max'] as const).map(effort => <button key={effort} type="button" className={draft.reasoningEffort === effort ? 'active' : ''} onClick={() => { setDraft(current => ({ ...current, reasoningEffort: effort })) }}>{REASONING_LABELS[effort]}</button>)}</div>
                  </div>
                  <label className="form-field"><span>API Key</span><div className="secret-input"><KeyRound size={15} /><input type="password" value={draft.apiKey ?? ''} placeholder={props.settings.apiKeyConfigured ? '已安全保存；留空则不修改' : 'sk-…'} onChange={event => { setDraft(current => ({ ...current, apiKey: event.target.value, clearApiKey: false })) }} /></div></label>
                  {props.settings.apiKeyConfigured && <label className="clear-key"><input type="checkbox" checked={draft.clearApiKey === true} onChange={event => { setDraft(current => ({ ...current, clearApiKey: event.target.checked, apiKey: '' })) }} />自动保存后删除现有 API Key</label>}
                  <button type="button" className="secondary-button test-button" disabled={testing} onClick={() => { void test() }}>{testing ? <span className="mini-spinner" /> : <Activity size={15} />}{testing ? '正在测试（最多 12 秒）…' : '测试模型连接'}</button>
                </div>
              </SettingsPage>
            )}
            {tab === 'agent' && (
              <SettingsPage title="Agent 预设" description="预设只影响分析策略，扫描阶段的只读权限无法被预设覆盖。">
                <div className="preset-list">
                  {allPresets.map(preset => (
                    <div key={preset.id} className={`preset-card ${draft.activePresetId === preset.id ? 'active' : ''}`} onClick={() => { setDraft(current => ({ ...current, activePresetId: preset.id })) }}>
                      <span className="preset-radio"><i /></span>
                      <div><b>{preset.name}</b><p>{preset.description}</p><small>{preset.builtIn ? '内置安全预设' : '自定义预设'}</small></div>
                      {!preset.builtIn && <div className="preset-actions"><button type="button" title="编辑" onClick={event => { event.stopPropagation(); setEditingPreset({ ...preset }) }}><Pencil size={14} /></button><button type="button" title="删除" onClick={event => { event.stopPropagation(); setDraft(current => ({ ...current, customPresets: current.customPresets.filter(item => item.id !== preset.id), activePresetId: current.activePresetId === preset.id ? 'balanced-cleaner' : current.activePresetId })) }}><Trash2 size={14} /></button></div>}
                    </div>
                  ))}
                </div>
                {editingPreset === undefined ? (
                  <button type="button" className="add-preset" onClick={() => { setEditingPreset({ id: `custom-${Date.now()}`, name: '', description: '', prompt: '', builtIn: false }) }}><Plus size={16} />新建自定义预设</button>
                ) : (
                  <div className="preset-editor">
                    <div className="preset-editor-head"><b>{draft.customPresets.some(item => item.id === editingPreset.id) ? '编辑自定义预设' : '新建自定义预设'}</b><button type="button" onClick={() => { setEditingPreset(undefined) }}><X size={16} /></button></div>
                    <label className="form-field"><span>名称</span><input value={editingPreset.name} onChange={event => { setEditingPreset(current => current === undefined ? current : { ...current, name: event.target.value }) }} /></label>
                    <label className="form-field"><span>说明</span><input value={editingPreset.description} onChange={event => { setEditingPreset(current => current === undefined ? current : { ...current, description: event.target.value }) }} /></label>
                    <label className="form-field"><span>提示词补充</span><textarea rows={7} value={editingPreset.prompt} onChange={event => { setEditingPreset(current => current === undefined ? current : { ...current, prompt: event.target.value }) }} placeholder="描述扫描关注点、风险偏好与判断标准…" /></label>
                    <button type="button" className="primary-button" disabled={editingPreset.name.trim().length === 0 || editingPreset.prompt.trim().length === 0} onClick={saveCustomPreset}>保存预设</button>
                  </div>
                )}
              </SettingsPage>
            )}
            {tab === 'security' && (
              <SettingsPage title="隔离与隐私" description="扫描内容只在本机 DSH 会话中处理。">
                <SettingRow title="隔离区" description={props.quarantinePath}><button type="button" className="secondary-button" onClick={() => { void window.pcManager.openPath(props.quarantinePath) }}><FolderOpen size={15} />打开</button></SettingRow>
                <SettingRow title="隔离保留期" description="到期项目不会自动清空；保留期用于提醒你复核。"><label className="number-field"><input type="number" min={1} max={365} value={draft.quarantineRetentionDays} onChange={event => { setDraft(current => ({ ...current, quarantineRetentionDays: Math.max(1, Math.min(365, Number(event.target.value) || 1)) })) }} />天</label></SettingRow>
                <div className="privacy-note"><LockKeyhole size={18} /><div><b>双层安全边界</b><p>扫描会话由 DSH read-only 沙箱硬性禁止写入；只有你勾选项目并确认后，才会为一次独立清理会话开放写权限。</p></div></div>
              </SettingsPage>
            )}
            {tab === 'about' && (
              <SettingsPage title="关于" description="基于 DeepSeek Harness 构建的独立桌面电脑管家。">
                <div className="about-card"><img src="./whale.svg" alt="黑色鲸鱼标志" /><h3>DSH PC Manager</h3><span>Version {props.version}</span><p>一个以 Agent 二次判断为核心的 Windows 清理与安全检查工具。DeepSeek Harness 是底层智能体运行框架；本项目并非 DeepSeek 官方产品。</p></div>
              </SettingsPage>
            )}
          </div>
        </div>
        <footer><span className={`autosave-status ${saveState}`}>{saveState === 'saved' ? <CheckCircle2 size={13} /> : saveState === 'error' ? <AlertTriangle size={13} /> : <span className="mini-spinner" />}{saveState === 'saved' ? '所有更改已自动保存' : saveState === 'pending' ? '等待自动保存…' : saveState === 'saving' ? '正在自动保存…' : '自动保存失败'}</span><div><button type="button" className="primary-button" disabled={saveState === 'saving'} onClick={() => { void closePanel() }}>关闭</button></div></footer>
      </aside>
    </div>
  )
}

function SettingsPage(props: { title: string; description: string; children: ReactNode }): ReactNode {
  return <div className="settings-page"><div className="settings-page-head"><h3>{props.title}</h3><p>{props.description}</p></div>{props.children}</div>
}

function SettingRow(props: { title: string; description: string; children: ReactNode }): ReactNode {
  return <div className="setting-row"><div><b>{props.title}</b><p>{props.description}</p></div>{props.children}</div>
}

function Switch(props: { checked: boolean; onChange(checked: boolean): void }): ReactNode {
  return <button type="button" role="switch" aria-checked={props.checked} className={`switch ${props.checked ? 'on' : ''}`} onClick={() => { props.onChange(!props.checked) }}><span /></button>
}

function Toast(props: { toast: ToastState; onClose(): void }): ReactNode {
  return <div className={`toast ${props.toast.tone}`}>{props.toast.tone === 'success' ? <CheckCircle2 size={17} /> : props.toast.tone === 'error' ? <AlertTriangle size={17} /> : <Info size={17} />}<span>{props.toast.message}</span><button type="button" onClick={props.onClose}><X size={14} /></button></div>
}

function LoadingScreen(props: { error?: string }): ReactNode {
  return <div className="loading-screen"><img src="./whale.svg" alt="" /><div className="loading-pulse" /><h1>DSH PC Manager</h1><p>{props.error ?? '正在连接本机安全服务…'}</p>{props.error !== undefined && <button type="button" className="primary-button" onClick={() => { window.location.reload() }}><RotateCcw size={15} />重新加载</button>}</div>
}

export function App(): ReactNode {
  const [bootstrap, setBootstrap] = useState<BootstrapData | undefined>()
  const [bootstrapError, setBootstrapError] = useState<string | undefined>()
  const [settings, setSettings] = useState<AppSettings | undefined>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [operation, setOperation] = useState<UiOperation | undefined>()
  const [operationUsage, setOperationUsage] = useState<TokenUsage>({ ...EMPTY_TOKEN_USAGE })
  const [lifetimeUsage, setLifetimeUsage] = useState<TokenUsage>({ ...EMPTY_TOKEN_USAGE })
  const [risks, setRisks] = useState<RiskItem[]>([])
  const [riskScanKind, setRiskScanKind] = useState<ScanKind>('disk')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [riskResolutions, setRiskResolutions] = useState<Record<string, RiskResolution>>({})
  const [activities, setActivities] = useState<ToolActivity[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [confirmCleanup, setConfirmCleanup] = useState(false)
  const [cleanupReport, setCleanupReport] = useState<CleanupReport | undefined>()
  const [cleanupReportRisks, setCleanupReportRisks] = useState<RiskItem[]>([])
  const [auditReport, setAuditReport] = useState<CleanupAuditReport | undefined>()
  const [reportOpen, setReportOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [pendingElevatedScan, setPendingElevatedScan] = useState<ScanKind | undefined>()
  const [scanTargets, setScanTargets] = useState<ScanTarget[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyEntries, setHistoryEntries] = useState<OperationHistoryEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [toast, setToast] = useState<ToastState | undefined>()
  const cleanupInputRisksRef = useRef<RiskItem[]>([])

  const notify = useCallback((tone: ToastState['tone'], message: string): void => {
    setToast({ id: Date.now(), tone, message })
  }, [])

  const refreshHistory = useCallback((): void => {
    setHistoryLoading(true)
    void window.pcManager.listHistory().then(entries => {
      setHistoryEntries(entries)
    }).catch(error => {
      notify('error', error instanceof Error ? error.message : String(error))
    }).finally(() => { setHistoryLoading(false) })
  }, [notify])

  useEffect(() => {
    if (toast === undefined) return
    const timer = window.setTimeout(() => { setToast(undefined) }, 5000)
    return () => { window.clearTimeout(timer) }
  }, [toast])

  useEffect(() => {
    const dispose = window.pcManager.onOperationEvent((event: OperationEvent) => {
      switch (event.type) {
        case 'started':
          setOperation({ id: event.operationId, kind: event.kind, title: event.title, state: 'running', stage: '正在启动 Agent', message: '准备 DeepSeek Harness 会话与权限策略。', progress: 2, startedAt: event.startedAt, completedPlanStepIds: [] })
          setOperationUsage({ ...EMPTY_TOKEN_USAGE })
          setActivities([])
          if (event.kind === 'disk' || event.kind === 'virus') {
            setRisks([])
            setSelectedIds(new Set())
            setRiskResolutions({})
            setCleanupReport(undefined)
            setCleanupReportRisks([])
            setRiskScanKind(event.kind)
          }
          break
        case 'plan':
          setOperation(current => current?.id === event.operationId ? { ...current, plan: event.plan, completedPlanStepIds: [] } : current)
          break
        case 'progress':
          setOperation(current => {
            if (current?.id !== event.operationId) return current
            return {
              ...current,
              stage: event.stage,
              message: event.message,
              progress: event.progress ?? current.progress,
              state: event.stage === '正在停止' ? 'cancelling' : current.state,
              ...(event.planStepId === undefined ? {} : { activePlanStepId: event.planStepId }),
              ...(event.completedPlanStepIds === undefined ? {} : { completedPlanStepIds: event.completedPlanStepIds }),
            }
          })
          break
        case 'tool':
          setActivities(current => [...current.slice(-11), { id: `${event.operationId}-${event.time}-${current.length}`, label: event.label, detail: event.detail, time: event.time }])
          break
        case 'tokens':
          setOperationUsage(event.operationUsage)
          setLifetimeUsage(event.lifetimeUsage)
          break
        case 'risks':
          setRisks(event.risks)
          setRiskScanKind(event.scanKind)
          setSelectedIds(new Set(event.risks.filter(risk => risk.selectedByDefault).map(risk => risk.id)))
          setRiskResolutions(Object.fromEntries(event.risks.map(risk => [risk.id, { mode: 'recommended', instruction: '' } satisfies RiskResolution])))
          break
        case 'assistant-message':
          setMessages(current => [...current, { id: `${event.operationId}-${Date.now()}`, role: 'assistant', content: event.content, time: Date.now() }])
          break
        case 'audit-report': {
          setAuditReport(event.report)
          const allowed = event.report.decisions.filter(decision => decision.verdict === 'allow').length
          setMessages(current => [...current, { id: `${event.operationId}-audit`, role: 'system', content: `独立审核 Agent：${event.report.summary}（放行 ${allowed}/${event.report.decisions.length} 项）`, time: Date.now() }])
          break
        }
        case 'cleanup-report': {
          const handledIds = new Set(event.report.results.filter(result => result.status === 'cleaned' || result.status === 'quarantined').map(result => result.id))
          setCleanupReport(event.report)
          setCleanupReportRisks(structuredClone(cleanupInputRisksRef.current))
          setRisks(current => current.filter(risk => !handledIds.has(risk.id)))
          setSelectedIds(current => new Set([...current].filter(id => !handledIds.has(id))))
          setRiskResolutions(current => Object.fromEntries(Object.entries(current).filter(([id]) => !handledIds.has(id))))
          setReportOpen(true)
          break
        }
        case 'completed':
          setOperation(current => current?.id === event.operationId ? { ...current, state: 'completed', stage: '任务已完成', message: event.summary, progress: 100, completedPlanStepIds: current.plan?.steps.map(step => step.id) ?? current.completedPlanStepIds } : current)
          setOperationUsage(event.operationUsage)
          notify('success', event.summary)
          refreshHistory()
          break
        case 'failed':
          setOperation(current => current?.id === event.operationId ? { ...current, state: 'failed', stage: '任务未完成', message: event.message, progress: Math.max(current.progress, 8) } : current)
          setOperationUsage(event.operationUsage)
          setMessages(current => [...current, { id: `${event.operationId}-error`, role: 'system', content: `任务失败：${event.message}`, time: Date.now() }])
          notify('error', event.message)
          refreshHistory()
          break
        case 'cancelled':
          setOperation(current => current?.id === event.operationId ? { ...current, state: 'cancelled', stage: '任务已停止', message: '本次 Agent 会话及子进程已经终止。' } : current)
          setOperationUsage(event.operationUsage)
          notify('info', '任务已停止')
          refreshHistory()
          break
      }
    })
    void window.pcManager.bootstrap().then(data => {
      setBootstrap(data)
      setSettings(data.settings)
      setLifetimeUsage(data.lifetimeUsage)
      const preferredVolume = data.system.volumes.find(volume => volume.root.toLocaleLowerCase() === data.system.rootPath.toLocaleLowerCase()) ?? data.system.volumes[0]
      setScanTargets(preferredVolume === undefined
        ? [{ type: 'directory', path: data.system.rootPath, label: data.system.rootPath }]
        : [{ type: 'drive', path: preferredVolume.root, label: preferredVolume.name.trim().length > 0 ? `${preferredVolume.name} (${preferredVolume.root})` : preferredVolume.root }])
      applyTheme(data.settings.theme)
    }).catch(error => { setBootstrapError(error instanceof Error ? error.message : String(error)) })
    return dispose
  }, [notify, refreshHistory])

  useEffect(() => {
    const listener = (): void => { if (settings !== undefined && settings.theme === 'system') applyTheme('system') }
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', listener)
    return () => { media.removeEventListener('change', listener) }
  }, [settings])

  if (bootstrap === undefined || settings === undefined) return <LoadingScreen {...bootstrapError === undefined ? {} : { error: bootstrapError }} />

  const busy = operation?.state === 'running' || operation?.state === 'starting' || operation?.state === 'cancelling'
  const presets = [...bootstrap.builtInPresets, ...settings.customPresets]
  const selectedRisks = risks.filter(risk => selectedIds.has(risk.id))
  const ignoredRisks = risks.filter(risk => riskResolutions[risk.id]?.mode === 'ignore')
  const cleanupInstructions: CleanupInstruction[] = [...selectedRisks.map<CleanupInstruction>(risk => {
    const resolution = riskResolutions[risk.id] ?? { mode: 'recommended', instruction: '' }
    return {
      riskId: risk.id,
      mode: resolution.mode === 'quarantine' || resolution.mode === 'manual' ? resolution.mode : 'recommended',
      ...(resolution.mode === 'manual' ? { instruction: resolution.instruction.trim() } : {}),
    }
  }), ...ignoredRisks.map(risk => ({ riskId: risk.id, mode: 'ignore' as const }))]
  const volumes = bootstrap.system.volumes
  const totalBytes = volumes.reduce((total, volume) => total + volume.totalBytes, 0)
  const freeBytes = volumes.reduce((total, volume) => total + volume.freeBytes, 0)
  const usedPercent = totalBytes === 0 ? 0 : Math.round((totalBytes - freeBytes) / totalBytes * 100)
  const diskRiskCount = risks.filter(risk => risk.scanKind === 'disk').length
  const virusRiskCount = risks.filter(risk => risk.scanKind === 'virus' && (risk.severity === 'high' || risk.severity === 'critical')).length

  const openSettings = (tab: SettingsTab): void => {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }
  const ensureConfigured = (): boolean => {
    if (settings.apiKeyConfigured) return true
    notify('info', '请先配置 DeepSeek API Key')
    openSettings('model')
    return false
  }
  const runScan = async (kind: ScanKind): Promise<void> => {
    if (!ensureConfigured()) return
    if (scanTargets.length === 0) {
      setScopeOpen(true)
      notify('info', '请先选择扫描磁盘或目录')
      return
    }
    try {
      await window.pcManager.startScan(kind, scanTargets)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }
  const startScan = async (kind: ScanKind): Promise<void> => {
    if (!ensureConfigured()) return
    const needsElevation = kind === 'virus' || scanTargets.some(target => target.type === 'drive' || /^[a-z]:\\(?:windows|program files(?: \(x86\))?|programdata)(?:\\|$)/iu.test(target.path))
    if (!bootstrap.system.isElevated && needsElevation) {
      setPendingElevatedScan(kind)
      return
    }
    await runScan(kind)
  }
  const startCleanup = async (): Promise<void> => {
    setConfirmCleanup(false)
    cleanupInputRisksRef.current = structuredClone(selectedRisks)
    try {
      await window.pcManager.startCleanup({ sourceScanKind: riskScanKind, risks: selectedRisks, ignoredRisks, instructions: cleanupInstructions })
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }
  const sendChat = async (message: string, referencedPaths: PathReference[]): Promise<void> => {
    if (!ensureConfigured()) return
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: 'user', content: message, time: Date.now() }
    setMessages(current => [...current, userMessage])
    try {
      await window.pcManager.sendChat({ message, relatedRisks: risks.filter(risk => selectedIds.has(risk.id)), referencedPaths })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setMessages(current => [...current, { id: `error-${Date.now()}`, role: 'system', content: detail, time: Date.now() }])
      notify('error', detail)
    }
  }
  const quickSave = async (input: SaveSettingsInput): Promise<void> => {
    try {
      const saved = await window.pcManager.saveSettings(input)
      setSettings(saved)
      applyTheme(saved.theme)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="app-shell">
      <WindowTitleBar configured={settings.apiKeyConfigured} onHistory={() => { setHistoryOpen(true); refreshHistory() }} onSettings={() => { openSettings('general') }} />
      <main className="app-main">
        <section className="hero-heading">
          <div>
            <span className="hero-kicker"><i />DEEPSEEK HARNESS POWERED</span>
            <h1>让 Agent 帮你看懂这台电脑</h1>
            <p>先只读扫描，再由你决定。任何清理都经过新会话二次研判。</p>
          </div>
          <div className="hero-controls">
            <button type="button" className="scope-chip" disabled={busy} onClick={() => { setScopeOpen(true) }}><span><Search size={16} /></span><div><b>扫描范围 · {scanTargets.length} 项</b><small>{scanTargets.length === 1 ? scanTargets[0]?.label : scanTargets.map(target => target.path).join('；')}</small></div><Pencil size={13} /></button>
            <button type="button" className="thinking-chip" disabled={busy} onClick={() => { openSettings('model') }}><span><BrainCircuit size={17} /></span><div><b>思考等级</b><small>{REASONING_LABELS[settings.reasoningEffort]}</small></div><Pencil size={13} /></button>
            <div className="machine-chip"><span><HardDrive size={17} /></span><div><b>{bootstrap.system.hostname}</b><small>{bootstrap.system.platformLabel} · 根目录 {bootstrap.system.rootPath}</small></div></div>
          </div>
        </section>

        <section className="action-grid">
          <ActionCard
            tone="blue"
            icon={HardDrive}
            eyebrow="STORAGE AGENT"
            title="硬盘清理"
            description="覆盖缓存、转储、大文件与应用残留，给出可核验的空间风险清单。"
            metric={volumes.length > 0 ? `${usedPercent}%` : diskRiskCount > 0 ? String(diskRiskCount) : '—'}
            metricLabel={volumes.length > 0 ? `磁盘已使用 · 剩余 ${formatBytes(freeBytes)}` : '等待磁盘信息'}
            busy={busy && operation?.kind === 'disk'}
            disabled={busy}
            onClick={() => { void startScan('disk') }}
          />
          <ActionCard
            tone="violet"
            icon={ShieldCheck}
            eyebrow="SECURITY AGENT"
            title="病毒扫描"
            description="关联进程、签名、外连、防火墙与持久化入口，不靠文件名草率判断。"
            metric={virusRiskCount === 0 ? '安全检查' : String(virusRiskCount)}
            metricLabel={virusRiskCount === 0 ? '等待开始一次扫描' : '个高风险项目待确认'}
            busy={busy && operation?.kind === 'virus'}
            disabled={busy}
            onClick={() => { void startScan('virus') }}
          />
          <TokenCard operation={operationUsage} lifetime={lifetimeUsage} busy={busy} />
        </section>

        <ProgressPanel
          operation={operation}
          activities={activities}
          riskCount={risks.length}
          onCancel={() => { if (operation !== undefined) void window.pcManager.cancelOperation(operation.id) }}
        />

        <RiskSection
          risks={risks}
          selectedIds={selectedIds}
          resolutions={riskResolutions}
          busy={busy}
          {...cleanupReport === undefined ? {} : { cleanupReport }}
          onToggle={id => { setSelectedIds(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }); setRiskResolutions(current => current[id]?.mode === 'ignore' ? { ...current, [id]: { mode: 'recommended', instruction: '' } } : current) }}
          onSelectAll={(ids, selected) => { setSelectedIds(current => { const next = new Set(current); for (const id of ids) selected ? next.add(id) : next.delete(id); return next }); if (selected) setRiskResolutions(current => ({ ...current, ...Object.fromEntries(ids.filter(id => current[id]?.mode === 'ignore').map(id => [id, { mode: 'recommended', instruction: '' } satisfies RiskResolution])) })) }}
          onResolution={(id, resolution) => { setRiskResolutions(current => ({ ...current, [id]: resolution })); setSelectedIds(current => { const next = new Set(current); if (resolution.mode === 'ignore') next.delete(id); else next.add(id); return next }) }}
          onCleanup={() => { setConfirmCleanup(true) }}
        />

        <ChatSection
          messages={messages}
          settings={settings}
          presets={presets}
          risks={risks}
          busy={busy}
          onSend={sendChat}
          onQuickSetting={quickSave}
        />
        <footer className="app-footer"><span><LockKeyhole size={12} />扫描只读 · 清理需确认 · API Key 使用系统加密存储</span><span>DSH PC Manager {bootstrap.appVersion}</span></footer>
      </main>

      {confirmCleanup && <CleanupConfirmation risks={selectedRisks} onCancel={() => { setConfirmCleanup(false) }} onConfirm={() => { void startCleanup() }} />}
      {pendingElevatedScan !== undefined && <ElevationDialog kind={pendingElevatedScan} onCancel={() => { setPendingElevatedScan(undefined) }} onLimited={() => { const kind = pendingElevatedScan; setPendingElevatedScan(undefined); void runScan(kind) }} onElevate={async () => { const restarted = await window.pcManager.requestElevation(); if (!restarted) notify('info', '未获得管理员权限，应用保持当前状态。') }} />}
      {scopeOpen && <ScanScopeDialog volumes={bootstrap.system.volumes} selected={scanTargets} onCancel={() => { setScopeOpen(false) }} onSave={targets => { setScanTargets(targets); setScopeOpen(false); notify('success', `已选择 ${targets.length} 个扫描范围`) }} onToast={notify} />}
      {reportOpen && cleanupReport !== undefined && <CleanupReportDialog report={cleanupReport} risks={cleanupReportRisks} quarantinePath={bootstrap.system.quarantinePath} onClose={() => { setReportOpen(false) }} />}
      <HistoryPanel open={historyOpen} entries={historyEntries} loading={historyLoading} onClose={() => { setHistoryOpen(false) }} onRefresh={refreshHistory} />
      <SettingsPanel
        open={settingsOpen}
        initialTab={settingsTab}
        settings={settings}
        presets={presets}
        quarantinePath={bootstrap.system.quarantinePath}
        version={bootstrap.appVersion}
        onClose={() => { setSettingsOpen(false) }}
        onSaved={saved => { setSettings(saved); applyTheme(saved.theme) }}
        onToast={notify}
      />
      {toast !== undefined && <Toast toast={toast} onClose={() => { setToast(undefined) }} />}
    </div>
  )
}
