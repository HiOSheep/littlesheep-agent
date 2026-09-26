// UX-29: which Shell a terminal session uses, and what to say when the preference is gone.
//
// Pure on purpose: the interesting cases are all about honesty — a preferred shell that no
// longer exists must be reported and replaced, never silently swapped for something else.

import type { WorkspaceShellProfile } from '../api/terminal'

export interface TerminalShellChoice {
  /** The profile to start, or null when this machine offers nothing. */
  selected: WorkspaceShellProfile | null
  /** A sentence for the user when their preference could not be honoured. */
  notice: string | null
  /** True when the preference was dropped rather than used. */
  preferenceLost: boolean
}

/** The default order: PowerShell 7, then Windows PowerShell, then cmd, then anything else. */
export function defaultTerminalShell(
  profiles: readonly WorkspaceShellProfile[],
): WorkspaceShellProfile | null {
  for (const id of ['windows-powershell', 'powershell-7', 'cmd', 'git-bash']) {
    const profile = profiles.find((candidate) => candidate.id === id && candidate.available)
    if (profile) return profile
  }
  return profiles.find((profile) => profile.available) ?? null
}

/**
 * Pick the shell to run from the saved preference and what was actually discovered.
 *
 * An unavailable or unknown preference falls back to the default *and says so* — the user
 * chose that shell once, so quietly running another one would hide a real change on their
 * machine (an uninstalled Git, a removed WSL distribution).
 */
export function resolveTerminalShellChoice(
  profiles: readonly WorkspaceShellProfile[],
  preferredId: string | null | undefined,
): TerminalShellChoice {
  const fallback = defaultTerminalShell(profiles)
  if (!preferredId) return { selected: fallback, notice: null, preferenceLost: false }

  const preferred = profiles.find((profile) => profile.id === preferredId)
  if (preferred?.available) return { selected: preferred, notice: null, preferenceLost: false }

  const known = preferred ? preferred : null
  const reason = known?.reason ?? `已保存的 Shell（${preferredId}）不在本机可用列表中。`
  const hint = known?.configHint ? ` ${known.configHint}` : ''
  const replacement = fallback ? `已改用 ${fallback.label}。` : '当前没有可用的 Shell。'
  return {
    selected: fallback,
    notice: `${reason}${hint} ${replacement}`,
    preferenceLost: true,
  }
}

/** The label to show for a running session: the real shell, never a hardcoded one. */
export function terminalShellLabel(
  profiles: readonly WorkspaceShellProfile[],
  shellId: string | null | undefined,
  sessionShell?: string | null,
): string {
  if (sessionShell && sessionShell.trim()) return sessionShell.trim()
  const profile = profiles.find((candidate) => candidate.id === shellId)
  return profile?.label ?? 'Shell'
}

/** The saved Shell preference for this workspace session (UX-29). */
export function preferredShellId(): string | null {
  try {
    const value = window.localStorage.getItem('littlesheep.terminal.shellId')
    return value && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

/** Storing the preference must never fail a terminal start. */
export function savePreferredShellId(id: string): void {
  try {
    window.localStorage.setItem('littlesheep.terminal.shellId', id)
  } catch {
    // Ignore: the shell still starts with this session's choice.
  }
}