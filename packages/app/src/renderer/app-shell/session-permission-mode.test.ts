import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../../shared/session-project-contracts'
import { resolveSessionPermissionMode } from './session-permission-mode'

const sessions: SessionMeta[] = [
  {
    id: 'session-a',
    title: '会话 A',
    createdAt: 1,
    lastMessageAt: 1,
    mode: 'full',
    scope: 'standalone',
  },
  {
    id: 'session-b',
    title: '会话 B',
    createdAt: 2,
    lastMessageAt: 2,
    mode: 'research',
    scope: 'standalone',
  },
]

describe('session permission mode resolution', () => {
  it('keeps each conversation mode independent', () => {
    expect(resolveSessionPermissionMode('session-a', sessions, { 'session-a': 'restricted' })).toBe('restricted')
    expect(resolveSessionPermissionMode('session-b', sessions, { 'session-a': 'restricted' })).toBe('research')
    expect(resolveSessionPermissionMode('session-a', sessions, { 'session-a': 'full' })).toBe('full')
  })

  it('uses the persisted session mode when there is no local override', () => {
    expect(resolveSessionPermissionMode('session-a', sessions, {})).toBe('full')
  })

  it('starts a new draft with its own default mode', () => {
    expect(resolveSessionPermissionMode(undefined, sessions, {}, 'restricted')).toBe('restricted')
    expect(resolveSessionPermissionMode(undefined, sessions, {})).toBe('research')
  })

  it('falls back to research for an unknown persisted mode', () => {
    expect(resolveSessionPermissionMode('session-a', [{ ...sessions[0]!, mode: 'unknown' }], {})).toBe('research')
  })
})
