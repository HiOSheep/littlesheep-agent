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

export function recordBootstrapTiming(stage: string, startedAt?: number): number {
  const now = performance.now()
  if (enabled) {
    console.log(`[bootstrap-timing] ${JSON.stringify({
      stage,
      processUptimeMs: Math.round(process.uptime() * 1_000 * 10) / 10,
      ...(startedAt === undefined ? {} : { durationMs: Math.round((now - startedAt) * 10) / 10 }),
    })}`)
  }
  return now
}
