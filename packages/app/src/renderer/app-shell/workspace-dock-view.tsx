// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { useLayoutEffect } from 'react'
import {
  MAX_NAVIGATION_EXPANDED_PATHS,
  boundStringList
} from '../navigation-history'
import { buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { SidebarToggleIcon, WorkspacePanelIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
  WORKSPACE_PANEL_WIDTH_MIN
} from '../workspace-layout'
import { workspaceSessionKey } from '../workspace-persistence'
import { WorkspacePanel } from '../workspace/panel'
import { mergeLineCommentAttachment } from '../workspace/line-comment-attachments'
import type { WorkspaceDockViewController } from './app-controller-projections'




export function WorkspaceDockView({ controller }: { controller: WorkspaceDockViewController }) {
  const {
    currentSession,
    workspacePanelCollapsed,
    workspacePanelReopenActive,
    setWorkspacePanelReopenActive,
    workspacePanelFullscreen,
    workspacePanelTab,
    workspacePanelOpenTabs,
    setWorkspacePanelOpenTabs,
    workspaceBrowserTabs,
    workspaceBrowserUrl,
    workspaceBrowserHistory,
    navigateWorkspaceBrowser,
    openWorkspaceBrowserTab,
    updateWorkspaceBrowserTitle,
    moveWorkspaceBrowser,
    workspaceOpenRequest,
  workspaceReviewRequest,
    setWorkspaceOpenRequest,
    workspaceFileDrafts,
    workspaceFileNavigatorCollapsed,
    setWorkspaceFileNavigatorCollapsed,
    workspaceFileNavigatorWidth,
    setWorkspaceFileNavigatorWidth,
    workspaceReviewNavigatorWidth,
    setWorkspaceReviewNavigatorWidth,
    workspaceExpandedPaths,
    setWorkspaceExpandedPaths,
    workspaceArtifactVersion,
    setWorkspaceArtifactVersion,
    attachmentRemoval,
    setAttachments,
    removeLineCommentAttachment,
    updatePublishedLineCommentAttachment,
    setControlTip,
    setWorkspacePanelWidth,
    workspacePanelLayout,
    requestWorkspaceSaveApproval,
    openFileInWorkspace,
    beginWorkspacePanelResize,
    toggleWorkspacePanel,
    toggleWorkspacePanelFullscreen,
    nudgeWorkspacePanel,
    openWorkspacePanelTab,
    updateWorkspaceFileDraft,
    closeWorkspacePanelTab,
    notifyRuntimeWorkspaceFileSaved,
    defaultWorkspacePath,
    workspacePanelRoot,
    workspacePanelUsingTemporaryRoot,
  } = controller
  const workspacePanelToggleTip = workspacePanelCollapsed ? '打开拓展工作区' : '收起拓展工作区'

  useLayoutEffect(() => {
    const shell = document.querySelector('.window-shell')
    const coreWorkspace = shell?.querySelector('.core-workspace')
    const tabRow = shell?.querySelector('.workspace-panel-header')
    const toggle = shell?.querySelector('.workspace-panel-corner-toggle')
    if (!(shell instanceof HTMLElement)
      || !(coreWorkspace instanceof HTMLElement)
      || !(tabRow instanceof HTMLElement)
      || !(toggle instanceof HTMLElement)) {
      return
    }

    const syncToggleCenterline = () => {
      const coreRect = coreWorkspace.getBoundingClientRect()
      const tabRowRect = tabRow.getBoundingClientRect()
      const toggleRect = toggle.getBoundingClientRect()
      if (!tabRowRect.height || !toggleRect.height) return
      const top = tabRowRect.top + tabRowRect.height / 2 - toggleRect.height / 2 - coreRect.top
      shell.style.setProperty('--workspace-panel-toggle-top', `${top}px`)
    }

    syncToggleCenterline()
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncToggleCenterline)
    resizeObserver?.observe(coreWorkspace)
    resizeObserver?.observe(tabRow)
    resizeObserver?.observe(toggle)
    window.addEventListener('resize', syncToggleCenterline)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', syncToggleCenterline)
      shell.style.removeProperty('--workspace-panel-toggle-top')
    }
  }, [currentSession, workspacePanelCollapsed, workspacePanelFullscreen, workspacePanelTab, workspacePanelOpenTabs])

  return (
<>
      <div
        className="workspace-panel-resizer"
        role="separator"
        aria-hidden={workspacePanelCollapsed || workspacePanelFullscreen}
        {...(workspacePanelCollapsed || workspacePanelFullscreen ? { inert: '' } : {})}
        aria-label="调整拓展工作区宽度"
        aria-orientation="vertical"
        aria-valuemin={WORKSPACE_PANEL_WIDTH_MIN}
        aria-valuemax={workspacePanelLayout.maxSplitWidth}
        aria-valuenow={Math.round(workspacePanelLayout.width)}
        tabIndex={workspacePanelCollapsed || workspacePanelFullscreen ? -1 : 0}
        onPointerDown={beginWorkspacePanelResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            nudgeWorkspacePanel(event.shiftKey ? 32 : 12)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            nudgeWorkspacePanel(event.shiftKey ? -32 : -12)
          } else if (event.key === 'Home') {
            event.preventDefault()
            setWorkspacePanelWidth(WORKSPACE_PANEL_WIDTH_MIN)
          } else if (event.key === 'End') {
            event.preventDefault()
            setWorkspacePanelWidth(workspacePanelLayout.maxSplitWidth)
          }
        }}
      />
      <WorkspacePanel
        key={workspaceSessionKey(currentSession)}
        collapsed={workspacePanelCollapsed}
        fullscreen={workspacePanelFullscreen}
        activeTab={workspacePanelTab}
        openTabs={workspacePanelOpenTabs}
        browserTabs={workspaceBrowserTabs}
        browserUrl={workspaceBrowserUrl}
        browserHistory={workspaceBrowserHistory}
        workspacePath={workspacePanelRoot}
        defaultWorkspacePath={defaultWorkspacePath}
        usingTemporaryRoot={workspacePanelUsingTemporaryRoot}
        openRequest={workspaceOpenRequest}
        reviewFocusRequest={workspaceReviewRequest}
        sessionId={currentSession}
        artifactVersion={workspaceArtifactVersion}
        fileDrafts={workspaceFileDrafts}
        fileNavigatorCollapsed={workspaceFileNavigatorCollapsed}
        fileNavigatorWidth={workspaceFileNavigatorWidth}
        reviewNavigatorWidth={workspaceReviewNavigatorWidth}
        expandedPaths={workspaceExpandedPaths}
        onTabChange={openWorkspacePanelTab}
        onTabsReorder={setWorkspacePanelOpenTabs}
        onCloseTab={closeWorkspacePanelTab}
        onFileDraftChange={updateWorkspaceFileDraft}
        onToggleFullscreen={toggleWorkspacePanelFullscreen}
        onRememberOpenPath={(root, path) => setWorkspaceOpenRequest({ id: Date.now(), root, path })}
        onReturnToDefaultWorkspace={() => setWorkspaceOpenRequest(null)}
        onRequestFileSaveApproval={requestWorkspaceSaveApproval}
         onWorkspaceArtifactsChanged={() => setWorkspaceArtifactVersion((value) => value + 1)}
         onWorkspaceFileSaved={notifyRuntimeWorkspaceFileSaved}
         attachmentRemoval={attachmentRemoval}
         onLineCommentDelete={removeLineCommentAttachment}
         onLineCommentUpdate={updatePublishedLineCommentAttachment}
         onAddAttachment={(attachment) => setAttachments((current) => (
           mergeLineCommentAttachment(current, attachment)
         ))}
        onFileNavigatorCollapsedChange={setWorkspaceFileNavigatorCollapsed}
        onFileNavigatorWidthChange={setWorkspaceFileNavigatorWidth}
        onReviewNavigatorWidthChange={setWorkspaceReviewNavigatorWidth}
        onExpandedPathsChange={(update) => setWorkspaceExpandedPaths((paths) =>
          boundStringList(update(paths), MAX_NAVIGATION_EXPANDED_PATHS),
        )}
        onOpenFile={openFileInWorkspace}
        onBrowserNavigate={navigateWorkspaceBrowser}
        onBrowserHistoryMove={moveWorkspaceBrowser}
        onBrowserOpenNewTab={openWorkspaceBrowserTab}
        onBrowserTitleChange={updateWorkspaceBrowserTitle}
        onTipChange={setControlTip}
      />
      <button
        {...transientTriggerProps()}
        className="sidebar-toggle-btn workspace-panel-corner-toggle workspace-tab-row-control"
        type="button"
        aria-label={workspacePanelToggleTip}
        aria-expanded={!workspacePanelCollapsed}
        onClick={toggleWorkspacePanel}
        onPointerMove={(event) => event.stopPropagation()}
        onMouseEnter={(event) => {
          setWorkspacePanelReopenActive(false)
          setControlTip(buildFloatingHelpTipFromElement(workspacePanelToggleTip, event.currentTarget, {
            placement: 'left',
            avoidElement: event.currentTarget,
          }))
        }}
        onMouseMove={(event) => setControlTip(buildFloatingHelpTipFromElement(workspacePanelToggleTip, event.currentTarget, {
          placement: 'left',
          avoidElement: event.currentTarget,
        }))}
        onMouseLeave={() => setControlTip(null)}
        onFocus={(event) => setControlTip(buildFloatingHelpTipFromElement(workspacePanelToggleTip, event.currentTarget, {
          placement: 'left',
          avoidElement: event.currentTarget,
        }))}
        onBlur={() => setControlTip(null)}
      >
        <SidebarToggleIcon className="workspace-panel-toggle-icon" />
      </button>
      <button
        {...transientTriggerProps()}
        className={`workspace-panel-reopen-target ${workspacePanelReopenActive ? 'reopen-visible' : ''}`}
        type="button"
        aria-label="打开拓展工作区"
        aria-expanded={!workspacePanelCollapsed}
        aria-hidden={!workspacePanelCollapsed}
        {...(!workspacePanelCollapsed ? { inert: '' } : {})}
        tabIndex={workspacePanelCollapsed ? 0 : -1}
        onClick={toggleWorkspacePanel}
        onFocus={() => setWorkspacePanelReopenActive(true)}
        onBlur={() => setWorkspacePanelReopenActive(false)}
      >
        <span className="workspace-panel-reopen-label" aria-hidden="true">打开拓展工作区</span>
        <span className="workspace-panel-reopen-icon" aria-hidden="true">
          <WorkspacePanelIcon collapsed />
        </span>
      </button>
      </>
  )
}
