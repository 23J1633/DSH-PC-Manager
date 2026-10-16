import {
  Activity,
  AlertTriangle,
  AtSign,
  BarChart3,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  CalendarDays,
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
  MemoryStick,
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
  Children,
  cloneElement,
  isValidElement,
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
  CleanupInput,
  CleanupInstruction,
  CleanupReport,
  DiskVolume,
  OperationEvent,
  OperationHistoryEntry,
  AgentTraceEntry,
  AppStatisticsSnapshot,
  CleanupSteeringInput,
  OperationKind,
  OperationPlan,
  OperationState,
  RiskItem,
  RiskScanKind,
  SaveSettingsInput,
  ScanKind,
  ScanTarget,
  PathReference,
  PathSuggestion,
  Severity,
  TokenUsage,
} from '../shared/types.js'
import { EMPTY_TOKEN_USAGE } from '../shared/types.js'
import { groupScanCleanupHistory } from './history-grouping.js'

interface UiOperation {
  id: string
  kind: OperationKind
  title: string
  state: OperationState
  stage: string
  message: string
  progress: number
  startedAt: number
  finishedAt?: number
  waitingForTool?: boolean
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

type RiskResolutionMode = 'recommended' | 'ignore' | 'quarantine' | 'manual' | 'safe-clean'

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
  'safe-clean': '安全清理',
}

type SettingsTab = 'general' | 'model' | 'agent' | 'security' | 'repair' | 'about'

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
  application: '大型软件',
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

function isWindowsPath(value: string): boolean {
  return /^[a-z]:\\/iu.test(value) || /^\\\\[^\\]+\\[^\\]+/u.test(value)
}

function PathText(props: { text: string; block?: boolean; exactPath?: boolean }): ReactNode {
  const parts: ReactNode[] = []
  const appendPathLink = (path: string, key: string): void => {
    parts.push(<button type="button" className="local-path-link" key={key} title={`打开 ${path}`} onClick={event => { event.stopPropagation(); void window.pcManager.openPath(path).catch(error => { console.error('Failed to open local path', error) }) }}>{path}</button>)
  }
  const appendLegacyPaths = (text: string, offset: number): void => {
    const expression = /(?:[a-z]:\\|\\\\[^\\\s]+\\[^\\\s]+\\?)[^\s<>|"，；。！？、：,;()[\]{}]*/giu
    let cursor = 0
    for (const [index, match] of [...text.matchAll(expression)].entries()) {
      let raw = match[0] ?? ''
      const start = match.index ?? cursor
      let end = start + raw.length
      while (end < text.length) {
        const component = text.slice(end).match(/^[ \t]+[^\\/\r\n<>|"，；。！？、：,;()[\]{}]+\\/u)?.[0]
        if (component === undefined || /[a-z]:\\/iu.test(component)) break
        raw += component
        end += component.length
      }
      const suffix = raw.match(/[),;.!?，；。！？\]}]+$/u)?.[0] ?? ''
      const path = suffix.length === 0 ? raw : raw.slice(0, -suffix.length)
      if (!isWindowsPath(path)) continue
      parts.push(text.slice(cursor, start))
      appendPathLink(path, `${offset + start}-${index}`)
      if (suffix.length > 0) parts.push(suffix)
      cursor = end
    }
    parts.push(text.slice(cursor))
  }
  const exactPath = props.text.trim()
  const markedPaths = [...props.text.matchAll(/⟦PATH⟧([\s\S]*?)⟦\/PATH⟧/giu)]
  if (props.exactPath === true && isWindowsPath(exactPath)) {
    appendPathLink(exactPath, 'exact-path')
  } else if (markedPaths.length === 0) {
    appendLegacyPaths(props.text, 0)
  } else {
    let cursor = 0
    for (const [index, match] of markedPaths.entries()) {
      const raw = match[0] ?? ''
      const path = (match[1] ?? '').trim()
      const start = match.index ?? cursor
      appendLegacyPaths(props.text.slice(cursor, start), cursor)
      if (isWindowsPath(path)) appendPathLink(path, `marked-${start}-${index}`)
      else parts.push(path)
      cursor = start + raw.length
    }
    appendLegacyPaths(props.text.slice(cursor), cursor)
  }
  if (parts.length === 0 || (parts.length === 1 && parts[0] === props.text)) return props.block === true ? <code>{props.text}</code> : <>{props.text}</>
  return props.block === true ? <code className="path-code">{parts}</code> : <>{parts}</>
}

function renderPathNodes(nodes: ReactNode): ReactNode {
  return Children.map(nodes, child => {
    if (typeof child === 'string') return <PathText text={child} />
    if (!isValidElement<{ children?: ReactNode }>(child)) return child
    return cloneElement(child, undefined, renderPathNodes(child.props.children))
  })
}

