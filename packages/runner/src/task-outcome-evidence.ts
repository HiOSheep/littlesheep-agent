// Task Outcome evidence correlation from persisted Tool results and settled Effects.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentResult, TaskArtifactOutcome, TaskEvidenceReference, TaskOutcome } from '@littlesheep/types';
import type { ExplicitFileContentCheckReceipt } from '@littlesheep/tools';
import type { ExecutionLog } from './execution-log.js';

export function collectTrustedCheckReceipts(
  messages: readonly import('@littlesheep/types').Message[],
  callIds: ReadonlySet<string>,
  requirementId: string,
  workspaceRoot: string,
  expectedFilePath: string,
  invocations: readonly NonNullable<AgentResult['toolInvocations']>[number][],
  sideEffects: readonly NonNullable<AgentResult['sideEffects']>[number][],
): Array<ExplicitFileContentCheckReceipt & {
  callId: string;
  checkedAt?: string;
  mutationAction?: TaskArtifactOutcome['action'];
  writeEffectRef?: string;
}> {
  const receipts: Array<ExplicitFileContentCheckReceipt & {
    callId: string;
    checkedAt?: string;
    mutationAction?: TaskArtifactOutcome['action'];
    writeEffectRef?: string;
  }> = [];
  const mutations: Array<{ resourceRef: string; action: TaskArtifactOutcome['action']; callId: string; order: number }> = [];
  const candidates: Array<{
    receipt: ExplicitFileContentCheckReceipt;
    callId: string;
    order: number;
    timestamp: string;
    checkedAt?: string;
  }> = [];
  let order = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      const result = block.result;
      const currentOrder = order++;
      const mutation = recordWorkspaceMutation(result.meta?.workspaceFileMutation);
      if (mutation) mutations.push({ ...mutation, callId: result.callId, order: currentOrder });
      if (callIds.has(result.callId) && result.ok) {
        const receipt = readCheckReceipt(result.meta?.taskOutcomeCheck);
        if (receipt?.requirementId === requirementId) {
          const invocation = invocations.find((record) => record.callId === result.callId);
          candidates.push({
            receipt,
            callId: result.callId,
            order: currentOrder,
            timestamp: message.timestamp,
            ...(isTimestamp(invocation?.endedAt) ? { checkedAt: invocation.endedAt } : {}),
          });
        }
      }
    }
  }
  const successfulWrites = new Set(invocations
    .filter((record) => record.toolName === 'write' && record.status === 'succeeded')
    .map((record) => record.callId));
  const settledWriteByCall = new Map(sideEffects
    .filter((effect) => effect.toolName === 'write' && effect.status === 'succeeded' && effect.callId)
    .map((effect) => [effect.callId!, `effect:${createHash('sha256').update(effect.idempotencyKey).digest('hex').slice(0, 32)}`]));
  const expectedResourceRef = `workspace:${expectedFilePath.replaceAll('\\', '/')}`;
  const normalizedTarget = resolve(workspaceRoot, expectedFilePath).replace(/[\\/]+$/u, '');
  const resourceTarget = process.platform === 'win32' ? normalizedTarget.toLocaleLowerCase() : normalizedTarget;
  const expectedResourceKeys = new Set([`fs:${resourceTarget}`, `write:fs:${resourceTarget}`]);
  const visibleMutationCallIds = new Set(mutations
    .filter((mutation) => mutation.resourceRef === expectedResourceRef)
    .map((mutation) => mutation.callId));
  const checkpointWrites = sideEffects.filter((effect) => effect.toolName === 'write'
    && effect.status === 'succeeded'
    && effect.callId
    && !visibleMutationCallIds.has(effect.callId)
    && effect.resourceKeys?.some((key) => expectedResourceKeys.has(key)));
  for (const candidate of candidates) {
    const priorMutation = [...mutations].reverse().find((mutation) => mutation.order < candidate.order
      && mutation.resourceRef === candidate.receipt.resourceRef
      && successfulWrites.has(mutation.callId)
      && settledWriteByCall.has(mutation.callId));
    const followedByMutation = mutations.some((mutation) => mutation.order > candidate.order
      && mutation.resourceRef === candidate.receipt.resourceRef
      && successfulWrites.has(mutation.callId)
      && settledWriteByCall.has(mutation.callId));
    const candidateAt = Date.parse(candidate.timestamp);
    const laterCheckpointWrite = checkpointWrites.some((effect) => {
      const endedAt = effect.endedAt ? Date.parse(effect.endedAt) : Number.NaN;
      return !Number.isFinite(candidateAt) || !Number.isFinite(endedAt) || endedAt > candidateAt;
    });
    if (followedByMutation || laterCheckpointWrite) continue;
    const priorCheckpointWrite = checkpointWrites
      .filter((effect) => Number.isFinite(candidateAt) && Number.isFinite(Date.parse(effect.endedAt ?? ''))
        && Date.parse(effect.endedAt!) < candidateAt)
      .sort((left, right) => Date.parse(right.endedAt!) - Date.parse(left.endedAt!))[0];
    const priorCheckpointEffectRef = priorCheckpointWrite
      ? `effect:${createHash('sha256').update(priorCheckpointWrite.idempotencyKey).digest('hex').slice(0, 32)}`
      : undefined;
    const writeEffectRef = (priorMutation && settledWriteByCall.get(priorMutation.callId))
      ?? priorCheckpointEffectRef;
    receipts.push({
      ...candidate.receipt,
      callId: candidate.callId,
      ...(candidate.checkedAt ? { checkedAt: candidate.checkedAt } : {}),
      ...(priorMutation ? { mutationAction: priorMutation.action } : {}),
      ...(writeEffectRef ? { writeEffectRef } : {}),
    });
  }
  return receipts;
}

