import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { expect, it } from 'vitest'
import { withPinnedWorkspaceDirectories } from './workspace-directory-pins.js'

it.skipIf(process.platform !== 'win32')('pins real Windows ancestors against replacement while allowing child file operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ls-native-pins-'))
  const directory = join(root, 'nested')
  await mkdir(directory)
  const ancestors: string[] = []
  for (let cursor = directory; ; cursor = dirname(cursor)) {
    ancestors.unshift(cursor)
    if (cursor === parse(cursor).root) break
  }
  try {
    const result = await withPinnedWorkspaceDirectories(ancestors, async () => true, async () => {
      await expect(rename(directory, join(root, 'moved'))).rejects.toThrow()
      await expect(rename(root, `${root}-moved`)).rejects.toThrow()
      const target = join(directory, 'target.txt')
      await writeFile(target, 'first')
      const temporary = join(directory, 'temporary.txt')
      await writeFile(temporary, 'replacement')
      await rename(temporary, target)
      expect(await readFile(target, 'utf8')).toBe('replacement')
      return 'committed'
    })
    expect(result).toEqual({ ok: true, value: 'committed' })
    await rename(directory, join(root, 'released'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(process.platform !== 'win32')('refuses missing directories, junctions, and a failed identity recheck before executing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ls-native-pins-refused-'))
  let executed = false
  const operation = async () => { executed = true }
  try {
    await symlink(root, join(root, 'junction'), 'junction')
    for (const path of [join(root, 'missing'), join(root, 'junction')]) {
      expect(await withPinnedWorkspaceDirectories([path], async () => true, operation)).toMatchObject({ ok: false })
    }
    expect(await withPinnedWorkspaceDirectories([root], async () => false, operation)).toMatchObject({ ok: false })
    expect(executed).toBe(false)
    await rename(root, `${root}-released`)
    await rm(`${root}-released`, { recursive: true, force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

it.skipIf(process.platform !== 'win32')('releases native directory handles when the file operation throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ls-native-pins-error-'))
  try {
    await expect(withPinnedWorkspaceDirectories([root], async () => true, async () => {
      throw new Error('operation failed')
    })).rejects.toThrow('operation failed')
    await rename(root, `${root}-released`)
    await rm(`${root}-released`, { recursive: true, force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
