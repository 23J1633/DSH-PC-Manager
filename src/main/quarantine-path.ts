import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, parse, win32 } from 'node:path'
import type { DiskVolume } from '../shared/types.js'

interface DirectorySummary {
  files: number
  bytes: number
}

function isOnCDrive(path: string): boolean {
  return win32.parse(win32.resolve(path)).root.toLocaleLowerCase() === 'c:\\'
}

async function directorySummary(path: string): Promise<DirectorySummary> {
  const total: DirectorySummary = { files: 0, bytes: 0 }
  const pending = [path]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(child)
      } else {
        const metadata = await lstat(child)
        total.files += 1
        total.bytes += metadata.size
      }
    }
  }
  return total
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function nextMigrationPath(rootPath: string): Promise<string> {
  const base = join(rootPath, 'migrated-from-C')
  if (!await exists(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!await exists(candidate)) return candidate
  }
  throw new Error('无法为旧隔离区创建唯一迁移目录。')
}

async function remapHistoryPaths(userDataPath: string, oldRoot: string, newRoot: string): Promise<void> {
  const historyPath = join(userDataPath, 'operation-history.json')
  if (!await exists(historyPath)) return
  const document: unknown = JSON.parse(await readFile(historyPath, 'utf8'))
  const oldPrefix = oldRoot.replace(/[\\/]+$/u, '')
  const normalizedPrefix = oldPrefix.toLocaleLowerCase()
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value.toLocaleLowerCase() === normalizedPrefix) return newRoot
      if (value.toLocaleLowerCase().startsWith(`${normalizedPrefix}\\`)) return join(newRoot, value.slice(oldPrefix.length + 1))
      if (value.toLocaleLowerCase().startsWith(`${normalizedPrefix}/`)) return join(newRoot, value.slice(oldPrefix.length + 1))
      return value
    }
    if (Array.isArray(value)) return value.map(replace)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]))
    }
    return value
  }
  const temporary = `${historyPath}.tmp`
  await writeFile(temporary, `${JSON.stringify(replace(document), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, historyPath)
}

function availableVolumes(volumes: readonly DiskVolume[]): DiskVolume[] {
  return volumes
    .filter(volume => {
      const root = win32.parse(volume.root).root
      return root.length > 0 && root.toLocaleLowerCase() !== 'c:\\' && volume.freeBytes > 0
    })
    .sort((left, right) => right.freeBytes - left.freeBytes)
}

export async function resolveQuarantinePath(userDataPath: string, volumes: readonly DiskVolume[], platform = process.platform): Promise<string> {
  const legacyPath = join(userDataPath, 'quarantine')
  if (platform !== 'win32' || !isOnCDrive(legacyPath)) {
    await mkdir(legacyPath, { recursive: true })
    return legacyPath
  }

  const candidates = availableVolumes(volumes)
  const legacyExists = await exists(legacyPath)
  if (candidates.length === 0) {
    throw new Error('已禁止将隔离区写入 C 盘，但没有检测到可用的其他本地磁盘。请连接或准备一个非 C 盘后重新启动。')
  }

  let migrationSize = 0
  if (legacyExists) migrationSize = (await directorySummary(legacyPath)).bytes
  const eligibleVolumes = candidates.filter(item => item.freeBytes >= migrationSize + 64 * 1024 ** 2)
  if (eligibleVolumes.length === 0) {
    const largest = candidates[0]
    throw new Error(`非 C 盘空间不足，无法迁移历史隔离区（需要约 ${(migrationSize / 1024 ** 3).toFixed(1)} GB，可用 ${(largest?.freeBytes ?? 0) / 1024 ** 3} GB）。旧数据保留在原处，未执行清理。`)
  }
  const userKey = createHash('sha256').update(win32.resolve(userDataPath).toLocaleLowerCase()).digest('hex').slice(0, 16)
  let destinationRoot: string | undefined
  let lastDirectoryError: unknown
  for (const candidate of eligibleVolumes) {
    const driveRoot = win32.parse(candidate.root).root
    if (driveRoot.length === 0 || driveRoot.toLocaleLowerCase() === 'c:\\') continue
    const candidatePath = join(driveRoot, 'DSH PC Manager', 'quarantine', userKey)
    try {
      await mkdir(candidatePath, { recursive: true })
      destinationRoot = candidatePath
      break
    } catch (error) {
      lastDirectoryError = error
    }
  }
  if (destinationRoot === undefined) {
    throw new Error(`无法在其他磁盘创建隔离区目录；C 盘隔离已禁用。${lastDirectoryError instanceof Error ? ` ${lastDirectoryError.message}` : ''}`)
  }
  if (!legacyExists) return destinationRoot

  const destinationExists = await exists(destinationRoot)
  const destinationIsEmpty = destinationExists && (await readdir(destinationRoot)).length === 0
  const migrationTarget = destinationIsEmpty
    ? destinationRoot
    : await nextMigrationPath(destinationRoot)
  const temporaryPath = join(parse(migrationTarget).dir, `.quarantine-migration-${Date.now()}`)
  if (await exists(temporaryPath)) throw new Error('隔离区迁移临时目录已存在，拒绝覆盖。')

  try {
    await cp(legacyPath, temporaryPath, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
    const copied = await directorySummary(temporaryPath)
    const original = await directorySummary(legacyPath)
    if (copied.files !== original.files || copied.bytes !== original.bytes) {
      throw new Error('隔离区迁移校验失败，旧数据仍保留在 C 盘。')
    }
    if (destinationIsEmpty) await rm(destinationRoot, { recursive: true })
    await rename(temporaryPath, migrationTarget)
    await remapHistoryPaths(userDataPath, legacyPath, migrationTarget)
    await rm(legacyPath, { recursive: true })
  } catch (error) {
    await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return destinationRoot
}
