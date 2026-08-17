// Pure renderer composition view. Runtime authority and side effects stay in the controller.
import '@xterm/xterm/css/xterm.css'
import {
  selectWorkspace
} from '../api'
import { ApprovalPrompt } from '../approval/prompt'
import { SettingsWorkspace } from '../settings/workspace'
import { SettingsEntryBridge } from '../sidebar/global-titlebar'
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
    settingsEntryRippling,
    sidebarWidth,
    settingsOpen,
    settingsPage,
    canNavigateBack,
    canNavigateForward,
    openSettingsFromEntry,
    openSettingsPage,
    navigateBack,
    navigateForward,
    closeSettingsFromEntry,
    sidebarToggleTip,
    settleApprovalPrompt,
    refreshSessions,
    refreshProjects,
    applyRuntimePatch,
    chooseProjectFolder,
    createProjectInFolder,
    beginSidebarResize,
    nudgeSidebar,
    toggleSidebar,
    setSidebarWidth,
    setControlTip,
  } = controller
  return (
<>
      <FadePresence show={settingsOpen} exitMs={790} interactiveDuringExit>
        <SettingsWorkspace
          page={settingsPage}
          runtime={runtime}
          sidebarCollapsed={sidebarCollapsed}
          sidebarWidth={sidebarWidth}
          sidebarToggleTip={sidebarToggleTip}
          canBack={canNavigateBack}
          canForward={canNavigateForward}
          onBeginSidebarResize={beginSidebarResize}
          onNudgeSidebar={nudgeSidebar}
          onSetSidebarWidth={setSidebarWidth}
          onToggleSidebar={toggleSidebar}
          onBack={navigateBack}
          onForward={navigateForward}
          onClose={closeSettingsFromEntry}
          settingsEntryRippling={settingsEntryRippling}
          onOpenPage={openSettingsPage}
          onProfileChange={(profile) => void applyRuntimePatch({ profile })}
          onContextCompressionThresholdChange={async (ratio) => {
            await applyRuntimePatch({ contextCompressionThresholdRatio: ratio })
          }}
          onClosePolicyChange={(closePolicy) => applyRuntimePatch({ closePolicy })}
          onArchiveChanged={() => {
            void refreshProjects()
            void refreshSessions()
          }}
          onTipChange={setControlTip}
        />
        <SettingsEntryBridge
          settingsOpen={settingsOpen}
          onOpen={openSettingsFromEntry}
          onClose={closeSettingsFromEntry}
          rippling={settingsEntryRippling}
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
