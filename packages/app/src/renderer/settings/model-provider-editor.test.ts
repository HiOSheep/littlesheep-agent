import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'

let editor = ''

beforeAll(async () => {
  editor = await readFile(new URL('./model-provider-editor.tsx', import.meta.url), 'utf8')
})

/**
 * The keyboard contract of the provider editor.
 *
 * The measured defect (audit #12): Escape did nothing in this panel and nothing in its discard
 * question, while every other dialog in the app answered it. The panel is a page-level surface, so
 * the two Escape scopes are what carry the contract; `verify:settings-escape-scopes` measures the
 * behaviour in a real window, and this test keeps the wiring from being refactored away silently.
 */
describe('provider editor escape scopes', () => {
  it('takes Escape as a page-level surface instead of trapping Tab like a modal', () => {
    expect(editor).toContain("import { useEscapeScope } from '../ui/modal-surface'")
    expect(editor).toContain('useEscapeScope(')
    // A flat editing panel must not become a modal surface: that would also take Tab.
    expect(editor).not.toContain('useModalSurface')
  })

  it('closes through one exit path, and only while no save is in flight', () => {
    // `onCancel` is `closeEditor` in models.tsx: it decides for itself whether there is anything to
    // ask about (unsaved edits) and refuses to leave mid-save. Registering only when neither of
    // those states holds is what makes Escape mean exactly what the close entry means.
    expect(editor).toContain('useEscapeScope(onCancel, !saving && !discardConfirm)')
  })

  it('stacked the discard question above the editor, where Escape keeps editing', () => {
    const closeScope = editor.indexOf('useEscapeScope(onCancel, !saving && !discardConfirm)')
    const keepScope = editor.indexOf('useEscapeScope(onKeepEditing, discardConfirm)')
    expect(closeScope).toBeGreaterThanOrEqual(0)
    expect(keepScope).toBeGreaterThan(closeScope)
    // The question is the second registration, which is what makes it the topmost layer
    // (`ui/modal-layer.ts` gives Escape to the layer registered last).
    expect(editor).toContain('role="alertdialog"')
    expect(editor).toContain('aria-label="有未保存的修改"')
    expect(editor).toContain('onClick={onKeepEditing}')
    expect(editor).toContain('onClick={onDiscard}')
  })
})
