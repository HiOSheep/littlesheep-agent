// Where the caret goes when one of the composer's menus closes.
//
// `ui/focus-ownership.ts` owns the *modal* half of this rule (a dialog takes the
// caret when it opens and gives it back when it closes). This module owns the
// half a popover owes, and it is deliberately the smaller one: a menu never takes
// the caret when it opens, so the only thing it may do on close is give back a
// caret it was holding.
//
// Why it exists (measured 2026-09-29, real Electron window, real pointer and real
// keys): every composer menu closed by making its panel `inert` in the same commit
// as the state change, and Chromium blurs an element that becomes inert. All four
// closed paths - the add menu with Escape, the permission menu with Escape, the
// permission menu by choosing an option, the model menu by choosing a model -
// therefore left `document.activeElement` on `document.body`: the caret was
// nowhere, and the next keystroke reached nothing until the user clicked again.
//
// The reference is the pattern these controls already declare: they are menu
// buttons (`aria-haspopup="menu"` + `role="menu"` + `aria-expanded`), and the
// convention ChatGPT, VS Code, Linear and Cursor follow for a menu button is that
// closing the menu returns focus to the button that opened it.
//
// Ownership boundary: this module decides *whether* a closing menu gives the caret
// back and *where* it goes. It does not render, does not own which menu is open,
// and does not touch Escape arbitration or the Tab cycle (`ui/modal-surface.ts`)
// or any other surface's visuals.

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { restoreFocusTo } from '../ui/focus-ownership'

/**
 * Where the caret is once a menu has closed.
 *
 * `menu`: still inside the popup. The close made the popup inert and the browser
 * has not run its caret fix-up yet, so the caret is on its way to the body.
 * `body`: the page body - the close dropped it, which is the defect above.
 * `elsewhere`: a real element that is not the popup. Somebody else put it there
 * (a click outside the menu focuses what it hit), so it is not ours to move.
 */
export type MenuCaretAfterClose = 'menu' | 'body' | 'elsewhere'

export interface MenuCaretReturnRequest {
  /** The popup held the caret when its close was requested. */
  caretHeldByMenu: boolean
  caretAfterClose: MenuCaretAfterClose
}

/**
 * Whether a closing menu gives the caret back to its trigger.
 *
 * Both guards exist so this can never steal focus:
 *   - a menu gives back only a caret it was holding, so a menu that never took it
 *     from the composer leaves the composer's own caret exactly where it was;
 *   - only when the close itself dropped it. A click outside the menu moves the
 *     caret to whatever it hit, and `elsewhere` keeps it there.
 */
export function shouldReturnMenuCaret(request: MenuCaretReturnRequest): boolean {
  return request.caretHeldByMenu && request.caretAfterClose !== 'elsewhere'
}

/** Where the caret is now, in the terms {@link shouldReturnMenuCaret} reads. */
function caretPosition(panel: HTMLElement | null): MenuCaretAfterClose {
  const active = typeof document === 'undefined' ? null : document.activeElement
  if (active === null || active === document.body) return 'body'
  if (panel && active instanceof Node && panel.contains(active)) return 'menu'
  return 'elsewhere'
}

/**
 * The close-time half of the contract, plus the return.
 *
 * The returned function is what every close path of one menu must call while the
 * menu is still rendered: it records whether the menu is holding the caret, which
 * is the only moment that fact can still be read (one commit later the panel is
 * inert and the caret has already been dropped). The hook itself, on the commit
 * where `open` turns false, gives the caret back to the trigger.
 */
export function useMenuFocusReturn(options: {
  open: boolean
  /** The popup: what "the menu is holding the caret" is measured against. */
  panelRef: RefObject<HTMLElement | null>
  /** The control that opened the popup, and the one that gets the caret back. */
  triggerRef: RefObject<HTMLElement | null>
}): () => void {
  const { open, panelRef, triggerRef } = options
  const caretHeldRef = useRef(false)

  const captureMenuCaret = useCallback(() => {
    caretHeldRef.current = caretPosition(panelRef.current) === 'menu'
  }, [panelRef])

  useEffect(() => {
    if (open) return
    const caretHeldByMenu = caretHeldRef.current
    caretHeldRef.current = false
    if (!caretHeldByMenu) return
    if (!shouldReturnMenuCaret({ caretHeldByMenu, caretAfterClose: caretPosition(panelRef.current) })) return
    restoreFocusTo(triggerRef.current)
  }, [open, panelRef, triggerRef])

  return captureMenuCaret
}
