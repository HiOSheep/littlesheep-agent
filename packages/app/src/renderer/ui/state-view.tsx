// One structure for the four state views (loading / empty / unavailable / failure).
//
// The states are different facts, so they must not share a look: each one carries
// its own glyph from `state-icons.tsx`, its own ARIA answer from `state-view.ts`,
// and - for `unavailable` - a reason that the caller cannot omit. "Cannot be used
// here" therefore never renders as "there is nothing here": it has a slashed mark
// and a sentence saying why.
import type { ReactNode } from 'react'
import { EmptyIcon, FailureIcon, UnavailableIcon } from './state-icons'
import { viewStateSpec, type ViewState } from './state-view-specs'

interface StateViewBaseProps {
  /** Short statement of the fact, in the user's words. */
  title: string
  /** Optional second line: what it means for the next step. */
  description?: string
  /** The area's single most important action, if it has one. */
  action?: ReactNode
}

export interface OrdinaryStateViewProps extends StateViewBaseProps {
  state: 'loading' | 'empty' | 'failure'
}

/** `unavailable` requires the reason: the surface knows why it cannot be used. */
export interface UnavailableStateViewProps extends StateViewBaseProps {
  state: 'unavailable'
  reason: string
}

export type StateViewProps = OrdinaryStateViewProps | UnavailableStateViewProps

export function StateView(props: StateViewProps) {
  const spec = viewStateSpec(props.state)
  const reason = props.state === 'unavailable' ? props.reason : null
  return (
    <div
      className="state-view"
      data-state={props.state}
      role={spec.role}
      aria-busy={spec.busy ? true : undefined}
      aria-disabled={spec.disabled ? true : undefined}
    >
      <span className="state-view-icon" aria-hidden="true">{stateGlyph(props.state)}</span>
      <strong>{props.title}</strong>
      {props.description && <p>{props.description}</p>}
      {reason && <p className="state-view-reason">{reason}</p>}
      {props.action && <div className="state-view-action-slot">{props.action}</div>}
    </div>
  )
}

function stateGlyph(state: ViewState) {
  if (state === 'loading') return <span className="state-view-ring" />
  if (state === 'empty') return <EmptyIcon />
  if (state === 'unavailable') return <UnavailableIcon />
  return <FailureIcon />
}
