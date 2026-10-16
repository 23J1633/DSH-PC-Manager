export type ScanKind = 'disk' | 'virus'
export type RiskScanKind = ScanKind | 'memory'
export type OperationKind = ScanKind | 'cleanup' | 'chat' | 'repair' | 'connection-test' | 'memory'
export type OperationState = 'idle' | 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type Severity = 'low' | 'medium' | 'high' | 'critical'
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'
export type CleanupActionMode = 'recommended' | 'ignore' | 'quarantine' | 'manual' | 'safe-clean'
export type MemoryOptimizationAction = 'trim-working-set'

export interface ScanTarget {
  type: 'drive' | 'directory'
  path: string
  label: string
}

export type RiskKind =
  | 'file'
  | 'directory'
  | 'process'
  | 'startup'
  | 'firewall'
  | 'service'
  | 'scheduled-task'
  | 'registry'
  | 'network'
  | 'browser-extension'
  | 'application'
  | 'other'

export interface RiskItem {
  id: string
  scanKind: RiskScanKind
  kind: RiskKind
  name: string
  target: string
  description: string
  reason: string
  severity: Severity
  sizeBytes?: number
  recommendedAction: string
  evidence: string[]
  selectedByDefault: boolean
  reversible: boolean
  cleanupHint?: string
  applicationId?: string
  memoryCandidate?: MemoryProcessCandidate
}

export interface MemoryProcessCandidate {
  pid: number
  name: string
  memoryBytes: number
  reason: string
}

export interface MemoryOverview {
  totalBytes: number
  availableBytes: number
  candidates: MemoryProcessCandidate[]
  checkedAt: number
  analysisSummary?: string
}

export interface MemoryOptimizationResult {
  requested: number
  optimized: number
  reclaimedBytes: number
  details: Array<{ pid: number; name: string; beforeBytes: number; afterBytes: number; success: boolean; message: string }>
  agentSummary?: string
}

export interface QuarantineClearResult {
  removedCount: number
}

