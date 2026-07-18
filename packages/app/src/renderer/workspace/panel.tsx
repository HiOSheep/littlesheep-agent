// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useRef, useState } from 'react'
import { StringListUpdater } from '../app-shell/types'
import { ChatMessage } from '../chat/types'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { CloseMiniIcon, FileGlyphIcon, PanelCollapseIcon, PanelFullscreenIcon, WorkspaceFeatureIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
  isWorkspacePanelTab,
  parseWorkspaceFileTabId,
  workspaceFileTabId,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId,
  type WorkspaceOpenRequest,
  type WorkspacePanelTab,
  type WorkspacePanelTabId
} from '../workspace-persistence'
import { WorkspaceAddMenu } from './add-menu'
import { WorkspaceArtifacts } from './artifacts'
import { WorkspaceBrowser } from './browser'
import { WorkspaceFileNavigator } from './file-navigator'
import { WorkspaceFiles } from './files'
import { WorkspaceOverview } from './overview'
import { isSamePath, lastPathSegment } from './path-utils'
import { WorkspacePlaceholder } from './placeholder'
import { WorkspaceFileView } from './preview-pane'
import { WorkspaceTerminal } from './terminal'
import type { WorkspaceBrowserHistory } from './browser-history'
export function WorkspacePanel({
  collapsed,
  fullscreen,
  activeTab, openTabs, browserUrl, browserHistory,
  messages,
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  workplacePath,
  openRequest,
  sessionId,
  sessionTitle,
  artifactVersion,
  fileDrafts,
  fileNavigatorCollapsed,
  expandedPaths,
  onTabChange,
  onCloseTab,
  onFileDraftChange,
  onToggleCollapsed,
  onToggleFullscreen,
  onRememberOpenPath,
  onReturnToDefaultWorkspace,
  onRequestFileSaveApproval,
  onRequestCommandApproval,
  onWorkspaceArtifactsChanged,
  onFileNavigatorCollapsedChange,
  onExpandedPathsChange,
  onOpenFile, onNavigateLink, onBrowserNavigate, onBrowserHistoryMove,
  onTipChange,
}: {
  collapsed: boolean
  fullscreen: boolean
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  browserUrl: string
  browserHistory: WorkspaceBrowserHistory
  messages: ChatMessage[]
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  workplacePath: string
  openRequest: WorkspaceOpenRequest | null
  sessionId?: string
  sessionTitle?: string
  artifactVersion: number
  fileDrafts: Record<string, WorkspaceFileDraftState>
  fileNavigatorCollapsed: boolean
  expandedPaths: string[]
  onTabChange: (tab: WorkspacePanelTabId) => void
  onCloseTab: (tab: WorkspacePanelTabId) => void
  onFileDraftChange: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onToggleCollapsed: () => void
  onToggleFullscreen: () => void
  onRememberOpenPath: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onRequestCommandApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onFileNavigatorCollapsedChange: (collapsed: boolean) => void
  onExpandedPathsChange: (update: StringListUpdater) => void
  onOpenFile: (path: string) => void
  onNavigateLink: (href: string) => void
  onBrowserNavigate: (url: string, mode?: 'push' | 'replace') => void
  onBrowserHistoryMove: (delta: number) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const workspaceEntries: Array<{
    id: WorkspacePanelTab
    label: string
    desc: string
    shortcut?: string
  }> = [
    { id: 'review', label: '审查', desc: '当前工作现场、任务阶段和产物入口', shortcut: 'Ctrl+Shift+G' },
    { id: 'artifacts', label: '产物', desc: '按项目、来源和类型管理生成或保存的文件', shortcut: 'Ctrl+Shift+A' },
    { id: 'terminal', label: '终端', desc: 'LS 内置 PowerShell，命令执行受权限控制' },
    { id: 'browser', label: '浏览器', desc: '在拓展工作区预览对话中的网页链接', shortcut: 'Ctrl+T' },
    { id: 'sideChat', label: '侧边聊天', desc: '后续承载与当前文件或产物相关的局部对话', shortcut: 'Ctrl+Alt+S' },
  ]
  const fallbackEntry: typeof workspaceEntries[number] = {
    id: 'review',
    label: '审查',
    desc: '当前工作现场、任务阶段和产物入口',
    shortcut: 'Ctrl+Shift+G',
  }
  const workspaceEntryById = new Map(workspaceEntries.map((entry) => [entry.id, entry]))
  const activeFileTab = parseWorkspaceFileTabId(activeTab)
  const activeEntry = activeFileTab
    ? {
      id: activeTab,
      label: lastPathSegment(activeFileTab.path),
      desc: activeFileTab.path,
      shortcut: undefined,
      kind: 'file' as const,
      dirty: Boolean(fileDrafts[activeTab]?.editorText !== fileDrafts[activeTab]?.savedText),
    }
    : { ...(isWorkspacePanelTab(activeTab) ? workspaceEntryById.get(activeTab) ?? fallbackEntry : fallbackEntry), kind: 'feature' as const, dirty: false }
  const visibleTabs = openTabs
    .map((tab) => {
      const fileTab = parseWorkspaceFileTabId(tab)
      if (fileTab) {
        return {
          id: tab,
          label: lastPathSegment(fileTab.path),
          desc: fileTab.path,
          shortcut: undefined,
          kind: 'file' as const,
          dirty: Boolean(fileDrafts[tab]?.editorText !== fileDrafts[tab]?.savedText),
        }
      }
      const entry = isWorkspacePanelTab(tab) ? workspaceEntryById.get(tab) : undefined
      return entry ? { ...entry, kind: 'feature' as const, dirty: false } : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  const displayedTabs = visibleTabs.length > 0 ? visibleTabs : [activeEntry]
  const fullscreenTip = fullscreen ? '退出全屏工作区' : '全屏展开工作区'
  const workspaceIsDefault = isSamePath(workspacePath, workplacePath)
  const [warmTab, setWarmTab] = useState<WorkspacePanelTabId | null>(null)
  const previousTabRef = useRef<WorkspacePanelTabId>(activeTab)
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden')

  useEffect(() => {
    const previousTab = previousTabRef.current
    previousTabRef.current = activeTab
    if (previousTab === activeTab) return
    setWarmTab(previousTab)
    const timer = window.setTimeout(() => setWarmTab((current) => current === previousTab ? null : current), 20_000)
    return () => window.clearTimeout(timer)
  }, [activeTab])

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [])

  const panelSuspended = collapsed || !pageVisible
  // Derive the previous tab during the transition render as well. This keeps
  // the old heavy view mounted while React commits the new active tab instead
  // of unmounting it and recreating it one effect later.
  const transitionWarmTab = previousTabRef.current !== activeTab
    ? previousTabRef.current
    : warmTab
  const warmFileTab = transitionWarmTab ? parseWorkspaceFileTabId(transitionWarmTab) : null

  return (
    <aside
      className={`workspace-panel ${collapsed ? 'collapsed' : ''} ${fullscreen ? 'fullscreen' : ''}`}
      aria-label="拓展工作区"
    >
      <div className="workspace-panel-contents" {...(collapsed ? { inert: '' } : {})}>
        <header className="workspace-panel-header">
          <div className="workspace-panel-topbar">
            <div className="workspace-tab-strip" role="tablist" aria-label="拓展功能区">
              {displayedTabs.map((entry) => {
                const active = entry.id === activeTab
                return (
                  <div
                    key={entry.id}
                    className={`workspace-active-item ${active ? 'active' : ''} ${entry.kind === 'file' && entry.dirty ? 'file-dirty' : ''}`}
                    role="tab"
                    tabIndex={0}
                    aria-selected={active}
                    onClick={() => onTabChange(entry.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      onTabChange(entry.id)
                    }}
                    onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
                    onMouseMove={(event) => onTipChange(buildFloatingHelpTip(entry.desc, event.clientX, event.clientY))}
                    onMouseLeave={() => onTipChange(null)}
                    onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(entry.desc, event.currentTarget))}
                    onBlur={() => onTipChange(null)}
                  >
                    {entry.kind === 'file' ? <FileGlyphIcon /> : <WorkspaceFeatureIcon id={entry.id} />}
                    <span className="workspace-active-label">{entry.label}</span>
                    <button
                      {...transientTriggerProps()}
                      className="workspace-active-close"
                      type="button"
                      aria-label={`关闭${entry.label}标签`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onCloseTab(entry.id)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        event.stopPropagation()
                        onCloseTab(entry.id)
                      }}
                    >
                      <CloseMiniIcon />
                    </button>
                  </div>
                )
              })}
              <WorkspaceAddMenu
                entries={workspaceEntries}
                activeTab={isWorkspacePanelTab(activeTab) ? activeTab : 'review'}
                openTabs={displayedTabs.map((entry) => entry.id).filter(isWorkspacePanelTab)}
                onSelect={onTabChange}
                onTipChange={onTipChange}
              />
            </div>
            <div className="workspace-context-line">
              {workspaceIsDefault ? '默认工作区' : '目标工作区'}
            </div>
          </div>
          <div className="workspace-panel-actions">
            <button
              {...transientTriggerProps()}
              className="workspace-panel-action"
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
            <button
              {...transientTriggerProps()}
              className="workspace-panel-action"
              type="button"
              aria-label="收起拓展工作区"
              onClick={onToggleCollapsed}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('收起拓展工作区', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip('收起拓展工作区', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('收起拓展工作区', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              <PanelCollapseIcon />
            </button>
          </div>
        </header>
        <div className="workspace-panel-body">
          {!panelSuspended && (
            <div
              key={activeEntry.id}
              className={`workspace-panel-view content-fade ${!activeFileTab && activeTab !== 'files' ? 'with-file-navigator' : ''}`}
            >
            {activeTab === 'review' && (
              <WorkspaceOverview
                workspacePath={workspacePath}
                workplacePath={workplacePath}
                activeTab={activeTab}
                activeTabLabel={activeEntry.label}
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
                onRequestCommandApproval={onRequestCommandApproval}
                onTipChange={onTipChange}
              />
            )}
            {activeTab === 'browser' && (
              <WorkspaceBrowser
                url={browserUrl}
                history={browserHistory}
                onNavigate={onBrowserNavigate}
                onHistoryMove={onBrowserHistoryMove}
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
          {!panelSuspended && !activeFileTab && activeTab !== 'files' && (
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
          {!panelSuspended && transitionWarmTab && transitionWarmTab !== activeTab && (warmFileTab || transitionWarmTab === 'terminal') && (
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
                    onTipChange={onTipChange}
                  />
                </div>
              )}
              {transitionWarmTab === 'terminal' && (
                <WorkspaceTerminal
                  workspacePath={workspacePath}
                  sessionId={sessionId}
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
