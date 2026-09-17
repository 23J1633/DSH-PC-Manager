import { createServer, type IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { addTokenUsage, DshRuntime, sessionEventFromNotification, tokenUsageFromEvent } from '../src/main/dsh-runtime.js'
import { OperationController } from '../src/main/operation-controller.js'
import { cleanupAuditPrompt, cleanupPrompt } from '../src/main/prompt-library.js'
import { parseCleanupAuditReport, parseCleanupReport, parseScanReport } from '../src/main/result-parser.js'
import type { SettingsStore } from '../src/main/settings-store.js'
import { EMPTY_TOKEN_USAGE, type AppSettings, type OperationEvent, type RiskItem, type TokenUsage } from '../src/shared/types.js'

const require = createRequire(import.meta.url)
const electronExecutable = require('electron') as string

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : []
  return tools.flatMap(tool => {
    if (typeof tool !== 'object' || tool === null) return []
    const fn = (tool as Record<string, unknown>).function
    if (typeof fn !== 'object' || fn === null) return []
    const name = (fn as Record<string, unknown>).name
    return typeof name === 'string' ? [name] : []
  })
}

function sse(response: import('node:http').ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  response.end('data: [DONE]\n\n')
}

describe('real DSH runtime in an isolated fixture', () => {
  const temporaryRoots: string[] = []

  afterEach(async () => {
    for (const root of temporaryRoots.splice(0)) {
      if (!root.startsWith(resolve(tmpdir()))) throw new Error(`Refusing to remove non-temporary path: ${root}`)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs PowerShell through DSH, blocks a write, reads the fixture, and reports token use', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pc-manager-fixture-'))
    temporaryRoots.push(root)
    const scope = join(root, 'selected-scope')
    await mkdir(scope)
    const fixtureFile = join(scope, 'cache.tmp')
    const blockedFile = join(scope, 'must-not-exist.txt')
    await writeFile(fixtureFile, 'temporary fixture content', 'utf8')
    const modelRequests: Record<string, unknown>[] = []
    let call = 0
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(404).end()
        return
      }
      const body = await requestBody(request)
      modelRequests.push(body)
      const tools = toolNames(body)
      const shellTool = tools.find(name => name.toLocaleLowerCase().includes('pwsh')) ?? tools.find(name => name.toLocaleLowerCase().includes('bash'))
      call += 1
      if (call <= 2 && shellTool !== undefined) {
        const isWriteAttempt = call === 1
        const command = process.platform === 'win32'
          ? isWriteAttempt
            ? `Set-Content -LiteralPath '${blockedFile.replaceAll("'", "''")}' -Value 'blocked'`
            : `Get-ChildItem -LiteralPath '${scope.replaceAll("'", "''")}' -Force | Select-Object Name,Length | ConvertTo-Json -Compress`
          : isWriteAttempt
            ? `printf blocked > ${JSON.stringify(blockedFile)}`
            : `find ${JSON.stringify(scope)} -maxdepth 1 -type f -printf '%f %s\\n'`
        sse(response, [
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `fixture-${call}`,
                  type: 'function',
                  function: {
                    name: shellTool,
                    arguments: JSON.stringify({
                      command,
                      description: isWriteAttempt ? 'Attempt isolated fixture write' : 'List isolated fixture files',
                    }),
                  },
                }],
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 2 } },
        ])
        return
      }
      const finalText = `模拟扫描完成。\n<dsh-pc-manager-result>${JSON.stringify({
        summary: '隔离目录扫描完成，发现一个模拟缓存文件。',
        risks: [{
          id: 'fixture-cache',
          kind: 'file',
          name: '模拟缓存文件',
          target: fixtureFile,
          description: '仅用于集成测试的临时文件',
          reason: '测试夹具明确标记为可再生缓存',
          severity: 'low',
          sizeBytes: 25,
          recommendedAction: '测试结束后删除临时夹具',
          evidence: ['PowerShell 目录读取返回 cache.tmp'],
          selectedByDefault: true,
          reversible: true,
          cleanupHint: '仅处理该精确路径',
        }],
      })}</dsh-pc-manager-result>`
      sse(response, [
        { choices: [{ delta: { content: finalText } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5 } },
      ])
    })
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Mock model server did not bind a port')

    const runtime = new DshRuntime({
      cwd: scope,
      dshHome: join(root, 'dsh-home'),
      patchPath: resolve('resources/dsh/pc-manager.patch.yml'),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      apiKey: 'isolated-test-key',
      baseUrl: `http://127.0.0.1:${address.port}`,
      permissionMode: 'read-only',
      telemetryEnabled: false,
      maxTokens: 1024,
      runtimeExecutable: electronExecutable,
      initializeTimeoutMs: 180_000,
    })

    try {
      const result = await runtime.run('只检查当前测试目录。先尝试测试命令，再列出目录并返回结构化风险。')
      const report = parseScanReport(result.finalResponse, 'disk')
      expect(report.risks).toHaveLength(1)
      expect(report.risks[0]?.target).toBe(fixtureFile)
      expect(await readFile(fixtureFile, 'utf8')).toBe('temporary fixture content')
      await expect(stat(blockedFile)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(modelRequests.length).toBeGreaterThanOrEqual(3)
      const serializedRequests = JSON.stringify(modelRequests)
      expect(serializedRequests).toContain('"reasoning_effort":"high"')
      expect(serializedRequests).toContain('file access denied under read-only mode')
      expect(serializedRequests).toContain('cache.tmp')
      let usage: TokenUsage = { ...EMPTY_TOKEN_USAGE }
      for (const notification of result.notifications) {
        const event = sessionEventFromNotification(notification)
        if (event === undefined) continue
        const delta = tokenUsageFromEvent(event)
        if (delta !== undefined) usage = addTokenUsage(usage, delta)
      }
      expect(usage.totalTokens).toBeGreaterThan(0)
    } finally {
      await runtime.close(true)
      await new Promise<void>(resolvePromise => server.close(() => { resolvePromise() }))
    }
  }, 240_000)

  it('keeps audit read-only, then quarantines one audited fixture in a separate cleanup runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pc-manager-audit-fixture-'))
    temporaryRoots.push(root)
    const scope = join(root, 'selected-scope')
    const quarantine = join(root, 'quarantine')
    await mkdir(scope)
    await mkdir(quarantine)
    const candidate = join(scope, 'audited-cache.tmp')
    const quarantined = join(quarantine, 'audited-cache.tmp')
    await writeFile(candidate, 'audited fixture data', 'utf8')
    const risk: RiskItem = {
      id: 'audited-fixture',
      scanKind: 'disk',
      kind: 'file',
      name: '审核模拟缓存',
      target: candidate,
      description: '隔离集成测试文件',
      reason: '测试夹具明确标记为可再生缓存',
      severity: 'low',
      sizeBytes: 20,
      recommendedAction: '移动到隔离区',
      evidence: ['测试夹具由用例创建'],
      selectedByDefault: true,
      reversible: true,
      cleanupHint: '仅移动该精确文件',
    }
    let auditCalls = 0
    let cleanupCalls = 0
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(404).end()
        return
      }
      const body = await requestBody(request)
      const serialized = JSON.stringify(body)
      const tools = toolNames(body)
      const shellTool = tools.find(name => name.toLocaleLowerCase().includes('pwsh'))
      if (serialized.includes('独立清理审核 Agent')) {
        auditCalls += 1
        if (auditCalls === 1 && shellTool !== undefined) {
          const command = `Get-Item -LiteralPath '${candidate.replaceAll("'", "''")}' | Select-Object FullName,Length,LastWriteTime | ConvertTo-Json -Compress`
          sse(response, [
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'audit-read',
                    type: 'function',
                    function: {
                      name: shellTool,
                      arguments: JSON.stringify({ command, description: 'Inspect audited fixture file' }),
                    },
                  }],
                },
              }],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 2 } },
          ])
          return
        }
        const text = `<dsh-pc-manager-audit>${JSON.stringify({
          summary: '模拟审核确认目标身份未变化且可逆。',
          decisions: [{
            id: risk.id,
            verdict: 'allow',
            reason: '精确文件存在，且仅为测试夹具。',
            constraints: [`只允许移动 ${candidate} 到 ${quarantined}`],
          }],
          globalWarnings: [],
        })}</dsh-pc-manager-audit>`
        sse(response, [
          { choices: [{ delta: { content: text } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
        ])
        return
      }
      if (serialized.includes('二次研判与清理')) {
        cleanupCalls += 1
        if (cleanupCalls === 1 && shellTool !== undefined) {
          const command = `Move-Item -LiteralPath '${candidate.replaceAll("'", "''")}' -Destination '${quarantined.replaceAll("'", "''")}'`
          sse(response, [
            {
              choices: [{
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: 'cleanup-move',
                    type: 'function',
                    function: {
                      name: shellTool,
                      arguments: JSON.stringify({ command, description: 'Quarantine audited fixture file' }),
                    },
                  }],
                },
              }],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
          ])
          return
        }
        const text = `<dsh-pc-manager-cleanup>${JSON.stringify({
          summary: '模拟文件已移动到隔离区。',
          results: [{
            id: risk.id,
            status: 'quarantined',
            action: '移动到隔离区',
            detail: '精确目标已移动，原路径不存在。',
            restorePath: quarantined,
          }],
          rebootRecommended: false,
          followup: [],
        })}</dsh-pc-manager-cleanup>`
        sse(response, [
          { choices: [{ delta: { content: text } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } },
        ])
        return
      }
      response.writeHead(400).end('Unexpected prompt')
    })
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Mock model server did not bind a port')
    const common = {
      cwd: scope,
      dshHome: join(root, 'dsh-home'),
      patchPath: resolve('resources/dsh/pc-manager.patch.yml'),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      apiKey: 'isolated-test-key',
      baseUrl: `http://127.0.0.1:${address.port}`,
      telemetryEnabled: false,
      maxTokens: 1024,
      runtimeExecutable: electronExecutable,
      initializeTimeoutMs: 180_000,
    } as const
    let auditRuntime: DshRuntime | undefined
    let cleanupRuntime: DshRuntime | undefined
    try {
      auditRuntime = new DshRuntime({ ...common, permissionMode: 'read-only' })
      const auditResult = await auditRuntime.run(cleanupAuditPrompt({
        rootPath: scope,
        quarantinePath: quarantine,
        presetPrompt: '证据不足时拒绝放行。',
        sourceScanKind: 'disk',
        risks: [risk],
        instructions: [{ riskId: risk.id, mode: 'quarantine' }],
      }))
      const audit = parseCleanupAuditReport(auditResult.finalResponse, [risk])
      expect(audit.decisions).toEqual([expect.objectContaining({ id: risk.id, verdict: 'allow' })])
      expect(await readFile(candidate, 'utf8')).toBe('audited fixture data')
      await auditRuntime.close()
      auditRuntime = undefined

      cleanupRuntime = new DshRuntime({ ...common, permissionMode: 'danger-full-access' })
      const cleanupResult = await cleanupRuntime.run(cleanupPrompt({
        rootPath: scope,
        quarantinePath: quarantine,
        presetPrompt: '只执行已审核的精确动作。',
        sourceScanKind: 'disk',
        risks: [risk],
        instructions: [{ riskId: risk.id, mode: 'quarantine' }],
        auditReport: audit,
      }))
      const report = parseCleanupReport(cleanupResult.finalResponse, [risk])
      expect(report.results).toEqual([expect.objectContaining({ id: risk.id, status: 'quarantined', restorePath: quarantined })])
      await expect(stat(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(quarantined, 'utf8')).toBe('audited fixture data')
      expect(auditCalls).toBe(2)
      expect(cleanupCalls).toBe(2)
    } finally {
      await auditRuntime?.close(true)
      await cleanupRuntime?.close(true)
      await new Promise<void>(resolvePromise => server.close(() => { resolvePromise() }))
    }
  }, 240_000)

  it('runs the planning phase before scanning and publishes plan-based progress', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pc-manager-plan-fixture-'))
    temporaryRoots.push(root)
    const scope = join(root, 'selected-scope')
    const dshHome = join(root, 'dsh-home')
    const quarantine = join(root, 'quarantine')
    await mkdir(scope)
    await writeFile(join(scope, 'fixture.tmp'), 'plan fixture', 'utf8')
    let executionCalls = 0
    let executionPromptIncludedPlan = false
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(404).end()
        return
      }
      const body = await requestBody(request)
      const serialized = JSON.stringify(body)
      if (serialized.includes('扫描计划模式')) {
        const text = `<dsh-pc-manager-plan>${JSON.stringify({
          summary: '先确认范围，再核验缓存，最后整理结果。',
          steps: [
            { id: 'scope', title: '确认范围', description: '读取测试范围', expectedTools: 1 },
            { id: 'cache', title: '核验缓存', description: '检查模拟缓存', expectedTools: 1 },
            { id: 'report', title: '整理结果', description: '输出风险清单', expectedTools: 1 },
          ],
        })}</dsh-pc-manager-plan>`
        sse(response, [
          { choices: [{ delta: { content: text } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4 } },
        ])
        return
      }
      if (serialized.includes('硬盘清理扫描')) {
        executionPromptIncludedPlan ||= serialized.includes('确认范围') && serialized.includes('核验缓存')
        executionCalls += 1
        const shellTool = toolNames(body).find(name => name.toLocaleLowerCase().includes('pwsh'))
        if (executionCalls === 1 && shellTool !== undefined) {
          sse(response, [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'plan-read', type: 'function', function: { name: shellTool, arguments: JSON.stringify({ command: `Get-ChildItem -LiteralPath '${scope.replaceAll("'", "''")}' | Select-Object Name,Length | ConvertTo-Json -Compress`, description: 'Inspect planned fixture scope' }) } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 9, completion_tokens: 2 } },
          ])
          return
        }
        const text = `<dsh-pc-manager-result>${JSON.stringify({
          summary: '计划扫描完成。',
          risks: [
            { id: 'low-plan', kind: 'file', name: '低风险缓存', target: join(scope, 'fixture.tmp'), description: '模拟缓存', reason: '测试', severity: 'low', sizeBytes: 12, recommendedAction: '隔离', evidence: ['fixture'], selectedByDefault: true, reversible: true },
            { id: 'high-plan', kind: 'file', name: '高风险测试项', target: join(scope, 'other.tmp'), description: '排序测试', reason: '测试', severity: 'high', recommendedAction: '人工确认', evidence: ['fixture'], selectedByDefault: false, reversible: true },
          ],
        })}</dsh-pc-manager-result>`
        sse(response, [
          { choices: [{ delta: { content: text } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 5 } },
        ])
        return
      }
      response.writeHead(400).end('Unexpected prompt')
    })
    await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Mock model server did not bind a port')
    const settings: AppSettings = {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', baseUrl: `http://127.0.0.1:${address.port}`, apiKeyConfigured: true,
      theme: 'system', fontScale: 1.2, activePresetId: 'balanced-cleaner', customPresets: [], scanDepth: 'standard', includeNetworkDrives: false,
      quarantineRetentionDays: 30, telemetryEnabled: false,
    }
    let lifetime = { ...EMPTY_TOKEN_USAGE }
    const fakeStore = {
      publicSettings: () => structuredClone(settings),
      apiKey: () => 'isolated-test-key',
      addUsage: async (delta: TokenUsage) => {
        lifetime = addTokenUsage(lifetime, delta)
        return { ...lifetime }
      },
    } as unknown as SettingsStore
    const events: OperationEvent[] = []
    let resolveFinished!: () => void
    let rejectFinished!: (error: Error) => void
    const finished = new Promise<void>((resolvePromise, rejectPromise) => {
      resolveFinished = resolvePromise
      rejectFinished = rejectPromise
    })
    const controller = new OperationController(fakeStore, {
      rootPath: scope,
      dshHome,
      quarantinePath: quarantine,
      patchPath: resolve('resources/dsh/pc-manager.patch.yml'),
      runtimeExecutable: electronExecutable,
    }, event => {
      events.push(event)
      if (event.type === 'completed') resolveFinished()
      if (event.type === 'failed') rejectFinished(new Error(event.message))
    })
    try {
      const operationId = await controller.startScan('disk', [{ type: 'directory', path: scope, label: '计划测试目录' }])
      await finished
      expect(events[0]).toMatchObject({ type: 'started', operationId, model: settings.model })
      const planIndex = events.findIndex(event => event.type === 'plan')
      const toolIndex = events.findIndex(event => event.type === 'tool')
      const risksEvent = events.find(event => event.type === 'risks')
      expect(planIndex).toBeGreaterThan(0)
      expect(toolIndex).toBeGreaterThan(planIndex)
      expect(events.some(event => event.type === 'progress' && event.planStepId !== undefined)).toBe(true)
      expect(risksEvent?.type === 'risks' ? risksEvent.risks.map(risk => risk.severity) : []).toEqual(['high', 'low'])
      expect(executionPromptIncludedPlan).toBe(true)
    } finally {
      await controller.close()
      await new Promise<void>(resolvePromise => server.close(() => { resolvePromise() }))
    }
  }, 240_000)
})
