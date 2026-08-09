import {
  MEMORY_INTENT_DECISION_VERSION,
  type LlmMemoryIntentKind,
  type MemoryIntentDecisionRecord,
  type RunContext,
} from '@littlesheep/types';
import type {
  MemoryBranchKind,
  MemoryWriteIntent,
  MemoryWriteResult,
  MemoryWriteServiceLike,
} from '@littlesheep/memory-tree';
import {
  collectConversationSourceRecords,
  conversationSourceRefs,
} from '../conversation-source-records.js';
import { writeMemoryState } from '../memory-state.js';

const MAX_MEMORY_INTENT_DECISIONS_PER_RUN = 64;
const MAX_EVIDENCE_REFS_PER_INTENT = 32;

export interface MemoryIntentGateInput {
  ctx: RunContext;
  stage: 'evolve' | 'capture';
  intent: LlmMemoryIntentKind;
  branch?: MemoryBranchKind;
  summary?: string;
  importance?: number;
  confidence?: number;
  minImportance?: number;
  minConfidence?: number;
  proposalSource?: 'model' | 'runtime';
}

export interface GatedMemoryProposal {
  intent: LlmMemoryIntentKind;
  branch?: MemoryBranchKind;
  summary?: string;
  action: 'commit' | 'defer' | 'reject' | 'ignore';
  reason: string;
  sourceRefs: string[];
  evidenceRefs: string[];
  writeIntent?: MemoryWriteIntent;
}

export interface MemoryIntentBatchResult {
  records: MemoryIntentDecisionRecord[];
  writeResults: MemoryWriteResult[];
}

/** Decide whether a model proposal is eligible for a runtime-owned memory operation. */
export function evaluateMemoryIntent(input: MemoryIntentGateInput): GatedMemoryProposal {
  const contract = [...(input.ctx.modelRequests ?? [])]
    .reverse()
    .find((snapshot) => snapshot.callContract?.purpose === input.stage)
    ?.callContract;
  const runtimeCapture = input.proposalSource === 'runtime' && input.stage === 'capture';
  if (!contract && !runtimeCapture) {
    return rejected(input, [], 'No matching model-call contract snapshot exists for this proposal.');
  }
  if (runtimeCapture && (input.intent !== 'write' || input.branch !== 'daily')) {
    return rejected(input, [], 'Runtime CAPTURE may only propose daily write intents.');
  }
  if (contract && !contract.memoryIntentPolicy.allowed.includes(input.intent)) {
    return rejected(input, [], `Intent ${input.intent} is not allowed by ${contract.id}.`);
  }
  if (input.intent === 'none') {
    return { ...base(input, []), action: 'ignore', reason: 'The model explicitly proposed no memory operation.' };
  }
  if (input.intent === 'read') {
    return {
      ...base(input, []),
      action: 'ignore',
      reason: 'Read intents are resolved by Context selection before generation and do not commit memory.',
    };
  }

  const evidence = collectRunEvidence(input.ctx);
  if (evidence.refs.length === 0) {
    return rejected(input, [], 'No verified step, tool, or verification evidence supports this proposal.');
  }
  if (input.stage === 'evolve' && !evidence.verified) {
    return rejected(input, evidence.refs, 'EVOLVE may commit durable memory only after a passing verification record.');
  }
  if (input.intent === 'merge') {
    return {
      ...base(input, evidence.refs),
      action: 'defer',
      reason: 'Merge proposals require explicit Atom ids, revisions and the runtime reconciliation gate.',
    };
  }
  if (input.intent === 'move') {
    return {
      ...base(input, evidence.refs),
      action: 'defer',
      reason: 'Move proposals require explicit Atom ids, revisions, a parent relation and the runtime hierarchy gate.',
    };
  }
  if (input.intent === 'revise') {
    return {
      ...base(input, evidence.refs),
      action: 'defer',
      reason: 'Revision proposals require explicit Atom ids, revisions and the runtime content-refinement gate.',
    };
  }
  if (input.intent === 'invalidate' || input.intent === 'conflict') {
    return {
      ...base(input, evidence.refs),
      action: 'defer',
      reason: `${input.intent} proposals require an explicit reconciliation workflow and never mutate memory directly.`,
    };
  }
  if ((input.importance ?? 0) < (input.minImportance ?? 0)) {
    return rejected(
      input,
      evidence.refs,
      `Importance ${(input.importance ?? 0).toFixed(2)} is below the runtime threshold ${(input.minImportance ?? 0).toFixed(2)}.`,
    );
  }
  if ((input.confidence ?? 0) < (input.minConfidence ?? 0)) {
    return rejected(
      input,
      evidence.refs,
      `Confidence ${(input.confidence ?? 0).toFixed(2)} is below the runtime threshold ${(input.minConfidence ?? 0).toFixed(2)}.`,
    );
  }
  return {
    ...base(input, evidence.refs),
    action: 'commit',
    reason: 'The proposal is allowed by contract and supported by bounded runtime evidence.',
  };
}

