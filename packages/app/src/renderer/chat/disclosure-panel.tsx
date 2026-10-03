// The one disclosure surface for the chat transcript.
//
// The interaction guidelines require the disclosure-panel pattern: a panel that
// opens and closes must never mount or unmount instantly. The transcript's rows
// used to be native `<details>` elements, which snap open and closed with no
// transition at all — the same gesture felt smooth on a tool row and abrupt one
// line above it. Every fold in the transcript is on this primitive now, using
// the grid 0fr→1fr technique the tool details already proved: the panel keeps
// its box in the layout and grows into it, so opening and closing are one
// transition played in two directions.
//
// `disclosure-panel` also carries the closed-state pointer rule asserted by
// interaction-visibility.test.ts, and `inert` keeps the closed subtree out of
// tab order.
import type { ReactNode } from 'react'


export function DisclosurePanel({
  open,
  id,
  className,
  innerClassName,
  children,
}: {
  id?: string
  open: boolean
  className?: string
  innerClassName?: string
  children: ReactNode
}) {
  return (
    <div
      id={id}
      className={`agent-flow-disclosure disclosure-panel${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden={!open}
      {...(!open ? { inert: '' } : {})}
    >
      <div className={`agent-flow-disclosure-inner${innerClassName ? ` ${innerClassName}` : ''}`}>{children}</div>
    </div>
  )
}
