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

/**
 * How long a new-conversation request may keep asking, and how often.
 *
 * The command that asks for the caret also closes things: a sidebar panel goes
 * away over its own exit transition, and a settled prompt leaves the layer stack
 * a frame or two later. One look would read the surface that is on its way out
 * and drop the caret on the floor, so the request keeps asking until it is
 * answered - for a bounded time, and through the same guard every time, so a
 * live dialog or a caret the user moved still wins.
 */
const FOCUS_REQUEST_SETTLE_MS = 250
const FOCUS_REQUEST_STEP_MS = 25

export function useComposerFocus(inputRef: RefObject<HTMLTextAreaElement>): void {
  const focusComposer = useCallback((intent: ComposerFocusIntent): boolean => {
    const target = inputRef.current
    if (!target) return false
    const activeElement = typeof document === 'undefined' ? null : document.activeElement
    if (!shouldTakeComposerFocus({ intent, activeElement, layerDepth: modalLayers.depth(), target })) return false
    target.focus({ preventScroll: true })
    return true
  }, [inputRef])

  useEffect(() => {
    focusComposer('launch')
  }, [focusComposer])

  useEffect(() => {
    let timer = 0
    const handleFocusRequest = () => {
      // One turn later, then while the surfaces the command closes are still
      // leaving: the guard has to read the focus that exists then rather than the
      // focus it is replacing.
      window.clearTimeout(timer)
      const deadline = Date.now() + FOCUS_REQUEST_SETTLE_MS
      const attempt = () => {
        if (focusComposer('new-session')) return
        if (Date.now() >= deadline) return
        timer = window.setTimeout(attempt, FOCUS_REQUEST_STEP_MS)
      }
      timer = window.setTimeout(attempt, 0)
    }
    window.addEventListener(COMPOSER_FOCUS_REQUEST_EVENT, handleFocusRequest)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener(COMPOSER_FOCUS_REQUEST_EVENT, handleFocusRequest)
    }
  }, [focusComposer])
}
