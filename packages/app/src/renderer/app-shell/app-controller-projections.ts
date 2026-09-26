// Which controller fields each renderer view is allowed to see.
//
// The controller is one object with everything in it; a view that receives the whole thing quietly
// couples to fields it never needed, and the coupling only shows up when someone changes one. So
// every view gets a declared Pick of the fields it actually renders, and adding a field to a view is
// a one-line edit here rather than a prop drilled through three components.
import type { AppController } from './use-app-controller'

export const APP_CONTROLLER_VIEW_FIELDS = {
  app: [
    'shellRef',
    'sidebarCollapsed',
    'workspacePanelCollapsed',
    'workspacePanelFullscreen',
    'directModulePage',
    'settingsOpen',
    'settingsReturning',
    'layoutStyle',
    'sidebarToggleTip',
    'canNavigateBack',
    'canNavigateForward',
    'settingsEntryRippling',
    'openSettingsFromEntry',
    'closeSettingsFromEntry',
    'finishSettingsReturn',
    'toggleSidebar',
    'navigateBack',
    'navigateForward',
    'setControlTip',
    'openHyperlinkInside',
    'openHyperlinkWithSystem',
    'titlebarTask',
  ],
  sidebar: [
    'sidebarCollapsed',
    'sidebarPanel',
    'directModulePage',
    'createConversationFromSidebar',
    'createProjectConversationFromSidebar',
    'openSidebarPanel',
    'openDirectModulePage',
    'setControlTip',
    'projects',
    'displayedSessions',
    'currentSession',
    'pinnedSessionIds',
    'now',
    'reorderSidebarSessions',
    'sessionOwnership',
    'projectPath',
    'activateProjectWorkspace',
    'openProjectCreator',
    'switchSession',
    'togglePinnedSession',
    'renameSession',
    'archiveSession',
    'deleteSessionPermanently',
    'archiveProject',
    'relocateProject',
    'deleteProjectPermanently',
  ],
  sidebarResizer: [
    'sidebarCollapsed',
    'sidebarWidth',
    'beginSidebarResize',
    'nudgeSidebar',
    'setSidebarWidth',
  ],
  conversation: [
    'conversationCollapsed',
    'setConversationCollapsed',
    'moreConversationTip',
    'setControlTip',
    'archiveAllSessions',
    'newConversationTip',
    'createConversationFromSidebar',
    'visibleSessions',
    'currentSession',
    'pinnedSessionIds',
    'now',
    'reorderSidebarSessions',
    'switchSession',
    'togglePinnedSession',
    'renameSession',
    'archiveSession',
    'deleteSessionPermanently',
  ],
  coreWorkspace: [
    'updateWorkspacePanelReopenPresence',
    'setWorkspacePanelReopenActive',
    'directModulePage',
    'sidebarPanel',
    'sidebarSearch',
    'visibleSessions',
    'currentSession',
    'now',
    'setSidebarSearch',
    'closeSidebarPanel',
    'switchSession',
  ],
  chat: [
    'currentSession',
    'messages',
    'historyWindow',
    'loadOlderMessages',
    'scrollRef',
    'activityNow',
    'openFileInWorkspace',
    'openReviewInWorkspace',
    'projectPath',
    'branchConversationFromMessage',
  ],
  composer: [
    'input',
    'setInput',
    'inputRef',
    'scrollRef',
    'loading',
    'permissionMode',
    'setPermissionMode',
    'runtime',
    'attachments',
    'setAttachments',
    'removeAttachment',
    'dragActive',
    'runtimeError',
    'runtimeEventNotice',
    'activityNow',
    'selectableProviders',
    'selectedModel',
    'workspaceIsWorkplace',
    'workspaceTip',
    'contextUsage',
    'latestTaskActivity',
    'uploadTip',
    'sendTip',
    'stopTip',
    'setControlTip',
    'applyRuntimePatch',
    'applyModelPatch',
    'openSettingsPage',
    'refreshRuntime',
    'addAttachments',
    'chooseWorkspace',
    'resetWorkspace',
    'openFileInWorkspace',
    'openReviewInWorkspace',
    'projectPath',
    'handleComposerDragEnter',
    'handleComposerDragOver',
    'handleComposerDragLeave',
    'handleComposerDrop',
    'handleComposerPaste',
    'send',
    'stop',
  ],
  workspaceDock: [
    'currentSession',
    'workspacePanelCollapsed',
    'workspacePanelReopenActive',
    'setWorkspacePanelReopenActive',
    'workspacePanelFullscreen',
    'workspacePanelTab',
    'workspacePanelOpenTabs',
    'setWorkspacePanelOpenTabs',
    'workspaceBrowserTabs',
    'workspaceBrowserUrl',
    'workspaceBrowserHistory',
    'navigateWorkspaceBrowser',
    'openWorkspaceBrowserTab',
    'updateWorkspaceBrowserTitle',
    'moveWorkspaceBrowser',
    'workspaceOpenRequest',
    'workspaceReviewRequest',
    'setWorkspaceOpenRequest',
    'workspaceFileDrafts',
    'workspaceFileNavigatorCollapsed',
    'setWorkspaceFileNavigatorCollapsed',
    'workspaceFileNavigatorWidth',
    'setWorkspaceFileNavigatorWidth',
    'workspaceReviewNavigatorWidth',
    'setWorkspaceReviewNavigatorWidth',
    'workspaceExpandedPaths',
    'setWorkspaceExpandedPaths',
    'workspaceArtifactVersion',
    'setWorkspaceArtifactVersion',
    'attachmentRemoval',
    'setAttachments',
    'removeLineCommentAttachment',
    'updatePublishedLineCommentAttachment',
    'setControlTip',
    'setWorkspacePanelWidth',
    'workspacePanelLayout',
    'requestWorkspaceSaveApproval',
    'openFileInWorkspace',
    'openReviewInWorkspace',
    'projectPath',
    'beginWorkspacePanelResize',
    'toggleWorkspacePanel',
    'toggleWorkspacePanelFullscreen',
    'nudgeWorkspacePanel',
    'openWorkspacePanelTab',
    'updateWorkspaceFileDraft',
    'closeWorkspacePanelTab',
    'notifyRuntimeWorkspaceFileSaved',
    'defaultWorkspacePath',
    'workspacePanelRoot',
    'workspacePanelUsingTemporaryRoot',
  ],
  overlays: [
    'runtime',
    'pendingApproval',
    'checkpointRecovery',
    'sidebarCollapsed',
    'projectCreatorOpen',
    'setProjectCreatorOpen',
    'controlTip',
    'sidebarWidth',
    'settingsOpen',
    'settingsReturning',
    'settingsPage',
    'canNavigateBack',
    'canNavigateForward',
    'openSettingsPage',
    'closeSettingsFromEntry',
    'finishSettingsReturn',
    'navigateBack',
    'navigateForward',
    'sidebarToggleTip',
    'settleApprovalPrompt',
    'refreshSessions',
    'refreshProjects',
    'applyRuntimePatch',
    'applyRuntimePatchReporting',
    'chooseProjectFolder',
    'createProjectInFolder',
    'beginSidebarResize',
    'nudgeSidebar',
    'toggleSidebar',
    'setSidebarWidth',
    'setControlTip',
  ],
} as const satisfies Record<string, readonly (keyof AppController)[]>

