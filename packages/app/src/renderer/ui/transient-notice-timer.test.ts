// The rules a self-clearing confirmation must obey, tested with a controlled clock.
//
// These are the failures that motivated each rule, so each test names the behaviour a
// user would notice rather than the implementation:
//   - a confirmation that never clears leaves a stale "已保存" on screen;
//   - a confirmation cleared by an older deadline disappears almost immediately;
//   - a repeat that does not restart the window leaves the second press unacknowledged;
//   - a timer that outlives its owner fires into the next message, or into nothing.
//
// The timer is a plain object with an injected clock, because this repository's vitest
// runs in a node environment with no DOM testing library to mount a React hook in.

import { describe, expect, it } from 'vitest'
import { createTransientTimer, type TimerHost } from './transient-notice-timer'

/** A clock that only moves when a test says so. */
function fakeClock(options: { cancelIsReliable?: boolean } = {}) {
  const cancelIsReliable = options.cancelIsReliable ?? true
  let now = 0
  let nextHandle = 1
  const pending = new Map<number, { at: number; callback: () => void }>()

  const host: TimerHost<string> = {
    durationMs: 3_000,
    schedule: (callback, ms) => {
      const handle = nextHandle++
      pending.set(handle, { at: now + ms, callback })
      return handle
    },
    // A host whose cancel does not stop the callback is the case the sequence guard
    // exists for, so the tests can model it rather than assuming cancellation works.
    cancel: (handle) => { if (cancelIsReliable) pending.delete(handle) },
    publish: () => {},
  }

  return {
    host,
    /** Advance the clock, firing every deadline that comes due, in order. */
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        const [handle, entry] = due
        pending.delete(handle)
        now = entry.at
        entry.callback()
      }
      now = target
    },
    /** Deadlines still waiting, so a cancelled timer can be observed. */
    pendingCount: () => pending.size,
  }
}

describe('transient notice timer', () => {
  it('publishes immediately and clears at the deadline', () => {
    const clock = fakeClock()
    const seen: Array<string | null> = []
    const timer = createTransientTimer<string>({ ...clock.host, publish: (v) => seen.push(v) })

    timer.show('已保存供应商 "opencode"。')
    expect(seen).toEqual(['已保存供应商 "opencode"。'])

    clock.advance(2_999)
    expect(seen).toHaveLength(1)
    clock.advance(1)
    expect(seen).toEqual(['已保存供应商 "opencode"。', null])
  })

  it('restarts the deadline when the same message is shown again', () => {
    // Pressing save twice must acknowledge the second press. If the repeat were
    // ignored, the confirmation from the first press would expire while the second one
    // went unconfirmed.
    const clock = fakeClock()
    const seen: Array<string | null> = []
    const timer = createTransientTimer<string>({ ...clock.host, publish: (v) => seen.push(v) })

    timer.show('已保存。')
    clock.advance(2_000)
    timer.show('已保存。')
    clock.advance(2_000)
    expect(seen.filter((v) => v === null)).toHaveLength(0)
    clock.advance(1_000)
    expect(seen.at(-1)).toBeNull()
  })

  it('does not let an older deadline clear a newer message', () => {
    // The message shown at t=0 has a deadline at t=3000. A new message at t=2900 must
    // survive it, or the user sees the newer confirmation blink away after 100ms.
    //
    // `cancelIsReliable: false` models the hazard the sequence guard defends against: a
    // timer whose cancellation does not take effect still fires its callback, and only
    // the sequence check stops it from clearing a message it does not own. With a
    // reliable cancel this scenario cannot arise, so asserting it there would have
    // proved nothing — an earlier version of this test passed with the guard removed.
    const clock = fakeClock({ cancelIsReliable: false })
    const seen: Array<string | null> = []
    const timer = createTransientTimer<string>({ ...clock.host, publish: (v) => seen.push(v) })

    timer.show('第一条。')
    clock.advance(2_900)
    timer.show('第二条。')
    clock.advance(200)
    expect(seen.at(-1)).toBe('第二条。')
    expect(seen.filter((v) => v === null)).toHaveLength(0)
  })

  it('cancels the pending deadline on an explicit clear', () => {
    const clock = fakeClock()
    const seen: Array<string | null> = []
    const timer = createTransientTimer<string>({ ...clock.host, publish: (v) => seen.push(v) })

    timer.show('已删除供应商 "opencode"。')
    timer.clear()
    expect(seen.at(-1)).toBeNull()
    expect(clock.pendingCount()).toBe(0)
  })

  it('does not let a cancelled deadline clear the next message', () => {
    const clock = fakeClock()
    const seen: Array<string | null> = []
    const timer = createTransientTimer<string>({ ...clock.host, publish: (v) => seen.push(v) })

    timer.show('第一条。')
    timer.clear()
    timer.show('第二条。')
    clock.advance(2_999)
    expect(seen.at(-1)).toBe('第二条。')
  })

  it('cancels without publishing when disposed', () => {
    // Unmount must not publish: the component that owns the state is gone, and React
    // would warn about setting state on an unmounted tree.
    const clock = fakeClock()
    const seen: Array<string | null> = []
    const timer = createTransientTimer<string>({ ...clock.host, publish: (v) => seen.push(v) })

    timer.show('已保存。')
    const countBefore = seen.length
    timer.dispose()
    clock.advance(10_000)
    expect(seen).toHaveLength(countBefore)
    expect(clock.pendingCount()).toBe(0)
  })
})
