// Who holds focus, and the two visible rules that come with it.
//
// This module owns the *focus lifecycle* of every surface that has one. It is
// the single place that answers "which element takes the caret when this surface
// opens" and "where does the caret go when it closes", so no surface has to
// re-invent either.
//
// Why it exists (measured 2026-09-28): `useModalSurface` focused its dialog
// exactly once, in the effect that runs on the commit where `active` turns true.
// For any surface that renders through `FadePresence`, that commit renders
// `null` (`presence.tsx` returns null until its layout effect has mounted the
// subtree), so both the container ref and the deliberate target ref were still
// null: focus never landed, and nothing retried. Opening the 完全访问 warning
// through a real pointer path therefore left `document.activeElement` on `BODY`,
// and the next Enter or Space activated a *background* control - in one measured
// run it navigated the app elsewhere and silently dismissed the warning, losing
// the pending mode change.
//
// The retry is bounded on purpose. This is not a focus trap and not a scheduler:
// it re-reads the refs on each animation frame until focus lands or the deadline
// passes, and then stops for good. Surfaces that mount synchronously (the
// irreversible-deletion confirmation, the approval prompt) land on the first
// attempt and never schedule a frame.
//
// ---------------------------------------------------------------------------
// The rules this module owns
// ---------------------------------------------------------------------------
//
//   R1  A modal surface takes focus when it opens. The caret goes to the
//       surface's deliberate target if it declares one, otherwise to the first
//       focusable element inside it. The attempt retries across animation frames
//       until it lands or `ENTRY_FOCUS_TIMEOUT_MS` expires, so "the subtree was
//       not mounted yet" is no longer a silent failure.
//
//   R2  A modal surface gives focus back when it closes. The element that held
//       the caret before the surface opened gets it again, if it is still in the
//       document and still focusable; if that element is gone - the same commit
//       that closed the surface removed it, or made its panel `inert` - focus is
//       released to the body instead, so the caret is never left on a detached
//       node. If the surface never actually took focus, nothing is restored: a
//       surface that did not move the caret must not move it back either.
//
//   R3  A focused control must be *visibly* focused: it shows a ring or a fill.
//       A control that suppresses the app-wide `:focus-visible` outline must draw
//       a substitute of its own, and a scroll container around it must not clip
//       that substitute away (`option-picker-list` used to cut every focused
//       option's left and right edge to 0.00 coverage). This rule is asserted in
//       two places, because neither alone can see all of it:
//         - `focus-ownership.test.ts` reads the stylesheets: every rule that
//           turns the outline off for a focus state must be paired with a visible
//           indicator for the same control, or be a named exception;
//         - `scripts/lib/focus-visibility.mjs` measures real pixels (focused
//           frame against the same pixels blurred) and fails when neither a ring
//           nor a fill appears, which is the only way to catch a ring that is
//           drawn and then clipped, covered, or scrolled out of its container.
//
// Deliberately NOT owned here: the Tab cycle (that is `modal-layer.ts`'s
// `nextFocusIndex` plus `useModalSurface`'s key handler), `:focus-visible`
// semantics (the browser decides how focus arrived; this module never forces a
// ring on for the mouse), and any surface's own visuals.

import { useEffect, useRef, type RefObject } from 'react'

/**
 * How long an opening surface keeps trying to place the caret.
 *
 * `FadePresence` mounts its subtree from two animation frames, so a surface can
 * legitimately be unmounted for two or three frames before its children exist;
 * at 60Hz that is well under 100ms. 500ms is the ceiling that keeps a surface
 * whose target genuinely never appears from retrying forever, and it is short
 * enough that it cannot be mistaken for "stealing focus later".
 */
export const ENTRY_FOCUS_TIMEOUT_MS = 500

/**
 * The longest wait between two entry-focus attempts.
 *
 * 16ms is one frame at 60Hz, which is what a foreground window gives. It is also
 * the floor for the clamped timer below: a window that is not foreground delivers
 * animation frames far more slowly, and a retry that only ever ran on those frames
 * could burn the whole timeout on four callbacks.
 */
