import type {
  ContextSnapshot,
  ModelRequestSnapshot,
  ReplyProvenance,
  ToolResult,
  UserFacingReplyPurpose,
} from '@littlesheep/types';
import {
  parseMemoryAtomSections,
  type MemoryAtomText,
} from './response-continuity-text.js';

const CONTENT_PURPOSES = new Set<UserFacingReplyPurpose>([
  'reply',
  'capability_reply',
  'ask_user',
  'decide',
  'decide_explicit_tool',
  'execute_tool_loop',
  'execute_final_reply',
  'recover',
]);

export interface ResponseContinuityExposure {
  strict: boolean;
  observed: boolean;
  snapshots: number;
  truncated: boolean;
  initialMemoryIncluded: boolean;
  sessionSummaryIncluded: boolean;
  historyMessageIds?: Set<string>;
  memoryToolAtoms: MemoryAtomText[];
  memoryToolResults: number;
}

/** Resolve only Context sources that entered the causal model-call chain before the visible reply. */
export function resolveResponseContinuityExposure(input: {
  replyProvenance?: ReplyProvenance;
  modelRequests?: ModelRequestSnapshot[];
  contextSnapshots?: ContextSnapshot[];
  sessionSummaryId?: string;
  toolResults?: ToolResult[];
}): ResponseContinuityExposure {
  const strict = input.replyProvenance !== undefined
    || input.modelRequests !== undefined
    || input.contextSnapshots !== undefined;
  if (!strict) {
    const memoryToolResults = (input.toolResults ?? []).filter(isMemoryFragmentResult);
    const memoryToolAtoms = memoryAtomsFromToolResults(memoryToolResults);
    return {
      strict: false,
      observed: false,
      snapshots: 0,
      truncated: false,
      initialMemoryIncluded: true,
      sessionSummaryIncluded: true,
      memoryToolAtoms,
      memoryToolResults: memoryToolResults.length,
    };
  }

  const provenance = input.replyProvenance;
  if (!provenance) return unavailableExposure();
  // Identity, not shape: the request id is stable, while its index and the
  // messages it carries are not (a stage may start sending conversation
  // history), and a shape mismatch here silently drops the exposure report.
  const provenanceRequest = (input.modelRequests ?? []).find((request) => (
    request.id === provenance.modelRequestId
    && request.callContract?.purpose === provenance.purpose
  ));
  if (!provenanceRequest) return unavailableExposure();
  const snapshotsById = new Map((input.contextSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]));
  const snapshots = (input.modelRequests ?? [])
    .filter((request) => request.requestIndex <= provenanceRequest.requestIndex)
    .filter((request) => CONTENT_PURPOSES.has(request.callContract?.purpose as UserFacingReplyPurpose))
    .map((request) => request.contextSnapshotId ? snapshotsById.get(request.contextSnapshotId) : undefined)
    .filter((snapshot): snapshot is ContextSnapshot => Boolean(snapshot));
  if (snapshots.length === 0) return unavailableExposure();

  const included = snapshots.flatMap((snapshot) => (
    snapshot.items.filter((item) => item.disposition === 'included')
  ));
  const historyMessageIds = new Set(included
    .filter((item) => item.kind === 'recent_message' && item.source.kind === 'message')
    .map((item) => item.source.id)
    .filter((id): id is string => Boolean(id)));
  const includedToolCallIds = new Set(included
    .filter((item) => item.kind === 'tool_result' && item.source.kind === 'tool')
    .map((item) => item.source.id)
    .filter((id): id is string => Boolean(id)));
  const visibleToolResults = (input.toolResults ?? [])
    .filter((result) => includedToolCallIds.has(result.callId));
  const memoryToolAtoms = memoryAtomsFromToolResults(visibleToolResults);

  return {
    strict: true,
    observed: true,
    snapshots: snapshots.length,
    truncated: snapshots.some((snapshot) => snapshot.itemsTruncated),
    initialMemoryIncluded: included.some((item) => (
      item.kind === 'memory_fragment'
      && item.source.kind === 'memory'
      && item.source.id === 'initial-selection'
    )),
    sessionSummaryIncluded: Boolean(input.sessionSummaryId && included.some((item) => (
      item.kind === 'summary_memory'
      && item.source.kind === 'memory'
      && item.source.id === input.sessionSummaryId
    ))),
    historyMessageIds,
    memoryToolAtoms,
    memoryToolResults: visibleToolResults.filter(isMemoryFragmentResult).length,
  };
}

function memoryAtomsFromToolResults(results: ToolResult[]): MemoryAtomText[] {
  const byId = new Map<string, MemoryAtomText>();
  for (const result of results) {
    if (!isMemoryFragmentResult(result) || typeof result.output !== 'string') continue;
    const fragmentIds = new Set(result.meta!.memoryFragmentIds as string[]);
    for (const atom of parseMemoryAtomSections(result.output)) {
      if (fragmentIds.has(atom.atomId)) byId.set(atom.atomId, atom);
    }
  }
  return [...byId.values()];
}

function isMemoryFragmentResult(result: ToolResult): boolean {
  return result.ok
    && Array.isArray(result.meta?.memoryFragmentIds)
    && result.meta.memoryFragmentIds.every((value) => typeof value === 'string');
}

function unavailableExposure(): ResponseContinuityExposure {
  return {
    strict: true,
    observed: false,
    snapshots: 0,
    truncated: false,
    initialMemoryIncluded: false,
    sessionSummaryIncluded: false,
    historyMessageIds: new Set(),
    memoryToolAtoms: [],
    memoryToolResults: 0,
  };
}
