// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import { lazy, Suspense, useRef } from 'react'
import {
  selectWorkspace
} from '../api'
import { ApprovalPrompt } from '../approval/prompt'
import { ProjectCreatorDialog } from '../sidebar/project-creator'
import { CheckpointRecovery } from '../runtime-recovery/checkpoint-recovery'
import { FloatingHelpTooltip } from '../ui/floating-help'
import { FadePresence } from '../ui/presence'
import type { OverlaysViewController } from './app-controller-projections'

const SettingsWorkspace = lazy(async () => ({ default: (await import('../settings/workspace')).SettingsWorkspace }))



export function OverlaysView({ controller }: { controller: OverlaysViewController }) {
  const {
    runtime,
    pendingApproval,
    checkpointRecovery,
    sidebarCollapsed,
    projectCreatorOpen,
    setProjectCreatorOpen,
    controlTip,
    sidebarWidth,
    settingsOpen,
    finishSettingsReturn,
    closeSettingsFromEntry,
    settingsPage,
    openSettingsPage,
    settleApprovalPrompt,
    refreshSessions,
    refreshProjects,
    applyRuntimePatch,
    applyRuntimePatchReporting,
    chooseProjectFolder,
    createProjectInFolder,
    beginSidebarResize,
    nudgeSidebar,
    setSidebarWidth,
  } = controller
  // Retain settings state after the first visit without mounting its pages or
  // starting their requests during an ordinary chat startup.
  const settingsVisited = useRef(settingsOpen)
  if (settingsOpen) settingsVisited.current = true
  return (
<>
      <FadePresence
        show={settingsOpen}
        exitMs={560}
        enterFrames={1}
        interactiveDuringExit
        keepMounted
        onExited={finishSettingsReturn}
        className="settings-presence"
      >
        {settingsVisited.current && <Suspense fallback={<div className="settings-workspace" role="status">加载设置…</div>}><SettingsWorkspace
          page={settingsPage}
          runtime={runtime}
          sidebarCollapsed={sidebarCollapsed}
          sidebarWidth={sidebarWidth}
          onBeginSidebarResize={beginSidebarResize}
          onNudgeSidebar={nudgeSidebar}
          onSetSidebarWidth={setSidebarWidth}
          onOpenPage={openSettingsPage}
          onCloseSettings={closeSettingsFromEntry}
          onProfileChange={(profile) => void applyRuntimePatch({ profile })}
          onContextCompressionThresholdChange={(ratio) => (
            applyRuntimePatchReporting({ contextCompressionThresholdRatio: ratio })
          )}
          onClosePolicyChange={(closePolicy) => applyRuntimePatch({ closePolicy })}
          onArchiveChanged={() => {
            void refreshProjects()
            void refreshSessions()
          }}
        /></Suspense>}
      </FadePresence>
      <ProjectCreatorDialog
        show={projectCreatorOpen}
        defaultParentPath={runtime?.workspace ?? runtime?.workplace ?? ''}
        onClose={() => setProjectCreatorOpen(false)}
        onChooseExisting={chooseProjectFolder}
        onChooseParent={selectWorkspace}
        onCreateNew={createProjectInFolder}
      />
      <CheckpointRecovery recovery={checkpointRecovery} />
      <ApprovalPrompt prompt={pendingApproval} onResolve={settleApprovalPrompt} />
      <FloatingHelpTooltip tip={controlTip} />

      </>
  )
}
