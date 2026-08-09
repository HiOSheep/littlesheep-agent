// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useRef, useState } from 'react'
import { StringListUpdater } from '../app-shell/types'
import { ChatMessage } from '../chat/types'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { PanelFullscreenIcon, WorkspaceFeatureIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
  parseWorkspaceFileTabId,
  workspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspaceOpenRequest,
  type WorkspacePanelTab,
  type WorkspacePanelTabId
} from '../workspace-persistence'
import { WorkspaceArtifacts } from './artifacts'
import { WorkspaceBrowser } from './browser'
import { WorkspaceFileNavigator } from './file-navigator'
import { WorkspaceFiles } from './files'
import { WorkspaceOverview } from './overview'
import { isSamePath, lastPathSegment } from './path-utils'
import { WorkspacePlaceholder } from './placeholder'
import { WorkspaceFileView } from './preview-pane'
import { WorkspaceReview } from './review'
import { WorkspaceTerminal } from './terminal'
import type { WorkspaceBrowserHistory } from './browser-history'
import { isWorkspaceBrowserTabId, type WorkspaceBrowserTab, type WorkspaceBrowserTabId } from './browser-tabs'
import { resolveWorkspaceEntrySelection } from './entry-selection'
import { WorkspaceTabStrip } from './tab-strip'
import type { PermissionModeId } from '../../shared/permission-modes'
export function WorkspacePanel({
  collapsed,
  fullscreen,
  activeTab, openTabs, browserTabs, browserUrl, browserHistory,
  messages,
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  workplacePath,
  openRequest,
  sessionId,
  permissionMode,
  sessionTitle,
  artifactVersion,
  fileDrafts,
  fileNavigatorCollapsed,
  expandedPaths,
  onTabChange,
  onCloseTab,
  onFileDraftChange,
  onToggleFullscreen,
  onRememberOpenPath,
  onReturnToDefaultWorkspace,
  onRequestFileSaveApproval,
  onRequestCommandApproval,
  onWorkspaceArtifactsChanged,
  onWorkspaceFileSaved,
  onFileNavigatorCollapsedChange,
  onExpandedPathsChange,
  onOpenFile, onNavigateLink, onBrowserNavigate, onBrowserHistoryMove, onBrowserOpenNewTab, onBrowserTitleChange,
  onTipChange,
}: {
  collapsed: boolean
  fullscreen: boolean
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  browserTabs: WorkspaceBrowserTab[]
  browserUrl: string
  browserHistory: WorkspaceBrowserHistory
  messages: ChatMessage[]
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  workplacePath: string
  openRequest: WorkspaceOpenRequest | null
  sessionId?: string
  permissionMode: PermissionModeId
  sessionTitle?: string
  artifactVersion: number
  fileDrafts: Record<string, WorkspaceFileDraftState>
  fileNavigatorCollapsed: boolean
  expandedPaths: string[]
  onTabChange: (tab: WorkspacePanelTabId) => void
  onCloseTab: (tab: WorkspacePanelTabId) => void
  onFileDraftChange: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onToggleFullscreen: () => void
  onRememberOpenPath: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onRequestCommandApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onWorkspaceFileSaved: (root: string, path: string, preview: import('../api').WorkspacePreview) => void
  onFileNavigatorCollapsedChange: (collapsed: boolean) => void
  onExpandedPathsChange: (update: StringListUpdater) => void
  onOpenFile: (path: string) => void
  onNavigateLink: (href: string) => void
  onBrowserNavigate: (url: string, mode?: 'push' | 'replace') => void
  onBrowserHistoryMove: (delta: number) => void
  onBrowserOpenNewTab: (url: string) => void
  onBrowserTitleChange: (tabId: WorkspaceBrowserTabId, title: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const workspaceEntries: Array<{
    id: WorkspacePanelTab
    label: string
    desc: string
  }> = [
    { id: 'review', label: '审阅', desc: '审阅当前 Git 更改与工作现场' },
    { id: 'artifacts', label: '产物', desc: '按项目、来源和类型管理生成或保存的文件' },
    { id: 'terminal', label: '终端', desc: 'LS 内置 PowerShell，命令执行受权限控制' },
    { id: 'browser', label: '浏览器', desc: '在拓展工作区预览对话中的网页链接' },
    { id: 'sideChat', label: '侧边聊天', desc: '后续承载与当前文件或产物相关的局部对话' },
  ]
  const activeFileTab = parseWorkspaceFileTabId(activeTab)
  const activeTabLabel = activeFileTab
    ? lastPathSegment(activeFileTab.path)
    : isWorkspaceBrowserTabId(activeTab)
      ? browserTabs.find((tab) => tab.id === activeTab)?.title || '浏览器'
      : workspaceEntries.find((entry) => entry.id === activeTab)?.label || '审阅'
  const fullscreenTip = fullscreen ? '退出全屏工作区' : '全屏展开工作区'
  const workspaceIsDefault = isSamePath(workspacePath, workplacePath)
  const [warmTab, setWarmTab] = useState<WorkspacePanelTabId | null>(null)
  const previousTabRef = useRef<WorkspacePanelTabId>(activeTab)

  useEffect(() => {
    const previousTab = previousTabRef.current
    previousTabRef.current = activeTab
    if (previousTab === activeTab) return
    setWarmTab(previousTab)
    const timer = window.setTimeout(() => setWarmTab((current) => current === previousTab ? null : current), 20_000)
    return () => window.clearTimeout(timer)
  }, [activeTab])

  // Minimize/restore changes document.visibilityState, but must not unmount a
  // webview: doing so destroys the guest page and makes restore navigate from
  // about:blank again. Electron's backgroundThrottling keeps hidden pages
  // quiet; only an intentional workspace collapse suspends the panel.
  const panelSuspended = collapsed
  const hasOpenTabs = openTabs.length > 0
  // Derive the previous tab during the transition render as well. This keeps
  // the old heavy view mounted while React commits the new active tab instead
  // of unmounting it and recreating it one effect later.
  const transitionWarmTab = previousTabRef.current !== activeTab
    ? previousTabRef.current
    : warmTab
  const warmFileTab = transitionWarmTab ? parseWorkspaceFileTabId(transitionWarmTab) : null
  const showSharedFileNavigator = !activeFileTab && activeTab !== 'files' && activeTab !== 'review'

  return (
    <aside
      className={`workspace-panel ${collapsed ? 'collapsed' : ''} ${fullscreen ? 'fullscreen' : ''}`}
      aria-label="拓展工作区"
    >
      <div
        className="workspace-panel-contents"
        aria-hidden={collapsed}
        {...(collapsed ? { inert: '' } : {})}
      >
        <header className="workspace-panel-header">
          <div className="workspace-panel-topbar">
            <WorkspaceTabStrip
              activeTab={activeTab}
              openTabs={openTabs}
              browserTabs={browserTabs}
              fileDrafts={fileDrafts}
              workspaceEntries={workspaceEntries}
              onTabChange={onTabChange}
              onCloseTab={onCloseTab}
              onOpenBrowserTab={onBrowserOpenNewTab}
              onTipChange={onTipChange}
            />
            <div className="workspace-context-line">
              {workspaceIsDefault ? '默认工作区' : '目标工作区'}
            </div>
          </div>
          <div className="workspace-panel-actions">
            <button
              {...transientTriggerProps()}
              className="workspace-panel-action workspace-panel-collapse-action"
              type="button"
              aria-label={fullscreenTip}
              aria-pressed={fullscreen}
              onClick={onToggleFullscreen}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(fullscreenTip, event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(fullscreenTip, event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(fullscreenTip, event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <PanelFullscreenIcon active={fullscreen} />
            </button>
          </div>
        </header>
        <div className="workspace-panel-body">
          {!panelSuspended && !hasOpenTabs && (
            <WorkspaceEmptyLauncher
              entries={workspaceEntries}
              onSelect={onTabChange}
              onOpenBrowserTab={onBrowserOpenNewTab}
              onTipChange={onTipChange}
            />
          )}
          {!panelSuspended && hasOpenTabs && (
            <div
              key={activeTab}
              className={`workspace-panel-view content-fade ${showSharedFileNavigator ? 'with-file-navigator' : ''}`}
            >
            {activeTab === 'review' && (
              <WorkspaceReview
                workspacePath={workspacePath}
                artifactVersion={artifactVersion}
                onOpenFile={onOpenFile}
                onTipChange={onTipChange}
                activityView={(
                  <WorkspaceOverview
                    workspacePath={workspacePath}
                    workplacePath={workplacePath}
                    activeTab={activeTab}
                    activeTabLabel={activeTabLabel}
                    openTabs={openTabs}
                    openRequest={openRequest}
                    sessionId={sessionId}
                    sessionTitle={sessionTitle}
                    messages={messages}
                    artifactVersion={artifactVersion}
                    fileDrafts={fileDrafts}
                    onOpenFile={onOpenFile}
                  />
                )}
              />
            )}
            {activeTab === 'files' && (
              <WorkspaceFiles
                workspacePath={workspacePath}
                defaultWorkspacePath={defaultWorkspacePath}
                usingTemporaryRoot={usingTemporaryRoot}
                navigatorCollapsed={fileNavigatorCollapsed}
                expandedPaths={expandedPaths}
                openRequest={openRequest}
                sessionId={sessionId}
                onRememberOpenPath={onRememberOpenPath}
                onReturnToDefaultWorkspace={onReturnToDefaultWorkspace}
                onRequestFileSaveApproval={onRequestFileSaveApproval}
                onWorkspaceArtifactsChanged={onWorkspaceArtifactsChanged}
                onWorkspaceFileSaved={onWorkspaceFileSaved}
                onNavigatorCollapsedChange={onFileNavigatorCollapsedChange}
                onExpandedPathsChange={onExpandedPathsChange}
                onOpenFileTab={(root, path) => {
                  onRememberOpenPath(root, path)
                  onTabChange(workspaceFileTabId(root, path))
                }}
                onTipChange={onTipChange}
              />
            )}
            {activeTab === 'artifacts' && (
              <WorkspaceArtifacts
                workspacePath={workspacePath}
                sessionId={sessionId}
                artifactVersion={artifactVersion}
                onOpenFile={onOpenFile}
                onTipChange={onTipChange}
              />
            )}
            {activeFileTab && (
              <div className="workspace-files">
                <WorkspaceFileView
                  tabId={activeTab as WorkspaceFileTabId}
                  root={activeFileTab.root}
                  path={activeFileTab.path}
                  sessionId={sessionId}
                  draft={fileDrafts[activeTab]}
                  onDraftChange={onFileDraftChange}
                  onRequestFileSaveApproval={onRequestFileSaveApproval}
                  onWorkspaceArtifactsChanged={onWorkspaceArtifactsChanged}
                  onWorkspaceFileSaved={onWorkspaceFileSaved}
                  onTipChange={onTipChange}
                />
                <WorkspaceFileNavigator
                  workspacePath={activeFileTab.root}
                  defaultWorkspacePath={defaultWorkspacePath}
                  usingTemporaryRoot={!isSamePath(activeFileTab.root, defaultWorkspacePath)}
                  navigatorCollapsed={fileNavigatorCollapsed}
                  expandedPaths={expandedPaths}
                  selectedPath={activeFileTab.path}
                  onOpenFileTab={(root, path) => {
                    onRememberOpenPath(root, path)
                    onTabChange(workspaceFileTabId(root, path))
                  }}
                  onReturnToDefaultWorkspace={() => {
                    onReturnToDefaultWorkspace()
                    onTabChange('review')
                  }}
                  onNavigatorCollapsedChange={onFileNavigatorCollapsedChange}
                  onExpandedPathsChange={onExpandedPathsChange}
                  onTipChange={onTipChange}
                />
              </div>
            )}
            {activeTab === 'terminal' && (
              <WorkspaceTerminal
                workspacePath={workspacePath}
                sessionId={sessionId}
                permissionMode={permissionMode}
                workspaceBoundary={workspaceIsDefault ? 'inside' : 'outside'}
                onRequestCommandApproval={onRequestCommandApproval}
                onTipChange={onTipChange}
              />
            )}
            {isWorkspaceBrowserTabId(activeTab) && (
              <WorkspaceBrowser
                tabId={activeTab}
                url={browserUrl}
                history={browserHistory}
                onNavigate={onBrowserNavigate}
                onHistoryMove={onBrowserHistoryMove}
                onOpenNewTab={onBrowserOpenNewTab}
                onTitleChange={(title) => onBrowserTitleChange(activeTab, title)}
                onTipChange={onTipChange}
              />
            )}
            {activeTab === 'sideChat' && (
              <WorkspacePlaceholder
                title="侧边聊天"
                text="后续会承载与当前文件、命令或产物绑定的局部对话，不挤占主对话区。"
              />
            )}
            </div>
          )}
          {!panelSuspended && hasOpenTabs && showSharedFileNavigator && (
            <WorkspaceFileNavigator
              workspacePath={workspacePath}
              defaultWorkspacePath={defaultWorkspacePath}
              usingTemporaryRoot={usingTemporaryRoot}
              navigatorCollapsed={fileNavigatorCollapsed}
              expandedPaths={expandedPaths}
              selectedPath={openRequest?.root === workspacePath ? openRequest.path : ''}
              onOpenFileTab={(root, path) => {
                onRememberOpenPath(root, path)
                onTabChange(workspaceFileTabId(root, path))
              }}
              onReturnToDefaultWorkspace={onReturnToDefaultWorkspace}
              onNavigatorCollapsedChange={onFileNavigatorCollapsedChange}
              onExpandedPathsChange={onExpandedPathsChange}
              onTipChange={onTipChange}
            />
          )}
          {!panelSuspended && hasOpenTabs && transitionWarmTab && transitionWarmTab !== activeTab && (warmFileTab || transitionWarmTab === 'terminal') && (
            <div className="workspace-panel-view warm-cache" aria-hidden="true" {...{ inert: '' }}>
              {warmFileTab && (
                <div className="workspace-files">
                  <WorkspaceFileView
                    tabId={transitionWarmTab as WorkspaceFileTabId}
                    root={warmFileTab.root}
                    path={warmFileTab.path}
                    sessionId={sessionId}
                    draft={fileDrafts[transitionWarmTab]}
                    onDraftChange={onFileDraftChange}
                    onRequestFileSaveApproval={onRequestFileSaveApproval}
                    onWorkspaceArtifactsChanged={onWorkspaceArtifactsChanged}
                    onWorkspaceFileSaved={onWorkspaceFileSaved}
                    onTipChange={onTipChange}
                  />
                </div>
              )}
              {transitionWarmTab === 'terminal' && (
                <WorkspaceTerminal
                  workspacePath={workspacePath}
                  sessionId={sessionId}
                  permissionMode={permissionMode}
                  workspaceBoundary={workspaceIsDefault ? 'inside' : 'outside'}
                  onRequestCommandApproval={onRequestCommandApproval}
                  onTipChange={onTipChange}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}


function WorkspaceEmptyLauncher({
  entries,
  onSelect,
  onOpenBrowserTab,
  onTipChange,
}: {
  entries: Array<{ id: WorkspacePanelTab; label: string; desc: string }>
  onSelect: (tab: WorkspacePanelTab) => void
  onOpenBrowserTab: (url: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <nav className="workspace-empty-launcher content-fade" aria-label="拓展功能入口">
      {entries.map((entry) => (
        <button
          {...transientTriggerProps()}
          key={entry.id}
          className="workspace-empty-launcher-item"
          type="button"
          onClick={() => {
            onTipChange(null)
            const selection = resolveWorkspaceEntrySelection(entry.id)
            if (selection.kind === 'new-browser-tab') onOpenBrowserTab(selection.url)
            else onSelect(selection.tab)
          }}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(entry.desc, event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <span className="workspace-empty-launcher-icon" aria-hidden="true">
            <WorkspaceFeatureIcon id={entry.id} />
          </span>
          <span className="workspace-empty-launcher-label">{entry.label}</span>
        </button>
      ))}
    </nav>
  )
}
