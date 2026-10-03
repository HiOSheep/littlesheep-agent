// The void ring's motion model: what the eclipse is doing, frame by frame.
//
// Pure and DOM-free so it can be stepped in tests. The renderer turns its output into shader
// uniforms; the companion reads `press` / `lean` for the button body. Every ambient term is scaled
// by `awake`, which starts at 0, so the first frame after (re)starting is exactly the still mark —
// swapping the PNG for the live canvas is therefore invisible (the flash reported 2026-10-03).

export type VoidRingMode = 'idle' | 'loading' | 'thinking' | 'rest'

export interface VoidRingPointer {
  /** Unit direction from the disc centre to the pointer, in screen space (y down). */
  dx: number
  dy: number
  /** 0 when far away, 1 when on top of the ring. */
  near: number
}

export interface VoidRingMotionInput {
  mode: VoidRingMode
  pointer: VoidRingPointer | null
  pressed: boolean
  /** Keyboard focus or similar non-directional attention, 0..1. */
  attention: number
}

export interface VoidRingFrame {
  time: number
  rot: number
  breath: number
  flow: number
  energy: number
  flare: number
  /** Shockwave progress 0..1; -1 when no wave is travelling. */
  wave: number
  orbit: number
  orbitAngle: number
  think: number
  focusX: number
  focusY: number
  grain: number
  /** Body transform for the interactive companion. */
  press: number
  leanX: number
  leanY: number
}

/** Direction the mark's corona naturally leans (screen space, radians): toward the right. */
export const CORONA_ANGLE = -0.12

/** Disc centre and radius in mark UV space (0..1, y down), measured from mark.png. */
export const DISC = { x: 0.4658, y: 0.5156, r: 0.2979 }

/** Where the pointer is relative to the disc of a ring drawn in `rect`. */
export function pointerRelativeToDisc(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): VoidRingPointer {
  const dx = x - (rect.left + DISC.x * rect.width)
  const dy = y - (rect.top + DISC.y * rect.height)
  const distance = Math.hypot(dx, dy)
  const reach = rect.width
  // Fully attentive within the disc, still curious up to about two ring-widths away.
  const near = clamp(1 - (distance - reach * 0.3) / (reach * 1.9), 0, 1)
  return distance < 1e-3 ? { dx: 0, dy: 0, near } : { dx: dx / distance, dy: dy / distance, near }
}

const TAU = Math.PI * 2

export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle))
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
/** Frame-rate independent approach toward a target. */
const approach = (value: number, target: number, rate: number, dt: number) => value + (target - value) * (1 - Math.exp(-rate * dt))
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
/** 0..1 raised cosine, starting at 0. */
const swell = (t: number, period: number) => 0.5 - 0.5 * Math.cos((TAU * t) / period)

export interface VoidRingMotion {
  step(dt: number, input: VoidRingMotionInput): VoidRingFrame
  greet(): void
  /** True once a 'rest' ring has nothing left to show beyond the still mark. */
  settled(): boolean
  /** Back to the still mark, as if freshly mounted in `mode`. */
  reset(mode?: VoidRingMode): void
}

