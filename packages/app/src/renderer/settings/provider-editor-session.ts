// Session-scoped draft for the provider editor.
//
// The settings container remounts a page component whenever the user switches
// pages (`workspace.tsx` uses `key={page}`), so a draft held only in page state
// disappears on navigation. This module keeps one editor session in module
// memory for the lifetime of the app process:
//   - never written to localStorage, sessionStorage, disk or logs;
//   - the plaintext API key typed by the user lives here only in memory and is
//     dropped as soon as the draft is submitted, saved or cancelled;
//   - an in-flight save removes the session first, so a later page visit cannot
//     show a phantom draft next to a save that already reached Main.
import type { ProviderEditorDraft } from './model-provider-draft'

export interface ProviderEditorSession {
  /** Current editable content. */
  draft: ProviderEditorDraft
  /** The content the editor was opened with; dirtiness compares against it. */
  baseline: ProviderEditorDraft
}

let session: ProviderEditorSession | null = null

export function readProviderEditorSession(): ProviderEditorSession | null {
  return session
}

export function writeProviderEditorSession(next: ProviderEditorSession | null): void {
  session = next
}

export function clearProviderEditorSession(): void {
  session = null
}
