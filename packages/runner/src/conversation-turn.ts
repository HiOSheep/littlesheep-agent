import { createHash } from 'node:crypto'
import type { RunAttachment, SessionId } from '@littlesheep/types'

export interface ConversationTurnFingerprintInput {
  sessionId: SessionId
  requestKey: string
  text: string
  checkpointId?: string
  cwd?: string
  origin?: string
  permissionPolicyId?: string
  reasoning?: string
  profile?: string
  attachments?: RunAttachment[]
}

export function conversationTurnMessageId(
  sessionId: SessionId,
  requestKey?: string,
): string | undefined {
  const digest = conversationTurnDigest(sessionId, requestKey)
  return digest ? `conversation-turn-${digest}` : undefined
}

export function conversationTurnRunId(
  sessionId: SessionId,
  requestKey?: string,
): string | undefined {
  const digest = conversationTurnDigest(sessionId, requestKey)
  return digest ? `conversation-run-${digest}` : undefined
}

export function conversationTurnInputDigest(input: ConversationTurnFingerprintInput): string {
  const attachments = (input.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    cacheId: attachment.cacheId,
    contentHash: attachment.contentHash,
    contextPath: attachment.contextPath,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    size: attachment.size,
    lineComments: attachment.lineComments,
  }))
  return createHash('sha256').update(JSON.stringify({
    sessionId: String(input.sessionId),
    requestKey: input.requestKey.trim(),
    text: input.text.trim(),
    checkpointId: input.checkpointId,
    cwd: input.cwd,
    origin: input.origin,
    permissionPolicyId: input.permissionPolicyId,
    reasoning: input.reasoning,
    profile: input.profile,
    attachments,
  }), 'utf8').digest('hex')
}

function conversationTurnDigest(sessionId: SessionId, requestKey?: string): string | undefined {
  const normalized = requestKey?.trim()
  if (!normalized) return undefined
  return createHash('sha256').update(`${sessionId}\0${normalized}`, 'utf8').digest('hex')
}
