import {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionModeId,
  type PermissionModeId,
} from '../../shared/permission-modes'
import type { SessionMeta } from '../../shared/session-project-contracts'

export type SessionPermissionModeOverrides = Readonly<Record<string, PermissionModeId>>

/** Resolve a mode without allowing one conversation's selection to leak into another. */
export function resolveSessionPermissionMode(
  sessionId: string | undefined,
  sessions: readonly SessionMeta[],
  overrides: SessionPermissionModeOverrides,
  draftMode: PermissionModeId = DEFAULT_PERMISSION_MODE.id,
): PermissionModeId {
  if (!sessionId) return draftMode
  const override = overrides[sessionId]
  if (override) return override
  return normalizePermissionModeId(sessions.find((session) => session.id === sessionId)?.mode)
}
