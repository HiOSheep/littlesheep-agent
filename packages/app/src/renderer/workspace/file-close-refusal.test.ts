import { readFile } from 'node:fs/promises'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { workspaceFileTabId } from '../workspace-persistence'
import { workspaceFileCloseRefusal } from './file-close'
import { WorkspaceFileCloseRefusalNotice } from './file-close-refusal'

// The suite runs the classic JSX transform, so the renderer reads the React global.
beforeEach(() => vi.stubGlobal('React', React))
afterAll(() => vi.unstubAllGlobals())

const FILE_TAB = workspaceFileTabId('D:\\workspace', 'D:\\workspace\\notes.txt')

describe('workspaceFileCloseRefusal', () => {
  it('names the file whose close was refused', () => {
    expect(workspaceFileCloseRefusal(FILE_TAB, 'approval-denied')).toEqual({
      tab: FILE_TAB,
      label: 'notes.txt',
    })
  })

  it('stays silent for every other close outcome', () => {
    // A completed close needs no answer, and a feature tab has no draft to abandon.
    expect(workspaceFileCloseRefusal(FILE_TAB, 'closed')).toBeNull()
    expect(workspaceFileCloseRefusal(FILE_TAB, undefined)).toBeNull()
    expect(workspaceFileCloseRefusal('review', 'approval-denied')).toBeNull()
  })
})

describe('WorkspaceFileCloseRefusalNotice', () => {
  const refusal = workspaceFileCloseRefusal(FILE_TAB, 'approval-denied')

  it('offers the discard answer the permission prompt cannot express', () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceFileCloseRefusalNotice, {
      refusal,
      onDiscardDraft: () => {},
      onKeepEditing: () => {},
    }))

    expect(markup).toContain('已拒绝保存')
    expect(markup).toContain('notes.txt')
    expect(markup).toContain('未保存的修改还在')
    expect(markup).toContain('放弃修改')
    expect(markup).toContain('继续编辑')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('data-tone="warning"')
    expect(markup).toContain('workspace-file-close-refusal-action')
  })

  it('renders nothing without a refusal', () => {
    const markup = renderToStaticMarkup(createElement(WorkspaceFileCloseRefusalNotice, {
      refusal: null,
      onDiscardDraft: () => {},
      onKeepEditing: () => {},
    }))

    expect(markup).toBe('')
  })
})

describe('the refused close reaches the user', () => {
  it('keeps the result, shows the notice, and wires the discard to the close path', async () => {
    const [controller, panel, refusalModule] = await Promise.all([
      source('./use-workspace-layout-controller.ts'),
      source('./panel.tsx'),
      source('./file-close-refusal.tsx'),
    ])

    // The controller used to drop the result at the call site.
    expect(controller).toContain('return await saveWorkspaceFileBeforeClose({')
    expect(controller).toContain('request?.discardDraft')
    expect(controller).toContain('WorkspaceFileCloseResult | undefined')
    // The panel renders the strip together with the refusal answer.
    expect(panel).toContain('<WorkspaceTabStripWithCloseRefusal')
    expect(panel).toContain('WorkspaceFileTabCloseHandler')
    // Taking the answer closes the tab through the ordinary close handler.
    expect(refusalModule).toContain('{ discardDraft: true }')
    expect(refusalModule).toContain('workspaceFileCloseRefusal(tab, result)')
  })

  it('leaves the save approval itself untouched', async () => {
    const [prompt, refusalModule] = await Promise.all([
      source('../approval/prompt.tsx'),
      source('./file-close-refusal.tsx'),
    ])

    // The permission contract keeps its three answers and never grows a fourth:
    // abandoning an edit is decided on the tab strip, not in the permission dialog.
    expect(prompt).toContain("if (action === 'save_file') return '允许保存工作区文件？'")
    expect(prompt).toContain("onResolve('deny')")
    expect(prompt).toContain("onResolve('session')")
    expect(prompt).toContain("onResolve('once')")
    expect(prompt).toMatch(/>\s*拒绝\s*</u)
    expect(prompt).toMatch(/>\s*本对话允许\s*</u)
    expect(prompt).toMatch(/>\s*仅本次\s*</u)
    expect(prompt).not.toContain('放弃修改')
    expect(prompt).not.toContain('不保存')
    expect(refusalModule).not.toContain('ApprovalPrompt')
  })
})

function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}
