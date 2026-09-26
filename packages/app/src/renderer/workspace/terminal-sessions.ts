// UX-30: several terminal tabs, each with its own Shell, directory, output and exit state.
//
// Pure state on purpose. The rules worth getting right are the ones a user notices: a tab is
// never silently replaced, closing one moves the selection somewhere sensible, the replay
// buffer is bounded, and input can never be routed to a session that is no longer running.
import type { WorkspaceShellProfile } from '../api/terminal'

export type TerminalSessionStatus = 'starting' | 'ready' | 'exited' | 'failed'

export interface TerminalSessionTab {
  id: string
  /** The discovered Shell profile this tab was started with, when it came from the picker. */
  shellId: string | null
  /** The real shell name the session reported. */
  shellLabel: string
  cwd: string
  status: TerminalSessionStatus
  exitCode?: number | null
  /** Bounded tail of this session's output, so switching back is not a blank screen. */
  replay: string
  /** True once output had to be dropped to stay inside the bound. */
  replayTruncated: boolean
}

export interface TerminalSessionsState {
  tabs: TerminalSessionTab[]
  activeId: string | null
  /** Why the most recent open was refused, when it was. */
  notice: string | null
}

/** How many terminals one workspace may hold at once. */
export const MAX_TERMINAL_TABS = 8
/** How much output per tab is kept for switching back. */
export const MAX_REPLAY_CHARS = 64 * 1024

export const EMPTY_TERMINAL_SESSIONS: TerminalSessionsState = { tabs: [], activeId: null, notice: null }

export type TerminalSessionsAction =
  | { type: 'open'; tab: Omit<TerminalSessionTab, 'replay' | 'replayTruncated'> }
  | { type: 'select'; id: string }
  | { type: 'output'; id: string; text: string }
  | { type: 'status'; id: string; status: TerminalSessionStatus; exitCode?: number | null }
  | { type: 'close'; id: string }
  /** Drops every tab: the workspace they belonged to is gone. */
  | { type: 'reset' }
  | { type: 'notice'; text: string | null }

/** The tab a keystroke belongs to, or null when nothing may receive input. */
export function terminalInputTarget(state: TerminalSessionsState): string | null {
  const active = state.tabs.find((tab) => tab.id === state.activeId)
  if (!active) return null
  // A session that has exited or failed must not receive input, and neither must one that is
  // still starting: whatever is typed would go to a process that is not reading yet.
  return active.status === 'ready' ? active.id : null
}

export function terminalTabStatusLabel(tab: Pick<TerminalSessionTab, 'status' | 'exitCode'>): string {
  if (tab.status === 'starting') return '启动中'
  if (tab.status === 'ready') return '运行中'
  if (tab.status === 'failed') return '启动失败'
  return typeof tab.exitCode === 'number' ? `已退出 ${tab.exitCode}` : '已退出'
}

export function reduceTerminalSessions(
  state: TerminalSessionsState,
  action: TerminalSessionsAction,
): TerminalSessionsState {
  switch (action.type) {
    case 'open': {
      if (state.tabs.length >= MAX_TERMINAL_TABS) {
        return {
          ...state,
          notice: `最多同时打开 ${MAX_TERMINAL_TABS} 个终端；请先关闭一个再新建。`,
        }
      }
      const tab: TerminalSessionTab = { ...action.tab, replay: '', replayTruncated: false }
      return { tabs: [...state.tabs, tab], activeId: tab.id, notice: null }
    }
    case 'select': {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state
      return state.activeId === action.id ? state : { ...state, activeId: action.id }
    }
    case 'output': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id)
      if (index < 0) return state
      const tab = state.tabs[index]!
      const combined = tab.replay + action.text
      const overflow = combined.length - MAX_REPLAY_CHARS
      const replay = overflow > 0 ? combined.slice(overflow) : combined
      const next: TerminalSessionTab = {
        ...tab,
        replay,
        replayTruncated: tab.replayTruncated || overflow > 0,
      }
      const tabs = [...state.tabs]
      tabs[index] = next
      return { ...state, tabs }
    }
    case 'status': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id)
      if (index < 0) return state
      const tab = state.tabs[index]!
      const next: TerminalSessionTab = {
        ...tab,
        status: action.status,
        ...(action.exitCode === undefined ? {} : { exitCode: action.exitCode }),
      }
      const tabs = [...state.tabs]
      tabs[index] = next
      return { ...state, tabs }
    }
    case 'close': {
      const index = state.tabs.findIndex((tab) => tab.id === action.id)
      if (index < 0) return state
      const tabs = state.tabs.filter((tab) => tab.id !== action.id)
      if (state.activeId !== action.id) return { ...state, tabs }
      // The neighbour to the right, else the one to the left, else nothing — never a tab that
      // is not there.
      const neighbour = tabs[index] ?? tabs[index - 1] ?? null
      return { tabs, activeId: neighbour?.id ?? null, notice: state.notice }
    }
    case 'reset':
      return state.tabs.length === 0 && state.activeId === null ? state : EMPTY_TERMINAL_SESSIONS
    case 'notice':
      return state.notice === action.text ? state : { ...state, notice: action.text }
    default:
      return state
  }
}

/** The tab to open next: the same shell, in the same directory, until the user says otherwise. */
export function nextTerminalTabShell(
  profiles: readonly WorkspaceShellProfile[],
  state: TerminalSessionsState,
): WorkspaceShellProfile | null {
  const active = state.tabs.find((tab) => tab.id === state.activeId)
  const fromActive = active?.shellId
    ? profiles.find((profile) => profile.id === active.shellId && profile.available)
    : undefined
  if (fromActive) return fromActive
  return profiles.find((profile) => profile.available) ?? null
}
