import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('workspace missing file feedback', () => {
  it('clears the stale preview and renders the missing-file state inline', async () => {
    const source = await readSource('./file-view.tsx')

    expect(source).toContain('workspaceFilePreviewCache.load(root, path, { force: true })')
    expect(source).toContain('missingWorkspaceFileMessage(err)')
    expect(source).toContain('workspaceFilePreviewCache.invalidate(root, path)')
    expect(source).toContain('setPreview(null)')
    expect(source).toContain('setError(missingMessage)')
    expect(source).not.toContain('window.alert')
  })
})

function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
