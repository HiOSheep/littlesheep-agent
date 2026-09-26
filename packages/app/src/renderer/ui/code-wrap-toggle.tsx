import { codeWrapToggleLabel } from './code-wrap-preference'

/**
 * Two icons, one switch. `off` lets the middle line run straight past the right edge with the
 * arrow pointing out of the block; `on` folds the same line down onto the next row with the arrow
 * pointing back into it. Both keep the shared `sidebar-svg-icon` primitives, so the button says
 * which state it is in from its own drawing and not only from `aria-pressed`.
 */
function WrapOffIcon() {
  return (
    <svg className="sidebar-svg-icon code-wrap-icon" data-wrap-icon="off" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.25 3.5h11.5M2.25 6.5h6.4" />
      <path d="m7.5 4.65 1.85 1.85-1.85 1.85" />
      <path d="M2.25 10.4h11.5" />
    </svg>
  )
}

function WrapOnIcon() {
  return (
    <svg className="sidebar-svg-icon code-wrap-icon" data-wrap-icon="on" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.25 3.5h11.5M2.25 6.5h7.1a2.4 2.4 0 1 1 0 4.8H7.7" />
      <path d="m9.35 9.4-2 1.95 2 1.95" />
      <path d="M13.75 6.5v3.7" />
    </svg>
  )
}

export function CodeWrapToggle({
  wrapped,
  onToggle,
  className = 'code-wrap-toggle',
}: {
  wrapped: boolean
  onToggle: () => void
  className?: string
}) {
  const label = codeWrapToggleLabel(wrapped)
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-pressed={wrapped}
      title={label}
      data-wrapped={wrapped ? 'true' : 'false'}
      onClick={onToggle}
    >
      {wrapped ? <WrapOnIcon /> : <WrapOffIcon />}
    </button>
  )
}
