// Publication of the run router, and the deferred recovery gate that belongs to it.
//
// Split out of `local-app-api-server.ts`, which is at its controlled size ceiling:
// the listener there owns routing, and this owns the one piece of *state* routing
// depends on - which RunRouter generation is current, and how a request observes
// the recovery that router started.
//
// The two facts are deliberately one object. `setRunner` no longer waits for
// startup recovery (that work delays the publish the send control waits on and
// has nothing to do with a fresh message), so a route can arrive while a Runner
// has been published but its recovery has not settled. `waitForRecovery` reads
// the *pending* router rather than the active one for exactly that window: two
// routes can arrive in the same tick, and neither may read "no router yet" as
// "nothing to wait for".
import type { AgentRunner } from '@littlesheep/runner'
import { RunRouter } from './local-app-api/run-routes.js'

export class RunRouterPublisher {
  private pending: Promise<RunRouter> | undefined
  private active: RunRouter | undefined
  private generation = 0

  /** The router that serves requests, once one has been published. */
  current(): RunRouter | undefined {
    return this.active
  }

  /**
   * Publish a Runner's router.
   *
   * `create` is not awaited by callers that only need the publish, which is why
   * the pending router is kept: it is already the answer for any request that
   * needs recovery even though it is not `active` yet.
   */
  async publish(runner: AgentRunner): Promise<void> {
    const generation = ++this.generation
    const pending = RunRouter.create(runner)
    this.pending = pending
    const next = await pending
    if (generation === this.generation) this.active = next
    else next.stop()
  }

  /**
   * Settle the recovery that the published (or currently publishing) router runs.
   *
   * Never throws: recovery reports its own failures and must not fail a request.
   */
  async waitForRecovery(sessionId?: string): Promise<void> {
    const pending = this.pending
    if (!pending) return
    const generation = this.generation
    const router = await pending.catch(() => undefined)
    if (!router || generation !== this.generation) return
    await router.waitForRecovery(sessionId)
  }

  /** Stop the pending and the active router; used when the server shuts down. */
  async stop(): Promise<void> {
    const router = await this.pending?.catch(() => undefined)
    router?.stop()
    if (this.active !== router) this.active?.stop()
    this.pending = undefined
    this.active = undefined
  }
}