export const ENTRY_FOCUS_RETRY_MS = 16

/** Position of the entry-focus retry loop, for tests and for a retry that gave up. */
export type EntryFocusOutcome = 'landed' | 'timeout' | 'superseded' | 'inactive'

export interface FocusOwnershipOptions {
  /** False while the surface is only animating out: it must not take the caret. */
  active: boolean
  /**
   * The surface's root. Used both as the search scope for a fallback target and
   * as the containment test that decides whether focus already landed.
   */
  containerRef: RefObject<HTMLElement>
  /** The deliberate target. Falls back to the first focusable element inside. */
  initialFocusRef?: RefObject<HTMLElement>
  /** Give the previously focused element the caret back on close. Default true. */
  restoreFocus?: boolean
  /** The focusable selector used for the fallback target. */
  focusableSelector: string
}

/**
 * True when `element` can currently receive focus.
 *
 * Deliberately *not* a geometry test. An earlier version required
 * `getClientRects().length > 0`, and that is exactly what made the 完全访问
 * warning land late: the dialog is the child of a mount transition that starts at
 * zero size, so the retry rejected the very target it was waiting for and gave up
 * before the transition finished. Chromium will focus an element that is
 * `visibility: hidden`, so only `display: none` (which the computed style reports
 * without any layout being ready) and `inert` are real disqualifiers here.
 *
 * The *fallback* search keeps a geometry test of its own (see `isVisible`), because
 * "pick the first focusable element in this container" is a different question: a
 * control the surface has not laid out yet must not be chosen over one it has.
 */
function isFocusable(element: HTMLElement): boolean {
  if (!element.isConnected) return false
  if (element.hasAttribute('disabled')) return false
  if (element.closest('[inert]')) return false
  return getComputedStyle(element).display !== 'none'
}

/**
 * Laid out at least one box. Used only to choose *between* candidates, never to
 * reject the surface's own declared target: a declared target that has no box yet
 * is a target that is about to have one, which is the whole reason R1 retries.
 */
function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0
}

/** The element that would take focus if the surface declared no deliberate target. */
function firstFocusable(container: HTMLElement, selector: string): HTMLElement | null {
  let fallback: HTMLElement | null = null
  for (const candidate of container.querySelectorAll<HTMLElement>(selector)) {
    if (!isFocusable(candidate)) continue
    if (isVisible(candidate)) return candidate
    fallback ??= candidate
  }
  // A container whose children have no boxes yet still has a first focusable
  // element; returning it lets the retry succeed as soon as it is laid out.
  return fallback
}

/**
 * The entry target for this frame: the declared ref if it is focusable, else the
 * first focusable element inside the container. Read fresh on every attempt,
 * because on the opening commit neither the container nor the target exists yet.
 */
export function resolveEntryFocus(
  containerRef: RefObject<HTMLElement>,
  initialFocusRef: RefObject<HTMLElement> | undefined,
  focusableSelector: string,
): HTMLElement | null {
  const target = initialFocusRef?.current
  if (target && isFocusable(target)) return target
  const container = containerRef.current
  if (!container) return null
  return firstFocusable(container, focusableSelector)
}

/** True when the caret is inside the surface, which is the condition R1 tests. */
function holdsFocus(container: HTMLElement | null, target: HTMLElement | null): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  if (target && active === target) return true
  return container !== null && active !== container && container.contains(active)
}

/**
 * Place the caret inside an opening surface, retrying until it lands.
 *
 * Returns a cancel function. The caller must call it when the surface closes or
 * deactivates, so a pending frame cannot place the caret after the surface it
 * belongs to is gone.
 *
 * `onOutcome` is called exactly once, with `landed` or `timeout`. It is how a
 * gate can tell "the surface took focus" from "the surface gave up", which are
 * different failures and must not both read as "no focus".
 */
