// Point the desktop shortcut at the runtime this checkout just prepared.
//
// Hangs off `predev` / `prebuild` (through `@littlesheep/app`) and `build:app`,
// so the icon never lags behind an Electron upgrade. Two modes:
//
//   (default)  best effort — skips when there is nothing to do, and reports a
//              failure without failing the command it is attached to
//   --strict   the explicit act, i.e. `pnpm run refresh:desktop-shortcut`:
//              creates a missing shortcut and propagates any failure
import { explicitShortcutCommand, syncDesktopShortcut } from './lib/desktop-shortcut.mjs'

const strict = process.argv.includes('--strict')

const result = await syncDesktopShortcut({ mode: strict ? 'strict' : 'auto' })

if (result.status === 'skipped') {
  console.log(`Desktop shortcut: skipped (${result.reason}).`)
} else if (result.status === 'failed') {
  // Auto mode only. Exit 0 on purpose: the command this is attached to still
  // has work to do, and the message below is what makes the state visible.
  console.error(`Desktop shortcut was not refreshed: ${result.detail}`)
  console.error(`Run ${explicitShortcutCommand} to retry, or launch from the repository instead.`)
}
