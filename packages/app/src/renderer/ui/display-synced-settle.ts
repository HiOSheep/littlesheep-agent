// Time-bounded settling for renderer layout repairs.
//
// requestAnimationFrame is intentionally the only clock used by callers. In
// a normal Electron window Chromium schedules it from the active display's
// compositor VSync, so the active display's 60/120/144/240 Hz refresh rate is
// the effective FPS ceiling. Callers stop requesting frames after settling;
// there is no independent unbounded render loop while the UI is unchanged.

export const DISPLAY_SETTLE_IDLE_MS = 96
export const DISPLAY_SETTLE_MAX_MS = 1000
export const DISPLAY_SETTLE_MIN_FRAMES = 2

export interface DisplaySettleState {
  startedAt: number
  lastLayoutChangeAt: number
  frameCount: number
  layoutSignature: string
}

export function createDisplaySettleState(timestamp: number, layoutSignature = ''): DisplaySettleState {
  return {
    startedAt: timestamp,
    lastLayoutChangeAt: timestamp,
    frameCount: 0,
    layoutSignature,
  }
}

export function observeDisplaySettleFrame(
  state: DisplaySettleState,
  timestamp: number,
  layoutSignature: string,
): DisplaySettleState {
  return {
    ...state,
    lastLayoutChangeAt: layoutSignature === state.layoutSignature
      ? state.lastLayoutChangeAt
      : timestamp,
    frameCount: state.frameCount + 1,
    layoutSignature,
  }
}

export function shouldContinueDisplaySettle(
  state: DisplaySettleState,
  timestamp: number,
): boolean {
  const elapsed = Math.max(0, timestamp - state.startedAt)
  if (elapsed >= DISPLAY_SETTLE_MAX_MS) return false
  if (state.frameCount < DISPLAY_SETTLE_MIN_FRAMES) return true
  return timestamp - state.lastLayoutChangeAt < DISPLAY_SETTLE_IDLE_MS
}
