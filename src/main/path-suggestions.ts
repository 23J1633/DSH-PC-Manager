import { readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { DiskVolume, PathSuggestion } from '../shared/types.js'

const MAX_SUGGESTIONS = 32

function cleanQuery(query: string, homePath: string): string {
  let cleaned = query.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/^['"]|['"]$/g, '')
  if (cleaned === '~') cleaned = homePath
  else if (cleaned.startsWith(`~${sep}`)) cleaned = join(homePath, cleaned.slice(2))
  if (/^[a-zA-Z]:$/.test(cleaned)) cleaned += sep
  return cleaned
}

function displayName(path: string): string {
  return basename(path) || path
}

export async function suggestLocalPaths(
  query: string,
  homePath: string,
  volumes: readonly DiskVolume[],
): Promise<PathSuggestion[]> {
  if (typeof query !== 'string' || query.length > 2048 || query.includes('\0')) return []
  const cleaned = cleanQuery(query, homePath)
  if (cleaned.startsWith('\\\\')) return []

  const roots: PathSuggestion[] = cleaned.length === 0
    ? [
        { path: homePath, name: `用户目录 · ${homePath}`, type: 'directory' },
        ...volumes.map(volume => ({
          path: volume.root,
          name: volume.name.trim().length > 0 ? `${volume.name} (${volume.root})` : volume.root,
          type: 'drive' as const,
        })),
      ]
    : []

  const expanded = cleaned.length === 0
    ? homePath
    : isAbsolute(cleaned) ? resolve(cleaned) : resolve(homePath, cleaned)
  const endsWithSeparator = cleaned.endsWith('/') || cleaned.endsWith('\\')
  const parent = endsWithSeparator || cleaned.length === 0 ? expanded : dirname(expanded)
  const prefix = endsWithSeparator || cleaned.length === 0 ? '' : basename(expanded).toLocaleLowerCase()

  let entries
  try {
    entries = await readdir(parent, { withFileTypes: true })
  } catch {
    return roots.slice(0, MAX_SUGGESTIONS)
  }

  const children: PathSuggestion[] = entries
    .filter(entry => entry.name.toLocaleLowerCase().startsWith(prefix))
    .filter(entry => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
    .sort((left, right) => {
      const leftDirectory = left.isDirectory() ? 0 : 1
      const rightDirectory = right.isDirectory() ? 0 : 1
      return leftDirectory - rightDirectory || left.name.localeCompare(right.name, 'zh-CN', { numeric: true })
    })
    .slice(0, MAX_SUGGESTIONS)
    .map(entry => {
      const path = join(parent, entry.name)
      return {
        path,
        name: displayName(path),
        type: entry.isDirectory() ? 'directory' : 'file',
      }
    })

  const seen = new Set<string>()
  return [...roots, ...children].filter(item => {
    const key = item.path.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_SUGGESTIONS)
}
