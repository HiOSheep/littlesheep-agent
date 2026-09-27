// Keep the desktop shortcut pointing at the prepared Electron runtime.
//
// The link target is
// `packages/app/runtime/electron-v<version>-<platform>-<arch>/LittleSheep.exe`,
// so upgrading Electron silently invalidates it: the desktop icon keeps
// launching the previous Chromium, and a change that depends on a new engine
// reads as "nothing happened". Chromium 136, for example, does not know
// `corner-shape` and falls back to ordinary rounded corners without a word.
// `scripts/build-app.ps1` always refreshed the link, but the pnpm entries did
// not, and `pnpm run dev` is the one the dev loop actually uses.
//
// This module owns the cross-platform half: whether the platform can carry a
// shortcut at all, how PowerShell is invoked, and staying non-fatal in auto
// mode. Everything Windows-specific stays in the PowerShell script — including
// the Desktop path, which can be redirected and is only trustworthy when read
// back through .NET. Asking "is there a link?" or "is the build ready?" here
// would duplicate the artifact list the script already owns.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const shortcutScriptRelativePath = 'scripts/refresh-desktop-shortcut.ps1'
export const explicitShortcutCommand = 'pnpm run refresh:desktop-shortcut'

/**
 * `--strict` turns the best-effort lifecycle hook back into an explicit act: it
 * creates the shortcut when it is missing and lets a failure reach the caller.
 */
export const shortcutSyncModes = ['auto', 'strict']

export function planDesktopShortcutSync({ platform = process.platform } = {}) {
  if (platform !== 'win32') return { action: 'skip', reason: 'unsupported-platform' }
  return { action: 'run' }
}

/**
 * Auto mode passes `-IfPresent`: the script then treats "this desktop has no
 * shortcut" and "the app is not built yet" as states to report rather than
 * errors to throw, so attaching this to `predev` cannot block a fresh checkout.
 */
export function powershellInvocation(scriptPath, { ifPresent }) {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      ...(ifPresent ? ['-IfPresent'] : []),
    ],
  }
}

export function runPowerShellShortcut({ repoRoot, scriptPath, ifPresent, spawn = spawnSync }) {
  const { command, args } = powershellInvocation(scriptPath, { ifPresent })
  const result = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) return { ok: false, detail: result.error.message }
  if (result.status !== 0) {
    return { ok: false, detail: `refresh-desktop-shortcut.ps1 exited with ${result.status ?? 'no status'}` }
  }
  return { ok: true }
}

export async function syncDesktopShortcut({
  repoRoot = defaultRepoRoot,
  mode = 'auto',
  platform = process.platform,
  runScript = runPowerShellShortcut,
} = {}) {
  const strict = mode === 'strict'
  if (strict && platform !== 'win32') {
    throw new Error('The desktop shortcut only exists on Windows.')
  }

  const plan = strict ? { action: 'run' } : planDesktopShortcutSync({ platform })
  if (plan.action === 'skip') return { status: 'skipped', reason: plan.reason }

  const scriptPath = join(repoRoot, shortcutScriptRelativePath)
  let outcome
  try {
    outcome = await runScript({ repoRoot, scriptPath, ifPresent: !strict })
  } catch (error) {
    outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }

  if (outcome?.ok) return { status: 'synced' }
  const detail = outcome?.detail ?? 'the shortcut refresh reported no result'
  // Auto mode is a convenience attached to a command with a job of its own: a
  // stale icon must not stop `pnpm run dev` from starting.
  if (strict) throw new Error(detail)
  return { status: 'failed', detail }
}
