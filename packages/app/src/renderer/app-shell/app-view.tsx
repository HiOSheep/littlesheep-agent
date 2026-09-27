// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { LinkNavigationProvider } from '../link-navigation'
import { GlobalTitlebar, SettingsEntryButton, WindowDragRegion } from '../sidebar/global-titlebar'
import { CoreWorkspaceView } from './core-workspace-view'
import { OverlaysView } from './overlays-view'
import { SidebarView } from './sidebar-view'
import type { AppViewController } from './app-controller-projections'


export function AppView({ controller }: { controller: AppViewController }) {
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
          {/* chali: the sidebar owns the window's top-left corner, so the top bar covers
              only the chat+workspace column and the sidebar column gets its own drag
              surface over the same 32px band. Together they cover the whole top edge at
              every sidebar width, including the collapsed one. */}
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
