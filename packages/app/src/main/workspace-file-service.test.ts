import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { previewWorkspaceFile, saveWorkspaceTextFile } from './local-app-api/workspace-file-service.js'

describe('workspace file preview service', () => {
  it('returns HTML source as a renderable preview instead of an unsupported file card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-html-preview-'))
    try {
      const file = join(dir, 'snake-game.html')
      await writeFile(file, '<!doctype html><html><body><h1>Snake</h1></body></html>', 'utf8')

      await expect(previewWorkspaceFile(dir, file)).resolves.toMatchObject({
        kind: 'html',
        name: 'snake-game.html',
        relativePath: 'snake-game.html',
        content: expect.stringContaining('<h1>Snake</h1>'),
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps rendered HTML editable and returns the updated HTML preview after saving', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ls-html-save-'))
    try {
      const file = join(dir, 'page.htm')
      await writeFile(file, '<h1>Before</h1>', 'utf8')

      const preview = await saveWorkspaceTextFile(dir, file, {
        content: '<h1>After</h1>',
      })

      expect(preview).toMatchObject({ kind: 'html', content: '<h1>After</h1>' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
