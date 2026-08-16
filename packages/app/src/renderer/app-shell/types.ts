// Application-shell state helpers shared by the renderer composition root.
import { DirectModulePage, SettingsPage } from '../settings/types'
import {
  type WorkspacePanelTabId
} from '../workspace-persistence'


export type AppRoute =
  | { section: 'chat' }
  | { section: 'settings'; page: SettingsPage }
  | { section: 'module'; page: DirectModulePage }


export type SidebarPanel = 'search' | null

export type StringListUpdater = (current: string[]) => string[]


export interface AppNavigationSnapshot {
  route: AppRoute
  workspaceScopeKey: string
  sidebarCollapsed: boolean
  sidebarWidth: number
  conversationCollapsed: boolean
  sidebarPanel: SidebarPanel
  workspacePanelCollapsed: boolean
  workspacePanelFullscreen: boolean
  workspacePanelWidth: number
  workspacePanelTab: WorkspacePanelTabId
  workspacePanelOpenTabs: WorkspacePanelTabId[]
  workspaceOpenRequest: { root: string; path: string } | null
  workspaceFileNavigatorCollapsed: boolean
  workspaceExpandedPaths: string[]
}
