import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { suggestLocalPaths } from '../src/main/path-suggestions.js'

describe('local @ path suggestions', () => {
  const roots: string[] = []

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      if (!root.startsWith(resolve(tmpdir()))) throw new Error(`Refusing to remove non-temporary path: ${root}`)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists directories before files and supports partial names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-path-suggest-'))
    roots.push(root)
    await mkdir(join(root, 'AlphaFolder'))
    await writeFile(join(root, 'AlphaFile.txt'), 'fixture', 'utf8')
    const suggestions = await suggestLocalPaths(join(root, 'Alpha'), root, [])
    expect(suggestions.map(item => item.name)).toEqual(['AlphaFolder', 'AlphaFile.txt'])
    expect(suggestions.map(item => item.type)).toEqual(['directory', 'file'])
  })
})
