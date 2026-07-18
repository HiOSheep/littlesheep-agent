// Small lifecycle guard shared by the embedded browser and its regression tests.
// Electron exposes webview methods before the guest is ready, but they are not
// safe to call until the guest has emitted dom-ready.

export interface PendingBrowserNavigationState {
  started: boolean
  sequence: number
}

export function canStartBrowserNavigation(
  pending: PendingBrowserNavigationState | null,
  sequence: number,
  browserReady: boolean,
  browserAvailable: boolean,
): boolean {
  return Boolean(
    pending
      && pending.sequence === sequence
      && !pending.started
      && browserReady
      && browserAvailable,
  )
}
