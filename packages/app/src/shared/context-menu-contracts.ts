// Native edit capabilities are issued for one real context-menu invocation.
export const CONTEXT_MENU_OPEN_CHANNEL = 'littlesheep:context-menu-open'
export const CONTEXT_MENU_ACTION_CHANNEL = 'littlesheep:context-menu-action'
export const CONTEXT_MENU_ACTIONS = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'copyLink', 'openLink', 'copyImage'] as const
export type ContextMenuAction = typeof CONTEXT_MENU_ACTIONS[number]
export interface ContextMenuItem {
  id: ContextMenuAction
  label: string
  enabled: boolean
  shortcut?: string
  dividerBefore?: boolean
}
export interface NativeContextMenu {
  requestId: string
  x: number
  y: number
  items: ContextMenuItem[]
}
export function isContextMenuAction(value: unknown): value is ContextMenuAction {
  return typeof value === 'string' && (CONTEXT_MENU_ACTIONS as readonly string[]).includes(value)
}
export function isNativeContextMenu(value: unknown): value is NativeContextMenu {
  if (!value || typeof value !== 'object') return false
  const menu = value as NativeContextMenu
  return typeof menu.requestId === 'string' && menu.requestId.length <= 128
    && Number.isFinite(menu.x) && Number.isFinite(menu.y)
    && Array.isArray(menu.items) && menu.items.length <= CONTEXT_MENU_ACTIONS.length
    && menu.items.every((item) => item && isContextMenuAction(item.id)
      && typeof item.label === 'string' && item.label.length <= 80 && typeof item.enabled === 'boolean'
      && (item.shortcut === undefined || typeof item.shortcut === 'string' && item.shortcut.length <= 24)
      && (item.dividerBefore === undefined || typeof item.dividerBefore === 'boolean'))
}
