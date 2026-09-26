import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { listWorkspaceDirectory } from './workspace-file-service'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('finds a file beyond the 320-row cap when filtering a directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ls-directory-filter-'))
  roots.push(root)
  await Promise.all(Array.from({ length: 320 }, (_, index) =>
    writeFile(join(root, `item-${String(index).padStart(3, '0')}.txt`), 'fixture')))
  await writeFile(join(root, 'zzz-beyond-cap.txt'), 'target')

  const initial = await listWorkspaceDirectory(root, root)
  expect(initial.truncated).toBe(true)
  expect(initial.entries.some((entry) => entry.name === 'zzz-beyond-cap.txt')).toBe(false)

  const filtered = await listWorkspaceDirectory(root, root, 'BEYOND-CAP')
  expect(filtered.truncated).toBe(false)
  expect(filtered.entries.map((entry) => entry.name)).toEqual(['zzz-beyond-cap.txt'])
})
