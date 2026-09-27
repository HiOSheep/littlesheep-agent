// Runner build, rebuild and retirement.
//
// Split out of `main/index.ts`, which had grown past its controlled ceiling and
// whose own recorded plan was "move the Local App API options object and the
// Runner construction into their own module first". This module owns the Runner's
// lifetime: one build at a time, the published Runner plus its plugin host, and
// the delayed shutdown of the Runner a rebuild replaced.
//
// Why it is a queue and not a mutex: a cold start used to build the Runner twice
// concurrently when configuration was saved while the startup build was still
// running - two bootstrap commits, two attachment-protection passes and a
// `Git command aborted` from the second one, on the same data root. The rebuild
// path had a mutex, but the startup build was not in it, so the mutex could not
// see the build it was racing. Both paths enqueue here now.
//
// A queued rebuild compares the configuration the published Runner was built from
// with the current one first. When they agree it does nothing, so "configuration
// saved while the startup build was running" collapses to the single build that
// is already in flight instead of a second one.
import type { BrandingConfig } from '@littlesheep/branding'
import type { Config } from '@littlesheep/config'
import type { PluginHost } from '@littlesheep/plugins'
import type { AgentRunner } from '@littlesheep/runner'
import type { LocalAppApiServer } from './local-app-api-server.js'
import type { RunActivityMonitor } from './run-activity-monitor.js'
import { recordBootstrapTiming } from './bootstrap-timing.js'

/** How often a retired Runner is asked whether its last in-flight run finished. */
const RETIRED_RUNNER_POLL_MS = 1_000
/** How many replaced Runners may still own active tasks before a rebuild is refused. */
const MAX_RETIRED_RUNNERS = 4

export interface RunnerBuildInput {
  config: Config
  branding: BrandingConfig
  model: string
  /** Data root the Runner reads and writes; also the durable-effect read boundary. */
  dataDir: string
  /** Where the tokenizer and other bootstrap assets live; usually the same root. */
  bootstrapDir: string
}

export interface RunnerLifecycleOptions {
  activity: RunActivityMonitor
  /** Constructs a Runner. Injected so this module owns no Electron import. */
  createRunner: (input: RunnerBuildInput) => Promise<AgentRunner>
  server: () => LocalAppApiServer | null
  pluginHost: () => PluginHost | null
  /** The accepted configuration the next build must describe. */
  config: () => Config | null
  branding: () => BrandingConfig | null
  /**
   * Re-normalizes a configuration revision and returns the effective pair.
   * Called once per replacement build, before that build starts.
   */
  prepareConfig: (config: Config) => { config: Config; model: string }
  /**
   * Publishes the normalized configuration into the composition root's slot.
   */
  applyConfig: (config: Config) => void
  /** Data/boot roots a replacement build must use; read at build time. */
  roots: () => { dataDir: string; bootstrapDir: string }
  /** Marks the deferred recovery pass of a freshly published Runner, when it ends. */
  onRunnerPublished?: (runner: AgentRunner) => void
  log?: (message: string, error?: unknown) => void
}

export class RunnerLifecycle {
  private runner: AgentRunner | null = null
  private readonly retiredRunners = new Map<AgentRunner, NodeJS.Timeout>()
  private buildTail: Promise<void> = Promise.resolve()
  private lastBuiltConfig: Config | null = null

  constructor(private readonly options: RunnerLifecycleOptions) {}

  /** The published Runner, or null before the first build succeeded. */
  current(): AgentRunner | null {
    return this.runner
  }

  retiredCount(): number {
    return this.retiredRunners.size
  }

  /** Every Runner that can still own an active run: current first, then retired. */
  activitySources(): AgentRunner[] {
    return this.runner ? [this.runner, ...this.retiredRunners.keys()] : [...this.retiredRunners.keys()]
  }

  publishActivitySources(): void {
    this.options.activity.setRunners(this.activitySources())
  }

  /** Build and publish the first Runner. */
  async start(input: RunnerBuildInput): Promise<AgentRunner> {
    // The capture is what the build actually describes; the composition root may
    // replace its configuration object while the build is still running.
    const captured = this.options.config()
    const created = await this.enqueue(() => this.options.createRunner(input))
    this.runner = created
    this.lastBuiltConfig = captured
    this.options.activity.setRunners([created])
    return created
  }

  /**
   * Replace the Runner because the accepted configuration changed.
   *
   * A rebuild can arrive while the first build is still running - that is exactly
   * the measured double build - and at that moment there is nothing published to
   * replace. So the queue is awaited first and the decision is taken after it:
   * when the build that just finished already describes the current
   * configuration, this call is satisfied without building anything.
   */
  async rebuild(): Promise<AgentRunner> {
    const pending = this.buildTail
    await pending
    return this.enqueue(async () => {
      const published = this.runner
      if (!published) return this.requireRunner()
      const config = this.options.config()
      if (!config || !this.options.branding() || !this.options.server()) return published
      if (this.lastBuiltConfig !== null && config === this.lastBuiltConfig) return published
      return this.buildReplacement()
    })
  }

