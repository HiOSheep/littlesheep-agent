// Opt-in startup diagnostics shared by the Electron composition root.
//
// Emitted only when `LITTLESHEEP_BOOTSTRAP_TIMING=1`. Every entry is a stage
// name plus millisecond facts: no user text, no file contents, no secrets.
//
// `processUptimeMs` is the cold-start anchor. Node's uptime is monotonic and
// starts at OS process creation, so it covers module loading that happens
// before the first business log. Callers must not substitute wall-clock
// arithmetic against `process.getCreationTime()`: Electron reports a different
// epoch there, which silently inflates every delta.
import { performance } from 'node:perf_hooks'

const enabled = process.env['LITTLESHEEP_BOOTSTRAP_TIMING'] === '1'

export interface BootstrapTimingOptions {
  /**
   * Externally measured duration, used for renderer-reported marks whose clock
   * reference is inside the renderer and cannot be compared with main's.
   */
  durationMs?: number
}

export function recordBootstrapTiming(
  stage: string,
  startedAt?: number,
  options: BootstrapTimingOptions = {},
): number {
  const now = performance.now()
  if (enabled) {
    const durationMs = options.durationMs ?? (startedAt === undefined ? undefined : now - startedAt)
    console.log(`[bootstrap-timing] ${JSON.stringify({
      stage,
      processUptimeMs: Math.round(process.uptime() * 1_000 * 10) / 10,
      ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs * 10) / 10 }),
    })}`)
  }
  return now
}
