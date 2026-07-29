import type { DesktopClosePolicy } from '@littlesheep/config'

export type LastWindowCloseAction = 'hide' | 'quit'

export interface LastWindowCloseContext {
  policy: DesktopClosePolicy
  activeRunCount: number
  trayAvailable: boolean
}

/** Hidden background execution is allowed only when the user can see and control it from a tray. */
export function decideLastWindowClose(context: LastWindowCloseContext): LastWindowCloseAction {
  if (!context.trayAvailable) return 'quit'
  if (context.policy === 'always-background') return 'hide'
  if (context.policy === 'background-while-active' && context.activeRunCount > 0) return 'hide'
  return 'quit'
}