export function hasResolvableTaskOutcomeEvidence(
  log: Pick<ExecutionLog, 'toolInvocations' | 'toolCalls' | 'sideEffects'>,
  outcome: TaskOutcome,
): boolean {
  const invocations = new Map((log.toolInvocations ?? []).map((record) => [record.callId, record]));
  const calls = new Map(log.toolCalls.map((record) => [record.call.id, record]));
  const successfulEffects = new Set((log.sideEffects ?? [])
    .filter((effect) => effect.status === 'succeeded')
    .map((effect) => `effect:${createHash('sha256').update(effect.idempotencyKey).digest('hex').slice(0, 32)}`));
  return outcome.evidence.every((evidence) => isResolvableEvidence(evidence, invocations, calls, successfulEffects));
}

function isResolvableEvidence(
  evidence: TaskEvidenceReference,
  invocations: ReadonlyMap<string, NonNullable<ExecutionLog['toolInvocations']>[number]>,
  calls: ReadonlyMap<string, ExecutionLog['toolCalls'][number]>,
  successfulEffects: ReadonlySet<string>,
): boolean {
  if (evidence.kind === 'settled_effect') {
    return evidence.effectRef !== undefined && successfulEffects.has(evidence.effectRef);
  }
  if (evidence.kind !== 'tool_result' && evidence.kind !== 'file_state' && evidence.kind !== 'requirement_check') {
    return false;
  }
  const callId = evidence.sourceRef.startsWith('tool:') ? evidence.sourceRef.slice('tool:'.length) : '';
  const invocation = invocations.get(callId);
  const call = calls.get(callId);
  if (!callId || invocation?.toolName !== 'runtime_check_file_content'
    || invocation.toolSource !== 'run-scoped' || invocation.status !== 'succeeded'
    || call?.call.name !== 'runtime_check_file_content' || call.result.callId !== callId || !call.result.ok) return false;
  if (evidence.checkedAt !== undefined && invocation.endedAt !== evidence.checkedAt) return false;
  if (evidence.kind === 'tool_result') return evidence.id === `tool-result:${callId}`;
  const value = call.result.meta?.taskOutcomeCheck;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const expectedId = evidence.kind === 'file_state' ? receipt.fileStateEvidenceId : receipt.evidenceId;
  const expectedStatus = evidence.kind === 'file_state' || receipt.status === 'blocked'
    ? 'informational'
    : receipt.status === 'passed' ? 'pass' : receipt.status === 'failed' ? 'fail' : 'partial';
  return expectedId === evidence.id
    && expectedStatus === evidence.status
    && receipt.resourceRef === evidence.resourceRef
    && receipt.contentHash === evidence.contentHash;
}

function readCheckReceipt(value: unknown): ExplicitFileContentCheckReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.requirementId !== 'string'
    || typeof record.evidenceId !== 'string' || !record.evidenceId.startsWith('file-check:')
    || typeof record.fileStateEvidenceId !== 'string' || !record.fileStateEvidenceId.startsWith('file-check:')
    || typeof record.resourceRef !== 'string' || !/^workspace:[A-Za-z0-9._/-]{1,180}$/u.test(record.resourceRef)
    || (record.status !== 'passed' && record.status !== 'failed' && record.status !== 'blocked')
    || (record.contentHash !== undefined && !/^[a-f0-9]{64}$/u.test(String(record.contentHash)))) return undefined;
  return {
    version: 1,
    requirementId: record.requirementId,
    evidenceId: record.evidenceId,
    fileStateEvidenceId: record.fileStateEvidenceId,
    status: record.status,
    resourceRef: record.resourceRef,
    ...(typeof record.contentHash === 'string' ? { contentHash: record.contentHash } : {}),
    ...(typeof record.reasonCode === 'string' ? { reasonCode: boundReason(record.reasonCode) as ExplicitFileContentCheckReceipt['reasonCode'] } : {}),
  };
}

function recordWorkspaceMutation(value: unknown): { resourceRef: string; action: TaskArtifactOutcome['action'] } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.resourceRef !== 'string' || !/^workspace:[A-Za-z0-9._/-]{1,180}$/u.test(record.resourceRef)) return undefined;
  if (record.action !== 'created' && record.action !== 'modified') return undefined;
  return { resourceRef: record.resourceRef, action: record.action };
}

function boundReason(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, 80);
  return normalized || 'unknown_reason';
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}
