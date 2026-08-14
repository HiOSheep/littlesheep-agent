import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { WorkspacePreview } from '../api'
import type { WorkspaceFileDraftState } from '../workspace-persistence'
import { saveWorkspaceFileBeforeClose } from './file-close'

function textPreview(content: string, modifiedAt: number): WorkspacePreview {
  return {
    kind: 'text',
    path: 'D:\\workspace\\notes.txt',
    name: 'notes.txt',
    relativePath: 'notes.txt',
    size: content.length,
    modifiedAt,
    language: 'text',
    content,
  }
}

function draft(editorText: string, savedText: string, modifiedAt = 1): WorkspaceFileDraftState {
  return {
    path: 'D:\\workspace\\notes.txt',
    modifiedAt,
    editorText,
    savedText,
    editing: true,
  }
}

describe('saveWorkspaceFileBeforeClose', () => {
  it('closes a clean file without requesting approval or saving', async () => {
    const requestSaveApproval = vi.fn(async () => true)
    const saveDraft = vi.fn(async () => textPreview('saved', 2))
    const closeTab = vi.fn()

    const result = await saveWorkspaceFileBeforeClose({
      getDraft: () => draft('saved', 'saved'),
      requestSaveApproval,
      saveDraft,
      recordSavedDraft: () => undefined,
      closeTab,
    })

    expect(result).toBe('closed')
    expect(requestSaveApproval).not.toHaveBeenCalled()
    expect(saveDraft).not.toHaveBeenCalled()
    expect(closeTab).toHaveBeenCalledOnce()
  })

  it('saves a dirty file before closing it', async () => {
    let currentDraft = draft('updated', 'saved')
    const closeTab = vi.fn()

    const result = await saveWorkspaceFileBeforeClose({
      getDraft: () => currentDraft,
      requestSaveApproval: async () => true,
      saveDraft: async (content) => textPreview(content, 2),
      recordSavedDraft: (savedText, preview) => {
        currentDraft = { ...currentDraft, savedText, modifiedAt: preview.modifiedAt }
        return currentDraft
      },
      closeTab,
    })

    expect(result).toBe('closed')
    expect(currentDraft).toMatchObject({ editorText: 'updated', savedText: 'updated', modifiedAt: 2 })
    expect(closeTab).toHaveBeenCalledOnce()
  })

  it('keeps the dirty file open when save approval is denied', async () => {
    const closeTab = vi.fn()
    const saveDraft = vi.fn(async () => textPreview('updated', 2))

    const result = await saveWorkspaceFileBeforeClose({
      getDraft: () => draft('updated', 'saved'),
      requestSaveApproval: async () => false,
      saveDraft,
      recordSavedDraft: () => undefined,
      closeTab,
    })

    expect(result).toBe('approval-denied')
    expect(saveDraft).not.toHaveBeenCalled()
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('keeps the dirty file open when saving fails', async () => {
    const closeTab = vi.fn()
    const failure = new Error('save failed')

    await expect(saveWorkspaceFileBeforeClose({
      getDraft: () => draft('updated', 'saved'),
      requestSaveApproval: async () => true,
      saveDraft: async () => { throw failure },
      recordSavedDraft: () => undefined,
      closeTab,
    })).rejects.toBe(failure)

    expect(closeTab).not.toHaveBeenCalled()
  })

  it('saves edits made during an in-flight save before closing', async () => {
    let currentDraft = draft('first edit', 'saved')
    let saveCount = 0
    const saveDraft = vi.fn(async (content: string) => {
      saveCount += 1
      if (saveCount === 1) currentDraft = { ...currentDraft, editorText: 'second edit' }
      return textPreview(content, saveCount + 1)
    })
    const closeTab = vi.fn()

    await saveWorkspaceFileBeforeClose({
      getDraft: () => currentDraft,
      requestSaveApproval: async () => true,
      saveDraft,
      recordSavedDraft: (savedText, preview) => {
        currentDraft = { ...currentDraft, savedText, modifiedAt: preview.modifiedAt }
        return currentDraft
      },
      closeTab,
    })

    expect(saveDraft).toHaveBeenNthCalledWith(1, 'first edit', 1)
    expect(saveDraft).toHaveBeenNthCalledWith(2, 'second edit', 2)
    expect(currentDraft).toMatchObject({
      editorText: 'second edit',
      savedText: 'second edit',
      modifiedAt: 3,
    })
    expect(closeTab).toHaveBeenCalledOnce()
  })

  it('preserves the latest dirty draft when a follow-up save fails', async () => {
    let currentDraft = draft('first edit', 'saved')
    let saveCount = 0
    const closeTab = vi.fn()

    await expect(saveWorkspaceFileBeforeClose({
      getDraft: () => currentDraft,
      requestSaveApproval: async () => true,
      saveDraft: async (content) => {
        saveCount += 1
        if (saveCount === 1) {
          currentDraft = { ...currentDraft, editorText: 'second edit' }
          return textPreview(content, 2)
        }
        throw new Error('follow-up save failed')
      },
      recordSavedDraft: (savedText, preview) => {
        currentDraft = { ...currentDraft, savedText, modifiedAt: preview.modifiedAt }
        return currentDraft
      },
      closeTab,
    })).rejects.toThrow('follow-up save failed')

    expect(currentDraft).toMatchObject({
      editorText: 'second edit',
      savedText: 'first edit',
      modifiedAt: 2,
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('does not retain the legacy discard confirmation flow', async () => {
    const [prompt, overlays, controller, styles] = await Promise.all([
      source('../approval/prompt.tsx'),
      source('../app-shell/overlays-view.tsx'),
      source('./use-workspace-layout-controller.ts'),
      source('../styles.css'),
    ])
    const implementation = [prompt, overlays, controller, styles].join('\n')

    expect(implementation).not.toContain('DirtyFileClosePrompt')
    expect(implementation).not.toContain('pendingDirtyCloseTab')
    expect(implementation).not.toContain('继续关闭')
    expect(implementation).not.toContain('dirty-file-prompt')
    expect(controller).not.toContain('force?: boolean')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