export function createVoidRingMotion(initialMode: VoidRingMode = 'idle', random: () => number = Math.random): VoidRingMotion {
  let time = 0
  let weights = { idle: 0, loading: 0, thinking: 0 }
  let orbitPhase = 0
  let rot = 0
  let focusX = 0
  let focusY = 0
  let near = 0
  let attention = 0
  let flare = 0
  let wave = -1
  let spin = -1
  let pressValue = 1
  let pressVelocity = 0
  let leanX = 0
  let leanY = 0
  let glance = 0
  let glanceTarget = 0
  let glanceUntil = 0
  let nextGlance = 0
  let greetTimes: number[] = []
  let last: VoidRingFrame | null = null

  function reset(mode: VoidRingMode = initialMode) {
    time = 0
    weights = { idle: mode === 'idle' ? 1 : 0, loading: mode === 'loading' ? 1 : 0, thinking: mode === 'thinking' ? 1 : 0 }
    orbitPhase = -Math.PI / 2
    rot = focusX = focusY = near = attention = flare = glance = glanceTarget = leanX = leanY = pressVelocity = 0
    pressValue = 1
    wave = spin = -1
    glanceUntil = 0
    nextGlance = 6 + random() * 5
    greetTimes = []
    last = null
  }
  reset()

  function step(rawDt: number, input: VoidRingMotionInput): VoidRingFrame {
    // A stalled tab can hand us a huge delta; motion should resume, not jump.
    const dt = clamp(rawDt, 0, 1 / 15)
    time += dt
    const awake = smoothstep(0, 0.9, time)

    for (const key of ['idle', 'loading', 'thinking'] as const) {
      weights[key] = approach(weights[key], input.mode === key ? 1 : 0, 3.2, dt)
    }
    const total = weights.idle + weights.loading + weights.thinking
    const blend = (idle: number, loading: number, thinking: number) =>
      total < 1e-4 ? 0 : (weights.idle * idle + weights.loading * loading + weights.thinking * thinking) / total
    const presence = clamp(total, 0, 1) * awake

    // The comet surges a little rather than circling at a metronome's pace.
    orbitPhase += dt * (TAU / 1.6) * (1 + 0.28 * Math.sin(time * 2.3))

    // Idle curiosity: now and then the light glances somewhere, then comes back.
    if (time >= nextGlance) {
      glanceTarget = (random() - 0.5) * 0.9
      glanceUntil = time + 1.4 + random() * 0.8
      nextGlance = time + 7 + random() * 5
    }
    if (time >= glanceUntil) glanceTarget = 0
    glance = approach(glance, glanceTarget, 2.4, dt)

    const pulse = Math.pow(swell(time, 1.7), 1.5)
    const ambientRot = blend(
      0.09 * Math.sin(time * 0.31) + 0.05 * Math.sin(time * 0.83 + 1) + glance,
      0.32 * Math.sin(orbitPhase - CORONA_ANGLE),
      0.2 * Math.sin(time * 0.9),
    ) * presence

    near = approach(near, input.pointer?.near ?? 0, 5, dt)
    attention = approach(attention, Math.max(input.attention, input.pointer?.near ?? 0), 4, dt)
    let pointerRot = 0
    if (input.pointer && input.pointer.near > 0) {
      const toward = Math.atan2(input.pointer.dy, input.pointer.dx)
      pointerRot = clamp(wrapAngle(toward - CORONA_ANGLE), -1.1, 1.1) * 0.6 * input.pointer.near
    }
    rot += wrapAngle(ambientRot * (1 - 0.6 * near) + pointerRot - rot) * (1 - Math.exp(-6 * dt))
    focusX = approach(focusX, (input.pointer?.dx ?? 0) * (input.pointer?.near ?? 0) * 0.9, 8, dt)
    focusY = approach(focusY, (input.pointer?.dy ?? 0) * (input.pointer?.near ?? 0) * 0.9, 8, dt)

    flare *= Math.exp(-3 * dt)
    if (flare < 1e-3) flare = 0
    if (wave >= 0) wave = wave + dt / 1.15 >= 1 ? -1 : wave + dt / 1.15
    let spinAngle = 0
    if (spin >= 0) {
      spin += dt / 1.25
      if (spin >= 1) spin = -1
      else spinAngle = TAU * easeInOutCubic(spin)
    }

    // Press squashes, release springs back past rest once.
    const pressTarget = input.pressed ? 0.93 : 1
    pressVelocity += ((pressTarget - pressValue) * 340 - pressVelocity * 15) * dt
    pressValue += pressVelocity * dt
    leanX = approach(leanX, (input.pointer?.dx ?? 0) * (input.pointer?.near ?? 0) * 3, 7, dt)
    leanY = approach(leanY, (input.pointer?.dy ?? 0) * (input.pointer?.near ?? 0) * 3, 7, dt)

    const pressed = 1 - pressValue
    last = {
      time,
      rot: rot + spinAngle,
      breath: blend(
        0.035 * swell(time, 5.4) + 0.008 * Math.sin(time * 1.7),
        0.025 * swell(time, 1.6),
        0.05 * pulse,
      ) * presence + 0.03 * attention + 0.08 * flare - 0.4 * pressed,
      flow: blend(0.28, 0.45, 0.75) * presence + 0.6 * flare,
      energy: blend(0.05 * Math.sin((TAU * time) / 5.4), 0.08, 0.12 + 0.18 * pulse) * presence + 0.12 * attention,
      flare,
      wave,
      orbit: (weights.loading / Math.max(1, total)) * presence,
      orbitAngle: orbitPhase,
      think: (weights.thinking / Math.max(1, total)) * presence,
      focusX,
      focusY,
      grain: (0.25 + 0.25 * weights.thinking) * presence,
      press: pressValue,
      leanX,
      leanY,
    }
    return last
  }

  function greet() {
    flare = Math.min(1.5, flare + 1)
    wave = 0
    greetTimes = [...greetTimes.filter(at => time - at < 1.6), time]
    // Four quick greetings and it does a little lap.
    if (greetTimes.length >= 4 && spin < 0) {
      spin = 0
      greetTimes = []
    }
  }

  function settled() {
    if (!last) return true
    const quiet = [last.breath, last.flow, last.energy, last.flare, last.orbit, last.think, last.focusX, last.focusY, last.grain]
    return wave < 0 && spin < 0 && Math.abs(wrapAngle(last.rot)) < 2e-3 && Math.abs(last.press - 1) < 2e-3
      && quiet.every(value => Math.abs(value) < 2e-3)
  }

  return { step, greet, settled, reset }
}
