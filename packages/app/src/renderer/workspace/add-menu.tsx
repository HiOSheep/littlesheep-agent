// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { clampNumber } from '../app-shell/navigation'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { WorkspaceFeatureIcon } from '../ui/icons'
import { useDismissOnOutside } from '../ui/presence'
import { WORKSPACE_MENU_EVENT, transientTriggerProps } from '../ui/transient'
import {
  type WorkspacePanelTab
} from '../workspace-persistence'
import { resolveWorkspaceEntrySelection } from './entry-selection'


export function WorkspaceAddMenu({
  entries,
  activeTab,
  openTabs,
  onSelect,
  onOpenBrowserTab,
  onTipChange,
}: {
  entries: Array<{ id: WorkspacePanelTab; label: string; desc: string }>
  activeTab: WorkspacePanelTab | null
  openTabs: WorkspacePanelTab[]
  onSelect: (tab: WorkspacePanelTab) => void
  onOpenBrowserTab: (url: string) => void
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
  const menuIdRef = useRef(`workspace-menu-${Math.random().toString(36).slice(2)}`)

  function syncPosition() {
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 10
    const panelWidth = panelRef.current?.offsetWidth || 352
    const panelHeight = panelRef.current?.offsetHeight || entries.length * 36 + 16
    const x = clampNumber(rect.left, margin, window.innerWidth - panelWidth - margin)
    const below = rect.bottom + 5
    const y = below + panelHeight > window.innerHeight - margin
      ? Math.max(margin, rect.top - panelHeight - 5)
      : below
    setPosition({ x, y })
  }

  function openMenu() {
    window.clearTimeout(closeTimerRef.current)
    window.dispatchEvent(new CustomEvent(WORKSPACE_MENU_EVENT, { detail: menuIdRef.current }))
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

  function selectEntry(tab: WorkspacePanelTab) {
    onTipChange(null)
    const selection = resolveWorkspaceEntrySelection(tab)
    if (selection.kind === 'new-browser-tab') onOpenBrowserTab(selection.url)
    else onSelect(selection.tab)
    closeMenu()
  }

  useDismissOnOutside(mounted, [rootRef, panelRef], closeMenu)

  useEffect(() => {
    const handleWorkspaceMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== menuIdRef.current) closeMenu()
    }
    window.addEventListener(WORKSPACE_MENU_EVENT, handleWorkspaceMenuOpen)
    return () => window.removeEventListener(WORKSPACE_MENU_EVENT, handleWorkspaceMenuOpen)
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
  }, [mounted, entries.length])

  useEffect(() => () => {
    window.clearTimeout(closeTimerRef.current)
    window.cancelAnimationFrame(frameRef.current ?? 0)
  }, [])

  return (
    <div ref={rootRef} className={`workspace-add-menu ${open ? 'open' : ''}`}>
      <button
        {...transientTriggerProps()}
        ref={triggerRef}
        className="workspace-add-trigger"
        type="button"
        aria-label="打开拓展功能菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          onTipChange(null)
          if (open) closeMenu()
          else openMenu()
        }}
        onMouseEnter={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip('打开拓展功能菜单', event.clientX, event.clientY))
        }}
        onMouseMove={(event) => {
          if (!open) onTipChange(buildFloatingHelpTip('打开拓展功能菜单', event.clientX, event.clientY))
        }}
        onMouseLeave={() => onTipChange(null)}
        onFocus={(event) => {
          if (!open) onTipChange(buildFloatingHelpTipFromElement('打开拓展功能菜单', event.currentTarget))
        }}
        onBlur={() => onTipChange(null)}
      >
        <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M8 3.25v9.5M3.25 8h9.5" />
        </svg>
      </button>
      {mounted && createPortal(
        <div
          ref={panelRef}
          className={`workspace-add-panel ${open ? 'visible' : ''}`}
          role="menu"
          aria-label="拓展功能菜单"
          aria-hidden={!open}
          {...(!open ? { inert: '' } : {})}
          style={{ left: position.x, top: position.y }}
        >
          {entries.map((entry) => {
            const active = entry.id === activeTab
            const opened = openTabs.includes(entry.id)
            return (
              <button
                key={entry.id}
                className={`workspace-add-item ${active ? 'active' : ''} ${opened ? 'opened' : ''}`}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => selectEntry(entry.id)}
                onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
                onMouseMove={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
                onMouseLeave={() => onTipChange(null)}
                onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(entry.desc, event.currentTarget))}
                onBlur={() => onTipChange(null)}
              >
                <span className="workspace-add-icon"><WorkspaceFeatureIcon id={entry.id} /></span>
                <span className="workspace-add-label">{entry.label}</span>
                <span className="workspace-add-meta">
                  {opened && <span className="workspace-add-open-dot" aria-label="已打开" />}
                </span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}
