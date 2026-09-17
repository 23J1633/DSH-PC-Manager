const { app, BrowserWindow, nativeImage } = require('electron')
const { mkdir, writeFile } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')

function pngAsIco(png) {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt8(0, 6)
  header.writeUInt8(0, 7)
  header.writeUInt8(0, 8)
  header.writeUInt8(0, 9)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(header.length, 18)
  return Buffer.concat([header, png])
}

app.whenReady().then(async () => {
  const root = resolve(__dirname, '..')
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    useContentSize: true,
    show: false,
    skipTaskbar: true,
    frame: false,
    backgroundColor: '#ffffff',
  })
  const ready = new Promise(resolvePromise => window.once('ready-to-show', resolvePromise))
  await window.loadFile(join(__dirname, 'icon.html'))
  await ready
  window.showInactive()
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  const capture = await window.webContents.capturePage()
  const png = nativeImage.createFromBuffer(capture.toPNG()).resize({ width: 256, height: 256 }).toPNG()
  const pngPath = join(root, 'public', 'icon.png')
  const icoPath = join(root, 'resources', 'icon.ico')
  await mkdir(dirname(pngPath), { recursive: true })
  await mkdir(dirname(icoPath), { recursive: true })
  await writeFile(pngPath, png)
  await writeFile(icoPath, pngAsIco(png))
  window.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
