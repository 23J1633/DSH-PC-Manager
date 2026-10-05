import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function findPackageDirectory(entryUrl, packageName) {
  let directory = dirname(fileURLToPath(entryUrl))
  while (true) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        if (manifest.name === packageName) return directory
      } catch {}
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function findInstalledPackage(packageName, fromDirectory) {
  let current = fromDirectory
  while (true) {
    const packageDirectory = join(current, 'node_modules', ...packageName.split('/'))
    const manifestPath = join(packageDirectory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === packageName) return { packageDirectory: resolve(packageDirectory), manifest }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function resolvePackage(packageName, fromDirectory) {
  const parentUrl = pathToFileURL(join(fromDirectory, 'package.json')).href
  try {
    const entryUrl = import.meta.resolve(packageName, parentUrl)
    if (!entryUrl.startsWith('file:')) return { error: `resolved to unsupported URL ${entryUrl}` }
    const packageDirectory = findPackageDirectory(entryUrl, packageName)
    if (packageDirectory === undefined) return { error: `resolved ${entryUrl} but found no package manifest` }
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
    return { packageDirectory: resolve(packageDirectory), manifest }
  } catch (error) {
    const installed = findInstalledPackage(packageName, fromDirectory)
    if (installed !== undefined) {
      const manifest = installed.manifest
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
      const hasEntry = typeof manifest.main === 'string'
        || typeof manifest.module === 'string'
        || manifest.exports !== undefined
        || (typeof bin === 'string' && existsSync(join(installed.packageDirectory, bin)))
      if (hasEntry) return installed
      if (typeof manifest.types === 'string' || typeof manifest.typings === 'string') return { typeOnly: true, ...installed }
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function isTypeOnlyPackage(name) {
  return name.startsWith('@types/') || name === 'csstype'
}

export async function validatePackagedDependencies(appDirectory) {
  const rootManifestPath = join(appDirectory, 'package.json')
  if (!existsSync(rootManifestPath)) throw new Error(`Packaged app manifest is missing: ${rootManifestPath}`)
  const rootManifest = JSON.parse(readFileSync(rootManifestPath, 'utf8'))
  const pending = Object.keys(rootManifest.dependencies || {}).map(name => ({ name, from: appDirectory, parent: 'application' }))
  const visited = new Set()
  const missing = []

  while (pending.length > 0) {
    const request = pending.pop()
    if (request === undefined) continue
    const resolved = await resolvePackage(request.name, request.from)
    if (resolved.error !== undefined) {
      missing.push(`${request.parent} -> ${request.name}: ${resolved.error}`)
      continue
    }
    if (resolved.typeOnly === true) continue
    const packageDirectory = resolved.packageDirectory
    if (visited.has(packageDirectory)) continue
    visited.add(packageDirectory)
    const manifest = resolved.manifest
    for (const name of Object.keys(manifest.dependencies || {})) {
      if (isTypeOnlyPackage(name)) continue
      pending.push({ name, from: packageDirectory, parent: manifest.name })
    }
    for (const [name, range] of Object.entries(manifest.peerDependencies || {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional === true || isTypeOnlyPackage(name)) continue
      pending.push({ name, from: packageDirectory, parent: `${manifest.name} peer (${range})` })
    }
  }

  if (missing.length > 0) {
    throw new Error(`Packaged runtime dependency validation failed:\n${missing.map(item => `- ${item}`).join('\n')}`)
  }
  console.log(`Packaged runtime dependencies validated: ${visited.size} packages resolved.`)
}
