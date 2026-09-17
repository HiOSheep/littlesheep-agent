// Redacted, deterministic segment diff over actual model requests.
//
// Only ids, kinds, hashes, counts, dispositions and runtime-classified reasons
// leave this module. Prompt text, memory bodies, tool payloads and workspace
// paths never do; callers use the result to name *why* a prefix changed.

import type {
  ContextItemKind,
  ContextSnapshot,
  ContextSnapshotItem,
  ModelMessageShape,
  ModelRequestSnapshot,
} from '@littlesheep/types';

export type RequestDiffReason =
  | 'system_prompt'
  | 'user_input'
  | 'history'
  | 'summary_memory'
  | 'memory'
  | 'project_knowledge'
  | 'tool_result'
  | 'workflow_state'
  | 'output_constraint'
  | 'attachment'
  | 'runtime_fact'
  | 'tools'
  | 'policy';

export type RequestSegmentChange = 'unchanged' | 'changed' | 'added' | 'removed';

export interface RequestSegmentDiff {
  key: string;
  kind: string;
  change: RequestSegmentChange;
  reason: RequestDiffReason;
  fromHash?: string;
  toHash?: string;
  fromCharacters?: number;
  toCharacters?: number;
  fromDisposition?: ContextSnapshotItem['disposition'];
  toDisposition?: ContextSnapshotItem['disposition'];
}

export interface ContextSnapshotDiff {
  version: 1;
  identical: boolean;
  segments: RequestSegmentDiff[];
  /** Sorted, de-duplicated reasons for every non-unchanged segment. */
  changedReasons: RequestDiffReason[];
  /** Leading in-order segments whose key and content hash are byte-identical. */
  stablePrefixLength: number;
  firstChangeKey?: string;
}

export interface ModelMessageDiff {
  index: number;
  role: ModelMessageShape['role'];
  change: RequestSegmentChange;
  reason: 'history';
}

export interface ModelRequestDiff {
  version: 1;
  identical: boolean;
  payloadChanged: boolean;
  messageChanges: ModelMessageDiff[];
  tools: { added: string[]; removed: string[] };
  policyFields: Array<
    'model' | 'toolChoice' | 'temperature' | 'maxOutputTokens' | 'reasoningEffort' | 'thinking' | 'stream'
  >;
  reasons: RequestDiffReason[];
}

const KIND_REASONS: Record<ContextItemKind, RequestDiffReason> = {
  system_prompt: 'system_prompt',
  user_input: 'user_input',
  recent_message: 'history',
  summary_memory: 'summary_memory',
  memory_index: 'memory',
  memory_fragment: 'memory',
  project_knowledge: 'project_knowledge',
  tool_result: 'tool_result',
  workflow_state: 'workflow_state',
  output_constraint: 'output_constraint',
  attachment_manifest: 'attachment',
  runtime_event: 'runtime_fact',
};

/** Diff two Context snapshots by stable segment key, classifying each change. */
export function diffContextSnapshots(before: ContextSnapshot, after: ContextSnapshot): ContextSnapshotDiff {
  const beforeByKey = indexItems(before.items);
  const afterByKey = indexItems(after.items);
  const keys: string[] = [
    ...before.items.map(segmentKey),
    ...after.items.map(segmentKey).filter((key) => !beforeByKey.has(key)),
  ];

  const segments: RequestSegmentDiff[] = [];
  for (const key of keys) {
    const left = beforeByKey.get(key);
    const right = afterByKey.get(key);
    if (left && right) {
      const unchanged = left.contentHash === right.contentHash
        && left.disposition === right.disposition
        && left.kind === right.kind;
      segments.push({
        key,
        kind: right.kind,
        change: unchanged ? 'unchanged' : 'changed',
        reason: reasonFor(right.kind),
        fromHash: left.contentHash,
        toHash: right.contentHash,
        fromCharacters: left.characterCount,
        toCharacters: right.characterCount,
        fromDisposition: left.disposition,
        toDisposition: right.disposition,
      });
      continue;
    }
    if (left) {
      segments.push({
        key,
        kind: left.kind,
        change: 'removed',
        reason: reasonFor(left.kind),
        fromHash: left.contentHash,
        fromCharacters: left.characterCount,
        fromDisposition: left.disposition,
      });
      continue;
    }
    segments.push({
      key,
      kind: right!.kind,
      change: 'added',
      reason: reasonFor(right!.kind),
      toHash: right!.contentHash,
      toCharacters: right!.characterCount,
      toDisposition: right!.disposition,
    });
  }

  const changed = segments.filter((segment) => segment.change !== 'unchanged');
  const reasons = [...new Set(changed.map((segment) => segment.reason))].sort();
  return {
    version: 1,
    identical: changed.length === 0,
    segments,
    changedReasons: reasons,
    stablePrefixLength: stablePrefixLength(before.items, after.items),
    ...(changed[0] ? { firstChangeKey: changed[0].key } : {}),
  };
}

