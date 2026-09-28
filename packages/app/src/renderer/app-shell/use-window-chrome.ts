import { useLayoutEffect } from 'react'

/** Native window state changes CSS geometry without remounting conversations. */
export function useWindowChrome(): void {
  useLayoutEffect(() => window.littlesheep?.onWindowChrome?.((state) => {
    document.documentElement.dataset.windowLayout = state.layout
    document.documentElement.dataset.nativeBackdrop = state.backdrop
  }), [])
}
