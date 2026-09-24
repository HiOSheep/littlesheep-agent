import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProviderDraft } from './model-provider-draft'
import {
  clearProviderEditorSession,
  readProviderEditorSession,
  writeProviderEditorSession,
} from './provider-editor-session'

function readSettingsFile(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), 'utf8')
}

describe('provider editor session draft', () => {
  beforeEach(() => {
    clearProviderEditorSession()
  })

  it('holds one draft until it is saved or cancelled', () => {
    expect(readProviderEditorSession()).toBeNull()

    const draft = { ...createEmptyProviderDraft(), id: 'my-gw', baseURL: 'https://gw.example/v1' }
    writeProviderEditorSession({ draft, baseline: createEmptyProviderDraft() })
    expect(readProviderEditorSession()?.draft.id).toBe('my-gw')

    clearProviderEditorSession()
    expect(readProviderEditorSession()).toBeNull()
  })

  it('keeps the baseline with the draft so dirtiness survives a page switch', () => {
    const baseline = createEmptyProviderDraft()
    const draft = { ...baseline, baseURL: 'https://gw.example/v1' }
    writeProviderEditorSession({ draft, baseline })

    const restored = readProviderEditorSession()
    expect(restored?.baseline.baseURL).toBe('')
    expect(restored?.draft.baseURL).toBe('https://gw.example/v1')
  })

  it('never persists the draft outside memory', async () => {
    const source = await readSettingsFile('provider-editor-session.ts')

    // The module only ever assigns a module-level variable.
    expect(source).not.toMatch(/localStorage\.|sessionStorage\.|window\.localStorage/u)
    expect(source).not.toMatch(/console\.\w/u)
    expect(source).not.toContain('writeFile')
    expect(source).not.toContain('fetch(')
    expect(source).toContain('let session: ProviderEditorSession | null = null')
  })
})

describe('provider editor draft wiring', () => {
  it('restores, submits and discards the session draft deliberately', async () => {
    const [models, editor] = await Promise.all([
      readSettingsFile('models.tsx'),
      readSettingsFile('model-provider-editor.tsx'),
    ])

    // Restored on mount through the session store, not through page state alone.
    expect(models).toContain('useState<ProviderEditorDraft | null>(() => readProviderEditorSession()?.draft ?? null)')
    expect(models).toContain('applyEditorSession({ draft: next, baseline: baseline ?? next })')
    // Submitting clears the stored copy, and a failure puts the content back.
    expect(models).toContain('writeProviderEditorSession(null)')
    expect(models).toContain('writeProviderEditorSession({ draft: submitted, baseline: submittedBaseline })')
    // Cancelling and closing while saving.
    expect(models).toContain('function closeEditor()')
    expect(models).toMatch(/function closeEditor\(\) \{\n\s+\/\/ Leaving mid-save[\s\S]*?if \(saving\) return/u)
    expect(models).toContain('onCancel={closeEditor}')

    // The editor reports the four states and cannot be closed mid-save.
    expect(editor).toContain("stateText = saving")
    expect(editor).toContain("'已修改，尚未保存。'")
    // The failure stays in the editor through the shared feedback structure,
    // which owns the alert role and bounds the Runtime text.
    expect(editor).toContain("message: '保存失败，内容仍保留在编辑器里'")
    expect(editor).toContain('detail: saveError')
    expect(editor).toContain('onClick={onCancel} disabled={saving}')
    expect(editor).toContain('provider-editor-key-note')
  })

  it('asks before discarding unsaved edits instead of dropping them silently', async () => {
    const [models, editor] = await Promise.all([
      readSettingsFile('models.tsx'),
      readSettingsFile('model-provider-editor.tsx'),
    ])

    // The editor is a modal, so the close entry is the only way out: it must ask.
    // Measured in the real window by `verify:provider-editor-draft`: the page switch and the
    // settings exit are both unreachable while it is open.
    expect(models).toMatch(/function closeEditor\(\) \{[\s\S]*?if \(draftDirty\) \{[\s\S]*?setDiscardConfirm\(true\)[\s\S]*?return[\s\S]*?\n  \}/u)
    expect(models).toContain('function keepEditing()')
    expect(models).toContain('function discardDraft()')
    expect(models).toContain('discardConfirm={discardConfirm}')
    expect(models).toContain('onDiscard={discardDraft}')
    expect(editor).toContain('role="alertdialog" aria-label="有未保存的修改"')
    expect(editor).toContain('有未保存的修改，关闭后会丢弃。')
    expect(editor).toContain('继续编辑')
    expect(editor).toContain('丢弃修改')
  })
})
