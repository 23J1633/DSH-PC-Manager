const { app, safeStorage } = require('electron')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

app.whenReady().then(async () => {
  const projectRoot = resolve(__dirname, '..')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-pc-manager-settings-'))
  try {
    const moduleUrl = pathToFileURL(join(projectRoot, 'dist-electron', 'src', 'main', 'settings-store.js')).href
    const { SettingsStore } = await import(moduleUrl)
    const store = new SettingsStore(temporary)
    await store.load()
    const defaults = store.publicSettings()
    assert(defaults.theme === 'system', 'Default theme was not system')
    assert(defaults.fontScale === 1, 'Default relative font scale was not 100%')
    assert(defaults.reasoningEffort === 'high', 'Default reasoning effort was not high')

    const customPreset = {
      id: 'smoke-preset',
      name: '设置测试预设',
      description: '用于隔离设置测试',
      prompt: '只处理测试夹具。',
      builtIn: false,
    }
    const input = {
      provider: 'smoke-provider',
      model: 'smoke-model',
      reasoningEffort: 'max',
      baseUrl: 'http://127.0.0.1:31337/v1/',
      theme: 'light',
      fontScale: 1.15,
      activePresetId: customPreset.id,
      customPresets: [customPreset],
      scanDepth: 'deep',
      includeNetworkDrives: true,
      quarantineRetentionDays: 45,
      telemetryEnabled: true,
      ...(safeStorage.isEncryptionAvailable() ? { apiKey: 'smoke-secret-key' } : {}),
    }
    const saved = await store.save(input)
    assert(saved.theme === 'light' && saved.fontScale === 1.15, 'Theme/font scale did not save')
    assert(saved.scanDepth === 'deep' && saved.includeNetworkDrives, 'Scan options did not save')
    assert(saved.quarantineRetentionDays === 45 && saved.telemetryEnabled, 'Security/privacy options did not save')
    assert(saved.customPresets.length === 1 && saved.activePresetId === customPreset.id, 'Custom preset did not save')
    if (safeStorage.isEncryptionAvailable()) assert(store.apiKey() === 'smoke-secret-key', 'Encrypted API Key did not round trip')

    await Promise.all([
      store.addUsage({ inputTokens: 10, outputTokens: 4, totalTokens: 14, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 }),
      store.save({ ...input, theme: 'dark', fontScale: 1.25, apiKey: '' }),
    ])
    const reloaded = new SettingsStore(temporary)
    await reloaded.load()
    const persisted = reloaded.publicSettings()
    assert(persisted.theme === 'dark' && persisted.fontScale === 1.25, 'Concurrent autosave lost the final appearance settings')
    assert(reloaded.lifetimeUsage().totalTokens === 14, 'Concurrent autosave lost token usage')
    assert(persisted.model === 'smoke-model' && persisted.provider === 'smoke-provider', 'Model settings did not persist')
    assert(persisted.reasoningEffort === 'max', 'Reasoning effort did not persist')
    console.log('Settings smoke passed: appearance, model, scan, preset, privacy, credential, and token settings')
  } finally {
    if (!temporary.startsWith(resolve(tmpdir()))) throw new Error(`Refusing to remove non-temporary path: ${temporary}`)
    await rm(temporary, { recursive: true, force: true })
  }
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