type ProjectionName = keyof typeof APP_CONTROLLER_VIEW_FIELDS
type ProjectedControllerField = (typeof APP_CONTROLLER_VIEW_FIELDS)[ProjectionName][number]
type AssertNever<Value extends never> = Value

export type AppControllerProjectionCoverage = AssertNever<Exclude<keyof AppController, ProjectedControllerField>>

type Projection<Name extends ProjectionName> = Pick<
  AppController,
  (typeof APP_CONTROLLER_VIEW_FIELDS)[Name][number]
>

export type ConversationSectionViewController = Projection<'conversation'>
export type SidebarResizerViewController = Projection<'sidebarResizer'>
export type ChatViewController = Projection<'chat'>
export type ComposerViewController = Projection<'composer'>
export type WorkspaceDockViewController = Projection<'workspaceDock'>
export type OverlaysViewController = Projection<'overlays'>

export type SidebarViewController = Projection<'sidebar'> & {
  conversation: ConversationSectionViewController
  resizer: SidebarResizerViewController
}

export type CoreWorkspaceViewController = Projection<'coreWorkspace'> & {
  chat: ChatViewController
  composer: ComposerViewController
  workspaceDock: WorkspaceDockViewController
}

export type AppViewController = Projection<'app'> & {
  sidebar: SidebarViewController
  coreWorkspace: CoreWorkspaceViewController
  overlays: OverlaysViewController
}

export function projectAppController(controller: AppController): AppViewController {
  const conversation = pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.conversation)
  const resizer = pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.sidebarResizer)
  const chat = pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.chat)
  const composer = pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.composer)
  const workspaceDock = pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.workspaceDock)

  return {
    ...pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.app),
    sidebar: {
      ...pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.sidebar),
      conversation,
      resizer,
    },
    coreWorkspace: {
      ...pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.coreWorkspace),
      chat,
      composer,
      workspaceDock,
    },
    overlays: pickFields(controller, APP_CONTROLLER_VIEW_FIELDS.overlays),
  }
}

function pickFields<const Fields extends readonly (keyof AppController)[]>(
  controller: AppController,
  fields: Fields,
): Pick<AppController, Fields[number]> {
  return Object.fromEntries(fields.map((field) => [field, controller[field]])) as Pick<
    AppController,
    Fields[number]
  >
}
