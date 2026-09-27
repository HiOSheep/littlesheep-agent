// The composer's unsent draft belongs to one conversation, not to the window.
//
// A draft is the text plus the attachment chips beside it, and those chips carry workspace paths
// that belong to the conversation they were added in. One shared value meant a draft typed in a new
// conversation followed the user into whatever conversation they opened next, with send still
// enabled, so pressing send (or Enter, since the caret was already in the input) delivered it to the
// wrong thread. ChatGPT, Claude, Cursor and VS Code all keep the draft with the conversation:
// switching shows that conversation's own draft — empty when it has none — and switching back
// restores what was there.
//
// This module owns the map and its two transitions; `use-composer-drafts.ts` is the React half, and
// `run-actions.ts` still clears the draft through the composer's own setters, which land here.
// `persistent-state.ts` keeps persisting the single-entry draft it always did: the per-conversation
// map is runtime state, not a new persisted format.
import type { AttachmentRef } from '../api'

/** Where a conversation that has no session id yet keeps its draft: the new, unsent conversation. */
export const NEW_CONVERSATION_DRAFT_KEY = 'draft'

export interface ComposerDraft {
  text: string
  /** In the order the composer shows them. */
  attachments: AttachmentRef[]
}

/** One conversation's draft slot: the session id, or the new-conversation slot before it has one. */
export function conversationDraftKey(sessionId: string | undefined | null): string {
  return sessionId ?? NEW_CONVERSATION_DRAFT_KEY
}

export interface ComposerDraftSession {
  /** The conversation whose draft the composer is showing. */
  readonly key: string
  /** The active conversation's draft; empty when it has none. */
  read(): ComposerDraft
  /** Record what the composer now holds (text, attachments, or both) under the active key. */
  write(changes: Partial<ComposerDraft>): void
  /**
   * The user opened another conversation (`switchSession`) or started a new one (`newSession`):
   * the composer shows the incoming conversation's own draft, or an empty one when it has none.
   */
  activate(sessionId: string | undefined): ComposerDraft
  /**
   * `currentSession` moved without a navigation asking for it — a run settled into the session it
   * just created, or the active conversation was archived, deleted or replaced by a workspace
   * switch. The user's text is theirs: it moves with them instead of being dropped on the floor.
   * An existing draft in the destination slot wins, because that slot is a different conversation.
   */
  adopt(sessionId: string | undefined): void
}

export function createComposerDraftSession(
  initialSessionId: string | null,
  initialDraft: ComposerDraft,
): ComposerDraftSession {
  const drafts = new Map<string, ComposerDraft>()
  let key = conversationDraftKey(initialSessionId)
  record(key, initialDraft)

  function record(target: string, draft: ComposerDraft): void {
    if (draft.text.length === 0 && draft.attachments.length === 0) drafts.delete(target)
    else drafts.set(target, { text: draft.text, attachments: [...draft.attachments] })
  }

  function read(): ComposerDraft {
    const draft = drafts.get(key)
    return draft
      ? { text: draft.text, attachments: [...draft.attachments] }
      : { text: '', attachments: [] }
  }

  return {
    get key(): string {
      return key
    },
    read,
    write(changes: Partial<ComposerDraft>): void {
      const current = read()
      record(key, {
        text: changes.text ?? current.text,
        attachments: changes.attachments ?? current.attachments,
      })
    },
    activate(sessionId: string | undefined): ComposerDraft {
      key = conversationDraftKey(sessionId)
      return read()
    },
    adopt(sessionId: string | undefined): void {
      const next = conversationDraftKey(sessionId)
      if (next === key) return
      const held = drafts.get(key)
      drafts.delete(key)
      key = next
      if (held && !drafts.has(next)) record(next, held)
    },
  }
}
