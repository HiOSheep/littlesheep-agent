import {
  normalizePermissionSelectionId,
  type PermissionSelectionId,
} from '../../shared/permission-modes'
import type { SessionMeta } from '../../shared/session-project-contracts'

export type SessionPermissionModeOverrides = Readonly<Record<string, PermissionSelectionId>>

/** Resolve a mode without allowing one conversation's selection to leak into another. */
export function resolveSessionPermissionMode(
  sessionId: string | undefined,
  sessions: readonly SessionMeta[],
  overrides: SessionPermissionModeOverrides,
  draftMode: PermissionSelectionId = 'workspace-write',
): PermissionSelectionId {
  if (!sessionId) return draftMode
  const override = overrides[sessionId]
  if (override) return override
  return normalizePermissionSelectionId(sessions.find((session) => session.id === sessionId)?.mode)
}
