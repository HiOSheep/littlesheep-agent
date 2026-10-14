// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { LinkNavigationProvider } from '../link-navigation'
import { GlobalTitlebar, SettingsEntryButton, WindowDragRegion, WindowNavControls } from '../sidebar/global-titlebar'
import { CoreWorkspaceView } from './core-workspace-view'
import { OverlaysView } from './overlays-view'
import { SidebarView } from './sidebar-view'
import type { AppViewController } from './app-controller-projections'
import { useWindowChrome } from './use-window-chrome'


export function AppView({ controller }: { controller: AppViewController }) {
  useWindowChrome()
  const {
    shellRef,
    sidebarCollapsed,
    workspacePanelCollapsed,
    workspacePanelFullscreen,
    directModulePage,
    settingsOpen,
    settingsReturning,
    layoutStyle,
    sidebarToggleTip,
    canNavigateBack,
    canNavigateForward,
    settingsEntryRippling,
    openSettingsFromEntry,
    closeSettingsFromEntry,
    toggleSidebar,
    navigateBack,
    navigateForward,
    setControlTip,
    openHyperlinkInside,
    openHyperlinkWithSystem,
    sidebar,
    coreWorkspace,
    overlays,
  } = controller
  return (
    <LinkNavigationProvider value={{
      openInside: openHyperlinkInside,
      openWithSystem: openHyperlinkWithSystem,
    }}>
      <div
        ref={shellRef}
        className={[
          'window-shell',
          sidebarCollapsed ? 'sidebar-collapsed' : '',
          workspacePanelCollapsed ? 'workspace-panel-collapsed' : '',
          workspacePanelFullscreen ? 'workspace-panel-fullscreen' : '',
          directModulePage ? 'direct-module-open' : '',
          settingsOpen ? 'settings-open' : '',
          settingsReturning ? 'settings-returning' : '',
        ].filter(Boolean).join(' ')}
        style={layoutStyle}
      >
        {/* The window's navigation controls are a shell-level layer, rendered before
            `.primary-workspace` so that a bare `.sidebar-toggle-btn` query still names
            the window's own toggle rather than the workspace panel's corner toggle.
            `.primary-workspace` is its own stacking context (z-index 1) and the settings
            surface paints above it, so a control inside the panels could not stay
            reachable in the window's top-left corner. */}
        <WindowNavControls
          sidebarCollapsed={sidebarCollapsed}
          sidebarToggleTip={sidebarToggleTip}
          canNavigateBack={canNavigateBack}
          canNavigateForward={canNavigateForward}
          onToggleSidebar={toggleSidebar}
          onBack={navigateBack}
          onForward={navigateForward}
          onTipChange={setControlTip}
        />
        <div className="primary-workspace">
          {/* Chali puts the sidebar against the top edge. Native maximize/fullscreen
              projects Beta through preload: CSS spans the titlebar over all columns
              and moves the sidebar below it, without remounting any panel. */}
          <div className="app">
            <GlobalTitlebar />
            <WindowDragRegion className="window-drag-band" />
            {/* The settings surface covers the sidebar and the workspace, not the top bar.
                The inert/aria-hidden boundary follows what is actually behind it, so the
                top bar's drag band stays usable while settings is open — the same contract
                the full-width title bar had. */}
            <div className="app-panels" aria-hidden={settingsOpen} {...(settingsOpen ? { inert: '' } : {})}>
              <SidebarView controller={sidebar} />
              <CoreWorkspaceView controller={coreWorkspace} />
            </div>
          </div>
        </div>
        <SettingsEntryButton
          settingsOpen={settingsOpen}
          onOpen={openSettingsFromEntry}
          onClose={closeSettingsFromEntry}
          rippling={settingsEntryRippling}
        />
        <OverlaysView controller={overlays} />
      </div>
    </LinkNavigationProvider>
  )
}
