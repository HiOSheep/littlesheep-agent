// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { LinkNavigationProvider } from '../link-navigation'
import { GlobalTitlebar, SettingsEntryButton, WindowDragRegion } from '../sidebar/global-titlebar'
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
        <div className="primary-workspace">
          {/* Chali puts the sidebar against the top edge. Native maximize/fullscreen
              projects Beta through preload: CSS spans the titlebar over all columns
              and moves the sidebar below it, without remounting any panel. */}
          <div className="app">
            <GlobalTitlebar
              sidebarCollapsed={sidebarCollapsed}
              sidebarToggleTip={sidebarToggleTip}
              canNavigateBack={canNavigateBack}
              canNavigateForward={canNavigateForward}
              onToggleSidebar={toggleSidebar}
              onBack={navigateBack}
              onForward={navigateForward}
              onTipChange={setControlTip}
            />
            <WindowDragRegion className="window-drag-band" />
            {/* The settings surface covers the sidebar and the workspace, not the top bar.
                The inert/aria-hidden boundary follows what is actually behind it, so the
                top bar's navigation controls and the drag band stay usable while settings
                is open — the same contract the full-width title bar had. */}
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
