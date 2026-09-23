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
import { resizeWindowForAcceptance, showStartupErrorPageForAcceptance } from './desktop-visual-acceptance.js'

/** The window facts these actions need; `LittleSheepDesktopShell` satisfies it. */
export interface DesktopAcceptanceShell {
  close(): boolean
  show(): void
  currentWindow(): BrowserWindow | undefined
  showStartupError(error: unknown): void
}

type ContractActions = NonNullable<LocalAppApiServerOptions['desktopAcceptance']>

/**
 * Taken from the API contract so the two shapes cannot drift apart, with the two
 * actions this module always provides made required: inside an acceptance run
 * they are present, so callers do not have to re-check them.
 */
export type DesktopAcceptanceActions = ContractActions & Required<
  Pick<ContractActions, 'resizeForAcceptance' | 'showStartupErrorForAcceptance'>
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
    showStartupErrorForAcceptance: (message) =>
      showStartupErrorPageForAcceptance(
        input.shell.currentWindow(),
        message,
        (error) => input.shell.showStartupError(error),
      ),
  }
}
