import { hostname, platform, release } from 'node:os'
import { parse } from 'node:path'
import { spawn } from 'node:child_process'
import type { DiskVolume, SystemOverview } from '../shared/types.js'

function powershell(command: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      command,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('exit', code => {
      if (code === 0) resolvePromise(stdout.trim())
      else rejectPromise(new Error(stderr.trim() || `PowerShell exited with ${String(code)}`))
    })
  })
}

function volumeRecord(value: unknown): DiskVolume | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entry = value as Record<string, unknown>
  const name = typeof entry.Name === 'string' ? entry.Name : undefined
  const root = typeof entry.Root === 'string' ? entry.Root : undefined
  const totalBytes = typeof entry.TotalBytes === 'number' ? entry.TotalBytes : Number(entry.TotalBytes)
  const freeBytes = typeof entry.FreeBytes === 'number' ? entry.FreeBytes : Number(entry.FreeBytes)
  if (name === undefined || root === undefined || !Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) return undefined
  return { name, root, totalBytes: Math.max(0, totalBytes), freeBytes: Math.max(0, freeBytes) }
}

async function windowsVolumes(): Promise<DiskVolume[]> {
  const output = await powershell(`
$ErrorActionPreference = 'Stop'
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
  ForEach-Object { [pscustomobject]@{ Name=$_.VolumeName; Root=($_.DeviceID + '\\'); TotalBytes=[double]$_.Size; FreeBytes=[double]$_.FreeSpace } } |
  ConvertTo-Json -Compress
`)
  if (output.length === 0) return []
  const parsed = JSON.parse(output) as unknown
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries.map(volumeRecord).filter((entry): entry is DiskVolume => entry !== undefined)
}

async function windowsIsElevated(): Promise<boolean> {
  const output = await powershell("([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)")
  return output.trim().toLocaleLowerCase() === 'true'
}

export async function systemOverview(homePath: string, quarantinePath: string): Promise<SystemOverview> {
  const rootPath = parse(homePath).root || homePath
  let volumes: DiskVolume[] = []
  let isElevated = process.platform !== 'win32'
  if (process.platform === 'win32') {
    try {
      volumes = await windowsVolumes()
    } catch {
      volumes = []
    }
    try {
      isElevated = await windowsIsElevated()
    } catch {
      isElevated = false
    }
  }
  return {
    rootPath,
    hostname: hostname(),
    platformLabel: process.platform === 'win32' ? `Windows ${release()}` : `${platform()} ${release()}`,
    volumes,
    quarantinePath,
    isElevated,
  }
}
