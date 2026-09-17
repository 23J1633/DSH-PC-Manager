import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('DSH Windows child-process patch', () => {
  it('hides the runner plus full-access and restricted console targets', async () => {
    const subprocessManifest = require.resolve('@deepseek-ai/dsh-subprocess-local/package.json')
    const win32Manifest = require.resolve('@deepseek-ai/dsh-win32-process/package.json')
    const subprocessSource = await readFile(join(dirname(subprocessManifest), 'lib', 'index.js'), 'utf8')
    const win32Source = await readFile(join(dirname(win32Manifest), 'lib', 'index.js'), 'utf8')
    expect(subprocessSource).toMatch(/runnerEnvironment\(WINDOWS_RUNNER_SELECTION, invocation\)[\s\S]{0,180}windowsHide: true/)
    expect(win32Source).toContain('1, 134218756, environment')
    expect(win32Source).toContain('commandLine, 134217732, startupInfo')
  })
})
