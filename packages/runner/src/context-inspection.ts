// Content-free session inspection. No filesystem reads, model calls or durable store.
import { buildContextTrace, type ContextTrace } from '@littlesheep/context';
import { getContextWindowForModelRef } from '@littlesheep/config';
import type { ContextSnapshot, ModelRequestSnapshot } from '@littlesheep/types';

export interface ContextInspectionRequest {
  runId: string;
  requestId: string;
  requestIndex: number;
  modelRef: string;
  createdAt?: string;
  localCountedAt?: string;
  providerReportedAt?: string;
  maxContextTokens?: number;
  runState: 'active' | 'recorded';
  conversationRequest: boolean;
  trace: ContextTrace;
}

export interface ContextInspection {
  version: 1;
  sessionId: string;
  /** This is a bounded loaded-history view, never an all-time usage aggregate. */
  coverage: 'loaded_history';
  requests: ContextInspectionRequest[];
  retainedRequests: number;
  truncated: boolean;
  active: boolean;
}

export interface ContextInspectionEvidence {
  runId: string;
  sessionId: string;
  modelRequests?: ModelRequestSnapshot[];
  contextSnapshots?: ContextSnapshot[];
}

export function projectContextInspection(evidence: ContextInspectionEvidence, active = false): ContextInspectionRequest[] {
  const snapshots = new Map((evidence.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]));
  return (evidence.modelRequests ?? []).slice(-64).flatMap((request) => {
    if (request.runId !== evidence.runId || request.sessionId !== evidence.sessionId) return [];
    const snapshot = snapshots.get(request.contextSnapshotId ?? '');
    if (!snapshot) return [];
    const trace = buildContextTrace(snapshot, request);
    if (!trace) return [];
    const modelRef = `${request.provider}/${request.model}`;
    const maxContextTokens = snapshot.budget.status === 'known'
      ? snapshot.budget.maxContextTokens : getContextWindowForModelRef(modelRef);
    return [{ runId: evidence.runId, requestId: request.id, requestIndex: trace.requestIndex,
      modelRef, createdAt: timestamp(request.createdAt),
      localCountedAt: timestamp(snapshot.localTokenLedger?.countedAt),
      providerReportedAt: timestamp(snapshot.providerUsage?.reportedAt),
      maxContextTokens: positive(maxContextTokens), runState: active ? 'active' as const : 'recorded' as const,
      conversationRequest: request.stage === 'execute' || request.stage === 'reply' || request.stage === 'ask_user', trace }];
  });
}

/** Populated only when existing chat/log owners already read or write evidence. */
export class ContextInspectionStore {
  private readonly runs = new Map<string, { sessionId: string; requests: ContextInspectionRequest[] }>();

  observe(evidence: ContextInspectionEvidence): void {
    try {
      const requests = projectContextInspection(evidence);
      this.runs.delete(evidence.runId);
      this.runs.set(evidence.runId, { sessionId: evidence.sessionId, requests });
      while (this.runs.size > 128) this.runs.delete(this.runs.keys().next().value!);
    } catch {
      // Corrupt legacy diagnostics cannot break log replay, settlement or agent work.
    }
  }

  inspect(sessionId: string, live: ContextInspectionEvidence[] = []): ContextInspection {
    const byId = new Map<string, ContextInspectionRequest>();
    for (const run of this.runs.values()) {
      if (run.sessionId === sessionId) for (const request of run.requests) byId.set(request.requestId, request);
    }
    for (const run of live) {
      if (run.sessionId !== sessionId) continue;
      for (const request of projectContextInspection(run, true)) byId.set(request.requestId, request);
    }
    const requests = [...byId.values()].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.requestIndex - b.requestIndex);
    return structuredClone({ version: 1, sessionId, coverage: 'loaded_history', requests: requests.slice(-32),
      retainedRequests: requests.length, truncated: requests.length > 32, active: live.some((run) => run.sessionId === sessionId) });
  }
}

function timestamp(value: string | undefined): string | undefined {
  if (!value || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
function positive(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
