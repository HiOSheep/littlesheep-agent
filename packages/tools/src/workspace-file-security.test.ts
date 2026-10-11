import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { verifyReplacementSecurity } from './workspace-file-security.js'

it.skipIf(process.platform !== 'win32')('checks actual Windows DACL, owner and group without copying source content or changing permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ls-file-security-'))
  const source = join(root, 'source.txt')
  const replacement = join(root, 'replacement.txt')
  try {
    await writeFile(source, 'private source content')
    await writeFile(replacement, '')
    expect(await verifyReplacementSecurity(source, replacement)).toBe(true)
    expect(await readFile(replacement, 'utf8')).toBe('')
    // Read the existing OS file's metadata only. Its actual security descriptor
    // differs from the user temporary file; the helper must decline it.
    expect(await verifyReplacementSecurity(join(process.env.SystemRoot!, 'win.ini'), replacement)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
