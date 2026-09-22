// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import {
  selectWorkspace
} from '../api'
import { ApprovalPrompt } from '../approval/prompt'
import { SettingsWorkspace } from '../settings/workspace'
import { ProjectCreatorDialog } from '../sidebar/project-creator'
import { CheckpointRecovery } from '../runtime-recovery/checkpoint-recovery'
import { FloatingHelpTooltip } from '../ui/floating-help'
import { FadePresence } from '../ui/presence'
import type { OverlaysViewController } from './app-controller-projections'



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
        <SettingsWorkspace
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
        />
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
