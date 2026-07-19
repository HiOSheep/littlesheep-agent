// Coalesces terminal fit requests and ignores observer notifications whose
// effective physical-pixel geometry did not change.
import { createWindowDisplayFrameGate, type DisplayFrameGate } from '../ui/display-frame'

export interface TerminalHostSize {
  width: number
  height: number
  devicePixelRatio: number
}

function normalizedPixelRatio(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.round(value * 1_000) / 1_000
}

function physicalPixels(cssPixels: number, devicePixelRatio: number): number {
  return Math.round(cssPixels * normalizedPixelRatio(devicePixelRatio))
}

function hasSameRenderedGeometry(left: TerminalHostSize, right: TerminalHostSize): boolean {
  const leftRatio = normalizedPixelRatio(left.devicePixelRatio)
  const rightRatio = normalizedPixelRatio(right.devicePixelRatio)
  return leftRatio === rightRatio
    && physicalPixels(left.width, leftRatio) === physicalPixels(right.width, rightRatio)
    && physicalPixels(left.height, leftRatio) === physicalPixels(right.height, rightRatio)
}

export function createTerminalFitScheduler(
  readSize: () => TerminalHostSize | null,
  fit: () => void,
  frame: DisplayFrameGate = createWindowDisplayFrameGate(),
) {
  let observedSize: TerminalHostSize | null = null

  return {
    schedule(force = false): void {
      const size = readSize()
      if (!force && size && observedSize
        && hasSameRenderedGeometry(size, observedSize)) return
      observedSize = size
      frame.request(() => fit())
    },
    cancel(): void {
      frame.cancel()
    },
  }
}
