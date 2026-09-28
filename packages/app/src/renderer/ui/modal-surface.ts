// React glue for stacked UI layers.
//
// The rules live in modal-layer.ts and focus-ownership.ts; this module only
// connects them to the DOM:
//   - `useEscapeScope` gives a page-level surface Escape *only* while it is the
//     topmost layer (settings pages, popovers, menus);
//   - `useModalSurface` adds what a real modal dialog needs on top of that:
//     initial focus on a deliberate target, Tab kept inside the dialog, and
//     focus returned to the element that opened it on close.
//
// The focus half is not implemented here. `focus-ownership.ts` owns *who holds
// focus* - including the bounded retry that makes initial focus survive a
// subtree that is not mounted yet (every surface opening through
// `FadePresence`) - and hands it back on close. This module keeps only what a
// modal adds on top of a layer: the Escape/Tab key handling.
//
// A flat editing panel (the provider editor, an embedded settings page) is a
// page-level surface, not a modal dialog: it uses `useEscapeScope` and never
// traps Tab.
import { useEffect, useId, useRef, type RefObject } from 'react'
import { useFocusOwnership } from './focus-ownership'
import { FOCUSABLE_SELECTOR, modalLayers, nextFocusIndex } from './modal-layer'

export function useEscapeScope(onEscape: () => void, active = true): void {
  const id = useId()
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    if (!active) return
    modalLayers.push(id)
    const handleKeyDown = (event: KeyboardEvent) => {
      // An input method owns Escape while it is composing, and a handler that
      // already consumed the key keeps it.
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      if (!modalLayers.isTop(id)) return
      event.preventDefault()
      onEscapeRef.current()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      modalLayers.remove(id)
    }
  }, [active, id])
}

export interface ModalSurfaceOptions {
  /** False while the surface is only animating out: it must not take keys. */
  active: boolean
  onEscape: () => void
  /** Focus target on open. Defaults to the first focusable element inside. */
  initialFocusRef?: RefObject<HTMLElement>
  restoreFocus?: boolean
}

export function useModalSurface(
  containerRef: RefObject<HTMLElement>,
  { active, onEscape, initialFocusRef, restoreFocus = true }: ModalSurfaceOptions,
): void {
  const id = useId()
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  // R1 (focus on open, retried until it lands) and R2 (focus returned on close)
  // are owned by focus-ownership.ts. Registration in the layer stack stays here,
  // because Escape and Tab are the modal's own contract.
  useFocusOwnership({ active, containerRef, initialFocusRef, restoreFocus, focusableSelector: FOCUSABLE_SELECTOR })

  useEffect(() => {
    if (!active) return
    modalLayers.push(id)

    const focusables = () => {
      const scope = containerRef.current
      if (!scope) return []
      return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.getClientRects().length > 0)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (!modalLayers.isTop(id)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onEscapeRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const elements = focusables()
      const scope = containerRef.current
      if (elements.length === 0) {
        // A dialog without focusable children still keeps focus inside itself.
        event.preventDefault()
        scope?.focus({ preventScroll: true })
        return
      }
      const currentIndex = elements.indexOf(document.activeElement as HTMLElement)
      if (currentIndex < 0) {
        event.preventDefault()
        elements[event.shiftKey ? elements.length - 1 : 0]?.focus({ preventScroll: true })
        return
      }
      const atBoundary = event.shiftKey ? currentIndex === 0 : currentIndex === elements.length - 1
      if (!atBoundary) return
      event.preventDefault()
      elements[nextFocusIndex(elements.length, currentIndex, event.shiftKey)]?.focus({ preventScroll: true })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      modalLayers.remove(id)
    }
  }, [active, containerRef, id])
}
