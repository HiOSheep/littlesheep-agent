import type { Config } from '@littlesheep/config'
import { resolveNetworkReadPolicy, type AgentRunner } from '@littlesheep/runner'
import { isWebErrorKind, WebRetrievalRuntime } from '@littlesheep/web'
import type { RuntimeWebProviderCheck } from '../../shared/runtime-api-contracts.js'

type RunnerGetter = () => AgentRunner
type ConfigGetter = () => Config

/** Keeps the explicit, process-local Provider check separate from HTTP routing. */
export class WebProviderCheckCoordinator {
  private current: RuntimeWebProviderCheck | undefined
  private generation = 0
  private pending: { generation: number; promise: Promise<RuntimeWebProviderCheck> } | null = null

  constructor(
    private readonly getRunner: RunnerGetter,
    private readonly getConfig: ConfigGetter,
  ) {}

  get(): RuntimeWebProviderCheck | undefined {
    return this.current
  }

  invalidate(): void {
    this.generation += 1
    this.current = undefined
    this.pending = null
  }

  invalidateIfWebChanged(next: Config): void {
    if (JSON.stringify(next.web) !== JSON.stringify(this.getConfig().web)) this.invalidate()
  }

  routeBindings(): {
    getWebProviderCheck: () => RuntimeWebProviderCheck | undefined
    checkWebProvider: () => Promise<RuntimeWebProviderCheck>
  } {
    return { getWebProviderCheck: () => this.get(), checkWebProvider: () => this.check() }
  }

  check(): Promise<RuntimeWebProviderCheck> {
    if (this.pending?.generation === this.generation) return this.pending.promise
    const generation = this.generation
    const promise = runWebProviderCheck(this.getRunner(), this.getConfig()).then((check) => {
      if (generation === this.generation) {
        this.current = check
      }
      return check
    }).finally(() => {
      if (this.pending?.generation === generation && this.pending.promise === promise) {
        this.pending = null
      }
    })
    this.pending = { generation, promise }
    return promise
  }
}

/** Run one explicit, bounded provider search. Never runs during startup. */
export async function runWebProviderCheck(
  runner: AgentRunner,
  config: Config,
): Promise<RuntimeWebProviderCheck> {
  const providerId = config.web.defaultProvider ?? 'unknown'
  const policy = resolveNetworkReadPolicy(config)
  if (!policy.enabled || !policy.providerId) {
    return { providerId, status: 'unavailable', checkedAt: new Date().toISOString(), errorKind: 'web_disabled' }
  }
  const provider = runner.infra.webProviders.get(policy.providerId)
  if (!provider) {
    return { providerId: policy.providerId, status: 'unavailable', checkedAt: new Date().toISOString(), errorKind: 'web_provider_unconfigured' }
  }
  const runtime = new WebRetrievalRuntime({
    runId: `web-provider-check-${Date.now()}`,
    policy,
    providers: runner.infra.webProviders,
  })
  try {
    const response = await runtime.search({
      query: 'LittleSheep realtime web retrieval',
      maxResults: 1,
      runId: 'ignored',
    })
    return {
      providerId: policy.providerId,
      status: response.partial ? 'degraded' : 'healthy',
      checkedAt: new Date().toISOString(),
      resultCount: response.results.length,
    }
  } catch (error) {
    const candidate = error && typeof error === 'object' ? (error as { kind?: unknown }).kind : undefined
    const errorKind = isWebErrorKind(candidate) ? candidate : 'web_provider_unavailable'
    return {
      providerId: policy.providerId,
      status: 'unavailable',
      checkedAt: new Date().toISOString(),
      errorKind,
    }
  } finally {
    runtime.dispose()
  }
}
