// Escape arbitration for stacked UI layers.
//
// One Escape keypress must dismiss exactly one layer: the topmost interactive
// one. Every surface that reacts to Escape registers itself while it is
// interactive and asks this registry whether it is on top before acting, so a
// dialog above a page-scope Escape handler (or a confirm above a popover) no
// longer collapses both at once.
//
// Registration is idempotent per id, so a React double-invoked effect cannot
// leave a duplicate entry behind.

export interface ModalLayerRegistry {
  push(id: string): void
  remove(id: string): void
  isTop(id: string): boolean
  top(): string | null
  depth(): number
}

export function createModalLayerRegistry(): ModalLayerRegistry {
  const layers: string[] = []
  return {
    push(id) {
      if (layers.includes(id)) return
      layers.push(id)
    },
    remove(id) {
      const index = layers.lastIndexOf(id)
      if (index >= 0) layers.splice(index, 1)
    },
    isTop(id) {
      return layers.length > 0 && layers[layers.length - 1] === id
    },
    top() {
      return layers.length > 0 ? layers[layers.length - 1]! : null
    },
    depth() {
      return layers.length
    },
  }
}

/** App-wide stack shared by every dismissible surface. */
export const modalLayers = createModalLayerRegistry()

/**
 * Index Tab (or Shift+Tab) moves to inside a bounded scope. Wrapping is decided
 * by the caller so a mid-list Tab keeps the browser's native behavior.
 */
export function nextFocusIndex(count: number, currentIndex: number, shift: boolean): number {
  if (count <= 0) return -1
  if (currentIndex < 0) return shift ? count - 1 : 0
  return shift ? (currentIndex - 1 + count) % count : (currentIndex + 1) % count
}

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')
