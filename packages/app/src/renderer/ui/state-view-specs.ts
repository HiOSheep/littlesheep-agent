// The four state views, as data.
//
// "Loading", "nothing here", "cannot be used" and "failed" are four different
// facts, and the current app renders three of them with the same muted grey and
// no mark at all - which is how a disabled area ends up reading as an empty list.
// The table below is the contract every state view answers to, and it is kept
// separate from the component so the distinction can be asserted directly
// (`ui-state-matrix.test.ts`): every state has its own role, its own busy/disabled
// answer and its own glyph, and no two states share a signature.
//
// Which fact each state is:
//   loading      - work is in flight; the surface will fill itself.
//   empty        - the query succeeded and there is genuinely nothing.
//   unavailable  - the surface cannot be used *here* (no model configured, the
//                  Runtime is not ready, the feature is off). It must state the
//                  reason; without one it would be indistinguishable from empty.
//   failure      - something was attempted and did not complete. It keeps the
//                  danger tone and offers the retry.

export type ViewState = 'loading' | 'empty' | 'unavailable' | 'failure'

export interface ViewStateSpec {
  /** The container's ARIA role: only a failure interrupts. */
  role: 'alert' | 'status'
  /** `aria-busy` on the container. */
  busy: boolean
  /** `aria-disabled` on the container: the area cannot act in this state. */
  disabled: boolean
  /** The glyph the view draws. Four states, four different shapes. */
  icon: 'ring' | 'tray' | 'slashed' | 'danger'
  /** A reason is mandatory, not optional. */
  requiresReason: boolean
  /** Whether the state may offer the one action of its area. */
  allowsAction: boolean
}

export const VIEW_STATE_SPECS: Record<ViewState, ViewStateSpec> = {
  loading: { role: 'status', busy: true, disabled: false, icon: 'ring', requiresReason: false, allowsAction: false },
  empty: { role: 'status', busy: false, disabled: false, icon: 'tray', requiresReason: false, allowsAction: true },
  unavailable: { role: 'status', busy: false, disabled: true, icon: 'slashed', requiresReason: true, allowsAction: false },
  failure: { role: 'alert', busy: false, disabled: false, icon: 'danger', requiresReason: false, allowsAction: true },
}

export const VIEW_STATES = Object.keys(VIEW_STATE_SPECS) as ViewState[]

export function viewStateSpec(state: ViewState): ViewStateSpec {
  return VIEW_STATE_SPECS[state]
}
