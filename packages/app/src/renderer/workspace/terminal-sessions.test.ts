// UX-30: the rules for several terminal tabs.
//
// These are the behaviours a user notices when they go wrong: a tab silently replaced, the
// selection jumping somewhere unexpected after a close, unbounded memory from a chatty
// process, or — worst — keystrokes going to a session that has already exited.
import { describe, expect, it } from 'vitest'
import {
  EMPTY_TERMINAL_SESSIONS,
  MAX_REPLAY_CHARS,
  MAX_TERMINAL_TABS,
  nextTerminalTabShell,
  reduceTerminalSessions,
  terminalInputTarget,
  terminalTabStatusLabel,
  type TerminalSessionsState,
} from './terminal-sessions'

const tab = (id: string, shellId = 'windows-powershell') => ({
  id,
  shellId,
  shellLabel: 'Windows PowerShell',
  cwd: 'C:\\work',
  status: 'starting' as const,
})

function withTabs(...ids: string[]): TerminalSessionsState {
  return ids.reduce(
    (state, id) => reduceTerminalSessions(state, { type: 'open', tab: tab(id) }),
    EMPTY_TERMINAL_SESSIONS,
  )
}

describe('terminal session tabs', () => {
  it('opens a new tab without replacing the one that is running', () => {
    const one = withTabs('a')
    const two = reduceTerminalSessions(one, { type: 'open', tab: tab('b') })

    expect(two.tabs.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(two.activeId).toBe('b')
    // The first tab is untouched: no status change, no lost output.
    expect(two.tabs[0]).toMatchObject({ id: 'a', status: 'starting', replay: '' })
  })

  it('refuses beyond the documented cap and says why', () => {
    const full = withTabs(...Array.from({ length: MAX_TERMINAL_TABS }, (_unused, index) => `t${index}`))
    const refused = reduceTerminalSessions(full, { type: 'open', tab: tab('one-too-many') })

    expect(refused.tabs).toHaveLength(MAX_TERMINAL_TABS)
    expect(refused.notice).toContain(`最多同时打开 ${MAX_TERMINAL_TABS} 个终端`)
    expect(refused.activeId).toBe(full.activeId)
  })

  it('keeps the replay buffer bounded and remembers that it dropped output', () => {
    let state = withTabs('a')
    state = reduceTerminalSessions(state, { type: 'output', id: 'a', text: 'x'.repeat(MAX_REPLAY_CHARS + 10) })

    const entry = state.tabs[0]!
    expect(entry.replay.length).toBe(MAX_REPLAY_CHARS)
    expect(entry.replayTruncated).toBe(true)
    // The tail is what survives, because that is what a user reads after switching back.
    expect(entry.replay.endsWith('x')).toBe(true)

    state = reduceTerminalSessions(state, { type: 'output', id: 'a', text: 'END' })
    expect(state.tabs[0]!.replay.endsWith('END')).toBe(true)
  })

  it('moves the selection to a neighbour when the active tab closes', () => {
    const three = withTabs('a', 'b', 'c')
    const selected = reduceTerminalSessions(three, { type: 'select', id: 'b' })
    const closed = reduceTerminalSessions(selected, { type: 'close', id: 'b' })

    expect(closed.tabs.map((entry) => entry.id)).toEqual(['a', 'c'])
    // Right neighbour first, so the selection moves predictably.
    expect(closed.activeId).toBe('c')

    const last = reduceTerminalSessions(closed, { type: 'close', id: 'c' })
    expect(last.activeId).toBe('a')
    const none = reduceTerminalSessions(last, { type: 'close', id: 'a' })
    expect(none.activeId).toBeNull()
    expect(none.tabs).toEqual([])
  })

  it('never routes input to a session that is not running', () => {
    let state = withTabs('a')
    expect(terminalInputTarget(state)).toBeNull() // still starting
    state = reduceTerminalSessions(state, { type: 'status', id: 'a', status: 'ready' })
    expect(terminalInputTarget(state)).toBe('a')
    state = reduceTerminalSessions(state, { type: 'status', id: 'a', status: 'exited', exitCode: 0 })
    expect(terminalInputTarget(state)).toBeNull()
    state = reduceTerminalSessions(state, { type: 'status', id: 'a', status: 'failed' })
    expect(terminalInputTarget(state)).toBeNull()
    // Selecting something that is not there changes nothing.
    expect(reduceTerminalSessions(state, { type: 'select', id: 'gone' })).toBe(state)
  })

  it('labels each tab with its real state', () => {
    expect(terminalTabStatusLabel({ ...tab('a'), status: 'starting' })).toBe('启动中')
    expect(terminalTabStatusLabel({ ...tab('a'), status: 'ready' })).toBe('运行中')
    expect(terminalTabStatusLabel({ ...tab('a'), status: 'failed' })).toBe('启动失败')
    expect(terminalTabStatusLabel({ ...tab('a'), status: 'exited', exitCode: 3 })).toBe('已退出 3')
    expect(terminalTabStatusLabel({ ...tab('a'), status: 'exited' })).toBe('已退出')
  })

  it('opens the next tab with the shell the active one uses, when it still exists', () => {
    const profiles = [
      { id: 'windows-powershell', kind: 'windows-powershell' as const, label: 'Windows PowerShell', available: true },
      { id: 'git-bash', kind: 'git-bash' as const, label: 'Git Bash', available: true },
    ]
    const withBash = reduceTerminalSessions(EMPTY_TERMINAL_SESSIONS, { type: 'open', tab: tab('a', 'git-bash') })
    expect(nextTerminalTabShell(profiles, withBash)?.id).toBe('git-bash')

    // A shell that disappeared since falls back to whatever is available.
    const gone = reduceTerminalSessions(EMPTY_TERMINAL_SESSIONS, { type: 'open', tab: tab('a', 'wsl:Ubuntu') })
    expect(nextTerminalTabShell(profiles, gone)?.id).toBe('windows-powershell')
    expect(nextTerminalTabShell([], gone)).toBeNull()
  })

  it('ignores output and status for tabs that are gone', () => {
    const state = withTabs('a')
    expect(reduceTerminalSessions(state, { type: 'output', id: 'ghost', text: 'x' })).toBe(state)
    expect(reduceTerminalSessions(state, { type: 'status', id: 'ghost', status: 'ready' })).toBe(state)
  })
})
