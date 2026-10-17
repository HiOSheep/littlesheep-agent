import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuParams, WebContents, BrowserWindow } from 'electron'
import { CONTEXT_MENU_ACTION_CHANNEL, CONTEXT_MENU_DISMISS_CHANNEL } from '../shared/context-menu-contracts.js'
const { ipc, clipboard, nativeMenu } = vi.hoisted(() => ({
  ipc: { on: vi.fn(), removeListener: vi.fn() }, clipboard: { writeText: vi.fn() },
  nativeMenu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
}))
vi.mock('electron', () => ({ ipcMain: ipc, clipboard, Menu: nativeMenu }))
import { contextMenuItems, installContextMenu } from './context-menu.js'

const params = (extra: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
  x: 12, y: 34, isEditable: true, selectionText: 'selected', linkURL: '', mediaType: 'none', hasImageContents: false,
  editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canDelete: true, canEditRichly: false },
  ...extra,
} as ContextMenuParams)
function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => false, send: vi.fn(),
    undo: vi.fn(), redo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), copyImageAt: vi.fn(),
  })
  installContextMenu(contents as unknown as WebContents, {} as BrowserWindow)
  const handler = ipc.on.mock.calls.find(([channel]) => channel === CONTEXT_MENU_ACTION_CHANNEL)![1]
  const dismissHandler = ipc.on.mock.calls.find(([channel]) => channel === CONTEXT_MENU_DISMISS_CHANNEL)![1]
  const action = (requestId: string, id: string, event = { sender: contents, senderFrame: contents.mainFrame }) => handler(event, requestId, id)
  const open = (value = params()) => { contents.emit('context-menu', {}, value); return contents.send.mock.lastCall?.[1].requestId as string }
  const dismiss = (requestId: string, event = { sender: contents, senderFrame: contents.mainFrame }) => dismissHandler(event, requestId)
  return { contents, open, action, dismiss }
}
describe('desktop context menus', () => {
  beforeEach(() => vi.clearAllMocks())
  it('offers only meaningful capabilities and never paste on a read-only selection', () => {
    expect(contextMenuItems(params({ isEditable: false })).map((item) => item.id)).toEqual(['copy'])
    expect(contextMenuItems(params({ isEditable: false, selectionText: '' }))).toEqual([])
    expect(contextMenuItems(params({ isEditable: false, selectionText: '', linkURL: 'javascript:alert(1)' }))).toEqual([])
    expect(contextMenuItems(params()).find((item) => item.id === 'redo')?.enabled).toBe(false)
  })
  it('rejects wrong windows, subframes, disabled actions and arbitrary commands', () => {
    const { contents, open, action } = fixture()
    const id = open()
    action(id, 'paste', { sender: {} as typeof contents, senderFrame: contents.mainFrame })
    action(id, 'paste', { sender: contents, senderFrame: {} })
    action(id, 'redo'); action(id, 'executeJavaScript')
    expect(contents.paste).not.toHaveBeenCalled(); expect(contents.redo).not.toHaveBeenCalled()
    action(id, 'paste'); action(id, 'paste')
    expect(contents.paste).toHaveBeenCalledTimes(1)
  })
  it('uses the native captured link and invalidates earlier menu invocations', () => {
    const { open, action } = fixture()
    const stale = open(params({ linkURL: 'https://example.com/old' }))
    const latest = open(params({ linkURL: 'https://example.com/current' }))
    action(stale, 'copyLink'); expect(clipboard.writeText).not.toHaveBeenCalled()
    action(latest, 'copyLink'); expect(clipboard.writeText).toHaveBeenCalledWith('https://example.com/current')
  })
  it('copies the captured read-only selection even if the menu changed focus', () => {
    const { contents, open, action } = fixture()
    const id = open(params({ isEditable: false, selectionText: 'selected message text' }))
    action(id, 'copy')
    expect(clipboard.writeText).toHaveBeenCalledWith('selected message text')
    expect(contents.copy).not.toHaveBeenCalled()
  })
  it('preserves whitespace-only selections instead of replacing them with an object menu', () => {
    const { open, action } = fixture()
    const id = open(params({ isEditable: false, selectionText: '  \n\t' }))
    action(id, 'copy')
    expect(clipboard.writeText).toHaveBeenCalledWith('  \n\t')
  })
  it('invalidates capabilities on navigation and cleans up its IPC listener', () => {
    const { contents, open, action } = fixture()
    const id = open(); contents.emit('did-navigate'); action(id, 'cut')
    expect(contents.cut).not.toHaveBeenCalled()
    contents.emit('destroyed'); expect(ipc.removeListener).toHaveBeenCalledWith(CONTEXT_MENU_ACTION_CHANNEL, expect.any(Function))
  })
  it('rejects expired invocations', () => {
    const { contents, open, action } = fixture()
    const time = vi.spyOn(Date, 'now').mockReturnValue(100)
    const id = open(); time.mockReturnValue(61_000); action(id, 'cut'); time.mockRestore()
    expect(contents.cut).not.toHaveBeenCalled()
  })
  it('revokes a dismissed menu without letting stale or foreign dismissals cancel a newer menu', () => {
    const { contents, open, action, dismiss } = fixture()
    const previous = open()
    const current = open()
    dismiss(previous)
    dismiss(current, { sender: {} as typeof contents, senderFrame: contents.mainFrame })
    dismiss(current, { sender: contents, senderFrame: {} })
    action(current, 'paste')
    expect(contents.paste).toHaveBeenCalledTimes(1)
    const cancelled = open()
    dismiss(cancelled)
    action(cancelled, 'cut')
    expect(contents.cut).not.toHaveBeenCalled()
    contents.emit('destroyed')
    expect(ipc.removeListener).toHaveBeenCalledWith(CONTEXT_MENU_DISMISS_CHANNEL, expect.any(Function))
  })
})