/** Persist approved writes, append redacted decisions, and keep destructive proposals deferred. */
export async function commitMemoryIntentBatch(
  ctx: RunContext,
  stage: 'evolve' | 'capture',
  writer: MemoryWriteServiceLike | undefined,
  proposals: GatedMemoryProposal[],
): Promise<MemoryIntentBatchResult> {
  const commitProposals = proposals.filter((proposal) => proposal.action === 'commit' && proposal.writeIntent);
  const writeIntents = commitProposals.map((proposal) => proposal.writeIntent!);
  let sourceCaptureError: string | undefined;
  if (writer?.captureConversationSources && writeIntents.length > 0) {
    try {
      await writer.captureConversationSources(collectConversationSourceRecords(ctx));
    } catch (error) {
      sourceCaptureError = error instanceof Error ? error.message : String(error);
    }
  }
  const writeResults = writer && !sourceCaptureError ? await writer.writeMany(writeIntents) : [];
  const resultByIntentId = new Map(writeResults.map((result) => [result.intentId, result]));
  const now = new Date().toISOString();
  const records = proposals.map((proposal, index) => {
    const writeResult = proposal.writeIntent ? resultByIntentId.get(proposal.writeIntent.id ?? '') : undefined;
    return decisionRecord(
      ctx,
      stage,
      proposal,
      writeResult,
      writer !== undefined,
      index,
      now,
      sourceCaptureError,
    );
  });
  appendMemoryIntentDecisionRecords(ctx, stage, records);
  return { records, writeResults };
}

export function appendMemoryIntentDecisionRecords(
  ctx: RunContext,
  records: readonly MemoryIntentDecisionRecord[],
): void;
export function appendMemoryIntentDecisionRecords(
  ctx: RunContext,
  stage: 'evolve' | 'capture',
  records: readonly MemoryIntentDecisionRecord[],
): void;
export function appendMemoryIntentDecisionRecords(
  ctx: RunContext,
  stageOrRecords: 'evolve' | 'capture' | readonly MemoryIntentDecisionRecord[],
  maybeRecords?: readonly MemoryIntentDecisionRecord[],
): void {
  const hasExplicitStage = typeof stageOrRecords === 'string';
  const stage: 'evolve' | 'capture' = hasExplicitStage ? stageOrRecords : 'evolve';
  const records = hasExplicitStage ? (maybeRecords ?? []) : stageOrRecords;
  if (records.length === 0) return;
  const next = [...(ctx.memoryIntentDecisions ?? []), ...records]
    .slice(-MAX_MEMORY_INTENT_DECISIONS_PER_RUN)
    .map((record) => structuredClone(record));
  writeMemoryState(ctx, stage, { memoryIntentDecisions: next });
}

export function memoryWriteEvidenceRefs(proposal: GatedMemoryProposal): string[] {
  return proposal.evidenceRefs.slice(0, MAX_EVIDENCE_REFS_PER_INTENT);
}

export function memoryWriteSourceRefs(proposal: GatedMemoryProposal): string[] {
  return proposal.sourceRefs.slice(0, MAX_EVIDENCE_REFS_PER_INTENT);
}

export function collectRunEvidence(ctx: RunContext): { refs: string[]; verified: boolean } {
  const refs = new Set<string>();
  for (const verification of ctx.verificationHistory ?? []) {
    refs.add(`run:${ctx.runId}:verification:${verification.attempt}:${verification.verdict}`);
  }
  for (const step of ctx.taskExecution?.steps ?? []) {
    refs.add(`run:${ctx.runId}:step:${step.stepId}:${step.status}`);
  }
  for (const result of ctx.toolResults ?? []) {
    refs.add(`run:${ctx.runId}:tool:${result.callId}:${result.ok ? 'succeeded' : 'failed'}`);
  }
  const latestVerification = ctx.verificationHistory?.at(-1);
  return {
    refs: [...refs].slice(0, MAX_EVIDENCE_REFS_PER_INTENT),
    verified: latestVerification?.verdict === 'pass',
  };
}

function base(input: MemoryIntentGateInput, evidenceRefs: string[]): Omit<GatedMemoryProposal, 'action' | 'reason'> {
  return {
    intent: input.intent,
    branch: input.branch,
    summary: input.summary,
    sourceRefs: conversationSourceRefs(input.ctx, MAX_EVIDENCE_REFS_PER_INTENT),
    evidenceRefs,
  };
}

function rejected(
  input: MemoryIntentGateInput,
  evidenceRefs: string[],
  reason: string,
): GatedMemoryProposal {
  return { ...base(input, evidenceRefs), action: 'reject', reason };
}

function decisionRecord(
  ctx: RunContext,
  stage: 'evolve' | 'capture',
  proposal: GatedMemoryProposal,
  writeResult: MemoryWriteResult | undefined,
  writerAvailable: boolean,
  index: number,
  createdAt: string,
  sourceCaptureError?: string,
): MemoryIntentDecisionRecord {
  let decision: MemoryIntentDecisionRecord['decision'];
  let reason = proposal.reason;
  if (proposal.action === 'ignore') decision = 'ignored';
  else if (proposal.action === 'reject') decision = 'rejected';
  else if (proposal.action === 'defer') decision = 'deferred';
  else if (sourceCaptureError) {
    decision = 'deferred';
    reason = `Conversation source capture failed before projection write: ${sourceCaptureError}`;
  }
  else if (!writerAvailable) {
    decision = 'deferred';
    reason = 'The runtime approved the proposal, but no memory writer is available.';
  } else if (!writeResult || writeResult.decision === 'queued') {
    decision = 'deferred';
    reason = writeResult?.reason ?? 'The memory writer did not return a persistence decision.';
  } else if (writeResult.decision === 'rejected') {
    decision = 'rejected';
    reason = writeResult.reason;
  } else {
    decision = 'committed';
    reason = writeResult.reason;
  }
  return Object.freeze({
    version: MEMORY_INTENT_DECISION_VERSION,
    id: proposal.writeIntent?.id ?? `${ctx.runId}:${stage}:memory-intent:${index + 1}`,
    runId: ctx.runId,
    stage,
    proposedIntent: proposal.intent,
    decision,
    reason,
    branch: proposal.branch,
    summary: proposal.summary,
    evidenceRefs: Object.freeze([...proposal.evidenceRefs]),
    writeIntentId: proposal.writeIntent?.id,
    repositoryDecision: writeResult?.decision,
    createdAt,
  });
}
