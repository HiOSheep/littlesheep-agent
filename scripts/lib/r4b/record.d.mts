export function buildRecord(input: {
  loaded: Record<string, unknown>; task: Record<string, unknown>; trial: number; batchId: string;
  observation: Record<string, unknown>; gitState: Record<string, unknown>;
  evaluatorFingerprint: string; contractSha256: string; taskSuiteSha256: string; command: string;
  variant?: string | null; faultMode?: string | null;
}): Record<string, unknown>;
