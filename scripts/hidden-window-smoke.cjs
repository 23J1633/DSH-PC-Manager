const { spawn } = require('node:child_process')
const { join, resolve } = require('node:path')

const projectRoot = resolve(__dirname, '..')

function wait(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function run(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('exit', code => { resolvePromise({ code, stdout, stderr }) })
  })
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Hidden-window smoke skipped: Windows only')
    return
  }
  const powershellPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const monitorScript = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$names = @('powershell','pwsh','cmd','conhost','OpenConsole','WindowsTerminal')
$baseline = @{}
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $baseline["$($_.Id):$($_.MainWindowHandle)"] = $true }
$reported = @{}
while ($true) {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $names -contains $_.ProcessName } | ForEach-Object {
    $key = "$($_.Id):$($_.MainWindowHandle)"
    if (-not $baseline.ContainsKey($key) -and -not $reported.ContainsKey($key)) {
      $reported[$key] = $true
      [Console]::Out.WriteLine(([pscustomobject]@{ pid=$_.Id; name=$_.ProcessName; title=$_.MainWindowTitle; handle=$_.MainWindowHandle } | ConvertTo-Json -Compress))
    }
  }
  Start-Sleep -Milliseconds 20
}`
  const encodedMonitor = Buffer.from(monitorScript, 'utf16le').toString('base64')
  const monitor = spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedMonitor], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let visibleWindows = ''
  monitor.stdout.setEncoding('utf8')
  monitor.stdout.on('data', chunk => { visibleWindows += chunk })
  await wait(700)
  const vitest = spawn(process.execPath, [join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/dsh-runtime.integration.test.ts'], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await run(vitest)
  monitor.kill()
  await wait(200)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  if (result.code !== 0) throw new Error(`DSH integration smoke failed with exit code ${String(result.code)}`)
  const unexpected = visibleWindows.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (unexpected.length > 0) throw new Error(`Detected visible terminal windows during DSH operations:\n${unexpected.join('\n')}`)
  console.log('Hidden-window smoke passed: no new visible PowerShell/cmd/console window was detected')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
