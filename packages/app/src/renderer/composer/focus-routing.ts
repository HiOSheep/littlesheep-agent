const COMPOSER_FOCUS_EXCLUSION_SELECTOR = [
  'textarea',
  '.attachment-preview-grid',
  '.composer-controls',
  'button',
  'a',
  'input',
  'select',
  '[role="button"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
].join(', ')

/** Text surfaces that belong to somebody else while the user is typing in them. */
const TEXT_ENTRY_SELECTOR = 'textarea, input, [contenteditable="true"]'

type ClosestTarget = EventTarget & {
  closest?: (selector: string) => unknown
}

export function shouldFocusComposerInput(target: EventTarget | null): boolean {
  const candidate = target as ClosestTarget | null
  return typeof candidate?.closest === 'function'
    && !candidate.closest(COMPOSER_FOCUS_EXCLUSION_SELECTOR)
}

/**
 * Who asked for the composer's caret.
 *
 * `launch`: the shell just became interactive and the user has not chosen
 * anything yet, so the composer may take the caret only when nothing else owns
 * it. `new-session`: the user just asked for a new conversation, so the caret is
 * part of that command - unless a layer above the page, or another text surface,
 * owns it.
 */
export type ComposerFocusIntent = 'launch' | 'new-session'

/**
 * The part of an element this decision reads, so a caller (or a test) can state
 * the focus it has without constructing a DOM.
 */
export interface ComposerFocusTarget {
  closest?: (selector: string) => ComposerFocusTarget | null
  ownerDocument?: { body?: ComposerFocusTarget | null; documentElement?: ComposerFocusTarget | null } | null
}

export interface ComposerFocusRequest {
  intent: ComposerFocusIntent
  /** The element that owns focus right now, if any. */
  activeElement: ComposerFocusTarget | null
  /** Layers registered above the page: dialogs, approval prompts, open popups. */
  layerDepth: number
  /** The composer's own textarea, which is never "somewhere else". */
  target: ComposerFocusTarget
}

/**
 * Whether this request may take the caret.
 *
 * The guards are the whole point of the function: a dialog, an approval prompt
 * or a popup above the page owns the keyboard while it is up, and a user who has
 * moved focus somewhere else in the meantime keeps it. Nothing here focuses
 * anything - the caller still has to do that.
 */
export function shouldTakeComposerFocus(request: ComposerFocusRequest): boolean {
  if (request.layerDepth > 0) return false
  const active = request.activeElement
  if (!active || active === request.target) return true
  const document = active.ownerDocument
  if (active === document?.body || active === document?.documentElement) return true
  // Nothing else in the shell holds a caret at launch, so a launch request that
  // finds one has arrived after the user's own choice and must not undo it.
  if (request.intent === 'launch') return false
  const entry = typeof active.closest === 'function' ? active.closest(TEXT_ENTRY_SELECTOR) : null
  return entry === null || entry === request.target
}

/**
 * Window-level request for the composer's caret.
 *
 * `newSession()` lives in the session actions rather than in the composer, so the
 * two cannot pass a prop to each other; a window event is how this codebase
 * already hands a one-shot composer command across domains (see `ui/transient.ts`).
 * The composer re-checks the guards when it receives it, so a request that has
 * been overtaken by a dialog or by the user's own focus is simply dropped.
 */
export const COMPOSER_FOCUS_REQUEST_EVENT = 'littlesheep:composer-focus-request'

export function requestComposerFocus(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_REQUEST_EVENT))
}
