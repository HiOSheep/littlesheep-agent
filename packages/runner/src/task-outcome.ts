import type {
  AgentResult,
  DurableRunProjection,
  TaskArtifactOutcome,
  TaskEvidenceReference,
  TaskOutcome,
  TaskRequirementOutcome,
  TaskRequirementStatus,
} from '@littlesheep/types';
import { unknownTaskOutcome } from '@littlesheep/types';
import { EXPLICIT_FILE_CHECK_TOOL_NAME } from '@littlesheep/tools';
import type { ExplicitFileContentRequirement } from './task-outcome-request.js';
import { collectTrustedCheckReceipts } from './task-outcome-evidence.js';

const MAX_OUTCOME_EVIDENCE = 64;
const MAX_OUTCOME_REQUIREMENTS = 32;
const MAX_OUTCOME_ARTIFACTS = 32;
const MAX_REASON_CODE = 80;

export function readTaskOutcomeForProjection(
  projection: Pick<DurableRunProjection, 'status' | 'finalReply' | 'taskOutcome'>,
  runId: string,
): TaskOutcome {
  const terminal = projection.status === 'completed' || projection.status === 'failed'
    || projection.status === 'interrupted' || projection.finalReply.state === 'runtime_status';
  if (terminal && projection.taskOutcome) return projection.taskOutcome.outcome;
  const fallback = unknownTaskOutcome(runId);
  if (projection.taskOutcome) {
    fallback.execution.reasonCode = 'outcome_pending_terminal_settlement';
    fallback.remaining = [{ reasonCode: 'outcome_pending_terminal_settlement', evidenceRefs: [] }];
  }
  return fallback;
}

