export const DEFAULT_PHYSICAL_REQUEST_BUDGET: number;
export const DEFAULT_OUTPUT_TOKEN_BUDGET: number;
export function createBudgetEnvelope(options?: { physicalRequestBudget?: number; outputTokenBudget?: number }): {
  noteLogicalRequest(): number;
  chargePhysical(kind?: string): { allowed: boolean; index: number | null };
  reserveOutputTokens(requested?: number | null): number;
  recordObservedUsage(usage?: { inputTokens?: number; outputTokens?: number }): boolean;
  markUsageUnavailable(reason?: string): void;
  snapshot(): Record<string, unknown>;
};
export function createBatchBudget(options: { maxPhysicalRequests: number; maxOutputTokens: number }): {
  chargePhysical(): { allowed: boolean; index: number | null };
  chargeOutputTokens(amount: number): { allowed: boolean; charged: number };
  snapshot(): Record<string, unknown>;
};
