// Focus ownership for the composer's input.
//
// The window is interactive before anything holds focus, and typing into an
// unfocused composer does nothing: measured on a real window, `document.activeElement`
// was BODY both at first paint and once execution was ready, and real key events
// inserted nothing until the textarea was focused explicitly. ChatGPT, Claude,
// Cursor and VS Code all put the caret in the input on launch and when a new
// conversation starts, so this asks for it at exactly those two moments.
//
// Who may take focus is decided in `focus-routing.ts`; this hook only supplies the
// live facts (the active element, the open layers) and the timing.

import { useCallback, useEffect, type RefObject } from 'react'
import { modalLayers } from '../ui/modal-layer'
import {
  COMPOSER_FOCUS_REQUEST_EVENT,
  shouldTakeComposerFocus,
  type ComposerFocusIntent,
} from './focus-routing'

export function useComposerFocus(inputRef: RefObject<HTMLTextAreaElement>): void {
  const focusComposer = useCallback((intent: ComposerFocusIntent) => {
    const target = inputRef.current
    if (!target) return
    const activeElement = typeof document === 'undefined' ? null : document.activeElement
    if (!shouldTakeComposerFocus({ intent, activeElement, layerDepth: modalLayers.depth(), target })) return
    target.focus({ preventScroll: true })
  }, [inputRef])

  useEffect(() => {
    focusComposer('launch')
  }, [focusComposer])

  useEffect(() => {
    let timer = 0
    const handleFocusRequest = () => {
      // One turn later: the command that asked for this (a new conversation, or
      // the dialog it settled) is still committing, so the guard has to read the
      // focus that exists then rather than the focus it is replacing.
      window.clearTimeout(timer)
      timer = window.setTimeout(() => focusComposer('new-session'), 0)
    }
    window.addEventListener(COMPOSER_FOCUS_REQUEST_EVENT, handleFocusRequest)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener(COMPOSER_FOCUS_REQUEST_EVENT, handleFocusRequest)
    }
  }, [focusComposer])
}