export function MarkdownContent(props: { content: string }): ReactNode {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{renderPathNodes(children)}</p>,
          li: ({ children }) => <li>{renderPathNodes(children)}</li>,
          blockquote: ({ children }) => <blockquote>{renderPathNodes(children)}</blockquote>,
          td: ({ children }) => <td>{renderPathNodes(children)}</td>,
          th: ({ children }) => <th>{renderPathNodes(children)}</th>,
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
    relaxedPermissions: settings.relaxedPermissions,
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

function WindowTitleBar(props: { configured: boolean; onHistory(): void; onStatistics(): void; onSettings(): void }): ReactNode {
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
        <button type="button" className="window-button" aria-label="统计信息" title="统计信息" onClick={props.onStatistics}><BarChart3 size={16} /></button>
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
  className?: string
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
    <article className={`action-card ${props.tone} ${props.className ?? ''}`}>
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

function LiveTokenChip(props: { operation: TokenUsage; busy: boolean; startedAt?: number; finishedAt?: number }): ReactNode {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!props.busy) {
      setNow(Date.now())
      return
    }
    const timer = window.setInterval(() => { setNow(Date.now()) }, 250)
    return () => { window.clearInterval(timer) }
  }, [props.busy])
  const endAt = props.busy ? now : props.finishedAt ?? now
  const elapsed = props.startedAt === undefined ? 0 : Math.max(0, endAt - props.startedAt)
  const seconds = Math.floor(elapsed / 1000)
  const clock = `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const digits = props.operation.totalTokens.toLocaleString('en-US')
  return (
    <div className={`live-token-chip ${props.busy ? 'active' : ''}`} title={`本轮 Token：${props.operation.totalTokens.toLocaleString('zh-CN')} · 用时 ${clock}`}>
      <span className="live-token-caption"><Coins size={14} />本轮 Token</span>
      <strong className="rolling-token" aria-live="off">{[...digits].map((digit, index) => /\d/u.test(digit)
        ? <span className="rolling-digit" key={index}><span style={{ transform: `translateY(-${Number(digit) * 1.15}em)` }}>{'0123456789'.split('').map((value, digitIndex) => <i key={digitIndex}>{value}</i>)}</span></span>
        : <span className="rolling-separator" key={index}>{digit}</span>)}</strong>
      <span className="live-turn-clock"><Clock3 size={13} />{clock}</span>
      {props.busy && <i className="live-token-indicator" />}
    </div>
  )
}

function MemoryOptimizationCard(props: { busy: boolean; disabled: boolean; onClick(): void }): ReactNode {
  return (
    <ActionCard
      tone="blue"
      className="memory-action-card"
      icon={MemoryStick}
      eyebrow="MEMORY AGENT"
      title="内存优化"
      description="Agent 检查高占用应用进程；你勾选后再交由 Agent 复核，只回收工作集。"
      metric="进程检查"
      metricLabel="查找可优化内存项"
      busy={props.busy}
      disabled={props.disabled}
      onClick={props.onClick}
      actionLabel="开始扫描"
    />
  )
}

function AgentTrajectory(props: { entries: AgentTraceEntry[] }): ReactNode {
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [actualDuration, setActualDuration] = useState(false)
  const [callsCollapsed, setCallsCollapsed] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const turns = useMemo(() => {
    const grouped = new Map<number, AgentTraceEntry[]>()
    for (const entry of props.entries) {
      const turn = Math.max(1, entry.turn)
      grouped.set(turn, [...(grouped.get(turn) ?? []), entry])
    }
    const needle = searchQuery.trim().toLocaleLowerCase()
    return [...grouped.entries()]
      .map(([turn, entries]) => [turn, needle.length === 0 ? entries : entries.filter(entry => `${entry.label} ${entry.type} ${entry.input ?? ''} ${entry.output ?? ''} ${entry.detail}`.toLocaleLowerCase().includes(needle))] as const)
      .filter(([, entries]) => entries.length > 0)
      .sort((left, right) => left[0] - right[0])
  }, [props.entries, searchQuery])
  if (props.entries.length === 0) return <div className="trajectory-empty">等待 Harness 事件进入轨迹…</div>
  const allCollapsed = turns.length > 0 && turns.every(([turn]) => collapsedTurns.has(turn))
  return (
    <details className="trajectory-panel">
      <summary><span><Activity size={14} />执行轨迹</span><small>{props.entries.length} 条事件</small><ChevronDown size={14} /></summary>
      <div className="trajectory-content" data-trajectory-scroll>
        <div className="trajectory-toolbar">
          <div className="trajectory-toolbar-group" role="group" aria-label="轨迹显示设置">
            <button type="button" className={!actualDuration ? 'active' : ''} aria-pressed={!actualDuration} onClick={() => { setActualDuration(false) }}>等宽</button>
            <button type="button" className={actualDuration ? 'active' : ''} aria-pressed={actualDuration} onClick={() => { setActualDuration(true) }}>按时长</button>
            <button type="button" onClick={() => { setCollapsedTurns(allCollapsed ? new Set() : new Set(turns.map(([turn]) => turn))) }}>{allCollapsed ? '展开轮次' : '折叠轮次'}</button>
            <button type="button" aria-pressed={callsCollapsed} onClick={() => { setCallsCollapsed(value => !value) }}>{callsCollapsed ? '展开调用' : '折叠调用'}</button>
          </div>
          <label className="trajectory-search"><Search size={13} /><input value={searchQuery} onChange={event => { setSearchQuery(event.target.value) }} placeholder="搜索轨迹" /></label>
        </div>
        {turns.map(([turn, entries]) => {
          const turnStart = entries[0]?.time ?? 0
          const turnEnd = entries.at(-1)?.time ?? turnStart
          const duration = Math.max(0, turnEnd - turnStart)
          const durationLabel = duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(duration < 10_000 ? 2 : 1)} s`
          const collapsed = collapsedTurns.has(turn)
          const visibleEntries = callsCollapsed ? entries.filter(entry => entry.type !== 'tool/call' && entry.type !== 'tool/result') : entries
          const collapsedCallCount = entries.length - visibleEntries.length
          const positionOf = (entry: AgentTraceEntry, index: number): number => actualDuration && duration > 0
            ? (entry.time - turnStart) / duration * 100
            : entries.length <= 1 ? 50 : index / (entries.length - 1) * 100
          return <section className={`trajectory-turn ${collapsed ? 'collapsed' : ''}`} key={turn}>
            <button type="button" className="trajectory-turn-header" aria-expanded={!collapsed} onClick={() => { setCollapsedTurns(current => { const next = new Set(current); if (next.has(turn)) next.delete(turn); else next.add(turn); return next }) }}>
              <b>Turn {turn}</b><span>{entries.length} 条事件</span><small>输入 · 输出 · Think · 时间</small><strong>{durationLabel}</strong><ChevronDown size={14} />
            </button>
            {!collapsed && <>
              <div className="trajectory-timeline" aria-label={`Turn ${turn} 事件时间线`}>
                <div className="trajectory-timeline-axis"><span>{new Date(turnStart).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><span>{actualDuration ? '记录时长' : '等间距事件'}</span><span>{new Date(turnEnd).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>
                <div className="trajectory-timeline-track">{entries.map((entry, index) => <i key={entry.id} className={`trajectory-point ${entry.type.replace('/', '-').replaceAll('_', '-')}`} style={{ left: `${positionOf(entry, index)}%` }} title={`${entry.label} · ${new Date(entry.time).toLocaleTimeString('zh-CN')}`} />)}</div>
              </div>
              <div className="trajectory-column-header"><span>事件</span><span>内容</span><span>输入</span><span>输出</span><span>Think</span><span>时间</span></div>
              <div className="trajectory-turn-body">
                {collapsedCallCount > 0 && <div className="trajectory-collapsed-calls">{collapsedCallCount} 条工具调用事件已折叠</div>}
                {visibleEntries.map(entry => {
                  const index = entries.indexOf(entry)
                  const input = entry.input ?? (entry.type === 'user/message' ? entry.detail : '')
                  const output = entry.output ?? (entry.type === 'assistant/message' ? entry.detail : '')
                  const think = entry.reasoning ?? (entry.type === 'assistant/attempt' ? entry.detail : '')
                  const displayText = entry.type === 'user/message'
                    ? input
                    : entry.type === 'tool/call'
                      ? [entry.label, input].filter(Boolean).join(' · ')
                      : output || think || entry.detail || entry.label
                  const elapsedMs = entry.durationMs ?? Math.max(0, entry.time - turnStart)
                  const elapsed = elapsedMs < 1000 ? `${elapsedMs} ms` : `${(elapsedMs / 1000).toFixed(2)} s`
                  const kindLabel = entry.type === 'user/message'
                    ? 'User'
                    : entry.type === 'assistant/message' || entry.type === 'assistant/attempt'
                      ? 'Assistant'
                      : entry.type === 'tool/call' || entry.type === 'tool/result'
                        ? 'Tool'
                        : entry.type === 'system/message' ? 'System' : 'Context'
                  return <details className={`trajectory-record ${kindLabel.toLocaleLowerCase()} ${entry.isError === true ? 'error' : ''}`} key={entry.id}>
                    <summary>
                      <span className="trajectory-kind"><small>#{index + 1}</small><b>{kindLabel}</b></span>
                      <span className="trajectory-cell content"><PathText text={displayText || '—'} /></span>
                      <span className="trajectory-cell input">{entry.inputTokens === undefined ? '—' : formatTokens(entry.inputTokens)}</span>
                      <span className="trajectory-cell output">{entry.outputTokens === undefined ? '—' : formatTokens(entry.outputTokens)}</span>
                      <span className="trajectory-cell think">{entry.reasoningTokens === undefined ? '—' : formatTokens(entry.reasoningTokens)}</span>
                      <span className="trajectory-cell time">{elapsed}</span>
                    </summary>
                    <div className="trajectory-record-detail">
                      <b>{entry.label} · {entry.type}{entry.step > 0 ? ` · Step ${entry.step}` : ''}</b>
                      {input && <pre><strong>Input</strong><PathText text={input} /></pre>}
                      {output && <pre><strong>Output</strong><PathText text={output} /></pre>}
                      {think && <pre><strong>Think</strong><PathText text={think} /></pre>}
                      {entry.isError === true && <small>工具返回错误</small>}
                    </div>
                  </details>
                })}
              </div>
            </>}
          </section>
        })}
      </div>
    </details>
  )
}

