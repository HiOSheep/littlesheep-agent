// Untrusted read boundary for the tool-declared effect reconciliation key.
//
// The key is written by the runtime but read back from durable storage, so it
// is treated as untrusted input here: a value that no longer parses as the
// bounded shape refuses the event instead of handing a partially trusted key
// to a recovery-time tool hook.
import { boundReconciliationKey, type ReconciliationValue } from '@littlesheep/types';
import { DurableKernelError } from './durable-kernel-error.js';

export function readEffectReconciliationKey(
  payload: Record<string, unknown>,
): ReconciliationValue | undefined {
  if (payload.reconciliationKey === undefined) return undefined;
  const bounded = boundReconciliationKey(payload.reconciliationKey);
  if (!bounded) {
    throw new DurableKernelError(
      'effect_intent_created.reconciliationKey must be a bounded scalar, scalar array or flat scalar object',
      'invalid',
    );
  }
  return bounded;
}
