// Owns stable renderer request identity across text, runtime, workspace, and attachment context.
import type {
  AttachmentRef,
  PermissionModeId,
  RuntimeState,
  SessionMeta,
} from '../api'

interface ConversationTurnFingerprintInput {
  text: string
  sessionId?: string
  permissionMode: PermissionModeId
  workspace?: string
  sessionScope: SessionMeta['scope']
  projectId?: string
  reasoning?: RuntimeState['reasoning']
  profile?: RuntimeState['profile']
  attachments: AttachmentRef[]
}

export function conversationTurnFingerprint(input: ConversationTurnFingerprintInput): string {
  return JSON.stringify({
    text: input.text,
    sessionId: input.sessionId ?? null,
    permissionMode: input.permissionMode,
    workspace: input.workspace ?? null,
    sessionScope: input.sessionScope,
    projectId: input.projectId ?? null,
    reasoning: input.reasoning ?? null,
    profile: input.profile ?? null,
    attachments: input.attachments.map((attachment) => ({
      cacheId: attachment.cacheId ?? null,
      contentHash: attachment.contentHash ?? null,
      path: attachment.path,
      contextPath: attachment.contextPath ?? null,
      name: attachment.name ?? null,
      kind: attachment.kind,
      mimeType: attachment.mimeType ?? null,
      size: attachment.size ?? null,
      lineComments: attachment.lineComments ?? null,
    })),
  })
}
