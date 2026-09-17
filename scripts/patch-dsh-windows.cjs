const { readFileSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, join } = require('node:path')

const requireFromProject = createRequire(join(process.cwd(), 'package.json'))

function packageFile(packageName, relativePath) {
  const manifest = requireFromProject.resolve(`${packageName}/package.json`)
  return join(dirname(manifest), relativePath)
}

function patchFile(path, alreadyPatched, applyPatch, label) {
  const original = readFileSync(path, 'utf8')
  if (alreadyPatched(original)) return
  const patched = applyPatch(original)
  if (patched === original) throw new Error(`无法应用 ${label}：依赖源码结构已经变化`)
  writeFileSync(path, patched, 'utf8')
}

patchFile(
  packageFile('@deepseek-ai/dsh-subprocess-local', 'lib/index.js'),
  source => /runnerEnvironment\(WINDOWS_RUNNER_SELECTION, invocation\),\s*stdio: runnerStdio\(spec, true,[\s\S]{0,80}?\),\s*windowsHide: true/u.test(source),
  source => source.replace(
    /(env: runnerEnvironment\(WINDOWS_RUNNER_SELECTION, invocation\),\s*stdio: runnerStdio\(spec, true, ignoredStdinFd \?\? "pipe"\))\s*\n\s*\}/u,
    '$1,\n\t\t\twindowsHide: true\n\t\t}',
  ),
  'DSH Windows runner 隐藏窗口补丁',
)

patchFile(
  packageFile('@deepseek-ai/dsh-win32-process', 'lib/index.js'),
  source => source.includes('1, 134218756, environment') && source.includes('commandLine, 134217732, startupInfo'),
  source => source
    .replace('1, 1028, environment', '1, 134218756, environment')
    .replace('commandLine, 4, startupInfo', 'commandLine, 134217732, startupInfo'),
  'DSH PowerShell CREATE_NO_WINDOW 补丁',
)

console.log('DSH Windows hidden-process patch verified')