/** Build Task Outcome only from Runtime status and check receipts returned by the trusted builtin. */
export function buildTaskOutcome(input: {
  runId: string;
  workspaceRoot?: string;
  result: Pick<AgentResult, 'status' | 'runtimeStatus' | 'sideEffects' | 'modelRequests' | 'messages' | 'toolInvocations'>;
  requirements?: readonly ExplicitFileContentRequirement[];
  requirement?: ExplicitFileContentRequirement;
  /** Durable Kernel state, not the redacted request-attempt snapshots on AgentResult. */
  unsettledProviderRequestIds?: readonly string[];
}): TaskOutcome {
  const execution = executionStatus(input.result.status, input.result.runtimeStatus);
  const explicitRequirements = input.requirements ?? (input.requirement ? [input.requirement] : []);
  const checkCallIds = new Set((input.result.toolInvocations ?? [])
    .filter((record) => record.toolName === EXPLICIT_FILE_CHECK_TOOL_NAME
      && record.toolSource === 'run-scoped' && record.status === 'succeeded')
    .map((record) => record.callId));
  const receipts = explicitRequirements.length > 0
    ? collectTrustedCheckReceipts(
        input.result.messages,
        checkCallIds,
        explicitRequirements,
        input.workspaceRoot ?? process.cwd(),
        input.result.toolInvocations ?? [],
        input.result.sideEffects ?? [],
      )
    : [];
  const unknownEffect = input.result.sideEffects?.some((effect) => effect.status === 'unknown'
    || effect.status === 'planned' || effect.status === 'in_progress') === true;
  const unresolvedProvider = (input.unsettledProviderRequestIds?.length ?? 0) > 0;

  const evidence: TaskEvidenceReference[] = [];
  const requirements: TaskRequirementOutcome[] = [];
  const artifacts: TaskArtifactOutcome[] = [];
  const remaining: TaskOutcome['remaining'] = [];
  let inventory: TaskOutcome['requirementInventory'] = explicitRequirements.length > 0 ? 'complete' : 'unknown';

  for (const explicitRequirement of explicitRequirements) {
    const latest = receipts.filter((receipt) => receipt.requirementId === explicitRequirement.requirementId).at(-1);
    const missingSettledWrite = latest?.status === 'passed' && !latest.writeEffectRef;
    const status: TaskRequirementStatus = !latest
      ? execution === 'blocked' || execution === 'cancelled' ? 'blocked' : 'unverified'
      : unknownEffect || unresolvedProvider ? 'blocked' : missingSettledWrite ? 'unverified' : latest.status;
    const failedReason = latest?.reasonCode ?? 'file_content_mismatch';
    const evidenceRefs: string[] = [];
    if (latest && status !== 'blocked') {
      evidence.push({
        version: 1,
        id: latest.fileStateEvidenceId,
        kind: 'file_state',
        status: 'informational',
        sourceRef: `tool:${latest.callId}`,
        resourceRef: latest.resourceRef,
        ...(latest.contentHash ? { contentHash: latest.contentHash } : {}),
        ...(latest.checkedAt ? { checkedAt: latest.checkedAt } : {}),
      });
      if (latest.writeEffectRef) {
        evidence.push({
          version: 1,
          id: latest.writeEffectRef,
          kind: 'settled_effect',
          status: 'pass',
          sourceRef: latest.writeEffectRef,
          resourceRef: latest.resourceRef,
          effectRef: latest.writeEffectRef,
        });
      }
      const toolResultEvidenceId = `tool-result:${latest.callId}`;
      evidence.push({
        version: 1,
        id: toolResultEvidenceId,
        kind: 'tool_result',
        status: 'informational',
        sourceRef: `tool:${latest.callId}`,
        resourceRef: latest.resourceRef,
      });
      evidence.push({
        version: 1,
        id: latest.evidenceId,
        kind: 'requirement_check',
        status: status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : 'partial',
        sourceRef: `tool:${latest.callId}`,
        resourceRef: latest.resourceRef,
        ...(latest.contentHash ? { contentHash: latest.contentHash } : {}),
        ...(latest.checkedAt ? { checkedAt: latest.checkedAt } : {}),
      });
      evidenceRefs.push(latest.fileStateEvidenceId, ...(latest.writeEffectRef ? [latest.writeEffectRef] : []),
        toolResultEvidenceId, latest.evidenceId);
      artifacts.push({
        resourceRef: latest.resourceRef,
        action: latest.mutationAction ?? 'observed',
        ...(latest.writeEffectRef ? { effectRef: latest.writeEffectRef } : {}),
        evidenceRefs: [...evidenceRefs],
        verification: status,
      });
    }
    const requirementOutcome: TaskRequirementOutcome = {
      id: explicitRequirement.requirementId,
      sourceMessageId: explicitRequirement.sourceMessageId,
      origin: explicitRequirement.origin,
      status,
      evidenceRefs,
      ...(status === 'blocked'
        ? { reasonCode: unknownEffect ? 'unknown_effect' : unresolvedProvider ? 'provider_unsettled' : latest?.reasonCode ?? 'execution_blocked' }
        : status === 'failed' ? { reasonCode: failedReason }
          : status === 'unverified' ? { reasonCode: execution === 'cancelled' ? 'execution_cancelled'
            : missingSettledWrite ? 'no_settled_write_effect' : 'no_independent_check' }
            : {}),
    };
    requirements.push(requirementOutcome);
    if (status !== 'passed') {
      remaining.push({ requirementId: explicitRequirement.requirementId,
        reasonCode: requirementOutcome.reasonCode ?? (status === 'failed' ? failedReason : 'no_independent_check'),
        evidenceRefs });
    }
  }

  if (unknownEffect) remaining.push({ reasonCode: 'unknown_effect', evidenceRefs: [] });
  if (unresolvedProvider) remaining.push({ reasonCode: 'provider_unsettled', evidenceRefs: [] });

  const allRequirementsPassed = inventory === 'complete'
    && requirements.length > 0
    && requirements.every((requirement) => requirement.status === 'passed');
  const hasTrustedProgress = evidence.length > 0
    || input.result.sideEffects?.some((effect) => effect.status === 'succeeded') === true;
  let status: TaskOutcome['status'];
  if (execution === 'cancelled') status = 'cancelled';
  else if (allRequirementsPassed && execution === 'completed' && !unknownEffect && !unresolvedProvider) status = 'completed';
  else if ((unknownEffect || unresolvedProvider || execution === 'blocked') && !hasTrustedProgress) status = 'blocked';
  else if (inventory === 'unknown') status = 'unknown';
  else if (hasTrustedProgress || requirements.some((requirement) => requirement.status === 'failed' || requirement.status === 'unverified')) status = 'partially_completed';
  else status = 'unknown';

  if (inventory !== 'complete' && status === 'completed') status = 'unknown';
  if (inventory === 'unknown') remaining.push({ reasonCode: 'requirements_unknown', evidenceRefs: [] });
  if (execution !== 'completed' && execution !== 'cancelled') {
    remaining.push({ reasonCode: executionReason(input.result.status, input.result.runtimeStatus), evidenceRefs: [] });
  }

  return {
    version: 1,
    runId: input.runId,
    execution: {
      status: execution,
      ...(execution !== 'completed' ? { reasonCode: executionReason(input.result.status, input.result.runtimeStatus) } : {}),
    },
    requirementInventory: inventory,
    requirements: requirements.slice(0, MAX_OUTCOME_REQUIREMENTS),
    evidence: deduplicateEvidence(evidence).slice(0, MAX_OUTCOME_EVIDENCE),
    artifacts: artifacts.slice(0, MAX_OUTCOME_ARTIFACTS),
    status,
    remaining: deduplicateRemaining(remaining).slice(0, MAX_OUTCOME_REQUIREMENTS + 4),
  };
}

function executionStatus(
  status: AgentResult['status'],
  runtimeStatus: AgentResult['runtimeStatus'],
): TaskOutcome['execution']['status'] {
  if (status === 'aborted' || runtimeStatus?.status === 'interrupted') return 'cancelled';
  if (runtimeStatus?.status === 'waiting_user') return 'blocked';
  if (runtimeStatus?.status === 'failed' || status === 'error') return 'failed';
  return status === 'ok' ? 'completed' : 'unknown';
}

function executionReason(status: AgentResult['status'], runtimeStatus: AgentResult['runtimeStatus']): string {
  if (runtimeStatus?.reason) return boundedReason(runtimeStatus.reason);
  if (status === 'aborted') return 'execution_cancelled';
  if (status === 'error') return 'execution_failed';
  return 'execution_status_unknown';
}

function deduplicateEvidence(evidence: TaskEvidenceReference[]): TaskEvidenceReference[] {
  return [...new Map(evidence.map((item) => [item.id, item])).values()];
}

function deduplicateRemaining(items: TaskOutcome['remaining']): TaskOutcome['remaining'] {
  return [...new Map(items.map((item) => [`${item.requirementId ?? ''}:${item.reasonCode}`, item])).values()];
}

function boundedReason(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]/gu, '_').slice(0, MAX_REASON_CODE);
  return normalized || 'unknown_reason';
}
