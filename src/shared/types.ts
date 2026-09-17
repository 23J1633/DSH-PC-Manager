export type ScanKind = 'disk' | 'virus'
export type OperationKind = ScanKind | 'cleanup' | 'chat' | 'connection-test'
export type OperationState = 'idle' | 'starting' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
export type Severity = 'low' | 'medium' | 'high' | 'critical'
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'
export type CleanupActionMode = 'recommended' | 'ignore' | 'quarantine' | 'manual'

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
  | 'other'

export interface RiskItem {
  id: string
  scanKind: ScanKind
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
  isElevated: boolean
}

export interface BootstrapData {
  appVersion: string
  settings: AppSettings
  system: SystemOverview
  lifetimeUsage: TokenUsage
  builtInPresets: AgentPreset[]
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
      type: 'tokens'
      operationId: string
      operationUsage: TokenUsage
      lifetimeUsage: TokenUsage
    }
  | {
      type: 'risks'
      operationId: string
      scanKind: ScanKind
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
    }

export interface StartOperationResult {
  operationId: string
}

export interface CleanupInput {
  sourceScanKind: ScanKind
  risks: RiskItem[]
  ignoredRisks?: RiskItem[]
  instructions: CleanupInstruction[]
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
}

export interface PcManagerApi {
  bootstrap(): Promise<BootstrapData>
  saveSettings(settings: SaveSettingsInput): Promise<AppSettings>
  startScan(kind: ScanKind, targets: ScanTarget[]): Promise<StartOperationResult>
  startCleanup(input: CleanupInput): Promise<StartOperationResult>
  sendChat(input: ChatInput): Promise<StartOperationResult>
  cancelOperation(operationId: string): Promise<void>
  testConnection(settings: Pick<SaveSettingsInput, 'provider' | 'model' | 'baseUrl' | 'apiKey'>): Promise<string>
  chooseDirectory(): Promise<ScanTarget | undefined>
  suggestPaths(query: string): Promise<PathSuggestion[]>
  listHistory(): Promise<OperationHistoryEntry[]>
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
