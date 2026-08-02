// Task composer controls, attachments, runtime selection, and sizing.

export const COMPOSER_INPUT_MAX_HEIGHT = 220

export const COMPOSER_INPUT_VIEWPORT_RATIO = 0.3

export const COMPOSER_INPUT_MIN_HEIGHT = 36


export function getComposerInputMaxHeight(viewportHeight = window.innerHeight): number {
  return Math.max(96, Math.min(COMPOSER_INPUT_MAX_HEIGHT, Math.round(viewportHeight * COMPOSER_INPUT_VIEWPORT_RATIO)))
}


export function clampComposerInputHeight(measuredHeight: number, maxHeight: number): number {
  const safeMeasuredHeight = Number.isFinite(measuredHeight) ? Math.ceil(measuredHeight) : COMPOSER_INPUT_MIN_HEIGHT
  const safeMaxHeight = Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.floor(maxHeight))
  return Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.min(safeMeasuredHeight, safeMaxHeight))
}


export function syncComposerInputHeight(
  textarea: HTMLTextAreaElement | null,
  maxHeight = getComposerInputMaxHeight(),
): void {
  if (!textarea) return

  if (textarea.value.length === 0) {
    textarea.style.height = `${COMPOSER_INPUT_MIN_HEIGHT}px`
    textarea.style.overflowY = 'hidden'
    return
  }

  // A zero-height measurement cannot inherit a stale inline height from a
  // previous narrow layout or a just-finished workspace transition.
  textarea.style.height = '0px'
  const measuredHeight = textarea.scrollHeight
  const nextHeight = clampComposerInputHeight(measuredHeight, maxHeight)
  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = measuredHeight > maxHeight ? 'auto' : 'hidden'
}
