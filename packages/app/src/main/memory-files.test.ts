import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listUserMemoryFiles,
  readUserMemoryFile,
  writeUserMemoryFile,
} from './memory-files.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })))
})

async function createDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ls-memory-files-'))
  directories.push(directory)
  return directory
}

describe('user-facing memory files', () => {
  it('lists only the stable memory documents and never exposes atom storage', async () => {
    const dataDir = await createDataDir()
    await writeFile(join(dataDir, 'SOUL.md'), '# Soul\n', 'utf8')
    await writeFile(join(dataDir, 'atom-should-stay-internal.json'), '{"id":"atom-1"}', 'utf8')

    const files = await listUserMemoryFiles(dataDir)

    expect(files.map((file) => file.name)).toEqual([
      'AGENTS.md',
      'SOUL.md',
      'USER.md',
      'PHILOSOPHY.md',
      'TOOLS.md',
      'MEMORY.md',
    ])
    expect(files.find((file) => file.name === 'SOUL.md')).toMatchObject({
      exists: true,
      editable: true,
    })
    expect(files.filter((file) => file.editable).map((file) => file.name)).toEqual(['SOUL.md'])
  })

  it('reads missing documents as empty projections without creating them', async () => {
    const dataDir = await createDataDir()

    await expect(readUserMemoryFile(dataDir, 'USER.md')).resolves.toMatchObject({
      name: 'USER.md',
      exists: false,
      editable: false,
      content: '',
    })
    await expect(readUserMemoryFile(dataDir, '../SOUL.md')).resolves.toBeUndefined()
  })

  it('atomically updates SOUL.md and rejects writes to every other document', async () => {
    const dataDir = await createDataDir()
    await writeFile(join(dataDir, 'SOUL.md'), 'old soul', 'utf8')
    await writeFile(join(dataDir, 'AGENTS.md'), 'stable rules', 'utf8')

    await expect(writeUserMemoryFile(dataDir, 'SOUL.md', 'new soul')).resolves.toMatchObject({
      name: 'SOUL.md',
      editable: true,
      content: 'new soul',
    })
    await expect(readFile(join(dataDir, 'SOUL.md'), 'utf8')).resolves.toBe('new soul')

    await expect(writeUserMemoryFile(dataDir, 'AGENTS.md', 'changed rules'))
      .rejects.toThrow('只允许编辑 SOUL.md')
    await expect(readFile(join(dataDir, 'AGENTS.md'), 'utf8')).resolves.toBe('stable rules')
  })
})
