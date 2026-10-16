import { describe, expect, it } from 'vitest'
import type { ShellExecutionDescription } from '@littlesheep/types'
import {
  SHELL_REPEAT_AUTHORIZATION_MAX_USES,
  SHELL_REPEAT_AUTHORIZATION_TTL_MS,
  ShellRepeatAuthorizationStore,
  isRepeatCandidate,
} from './shell-repeat-authorization-store.js'

function description(overrides: Partial<ShellExecutionDescription> = {}): ShellExecutionDescription {
  const windows = process.platform === 'win32'
  const path = windows ? 'C:\\workspace' : '/workspace'
  return {
    version: 1,
    invocationId: 'invocation-1',
    digest: 'digest-1',
    action: 'exec',
    command: 'pwd',
    shell: {
      path: windows ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' : '/usr/bin/dash',
      args: windows ? ['-NoProfile', '-Command'] : ['-c'],
      identity: 'shell-object-1',
    },
    cwd: { path, identity: 'workspace-object-1' },
    workspace: { id: 'workspace:one', path, identity: 'workspace-object-1' },
    sessionId: 'session-one',
    runId: 'run-1',
    permission: 'permission-v2-workspace-write',
    environment: 'main-hmac-fingerprint-1',
    timeoutMs: 120_000,
    source: 'agent',
    user: 'test-user',
    ...overrides,
  }
}

describe('Main-owned exact Shell repeat authorization', () => {
  it('allows an exact Main-reviewed command and binds its raw command text', () => {
    expect(isRepeatCandidate(description())).toBe(true)
    expect(isRepeatCandidate(description({ command: 'git status --short' }))).toBe(true)
    expect(isRepeatCandidate(description({ command: ' ' }))).toBe(false)
    expect(isRepeatCandidate(description({ timeoutMs: 60_000 }))).toBe(true)
    expect(isRepeatCandidate(description({ cwd: { path: '/workspace/sub', identity: 'other' } }))).toBe(false)

    const store = new ShellRepeatAuthorizationStore()
    const exact = description({ command: 'git status --short' })
    store.remember(exact, 100)
    expect(store.consume(description({ command: 'git status --short', runId: 'run-2', invocationId: 'invocation-2' }), 101)).toBe(true)
    expect(store.consume(description({ command: 'git status --short ', runId: 'run-3', invocationId: 'invocation-3' }), 102)).toBe(false)
  })

  it('matches across runs but binds every execution and permission fact', () => {
    const store = new ShellRepeatAuthorizationStore()
    const first = description()
    expect(store.remember(first, 100)).toBeTypeOf('function')
    expect(store.consume(description({ runId: 'run-2', invocationId: 'invocation-2', digest: 'digest-2' }), 101)).toBe(true)

    for (const changed of [
      description({ workspace: { id: 'workspace:two', path: '/workspace', identity: 'workspace-object-1' } }),
      description({ cwd: { path: '/workspace/sub', identity: 'child-object' } }),
      description({ shell: { ...first.shell, identity: 'different-shell-binary' } }),
      description({ shell: { ...first.shell, args: [...first.shell.args, '-NoLogo'] } }),
      description({ permission: 'permission-v2-read-only' }),
      description({ environment: 'different-main-hmac' }),
      description({ timeoutMs: 60_000 }),
      description({ user: 'different-user' }),
    ]) {
      const isolated = new ShellRepeatAuthorizationStore()
      isolated.remember(first, 200)
      expect(isolated.consume(changed, 201)).toBe(false)
      expect(isolated.consume(first, 202)).toBe(false)
    }

    const separateSession = new ShellRepeatAuthorizationStore()
    separateSession.remember(first, 300)
    expect(separateSession.consume(description({ sessionId: 'session-two' }), 301)).toBe(false)
    expect(separateSession.consume(first, 302)).toBe(true)
  })

  it('expires after 30 minutes and consumes no more than 20 repeats under concurrent calls', () => {
    const expired = new ShellRepeatAuthorizationStore()
    expired.remember(description(), 1_000)
    expect(expired.consume(description(), 1_000 + SHELL_REPEAT_AUTHORIZATION_TTL_MS)).toBe(false)

    const limited = new ShellRepeatAuthorizationStore()
    limited.remember(description(), 1_000)
    const outcomes = Array.from({ length: SHELL_REPEAT_AUTHORIZATION_MAX_USES + 4 }, (_, index) =>
      limited.consume(description({ runId: `run-${index}` }), 1_001 + index))
    expect(outcomes.filter(Boolean)).toHaveLength(SHELL_REPEAT_AUTHORIZATION_MAX_USES)
  })

  it('supports internal rollback when the first approved launch fails', () => {
    const store = new ShellRepeatAuthorizationStore()
    const rollback = store.remember(description(), 10)!
    expect(store.consume(description(), 11)).toBe(true)
    rollback()
    expect(store.consume(description(), 12)).toBe(false)
  })

  it('permanently invalidates the session grant on a changed execution context', () => {
    const store = new ShellRepeatAuthorizationStore()
    store.remember(description(), 10)
    expect(store.consume(description({ environment: 'changed' }), 11)).toBe(false)
    expect(store.consume(description(), 12)).toBe(false)
  })
})
