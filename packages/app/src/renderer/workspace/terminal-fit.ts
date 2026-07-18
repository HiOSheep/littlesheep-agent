// Coalesces terminal fit requests and ignores ResizeObserver notifications
// whose effective host dimensions did not change.
import { createWindowDisplayFrameGate, type DisplayFrameGate } from '../ui/display-frame'

export interface TerminalHostSize {
  width: number
  height: number
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
        && size.width === observedSize.width
        && size.height === observedSize.height) return
      observedSize = size
      frame.request(() => fit())
    },
    cancel(): void {
      frame.cancel()
    },
  }
}
