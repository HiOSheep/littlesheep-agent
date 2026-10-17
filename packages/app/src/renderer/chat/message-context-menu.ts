import type { MouseEvent } from 'react'
import { openContextMenuFromEvent, usesNativeContextMenu, type ContextAction } from '../ui/context-menu'

/** A message menu supplements native selection/link menus without taking them over. */
export function openMessageContextMenu(event: MouseEvent<HTMLElement>, text: string, onBranch?: () => void): void {
  if (usesNativeContextMenu(event) || !text.trim()) return
  const items: ContextAction[] = [
    { id: 'copy-message', label: '复制消息', run: () => navigator.clipboard.writeText(text) },
  ]
  if (onBranch) items.push({ id: 'branch', label: '从这里分叉对话', dividerBefore: true, run: onBranch })
  openContextMenuFromEvent(event, items)
}
