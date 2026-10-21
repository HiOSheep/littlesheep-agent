export function computeMetrics(records: Array<Record<string, unknown>>): {
  goal: Record<string, unknown>; contract: Record<string, unknown>; mechanism: Record<string, unknown>; perTask: Record<string, Record<string, unknown>>;
};
export function rateSummary(metric: Record<string, unknown>): string;
