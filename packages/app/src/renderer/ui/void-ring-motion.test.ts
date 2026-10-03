import { describe, expect, it } from 'vitest'
import { createVoidRingMotion, pointerRelativeToDisc, type VoidRingMotionInput } from './void-ring-motion'

const idle: VoidRingMotionInput = { mode: 'idle', pointer: null, pressed: false, attention: 0 }
const seeded = () => {
  let seed = 7
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647
}
const run = (motion: ReturnType<typeof createVoidRingMotion>, seconds: number, input: VoidRingMotionInput = idle) => {
  let frame = motion.step(0, input)
  for (let t = 0; t < seconds; t += 1 / 60) frame = motion.step(1 / 60, input)
  return frame
}

describe('void ring motion', () => {
  it('starts as exactly the still mark, so going live never flashes', () => {
    for (const mode of ['idle', 'loading', 'thinking', 'rest'] as const) {
      const frame = createVoidRingMotion(mode, seeded()).step(0, { ...idle, mode })
      expect([frame.rot, frame.breath, frame.flow, frame.energy, frame.flare, frame.orbit, frame.think, frame.grain]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
      expect(frame.wave).toBe(-1)
      expect(frame.press).toBe(1)
    }
  })

  it('is alive while idle and visibly different when loading or thinking', () => {
    const a = run(createVoidRingMotion('idle', seeded()), 2)
    const b = run(createVoidRingMotion('idle', seeded()), 3.3)
    expect(Math.abs(a.breath - b.breath) + Math.abs(a.rot - b.rot)).toBeGreaterThan(0.005)
    expect(a.orbit).toBe(0)
    expect(run(createVoidRingMotion('loading', seeded()), 2, { ...idle, mode: 'loading' }).orbit).toBeGreaterThan(0.9)
    expect(run(createVoidRingMotion('thinking', seeded()), 2, { ...idle, mode: 'thinking' }).think).toBeGreaterThan(0.9)
  })

  it('blends between states instead of cutting', () => {
    const motion = createVoidRingMotion('loading', seeded())
    run(motion, 2, { ...idle, mode: 'loading' })
    const next = motion.step(1 / 60, { ...idle, mode: 'thinking' })
    expect(next.orbit).toBeGreaterThan(0.8)
    expect(run(motion, 3, { ...idle, mode: 'thinking' }).orbit).toBeLessThan(0.01)
  })

  it('turns its light toward the pointer and lets go when it leaves', () => {
    const motion = createVoidRingMotion('idle', seeded())
    const left = run(motion, 1.5, { ...idle, pointer: { dx: -1, dy: 0, near: 1 } })
    expect(Math.abs(left.rot)).toBeGreaterThan(0.4)
    expect(left.focusX).toBeLessThan(-0.6)
    const away = run(motion, 2, idle)
    expect(Math.abs(away.focusX)).toBeLessThan(0.05)
  })

  it('squashes under a press and springs back past rest', () => {
    const motion = createVoidRingMotion('idle', seeded())
    const held = run(motion, 0.4, { ...idle, pressed: true })
    expect(held.press).toBeLessThan(0.95)
    let peak = 0
    for (let i = 0; i < 40; i++) peak = Math.max(peak, motion.step(1 / 60, idle).press)
    expect(peak).toBeGreaterThan(1)
    expect(run(motion, 1).press).toBeCloseTo(1, 2)
  })

  it('answers a greeting with a flare and a travelling wave, and a lap after four', () => {
    const motion = createVoidRingMotion('idle', seeded())
    run(motion, 1)
    motion.greet()
    const greeted = motion.step(1 / 60, idle)
    expect(greeted.flare).toBeGreaterThan(0.9)
    expect(greeted.wave).toBeGreaterThanOrEqual(0)
    expect(run(motion, 1.3).wave).toBe(-1)
    for (let i = 0; i < 4; i++) { motion.greet(); motion.step(0.1, idle) }
    const turns: number[] = []
    for (let i = 0; i < 40; i++) turns.push(motion.step(1 / 60, idle).rot)
    expect(Math.max(...turns) - Math.min(...turns)).toBeGreaterThan(1)
  })

  it('settles completely when resting, so the loop can stop', () => {
    const motion = createVoidRingMotion('idle', seeded())
    run(motion, 2)
    expect(motion.settled()).toBe(false)
    run(motion, 6, { ...idle, mode: 'rest' })
    expect(motion.settled()).toBe(true)
  })

  it('ignores a stalled frame instead of jumping', () => {
    const motion = createVoidRingMotion('loading', seeded())
    const before = motion.step(1 / 60, { ...idle, mode: 'loading' })
    const after = motion.step(30, { ...idle, mode: 'loading' })
    expect(after.time - before.time).toBeLessThanOrEqual(1 / 15 + 1e-9)
  })
})

describe('pointer relative to the disc', () => {
  const rect = { left: 100, top: 100, width: 112, height: 112 }
  it('points from the disc centre and fades with distance', () => {
    const right = pointerRelativeToDisc(rect, 400, 100 + 0.5156 * 112)
    expect(right.dx).toBeCloseTo(1)
    expect(right.dy).toBeCloseTo(0)
    expect(right.near).toBe(0)
    const close = pointerRelativeToDisc(rect, 100 + 0.4658 * 112, 145)
    expect(close.dy).toBeCloseTo(-1)
    expect(close.near).toBe(1)
  })
})
