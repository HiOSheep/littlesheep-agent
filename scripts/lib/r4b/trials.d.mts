export const DEFAULT_BATCH_ID: string;
export function validateTrialIdentity(input: { batchId?: string; taskId: string; trial: number }): { valid: boolean; errors: Array<{ code: string; message: string }> };
export function assertTrialIdentity(input: { batchId?: string; taskId: string; trial: number }): { valid: boolean };
export function recordFileName(recordId: string): string;
export function createTrial(input: { batchId?: string; taskId: string; trial: number; baseRoot?: string }): {
  batchId: string; taskId: string; trial: number; recordId: string; fileName: string;
  root: string; workspaceDir: string; dataDir: string; identity: { batchId: string; taskId: string; trial: number };
};
