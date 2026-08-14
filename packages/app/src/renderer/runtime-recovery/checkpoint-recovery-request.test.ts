import { describe, expect, it, vi } from 'vitest'
import { resolveCheckpointRecoveryTurnIdentity } from './checkpoint-recovery-request'

describe('checkpoint recovery request identity', () => {
  it('reuses one request key for the same explicit recovery turn', () => {
    const createRequestKey = vi.fn()
      .mockReturnValueOnce('recovery-key-1')
      .mockReturnValueOnce('recovery-key-2')
    const input = {
      checkpointId: 'checkpoint-1',
      text: 'Permission is enabled. Continue.',
      permissionMode: 'full' as const,
      reasoning: 'high' as const,
      profile: 'general' as const,
    }

    const first = resolveCheckpointRecoveryTurnIdentity(null, input, createRequestKey)
    const retried = resolveCheckpointRecoveryTurnIdentity(first, input, createRequestKey)

    expect(first.requestKey).toBe('recovery-key-1')
    expect(retried).toBe(first)
    expect(createRequestKey).toHaveBeenCalledOnce()
  })

  it('creates a new request key when the selected task or runtime fingerprint changes', () => {
    const createRequestKey = vi.fn()
      .mockReturnValueOnce('recovery-key-1')
      .mockReturnValueOnce('recovery-key-2')
    const first = resolveCheckpointRecoveryTurnIdentity(null, {
      checkpointId: 'checkpoint-1',
      text: 'Continue.',
      permissionMode: 'research',
    }, createRequestKey)
    const changed = resolveCheckpointRecoveryTurnIdentity(first, {
      checkpointId: 'checkpoint-2',
      text: 'Continue.',
      permissionMode: 'full',
    }, createRequestKey)

    expect(changed.requestKey).toBe('recovery-key-2')
    expect(changed.fingerprint).not.toBe(first.fingerprint)
    expect(createRequestKey).toHaveBeenCalledTimes(2)
  })
})