function ProgressPanel(props: {
  operation: UiOperation | undefined
  activities: ToolActivity[]
  trace: AgentTraceEntry[]
  riskCount: number
  onCancel(): void
}): ReactNode {
  const { operation } = props
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (operation?.waitingForTool !== true) return
    const timer = window.setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { window.clearInterval(timer) }
  }, [operation?.waitingForTool])
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
  const waitingForTool = operation.waitingForTool === true
  const latestTool = props.activities.at(-1)
  const toolSeconds = latestTool === undefined ? 0 : Math.max(0, Math.floor((now - latestTool.time) / 1000))
  const toolElapsed = `${String(Math.floor(toolSeconds / 60)).padStart(2, '0')}:${String(toolSeconds % 60).padStart(2, '0')}`
  return (
    <section className={`progress-panel ${running ? 'active' : operation.state}`}>
      <div className="progress-main">
        <div className={`progress-orb ${running ? 'spinning' : ''}`}>
          {operation.state === 'failed' ? <AlertTriangle size={24} /> : operation.state === 'cancelled' ? <CircleStop size={24} /> : <Activity size={24} />}
        </div>
        <div className="progress-copy">
          <div className="progress-title-row">
            <h3>{operation.stage}</h3>
            <span>{waitingForTool ? `工具执行中 · ${toolElapsed}` : `${operation.progress}%`}</span>
          </div>
          <p>{operation.message}</p>
          <div className={`progress-track ${waitingForTool ? 'waiting' : ''}`}><span style={{ width: `${operation.progress}%` }} /></div>
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
          <p><PathText text={operation.plan.summary} /></p>
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
                  <i />{item.label}<small><PathText text={item.detail} /></small>
                </span>
              ))}
        </div>
        <span className="risk-counter">已发现 <b>{props.riskCount}</b> 项</span>
      </div>
      <AgentTrajectory entries={props.trace} />
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
        {props.risk.scanKind === 'memory' ? <MemoryStick size={19} /> : props.risk.scanKind === 'virus' ? <ShieldCheck size={19} /> : props.risk.kind === 'directory' ? <FolderOpen size={19} /> : <FileWarning size={19} />}
      </div>
      <div className="risk-content">
        <div className="risk-title-line">
          <h4>{props.risk.name}</h4>
          <span className={`severity-badge ${props.risk.severity}`}>{SEVERITY_LABELS[props.risk.severity]}</span>
          <span className="kind-badge">{KIND_LABELS[props.risk.kind]}</span>
          {props.cleanupStatus !== undefined && <span className={`cleanup-status ${props.cleanupStatus.status}`}>{props.cleanupStatus.status === 'quarantined' ? '已隔离' : props.cleanupStatus.status === 'cleaned' ? '已清理' : props.cleanupStatus.status === 'skipped' ? '已跳过' : '失败'}</span>}
        </div>
        <p><PathText text={props.risk.description} /></p>
        <PathText text={props.risk.target} block exactPath />
        {expanded && (
          <div className="risk-details">
            <div><b>判断理由</b><span><PathText text={props.risk.reason} /></span></div>
            <div><b>建议动作</b><span><PathText text={props.risk.recommendedAction} /></span></div>
            {props.risk.evidence.length > 0 && <div><b>证据</b><span><PathText text={props.risk.evidence.join('；')} /></span></div>}
            {props.cleanupStatus !== undefined && <div><b>执行结果</b><span><PathText text={props.cleanupStatus.detail} /></span></div>}
            {props.cleanupStatus === undefined && props.risk.scanKind !== 'memory' && (
              <div className="resolution-editor">
                <b>处理方案</b>
                <div>
                  <div className="resolution-options" role="group" aria-label={`${props.risk.name} 的处理方案`}>
                    {(['recommended', 'ignore', 'quarantine', 'manual', 'safe-clean'] as const).map(mode => <button key={mode} type="button" disabled={props.disabled} className={props.resolution.mode === mode ? 'active' : ''} onClick={() => { props.onResolution({ mode, instruction: mode === 'manual' ? props.resolution.instruction : '' }) }}>{RESOLUTION_LABELS[mode]}</button>)}
                  </div>
                  {props.resolution.mode === 'manual' && <textarea rows={3} disabled={props.disabled} value={props.resolution.instruction} maxLength={2000} placeholder="请输入希望 Agent 执行的具体方案；审核 Agent 会先检查安全性和授权边界。" onChange={event => { props.onResolution({ mode: 'manual', instruction: event.target.value }) }} />}
                  <small>{props.resolution.mode === 'ignore' ? '此项不会进入清理会话。' : props.resolution.mode === 'quarantine' ? '只允许移动到可恢复隔离区，不允许永久删除。' : props.resolution.mode === 'manual' ? '方案会先交给独立审核 Agent，审核拒绝时不会执行。' : props.resolution.mode === 'safe-clean' ? '审核 Agent 仍检查安全范围；清理 Agent 会在边界内尽力清理所选目标，不会因审核拒绝直接跳过。' : '清理 Agent 将基于扫描建议再次核验后决定动作。'}</small>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="risk-meta">
        <strong>{props.risk.sizeBytes === undefined ? '—' : formatBytes(props.risk.sizeBytes)}</strong>
        <span>{props.cleanupStatus === undefined ? props.risk.scanKind === 'memory' ? '可回收工作集' : RESOLUTION_LABELS[props.resolution.mode] : props.risk.reversible ? '可逆处理' : '需谨慎'}</span>
      </div>
      <button type="button" className="expand-risk" aria-label="展开详情" onClick={() => { setExpanded(value => !value) }}>
        <ChevronDown size={17} className={expanded ? 'rotated' : ''} />
      </button>
    </article>
  )
}

function RiskSection(props: {
  risks: RiskItem[]
  scanKind: RiskScanKind
  selectedIds: Set<string>
  busy: boolean
  canSteer: boolean
  cleanupReport?: CleanupReport
  relaxedPermissions: boolean
  quarantineAvailable: boolean
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
  const safeCleanupCount = selectedRisks.filter(risk => props.resolutions[risk.id]?.mode === 'safe-clean').length
  const selectedBytes = selectedRisks.reduce((total, risk) => total + (risk.sizeBytes ?? 0), 0)
  const allFilteredSelected = filtered.length > 0 && filtered.every(risk => props.selectedIds.has(risk.id))
  const cleanupById = new Map(props.cleanupReport?.results.map(result => [result.id, result]))
  const incompleteManualCount = selectedRisks.filter(risk => props.resolutions[risk.id]?.mode === 'manual' && !props.resolutions[risk.id]?.instruction.trim()).length
  const inputDisabled = props.busy && !props.canSteer
  const memoryMode = props.scanKind === 'memory'

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
              <input type="checkbox" checked={allFilteredSelected} disabled={inputDisabled} onChange={event => { props.onSelectAll(filtered.map(risk => risk.id), event.target.checked) }} />
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
                disabled={inputDisabled}
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
          <div><b>已选择项目</b><span>{selectedBytes > 0 ? memoryMode ? `候选工作集 ${formatBytes(selectedBytes)}` : `预计涉及 ${formatBytes(selectedBytes)}` : '最终动作由 Agent 二次判断'}</span></div>
        </div>
        <div className={`cleanup-note ${(!memoryMode && !props.quarantineAvailable) || incompleteManualCount > 0 || (!memoryMode && props.relaxedPermissions) ? 'warning' : ''}`}>
          {memoryMode ? <LockKeyhole size={14} /> : !props.quarantineAvailable || props.relaxedPermissions ? <AlertTriangle size={14} /> : <LockKeyhole size={14} />}
          {memoryMode ? '只回收已选应用的工作集，不会结束进程' : !props.quarantineAvailable ? '需要可用的非 C 盘才能启用隔离与清理' : incompleteManualCount > 0 ? `还有 ${incompleteManualCount} 项未填写手动方案` : safeCleanupCount > 0 ? `${safeCleanupCount} 项安全清理仍会经过审核，并按安全边界尽力执行` : props.relaxedPermissions ? '放宽权限已启用：清理将跳过独立审核' : '清理前会启动新会话重新核验，不会按清单盲删'}
        </div>
        <button type="button" className="primary-button cleanup-button" disabled={props.busy || (!memoryMode && !props.quarantineAvailable) || selectedRisks.length === 0 || incompleteManualCount > 0} onClick={props.onCleanup}>
          {memoryMode ? <MemoryStick size={16} /> : <Sparkles size={16} />}{memoryMode ? '交给 Agent 优化内存' : '交给 Agent 一键清理'}
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
  onSend(message: string, referencedPaths: PathReference[], operationMode: boolean): Promise<void>
  onQuickSetting(settings: SaveSettingsInput): Promise<void>
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [operationMode, setOperationMode] = useState(false)
  const [mention, setMention] = useState<MentionContext | undefined>()
  const [suggestions, setSuggestions] = useState<PathSuggestion[]>([])
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const [references, setReferences] = useState<PathReference[]>([])
  const listRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!props.settings.relaxedPermissions) setOperationMode(false)
  }, [props.settings.relaxedPermissions])
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
    await props.onSend(message, submittedReferences, operationMode)
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
        <div className="chat-header-main"><span className="bot-avatar"><Bot size={17} /></span><h3>电脑管家对话</h3>
          <div className="chat-mode-switch" role="group" aria-label="对话权限模式">
            <button type="button" className={!operationMode ? 'active' : ''} aria-pressed={!operationMode} disabled={props.busy} onClick={() => { setOperationMode(false) }}><LockKeyhole size={11} />只读咨询</button>
            <button type="button" className={operationMode ? 'active operate' : ''} aria-pressed={operationMode} disabled={props.busy || !props.settings.relaxedPermissions} title={props.settings.relaxedPermissions ? '允许按明确指令执行文件和系统操作' : '请先在设置的“隔离与隐私”中开启放宽操作权限'} onClick={() => { setOperationMode(true) }}><Wrench size={11} />可操作模式</button>
          </div>
        </div>
        <div className="chat-header-actions"><span>可结合当前 {props.risks.length} 个风险项继续询问</span><button type="button" title={expanded ? '退出全屏对话' : '放大对话'} aria-label={expanded ? '退出全屏对话' : '放大对话'} onClick={() => { setExpanded(value => !value) }}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button></div>
      </div>
      <div className="chat-messages" ref={listRef}>
        {operationMode && <div className="chat-operation-warning"><AlertTriangle size={14} /><span><b>可操作模式已开启。</b> Agent 拥有完整系统读写权限，只会按你明确指定的对象和动作执行。</span></div>}
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
          placeholder={props.busy ? 'Agent 正在执行任务…' : operationMode ? '描述要执行的操作和确切目标…' : '询问扫描结果，或输入电脑管理问题…'}
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

function CleanupConfirmation(props: { risks: RiskItem[]; relaxedPermissions: boolean; hasSafeCleanup: boolean; memoryMode: boolean; onCancel(): void; onConfirm(): void }): ReactNode {
  const [confirmed, setConfirmed] = useState(false)
  const critical = props.risks.filter(risk => risk.severity === 'critical' || risk.severity === 'high').length
  const totalBytes = props.risks.reduce((total, risk) => total + (risk.sizeBytes ?? 0), 0)
  const description = props.memoryMode
    ? 'Agent 会重新核对所选进程与 PID，只回收经 Agent 批准的工作集页面，不会结束应用或修改文件。'
    : props.hasSafeCleanup
    ? '安全清理项目仍会经过独立只读审核。审核 Agent 负责划定安全范围；即使审核保守拒绝，执行 Agent 也会在这些边界内尽力清理所选目标。确实没有安全可行的动作时会明确报告失败。'
    : props.relaxedPermissions
      ? '放宽权限已启用，本次会跳过独立审核。Agent 将按你逐项选择的目标和处理方案执行，手动方案可明确要求删除指定目标。'
      : '系统会先启动独立的只读审核 Agent。只有审核放行的项目，才会进入拥有写入能力的清理 Agent 会话，并优先隔离而非直接删除。'
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) props.onCancel() }}>
      <div className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="cleanup-confirm-title">
        <button type="button" className="modal-close" onClick={props.onCancel}><X size={18} /></button>
        <span className="confirm-icon"><Sparkles size={24} /></span>
        <h2 id="cleanup-confirm-title">{props.memoryMode ? '交给 Agent 复核并优化内存？' : '交给 Agent 二次研判并清理？'}</h2>
        <p>{description}</p>
        <div className="confirm-stats">
          <div><strong>{props.risks.length}</strong><span>授权项目</span></div>
          <div><strong>{critical}</strong><span>高风险项目</span></div>
          <div><strong>{props.memoryMode ? formatBytes(totalBytes) : totalBytes > 0 ? formatBytes(totalBytes) : '—'}</strong><span>{props.memoryMode ? '候选工作集' : '涉及空间'}</span></div>
        </div>
        {!props.memoryMode && <div className={`authorization-scope ${props.relaxedPermissions ? 'relaxed' : ''}`}>
          {props.relaxedPermissions ? <AlertTriangle size={17} /> : <LockKeyhole size={17} />}
          <div><b>{props.hasSafeCleanup ? '安全清理边界审核已启用' : props.relaxedPermissions ? '放宽权限模式已启用' : '双 Agent 审核门已启用'}</b><span>{props.hasSafeCleanup ? '执行 Agent 必须只处理你选中的目标，并按审核给出的安全范围尽力完成清理。' : props.relaxedPermissions ? '执行 Agent 可修改或删除你勾选并指定的目标；请确认目标和手动方案准确。' : '审核 Agent 可拒绝或转人工；执行 Agent 只能处理审核放行且由你勾选的目标。'}</span></div>
        </div>}
        <label className="confirm-check">
          <input type="checkbox" checked={confirmed} onChange={event => { setConfirmed(event.target.checked) }} />
          <span><Check size={13} /></span>
          {props.memoryMode ? '我已核对所选进程，并同意 Agent 回收其工作集' : '我已核对所选项目，并同意 Agent 执行必要的命令行操作'}
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={props.onCancel}>返回检查</button>
          <button type="button" className="primary-button" disabled={!confirmed} onClick={props.onConfirm}><Sparkles size={16} />{props.memoryMode ? '确认并优化' : '确认并开始'}</button>
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
                  <div key={target.path}><FolderOpen size={16} /><span title={target.path}><PathText text={target.path} exactPath /></span><button type="button" onClick={() => { setTargets(current => current.filter(item => item.path !== target.path)) }}><X size={14} /></button></div>
                ))}
          </div>
        </div>
        <div className="scope-safety"><LockKeyhole size={16} /><span><b>只读边界</b>DSH 沙箱会禁止扫描 Agent 对所选范围和系统进行任何修改。</span></div>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={props.onCancel}>取消</button><button type="button" className="primary-button" disabled={targets.length === 0} onClick={() => { props.onSave(targets) }}>使用 {targets.length} 个范围</button></div>
      </div>
    </div>
  )
}