export interface InstalledSoftwareItem {
  id: string
  name: string
  publisher: string
  version: string
  installDate?: string
  installLocation: string
  sizeBytes: number
  uninstallAvailable: boolean
  maintenanceAvailable: boolean
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface AgentPreset {
  id: string
  name: string
  description: string
  prompt: string
  builtIn: boolean
}

export interface AppSettings {
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
  baseUrl: string
  apiKeyConfigured: boolean
  theme: 'system' | 'light' | 'dark'
  fontScale: number
  activePresetId: string
  customPresets: AgentPreset[]
  scanDepth: 'standard' | 'deep'
  includeNetworkDrives: boolean
  quarantineRetentionDays: number
  relaxedPermissions: boolean
  telemetryEnabled: boolean
}

export interface SaveSettingsInput {
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
  baseUrl: string
  apiKey?: string
  clearApiKey?: boolean
  theme: AppSettings['theme']
  fontScale: number
  activePresetId: string
  customPresets: AgentPreset[]
  scanDepth: AppSettings['scanDepth']
  includeNetworkDrives: boolean
  quarantineRetentionDays: number
  relaxedPermissions: boolean
  telemetryEnabled: boolean
}

export interface DiskVolume {
  name: string
  root: string
  totalBytes: number
  freeBytes: number
}

export interface SystemOverview {
  rootPath: string
  hostname: string
  platformLabel: string
  volumes: DiskVolume[]
  quarantinePath: string
  quarantineMessage?: string
  isElevated: boolean
}

export interface BootstrapData {
  appVersion: string
  settings: AppSettings
  system: SystemOverview
  lifetimeUsage: TokenUsage
  statistics: AppStatisticsSnapshot
  builtInPresets: AgentPreset[]
}

export interface DailyAppStatistics {
  date: string
  requests: number
  scans: number
  scannedItems: number
  cleanupRuns: number
  cleanedItems: number
  tokenUsage: TokenUsage
}

export interface AppStatisticsSnapshot {
  lifetimeRequests: number
  lifetimeScans: number
  lifetimeScannedItems: number
  lifetimeCleanupRuns: number
  lifetimeCleanedItems: number
  daily: DailyAppStatistics[]
}

export interface AgentTraceEntry {
  id: string
  type: string
  turn: number
  step: number
  label: string
  detail: string
  input?: string
  output?: string
  reasoning?: string
  time: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  isError?: boolean
}

export interface CleanupResultItem {
  id: string
  status: 'cleaned' | 'quarantined' | 'skipped' | 'failed'
  action: string
  detail: string
  restorePath?: string
}

export interface CleanupReport {
  summary: string
  results: CleanupResultItem[]
  rebootRecommended: boolean
  followup: string[]
}

export interface CleanupAuditDecision {
  id: string
  verdict: 'allow' | 'deny' | 'manual'
  reason: string
  constraints: string[]
}

export interface CleanupAuditReport {
  summary: string
  decisions: CleanupAuditDecision[]
  globalWarnings: string[]
}

export interface OperationPlanStep {
  id: string
  title: string
  description: string
  expectedTools: number
}

export interface OperationPlan {
  summary: string
  source: 'agent' | 'fallback'
  steps: OperationPlanStep[]
}

export interface PathSuggestion {
  path: string
  name: string
  type: 'file' | 'directory' | 'drive'
}

export interface PathReference {
  path: string
  type: 'file' | 'directory'
}

export interface OperationHistoryEntry {
  id: string
  kind: OperationKind
  title: string
  status: Exclude<OperationState, 'idle' | 'starting' | 'cancelling'>
  startedAt: number
  finishedAt?: number
  summary: string
  model: string
  reasoningEffort?: ReasoningEffort
  tokenUsage: TokenUsage
  targets: ScanTarget[]
  risks: RiskItem[]
  plan?: OperationPlan
  auditReport?: CleanupAuditReport
  cleanupReport?: CleanupReport
  cleanupInstructions?: CleanupInstruction[]
  canResume?: boolean
  resumeState?: OperationResumeState
  resumedFrom?: string
  relatedOperationId?: string
  requestCount?: number
  trajectory?: AgentTraceEntry[]
  selectedRiskIds?: string[]
  steeringNotes?: string[]
}

export type OperationResumePhase = 'scan-planning' | 'scan-execution' | 'cleanup-audit' | 'cleanup-execution' | 'chat' | 'repair'

export type OperationResumeTask =
  | { kind: 'scan'; scanKind: ScanKind; targets: ScanTarget[] }
  | { kind: 'cleanup'; input: CleanupInput; quarantineId: string; relaxedPermissions?: boolean }
  | { kind: 'chat'; input: ChatInput }
  | { kind: 'repair'; errorText: string }

export interface OperationResumeState {
  task: OperationResumeTask
  sessionIds: { readOnly: string; writable: string; repair: string }
  phase: OperationResumePhase
}

export interface OperationResumeSnapshot {
  entry: OperationHistoryEntry
  resumeState: OperationResumeState
}

export type OperationEvent =
  | {
      type: 'started'
      operationId: string
      kind: OperationKind
      title: string
      startedAt: number
      model: string
      reasoningEffort: ReasoningEffort
      targets?: ScanTarget[]
      authorizedRisks?: RiskItem[]
      cleanupInstructions?: CleanupInstruction[]
      resumeState?: OperationResumeState
      resumedFrom?: string
      relatedOperationId?: string
    }
  | {
      type: 'checkpoint'
      operationId: string
      resumeState: OperationResumeState
    }
  | {
      type: 'plan'
      operationId: string
      plan: OperationPlan
    }
  | {
      type: 'progress'
      operationId: string
      stage: string
      message: string
      detail?: string
      progress?: number
      planStepId?: string
      completedPlanStepIds?: string[]
    }
  | {
      type: 'tool'
      operationId: string
      tool: string
      label: string
      detail: string
      time: number
    }
  | {
      type: 'trace'
      operationId: string
      entry: AgentTraceEntry
    }
  | {
      type: 'steering'
      operationId: string
      message: string
      cleanup: CleanupInput
      time: number
    }
  | {
      type: 'statistics'
      operationId: string
      statistics: AppStatisticsSnapshot
    }
  | {
      type: 'tokens'
      operationId: string
      operationUsage: TokenUsage
      lifetimeUsage: TokenUsage
    }
  | {
      type: 'memory-overview'
      operationId: string
      overview: MemoryOverview
    }
  | {
      type: 'memory-result'
      operationId: string
      result: MemoryOptimizationResult
    }
  | {
      type: 'risks'
      operationId: string
      scanKind: RiskScanKind
      summary: string
      risks: RiskItem[]
    }
  | {
      type: 'assistant-message'
      operationId: string
      content: string
    }
  | {
      type: 'audit-report'
      operationId: string
      report: CleanupAuditReport
    }
  | {
      type: 'cleanup-report'
      operationId: string
      report: CleanupReport
    }
  | {
      type: 'completed'
      operationId: string
      summary: string
      finishedAt: number
      operationUsage: TokenUsage
    }
  | {
      type: 'failed'
      operationId: string
      message: string
      finishedAt: number
      operationUsage: TokenUsage
    }
  | {
      type: 'cancelled'
      operationId: string
      finishedAt: number
      operationUsage: TokenUsage
      summary?: string
    }

export interface StartOperationResult {
  operationId: string
}

export interface CleanupInput {
  sourceScanKind: RiskScanKind
  sourceOperationId?: string
  steeringNotes?: string[]
  risks: RiskItem[]
  ignoredRisks?: RiskItem[]
  instructions: CleanupInstruction[]
}

export interface CleanupSteeringInput {
  operationId: string
  cleanup: CleanupInput
  message: string
}

export interface CleanupInstruction {
  riskId: string
  mode: CleanupActionMode
  instruction?: string
}

export interface ChatInput {
  message: string
  relatedRisks: RiskItem[]
  referencedPaths: PathReference[]
  operationMode?: boolean
}

export interface PcManagerApi {
  bootstrap(): Promise<BootstrapData>
  saveSettings(settings: SaveSettingsInput): Promise<AppSettings>
  startScan(kind: ScanKind, targets: ScanTarget[]): Promise<StartOperationResult>
  startCleanup(input: CleanupInput): Promise<StartOperationResult>
  sendChat(input: ChatInput): Promise<StartOperationResult>
  startSelfRepair(errorText: string): Promise<StartOperationResult>
  steerCleanup(input: CleanupSteeringInput): Promise<void>
  cancelOperation(operationId: string): Promise<void>
  resumeOperation(historyEntryId: string): Promise<StartOperationResult>
  testConnection(settings: Pick<SaveSettingsInput, 'provider' | 'model' | 'baseUrl' | 'apiKey'>): Promise<string>
  chooseDirectory(): Promise<ScanTarget | undefined>
  suggestPaths(query: string): Promise<PathSuggestion[]>
  listHistory(): Promise<OperationHistoryEntry[]>
  inspectMemory(): Promise<MemoryOverview>
  startMemoryAnalysis(): Promise<StartOperationResult>
  startMemoryOptimization(candidates: MemoryProcessCandidate[]): Promise<StartOperationResult>
  clearQuarantine(): Promise<QuarantineClearResult>
  createDesktopShortcut(): Promise<string>
  requestElevation(): Promise<boolean>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  onOperationEvent(listener: (event: OperationEvent) => void): () => void
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
  }
}

export const EMPTY_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
}
