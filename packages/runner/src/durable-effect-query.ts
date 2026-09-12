// Recovery-time durable effect reconciliation query.
//
// A host-provided query always wins; otherwise a registered tool may reconcile
// the effect it produced. The host also authorizes any local inspection, so a
// denied or unavailable approval leaves the outcome conservatively `unknown`
// instead of reading paths the current permission mode does not cover.
import type {
  DurableEffectOutcomeQueryResult,
  DurableEffectProjection,
} from '@littlesheep/types';
import type { ToolRegistry } from '@littlesheep/tools';
import type { LogFn } from './infra.js';

export interface DurableEffectOutcomeQueryOptions {
  registry: ToolRegistry;
  query?: (
    effect: DurableEffectProjection,
    identity: { sessionId: string; runId: string },
  ) => Promise<DurableEffectOutcomeQueryResult>;
  authorizeRead?: (absolutePath: string, identity: { sessionId: string; runId: string }) => Promise<boolean>;
  log?: LogFn;
}

export function createDurableEffectOutcomeQuery(
  options: DurableEffectOutcomeQueryOptions,
): (
  effect: DurableEffectProjection,
  identity: { sessionId: string; runId: string },
) => Promise<DurableEffectOutcomeQueryResult> {
  return async (effect, identity) => {
    if (options.query) return options.query(effect, identity);
    const reconcile = options.registry.get(effect.toolName)?.tool.reconcileEffect;
    if (!reconcile) return { known: false };
    try {
      return await reconcile(effect, {
        sessionId: identity.sessionId,
        runId: identity.runId,
        authorizeRead: options.authorizeRead
          ? (path) => options.authorizeRead!(path, identity)
          : undefined,
        ...(effect.reconciliationKey ? { reconciliationKey: effect.reconciliationKey } : {}),
        ...(options.log ? { log: options.log } : {}),
      });
    } catch (error) {
      options.log?.('warn', 'runner: durable effect reconciliation failed', {
        effectId: effect.effectId,
        toolName: effect.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return { known: false };
    }
  };
}