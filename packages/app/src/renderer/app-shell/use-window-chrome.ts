import { useLayoutEffect } from 'react'

/** Native window state changes CSS geometry without remounting conversations. */
export function useWindowChrome(): void {
  useLayoutEffect(() => window.littlesheep?.onWindowChrome?.((state) => {
    const root = document.documentElement
    if (root.dataset.windowLayout !== state.layout) root.dataset.windowLayout = state.layout
    if (root.dataset.nativeBackdrop !== state.backdrop) root.dataset.nativeBackdrop = state.backdrop
  }), [])
}
