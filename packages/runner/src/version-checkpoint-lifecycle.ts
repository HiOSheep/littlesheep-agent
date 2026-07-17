// Runner-facing checkpoint completion and degraded recovery.
// Keeps Git lifecycle error handling out of the main run orchestration.

import type { RunStatus, SessionId, VersionCheckpointSummary } from '@littlesheep/types';
import type { RunGitCheckpoint } from '@littlesheep/snapshot';
import type { ExecutionLogStore } from './execution-log.js';

export interface VersionCheckpointResultTarget {
  runId: string;
  status: RunStatus;
  durationMs: number;
  versionCheckpoint?: VersionCheckpointSummary;
}

export async function completeRunVersionCheckpoint(options: {
  checkpoint: RunGitCheckpoint;
  result: VersionCheckpointResultTarget;
  sessionId: SessionId;
  startedAtMs: number;
  executionLogStore: ExecutionLogStore;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}): Promise<boolean> {
  const { checkpoint, result } = options;
  try {
    result.versionCheckpoint = await checkpoint.complete({
      sessionId: String(options.sessionId),
      status: 'complete',
      warningCodes: result.status === 'ok' ? [] : [`run-status-${result.status}`],
    });
    result.durationMs = Date.now() - options.startedAtMs;
    await options.executionLogStore.attachVersionCheckpoint(
      result.runId,
      result.versionCheckpoint,
      result.durationMs,
    );
    return true;
  } catch (error) {
    options.log?.('error', `runner: failed to complete version checkpoint: ${(error as Error).message}`);
    try {
      result.versionCheckpoint = await checkpoint.abort('checkpoint-complete-failed');
      return true;
    } catch (abortError) {
      options.log?.('error', `runner: failed to preserve partial version checkpoint: ${(abortError as Error).message}`);
      return false;
    }
  }
}
