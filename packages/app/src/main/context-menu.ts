import { randomUUID } from 'node:crypto'
import { clipboard, ipcMain, Menu } from 'electron'
import { BROWSER_OPEN_NEW_TAB_CHANNEL } from '../shared/browser-control-contracts.js'
import {
  CONTEXT_MENU_ACTION_CHANNEL, CONTEXT_MENU_OPEN_CHANNEL,
  type ContextMenuAction, type ContextMenuItem,
} from '../shared/context-menu-contracts.js'

export function contextMenuItems(params: Electron.ContextMenuParams): ContextMenuItem[] {
  const flags = params.editFlags
  const items: ContextMenuItem[] = []
  if (params.isEditable) {
    items.push(
      { id: 'undo', label: '撤销', enabled: flags.canUndo, shortcut: 'Ctrl+Z' },
      { id: 'redo', label: '重做', enabled: flags.canRedo, shortcut: 'Ctrl+Y' },
      { id: 'cut', label: '剪切', enabled: flags.canCut, shortcut: 'Ctrl+X', dividerBefore: true },
      { id: 'copy', label: '复制', enabled: flags.canCopy, shortcut: 'Ctrl+C' },
      { id: 'paste', label: '粘贴', enabled: flags.canPaste, shortcut: 'Ctrl+V' },
      { id: 'selectAll', label: '全选', enabled: flags.canSelectAll, shortcut: 'Ctrl+A', dividerBefore: true },
    )
  } else if (params.selectionText.trim()) {
    items.push({ id: 'copy', label: '复制选中文字', enabled: flags.canCopy, shortcut: 'Ctrl+C' })
  }
  if (/^https?:\/\//iu.test(params.linkURL)) {
    items.push(
      { id: 'openLink', label: '在应用内浏览器打开', enabled: true, dividerBefore: items.length > 0 },
      { id: 'copyLink', label: '复制链接地址', enabled: true },
    )
  }
  if (params.mediaType === 'image' && params.hasImageContents) {
    items.push({ id: 'copyImage', label: '复制图片', enabled: true, dividerBefore: items.length > 0 })
  }
  return items
}

/** The app uses a styled Renderer menu; isolated browser guests use a native menu. */
export function installContextMenu(contents: Electron.WebContents, win: Electron.BrowserWindow, native = false): void {
  let pending: { requestId: string; params: Electron.ContextMenuParams; items: ContextMenuItem[]; expires: number } | undefined
  const execute = (action: ContextMenuAction, params: Electron.ContextMenuParams) => {
    if (contents.isDestroyed()) return
    if (action === 'copyLink') clipboard.writeText(params.linkURL)
    else if (action === 'copy' && !params.isEditable) clipboard.writeText(params.selectionText)
    else if (action === 'openLink') {
      const host = native ? contents.hostWebContents : contents
      if (host && !host.isDestroyed()) host.send(BROWSER_OPEN_NEW_TAB_CHANNEL, { url: params.linkURL })
    } else if (action === 'copyImage') contents.copyImageAt(params.x, params.y)
    else contents[action]()
  }
  contents.on('context-menu', (_event, params) => {
    const items = contextMenuItems(params)
    pending = undefined
    if (items.length === 0) return
    if (native) {
      Menu.buildFromTemplate(items.flatMap((item) => [
        ...(item.dividerBefore ? [{ type: 'separator' as const }] : []),
        { label: item.label, enabled: item.enabled, click: () => execute(item.id, params) },
      ])).popup({ window: win })
      return
    }
    pending = { requestId: randomUUID(), params, items, expires: Date.now() + 60_000 }
    contents.send(CONTEXT_MENU_OPEN_CHANNEL, { requestId: pending.requestId, x: params.x, y: params.y, items })
  })
  if (native) return
  const actionHandler = (event: Electron.IpcMainEvent, requestId: unknown, action: unknown) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame) return
    const current = pending
    if (!current || requestId !== current.requestId || current.expires < Date.now()) return
    const item = current.items.find((candidate) => candidate.id === action && candidate.enabled)
    if (!item) return
    pending = undefined
    execute(item.id, current.params)
  }
  ipcMain.on(CONTEXT_MENU_ACTION_CHANNEL, actionHandler)
  contents.once('destroyed', () => ipcMain.removeListener(CONTEXT_MENU_ACTION_CHANNEL, actionHandler))
  contents.on('did-navigate', () => { pending = undefined })
}
