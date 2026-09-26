// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { AttachmentRef } from '../api'
import { StringListUpdater } from '../app-shell/types'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { PanelFullscreenIcon } from '../ui/icons'
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
import { WorkspaceFileView } from './file-view'
import { WorkspaceFileNavigator } from './file-navigator'
import { isSamePath } from './path-utils'
import { WorkspacePlaceholder } from './placeholder'
import type { WorkspaceLineComment } from './line-comments'
import {
  lineCommentScopeMatchesAttachment,
  type LineCommentAttachmentRemoval,
} from './line-comment-attachments'
import type { WorkspaceReviewRequest } from '../workspace-persistence'
import { WorkspaceReview } from './review'
import { workspaceFileLineCommentScope } from './review-line-comments'
import { WorkspaceTerminal } from './terminal'
import type { WorkspaceBrowserHistory } from './browser-history'
import { isWorkspaceBrowserTabId, type WorkspaceBrowserTab, type WorkspaceBrowserTabId } from './browser-tabs'
import { WorkspaceTabStrip } from './tab-strip'
import { WorkspaceEmptyLauncher } from './empty-launcher'

const EMPTY_LINE_COMMENTS: WorkspaceLineComment[] = []
export function WorkspacePanel({
  collapsed,
  fullscreen,
  activeTab, openTabs, browserTabs, browserUrl, browserHistory,
  workspacePath,
  defaultWorkspacePath,
  usingTemporaryRoot,
  openRequest,
  reviewFocusRequest,
  sessionId,
  artifactVersion,
  fileDrafts,
  fileNavigatorCollapsed,
  fileNavigatorWidth, reviewNavigatorWidth,
  expandedPaths,
  onTabChange,
  onTabsReorder,
  onCloseTab,
  onFileDraftChange,
  onToggleFullscreen,
  onRememberOpenPath,
  onReturnToDefaultWorkspace,
  onRequestFileSaveApproval,
  onWorkspaceArtifactsChanged,
  onWorkspaceFileSaved,
  onAddAttachment,
  onLineCommentUpdate,
  onLineCommentDelete,
  attachmentRemoval,
  onFileNavigatorCollapsedChange,
  onFileNavigatorWidthChange, onReviewNavigatorWidthChange,
  onExpandedPathsChange,
  onOpenFile, onBrowserNavigate, onBrowserHistoryMove, onBrowserOpenNewTab, onBrowserTitleChange,
  onTipChange,
}: {
  collapsed: boolean
  fullscreen: boolean
  activeTab: WorkspacePanelTabId
  openTabs: WorkspacePanelTabId[]
  browserTabs: WorkspaceBrowserTab[]
  browserUrl: string
  browserHistory: WorkspaceBrowserHistory
  workspacePath: string
  defaultWorkspacePath: string
  usingTemporaryRoot: boolean
  openRequest: WorkspaceOpenRequest | null
  reviewFocusRequest?: WorkspaceReviewRequest | null
  sessionId?: string
  artifactVersion: number
  fileDrafts: Record<string, WorkspaceFileDraftState>
  fileNavigatorCollapsed: boolean
  fileNavigatorWidth: number
  /** Same bounds as the file navigator, independent value (UX-18). */ reviewNavigatorWidth: number
  expandedPaths: string[]
  onTabChange: (tab: WorkspacePanelTabId) => void
  onTabsReorder: (tabs: WorkspacePanelTabId[]) => void
  onCloseTab: (tab: WorkspacePanelTabId) => void | Promise<void>
  onFileDraftChange: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onToggleFullscreen: () => void
  onRememberOpenPath: (root: string, path: string) => void
  onReturnToDefaultWorkspace: () => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onWorkspaceFileSaved: (root: string, path: string, preview: import('../api').WorkspacePreview) => void
  onAddAttachment: (attachment: AttachmentRef) => void
  onLineCommentUpdate: (
    scope: string,
    previous: WorkspaceLineComment,
    next: WorkspaceLineComment,
    attachment: AttachmentRef,
  ) => void
  onLineCommentDelete: (scope: string, comment: WorkspaceLineComment) => void
  attachmentRemoval: LineCommentAttachmentRemoval | null
  onFileNavigatorCollapsedChange: (collapsed: boolean) => void
  onFileNavigatorWidthChange: (width: number) => void; onReviewNavigatorWidthChange: (width: number) => void
  onExpandedPathsChange: (update: StringListUpdater) => void
  onOpenFile: (path: string) => void
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
    { id: 'review', label: '审阅', desc: '审阅当前 Git 更改' },
    { id: 'artifacts', label: '产物', desc: '按项目、来源和类型管理生成或保存的文件' },
    { id: 'terminal', label: '终端', desc: '在你选择的 Shell 里交互；切到别的标签只隐藏面板，关闭这个标签会结束全部终端会话' },
    { id: 'browser', label: '浏览器', desc: '在拓展工作区预览对话中的网页链接' },
    { id: 'sideChat', label: '侧边聊天', desc: '尚未接入的局部对话' },
  ]
  const activeFileTab = parseWorkspaceFileTabId(activeTab)
  const fullscreenTip = fullscreen ? '退出全屏工作区' : '全屏展开工作区'
  const hasOpenTabs = openTabs.length > 0
  const [mountedTabs, setMountedTabs] = useState<WorkspacePanelTabId[]>(() => (
    hasOpenTabs && openTabs.includes(activeTab) ? [activeTab] : []
  ))
  const [lineCommentsByScope, setLineCommentsByScope] = useState<Record<string, WorkspaceLineComment[]>>({})
  const handledAttachmentRemovalRef = useRef<number | null>(null)
  const initialNavigatorRoot = activeFileTab?.root ?? workspacePath
  const navigatorRootRef = useRef(initialNavigatorRoot)
  const [rememberedNavigatorRoot, setRememberedNavigatorRoot] = useState(initialNavigatorRoot)

  function updateLineComments(scope: string, comments: WorkspaceLineComment[]) {
    setLineCommentsByScope((current) => ({ ...current, [scope]: comments }))
  }

  useEffect(() => {
    if (!attachmentRemoval || handledAttachmentRemovalRef.current === attachmentRemoval.id) return
    handledAttachmentRemovalRef.current = attachmentRemoval.id
    setLineCommentsByScope((current) => {
      let changed = false
      const next = Object.fromEntries(Object.entries(current).filter(([scope]) => {
        const matches = lineCommentScopeMatchesAttachment(scope, attachmentRemoval.attachment)
        if (matches) changed = true
        return !matches
      }))
      return changed ? next : current
    })
  }, [attachmentRemoval])

  useEffect(() => {
    setMountedTabs((current) => {
      const openTabSet = new Set(openTabs)
      const next = current.filter((tab) => openTabSet.has(tab))
      if (openTabSet.has(activeTab) && !next.includes(activeTab)) next.push(activeTab)
      if (next.length === current.length && next.every((tab, index) => tab === current[index])) return current
      return next
    })
  }, [activeTab, openTabs])

  // Keep every visited open tab mounted. Switching tabs only changes which
  // surface is visible, so terminal sessions, editor models, browser guests,
  // and each view's scroll/selection state remain alive until that tab closes.
  const mountedWorkspaceTabs = mountedTabs.filter((tab) => openTabs.includes(tab))
  const workspaceViewTabs = hasOpenTabs && openTabs.includes(activeTab) && !mountedWorkspaceTabs.includes(activeTab)
    ? [...mountedWorkspaceTabs, activeTab]
    : mountedWorkspaceTabs
  const usesEdgeToEdgeFileSurface = Boolean(activeFileTab) || activeTab === 'review'
  const hasOpenFileTab = openTabs.some((tab) => Boolean(parseWorkspaceFileTabId(tab)))
  const navigatorRoot = activeFileTab?.root
    ?? (hasOpenFileTab ? rememberedNavigatorRoot : workspacePath)
  const navigatorSelectedPath = activeFileTab?.path
    ?? (openRequest?.root === navigatorRoot ? openRequest.path : '')
  const navigatorUsesTemporaryRoot = activeFileTab
    ? !isSamePath(activeFileTab.root, defaultWorkspacePath)
    : hasOpenFileTab
      ? !isSamePath(navigatorRoot, defaultWorkspacePath)
      : usingTemporaryRoot
  const sharedFileNavigatorStyle = {
    '--workspace-files-navigator-width': `${fileNavigatorWidth}px`,
  } as CSSProperties

  useEffect(() => {
    const nextRoot = activeFileTab?.root
      ?? (hasOpenFileTab ? navigatorRootRef.current : workspacePath)
    if (!nextRoot || isSamePath(navigatorRootRef.current, nextRoot)) return
    navigatorRootRef.current = nextRoot
    setRememberedNavigatorRoot(nextRoot)
  }, [activeFileTab?.root, hasOpenFileTab, workspacePath])

  function renderWorkspaceTab(tab: WorkspacePanelTabId, isActive: boolean) {
    if (tab === 'review') {
      return (
        <WorkspaceReview
          workspacePath={workspacePath}
          artifactVersion={artifactVersion}
          focusRequest={reviewFocusRequest}
          fileNavigatorCollapsed={fileNavigatorCollapsed}
          fileNavigatorWidth={reviewNavigatorWidth}
          lineCommentsByScope={lineCommentsByScope}
          onFileNavigatorCollapsedChange={onFileNavigatorCollapsedChange} onFileNavigatorWidthChange={onReviewNavigatorWidthChange}
          onLineCommentsChange={updateLineComments}
          onLineCommentUpdate={onLineCommentUpdate}
          onLineCommentDelete={onLineCommentDelete}
          onAddAttachment={onAddAttachment}
          onOpenFile={onOpenFile}
          onTipChange={onTipChange}
        />
      )
    }

    if (tab === 'artifacts') {
      return (
        <WorkspaceArtifacts
          workspacePath={workspacePath}
          sessionId={sessionId}
          artifactVersion={artifactVersion}
          onOpenFile={onOpenFile}
          onTipChange={onTipChange}
        />
      )
    }

    const fileTab = parseWorkspaceFileTabId(tab)
    if (fileTab) {
      const fileTabId = tab as WorkspaceFileTabId
      const commentScope = workspaceFileLineCommentScope(fileTab.root, fileTab.path)
      return (
        <div className="workspace-files">
          <WorkspaceFileView
            tabId={fileTabId}
            root={fileTab.root}
            path={fileTab.path}
            sessionId={sessionId}
            draft={fileDrafts[tab]} onDraftChange={onFileDraftChange}
            onRequestFileSaveApproval={onRequestFileSaveApproval}
            onWorkspaceArtifactsChanged={onWorkspaceArtifactsChanged}
            onWorkspaceFileSaved={onWorkspaceFileSaved}
            onOpenBrowserTab={onBrowserOpenNewTab}
            comments={lineCommentsByScope[commentScope] ?? EMPTY_LINE_COMMENTS}
            onCommentsChange={(comments) => updateLineComments(commentScope, comments)}
            onCommentUpdate={(previous, next, attachment) => onLineCommentUpdate(
              commentScope,
              previous,
              next,
              attachment,
            )}
            onCommentDelete={(comment) => onLineCommentDelete(commentScope, comment)}
            onAddAttachment={onAddAttachment}
            onTipChange={onTipChange}
          />
        </div>
      )
    }

    if (tab === 'terminal') {
      return (
        <WorkspaceTerminal
          workspacePath={workspacePath}
          sessionId={sessionId}
          active={isActive}
          onTipChange={onTipChange}
        />
      )
    }

    if (isWorkspaceBrowserTabId(tab)) {
      const tabState = browserTabs.find((item) => item.id === tab)
      return (
        <WorkspaceBrowser
          tabId={tab}
          url={tabState?.url ?? (isActive ? browserUrl : '')}
          history={tabState?.history ?? (isActive ? browserHistory : { entries: [], index: -1 })}
          active={isActive}
          onNavigate={onBrowserNavigate}
          onHistoryMove={onBrowserHistoryMove}
          onOpenNewTab={onBrowserOpenNewTab}
          onTitleChange={(title) => onBrowserTitleChange(tab, title)}
          onTipChange={onTipChange}
        />
      )
    }

    if (tab === 'sideChat') {
      return (
        <WorkspacePlaceholder
          title="侧边聊天尚未接入"
          text="当前版本还不能在这里进行局部对话；请在主对话区说明要处理的文件和产物。"
        />
      )
    }

    return null
  }

  return (
    <aside
      className={`workspace-panel ${collapsed ? 'collapsed' : ''} ${fullscreen ? 'fullscreen' : ''}`}
      aria-label="拓展工作区"
    >
      <div className="workspace-panel-surface">
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
              onTabsReorder={onTabsReorder}
              onCloseTab={onCloseTab}
              onOpenBrowserTab={onBrowserOpenNewTab}
              onTipChange={onTipChange}
            />
          </div>
          <div className="workspace-panel-actions workspace-tab-row-control">
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
        <div className={`workspace-panel-body ${usesEdgeToEdgeFileSurface ? 'file-surface-active' : ''}`}>
          {!hasOpenTabs && (
            <WorkspaceEmptyLauncher
              entries={workspaceEntries}
              onSelect={onTabChange}
              onOpenBrowserTab={onBrowserOpenNewTab}
              onTipChange={onTipChange}
            />
          )}
          {hasOpenTabs && workspaceViewTabs.map((tab) => {
            const isActive = tab === activeTab
            return (
              <div
                key={tab}
                className={`workspace-panel-view workspace-tab-view ${isActive ? 'active content-fade' : 'cached'}`}
                aria-hidden={!isActive}
                {...(!isActive ? { inert: '' } : {})}
              >
                {renderWorkspaceTab(tab, isActive)}
              </div>
            )
          })}
          {hasOpenTabs && (
            <div
              className={`workspace-shared-file-navigator ${activeTab === 'review' ? 'inactive' : ''}`}
              style={sharedFileNavigatorStyle}
            >
              <WorkspaceFileNavigator
                workspacePath={navigatorRoot}
                defaultWorkspacePath={defaultWorkspacePath}
                usingTemporaryRoot={navigatorUsesTemporaryRoot}
                navigatorCollapsed={fileNavigatorCollapsed}
                navigatorWidth={fileNavigatorWidth}
                expandedPaths={expandedPaths}
                selectedPath={navigatorSelectedPath}
                onOpenFileTab={(root, path) => {
                  onRememberOpenPath(root, path)
                  onTabChange(workspaceFileTabId(root, path))
                }}
                onReturnToDefaultWorkspace={onReturnToDefaultWorkspace}
                onNavigatorCollapsedChange={onFileNavigatorCollapsedChange}
                onNavigatorWidthChange={onFileNavigatorWidthChange}
                onExpandedPathsChange={onExpandedPathsChange}
                onTipChange={onTipChange}
              />
            </div>
          )}
        </div>
        </div>
      </div>
    </aside>
  )
}