export function captureEntryFocus(
  options: FocusOwnershipOptions,
  onOutcome?: (outcome: EntryFocusOutcome) => void,
): () => void {
  let frame = 0
  let deadline = 0
  let settled = false

  const finish = (outcome: EntryFocusOutcome, cancelled = false) => {
    if (settled) return
    settled = true
    if (!cancelled && frame !== 0) window.cancelAnimationFrame(frame)
    frame = 0
    onOutcome?.(outcome)
  }

  const attempt = () => {
    frame = 0
    if (settled) return
    const target = resolveEntryFocus(options.containerRef, options.initialFocusRef, options.focusableSelector)
    if (target) {
      target.focus({ preventScroll: true })
      if (holdsFocus(options.containerRef.current, target)) {
        finish('landed')
        return
      }
    }
    // The subtree is not mounted yet (or its target is still inert/disabled):
    // wait for the next frame rather than giving up on this commit. The wait is
    // clamped because a frame callback is not production-rate when the window is
    // not foreground - an off-screen acceptance window was measured delivering the
    // frames of a 400ms window in under five callbacks, which would have pushed the
    // landing past every deadline for no reason the user could see.
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      finish('timeout')
      return
    }
    frame = window.requestAnimationFrame(attempt)
    setTimeout(() => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      attempt()
    }, Math.min(ENTRY_FOCUS_RETRY_MS, remaining))
  }

  // The first attempt is synchronous, so a synchronously mounted surface lands
  // in the same tick it opened and never schedules a frame at all. The deadline
  // is set first because the attempt below tests it.
  deadline = performance.now() + ENTRY_FOCUS_TIMEOUT_MS
  attempt()

  return () => finish('superseded', true)
}

/**
 * Hand the caret back to `element`, if it can still take it.
 *
 * Returns whether focus was actually restored, so a caller can record the
 * difference between "returned to the trigger" and "the trigger is gone".
 */
export function restoreFocusTo(element: HTMLElement | null): boolean {
  if (!element || !isFocusable(element)) return false
  element.focus({ preventScroll: true })
  return document.activeElement === element
}

/**
 * Undo focus the way the browser does when the focused element disappears: the
 * caret goes back to the document body.
 *
 * This is the fallback for the case `restoreFocusTo` cannot serve. The
 * 完全访问 warning is the measured example: the option that opened it lives in
 * the mode-picker panel, and the same commit that mounts the warning makes that
 * panel `inert` - so the option is blurred *before* the warning's effect runs,
 * and the element the owner captured as "what held the caret before" is already
 * `BODY`. Restoring to it is a no-op, which would leave the caret wherever the
 * removed element left it. Blurring explicitly puts it back on the body, which
 * is where a real Tab press then starts from.
 */
export function releaseFocus(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) active.blur()
  if (document.activeElement !== document.body) document.body.focus({ preventScroll: true })
}

/**
 * The focus lifecycle of one surface: R1 on open, R2 on close.
 *
 * This is the hook `useModalSurface` is built on. A page-level surface (a
 * settings page, a popover, a menu) must not use it: those do not take the caret
 * when they appear, and taking it would move a keyboard user out of whatever
 * they were doing.
 */
export function useFocusOwnership(options: FocusOwnershipOptions): void {
  const { active, containerRef, restoreFocus = true, focusableSelector } = options
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!active) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let tookFocus = false

    const cancel = captureEntryFocus(
      {
        active,
        containerRef,
        initialFocusRef: optionsRef.current.initialFocusRef,
        restoreFocus,
        focusableSelector,
      },
      (outcome) => {
        if (outcome === 'landed') tookFocus = true
      },
    )

    return () => {
      cancel()
      // R2: only give the caret back if this surface actually took it. A surface
      // that never placed focus (or whose target never appeared) must leave the
      // caret exactly where the user left it.
      if (!restoreFocus || !tookFocus) return
      // Prefer the element that held the caret when the surface opened. If the
      // same commit that closed the surface also made that element unfocusable
      // (its panel went `inert`, it unmounted), fall back to releasing focus to
      // the body rather than leaving the caret on a detached node.
      if (!restoreFocusTo(previouslyFocused)) releaseFocus()
    }
    // `initialFocusRef` is read through `optionsRef`, so a caller that swaps the
    // target between renders does not restart the retry.
  }, [active, containerRef, focusableSelector, restoreFocus])
}
