/** Run-level task status and bounded evidence references. This is separate
 * from the Harness VRS record, which only describes execution evidence health. */
export type TaskOutcomeExecutionStatus = 'completed' | 'failed' | 'cancelled' | 'blocked' | 'unknown';
export type TaskRequirementStatus = 'passed' | 'failed' | 'unverified' | 'blocked';
export type TaskOutcomeStatus = 'completed' | 'partially_completed' | 'blocked' | 'cancelled' | 'unknown';
export type TaskRequirementOrigin = 'user_explicit' | 'runtime_derived';
export type TaskEvidenceStatus = 'pass' | 'fail' | 'partial' | 'informational';
export type TaskEvidenceKind = 'tool_result' | 'settled_effect' | 'file_state' | 'command_result' | 'requirement_check' | 'vrs_verification';

/** A reference to a bounded Runtime fact; it never carries tool output or file contents. */
export interface TaskEvidenceReference {
  version: 1;
  id: string;
  kind: TaskEvidenceKind;
  status: TaskEvidenceStatus;
  /** Runtime-owned source identity such as a tool invocation or durable event ID. */
  sourceRef: string;
  resourceRef?: string;
  effectRef?: string;
  /** Content digest for the exact observed file version, when applicable. */
  contentHash?: string;
}

export interface TaskRequirementOutcome {
  id: string;
  sourceMessageId: string;
  origin: TaskRequirementOrigin;
  status: TaskRequirementStatus;
  evidenceRefs: string[];
  reasonCode?: string;
}

export interface TaskArtifactOutcome {
  resourceRef: string;
  action: 'created' | 'modified' | 'attached' | 'observed';
  effectRef?: string;
  evidenceRefs: string[];
  verification: TaskRequirementStatus;
}

export interface TaskOutcomeRemainingItem {
  requirementId?: string;
  reasonCode: string;
  evidenceRefs: string[];
}

/** Immutable, deterministic result projection for one logical Run. */
export interface TaskOutcome {
  version: 1;
  runId: string;
  execution: {
    status: TaskOutcomeExecutionStatus;
    reasonCode?: string;
  };
  requirementInventory: 'complete' | 'partial' | 'unknown';
  requirements: TaskRequirementOutcome[];
  evidence: TaskEvidenceReference[];
  artifacts: TaskArtifactOutcome[];
  status: TaskOutcomeStatus;
  remaining: TaskOutcomeRemainingItem[];
}

/** Conservative read value for legacy Run records that predate Task Outcome. */
export function unknownTaskOutcome(runId: string): TaskOutcome {
  return {
    version: 1,
    runId,
    execution: { status: 'unknown', reasonCode: 'legacy_outcome_unavailable' },
    requirementInventory: 'unknown',
    requirements: [],
    evidence: [],
    artifacts: [],
    status: 'unknown',
    remaining: [{ reasonCode: 'legacy_outcome_unavailable', evidenceRefs: [] }],
  };
}

