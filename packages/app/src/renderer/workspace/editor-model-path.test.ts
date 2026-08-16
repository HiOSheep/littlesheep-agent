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

  it('keeps Monaco models and undo history distinct between conversations', () => {
    const sessionA = workspaceEditorModelPath('D:\\work', 'src\\main.ts', 'session:a')
    const sessionB = workspaceEditorModelPath('D:\\work', 'src\\main.ts', 'session:b')

    expect(sessionA).not.toBe(sessionB)
    expect(sessionA).toContain('session%3Aa')
    expect(sessionB).toContain('session%3Ab')
  })
})
