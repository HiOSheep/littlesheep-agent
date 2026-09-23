// Isolated acceptance actions for the desktop window (taskbook CS-02 / CS-03).
//
// The acceptance run drives a real window through the hidden Local App API
// surface. The actions that need native window facts or a document swap live
// here so `index.ts` stays orchestration: `desktop-acceptance-snapshot.ts`
// provides the readable facts, `desktop-visual-acceptance.ts` the pixel-visible
// ones. Nothing in this module runs in a production start: the whole object is
// wired only when the acceptance environment variable is set.

import type { BrowserWindow } from 'electron'
import type { LocalAppApiServerOptions } from './local-app-api/contracts.js'
import {
  resizeWindowForAcceptance,
  setWindowMaximizedForAcceptance,
  setWindowMinimizedForAcceptance,
  showStartupErrorPageForAcceptance,
  showStartupPageForAcceptance,
} from './desktop-visual-acceptance.js'

/** The window facts these actions need; `LittleSheepDesktopShell` satisfies it. */
export interface DesktopAcceptanceShell {
  close(): boolean
  show(): void
  currentWindow(): BrowserWindow | undefined
  showStartupError(error: unknown): void
  showStartupPage(): boolean
}

type ContractActions = NonNullable<LocalAppApiServerOptions['desktopAcceptance']>

/**
 * Taken from the API contract so the two shapes cannot drift apart, with the two
 * actions this module always provides made required: inside an acceptance run
 * they are present, so callers do not have to re-check them.
 */
export type DesktopAcceptanceActions = ContractActions & Required<
  Pick<ContractActions, 'resizeForAcceptance' | 'setMaximizedForAcceptance' | 'setMinimizedForAcceptance' | 'showStartupErrorForAcceptance' | 'showStartupPageForAcceptance'>
>

export function createDesktopAcceptanceActions(input: {
  token: string
  snapshot: DesktopAcceptanceActions['snapshot']
  shell: DesktopAcceptanceShell
  quit: () => void
}): DesktopAcceptanceActions | undefined {
  if (process.env['LITTLESHEEP_ELECTRON_ACCEPTANCE'] !== '1') return undefined
  return {
    token: input.token,
    snapshot: input.snapshot,
    close: () => input.shell.close(),
    show: () => input.shell.show(),
    quit: input.quit,
    // CS-02 needs the native caption buttons rendered at more than one width,
    // which the renderer cannot drive.
    resizeForAcceptance: (size) => resizeWindowForAcceptance(input.shell.currentWindow(), size),
    // ...and in the maximized state, where the overlay meets a different width.
    setMaximizedForAcceptance: (maximized) =>
      setWindowMaximizedForAcceptance(input.shell.currentWindow(), maximized),
    // ...and for minimize/restore, where the question is what the window keeps.
    setMinimizedForAcceptance: (minimized) =>
      setWindowMinimizedForAcceptance(input.shell.currentWindow(), minimized),
    showStartupErrorForAcceptance: (message) =>
      showStartupErrorPageForAcceptance(
        input.shell.currentWindow(),
        message,
        (error) => input.shell.showStartupError(error),
      ),
    showStartupPageForAcceptance: () =>
      showStartupPageForAcceptance(input.shell.currentWindow(), () => input.shell.showStartupPage()),
  }
}

/** Upper bound on the acceptance delay, so a bad value cannot hang a run. */
const MAX_ACCEPTANCE_READY_DELAY_MS = 60_000

/**
 * How long to hold back the *publication* of execution readiness, in an
 * acceptance run only.
 *
 * A real start keeps the window not-ready for roughly 300 ms, which is too short
 * to check the pre-ready contract (draft accepted, send refused, notice shown)
 * by hand or by script. The Runner is built exactly as usual and only the publish
 * is delayed, so what this widens is the window the renderer sees - it does not
 * fake a slow or failed start. Outside an acceptance run it is always 0, and
 * `LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS` is bounded.
 */
export function acceptanceReadyDelayMs(): number {
  if (process.env['LITTLESHEEP_ELECTRON_ACCEPTANCE'] !== '1') return 0
  const requested = Number.parseInt(process.env['LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS'] ?? '', 10)
  if (!Number.isFinite(requested) || requested <= 0) return 0
  return Math.min(requested, MAX_ACCEPTANCE_READY_DELAY_MS)
}

/** Await the configured acceptance delay; returns how long it actually waited. */
export async function waitForAcceptanceReadyDelay(): Promise<number> {
  const delayMs = acceptanceReadyDelayMs()
  if (delayMs === 0) return 0
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  return delayMs
}
