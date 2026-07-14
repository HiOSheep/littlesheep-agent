// Task composer controls, attachments, runtime selection, and sizing.

export const COMPOSER_INPUT_MAX_HEIGHT = 220

export const COMPOSER_INPUT_VIEWPORT_RATIO = 0.3


export function getComposerInputMaxHeight(): number {
  return Math.max(96, Math.min(COMPOSER_INPUT_MAX_HEIGHT, Math.round(window.innerHeight * COMPOSER_INPUT_VIEWPORT_RATIO)))
}


export function syncComposerInputHeight(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return
  textarea.style.height = 'auto'
  const maxHeight = getComposerInputMaxHeight()
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight)
  textarea.style.height = `${nextHeight}px`
  textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
}
