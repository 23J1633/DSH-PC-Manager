import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import type { AgentPreset, AppSettings, ReasoningEffort, SaveSettingsInput, TokenUsage } from '../shared/types.js'
import { EMPTY_TOKEN_USAGE } from '../shared/types.js'

interface SettingsDocument {
  provider: string
  model: string
  reasoningEffort: ReasoningEffort
  baseUrl: string
  encryptedApiKey?: string
  theme: AppSettings['theme']
  fontScale: number
  uiScaleBasis: 125
  activePresetId: string
  customPresets: AgentPreset[]
  scanDepth: AppSettings['scanDepth']
  includeNetworkDrives: boolean
  quarantineRetentionDays: number
  telemetryEnabled: boolean
  lifetimeUsage: TokenUsage
}

const DEFAULT_DOCUMENT: SettingsDocument = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  baseUrl: 'https://api.deepseek.com',
  theme: 'system',
  fontScale: 1,
  uiScaleBasis: 125,
  activePresetId: 'balanced-cleaner',
  customPresets: [],
  scanDepth: 'standard',
  includeNetworkDrives: false,
  quarantineRetentionDays: 30,
  telemetryEnabled: false,
  lifetimeUsage: { ...EMPTY_TOKEN_USAGE },
}

function limitedText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed.length === 0 ? fallback : trimmed.slice(0, maxLength)
}

function normalizedBaseUrl(value: unknown): string {
  const text = limitedText(value, DEFAULT_DOCUMENT.baseUrl, 2048).replace(/\/+$/, '')
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_DOCUMENT.baseUrl
    return url.toString().replace(/\/$/, '')
  } catch {
    return DEFAULT_DOCUMENT.baseUrl
  }
}

function finiteToken(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizedUsage(value: unknown): TokenUsage {
  const usage = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return {
    inputTokens: finiteToken(usage.inputTokens),
    outputTokens: finiteToken(usage.outputTokens),
    totalTokens: finiteToken(usage.totalTokens),
    cacheReadTokens: finiteToken(usage.cacheReadTokens),
    cacheWriteTokens: finiteToken(usage.cacheWriteTokens),
    reasoningTokens: finiteToken(usage.reasoningTokens),
  }
}

function normalizedPresets(value: unknown): AgentPreset[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const presets: AgentPreset[] = []
  for (const candidate of value.slice(0, 20)) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const entry = candidate as Record<string, unknown>
    const id = limitedText(entry.id, '', 80).replace(/[^a-zA-Z0-9_-]/g, '-')
    const name = limitedText(entry.name, '', 60)
    const prompt = limitedText(entry.prompt, '', 12_000)
    if (id.length === 0 || name.length === 0 || prompt.length === 0 || ids.has(id)) continue
    ids.add(id)
    presets.push({
      id,
      name,
      description: limitedText(entry.description, '自定义清扫策略', 160),
      prompt,
      builtIn: false,
    })
  }
  return presets
}

