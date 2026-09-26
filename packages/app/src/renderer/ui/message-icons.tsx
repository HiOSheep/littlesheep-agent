// The glyphs on a message's own action row: copy, and branch the conversation from here.
//
// The copy mark is the classic two sheets, drawn so the front one really sits in front: the back
// sheet is stroked first and the front sheet's interior is filled with the row's own background, so
// the back sheet's lines stop at its edge instead of crossing it.

export function CopyIcon() {
  return (
    <svg className="sidebar-svg-icon copy-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <rect className="copy-icon-back" x="5.5" y="2.6" width="8" height="8" rx="2.1" />
      <rect className="copy-icon-front" x="2.5" y="5.4" width="8" height="8" rx="2.1" />
    </svg>
  )
}

/** A stem that splits in two: one conversation becoming two. */
export function BranchIcon() {
  return (
    <svg className="sidebar-svg-icon branch-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <circle cx="4.6" cy="3.6" r="1.7" />
      <circle cx="11.4" cy="3.6" r="1.7" />
      <circle cx="8" cy="12.4" r="1.7" />
      <path d="M4.6 5.3v1.1a1.9 1.9 0 0 0 1.9 1.9h3a1.9 1.9 0 0 0 1.9-1.9V5.3" />
      <path d="M8 8.3v2.4" />
    </svg>
  )
}
/** The usage pill's mark: a small stacked-database glyph. */
export function UsageIcon() {
  return (
    <svg className="sidebar-svg-icon usage-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <ellipse cx="8" cy="4.1" rx="4.6" ry="1.9" />
      <path d="M3.4 4.1v3.9c0 1 2.1 1.9 4.6 1.9s4.6-.9 4.6-1.9V4.1" />
      <path d="M3.4 8v3.9c0 1 2.1 1.9 4.6 1.9s4.6-.9 4.6-1.9V8" />
    </svg>
  )
}