/** Parse an untrusted persisted value into the bounded public Task Outcome shape. */
export function parseTaskOutcome(value: unknown, expectedRunId: string): TaskOutcome | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || input.runId !== expectedRunId
    || !isOutcomeStatus(input.status)
    || !['complete', 'partial', 'unknown'].includes(String(input.requirementInventory))
    || !input.execution || typeof input.execution !== 'object' || Array.isArray(input.execution)
    || !Array.isArray(input.requirements) || input.requirements.length > 32
    || !Array.isArray(input.evidence) || input.evidence.length > 64
    || !Array.isArray(input.artifacts) || input.artifacts.length > 32
    || !Array.isArray(input.remaining) || input.remaining.length > 36) return undefined;

  const executionInput = input.execution as Record<string, unknown>;
  if (!isExecutionStatus(executionInput.status)) return undefined;
  const requirements: TaskRequirementOutcome[] = [];
  for (const item of input.requirements) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (!shortIdentifier(record.id) || !shortIdentifier(record.sourceMessageId)
      || (record.origin !== 'user_explicit' && record.origin !== 'runtime_derived')
      || !isRequirementStatus(record.status) || !boundedStringArray(record.evidenceRefs, 64)) return undefined;
    requirements.push({
      id: record.id,
      sourceMessageId: record.sourceMessageId,
      origin: record.origin,
      status: record.status,
      evidenceRefs: [...record.evidenceRefs as string[]],
      ...(boundedReason(record.reasonCode) ? { reasonCode: boundedReason(record.reasonCode) } : {}),
    });
  }
  const evidence: TaskEvidenceReference[] = [];
  for (const item of input.evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (record.version !== 1 || !shortIdentifier(record.id) || !isEvidenceKind(record.kind)
      || !isEvidenceStatus(record.status) || !boundedText(record.sourceRef, 192)
      || (record.resourceRef !== undefined && !boundedText(record.resourceRef, 192))
      || (record.effectRef !== undefined && !shortIdentifier(record.effectRef))
      || (record.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(String(record.contentHash)))) return undefined;
    evidence.push({
      version: 1,
      id: record.id,
      kind: record.kind,
      status: record.status,
      sourceRef: record.sourceRef,
      ...(typeof record.resourceRef === 'string' ? { resourceRef: record.resourceRef } : {}),
      ...(typeof record.effectRef === 'string' ? { effectRef: record.effectRef } : {}),
      ...(typeof record.contentHash === 'string' ? { contentHash: record.contentHash } : {}),
    });
  }
  const artifacts: TaskArtifactOutcome[] = [];
  for (const item of input.artifacts) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (!boundedText(record.resourceRef, 192)
      || (record.action !== 'created' && record.action !== 'modified' && record.action !== 'attached' && record.action !== 'observed')
      || !isRequirementStatus(record.verification) || !boundedStringArray(record.evidenceRefs, 64)
      || (record.effectRef !== undefined && !shortIdentifier(record.effectRef))) return undefined;
    artifacts.push({
      resourceRef: record.resourceRef,
      action: record.action,
      evidenceRefs: [...record.evidenceRefs as string[]],
      verification: record.verification,
      ...(typeof record.effectRef === 'string' ? { effectRef: record.effectRef } : {}),
    });
  }
  const remaining: TaskOutcomeRemainingItem[] = [];
  for (const item of input.remaining) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (!boundedReason(record.reasonCode) || !boundedStringArray(record.evidenceRefs, 64)
      || (record.requirementId !== undefined && !shortIdentifier(record.requirementId))) return undefined;
    remaining.push({
      reasonCode: boundedReason(record.reasonCode)!,
      evidenceRefs: [...record.evidenceRefs as string[]],
      ...(typeof record.requirementId === 'string' ? { requirementId: record.requirementId } : {}),
    });
  }
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  if (evidenceById.size !== evidence.length) return undefined;
  for (const requirement of requirements) {
    if (requirement.evidenceRefs.some((id) => !evidenceById.has(id))) return undefined;
    if (requirement.status === 'passed' || requirement.status === 'failed') {
      const expectedCheckStatus = requirement.status === 'passed' ? 'pass' : 'fail';
      const linked = requirement.evidenceRefs.map((id) => evidenceById.get(id)!);
      const check = linked.find((item) => item.kind === 'requirement_check' && item.status === expectedCheckStatus);
      const fileState = linked.find((item) => item.kind === 'file_state');
      const toolResult = linked.find((item) => item.kind === 'tool_result' && item.sourceRef === check?.sourceRef);
      if (!check || !fileState || !toolResult
        || check.resourceRef !== fileState.resourceRef || check.contentHash !== fileState.contentHash) return undefined;
    }
  }
  for (const artifact of artifacts) {
    if (artifact.evidenceRefs.some((id) => !evidenceById.has(id))) return undefined;
    if (artifact.verification === 'passed' || artifact.verification === 'failed') {
      const expectedCheckStatus = artifact.verification === 'passed' ? 'pass' : 'fail';
      if (!artifact.evidenceRefs.some((id) => {
        const item = evidenceById.get(id);
        return item?.kind === 'requirement_check' && item.status === expectedCheckStatus
          && item.resourceRef === artifact.resourceRef;
      })) return undefined;
    }
  }
  if (input.status === 'completed' && (input.requirementInventory !== 'complete'
    || executionInput.status !== 'completed' || requirements.length === 0
    || requirements.some((requirement) => requirement.status !== 'passed') || remaining.length > 0)) return undefined;
  if (input.status === 'cancelled' && executionInput.status !== 'cancelled') return undefined;
  return {
    version: 1,
    runId: expectedRunId,
    execution: {
      status: executionInput.status,
      ...(boundedReason(executionInput.reasonCode) ? { reasonCode: boundedReason(executionInput.reasonCode) } : {}),
    },
    requirementInventory: input.requirementInventory as TaskOutcome['requirementInventory'],
    requirements,
    evidence,
    artifacts,
    status: input.status,
    remaining,
  };
}

function isOutcomeStatus(value: unknown): value is TaskOutcomeStatus {
  return value === 'completed' || value === 'partially_completed' || value === 'blocked' || value === 'cancelled' || value === 'unknown';
}
function isExecutionStatus(value: unknown): value is TaskOutcomeExecutionStatus {
  return value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'blocked' || value === 'unknown';
}
function isRequirementStatus(value: unknown): value is TaskRequirementStatus {
  return value === 'passed' || value === 'failed' || value === 'unverified' || value === 'blocked';
}
function isEvidenceKind(value: unknown): value is TaskEvidenceKind {
  return value === 'tool_result' || value === 'settled_effect' || value === 'file_state'
    || value === 'command_result' || value === 'requirement_check' || value === 'vrs_verification';
}
function isEvidenceStatus(value: unknown): value is TaskEvidenceStatus {
  return value === 'pass' || value === 'fail' || value === 'partial' || value === 'informational';
}
function boundedStringArray(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => shortIdentifier(item));
}
function shortIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 192;
}
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function boundedReason(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(value) ? value : undefined;
}
