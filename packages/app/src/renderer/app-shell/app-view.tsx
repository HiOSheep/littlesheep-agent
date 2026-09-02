// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { LinkNavigationProvider } from '../link-navigation'
import { GlobalTitlebar } from '../sidebar/global-titlebar'
import { SettingsEntryButton } from '../sidebar/global-titlebar'
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
          <div className="app" aria-hidden={settingsOpen} {...(settingsOpen ? { inert: '' } : {})}>
            <SidebarView controller={sidebar} />
            <CoreWorkspaceView controller={coreWorkspace} />
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
