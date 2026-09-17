const { app, shell } = require('electron')
const { mkdtemp, rmdir, stat, unlink } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

app.whenReady().then(async () => {
  const root = resolve(__dirname, '..')
  const target = join(root, 'release', 'win-unpacked', 'DSH PC Manager.exe')
  await stat(target)
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-pc-manager-shortcut-'))
  const shortcut = join(temporary, 'DSH PC Manager.lnk')
  try {
    const created = shell.writeShortcutLink(shortcut, 'create', {
      target,
      cwd: dirname(target),
      description: '启动 DSH PC Manager AI 智能体电脑管家',
      icon: target,
      iconIndex: 0,
    })
    if (!created) throw new Error('Shortcut creation returned false')
    const details = shell.readShortcutLink(shortcut)
    if (resolve(details.target) !== resolve(target)) throw new Error(`Unexpected shortcut target: ${details.target}`)
    if (resolve(details.cwd) !== resolve(dirname(target))) throw new Error(`Unexpected shortcut cwd: ${details.cwd}`)
    console.log(`Shortcut round trip passed: ${details.target}`)
  } finally {
    await unlink(shortcut).catch(() => undefined)
    await rmdir(temporary).catch(() => undefined)
  }
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
