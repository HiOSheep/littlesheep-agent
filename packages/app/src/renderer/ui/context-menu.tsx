import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeScope } from './modal-surface'
import { SIDEBAR_MENU_EVENT } from './transient'

const LOCAL_CONTEXT_MENU_EVENT = 'littlesheep:local-context-menu'
export interface ContextAction {
  id: string
  label: string
  enabled?: boolean
  shortcut?: string
  dividerBefore?: boolean
  tone?: 'danger'
  run: () => void | Promise<void>
}
interface MenuState { x: number; y: number; items: ContextAction[]; origin: HTMLElement | null; requestId?: string }
export function openContextMenu(x: number, y: number, items: ContextAction[], origin: HTMLElement | null = null): void {
  window.dispatchEvent(new CustomEvent(LOCAL_CONTEXT_MENU_EVENT, { detail: { x, y, items, origin } }))
}

/** Leave text, links, media and embedded editors to their own context menus. */
export function usesNativeContextMenu(event: ReactMouseEvent<HTMLElement>): boolean {
  if (event.defaultPrevented) return true
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor, .xterm, a[href], img, video, audio')) return true
  const selection = window.getSelection()
  return Boolean(selection?.toString().length && selection.anchorNode && event.currentTarget.contains(selection.anchorNode))
}

export function openContextMenuFromEvent(event: ReactMouseEvent<HTMLElement>, items: ContextAction[]): void {
  if (event.defaultPrevented || items.length === 0) return
  event.preventDefault()
  event.stopPropagation()
  const origin = event.currentTarget
  const bounds = origin.getBoundingClientRect()
  origin.focus({ preventScroll: true })
  const focusOrigin = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : origin
  openContextMenu(event.clientX || bounds.left + 8, event.clientY || bounds.bottom, items, focusOrigin)
}

export function ContextMenuSurface() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const menuRef = useRef<MenuState | null>(null)
  const close = (restoreFocus = false, invalidate = true) => {
    const current = menuRef.current
    if (invalidate && current?.requestId) window.littlesheep?.dismissContextMenu?.(current.requestId)
    if (restoreFocus && current?.origin?.isConnected) current.origin.focus({ preventScroll: true })
    menuRef.current = null
    setMenu(null)
  }
  useEscapeScope(() => close(true), Boolean(menu))
  useEffect(() => {
    // Opening an editor's own menu is not leaving that editor. In particular,
    // inline rename must not commit/unmount before cut, paste or undo can run.
    const editorFocusOut = (event: FocusEvent) => {
      const current = menuRef.current
      if (!current?.requestId || event.target !== current.origin) return
      if (!current.origin?.matches('input, textarea, [contenteditable]:not([contenteditable="false"])')) return
      if (event.relatedTarget instanceof Node && ref.current?.contains(event.relatedTarget)) event.stopPropagation()
    }
    window.addEventListener('focusout', editorFocusOut, true)
    const keyboardMenu = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
      const target = document.activeElement
      if (!(target instanceof HTMLElement)) return
      const owner = target.closest<HTMLElement>('[data-context-menu]')
      if (!owner || target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') && !target.closest('.xterm')) return
      const bounds = owner.getBoundingClientRect()
      const allowed = target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: bounds.left + 8, clientY: bounds.bottom }))
      if (!allowed) { event.preventDefault(); event.stopPropagation() }
    }
    window.addEventListener('keydown', keyboardMenu, true)
    const show = (next: MenuState) => {
      const previous = menuRef.current
      if (previous?.requestId) window.littlesheep?.dismissContextMenu?.(previous.requestId)
      window.dispatchEvent(new CustomEvent(SIDEBAR_MENU_EVENT, { detail: LOCAL_CONTEXT_MENU_EVENT }))
      setError('')
      menuRef.current = next
      setMenu(next.items.length ? next : null)
    }
    const local = (event: Event) => {
      const detail = (event as CustomEvent<MenuState>).detail
      show({ ...detail, origin: detail.origin ?? document.activeElement as HTMLElement | null })
    }
    window.addEventListener(LOCAL_CONTEXT_MENU_EVENT, local)
    const unsubscribe = window.littlesheep?.onContextMenu?.((native) => {
      const origin = document.activeElement as HTMLElement | null
      show({ x: native.x, y: native.y, origin, requestId: native.requestId, items: native.items.map((item) => ({
        ...item, run: () => window.littlesheep?.contextMenuAction?.(native.requestId, item.id),
      })) })
    })
    return () => {
      unsubscribe?.()
      window.removeEventListener('focusout', editorFocusOut, true)
      window.removeEventListener('keydown', keyboardMenu, true)
      window.removeEventListener(LOCAL_CONTEXT_MENU_EVENT, local)
      if (menuRef.current?.requestId) window.littlesheep?.dismissContextMenu?.(menuRef.current.requestId)
    }
  }, [])
  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const panel = ref.current
    const bounds = panel.getBoundingClientRect()
    panel.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`
    const first = panel.querySelector<HTMLButtonElement>('button:not(:disabled)')
    ;(first ?? panel).focus({ preventScroll: true })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const restoreEditor = () => Boolean(menuRef.current?.requestId && ref.current?.contains(document.activeElement))
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close(restoreEditor()) }
    const dismiss = () => close(restoreEditor())
    const scroll = (event: Event) => {
      const current = menuRef.current
      // The caret in a long single-line input scrolls horizontally as it blurs.
      // That internal scroll must not immediately dismiss its new edit menu.
      if (current?.requestId && event.target === current.origin && current.origin?.matches('input, textarea')) return
      // Hidden layout containers may scroll as Chromium focuses a child during
      // panel motion. Only an actual scrolling surface should dismiss the menu.
      if (event.target instanceof Element && !/(auto|scroll|overlay)/u.test(getComputedStyle(event.target).overflow)) return
      if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) close(restoreEditor())
    }
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('scroll', scroll, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [menu])
  const run = (item: ContextAction) => {
    if (item.enabled === false) return
    if (menuRef.current?.origin && !menuRef.current.origin.isConnected) { close(); return }
    close(true, false)
    Promise.resolve().then(item.run).catch((reason: unknown) => {
      setError(`操作未完成：${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }
  return createPortal(<>
    {menu && <div ref={ref} className="app-context-menu" role="menu" aria-label="右键菜单" tabIndex={-1}
      style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.ctrlKey && !event.altKey && !event.metaKey) {
          const shortcut = `Ctrl+${event.shiftKey ? 'Shift+' : ''}${event.key.toUpperCase()}`
          const item = menu.items.find((candidate) => candidate.shortcut === shortcut && candidate.enabled !== false)
          if (item) { event.preventDefault(); event.stopPropagation(); run(item); return }
        }
        if (event.key === 'Tab') {
          close(true); return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        buttons[next]?.focus({ preventScroll: true })
        buttons[next]?.scrollIntoView({ block: 'nearest' })
      }}>
      {menu.items.map((item) => <div key={item.id} role="none">
        {item.dividerBefore && <div className="app-context-menu-divider" role="separator" />}
        <button type="button" role="menuitem" disabled={item.enabled === false}
          className={item.tone === 'danger' ? 'danger' : undefined}
          onMouseEnter={(event) => { if (!event.currentTarget.disabled) event.currentTarget.focus({ preventScroll: true }) }}
          onMouseDown={(event) => event.preventDefault()} onClick={() => run(item)}>
          <span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      </div>)}
    </div>}
    {error && <div className="app-context-menu-error" role="alert">{error}<button type="button" aria-label="关闭操作提示" onClick={() => setError('')}>×</button></div>}
  </>, document.body)
}
