export const LEGACY_CONTROLLED_PATH: string;
export const LEGACY_REAL_BATCH_PATH: string;
export function readLegacyDisplayRows(options?: { repoRoot?: string }): {
  controlledRows: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  validModelAttempts: Array<Record<string, unknown>>;
  invalidModelAttempts: Array<Record<string, unknown>>;
  invalidModelPhysicalRequests: number;
  mappedToDimensions: false;
};
export function buildBatchLedger(input: { records: unknown[]; batchId: string; legacy: Record<string, unknown> }): Record<string, unknown>;
export function renderReport(input: { ledger: Record<string, unknown>; legacy: Record<string, unknown> }): string;
export function writeReportFile(input: { path?: string; content: string; force?: boolean; repoRoot?: string }): string;
export function readLedgerRecords(input: { repoRoot?: string; recordsDir: string; tasks: unknown[]; options?: Record<string, unknown> }): Array<Record<string, unknown>>;