function normalizeDocument(value: unknown): SettingsDocument {
  const input = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const encryptedApiKey = typeof input.encryptedApiKey === 'string' && input.encryptedApiKey.length > 0
    ? input.encryptedApiKey
    : undefined
  const legacyFontScale = typeof input.fontScale === 'number' && Number.isFinite(input.fontScale)
    ? input.fontScale
    : undefined
  const hasCurrentScaleBasis = input.uiScaleBasis === 125
  const relativeFontScale = hasCurrentScaleBasis
    ? legacyFontScale
    : legacyFontScale === undefined || Math.abs(legacyFontScale - 1.2) < 0.001
      ? 1
      : legacyFontScale / 1.25
  return {
    provider: limitedText(input.provider, DEFAULT_DOCUMENT.provider, 120),
    model: limitedText(input.model, DEFAULT_DOCUMENT.model, 200),
    reasoningEffort: input.reasoningEffort === 'off' || input.reasoningEffort === 'low' || input.reasoningEffort === 'max'
      ? input.reasoningEffort
      : 'high',
    baseUrl: normalizedBaseUrl(input.baseUrl),
    ...(encryptedApiKey === undefined ? {} : { encryptedApiKey }),
    theme: input.theme === 'light' || input.theme === 'dark' ? input.theme : 'system',
    fontScale: Math.min(1.25, Math.max(0.75, Math.round((relativeFontScale ?? DEFAULT_DOCUMENT.fontScale) * 20) / 20)),
    uiScaleBasis: 125,
    activePresetId: limitedText(input.activePresetId, DEFAULT_DOCUMENT.activePresetId, 80),
    customPresets: normalizedPresets(input.customPresets),
    scanDepth: input.scanDepth === 'deep' ? 'deep' : 'standard',
    includeNetworkDrives: input.includeNetworkDrives === true,
    quarantineRetentionDays: typeof input.quarantineRetentionDays === 'number'
      ? Math.min(365, Math.max(1, Math.round(input.quarantineRetentionDays)))
      : DEFAULT_DOCUMENT.quarantineRetentionDays,
    telemetryEnabled: input.telemetryEnabled === true,
    lifetimeUsage: normalizedUsage(input.lifetimeUsage),
  }
}

export class SettingsStore {
  private readonly path: string
  private document: SettingsDocument = structuredClone(DEFAULT_DOCUMENT)
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'settings.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    try {
      this.document = normalizeDocument(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    this.loaded = true
  }

  publicSettings(): AppSettings {
    this.assertLoaded()
    return {
      provider: this.document.provider,
      model: this.document.model,
      reasoningEffort: this.document.reasoningEffort,
      baseUrl: this.document.baseUrl,
      apiKeyConfigured: this.document.encryptedApiKey !== undefined || Boolean(process.env.DEEPSEEK_API_KEY),
      theme: this.document.theme,
      fontScale: this.document.fontScale,
      activePresetId: this.document.activePresetId,
      customPresets: structuredClone(this.document.customPresets),
      scanDepth: this.document.scanDepth,
      includeNetworkDrives: this.document.includeNetworkDrives,
      quarantineRetentionDays: this.document.quarantineRetentionDays,
      telemetryEnabled: this.document.telemetryEnabled,
    }
  }

  async save(input: SaveSettingsInput): Promise<AppSettings> {
    this.assertLoaded()
    return this.enqueue(async () => {
      const next = normalizeDocument({
        ...this.document,
        ...input,
        customPresets: input.customPresets,
        lifetimeUsage: this.document.lifetimeUsage,
      })
      if (input.clearApiKey === true) {
        delete next.encryptedApiKey
      } else if (input.apiKey !== undefined && input.apiKey.trim().length > 0) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('当前系统无法使用安全凭据存储，API Key 未保存。')
        }
        next.encryptedApiKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64')
      }
      this.document = next
      await this.persist()
      return this.publicSettings()
    })
  }

  apiKey(): string | undefined {
    this.assertLoaded()
    if (this.document.encryptedApiKey === undefined) return process.env.DEEPSEEK_API_KEY
    if (!safeStorage.isEncryptionAvailable()) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(this.document.encryptedApiKey, 'base64'))
    } catch {
      return undefined
    }
  }

  lifetimeUsage(): TokenUsage {
    this.assertLoaded()
    return { ...this.document.lifetimeUsage }
  }

  async addUsage(delta: TokenUsage): Promise<TokenUsage> {
    this.assertLoaded()
    return this.enqueue(async () => {
      const current = this.document.lifetimeUsage
      this.document.lifetimeUsage = {
        inputTokens: current.inputTokens + delta.inputTokens,
        outputTokens: current.outputTokens + delta.outputTokens,
        totalTokens: current.totalTokens + delta.totalTokens,
        cacheReadTokens: current.cacheReadTokens + delta.cacheReadTokens,
        cacheWriteTokens: current.cacheWriteTokens + delta.cacheWriteTokens,
        reasoningTokens: current.reasoningTokens + delta.reasoningTokens,
      }
      await this.persist()
      return this.lifetimeUsage()
    })
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('设置尚未加载')
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(task, task)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }
}
