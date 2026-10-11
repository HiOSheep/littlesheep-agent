import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileAtomically, replaceFileAtomically } from './workspace-file-operations.js'

describe('workspace file commit primitives', () => {
  let directory: string | undefined

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('atomically creates an actual file without replacing a concurrent winner', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ls-file-commit-'))
    const target = join(directory, 'new.txt')
    const created = await createFileAtomically(target, 'complete bytes', async () => true)
    expect(created).toEqual({ ok: true })
    expect(await readFile(target, 'utf8')).toBe('complete bytes')
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const collision = await createFileAtomically(target, 'must not replace', async () => true)
    expect(collision).toEqual({ ok: false, reason: 'target_exists' })
    expect(await readFile(target, 'utf8')).toBe('complete bytes')
  })

  it('replaces an actual file atomically and leaves the old target on a failed recheck', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ls-file-commit-'))
    const target = join(directory, 'existing.txt')
    const original = Buffer.from('original complete bytes')
    await writeFile(target, original)

    const refused = await replaceFileAtomically(target, original, 'must not commit', async () => false)
    expect(refused).toEqual({ ok: false, reason: 'path_changed' })
    expect(await readFile(target)).toEqual(original)
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])

    const replaced = await replaceFileAtomically(target, original, 'replacement', async () => true)
    expect(replaced).toEqual({ ok: true })
    expect(await readFile(target, 'utf8')).toBe('replacement')
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
