import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../../shared/session-project-contracts'
import { resolveSessionPermissionMode } from './session-permission-mode'

const sessions: SessionMeta[] = [
  {
    id: 'session-a',
    title: '会话 A',
    createdAt: 1,
    lastMessageAt: 1,
    mode: 'full-access',
    scope: 'standalone',
  },
  {
    id: 'session-b',
    title: '会话 B',
    createdAt: 2,
    lastMessageAt: 2,
    mode: 'read-only',
    scope: 'standalone',
  },
]

describe('session permission mode resolution', () => {
  it('keeps each conversation mode independent', () => {
    expect(resolveSessionPermissionMode('session-a', sessions, { 'session-a': 'read-only' })).toBe('read-only')
    expect(resolveSessionPermissionMode('session-b', sessions, { 'session-a': 'read-only' })).toBe('read-only')
    expect(resolveSessionPermissionMode('session-a', sessions, { 'session-a': 'workspace-write' })).toBe('workspace-write')
  })

  it('uses the persisted session mode when there is no local override', () => {
    expect(resolveSessionPermissionMode('session-a', sessions, {})).toBe('full-access')
  })

  it('starts a new draft with its own default mode', () => {
    expect(resolveSessionPermissionMode(undefined, sessions, {}, 'read-only')).toBe('read-only')
    expect(resolveSessionPermissionMode(undefined, sessions, {})).toBe('workspace-write')
  })

  it('falls back to read-only for an unknown persisted mode', () => {
    expect(resolveSessionPermissionMode('session-a', [{ ...sessions[0]!, mode: 'unknown' }], {})).toBe('read-only')
  })
})
