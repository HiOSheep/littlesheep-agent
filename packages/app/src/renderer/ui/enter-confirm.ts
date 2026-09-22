// Enter semantics shared by text-entry surfaces that confirm on Enter.
//
// Plain Enter confirms the current input, Shift+Enter keeps the line break, and
// an Enter an input method uses to confirm candidate words does neither. The
// rules live in a plain module so the key sequence can be replayed in tests
// without a browser window, an installed IME or a rendered React tree.

/** Key identity Windows IMEs report for the keystroke that ends a composition. */
export const IME_PROCESS_KEY_CODE = 229

export interface EnterKeyEvent {
  key: string
  shiftKey: boolean
  /**
   * Native composition flag. Chromium sets it on the keydown that confirms
   * candidates, so the same Enter that accepts a word never reaches `confirm`.
   */
  isComposing?: boolean
  /**
   * Legacy identity. IME and Chromium builds that clear `isComposing` before
   * the confirming keydown still report 229 for that keystroke.
   */
  keyCode?: number
}

/**
 * Tracks composition across keydown events. A confirming keydown can arrive
 * after `compositionend`, so the flag from the composition events is the only
 * state that survives that ordering.
 */
export interface ImeCompositionState {
  readonly composing: boolean
  start(): void
  end(): void
}

export function createImeCompositionState(): ImeCompositionState {
  let composing = false
  return {
    get composing() {
      return composing
    },
    start() {
      composing = true
    },
    end() {
      composing = false
    },
  }
}

export type EnterAction = 'confirm' | 'line-break' | 'ignore'

export function isImeCompositionKey(event: EnterKeyEvent, composing = false): boolean {
  return composing || event.isComposing === true || event.keyCode === IME_PROCESS_KEY_CODE
}

/**
 * `confirm` means "submit this input", never "insert a newline"; callers own
 * the side effect. `line-break` leaves the default textarea behavior alone.
 */
export function resolveEnterAction(event: EnterKeyEvent, composing = false): EnterAction {
  if (event.key !== 'Enter') return 'ignore'
  if (isImeCompositionKey(event, composing)) return 'ignore'
  return event.shiftKey ? 'line-break' : 'confirm'
}
