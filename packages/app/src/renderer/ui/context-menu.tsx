import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const LOCAL_CONTEXT_MENU_EVENT = 'littlesheep:local-context-menu'
export interface ContextAction {
  id: string
  label: string
  enabled?: boolean
  shortcut?: string
  dividerBefore?: boolean
  run: () => void | Promise<void>
}
interface MenuState { x: number; y: number; items: ContextAction[]; origin: HTMLElement | null }
export function openContextMenu(x: number, y: number, items: ContextAction[]): void {
  window.dispatchEvent(new CustomEvent(LOCAL_CONTEXT_MENU_EVENT, { detail: { x, y, items } }))
}

export function ContextMenuSurface() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [error, setError] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const close = () => setMenu(null)
  useEffect(() => {
    const local = (event: Event) => {
      const detail = (event as CustomEvent<Omit<MenuState, 'origin'>>).detail
      setError('')
      setMenu({ ...detail, origin: document.activeElement as HTMLElement | null })
    }
    window.addEventListener(LOCAL_CONTEXT_MENU_EVENT, local)
    const unsubscribe = window.littlesheep?.onContextMenu?.((native) => {
      const origin = document.activeElement as HTMLElement | null
      setError('')
      setMenu({ x: native.x, y: native.y, origin, items: native.items.map((item) => ({
        ...item, run: () => window.littlesheep?.contextMenuAction?.(native.requestId, item.id),
      })) })
    })
    return () => { unsubscribe?.(); window.removeEventListener(LOCAL_CONTEXT_MENU_EVENT, local) }
  }, [])
  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const panel = ref.current
    const bounds = panel.getBoundingClientRect()
    panel.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`
    panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close() }
    const dismiss = () => close()
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [menu])
  const run = (item: ContextAction) => {
    menu?.origin?.focus({ preventScroll: true })
    close()
    Promise.resolve().then(item.run).catch((reason: unknown) => {
      setError(`操作未完成：${reason instanceof Error ? reason.message : String(reason)}`)
    })
  }
  return createPortal(<>
    {menu && <div ref={ref} className="app-context-menu" role="menu" aria-label="右键菜单"
      style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault(); menu.origin?.focus({ preventScroll: true }); close(); return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }}>
      {menu.items.map((item) => <div key={item.id} role="none">
        {item.dividerBefore && <div className="app-context-menu-divider" role="separator" />}
        <button type="button" role="menuitem" disabled={item.enabled === false}
          onMouseDown={(event) => event.preventDefault()} onClick={() => run(item)}>
          <span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
        </button>
      </div>)}
    </div>}
    {error && <div className="app-context-menu-error" role="alert">{error}<button type="button" aria-label="关闭操作提示" onClick={() => setError('')}>×</button></div>}
  </>, document.body)
}
