// The state glyph family: one shape per feedback tone and one per state view.
//
// They live in their own family file instead of `icons.tsx` because that file is
// a frozen composition hotspot (see `check:repo`), and because a state mark has a
// different job from an action mark: it has to be recognisable as a *state* at
// 14px, next to text, without relying on its colour. Each glyph below is a
// different silhouette - a crossed circle, a triangle, a ticked circle, an
// information circle, a slashed circle, a tray - so "failed", "warning",
// "success", "info", "cannot be used" and "nothing here" cannot be confused when
// the surface is read in greyscale.

export function FailureIcon() {
  return (
    <svg className="state-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 4.7v4.5" />
      <circle cx="8" cy="11.6" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function WarningIcon() {
  return (
    <svg className="state-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <path d="M8 2.5 14.4 13.4H1.6z" />
      <path d="M8 6.3v3.3" />
      <path d="M8 11.6h.01" />
    </svg>
  )
}

export function SuccessIcon() {
  return (
    <svg className="state-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <circle cx="8" cy="8" r="6.1" />
      <path d="M5.2 8.2 7.3 10.3l3.6-4.1" />
    </svg>
  )
}

export function InfoIcon() {
  return (
    <svg className="state-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <circle cx="8" cy="8" r="6.1" />
      <path d="M8 7.3v4.1" />
      <path d="M8 4.6h.01" />
    </svg>
  )
}

/** "Cannot be used": a slashed circle, the one state mark that is not a warning. */
export function UnavailableIcon() {
  return (
    <svg className="state-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <circle cx="8" cy="8" r="6.1" />
      <path d="M4.1 11.9 11.9 4.1" />
    </svg>
  )
}

/** "Nothing here yet": an open tray, so an empty list never reads as a failure. */
export function EmptyIcon() {
  return (
    <svg className="state-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" shapeRendering="geometricPrecision">
      <path d="M2.4 9.1h3.1l.9 1.7h3.2l.9-1.7h3.1" />
      <path d="M2.4 9.1 4.2 3.5h7.6l1.8 5.6v3.4H2.4z" />
    </svg>
  )
}