function CleanupReportDialog(props: { report: CleanupReport; risks: RiskItem[]; auditReport?: CleanupAuditReport; quarantinePath: string; onClose(): void; onContinueSkipped(risks: RiskItem[]): void }): ReactNode {
  const riskMap = new Map(props.risks.map(risk => [risk.id, risk]))
  const auditMap = new Map(props.auditReport?.decisions.map(decision => [decision.id, decision]) ?? [])
  const blockedRisks = props.report.results
    .filter(result => {
      const decision = auditMap.get(result.id)
      return result.status === 'skipped' && decision !== undefined && decision.verdict !== 'allow'
    })
    .flatMap(result => {
      const risk = riskMap.get(result.id)
      return risk === undefined ? [] : [risk]
    })
  const success = props.report.results.filter(result => result.status === 'cleaned' || result.status === 'quarantined').length
  return (
    <div className="modal-backdrop">
      <div className="report-modal" role="dialog" aria-modal="true">
        <button type="button" className="modal-close" onClick={props.onClose}><X size={18} /></button>
        <span className="report-icon"><CheckCircle2 size={25} /></span>
        <h2>Agent 清理报告</h2>
        <p><PathText text={props.report.summary} /></p>
        <div className="report-overview"><b>{success}</b> 项已处理 · <b>{props.report.results.length - success}</b> 项跳过或失败 {props.report.rebootRecommended && <span>· 建议重启电脑</span>}</div>
        <div className="report-list">
          {props.report.results.map(result => (
            <div key={result.id} className={`report-item ${result.status}`}>
              <span>{result.status === 'cleaned' || result.status === 'quarantined' ? <Check size={15} /> : result.status === 'skipped' ? <Minus size={15} /> : <AlertTriangle size={15} />}</span>
              <div><b>{riskMap.get(result.id)?.name ?? result.id}</b><p>{result.action} · <PathText text={result.detail} /></p></div>
              <em>{result.status === 'quarantined' ? '已隔离' : result.status === 'cleaned' ? '已清理' : result.status === 'skipped' ? '已跳过' : '失败'}</em>
            </div>
          ))}
        </div>
        {props.report.followup.length > 0 && <div className="followup-box"><b>后续建议</b>{props.report.followup.map((item, index) => <p key={index}>• {item}</p>)}</div>}
        <div className="modal-actions">
          {blockedRisks.length > 0 && <button type="button" className="secondary-button" onClick={() => { props.onContinueSkipped(blockedRisks) }}><RotateCcw size={15} />继续安全清理 {blockedRisks.length} 项</button>}
          <button type="button" className="secondary-button" onClick={() => { void window.pcManager.openPath(props.quarantinePath) }}><FolderOpen size={15} />打开隔离区</button>
          <button type="button" className="primary-button" onClick={props.onClose}>完成</button>
        </div>
      </div>
    </div>
  )
}

function HistoryPanel(props: { open: boolean; entries: OperationHistoryEntry[]; loading: boolean; busy: boolean; onClose(): void; onRefresh(): void; onContinueSkipped(risks: RiskItem[]): void; onResume(entryId: string): void }): ReactNode {
  const historyGroups = groupScanCleanupHistory(props.entries)
  if (!props.open) return null
  const statusLabel: Record<OperationHistoryEntry['status'], string> = {
    running: '进行中',
    completed: '已完成',
    failed: '失败',
    cancelled: '已停止',
    interrupted: '意外中断',
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
          ) : (() => {
            const renderEntry = (entry: OperationHistoryEntry, nested = false): ReactNode => {
            if (!nested && entry.kind === 'cleanup' && historyGroups.groupedCleanupIds.has(entry.id)) return null
            const linkedCleanups = !nested ? historyGroups.cleanupsByScanId.get(entry.id) ?? [] : []
            const riskById = new Map(entry.risks.map(risk => [risk.id, risk]))
            const instructionById = new Map(entry.cleanupInstructions?.map(instruction => [instruction.riskId, instruction]) ?? [])
            const auditById = new Map(entry.auditReport?.decisions.map(decision => [decision.id, decision]) ?? [])
            const resultById = new Map(entry.cleanupReport?.results.map(result => [result.id, result]) ?? [])
            const handled = entry.cleanupReport?.results.filter(result => result.status === 'cleaned' || result.status === 'quarantined') ?? []
            const blockedRisks = entry.cleanupReport?.results
              .filter(result => {
                const decision = auditById.get(result.id)
                return result.status === 'skipped' && decision !== undefined && decision.verdict !== 'allow'
              })
              .flatMap(result => {
                const risk = riskById.get(result.id)
                return risk === undefined ? [] : [risk]
              }) ?? []
            const detail = (
              <details key={entry.id} className={`history-entry ${entry.status}`}>
                <summary>
                  <span className="history-kind">{entry.kind === 'disk' ? <HardDrive size={17} /> : entry.kind === 'virus' ? <ShieldCheck size={17} /> : entry.kind === 'cleanup' ? <Sparkles size={17} /> : entry.kind === 'memory' ? <MemoryStick size={17} /> : entry.kind === 'repair' ? <Wrench size={17} /> : <Bot size={17} />}</span>
                  <div><b>{entry.title}</b><span>{formatDateTime(entry.startedAt)}{entry.finishedAt === undefined ? '' : ` · ${Math.max(1, Math.round((entry.finishedAt - entry.startedAt) / 1000))} 秒`}</span></div>
                  <div className="history-summary-metrics"><span className={`history-status ${entry.status}`}>{statusLabel[entry.status]}</span><strong>{formatTokens(entry.tokenUsage.totalTokens)} Token</strong><ChevronDown size={15} /></div>
                </summary>
                <div className="history-details">
                  <p><PathText text={entry.summary} /></p>
                  {entry.canResume === true && <button type="button" className="secondary-button history-resume" disabled={props.busy} onClick={() => { props.onResume(entry.id) }}><RotateCcw size={14} />{props.busy ? '请先等待当前任务' : '继续原任务'}</button>}
                  <div className="history-facts">
                    <span><b>模型 / 思考</b>{entry.model} · {entry.reasoningEffort === undefined ? '旧记录未记录' : REASONING_LABELS[entry.reasoningEffort]}</span>
                    <span><b>本次 Token</b>{entry.tokenUsage.totalTokens.toLocaleString('zh-CN')}（输入 {entry.tokenUsage.inputTokens.toLocaleString('zh-CN')} / 输出 {entry.tokenUsage.outputTokens.toLocaleString('zh-CN')} / 推理 {entry.tokenUsage.reasoningTokens.toLocaleString('zh-CN')}）</span>
                    {entry.targets.length > 0 && <span><b>扫描范围</b>{entry.targets.map(target => <PathText text={target.path} exactPath key={target.path} />)}</span>}
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
                        return <details key={risk.id} className={`history-risk severity-${risk.severity}`}><summary><span className={`severity-badge ${risk.severity}`}>{SEVERITY_LABELS[risk.severity]}</span><strong>{risk.name}</strong><em>{instruction === undefined ? risk.recommendedAction : instruction.mode === 'ignore' ? '用户选择：忽略' : instruction.mode === 'quarantine' ? '用户选择：隔离' : instruction.mode === 'manual' ? '用户选择：手动方案' : instruction.mode === 'safe-clean' ? '用户选择：安全清理' : '用户选择：AI 建议'}</em><ChevronDown size={13} /></summary><div><p><b>目标</b><PathText text={risk.target} block exactPath /></p><p><b>判断理由</b><span><PathText text={risk.reason} /></span></p><p><b>AI 建议</b><span><PathText text={risk.recommendedAction} /></span></p>{risk.evidence.length > 0 && <p><b>证据</b><span><PathText text={risk.evidence.join('；')} /></span></p>}{instruction?.mode === 'manual' && <p><b>手动方案</b><span><PathText text={instruction.instruction ?? ''} /></span></p>}{audit !== undefined && <p><b>审核结果</b><span><PathText text={`${audit.verdict === 'allow' ? '放行' : audit.verdict === 'deny' ? '拒绝' : '需人工确认'} · ${audit.reason}`} /></span></p>}{result !== undefined && <p><b>实际处理</b><span><PathText text={`${result.action} · ${result.detail}`} /></span></p>}</div></details>
                      })}
                    </div>
                  )}
                  {entry.cleanupReport !== undefined && (
                    <div className="history-cleanup-results">
                      <b>清理明细 · 成功处理 {handled.length} 项</b>
                      {entry.cleanupReport.results.map(result => <div key={result.id} className={result.status}><span>{result.status === 'cleaned' ? '已清理' : result.status === 'quarantined' ? '已隔离' : result.status === 'skipped' ? '已跳过' : '失败'}</span><div><strong>{riskById.get(result.id)?.name ?? result.id}</strong><small>{result.action} · <PathText text={result.detail} /></small></div></div>)}
                      {blockedRisks.length > 0 && <button type="button" className="secondary-button" onClick={() => { props.onContinueSkipped(blockedRisks) }}><RotateCcw size={14} />继续安全清理审核跳过的 {blockedRisks.length} 项</button>}
                    </div>
                  )}
                </div>
              </details>
            )
            if (nested || linkedCleanups.length === 0) return detail
            return <div key={`work-${entry.id}`} className="history-work-group"><div className="history-work-group-heading"><span>{entry.kind === 'memory' ? <MemoryStick size={14} /> : <HardDrive size={14} />}一次工作</span><small>扫描与 {linkedCleanups.length} 次清理分别记录</small></div>{detail}{linkedCleanups.map(cleanup => renderEntry(cleanup, true))}</div>
            }
            return props.entries.map(entry => renderEntry(entry))
          })()}
        </div>
      </aside>
    </div>
  )
}

