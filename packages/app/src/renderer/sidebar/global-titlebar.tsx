// Window chrome: the 32px top bar of the chat/workspace region, its navigation
// controls, the settings entry, and the transparent drag surfaces that keep the
// window grabbable along its whole top edge.
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { SettingsGearIcon, SidebarToggleIcon } from '../ui/icons'
import { HistoryBackIcon, HistoryForwardIcon } from '../ui/browser-icons'

function canBeginWindowDrag(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest('[data-window-drag-ignore], button, a, input, textarea, select, [contenteditable="true"]'))
}

function startWindowDrag(event: React.PointerEvent<HTMLElement>): void {
  if (event.button !== 0 || !canBeginWindowDrag(event.target)) return
  const bridge = window.littlesheep
  if (!bridge?.startWindowDrag) return
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  bridge.startWindowDrag({ screenX: event.screenX, screenY: event.screenY })
}

function moveWindowDrag(event: React.PointerEvent<HTMLElement>): void {
  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
  window.littlesheep?.moveWindowDrag?.({ screenX: event.screenX, screenY: event.screenY })
}

function endWindowDrag(event: React.PointerEvent<HTMLElement>): void {
  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
  event.currentTarget.releasePointerCapture(event.pointerId)
  window.littlesheep?.endWindowDrag?.()
}

/**
 * Transparent window drag surface for a band the titlebar does not cover.
 *
 * `chali` puts the sidebar in the window's top-left corner and stops the 32px top
 * bar at the sidebar's right edge, so the titlebar alone no longer spans the
 * window's top edge. This is the second half of that strip: one drag surface per
 * column that owns part of the band, each carrying the same two mechanisms the
 * titlebar already used (the CSS `-webkit-app-region: drag` and the pointer bridge
 * to Main). It renders no content and is not focusable.
 */
export function WindowDragRegion({ className }: { className?: string }) {
  return (
    <div
      className={className}
      data-window-drag-region=""
      aria-hidden="true"
      onPointerDown={startWindowDrag}
      onPointerMove={moveWindowDrag}
      onPointerUp={endWindowDrag}
      onPointerCancel={endWindowDrag}
    />
  )
}

export function GlobalTitlebar({
  sidebarCollapsed,
  sidebarToggleTip,
  canNavigateBack,
  canNavigateForward,
  onToggleSidebar,
  onBack,
  onForward,
  onTipChange,
}: {
  sidebarCollapsed: boolean
  sidebarToggleTip: string
  canNavigateBack: boolean
  canNavigateForward: boolean
  onToggleSidebar: () => void
  onBack: () => void
  onForward: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <header
      className="window-titlebar"
      aria-label="LittleSheep titlebar"
      onPointerDown={startWindowDrag}
      onPointerMove={moveWindowDrag}
      onPointerUp={endWindowDrag}
      onPointerCancel={endWindowDrag}
    >
      <div className="app-nav-controls" data-window-drag-ignore aria-label="全局导航">
        <button
          className="sidebar-toggle-btn"
          type="button"
          aria-label={sidebarToggleTip}
          aria-expanded={!sidebarCollapsed}
          onClick={onToggleSidebar}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(sidebarToggleTip, event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(sidebarToggleTip, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(sidebarToggleTip, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <SidebarToggleIcon />
        </button>
        <button
          className="app-nav-btn history-nav-btn nav-back"
          type="button"
          disabled={!canNavigateBack}
          onClick={onBack}
          aria-label="返回"
        >
          <HistoryBackIcon />
        </button>
        <button
          className="app-nav-btn history-nav-btn nav-forward"
          type="button"
          disabled={!canNavigateForward}
          onClick={onForward}
          aria-label="前进"
        >
          <HistoryForwardIcon />
        </button>
      </div>
    </header>
  )
}


export function SettingsEntryButton({
  settingsOpen,
  onOpen,
  onClose,
  rippling,
}: {
  settingsOpen: boolean
  onOpen: () => void
  onClose: () => void
  rippling: boolean
}) {
  return (
    <button
      className={`settings-entry-btn settings-entry-global ${rippling ? 'rippling' : ''}`}
      type="button"
      aria-label={settingsOpen ? '关闭设置' : '设置'}
      aria-expanded={settingsOpen}
      onClick={settingsOpen ? onClose : onOpen}
    >
      <SettingsGearIcon />
    </button>
  )
}
