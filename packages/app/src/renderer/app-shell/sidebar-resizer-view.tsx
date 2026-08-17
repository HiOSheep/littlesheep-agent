// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from './preferences'
import type { SidebarResizerViewController } from './app-controller-projections'




export function SidebarResizerView({ controller }: { controller: SidebarResizerViewController }) {
  const {
    sidebarCollapsed,
    sidebarWidth,
    beginSidebarResize,
    nudgeSidebar,
    setSidebarWidth,
  } = controller
  return (
      <div
        className="sidebar-resizer"
        role="separator"
        aria-hidden={sidebarCollapsed}
        {...(sidebarCollapsed ? { inert: '' } : {})}
        aria-label="调整会话栏宽度"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={sidebarCollapsed ? -1 : 0}
        onPointerDown={beginSidebarResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            nudgeSidebar(event.shiftKey ? -32 : -12)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            nudgeSidebar(event.shiftKey ? 32 : 12)
          } else if (event.key === 'Home') {
            event.preventDefault()
            setSidebarWidth(SIDEBAR_WIDTH_MIN)
          } else if (event.key === 'End') {
            event.preventDefault()
            setSidebarWidth(SIDEBAR_WIDTH_MAX)
          }
        }}
      />

  )
}
