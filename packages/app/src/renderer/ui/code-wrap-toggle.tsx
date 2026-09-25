import { codeWrapToggleLabel } from './code-wrap-preference'

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
      <svg className="sidebar-svg-icon code-wrap-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.25 3.5h11.5M2.25 6.5h7.1a2.4 2.4 0 1 1 0 4.8H7.7" />
        <path d="m9.35 9.4-2 1.95 2 1.95" />
        <path d="M13.75 6.5v3.7" />
      </svg>
    </button>
  )
}
