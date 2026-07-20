// Primary navigation, project/session trees, and sidebar actions.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clampNumber } from '../app-shell/navigation'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement, FloatingHelpTip } from '../ui/floating-help'
import { useDismissOnOutside } from '../ui/presence'
import { SIDEBAR_MENU_EVENT, transientTriggerProps } from '../ui/transient'


export interface SidebarMenuItem {
  label: string
  icon: ReactNode
  tone?: 'danger'
  onSelect: () => void | Promise<void>
}


export function SidebarActionMenu({
  label,
  items,
  children,
  onTipChange,
}: {
  label: string
  items: SidebarMenuItem[]
  children: ReactNode
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [mounted, setMounted] = useState(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number>()
  const frameRef = useRef<number>()
  const menuIdRef = useRef(`sidebar-menu-${Math.random().toString(36).slice(2)}`)

  function syncPosition() {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const anchor = trigger.closest('.session-item, .sidebar-section-header') as HTMLElement | null
    const anchorRect = anchor?.getBoundingClientRect() ?? rect
    const panelWidth = panelRef.current?.offsetWidth || 154
    const panelHeight = panelRef.current?.offsetHeight || Math.max(44, items.length * 34 + 14)
    const x = clampNumber(anchorRect.right - panelWidth, margin, window.innerWidth - panelWidth - margin)
    const below = rect.bottom + 3
    const y = below + panelHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelHeight - 3)
      : below
    setPosition({ x, y })
  }

  function openMenu() {
    window.clearTimeout(closeTimerRef.current)
    window.dispatchEvent(new CustomEvent(SIDEBAR_MENU_EVENT, { detail: menuIdRef.current }))
    setMounted(true)
    frameRef.current = window.requestAnimationFrame(() => {
      syncPosition()
      setOpen(true)
    })
  }

  function closeMenu() {
    setOpen(false)
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = window.setTimeout(() => setMounted(false), 170)
  }

  useDismissOnOutside(mounted, [rootRef, panelRef], closeMenu)

  useEffect(() => {
    const handleSidebarMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== menuIdRef.current) closeMenu()
    }
    window.addEventListener(SIDEBAR_MENU_EVENT, handleSidebarMenuOpen)
    return () => window.removeEventListener(SIDEBAR_MENU_EVENT, handleSidebarMenuOpen)
  }, [])

  useEffect(() => {
    if (!mounted) return
    const handleReposition = () => syncPosition()
    window.addEventListener('resize', handleReposition)
    window.addEventListener('scroll', handleReposition, true)
    return () => {
      window.removeEventListener('resize', handleReposition)
      window.removeEventListener('scroll', handleReposition, true)
    }
  }, [mounted])

  useLayoutEffect(() => {
    if (mounted) syncPosition()
  }, [mounted, items.length])

  useEffect(() => () => {
    window.clearTimeout(closeTimerRef.current)
    window.cancelAnimationFrame(frameRef.current ?? 0)
  }, [])

  return (
    <div ref={rootRef} className={`sidebar-action-menu ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        ref={triggerRef}
        className="sidebar-section-action sidebar-action-menu-trigger"
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          onTipChange(null)
          if (open) closeMenu()
          else openMenu()
        }}
        onMouseEnter={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))
        }}
        onMouseMove={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY))
        }}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => {
          if (!open) onTipChange(buildFloatingHelpTipFromElement(label, event.currentTarget))
        }}
        onBlur={() => onTipChange(null)}
      >
        {children}
      </button>
      {mounted && createPortal(
        <div
          ref={panelRef}
          className={`sidebar-menu-panel ${open ? 'visible' : ''}`}
          role="menu"
          aria-label={label}
          aria-hidden={!open}
          {...(!open ? { inert: '' } : {})}
          style={{ left: position.x, top: position.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {items.map((item) => (
            <button
              key={item.label}
              className={`sidebar-menu-item ${item.tone === 'danger' ? 'danger' : ''}`}
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu()
                void Promise.resolve(item.onSelect()).catch((error) => console.error(error))
              }}
            >
              <span className="sidebar-menu-item-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}
