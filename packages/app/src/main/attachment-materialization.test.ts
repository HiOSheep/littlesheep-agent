import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ManagedAttachmentCache } from './attachment-cache'
import { ensureManagedAttachmentRefs } from './attachment-materialization'
import { parseAttachments } from './attachments'

describe('attachment materialization', () => {
  it('materializes an inline review snapshot even when the reviewed file was deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ls-review-comment-'))
    try {
      const cache = new ManagedAttachmentCache({ rootDir: join(root, 'cache') })
      await cache.initialize()
      const refs = parseAttachments([{
        path: join(root, 'deleted.ts'),
        contextPath: 'src/deleted.ts',
        name: 'deleted.ts',
        kind: 'file',
        inlineText: 'Git review snapshot\n12 | return oldValue',
        lineComments: [{ startLine: 12, text: 'Keep this behavior.' }],
      }])

      const [managed] = await ensureManagedAttachmentRefs(refs, cache)
      expect(managed).toMatchObject({
        contextPath: 'src/deleted.ts',
        name: 'deleted.ts',
        kind: 'file',
        ownership: 'cache',
        lineComments: [{ startLine: 12, text: 'Keep this behavior.' }],
      })
      expect(managed?.cacheId).toBeTruthy()
      expect(managed?.inlineText).toBeUndefined()
      expect(await readFile(managed!.path, 'utf8')).toBe('Git review snapshot\n12 | return oldValue')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
