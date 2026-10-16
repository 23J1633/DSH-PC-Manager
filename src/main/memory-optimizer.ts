import { spawn } from 'node:child_process'
import type { MemoryOptimizationResult, MemoryOverview, MemoryProcessCandidate } from '../shared/types.js'

const EXCLUDED_PROCESSES = new Set([
  'system', 'registry', 'csrss', 'services', 'lsass', 'winlogon', 'smss', 'wininit', 'svchost',
  'dwm', 'fontdrvhost', 'memory compression', 'secure system', 'msmpeng', 'mssense', 'nissrv',
])

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-1_000_000) })
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-12_000) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `PowerShell 退出码 ${String(code)}`))
      else resolve(stdout.trim())
    })
  })
}

function parseOverview(value: unknown): MemoryOverview {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const candidates = Array.isArray(record.candidates)
    ? record.candidates
    : record.candidates === undefined || record.candidates === null ? [] : [record.candidates]
  const processes: MemoryProcessCandidate[] = candidates.flatMap(candidate => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const process = candidate as Record<string, unknown>
    const pid = Number(process.pid)
    const memoryBytes = Number(process.memoryBytes)
    const name = typeof process.name === 'string' ? process.name.trim().slice(0, 160) : ''
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0 || name.length === 0) return []
    if (EXCLUDED_PROCESSES.has(name.toLocaleLowerCase())) return []
    return [{ pid, name, memoryBytes, reason: '当前工作集占用较高；回收后进程仍会运行，需要时可重新载入内存。' }]
  }).slice(0, 20)
  return {
    totalBytes: Number.isFinite(Number(record.totalBytes)) ? Math.max(0, Number(record.totalBytes)) : 0,
    availableBytes: Number.isFinite(Number(record.availableBytes)) ? Math.max(0, Number(record.availableBytes)) : 0,
    candidates: processes,
    checkedAt: Date.now(),
  }
}

export async function inspectMemory(): Promise<MemoryOverview> {
  if (process.platform !== 'win32') return { totalBytes: 0, availableBytes: 0, candidates: [], checkedAt: Date.now() }
  const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance Win32_OperatingSystem
$blocked = @('system','registry','csrss','services','lsass','winlogon','smss','wininit','svchost','dwm','fontdrvhost','memory compression','secure system','msmpeng','mssense','nissrv')
$items = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID -and $_.WorkingSet64 -ge 268435456 -and $blocked -notcontains $_.ProcessName.ToLowerInvariant() } | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 | ForEach-Object { [pscustomobject]@{ pid=[int]$_.Id; name=[string]$_.ProcessName; memoryBytes=[long]$_.WorkingSet64 } })
[pscustomobject]@{ totalBytes=[long]$os.TotalVisibleMemorySize * 1024; availableBytes=[long]$os.FreePhysicalMemory * 1024; candidates=$items } | ConvertTo-Json -Compress -Depth 4
`)
  return parseOverview(JSON.parse(output))
}

export async function optimizeMemory(requestedPids: readonly number[]): Promise<MemoryOptimizationResult> {
  if (process.platform !== 'win32') throw new Error('内存优化目前只支持 Windows')
  if (requestedPids.length === 0 || requestedPids.length > 40) throw new Error('请选择 1 至 40 个进程')
  const pids = [...new Set(requestedPids)]
  if (pids.length !== requestedPids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('进程列表无效')
  const idList = pids.join(',')
  const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
$ids = @(${idList})
$blocked = @('system','registry','csrss','services','lsass','winlogon','smss','wininit','svchost','dwm','fontdrvhost','memory compression','secure system','msmpeng','mssense','nissrv')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PcManagerMemoryApi {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("psapi.dll", SetLastError=true)] public static extern bool EmptyWorkingSet(IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
}
'@
$details = @()
foreach ($id in $ids) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($null -eq $p -or $blocked -contains $p.ProcessName.ToLowerInvariant()) {
    $details += [pscustomobject]@{ pid=[int]$id; name=''; beforeBytes=0; afterBytes=0; success=$false; message='进程已退出或属于受保护的系统进程。' }
    continue
  }
  $before = [long]$p.WorkingSet64
  $handle = [PcManagerMemoryApi]::OpenProcess(0x0100 -bor 0x0400, $false, [int]$id)
  if ($handle -eq [IntPtr]::Zero) {
    $details += [pscustomobject]@{ pid=[int]$id; name=$p.ProcessName; beforeBytes=$before; afterBytes=$before; success=$false; message='Windows 拒绝访问该进程，未作修改。' }
    continue
  }
  try { $ok = [PcManagerMemoryApi]::EmptyWorkingSet($handle); $winError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
  finally { [void][PcManagerMemoryApi]::CloseHandle($handle) }
  Start-Sleep -Milliseconds 120
  $p.Refresh()
  $after = [long]$p.WorkingSet64
  $details += [pscustomobject]@{ pid=[int]$id; name=$p.ProcessName; beforeBytes=$before; afterBytes=$after; success=[bool]$ok; message=$(if ($ok) { '已回收当前工作集中的非活动页面。' } else { "Windows API 失败，错误码 $winError。" }) }
}
[pscustomobject]@{ requested=$ids.Count; details=$details } | ConvertTo-Json -Compress -Depth 4
`)
  const record = JSON.parse(output) as { requested?: unknown; details?: unknown }
  const details = Array.isArray(record.details) ? record.details.flatMap(candidate => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const entry = candidate as Record<string, unknown>
    const pid = Number(entry.pid)
    const beforeBytes = Number(entry.beforeBytes)
    const afterBytes = Number(entry.afterBytes)
    if (!Number.isSafeInteger(pid)) return []
    return [{
      pid,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 160) : '',
      beforeBytes: Number.isFinite(beforeBytes) ? Math.max(0, beforeBytes) : 0,
      afterBytes: Number.isFinite(afterBytes) ? Math.max(0, afterBytes) : 0,
      success: entry.success === true,
      message: typeof entry.message === 'string' ? entry.message.slice(0, 500) : '未能读取优化结果。',
    }]
  }) : []
  return {
    requested: pids.length,
    optimized: details.filter(item => item.success).length,
    reclaimedBytes: details.reduce((total, item) => total + Math.max(0, item.beforeBytes - item.afterBytes), 0),
    details,
  }
}
