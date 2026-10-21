export const RECORDS_DIR: string;
export const LEDGER_PATH: string;
export const REPORT_PATH: string;
export const DEFAULT_IO: Record<string, (...args: never[]) => unknown>;
export function writeRecordAtomic(input: { dir: string; record: unknown; task?: unknown; options?: Record<string, unknown>; io?: Record<string, unknown> }): { path: string; sha256: string };
export function readRecords(input: { dir: string; tasks?: unknown[]; options?: Record<string, unknown> }): Array<Record<string, unknown>>;
export function writeLedgerAtomic(input: { path: string; ledger: unknown; options?: Record<string, unknown>; allowRegenerate?: boolean; io?: Record<string, unknown> }): { path: string; sha256: string };
export function buildLedger(input: { records: unknown[]; batchId: string; suiteId: string; metrics: unknown; legacy: unknown; generatedAt?: string }): Record<string, unknown>;