type StatisticsRange = 7 | 30 | 90 | 365

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function StatisticsPanel(props: { open: boolean; statistics: AppStatisticsSnapshot; lifetime: TokenUsage; entries: OperationHistoryEntry[]; onClose(): void }): ReactNode {
  const [range, setRange] = useState<StatisticsRange>(30)
  const [hoveredIndex, setHoveredIndex] = useState<number | undefined>()
  const today = new Date()
  const days = useMemo(() => {
    const lookup = new Map(props.statistics.daily.map(item => [item.date, item]))
    return Array.from({ length: range }, (_, index) => {
      const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (range - index - 1))
      const key = localDayKey(date)
      return { date: key, value: lookup.get(key) ?? { date: key, requests: 0, scans: 0, scannedItems: 0, cleanupRuns: 0, cleanedItems: 0, tokenUsage: { ...EMPTY_TOKEN_USAGE } } }
    })
  }, [props.statistics.daily, range])
  const maxTokens = Math.max(1, ...days.map(day => day.value.tokenUsage.totalTokens))
  const chartX = (index: number): number => 36 + index * (928 / Math.max(1, days.length - 1))
  const chartY = (value: number): number => 166 - value / maxTokens * 142
  const chartPath = (selector: (usage: TokenUsage) => number): string => days.map((day, index) => {
    const x = chartX(index)
    const y = chartY(selector(day.value.tokenUsage))
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
  }).join(' ')
  const selectedEntries = props.entries.filter(entry => entry.finishedAt === undefined || entry.startedAt >= new Date(today.getFullYear(), today.getMonth(), today.getDate() - range + 1).getTime())
  const dominantModel = [...props.entries].sort((left, right) => right.tokenUsage.totalTokens - left.tokenUsage.totalTokens)[0]?.model ?? '暂无模型记录'
  const latestDaily = days.at(-1)?.value
  const recentAverage = Math.round(days.reduce((sum, day) => sum + day.value.tokenUsage.totalTokens, 0) / range)
  const estimatedFreedBytes = props.entries.flatMap(entry => {
    if (entry.cleanupReport === undefined) return []
    const sizes = new Map(entry.risks.map(risk => [risk.id, risk.sizeBytes ?? 0]))
    return entry.cleanupReport.results.filter(result => result.status === 'cleaned' || result.status === 'quarantined').map(result => sizes.get(result.id) ?? 0)
  }).reduce((sum, size) => sum + size, 0)
  const heatMax = Math.max(1, ...days.map(day => day.value.tokenUsage.totalTokens))
  const hoveredDay = hoveredIndex === undefined ? undefined : days[hoveredIndex]
  const hoveredX = hoveredIndex === undefined ? undefined : chartX(hoveredIndex)
  const chartSeries = hoveredDay === undefined ? [] : [
    { label: '总 Token', value: hoveredDay.value.tokenUsage.totalTokens, className: 'total' },
    { label: '输入', value: hoveredDay.value.tokenUsage.inputTokens, className: 'input' },
    { label: '输出', value: hoveredDay.value.tokenUsage.outputTokens, className: 'output' },
    { label: '缓存命中', value: hoveredDay.value.tokenUsage.cacheReadTokens, className: 'cache' },
    { label: '缓存写入', value: hoveredDay.value.tokenUsage.cacheWriteTokens, className: 'cache-write' },
  ]
  const updateHoveredIndex = (clientX: number, rect: DOMRect): void => {
    if (rect.width <= 0) return
    const viewX = (clientX - rect.left) / rect.width * 1000
    if (viewX < 36 || viewX > 964) {
      setHoveredIndex(undefined)
      return
    }
    setHoveredIndex(Math.max(0, Math.min(days.length - 1, Math.round((viewX - 36) / 928 * (days.length - 1)))))
  }
  if (!props.open) return null
  return (
    <div className="statistics-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target) props.onClose() }}>
      <section className="statistics-page" role="dialog" aria-modal="true" aria-label="使用统计">
        <header className="statistics-header"><div><BarChart3 size={23} /><div><h2>使用统计</h2><p>AI 模型使用情况、扫描发现与清理结果</p></div></div><div className="statistics-header-actions"><div className="statistics-range">{([7, 30, 90, 365] as const).map(value => <button key={value} type="button" className={range === value ? 'active' : ''} onClick={() => { setRange(value); setHoveredIndex(undefined) }}>{value === 365 ? '最近一年' : `最近 ${value} 天`}</button>)}</div><button type="button" className="statistics-close" aria-label="关闭统计" onClick={props.onClose}><X size={19} /></button></div></header>
        <div className="statistics-content">
          <section className="statistics-overview">
            <div className="statistics-lead"><span><Coins size={18} />累计 Token 消耗</span><strong>{props.lifetime.totalTokens.toLocaleString('zh-CN')}</strong><small>约 {formatTokens(props.lifetime.totalTokens)} Token</small></div>
            <div className="statistics-overview-grid">
              <article><span>模型请求</span><b>{props.statistics.lifetimeRequests.toLocaleString('zh-CN')}</b><small>统计 DSH 模型轮次</small></article>
              <article><span>累计输入</span><b>{props.lifetime.inputTokens.toLocaleString('zh-CN')}</b><small>含缓存读取 {props.lifetime.cacheReadTokens.toLocaleString('zh-CN')}</small></article>
              <article><span>累计输出</span><b>{props.lifetime.outputTokens.toLocaleString('zh-CN')}</b><small>推理 Token {props.lifetime.reasoningTokens.toLocaleString('zh-CN')}</small></article>
              <article><span>缓存命中率</span><b>{props.lifetime.inputTokens + props.lifetime.cacheReadTokens === 0 ? '—' : `${(props.lifetime.cacheReadTokens / (props.lifetime.inputTokens + props.lifetime.cacheReadTokens) * 100).toFixed(1)}%`}</b><small>按累计缓存读取计算</small></article>
              <article><span>扫描次数</span><b>{props.statistics.lifetimeScans.toLocaleString('zh-CN')}</b><small>硬盘、安全与内存检查</small></article>
              <article><span>扫描发现</span><b>{props.statistics.lifetimeScannedItems.toLocaleString('zh-CN')}</b><small>清单中的可复核项</small></article>
              <article><span>已清理 / 隔离</span><b>{props.statistics.lifetimeCleanedItems.toLocaleString('zh-CN')}</b><small>{props.statistics.lifetimeCleanupRuns.toLocaleString('zh-CN')} 次清理操作</small></article>
              <article><span>历史估算释放空间</span><b>{formatBytes(estimatedFreedBytes)}</b><small>仅按有大小记录的成功项估算</small></article>
            </div>
          </section>

          <section className="statistics-section"><div className="statistics-section-heading"><div><h3>使用趋势</h3><p>近 {range} 天 · 日均 {formatTokens(recentAverage)} Token</p></div><span>{latestDaily?.tokenUsage.totalTokens.toLocaleString('zh-CN') ?? '0'} 今日 Token</span></div>
            <div className="statistics-chart"><svg viewBox="0 0 1000 205" role="img" aria-label="每日 Token 使用趋势；将鼠标移到曲线上查看日期和用量" preserveAspectRatio="none" onPointerMove={event => { updateHoveredIndex(event.clientX, event.currentTarget.getBoundingClientRect()) }} onPointerLeave={() => { setHoveredIndex(undefined) }}><defs><linearGradient id="token-area-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#9a57ff" stopOpacity=".23" /><stop offset="100%" stopColor="#9a57ff" stopOpacity="0" /></linearGradient></defs>{[24, 71, 118, 166].map(y => <line key={y} x1="36" x2="964" y1={y} y2={y} className="chart-gridline" />)}<path d={`${chartPath(usage => usage.totalTokens)} L 964 166 L 36 166 Z`} fill="url(#token-area-gradient)" /><path d={chartPath(usage => usage.totalTokens)} className="chart-line total" /><path d={chartPath(usage => usage.inputTokens)} className="chart-line input" /><path d={chartPath(usage => usage.outputTokens)} className="chart-line output" /><path d={chartPath(usage => usage.cacheReadTokens)} className="chart-line cache" />{hoveredDay !== undefined && hoveredX !== undefined && <g className="chart-hover-markers" pointerEvents="none"><line x1={hoveredX} x2={hoveredX} y1="24" y2="166" /><circle className="total" cx={hoveredX} cy={chartY(hoveredDay.value.tokenUsage.totalTokens)} r="4" /><circle className="input" cx={hoveredX} cy={chartY(hoveredDay.value.tokenUsage.inputTokens)} r="3.5" /><circle className="output" cx={hoveredX} cy={chartY(hoveredDay.value.tokenUsage.outputTokens)} r="3.5" /><circle className="cache" cx={hoveredX} cy={chartY(hoveredDay.value.tokenUsage.cacheReadTokens)} r="3.5" /></g>}</svg>{hoveredDay !== undefined && hoveredX !== undefined && <div className="statistics-chart-tooltip" style={{ left: `${hoveredX / 10}%`, transform: hoveredX > 700 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}><strong>{hoveredDay.date}</strong>{chartSeries.map(series => <span key={series.label} className={series.className}><i />{series.label}：{series.value.toLocaleString('zh-CN')}</span>)}</div>}<div className="statistics-chart-axis"><span>{days[0]?.date}</span><span>{days[Math.floor(days.length / 2)]?.date}</span><span>{days.at(-1)?.date}</span></div><div className="statistics-chart-legend"><span><i className="total" />总 Token</span><span><i className="input" />输入</span><span><i className="output" />输出</span><span><i className="cache" />缓存命中</span></div></div>
          </section>

          <section className="statistics-section"><div className="statistics-section-heading"><div><h3>每日活动</h3><p>扫描次数、发现数量与清理成果</p></div><div className="activity-toggle"><CalendarDays size={14} />日历</div></div><div className="statistics-heatmap">{days.map(day => {
            const level = day.value.tokenUsage.totalTokens === 0 ? 0 : Math.min(4, Math.ceil(day.value.tokenUsage.totalTokens / heatMax * 4))
            return <div key={day.date} className={`heatmap-cell level-${level}`} title={`${day.date} · ${day.value.tokenUsage.totalTokens.toLocaleString('zh-CN')} Token · 扫描 ${day.value.scans} 次 · 发现 ${day.value.scannedItems} 项 · 清理 ${day.value.cleanedItems} 项`} />
          })}</div></section>

          <section className="statistics-section app-statistics"><div className="statistics-section-heading"><div><h3>电脑管家统计</h3><p>当前历史记录中有 {selectedEntries.length} 条操作可展开查看</p></div><span>最常用模型 · {dominantModel}</span></div><div className="app-statistics-grid"><article><span>今日扫描</span><b>{latestDaily?.scans ?? 0}</b><small>发现 {latestDaily?.scannedItems ?? 0} 个项目</small></article><article><span>今日清理</span><b>{latestDaily?.cleanupRuns ?? 0}</b><small>成功处理 {latestDaily?.cleanedItems ?? 0} 项</small></article><article><span>今日模型请求</span><b>{latestDaily?.requests ?? 0}</b><small>活动操作共 {selectedEntries.length} 条</small></article><article><span>今日 Token</span><b>{formatTokens(latestDaily?.tokenUsage.totalTokens ?? 0)}</b><small>输入 {formatTokens(latestDaily?.tokenUsage.inputTokens ?? 0)} · 输出 {formatTokens(latestDaily?.tokenUsage.outputTokens ?? 0)}</small></article></div></section>
          <p className="statistics-note">Token 为模型返回的用量统计。成本没有在本机配置模型单价，因此不估算费用；清理释放空间按扫描时记录的项目大小估算。</p>
        </div>
      </section>
    </div>
  )
}

