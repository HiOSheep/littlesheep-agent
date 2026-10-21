// Type declarations for the V2 contract module used by TypeScript adapters.

export const REPO_ROOT: string;
export const CONTRACT_VERSION: '2.0.0';
export const SCHEMA_VERSION: 2;
export const SUITE_ID: string;
export const TRIAL_MIN: number;
export const TRIAL_MAX: number;
export const CONTRACT_SCHEMA_PATH: string;
export const TASK_SUITE_PATH: string;
export const DIMENSION_NAMES: readonly ['goal', 'contract', 'mechanism'];
export const GOAL_STATUSES: readonly string[];
export const CONTRACT_STATUSES: readonly string[];
export const MECHANISM_STATUSES: readonly string[];
export const EVIDENCE_TIERS: readonly string[];
export const INFRASTRUCTURE_STATUSES: readonly string[];
export const CREDIBILITY_LEVELS: readonly string[];
export const REQUIRED_RECORD_FIELDS: readonly string[];
export const REQUIRED_LEDGER_FIELDS: readonly string[];
export const EVALUATOR_FILES: readonly string[];
export const FROZEN_BASELINES: Readonly<Record<string, { path: string; sha256: string }>>;

export function sha256Text(text: string): string;
export function sha256File(path: string): string;
export function makeRecordId(input: { batchId: string; taskId: string; trial: number }): string;
export function parseRecordId(recordId: string): { batchId: string; taskId: string; trial: number } | null;
export function computeEvaluatorFingerprint(options?: { repoRoot?: string; files?: readonly string[] }): string;
export function gitProductState(options?: { repoRoot?: string }): {
  sha: string; treeFingerprint: string; dirty: boolean; sourceDirty: boolean; dirtyPaths: string[]; sourceDirtyPaths: string[];
};
export function verifyFrozenBaselines(options?: { repoRoot?: string }): { valid: boolean; checks: Array<Record<string, unknown>> };
export function validateEvaluationRecord(record: unknown, options?: Record<string, unknown>): { valid: boolean; errors: Array<{ code: string; path: string; message: string }> };
export function assertEvaluationRecord(record: unknown, options?: Record<string, unknown>): { valid: boolean };
export function validateLedger(ledger: unknown, options?: Record<string, unknown>): { valid: boolean; errors: Array<{ code: string; path: string; message: string }> };
export function assertLedger(ledger: unknown, options?: Record<string, unknown>): { valid: boolean };
export function readLegacyRecords(path: string): { schemaVersion: number; sourcePath: string; records: Array<Record<string, unknown>>; displayOnly: true; mappedToDimensions: false };
