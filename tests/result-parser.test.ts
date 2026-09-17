import { describe, expect, it } from 'vitest'
import { cleanupAuditPrompt, diskScanPrompt } from '../src/main/prompt-library.js'
import { parseCleanupAuditReport, parseCleanupReport, parseOperationPlan, parseScanReport } from '../src/main/result-parser.js'
import type { RiskItem } from '../src/shared/types.js'

const risk: RiskItem = {
  id: 'disk-cache-1',
  scanKind: 'disk',
  kind: 'directory',
  name: '模拟缓存',
  target: 'C:\\fixture\\cache',
  description: '测试缓存目录',
  reason: '内容可再生',
  severity: 'low',
  sizeBytes: 1024,
  recommendedAction: '隔离后清理',
  evidence: ['仅包含 .tmp 文件'],
  selectedByDefault: true,
  reversible: true,
}

describe('structured Agent result parsing', () => {
  it('parses a visible Agent scan plan', () => {
    const plan = parseOperationPlan(`<dsh-pc-manager-plan>${JSON.stringify({
      summary: '先建立基线，再核验证据。',
      steps: [
        { id: 'baseline', title: '建立基线', description: '读取范围元数据', expectedTools: 2 },
        { id: 'inspect', title: '检查目标', description: '核验候选项', expectedTools: 4 },
        { id: 'report', title: '整理结果', description: '生成风险清单', expectedTools: 1 },
      ],
    })}</dsh-pc-manager-plan>`)
    expect(plan.source).toBe('agent')
    expect(plan.steps.map(step => step.id)).toEqual(['baseline', 'inspect', 'report'])
  })

  it('normalizes a scoped scan report', () => {
    const report = parseScanReport(`完成。\n<dsh-pc-manager-result>${JSON.stringify({
      summary: '发现一个缓存目录',
      risks: [{
        ...risk,
        scanKind: undefined,
      }],
    })}</dsh-pc-manager-result>`, 'disk')
    expect(report.summary).toBe('发现一个缓存目录')
    expect(report.risks).toHaveLength(1)
    expect(report.risks[0]).toMatchObject({ id: risk.id, scanKind: 'disk', target: risk.target })
  })

  it('sorts scan findings from critical to low risk', () => {
    const report = parseScanReport(`<dsh-pc-manager-result>${JSON.stringify({
      summary: '排序测试',
      risks: [
        { ...risk, id: 'low', severity: 'low' },
        { ...risk, id: 'critical', target: 'C:\\fixture\\critical', severity: 'critical' },
        { ...risk, id: 'high', target: 'C:\\fixture\\high', severity: 'high' },
      ],
    })}</dsh-pc-manager-result>`, 'disk')
    expect(report.risks.map(item => item.severity)).toEqual(['critical', 'high', 'low'])
  })

  it('fails closed when an audit omits an authorized item', () => {
    const second = { ...risk, id: 'disk-cache-2', target: 'C:\\fixture\\other' }
    const report = parseCleanupAuditReport(`<dsh-pc-manager-audit>${JSON.stringify({
      summary: '审核完成',
      decisions: [{ id: risk.id, verdict: 'allow', reason: '目标清晰', constraints: ['只移动该目录'] }],
      globalWarnings: [],
    })}</dsh-pc-manager-audit>`, [risk, second])
    expect(report.decisions).toEqual([
      expect.objectContaining({ id: risk.id, verdict: 'allow' }),
      expect.objectContaining({ id: second.id, verdict: 'manual' }),
    ])
  })

  it('fills a missing cleanup result as failed', () => {
    const report = parseCleanupReport(`<dsh-pc-manager-cleanup>${JSON.stringify({
      summary: '未执行',
      results: [],
      rebootRecommended: false,
      followup: [],
    })}</dsh-pc-manager-cleanup>`, [risk])
    expect(report.results[0]).toMatchObject({ id: risk.id, status: 'failed' })
  })
})

describe('safety prompts', () => {
  it('locks disk discovery to the selected directory', () => {
    const prompt = diskScanPrompt({
      rootPath: 'C:\\',
      presetPrompt: '保守扫描',
      scanDepth: 'standard',
      includeNetworkDrives: false,
      targets: [{ type: 'directory', path: 'C:\\fixture', label: '模拟目录' }],
    })
    expect(prompt).toContain('"path": "C:\\\\fixture"')
    expect(prompt).toContain('唯一允许的文件扫描边界')
    expect(prompt).toContain('不得自行扩展')
  })

  it('requires the auditor to decide every selected item', () => {
    const prompt = cleanupAuditPrompt({
      rootPath: 'C:\\',
      quarantinePath: 'C:\\quarantine',
      presetPrompt: '保守审核',
      sourceScanKind: 'disk',
      risks: [risk],
      instructions: [{ riskId: risk.id, mode: 'quarantine' }],
    })
    expect(prompt).toContain('独立清理审核 Agent')
    expect(prompt).toContain('每个用户授权 id 必须恰好给出一次决定')
    expect(prompt).toContain(risk.id)
  })
})
