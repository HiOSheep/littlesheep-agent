// Application-shell state helpers shared by the renderer composition root.
import { DirectModulePage, SettingsPage } from '../settings/types'
import {
  rebindWorkspacePanelState,
  rebindWorkspacePath
} from '../workspace-persistence'
import { AppNavigationSnapshot, AppRoute } from './types'


export function routesEqual(left: AppRoute | undefined, right: AppRoute): boolean {
  if (!left || left.section !== right.section) return false
  if (left.section === 'chat' && right.section === 'chat') return true
  if (left.section === 'settings' && right.section === 'settings') return left.page === right.page
  if (left.section === 'module' && right.section === 'module') return left.page === right.page
  return false
}


export function isDirectModulePage(page: SettingsPage): page is DirectModulePage {
  return page === 'memoryTree' || page === 'scheduled' || page === 'plugins'
}


export function rebindNavigationSnapshotWorkspace(
  snapshot: AppNavigationSnapshot,
  fromPath: string,
  toPath: string,
): AppNavigationSnapshot {
  const rebound = rebindWorkspacePanelState({
    openRequest: snapshot.workspaceOpenRequest
      ? { id: 0, ...snapshot.workspaceOpenRequest }
      : null,
    openTabs: snapshot.workspacePanelOpenTabs,
    activeTab: snapshot.workspacePanelTab,
    drafts: {},
  }, fromPath, toPath)
  return {
    ...snapshot,
    workspacePanelTab: rebound.activeTab,
    workspacePanelOpenTabs: rebound.openTabs,
    workspaceOpenRequest: rebound.openRequest
      ? { root: rebound.openRequest.root, path: rebound.openRequest.path }
      : null,
    workspaceExpandedPaths: [...new Set(snapshot.workspaceExpandedPaths.map((path) => (
      rebindWorkspacePath(path, fromPath, toPath)
    )))],
  }
}


export function navigationSnapshotsEqual(
  left: AppNavigationSnapshot | undefined,
  right: AppNavigationSnapshot,
): boolean {
  if (!left) return false
  return routesEqual(left.route, right.route)
    && left.sidebarCollapsed === right.sidebarCollapsed
    && left.sidebarWidth === right.sidebarWidth
    && left.conversationCollapsed === right.conversationCollapsed
    && left.sidebarPanel === right.sidebarPanel
    && left.workspacePanelCollapsed === right.workspacePanelCollapsed
    && left.workspacePanelFullscreen === right.workspacePanelFullscreen
    && left.workspacePanelWidth === right.workspacePanelWidth
    && left.workspacePanelTab === right.workspacePanelTab
    && stringListsEqual(left.workspacePanelOpenTabs, right.workspacePanelOpenTabs)
    && left.workspaceBrowserUrl === right.workspaceBrowserUrl
    && left.workspaceOpenRequest?.root === right.workspaceOpenRequest?.root
    && left.workspaceOpenRequest?.path === right.workspaceOpenRequest?.path
    && left.workspaceFileNavigatorCollapsed === right.workspaceFileNavigatorCollapsed
    && stringListsEqual(left.workspaceExpandedPaths, right.workspaceExpandedPaths)
}


export function stringListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}


export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