  /**
   * Replace the published Runner only if its configuration is out of date.
   *
   * Called after a build: a configuration written into the composition root's slot
   * while that build was running has not been seen by any Runner yet.
   */
  async rebuildIfConfigChanged(): Promise<void> {
    if (this.lastBuiltConfig === null) return
    if (this.options.config() === this.lastBuiltConfig) return
    await this.rebuild()
  }

  /** Stop every timer and shut every Runner down; used at application exit. */
  async shutdown(): Promise<void> {
    const entries = [...this.retiredRunners.entries()]
    this.retiredRunners.clear()
    for (const [, timer] of entries) clearTimeout(timer)
    await Promise.all([
      ...[...entries].map(([retired]) => retired.shutdown().catch(() => undefined)),
      ...(this.runner ? [this.runner.shutdown().catch(() => undefined)] : []),
    ])
    this.publishActivitySources()
  }

  /**
   * Run one build at a time.
   *
   * The queue is what makes a start impossible to double: a rebuild requested
   * while a build is running waits for its turn and then decides whether it still
   * has anything to do, instead of starting a second build beside it.
   */
  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.buildTail.then(operation)
    this.buildTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async buildReplacement(): Promise<AgentRunner> {
    const config = this.options.config()
    const branding = this.options.branding()
    const server = this.options.server()
    if (!config || !branding || !server) return this.requireRunner()
    await this.releaseIdleRetiredRunners()
    if (this.retiredRunners.size >= MAX_RETIRED_RUNNERS) {
      throw new Error(`cannot replace runtime while ${this.retiredRunners.size} previous runtime(s) still own active tasks`)
    }
    const oldRunner = this.runner
    const runtime = this.options.prepareConfig(config)
    this.options.applyConfig(runtime.config)
    const roots = this.options.roots()
    // Captured before the build: a further save during it must leave this build
    // describing the revision it was actually created from, so the next queued
    // rebuild can tell that it is still needed.
    const captured = runtime.config
    const published = await this.options.createRunner({
      config: runtime.config,
      branding,
      model: runtime.model,
      dataDir: roots.dataDir || roots.bootstrapDir,
      bootstrapDir: roots.bootstrapDir || roots.dataDir,
    })
    this.lastBuiltConfig = captured
    // Publish before retiring: the API server owns the run router, and awaiting
    // its publication keeps the previous router from outliving its Runner.
    this.runner = published
    await server.setRunner(published)
    this.options.onRunnerPublished?.(published)
    server.setConfig(runtime.config)
    const host = this.options.pluginHost()
    if (host) {
      await host.setRunner(published)
      host.setConfig(runtime.config)
    }
    if (oldRunner) this.retire(oldRunner)
    recordBootstrapTiming('runner-rebuilt')
    this.publishActivitySources()
    return published
  }

  private retire(retiredRunner: AgentRunner): void {
    const timer = setTimeout(() => this.inspectRetired(retiredRunner), RETIRED_RUNNER_POLL_MS)
    timer.unref?.()
    this.retiredRunners.set(retiredRunner, timer)
    this.publishActivitySources()
  }

  private inspectRetired(retiredRunner: AgentRunner): void {
    if (!this.retiredRunners.has(retiredRunner)) return
    if ((retiredRunner.activeRuns?.list().length ?? 0) > 0) {
      const timer = setTimeout(() => this.inspectRetired(retiredRunner), RETIRED_RUNNER_POLL_MS)
      timer.unref?.()
      this.retiredRunners.set(retiredRunner, timer)
      return
    }
    this.retiredRunners.delete(retiredRunner)
    this.publishActivitySources()
    void retiredRunner.shutdown().catch((error: unknown) => {
      this.options.log?.('retired runner shutdown failed', error)
    })
  }

  private async releaseIdleRetiredRunners(): Promise<void> {
    const idle = [...this.retiredRunners.entries()]
      .filter(([retired]) => (retired.activeRuns?.list().length ?? 0) === 0)
    for (const [, timer] of idle) clearTimeout(timer)
    for (const [retired] of idle) this.retiredRunners.delete(retired)
    if (idle.length > 0) {
      this.publishActivitySources()
      await Promise.all(idle.map(([retired]) => retired.shutdown().catch(() => undefined)))
    }
  }

  private requireRunner(): AgentRunner {
    if (!this.runner) throw new Error('cannot rebuild the runtime before a Runner exists')
    return this.runner
  }
}
