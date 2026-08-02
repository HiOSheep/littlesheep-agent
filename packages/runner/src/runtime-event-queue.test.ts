import { describe, expect, it } from 'vitest'
import { asSessionId } from '@littlesheep/types'
import {
  RuntimeEventQueue,
  RuntimeEventQueueBusyError,
} from './runtime-event-queue.js'

function clock(start = '2026-07-18T10:00:00.000Z') {
  let value = Date.parse(start)
  return {
    now: () => new Date(value),
    advance: (milliseconds: number) => { value += milliseconds },
  }
}

function queue(options: Record<string, unknown> = {}) {
  const time = clock()
  const instance = new RuntimeEventQueue({
    runId: 'run-1',
    sessionId: asSessionId('session-1'),
    now: time.now,
    maxEventAgeMs: null,
    ...options,
  })
  return { instance, time }
}

describe('RuntimeEventQueue', () => {
  it('isolates run/session ownership and assigns monotonic sequences', () => {
    const { instance } = queue()
    const first = instance.append({
      type: 'user_message',
      source: 'app',
      payload: { text: 'first' },
    })
    expect(first.kind).toBe('accepted')
    if (first.kind !== 'accepted') return
    expect(first.event.sequence).toBe(1)
    expect(instance.append({
      runId: 'other-run',
      type: 'user_message',
      source: 'app',
      payload: { text: 'wrong run' },
    })).toMatchObject({ kind: 'rejected', reason: 'run-mismatch' })
    expect(instance.append({
      sessionId: asSessionId('other-session'),
      type: 'user_message',
      source: 'app',
      payload: { text: 'wrong session' },
    })).toMatchObject({ kind: 'rejected', reason: 'session-mismatch' })
  })

  it('deduplicates identical ids/keys and rejects conflicting reuse', () => {
    const { instance } = queue()
    const first = instance.append({
      id: 'event-1',
      dedupKey: 'message:1',
      type: 'user_message',
      source: 'app',
      payload: { text: 'same' },
    })
    expect(instance.append({
      id: 'different-id',
      dedupKey: 'message:1',
      type: 'user_message',
      source: 'app',
      payload: { text: 'same' },
    })).toMatchObject({ kind: 'duplicate' })
    expect(instance.append({
      id: 'event-1',
      type: 'user_message',
      source: 'app',
      payload: { text: 'changed' },
    })).toMatchObject({ kind: 'rejected', reason: 'conflict', existingEventId: 'event-1' })
    expect(first.kind).toBe('accepted')
    expect(instance.summary().queued).toBe(1)
  })

  it('claims a single decision batch and settles it atomically', () => {
    const { instance } = queue()
    instance.append({ type: 'user_message', source: 'app', payload: { text: 'one' } })
    instance.append({ type: 'pause_requested', source: 'app', payload: { reason: 'pause' } })
    const batch = instance.openDecisionBatch()
    expect(batch?.events).toHaveLength(2)
    expect(() => instance.openDecisionBatch()).toThrow(RuntimeEventQueueBusyError)
    expect(batch).toBeDefined()
    if (!batch) return
    const settled = instance.settleDecisionBatch(batch.token, batch.events.map((event) => ({
      eventId: event.id,
      status: event.type === 'pause_requested' ? 'applied' : 'ignored',
      reason: 'boundary decision',
    })))
    expect(settled.map((event) => event.status)).toEqual(['ignored', 'applied'])
    expect(instance.summary()).toMatchObject({ cursor: 2, queued: 0, applied: 1, ignored: 1 })
  })

  it('claims control events without consuming unrelated task-changing events', () => {
    const { instance } = queue()
    instance.append({ type: 'user_message', source: 'app', payload: { text: 'keep queued' } })
    instance.append({ type: 'pause_requested', source: 'app', payload: { reason: 'pause' } })
    const batch = instance.openDecisionBatchForTypes([
      'pause_requested',
      'resume_requested',
      'interrupt_requested',
    ])
    expect(batch?.events.map((event) => event.type)).toEqual(['pause_requested'])
    if (!batch) return
    instance.settleDecisionBatch(batch.token, [{ eventId: batch.events[0]!.id, status: 'applied' }])
    expect(instance.pending()).toEqual([
      expect.objectContaining({ type: 'user_message', status: 'queued' }),
    ])
    expect(instance.summary()).toMatchObject({ cursor: 0, queued: 1, applied: 1 })
  })

  it('releases a failed decision batch without losing events', () => {
    const { instance } = queue()
    instance.append({ type: 'resume_requested', source: 'app', payload: {} })
    const batch = instance.openDecisionBatch()
    expect(batch).toBeDefined()
    if (!batch) return
    expect(instance.releaseDecisionBatch(batch.token)).toBe(true)
    expect(instance.pending()).toHaveLength(1)
    expect(instance.summary().cursor).toBe(0)
  })

  it('expires events and prevents applying one that expires during a decision', () => {
    const { instance, time } = queue({ maxEventAgeMs: 1_000 })
    const accepted = instance.append({ type: 'user_message', source: 'app', payload: { text: 'short lived' } })
    expect(accepted.kind).toBe('accepted')
    const batch = instance.openDecisionBatch()
    expect(batch).toBeDefined()
    if (!batch) return
    time.advance(1_001)
    const settled = instance.settleDecisionBatch(batch.token, [{
      eventId: batch.events[0]!.id,
      status: 'applied',
    }])
    expect(settled[0]?.status).toBe('expired')
    expect(instance.summary()).toMatchObject({ cursor: 1, expired: 1 })
  })

  it('bounds payloads and queue capacity, then reuses terminal space', () => {
    const { instance } = queue({ maxEvents: 2, maxPayloadBytes: 256 })
    instance.append({ type: 'user_message', source: 'app', payload: { text: 'one' } })
    instance.append({ type: 'user_message', source: 'app', payload: { text: 'two' } })
    expect(instance.append({ type: 'user_message', source: 'app', payload: { text: 'three' } })).toMatchObject({ kind: 'rejected', reason: 'capacity' })
    const batch = instance.openDecisionBatch()
    expect(batch).toBeDefined()
    if (!batch) return
    instance.settleDecisionBatch(batch.token, batch.events.map((event) => ({ eventId: event.id, status: 'ignored' })))
    expect(instance.append({ type: 'user_message', source: 'app', payload: { text: 'three' } }).kind).toBe('accepted')
    expect(instance.append({ type: 'user_message', source: 'app', payload: { text: 'x'.repeat(1_000) } })).toMatchObject({ kind: 'rejected', reason: 'payload-too-large' })
  })

  it('restores bounded state without restoring an in-flight lease and redacts context summaries', () => {
    const { instance } = queue()
    const accepted = instance.append({
      type: 'setting_changed',
      source: 'app',
      payload: { secret: 'do-not-inject', setting: 'reasoning' },
    })
    expect(accepted.kind).toBe('accepted')
    const batch = instance.openDecisionBatch()
    expect(batch).toBeDefined()
    const restored = RuntimeEventQueue.fromSnapshot(instance.snapshot(), {
      now: () => new Date('2026-07-18T10:00:00.000Z'),
      maxEventAgeMs: null,
    })
    expect(restored.summary().activeDecisionBatch).toBe(false)
    expect(restored.pending()).toHaveLength(1)
    expect(JSON.stringify(restored.contextSummary())).not.toContain('do-not-inject')
    expect(restored.snapshot().events[0]?.payload).toMatchObject({ secret: 'do-not-inject' })
    if (batch) expect(restored.snapshot().cursor).toBe(0)
  })

  it('restores persisted snapshots whose omitted optional event fields were encoded as null', () => {
    const { instance } = queue()
    instance.append({ type: 'pause_requested', source: 'system', payload: { reason: 'pause' } })
    const snapshot = structuredClone(instance.snapshot()) as unknown as {
      events: Array<Record<string, unknown>>
    }
    Object.assign(snapshot.events[0]!, {
      dedupKey: null,
      expiresAt: null,
      appliedAt: null,
      decisionReason: null,
    })

    const restored = RuntimeEventQueue.fromSnapshot(snapshot as never, { maxEventAgeMs: null })
    const event = restored.snapshot().events[0]!
    expect(event).not.toHaveProperty('dedupKey')
    expect(event).not.toHaveProperty('expiresAt')
    expect(event).not.toHaveProperty('appliedAt')
    expect(event).not.toHaveProperty('decisionReason')
    expect(event).toMatchObject({ type: 'pause_requested', status: 'queued' })
  })

  it('preserves a cursor after all terminal records have been pruned', () => {
    const { instance } = queue({ maxEvents: 1 })
    instance.append({ type: 'interrupt_requested', source: 'app', payload: {} })
    const batch = instance.openDecisionBatch()
    expect(batch).toBeDefined()
    if (!batch) return
    instance.settleDecisionBatch(batch.token, [{ eventId: batch.events[0]!.id, status: 'applied' }])
    expect(instance.snapshot().events).toHaveLength(0)
    expect(instance.snapshot().cursor).toBe(1)
    const restored = RuntimeEventQueue.fromSnapshot(instance.snapshot(), { maxEvents: 1, maxEventAgeMs: null })
    expect(restored.summary().cursor).toBe(1)
    expect(restored.append({ type: 'resume_requested', source: 'app', payload: {} })).toMatchObject({
      kind: 'accepted',
      event: { sequence: 2 },
    })
  })

  it('does not retain caller payload references', () => {
    const { instance } = queue()
    const payload = { nested: { value: 'before' } }
    const result = instance.append({ type: 'setting_changed', source: 'app', payload })
    payload.nested.value = 'after'
    expect(result.kind).toBe('accepted')
    expect(instance.snapshot().events[0]?.payload).toEqual({ nested: { value: 'before' } })
  })

  it('clears retained references on dispose', () => {
    const { instance } = queue()
    instance.append({ type: 'workspace_file_saved', source: 'workspace', payload: { path: 'a.txt' } })
    instance.dispose()
    expect(() => instance.summary()).toThrow('disposed')
  })
})
