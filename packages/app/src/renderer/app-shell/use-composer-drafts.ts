// Owns the composer's text and attachment state for the active conversation.
//
// The React half of `composer-drafts.ts`. Every write goes into the active conversation's slot, so
// the values the composer renders (`input`, `attachments`) are always that one conversation's own
// draft; a session change swaps the slot. Nothing is saved on the way out: by the time the
// conversation changes, the text and the chips are already in the slot they belong to.
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentRef } from '../api'
import {
  conversationDraftKey,
  createComposerDraftSession,
  type ComposerDraft,
  type ComposerDraftSession,
} from './composer-drafts'

export interface ComposerDraftController {
  input: string
  setInput: Dispatch<SetStateAction<string>>
  /** The value the app-shell persistence reads; kept in step with `input`. */
  inputValueRef: MutableRefObject<string>
  attachments: AttachmentRef[]
  setAttachments: Dispatch<SetStateAction<AttachmentRef[]>>
  /** `switchSession` / `newSession` ask for the incoming conversation's own draft. */
  activateConversationDraft: (sessionId: string | undefined) => void
}

export function useComposerDrafts(options: {
  currentSession: string | undefined
  /** The session the window was restored to, so the recovered draft stays in its own slot. */
  initialSessionId: string | null
  initialDraft: string
}): ComposerDraftController {
  const { currentSession, initialSessionId, initialDraft } = options
  const sessionRef = useRef<ComposerDraftSession | null>(null)
  if (sessionRef.current === null) {
    sessionRef.current = createComposerDraftSession(initialSessionId, {
      text: initialDraft,
      attachments: [],
    })
  }
  const draftSession = sessionRef.current
  const [input, setInputState] = useState(initialDraft)
  const [attachments, setAttachmentsState] = useState<AttachmentRef[]>([])
  const inputValueRef = useRef(initialDraft)
  const attachmentsValueRef = useRef<AttachmentRef[]>([])

  const showDraft = useCallback((draft: ComposerDraft) => {
    inputValueRef.current = draft.text
    attachmentsValueRef.current = draft.attachments
    setInputState(draft.text)
    setAttachmentsState(draft.attachments)
  }, [])

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((update) => {
    const current = inputValueRef.current
    const next = typeof update === 'function' ? update(current) : update
    inputValueRef.current = next
    draftSession.write({ text: next })
    setInputState(next)
  }, [draftSession])

  const setAttachments = useCallback<Dispatch<SetStateAction<AttachmentRef[]>>>((update) => {
    const current = attachmentsValueRef.current
    const next = typeof update === 'function' ? update(current) : update
    attachmentsValueRef.current = next
    draftSession.write({ attachments: next })
    setAttachmentsState(next)
  }, [draftSession])

  const activateConversationDraft = useCallback((sessionId: string | undefined) => {
    showDraft(draftSession.activate(sessionId))
  }, [draftSession, showDraft])

  // A conversation change nobody navigated to: the run settled into the session it just created, or
  // the active conversation went away. The draft moves with the user rather than being replaced by
  // an empty slot. A navigation already claimed the key, so this leaves its restore untouched.
  useEffect(() => {
    if (draftSession.key === conversationDraftKey(currentSession)) return
    draftSession.adopt(currentSession)
  }, [currentSession, draftSession])

  return {
    input,
    setInput,
    inputValueRef,
    attachments,
    setAttachments,
    activateConversationDraft,
  }
}
