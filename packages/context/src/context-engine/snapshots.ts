// Builds bounded, content-hashed Context and model request evidence snapshots.
import { createHash, randomUUID } from 'node:crypto';
import type { ModelContextWindowCapability } from '@littlesheep/config';
import type {
  ChatContentPart,
  ChatMessage,
  ChatRequest,
} from '@littlesheep/llm';
import type {
  ContextSafetyEstimate,
  ContextSnapshot,
  ContextSnapshotItem,
  LlmCallContract,
  ModelMessageShape,
  ModelRequestSnapshot,
  SessionId,
  StageName,
} from '@littlesheep/types';
import type { ContextMessageCandidate } from './contracts.js';
import {
  MAX_SNAPSHOT_ITEMS,
  MAX_SNAPSHOT_MESSAGES,
  MAX_SNAPSHOT_TOOLS,
} from './contracts.js';

export interface BuildContextSnapshotInput {
  runId: string;
  sessionId: SessionId;
  provider: string;
  model: string;
  createdAt: string;
  capability?: ModelContextWindowCapability;
  reservedOutputTokens: number;
  availablePromptTokens?: number;
  compressionThresholdRatio: number;
  candidates: ContextMessageCandidate[];
  omitted: Set<string>;
  compressionRecommended: boolean;
  safetyEstimate?: ContextSafetyEstimate;
  promptTokens?: number;
  exactCounterId?: string;
  unavailableCounterReason: string;
}

export interface BuildModelRequestSnapshotInput {
  runId: string;
  sessionId: SessionId;
  stage: StageName;
  requestIndex: number;
  provider: string;
  model: string;
  createdAt: string;
  request: ChatRequest;
  contextSnapshotId: string;
  callContract?: LlmCallContract;
}

export function buildContextSnapshot(input: BuildContextSnapshotInput): ContextSnapshot {
  const allItems = input.candidates.flatMap((candidate) => snapshotItems(
    candidate,
    input.createdAt,
    input.omitted,
  ));
  const items = boundedWithFirst(allItems, MAX_SNAPSHOT_ITEMS);
  return deepFreeze<ContextSnapshot>({
    version: 1,
    id: randomUUID(),
    runId: input.runId,
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
    createdAt: input.createdAt,
    budget: input.capability
      ? {
          status: 'known',
          maxContextTokens: input.capability.maxContextTokens,
          reservedOutputTokens: input.reservedOutputTokens,
          availablePromptTokens: input.availablePromptTokens!,
          compressionThresholdRatio: input.compressionThresholdRatio,
        }
      : {
          status: 'unknown',
          reason: `No verified context-window capability is registered for ${input.provider}/${input.model}.`,
        },
    items,
    totalItemCount: allItems.length,
    itemsTruncated: allItems.length > items.length,
    compressionRecommended: input.compressionRecommended,
    safetyEstimate: input.safetyEstimate,
    localTokenLedger: input.promptTokens === undefined
      ? {
          version: 1,
          source: 'local',
          accuracy: 'unavailable',
          provider: input.provider,
          model: input.model,
          reason: input.unavailableCounterReason,
          countedAt: input.createdAt,
        }
      : {
          version: 1,
          source: 'local',
          accuracy: 'exact',
          provider: input.provider,
          model: input.model,
          tokenizerId: input.exactCounterId!,
          promptTokens: input.promptTokens,
          countedAt: input.createdAt,
        },
  });
}

export function buildModelRequestSnapshot(input: BuildModelRequestSnapshotInput): ModelRequestSnapshot {
  const allMessageShapes = input.request.messages.map(messageShape);
  const messages = boundedWithFirst(allMessageShapes, MAX_SNAPSHOT_MESSAGES);
  const allToolNames = input.request.tools?.map((tool) => tool.function.name) ?? [];
  const toolNames = allToolNames.slice(0, MAX_SNAPSHOT_TOOLS);
  return deepFreeze<ModelRequestSnapshot>({
    version: 1,
    id: randomUUID(),
    runId: input.runId,
    sessionId: input.sessionId,
    stage: input.stage,
    requestIndex: input.requestIndex,
    provider: input.provider,
    model: input.model,
    createdAt: input.createdAt,
    messages,
    totalMessageCount: allMessageShapes.length,
    messagesTruncated: allMessageShapes.length > messages.length,
    toolNames,
    totalToolCount: allToolNames.length,
    toolsTruncated: allToolNames.length > toolNames.length,
    toolChoice: toolChoiceLabel(input.request.tool_choice),
    temperature: input.request.temperature,
    maxOutputTokens: input.request.max_tokens,
    reasoningEffort: input.request.reasoning_effort,
    thinkingMode: input.request.thinking?.type,
    preserveThinking: input.request.thinking?.clear_thinking === false ? true : undefined,
    stream: input.request.stream === true,
    callContract: input.callContract,
    contextSnapshotId: input.contextSnapshotId,
    payloadHash: hashJson({
      model: input.request.model,
      messages: allMessageShapes,
      toolNames: allToolNames,
      toolChoice: toolChoiceLabel(input.request.tool_choice),
      temperature: input.request.temperature,
      maxOutputTokens: input.request.max_tokens,
      reasoningEffort: input.request.reasoning_effort,
      thinking: input.request.thinking,
      stream: input.request.stream === true,
    }),
  });
}