interface SettingsPanelProps {
  open: boolean
  initialTab: SettingsTab
  settings: AppSettings
  presets: AgentPreset[]
  quarantinePath: string
  quarantineMessage: string | undefined
  version: string
  latestError: string
  busy: boolean
  onClose(): void
  onSaved(settings: AppSettings): void
  onStartRepair(errorText: string): Promise<void>
  onToast(tone: ToastState['tone'], message: string): void
}

function SettingsPanel(props: SettingsPanelProps): ReactNode {
  const [tab, setTab] = useState<SettingsTab>(props.initialTab)
  const [draft, setDraft] = useState<SaveSettingsInput>(() => settingsInput(props.settings, { apiKey: '' }))
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved')
  const [testing, setTesting] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [clearQuarantineConfirm, setClearQuarantineConfirm] = useState(false)
  const [clearingQuarantine, setClearingQuarantine] = useState(false)
  const [repairErrorText, setRepairErrorText] = useState(props.latestError)
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

  useEffect(() => {
    if (props.latestError.trim().length > 0) setRepairErrorText(current => current.trim().length === 0 ? props.latestError : current)
  }, [props.latestError])

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

  const startRepair = async (): Promise<void> => {
    setRepairing(true)
    try {
      const signature = JSON.stringify(draftRef.current)
      if (signature !== lastSavedRef.current && !await persistDraft(draftRef.current, signature)) return
      await props.onStartRepair(repairErrorText.trim() || props.latestError)
    } finally {
      setRepairing(false)
    }
  }

  const clearQuarantine = async (): Promise<void> => {
    if (clearingQuarantine || props.busy || props.quarantinePath.length === 0) return
    setClearingQuarantine(true)
    try {
      const result = await window.pcManager.clearQuarantine()
      setClearQuarantineConfirm(false)
      props.onToast('success', result.removedCount === 0 ? '隔离区已经是空的。' : `隔离区已清空，共移除 ${result.removedCount} 个项目。`)
    } catch (error) {
      props.onToast('error', `清空隔离区失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setClearingQuarantine(false)
    }
  }

  const navItems: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
    { id: 'general', label: '通用', icon: SlidersHorizontal },
    { id: 'model', label: '模型服务', icon: Activity },
    { id: 'agent', label: 'Agent 预设', icon: Sparkles },
    { id: 'security', label: '隔离与隐私', icon: ShieldCheck },
    { id: 'repair', label: '自我修复', icon: Wrench },
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
                <SettingRow title="隔离区" description={props.quarantinePath.length > 0 ? <PathText text={props.quarantinePath} /> : props.quarantineMessage || '未检测到可用的非 C 盘，隔离与清理功能已禁用。'}><div className="quarantine-actions"><button type="button" className="secondary-button" disabled={props.quarantinePath.length === 0} onClick={() => { void window.pcManager.openPath(props.quarantinePath) }}><FolderOpen size={15} />打开</button><button type="button" className="secondary-button danger-button" disabled={props.quarantinePath.length === 0 || props.busy || clearingQuarantine} onClick={() => { setClearQuarantineConfirm(true) }}><Trash2 size={15} />清空</button></div></SettingRow>
                <SettingRow title="隔离保留期" description="到期项目不会自动清空；保留期用于提醒你复核。"><label className="number-field"><input type="number" min={1} max={365} value={draft.quarantineRetentionDays} onChange={event => { setDraft(current => ({ ...current, quarantineRetentionDays: Math.max(1, Math.min(365, Number(event.target.value) || 1)) })) }} />天</label></SettingRow>
                <SettingRow title="放宽操作权限" description="允许清理跳过独立审核，并启用对话中的可操作模式。默认关闭；只在目标和动作明确时开启。"><Switch checked={draft.relaxedPermissions} onChange={checked => { setDraft(current => ({ ...current, relaxedPermissions: checked })) }} /></SettingRow>
                <div className={`privacy-note ${draft.relaxedPermissions ? 'relaxed' : ''}`}>
                  {draft.relaxedPermissions ? <AlertTriangle size={18} /> : <LockKeyhole size={18} />}
                  <div><b>{draft.relaxedPermissions ? '放宽权限已开启' : '双层安全边界'}</b><p>{draft.relaxedPermissions ? '扫描仍为只读。清理会跳过独立审核；对话只有切换到“可操作模式”才获得 DSH 完整读写权限，操作范围仍应由你明确指定。' : '扫描会话由 DSH read-only 沙箱硬性禁止写入；清理会先经过独立审核，只有你勾选并确认后才开放写权限。'}</p></div>
                </div>
              </SettingsPage>
            )}
            {tab === 'repair' && (
              <SettingsPage title="智能自我修复" description="让 Agent 根据本机 DSH 报错检查并修复其用户级运行配置。">
                <div className="privacy-note repair-scope"><Wrench size={18} /><div><b>修复范围受限</b><p>Agent 运行在 DSH_HOME 的 workspace-write 沙箱中，只能写入 DSH 运行目录。它会先备份再修改配置，不会改动应用安装文件、系统设置或其他用户文件。若错误来自打包文件或应用程序本身，Agent 会说明需要重新安装或更新。</p></div></div>
                <label className="form-field repair-error-field"><span>错误信息</span><textarea rows={10} maxLength={12_000} value={repairErrorText} onChange={event => { setRepairErrorText(event.target.value) }} placeholder={props.latestError || '粘贴最近出现的完整错误信息；留空时 Agent 会检查本机 DSH 运行环境。'} /></label>
                {!props.settings.apiKeyConfigured && <p className="repair-requirement">运行智能修复前，请先在“模型服务”中配置 API Key。</p>}
                <button type="button" className="primary-button repair-start" disabled={repairing || props.busy || !props.settings.apiKeyConfigured} onClick={() => { void startRepair() }}>{repairing || props.busy ? <span className="mini-spinner" /> : <Wrench size={15} />}{repairing || props.busy ? 'Agent 正在处理…' : '开始智能修复'}</button>
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
      {clearQuarantineConfirm && <div className="modal-backdrop quarantine-confirm-backdrop" role="presentation" onMouseDown={event => { if (event.currentTarget === event.target && !clearingQuarantine) setClearQuarantineConfirm(false) }}><section className="confirm-modal quarantine-confirm" role="dialog" aria-modal="true" aria-labelledby="clear-quarantine-title"><span className="confirm-icon danger"><Trash2 size={23} /></span><h2 id="clear-quarantine-title">清空隔离区？</h2><p>此操作会永久删除隔离区内的全部项目，删除后无法恢复。请先确认不再需要还原其中的文件。</p><div className="modal-actions"><button type="button" className="secondary-button" disabled={clearingQuarantine} onClick={() => { setClearQuarantineConfirm(false) }}>取消</button><button type="button" className="danger-action-button" disabled={clearingQuarantine} onClick={() => { void clearQuarantine() }}>{clearingQuarantine ? <span className="mini-spinner" /> : <Trash2 size={15} />}{clearingQuarantine ? '正在清空…' : '永久清空'}</button></div></section></div>}
    </div>
  )
}

function SettingsPage(props: { title: string; description: string; children: ReactNode }): ReactNode {
  return <div className="settings-page"><div className="settings-page-head"><h3>{props.title}</h3><p>{props.description}</p></div>{props.children}</div>
}

function SettingRow(props: { title: string; description: ReactNode; children: ReactNode }): ReactNode {
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
  const [statistics, setStatistics] = useState<AppStatisticsSnapshot>({ lifetimeRequests: 0, lifetimeScans: 0, lifetimeScannedItems: 0, lifetimeCleanupRuns: 0, lifetimeCleanedItems: 0, daily: [] })
  const [risks, setRisks] = useState<RiskItem[]>([])
  const [riskScanKind, setRiskScanKind] = useState<RiskScanKind>('disk')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [riskResolutions, setRiskResolutions] = useState<Record<string, RiskResolution>>({})
  const [activities, setActivities] = useState<ToolActivity[]>([])
  const [trace, setTrace] = useState<AgentTraceEntry[]>([])
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
  const [statisticsOpen, setStatisticsOpen] = useState(false)
  const [latestError, setLatestError] = useState('')
  const [toast, setToast] = useState<ToastState | undefined>()
  const cleanupInputRisksRef = useRef<RiskItem[]>([])
  const [riskSourceOperationId, setRiskSourceOperationId] = useState<string | undefined>()

  const notify = useCallback((tone: ToastState['tone'], message: string): void => {
    setToast({ id: Date.now(), tone, message })
  }, [])

  const refreshHistory = useCallback((): void => {
    setHistoryLoading(true)
    void window.pcManager.listHistory().then(entries => {
      setHistoryEntries(entries)
      const latestFailure = entries.find(entry => entry.status === 'failed' || entry.status === 'interrupted')
      if (latestFailure !== undefined) setLatestError(current => current || latestFailure.summary)
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
    const onWindowError = (event: ErrorEvent): void => { setLatestError(event.message || event.error?.message || 'Renderer 发生未处理错误') }
    const onUnhandledRejection = (event: PromiseRejectionEvent): void => { setLatestError(event.reason instanceof Error ? event.reason.message : String(event.reason)) }
    window.addEventListener('error', onWindowError)
    window.addEventListener('unhandledrejection', onUnhandledRejection)
    return () => {
      window.removeEventListener('error', onWindowError)
      window.removeEventListener('unhandledrejection', onUnhandledRejection)
    }
  }, [])

  useEffect(() => {
    const dispose = window.pcManager.onOperationEvent((event: OperationEvent) => {
      switch (event.type) {
        case 'started':
          setOperation({ id: event.operationId, kind: event.kind, title: event.title, state: 'running', stage: '正在启动 Agent', message: '准备 DeepSeek Harness 会话与权限策略。', progress: 2, startedAt: event.startedAt, completedPlanStepIds: [] })
          setOperationUsage({ ...EMPTY_TOKEN_USAGE })
          setActivities([])
          setTrace([])
          if (event.kind === 'cleanup') cleanupInputRisksRef.current = structuredClone(event.authorizedRisks ?? [])
          if (event.kind === 'disk' || event.kind === 'virus' || event.kind === 'memory') {
            setRiskSourceOperationId(event.operationId)
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
        case 'checkpoint':
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
        case 'trace':
          setTrace(current => [...current.slice(-299), structuredClone(event.entry)])
          setOperation(current => current?.id !== event.operationId ? current : {
            ...current,
            ...(event.entry.type === 'tool/call' ? { waitingForTool: true } : event.entry.type === 'tool/result' ? { waitingForTool: false } : {}),
          })
          break
        case 'steering':
          setMessages(current => [...current, { id: `${event.operationId}-steering-${event.time}`, role: 'system', content: `用户插话：${event.message}`, time: event.time }])
          break
        case 'statistics':
          setStatistics(event.statistics)
          break
        case 'tokens':
          setOperationUsage(event.operationUsage)
          setLifetimeUsage(event.lifetimeUsage)
          break
        case 'memory-result':
          notify(event.result.optimized > 0 ? 'success' : 'info', `Agent 已完成复核；回收约 ${formatBytes(event.result.reclaimedBytes)} 内存。`)
          break
        case 'risks':
          setRiskSourceOperationId(event.operationId)
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
          setOperation(current => current?.id === event.operationId ? { ...current, state: 'completed', stage: '任务已完成', message: event.summary, progress: 100, finishedAt: event.finishedAt, completedPlanStepIds: current.plan?.steps.map(step => step.id) ?? current.completedPlanStepIds } : current)
          setOperationUsage(event.operationUsage)
          notify('success', event.summary)
          refreshHistory()
          break
        case 'failed':
          setOperation(current => current?.id === event.operationId ? { ...current, state: 'failed', stage: '任务未完成', message: event.message, progress: Math.max(current.progress, 8), finishedAt: event.finishedAt } : current)
          setOperationUsage(event.operationUsage)
          setLatestError(event.message)
          setMessages(current => [...current, { id: `${event.operationId}-error`, role: 'system', content: `任务失败：${event.message}`, time: Date.now() }])
          notify('error', event.message)
          refreshHistory()
          break
        case 'cancelled':
          setOperation(current => current?.id === event.operationId ? { ...current, state: 'cancelled', stage: '任务已停止', message: event.summary ?? '本次 Agent 会话及子进程已经终止。', finishedAt: event.finishedAt } : current)
          setOperationUsage(event.operationUsage)
          notify('info', event.summary ?? '任务已停止')
          refreshHistory()
          break
      }
    })
    void window.pcManager.bootstrap().then(data => {
      setBootstrap(data)
      setSettings(data.settings)
      setLifetimeUsage(data.lifetimeUsage)
      setStatistics(data.statistics)
      const preferredVolume = data.system.volumes.find(volume => volume.root.toLocaleLowerCase() === data.system.rootPath.toLocaleLowerCase()) ?? data.system.volumes[0]
      setScanTargets(preferredVolume === undefined
        ? [{ type: 'directory', path: data.system.rootPath, label: data.system.rootPath }]
        : [{ type: 'drive', path: preferredVolume.root, label: preferredVolume.name.trim().length > 0 ? `${preferredVolume.name} (${preferredVolume.root})` : preferredVolume.root }])
      applyTheme(data.settings.theme)
      refreshHistory()
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
  const buildCleanupInput = (selection: Set<string>): CleanupInput => {
    const selected = risks.filter(risk => selection.has(risk.id))
    const ignored = risks.filter(risk => riskResolutions[risk.id]?.mode === 'ignore')
    const instructions: CleanupInstruction[] = [...selected.map<CleanupInstruction>(risk => {
      const resolution = riskResolutions[risk.id] ?? { mode: 'recommended', instruction: '' }
      return {
        riskId: risk.id,
        mode: resolution.mode === 'quarantine' || resolution.mode === 'manual' || resolution.mode === 'safe-clean' ? resolution.mode : 'recommended',
        ...(resolution.mode === 'manual' ? { instruction: resolution.instruction.trim() } : {}),
      }
    }), ...ignored.map(risk => ({ riskId: risk.id, mode: 'ignore' as const }))]
    return {
      sourceScanKind: riskScanKind,
      ...(riskSourceOperationId === undefined ? {} : { sourceOperationId: riskSourceOperationId }),
      risks: selected,
      ignoredRisks: ignored,
      instructions,
    }
  }
  const steerSelectionChange = async (selection: Set<string>, message: string): Promise<void> => {
    if (!busy || operation?.kind !== 'cleanup' || operation.state !== 'running') return
    const input: CleanupSteeringInput = { operationId: operation.id, cleanup: buildCleanupInput(selection), message }
    try {
      await window.pcManager.steerCleanup(input)
      notify('info', '已把你的选择作为插话发送给清理 Agent。')
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }
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
    setCleanupReport(undefined)
    setCleanupReportRisks([])
    setAuditReport(undefined)
    try {
      await window.pcManager.startCleanup(buildCleanupInput(selectedIds))
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }
  const toggleRisk = (id: string): void => {
    const next = new Set(selectedIds)
    const wasSelected = next.has(id)
    if (wasSelected) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
    setRiskResolutions(current => current[id]?.mode === 'ignore' ? { ...current, [id]: { mode: 'recommended', instruction: '' } } : current)
    if (operation?.kind === 'cleanup' && operation.state === 'running') {
      const riskName = risks.find(risk => risk.id === id)?.name ?? id
      void steerSelectionChange(next, wasSelected
        ? `用户插话：取消“${riskName}”，不得再继续处理这项；完成已启动步骤后跳过该项。`
        : `用户插话：加入“${riskName}”，请在当前授权范围内审核并处理新增项目。`)
    }
  }
  const toggleVisibleRisks = (ids: string[], selected: boolean): void => {
    const next = new Set(selectedIds)
    for (const id of ids) selected ? next.add(id) : next.delete(id)
    setSelectedIds(next)
    if (selected) setRiskResolutions(current => ({ ...current, ...Object.fromEntries(ids.filter(id => current[id]?.mode === 'ignore').map(id => [id, { mode: 'recommended', instruction: '' } satisfies RiskResolution])) }))
    if (operation?.kind === 'cleanup' && operation.state === 'running') {
      void steerSelectionChange(next, `用户插话：${selected ? '加入' : '取消'}当前筛选的 ${ids.length} 项，请按更新后的勾选清单执行。`)
    }
  }
  const continueSkippedCleanup = (items: RiskItem[]): void => {
    const byId = new Map(items.map(risk => [risk.id, risk]))
    const retryRisks = [...byId.values()].slice(0, 200)
    if (retryRisks.length === 0) return
    const retryIds = new Set(retryRisks.map(risk => risk.id))
    setRisks(current => [...current.filter(risk => !retryIds.has(risk.id)), ...retryRisks])
    setRiskScanKind(retryRisks[0]?.scanKind ?? 'disk')
    setSelectedIds(retryIds)
    setRiskResolutions(current => ({
      ...current,
      ...Object.fromEntries(retryRisks.map(risk => [risk.id, { mode: 'safe-clean', instruction: '' } satisfies RiskResolution])),
    }))
    setCleanupReport(undefined)
    setCleanupReportRisks([])
    setAuditReport(undefined)
    setReportOpen(false)
    setHistoryOpen(false)
    setConfirmCleanup(true)
    notify('info', `已选中 ${retryRisks.length} 项；确认后会重新审核安全范围并继续清理。`)
  }
  const sendChat = async (message: string, referencedPaths: PathReference[], operationMode: boolean): Promise<void> => {
    if (!ensureConfigured()) return
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: 'user', content: operationMode ? `【可操作模式】${message}` : message, time: Date.now() }
    setMessages(current => [...current, userMessage])
    try {
      await window.pcManager.sendChat({ message, relatedRisks: risks.filter(risk => selectedIds.has(risk.id)), referencedPaths, operationMode })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setMessages(current => [...current, { id: `error-${Date.now()}`, role: 'system', content: detail, time: Date.now() }])
      notify('error', detail)
    }
  }
  const startSelfRepair = async (errorText: string): Promise<void> => {
    if (!settings.apiKeyConfigured) {
      notify('info', '请先在模型服务中配置 DeepSeek API Key')
      openSettings('model')
      return
    }
    try {
      await window.pcManager.startSelfRepair(errorText)
      notify('info', '智能修复任务已启动，可在进度面板和历史记录中查看结果。')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setLatestError(detail)
      notify('error', detail)
    }
  }
  const resumeHistoryTask = async (entryId: string): Promise<void> => {
    try {
      await window.pcManager.resumeOperation(entryId)
      setHistoryOpen(false)
      notify('info', '正在使用原 DSH 会话继续历史任务。')
      refreshHistory()
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
      refreshHistory()
    }
  }
  const analyzeMemory = async (): Promise<void> => {
    if (!ensureConfigured()) return
    try {
      await window.pcManager.startMemoryAnalysis()
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
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
      <WindowTitleBar configured={settings.apiKeyConfigured} onStatistics={() => { setStatisticsOpen(true) }} onHistory={() => { setHistoryOpen(true); refreshHistory() }} onSettings={() => { openSettings('general') }} />
      <main className="app-main">
        <section className="hero-heading">
          <div>
            <span className="hero-kicker"><i />DEEPSEEK HARNESS POWERED</span>
            <h1>让 Agent 帮你看懂这台电脑</h1>
            <p>先只读扫描，再由你决定。任何清理都经过新会话二次研判。</p>
          </div>
          <div className="hero-controls">
            <div className={`scope-chip ${busy ? 'disabled' : ''}`} role="button" tabIndex={busy ? -1 : 0} aria-disabled={busy} onClick={() => { if (!busy) setScopeOpen(true) }} onKeyDown={event => { if (event.target === event.currentTarget && !busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setScopeOpen(true) } }}><span><Search size={16} /></span><div><b>扫描范围 · {scanTargets.length} 项</b><small><PathText text={scanTargets.length === 1 ? scanTargets[0]?.label ?? '' : scanTargets.map(target => target.path).join('；')} /></small></div><Pencil size={13} /></div>
            <button type="button" className="thinking-chip" disabled={busy} onClick={() => { openSettings('model') }}><span><BrainCircuit size={17} /></span><div><b>思考等级</b><small>{REASONING_LABELS[settings.reasoningEffort]}</small></div><Pencil size={13} /></button>
            <LiveTokenChip operation={operationUsage} busy={busy} {...operation === undefined ? {} : { startedAt: operation.startedAt, ...(operation.finishedAt === undefined ? {} : { finishedAt: operation.finishedAt }) }} />
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
          <MemoryOptimizationCard busy={busy && operation?.kind === 'memory'} disabled={busy} onClick={() => { void analyzeMemory() }} />
        </section>

        <ProgressPanel
          operation={operation}
          activities={activities}
          trace={trace}
          riskCount={risks.length}
          onCancel={() => { if (operation !== undefined) void window.pcManager.cancelOperation(operation.id) }}
        />

        <RiskSection
          risks={risks}
          scanKind={riskScanKind}
          selectedIds={selectedIds}
          resolutions={riskResolutions}
          relaxedPermissions={settings.relaxedPermissions}
          quarantineAvailable={bootstrap.system.quarantinePath.length > 0}
          busy={busy}
          canSteer={operation?.kind === 'cleanup' && operation.state === 'running'}
          {...cleanupReport === undefined ? {} : { cleanupReport }}
          onToggle={toggleRisk}
          onSelectAll={toggleVisibleRisks}
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

      {confirmCleanup && <CleanupConfirmation risks={selectedRisks} relaxedPermissions={settings.relaxedPermissions} hasSafeCleanup={selectedRisks.some(risk => riskResolutions[risk.id]?.mode === 'safe-clean')} memoryMode={riskScanKind === 'memory'} onCancel={() => { setConfirmCleanup(false) }} onConfirm={() => { void startCleanup() }} />}
      {pendingElevatedScan !== undefined && <ElevationDialog kind={pendingElevatedScan} onCancel={() => { setPendingElevatedScan(undefined) }} onLimited={() => { const kind = pendingElevatedScan; setPendingElevatedScan(undefined); void runScan(kind) }} onElevate={async () => { const restarted = await window.pcManager.requestElevation(); if (!restarted) notify('info', '未获得管理员权限，应用保持当前状态。') }} />}
      {scopeOpen && <ScanScopeDialog volumes={bootstrap.system.volumes} selected={scanTargets} onCancel={() => { setScopeOpen(false) }} onSave={targets => { setScanTargets(targets); setScopeOpen(false); notify('success', `已选择 ${targets.length} 个扫描范围`) }} onToast={notify} />}
      {reportOpen && cleanupReport !== undefined && <CleanupReportDialog report={cleanupReport} risks={cleanupReportRisks} {...auditReport === undefined ? {} : { auditReport }} quarantinePath={bootstrap.system.quarantinePath} onClose={() => { setReportOpen(false) }} onContinueSkipped={continueSkippedCleanup} />}
      <HistoryPanel open={historyOpen} entries={historyEntries} loading={historyLoading} busy={busy} onClose={() => { setHistoryOpen(false) }} onRefresh={refreshHistory} onContinueSkipped={continueSkippedCleanup} onResume={entryId => { void resumeHistoryTask(entryId) }} />
      <StatisticsPanel open={statisticsOpen} statistics={statistics} lifetime={lifetimeUsage} entries={historyEntries} onClose={() => { setStatisticsOpen(false) }} />
      <SettingsPanel
        open={settingsOpen}
        initialTab={settingsTab}
        settings={settings}
        presets={presets}
        quarantinePath={bootstrap.system.quarantinePath}
        quarantineMessage={bootstrap.system.quarantineMessage}
        version={bootstrap.appVersion}
        latestError={latestError}
        busy={busy}
        onClose={() => { setSettingsOpen(false) }}
        onSaved={saved => { setSettings(saved); applyTheme(saved.theme) }}
        onStartRepair={startSelfRepair}
        onToast={notify}
      />
      {toast !== undefined && <Toast toast={toast} onClose={() => { setToast(undefined) }} />}
    </div>
  )
}