/** Diff two ModelRequest snapshots: the actual outbound request shape and tools. */
export function diffModelRequestSnapshots(
  before: ModelRequestSnapshot,
  after: ModelRequestSnapshot,
): ModelRequestDiff {
  const limit = Math.min(before.messages.length, after.messages.length);
  const messageChanges: ModelMessageDiff[] = [];
  for (let index = 0; index < limit; index += 1) {
    const left = before.messages[index]!;
    const right = after.messages[index]!;
    if (sameMessageShape(left, right)) continue;
    messageChanges.push({ index, role: right.role, change: 'changed', reason: 'history' });
  }
  for (let index = limit; index < before.messages.length; index += 1) {
    messageChanges.push({ index, role: before.messages[index]!.role, change: 'removed', reason: 'history' });
  }
  for (let index = limit; index < after.messages.length; index += 1) {
    messageChanges.push({ index, role: after.messages[index]!.role, change: 'added', reason: 'history' });
  }

  const beforeTools = new Set(before.toolNames);
  const afterTools = new Set(after.toolNames);
  const tools = {
    added: [...afterTools].filter((name) => !beforeTools.has(name)).sort(),
    removed: [...beforeTools].filter((name) => !afterTools.has(name)).sort(),
  };

  const policyFields: ModelRequestDiff['policyFields'] = [];
  if (before.model !== after.model) policyFields.push('model');
  if (before.toolChoice !== after.toolChoice) policyFields.push('toolChoice');
  if (before.temperature !== after.temperature) policyFields.push('temperature');
  if (before.maxOutputTokens !== after.maxOutputTokens) policyFields.push('maxOutputTokens');
  if (before.reasoningEffort !== after.reasoningEffort) policyFields.push('reasoningEffort');
  if (before.thinkingMode !== after.thinkingMode || before.preserveThinking !== after.preserveThinking) {
    policyFields.push('thinking');
  }
  if (before.stream !== after.stream) policyFields.push('stream');

  const payloadChanged = before.payloadHash !== undefined
    && after.payloadHash !== undefined
    && before.payloadHash !== after.payloadHash;
  const reasons: RequestDiffReason[] = [];
  if (messageChanges.length > 0) reasons.push('history');
  if (tools.added.length > 0 || tools.removed.length > 0) reasons.push('tools');
  if (policyFields.length > 0) reasons.push('policy');
  reasons.sort();

  return {
    version: 1,
    identical: messageChanges.length === 0 && policyFields.length === 0 && tools.added.length === 0
      && tools.removed.length === 0 && !payloadChanged,
    payloadChanged,
    messageChanges,
    tools,
    policyFields,
    reasons,
  };
}

function segmentKey(item: ContextSnapshotItem): string {
  return `${item.kind}\u0000${item.id}`;
}

function indexItems(items: ContextSnapshotItem[]): Map<string, ContextSnapshotItem> {
  const indexed = new Map<string, ContextSnapshotItem>();
  for (const item of items) indexed.set(segmentKey(item), item);
  return indexed;
}

function reasonFor(kind: ContextItemKind): RequestDiffReason {
  return KIND_REASONS[kind] ?? 'runtime_fact';
}

function stablePrefixLength(before: ContextSnapshotItem[], after: ContextSnapshotItem[]): number {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit) {
    const left = before[index]!;
    const right = after[index]!;
    if (segmentKey(left) !== segmentKey(right) || left.contentHash !== right.contentHash) break;
    index += 1;
  }
  return index;
}

function sameMessageShape(left: ModelMessageShape, right: ModelMessageShape): boolean {
  return left.role === right.role
    && left.contentKind === right.contentKind
    && left.characterCount === right.characterCount
    && left.contentHash === right.contentHash
    && left.toolCallCount === right.toolCallCount
    && left.toolCallId === right.toolCallId
    && left.toolName === right.toolName
    && left.reasoningHash === right.reasoningHash;
}
