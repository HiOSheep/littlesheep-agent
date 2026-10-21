// Per-trial and per-batch provider budget envelopes for R4-B V2.
//
// The envelope is charged synchronously before any await, so concurrent calls
// share one counter and cannot bypass the cap. Physical attempts include
// failures, timeouts and retries; blocked attempts are counted separately.
// Output tokens are clamped at the executable boundary and observed usage is
// recorded only from provider receipts; missing receipts stay null/unavailable.
export const DEFAULT_PHYSICAL_REQUEST_BUDGET = 8;
export const DEFAULT_OUTPUT_TOKEN_BUDGET = 2048;

function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function createBudgetEnvelope({
  physicalRequestBudget = DEFAULT_PHYSICAL_REQUEST_BUDGET,
  outputTokenBudget = DEFAULT_OUTPUT_TOKEN_BUDGET,
} = {}) {
  const state = {
    logicalRequests: 0,
    physicalRequests: 0,
    retries: 0,
    blockedRequests: 0,
    requestedOutputTokens: 0,
    effectiveOutputTokens: 0,
    observedInputTokens: null,
    observedOutputTokens: null,
    usageStatus: 'unavailable',
    exhausted: false,
  };
  return {
    noteLogicalRequest() {
      state.logicalRequests += 1;
      return state.logicalRequests;
    },
    /** Charge one physical attempt. Returns {allowed,index} without throwing. */
    chargePhysical(kind = 'attempt') {
      if (state.physicalRequests >= physicalRequestBudget) {
        state.blockedRequests += 1;
        state.exhausted = true;
        return { allowed: false, index: null };
      }
      state.physicalRequests += 1;
      if (kind === 'retry') state.retries += 1;
      return { allowed: true, index: state.physicalRequests };
    },
    /** Clamp requested output tokens at the executable boundary. */
    reserveOutputTokens(requested) {
      if (requested === undefined || requested === null) {
        state.requestedOutputTokens += outputTokenBudget;
        state.effectiveOutputTokens += outputTokenBudget;
        return outputTokenBudget;
      }
      const requestedAmount = nonNegativeInteger(Number(requested), 0);
      const effective = Math.min(requestedAmount, outputTokenBudget);
      state.requestedOutputTokens += requestedAmount;
      state.effectiveOutputTokens += effective;
      return effective;
    },
    /** Record observable usage from a provider receipt; absence stays null. */
    recordObservedUsage({ inputTokens, outputTokens } = {}) {
      if (Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)) {
        state.observedInputTokens = (state.observedInputTokens ?? 0) + inputTokens;
        state.observedOutputTokens = (state.observedOutputTokens ?? 0) + outputTokens;
        state.usageStatus = 'available';
        return true;
      }
      state.usageStatus = state.observedInputTokens === null && state.observedOutputTokens === null ? 'unavailable' : 'partial';
      return false;
    },
    markUsageUnavailable(reason = 'no authoritative receipt') {
      state.usageStatus = 'unavailable';
      state.usageReason = reason;
    },
    snapshot() {
      return {
        limits: { physicalRequestBudget, outputTokenBudget },
        logicalRequests: state.logicalRequests,
        physicalRequests: state.physicalRequests,
        retries: state.retries,
        blockedRequests: state.blockedRequests,
        outputTokens: {
          requested: state.requestedOutputTokens,
          effective: state.effectiveOutputTokens,
          observedInput: state.observedInputTokens,
          observedOutput: state.observedOutputTokens,
          status: state.usageStatus,
        },
        exhausted: state.exhausted,
      };
    },
  };
}

/** Batch-level budget shared by all trials in a run batch. */
export function createBatchBudget({ maxPhysicalRequests, maxOutputTokens }) {
  const physical = nonNegativeInteger(maxPhysicalRequests, 0);
  const output = nonNegativeInteger(maxOutputTokens, 0);
  const state = { physicalRequests: 0, outputTokens: 0, blockedRequests: 0, exhausted: false };
  return {
    chargePhysical() {
      if (state.physicalRequests >= physical) {
        state.blockedRequests += 1;
        state.exhausted = true;
        return { allowed: false, index: null };
      }
      state.physicalRequests += 1;
      return { allowed: true, index: state.physicalRequests };
    },
    chargeOutputTokens(amount) {
      const requested = nonNegativeInteger(Number(amount), 0);
      if (state.outputTokens + requested > output) {
        state.blockedRequests += 1;
        state.exhausted = true;
        return { allowed: false, charged: 0 };
      }
      state.outputTokens += requested;
      return { allowed: true, charged: requested };
    },
    snapshot() {
      return {
        limits: { maxPhysicalRequests: physical, maxOutputTokens: output },
        physicalRequests: state.physicalRequests,
        outputTokens: state.outputTokens,
        blockedRequests: state.blockedRequests,
        exhausted: state.exhausted,
      };
    },
  };
}
