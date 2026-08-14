import { describe, expect, it } from 'vitest'
import { workspaceEditorModelPath } from './code-editor'

describe('workspace editor model paths', () => {
  it('creates stable, distinct URIs for file tabs', () => {
    const first = workspaceEditorModelPath('D:\\work', 'src\\main.ts')
    const second = workspaceEditorModelPath('D:\\work', 'src\\other.ts')

    expect(first).toBe(workspaceEditorModelPath('D:/work', 'src/main.ts'))
    expect(first).not.toBe(second)
    expect(first).toContain('inmemory://littlesheep-file/')
  })
})
