import { codeWrapToggleLabel } from './code-wrap-preference'

/**
 * One glyph, four strokes, two states. `off` lets the middle line run to the right edge
 * with the arrow pointing out of the block; `on` folds the same line down onto the next row with the
 * arrow pointing back into it.
 *
 * The middle run and arrow keep the same path commands in both states, so the stylesheet can transition
 * `d` and the strokes travel into their new position instead of one icon replacing the other (asked
 * for 2026-10-03: a cross-fade was the wrong answer). The top line never changes and is only drawn
 * once; the short bottom line also stays fixed. The arrow tip follows the run's endpoint throughout.
 *
 * Both states stay one accessible name and one tab stop; the glyph is decoration either way.
 */
function strokePath(className: string, off: string) {
  return <path className={`code-wrap-stroke ${className}`} d={off} />
}

export function CodeWrapToggle({
  wrapped,
  onToggle,
  className = 'code-wrap-toggle',
  showTooltip = true,
}: {
  wrapped: boolean
  onToggle: () => void
  showTooltip?: boolean
  className?: string
}) {
  const label = codeWrapToggleLabel(wrapped)
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      aria-pressed={wrapped}
      title={showTooltip ? label : undefined}
      data-wrapped={wrapped ? 'true' : 'false'}
      onClick={onToggle}
    >
      <svg className="sidebar-svg-icon code-wrap-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {/* Never changes. */}
        <path className="code-wrap-stroke code-wrap-top" d="M2.5 3.5 H13.5" />
        {/* The run: straight to the right edge, or extended and turned down onto the next row. The
            turn uses two cubics so both states share one command list (`M H C C H`). */}
        {strokePath('code-wrap-run', 'M2.5 7 H11.5 C11.5 7 13.5 7 13.5 7 C13.5 7 13.5 7 13.5 7 H13.5')}
        {/* The arrow head: it points out of the block, or back into the folded line. */}
        {strokePath('code-wrap-arrow', 'M11.5 5 L13.5 7 L11.5 9')}
        {/* A fixed short line leaves room for the return arrow. */}
        {strokePath('code-wrap-foot', 'M2.5 11 L5.5 11')}
      </svg>
    </button>
  )
}