function snapshotItems(
  candidate: ContextMessageCandidate,
  createdAt: string,
  omitted: Set<string>,
): ContextSnapshotItem[] {
  if (candidate.segments) {
    return candidate.segments.map((segment) => ({
      id: segment.id,
      kind: segment.kind,
      scope: segment.scope ?? 'run',
      source: segment.source,
      priority: segment.priority,
      required: segment.required,
      sensitive: segment.sensitive,
      createdAt,
      contentType: 'text' as const,
      contentHash: hashText(segment.text),
      characterCount: segment.text.length,
      disposition: omitted.has(segment.id) ? 'omitted' as const : 'included' as const,
      omissionReason: omitted.has(segment.id) ? 'budget' as const : undefined,
    }));
  }
  const candidateOmitted = omitted.has(candidate.id);
  const disposition = candidateOmitted ? 'omitted' as const : 'included' as const;
  const omissionReason = candidateOmitted ? 'budget' as const : undefined;
  if (typeof candidate.message.content === 'string') {
    return [{
      id: candidate.id,
      kind: candidate.kind,
      scope: candidate.scope ?? 'run',
      source: candidate.source,
      priority: candidate.priority,
      required: candidate.required,
      sensitive: candidate.sensitive,
      createdAt,
      contentType: 'text',
      contentHash: hashText(candidate.message.content),
      characterCount: candidate.message.content.length,
      disposition,
      omissionReason,
    }];
  }
  return candidate.message.content.map((part, partIndex) => {
    const id = `${candidate.id}-part-${partIndex}`;
    if (part.type === 'text') {
      return {
        id,
        kind: candidate.kind,
        scope: candidate.scope ?? 'run',
        source: candidate.source,
        priority: candidate.priority,
        required: candidate.required,
        sensitive: candidate.sensitive,
        createdAt,
        contentType: 'text',
        contentHash: hashText(part.text),
        characterCount: part.text.length,
        disposition,
        omissionReason,
      } satisfies ContextSnapshotItem;
    }
    return {
      id,
      kind: 'attachment_manifest',
      scope: candidate.scope ?? 'run',
      source: { kind: 'attachment', id },
      priority: candidate.priority,
      required: candidate.required,
      sensitive: true,
      createdAt,
      contentType: 'image_ref',
      contentHash: hashJson(normalizeImageRef(part.image_url.url)),
      disposition,
      omissionReason,
    } satisfies ContextSnapshotItem;
  });
}

function messageShape(message: ChatMessage): ModelMessageShape {
  if (typeof message.content === 'string') {
    return {
      role: message.role,
      contentKind: 'text',
      characterCount: message.content.length,
      contentHash: hashText(message.content),
      toolCallCount: message.tool_calls?.length ?? 0,
      toolCallId: message.tool_call_id,
      toolName: message.name,
      reasoningCharacterCount: message.reasoning_content?.length,
      reasoningHash: message.reasoning_content ? hashText(message.reasoning_content) : undefined,
    };
  }
  const normalized = message.content.map(normalizePartForHash);
  return {
    role: message.role,
    contentKind: 'multipart',
    characterCount: message.content.reduce(
      (total, part) => total + (part.type === 'text' ? part.text.length : 0),
      0,
    ),
    contentHash: hashJson(normalized),
    partTypes: message.content.map((part) => part.type),
    toolCallCount: message.tool_calls?.length ?? 0,
    toolCallId: message.tool_call_id,
    toolName: message.name,
    reasoningCharacterCount: message.reasoning_content?.length,
    reasoningHash: message.reasoning_content ? hashText(message.reasoning_content) : undefined,
  };
}

function normalizePartForHash(part: ChatContentPart): Record<string, unknown> {
  return part.type === 'text'
    ? { type: 'text', hash: hashText(part.text), characters: part.text.length }
    : { type: 'image_url', ...normalizeImageRef(part.image_url.url), detail: part.image_url.detail };
}

function normalizeImageRef(url: string): { scheme: string; mediaType?: string; referenceLength: number } {
  const dataMatch = url.match(/^data:([^;,]+)[;,]/i);
  if (dataMatch) return { scheme: 'data', mediaType: dataMatch[1], referenceLength: url.length };
  const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*):/i);
  return { scheme: schemeMatch?.[1]?.toLowerCase() ?? 'relative', referenceLength: url.length };
}

function toolChoiceLabel(choice: ChatRequest['tool_choice']): string | undefined {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  return `function:${choice.function.name}`;
}

function boundedWithFirst<T>(values: T[], max: number): T[] {
  if (values.length <= max) return values;
  if (max <= 1) return values.slice(0, max);
  return [values[0]!, ...values.slice(-(max - 1))];
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashJson(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? '[undefined]';
  } catch {
    serialized = '[non-serializable]';
  }
  return hashText(serialized);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
