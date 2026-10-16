import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import type { InstalledSoftwareItem, ScanTarget } from '../shared/types.js'

interface RegistrySoftwareRow {
  registryPath: string
  name: string
  publisher: string
  version: string
  installDate: string
  installLocation: string
  sizeBytes: number
  uninstallCommand: string
  quietUninstallCommand: string
  modifyCommand: string
}

export interface InstalledSoftwareRecord extends InstalledSoftwareItem {
  registryPath: string
  uninstallCommand: string
  quietUninstallCommand: string
  modifyCommand: string
}

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
    child.stdout.on('data', (chunk: string) => { stdout = `${stdout}${chunk}`.slice(-2_000_000) })
    child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-16_000) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `PowerShell 退出码 ${String(code)}`))
      else resolve(stdout.trim())
    })
  })
}

function rowsFromJson(output: string): RegistrySoftwareRow[] {
  if (output.length === 0) return []
  const parsed: unknown = JSON.parse(output)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap(candidate => {
    if (typeof candidate !== 'object' || candidate === null) return []
    const value = candidate as Record<string, unknown>
    if (typeof value.registryPath !== 'string' || typeof value.name !== 'string' || typeof value.installLocation !== 'string') return []
    return [{
      registryPath: value.registryPath,
      name: value.name,
      publisher: typeof value.publisher === 'string' ? value.publisher : '',
      version: typeof value.version === 'string' ? value.version : '',
      installDate: typeof value.installDate === 'string' ? value.installDate : '',
      installLocation: value.installLocation,
      sizeBytes: Number.isSafeInteger(Number(value.sizeBytes)) ? Math.max(0, Number(value.sizeBytes)) : 0,
      uninstallCommand: typeof value.uninstallCommand === 'string' ? value.uninstallCommand : '',
      quietUninstallCommand: typeof value.quietUninstallCommand === 'string' ? value.quietUninstallCommand : '',
      modifyCommand: typeof value.modifyCommand === 'string' ? value.modifyCommand : '',
    }]
  })
}

function applicationId(row: Pick<RegistrySoftwareRow, 'registryPath' | 'name'>): string {
  return createHash('sha256').update(`${row.registryPath.toLocaleLowerCase()}\0${row.name.toLocaleLowerCase()}`).digest('hex').slice(0, 16)
}

function isInside(target: ScanTarget, location: string): boolean {
  const root = win32.resolve(target.path).toLocaleLowerCase()
  const candidate = win32.resolve(location).toLocaleLowerCase()
  const relativePath = win32.relative(root, candidate)
  return relativePath === '' || (!relativePath.startsWith('..\\') && relativePath !== '..' && !win32.isAbsolute(relativePath))
}

export async function listInstalledSoftware(): Promise<InstalledSoftwareRecord[]> {
  if (process.platform !== 'win32') return []
  const output = await runPowerShell(`
$ErrorActionPreference = 'SilentlyContinue'
$uninstallRoots = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$rows = @(
  foreach ($root in $uninstallRoots) {
    Get-ItemProperty -Path $root | Where-Object {
      $_.DisplayName -and $_.InstallLocation -and $_.SystemComponent -ne 1 -and $_.NoRemove -ne 1 -and $_.ReleaseType -notmatch 'Update|Hotfix|Security'
    } | ForEach-Object {
      [pscustomobject]@{
        registryPath=[string]$_.PSPath
        name=[string]$_.DisplayName
        publisher=[string]$_.Publisher
        version=[string]$_.DisplayVersion
        installDate=[string]$_.InstallDate
        installLocation=[string]$_.InstallLocation
        sizeBytes=[long]$_.EstimatedSize * 1024
        uninstallCommand=[string]$_.UninstallString
        quietUninstallCommand=[string]$_.QuietUninstallString
        modifyCommand=[string]$_.ModifyPath
      }
    }
  }
)
$rows | ConvertTo-Json -Compress -Depth 3
`)
  return rowsFromJson(output).map(row => ({
    id: applicationId(row),
    name: row.name.trim().slice(0, 240),
    publisher: row.publisher.trim().slice(0, 200),
    version: row.version.trim().slice(0, 120),
    ...(row.installDate.length === 0 ? {} : { installDate: row.installDate.slice(0, 30) }),
    installLocation: row.installLocation.trim().slice(0, 4096),
    sizeBytes: row.sizeBytes,
    uninstallAvailable: row.uninstallCommand.trim().length > 0,
    maintenanceAvailable: row.modifyCommand.trim().length > 0,
    registryPath: row.registryPath.slice(0, 1000),
    uninstallCommand: row.uninstallCommand.trim().slice(0, 4096),
    quietUninstallCommand: row.quietUninstallCommand.trim().slice(0, 4096),
    modifyCommand: row.modifyCommand.trim().slice(0, 4096),
  })).filter(record => record.name.length > 0 && record.installLocation.length > 0)
}

export async function installedSoftwareForTargets(targets: readonly ScanTarget[]): Promise<InstalledSoftwareItem[]> {
  if (process.platform !== 'win32') return []
  const records = await listInstalledSoftware()
  return records
    .filter(record => record.sizeBytes >= 256 * 1024 ** 2 && targets.some(target => isInside(target, record.installLocation)))
    .sort((left, right) => right.sizeBytes - left.sizeBytes)
    .slice(0, 120)
    .map(({ id, name, publisher, version, installDate, installLocation, sizeBytes, uninstallAvailable, maintenanceAvailable }) => ({
      id, name, publisher, version,
      ...(installDate === undefined ? {} : { installDate }),
      installLocation,
      sizeBytes,
      uninstallAvailable,
      maintenanceAvailable,
    }))
}
