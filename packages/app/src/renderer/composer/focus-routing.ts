const COMPOSER_FOCUS_EXCLUSION_SELECTOR = [
  'textarea',
  '.attachment-preview-grid',
  '.composer-controls',
  'button',
  'a',
  'input',
  'select',
  '[role="button"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
].join(', ')

type ClosestTarget = EventTarget & {
  closest?: (selector: string) => unknown
}

export function shouldFocusComposerInput(target: EventTarget | null): boolean {
  const candidate = target as ClosestTarget | null
  return typeof candidate?.closest === 'function'
    && !candidate.closest(COMPOSER_FOCUS_EXCLUSION_SELECTOR)
}
