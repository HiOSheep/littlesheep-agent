// Opt-in startup diagnostics shared by the Electron composition root.
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
