// Deterministically budgets and assembles one model request context, producing
// traceable snapshots without owning the underlying memory or session data.
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  resolveModelContextWindow,
  resolveModelTokenizerCapability,
  type ModelContextWindowCapability,
  type ModelTokenizerCapability,
} from '@littlesheep/config';
import {
  buildOpenAICompatibleChatCompletionsBody,
  type ChatContentPart,
  type ChatMessage,
  type ChatRequest,
} from '@littlesheep/llm';
import type {
  ContextSafetyEstimate,
  ContextItemKind,
  ContextScope,
  ContextSnapshot,
  ContextSnapshotItem,
  ContextSourceRef,
  ModelMessageShape,
  ModelRequestSnapshot,
  SessionId,
  StageName,
} from '@littlesheep/types';

export const MAX_MODEL_REQUEST_SNAPSHOTS_PER_RUN = 64;
export const MAX_SNAPSHOT_MESSAGES = 64;
export const MAX_SNAPSHOT_ITEMS = 64;
export const MAX_SNAPSHOT_TOOLS = 64;
export const DEFAULT_COMPRESSION_THRESHOLD_RATIO = 0.8;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4_096;
export const DEFAULT_IMAGE_PROMPT_TOKEN_SAFETY_RESERVE = 32_768;
export const DEFAULT_REQUEST_PROMPT_TOKEN_SAFETY_RESERVE = 512;
export const DEFAULT_CONTEXT_SAFETY_ESTIMATOR_ID = 'openai-compatible-utf8-bytes-plus-image-reserve-v1';

export interface ExactContextTokenCounter {
  readonly id: string;
  supports(provider: string, model: string): boolean;
  countRequest(request: ChatRequest): number;
}

export interface ContextSafetyEstimator {
  readonly id: string;
  estimatePromptTokens(request: ChatRequest): number;
}

export interface ContextMessageCandidate {
  id: string;
  order: number;
  message: ChatMessage;
  kind: ContextItemKind;
  source: ContextSourceRef;
  priority: number;
  required: boolean;
  sensitive: boolean;
  scope?: ContextScope;
  segments?: ContextMessageSegment[];
}

export interface ContextMessageSegment {
  id: string;
  order: number;
  text: string;
  kind: ContextItemKind;
  source: ContextSourceRef;
  priority: number;
  required: boolean;
  sensitive: boolean;
  scope?: ContextScope;
}

export interface PrepareContextRequestInput {
  runId: string;
  sessionId: SessionId;
  stage: StageName;
  requestIndex: number;
  request: ChatRequest;
  provider?: string;
  candidates?: ContextMessageCandidate[];
  compressionThresholdRatio?: number;
}

export interface PreparedContextRequest {
  request: ChatRequest;
  modelRequestSnapshot: ModelRequestSnapshot;
  contextSnapshot: ContextSnapshot;
  compressionRecommended: boolean;
  omittedCandidateIds: string[];
}

export interface ContextEngineOptions {
  tokenCounter?: ExactContextTokenCounter;
  safetyEstimator?: ContextSafetyEstimator;
  resolveContextWindow?: (
    provider: string,
    model: string,
  ) => ModelContextWindowCapability | undefined;
  resolveTokenizerCapability?: (
    provider: string,
    model: string,
  ) => ModelTokenizerCapability | undefined;
}

export class ContextBudgetExceededError extends Error {
  readonly promptTokens: number;
  readonly availablePromptTokens: number;
  readonly measurement: 'exact' | 'conservative_estimate';

  constructor(
    promptTokens: number,
    availablePromptTokens: number,
    measurement: 'exact' | 'conservative_estimate' = 'exact',
  ) {
    super(measurement === 'exact'
      ? `Required context uses ${promptTokens} tokens but only ${availablePromptTokens} are available.`
      : `Required context exceeds the conservative safety budget (${promptTokens} estimated prompt tokens against ${availablePromptTokens} available).`);
    this.name = 'ContextBudgetExceededError';
    this.promptTokens = promptTokens;
    this.availablePromptTokens = availablePromptTokens;
    this.measurement = measurement;
  }
}

export class ContextSafetyEstimationError extends Error {
  constructor(estimatorId: string, reason: string) {
    super(`Context safety estimator ${estimatorId} failed: ${reason}`);
    this.name = 'ContextSafetyEstimationError';
  }
}

export const defaultContextSafetyEstimator: ContextSafetyEstimator = Object.freeze({
  id: DEFAULT_CONTEXT_SAFETY_ESTIMATOR_ID,
  estimatePromptTokens(request: ChatRequest): number {
    let imageCount = 0;
    const normalizedRequest: ChatRequest = {
      ...request,
      messages: request.messages.map((message) => {
        if (typeof message.content === 'string') return message;
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === 'text') return part;
            imageCount++;
            return {
              type: 'image_url' as const,
              image_url: {
                url: '[image-content-accounted-by-safety-reserve]',
                detail: part.image_url.detail,
              },
            };
          }),
        };
      }),
    };
    const body = buildOpenAICompatibleChatCompletionsBody(
      normalizedRequest,
      true,
      { includeStreamUsage: true },
    );
    const serialized = JSON.stringify(body);
    if (!serialized) throw new Error('request payload could not be serialized');
    return Buffer.byteLength(serialized, 'utf8')
      + DEFAULT_REQUEST_PROMPT_TOKEN_SAFETY_RESERVE
      + imageCount * DEFAULT_IMAGE_PROMPT_TOKEN_SAFETY_RESERVE;
  },
});

export class ContextEngine {
  private readonly tokenCounter?: ExactContextTokenCounter;
  private readonly safetyEstimator: ContextSafetyEstimator;
  private readonly resolveContextWindow: NonNullable<ContextEngineOptions['resolveContextWindow']>;
  private readonly resolveTokenizerCapability: NonNullable<ContextEngineOptions['resolveTokenizerCapability']>;

  constructor(options: ContextEngineOptions = {}) {
    this.tokenCounter = options.tokenCounter;
    this.safetyEstimator = options.safetyEstimator ?? defaultContextSafetyEstimator;
    this.resolveContextWindow = options.resolveContextWindow ?? resolveModelContextWindow;
    this.resolveTokenizerCapability = options.resolveTokenizerCapability ?? resolveModelTokenizerCapability;
  }

  prepare(input: PrepareContextRequestInput): PreparedContextRequest {
    const createdAt = new Date().toISOString();
    const provider = input.provider ?? providerFromModelRef(input.request.model);
    const model = modelFromRef(input.request.model);
    const candidates = normalizeCandidates(
      input.candidates ?? inferCandidates(input.request.messages),
    );
    const capability = this.resolveContextWindow(provider, model);
    const reservedOutputTokens = input.request.max_tokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS;
    const availablePromptTokens = capability
      ? Math.max(0, capability.maxContextTokens - reservedOutputTokens)
      : undefined;
    const compressionThresholdRatio = clampRatio(
      input.compressionThresholdRatio ?? DEFAULT_COMPRESSION_THRESHOLD_RATIO,
    );
    const counterResolution = resolveExactCounter(
      this.resolveTokenizerCapability(provider, model),
      this.tokenCounter,
      provider,
      model,
    );

    const omitted = new Set<string>();
    let request = requestFromCandidates(input.request, candidates, omitted);
    let promptTokens: number | undefined;
    let counterFailure: string | undefined;
    let safetyEstimate: ContextSafetyEstimate | undefined;
    const optional = optionalOmissionUnits(candidates);
    if (counterResolution.counter) {
      try {
        promptTokens = validTokenCount(
          counterResolution.counter.countRequest(request),
          'exact token counter',
        );
        if (availablePromptTokens !== undefined && promptTokens > availablePromptTokens) {
          for (const unit of optional) {
            omitted.add(unit.id);
            request = requestFromCandidates(input.request, candidates, omitted);
            promptTokens = validTokenCount(
              counterResolution.counter.countRequest(request),
              'exact token counter',
            );
            if (promptTokens <= availablePromptTokens) break;
          }
          if (promptTokens > availablePromptTokens) {
            throw new ContextBudgetExceededError(promptTokens, availablePromptTokens);
          }
        }
      } catch (error) {
        if (error instanceof ContextBudgetExceededError) throw error;
        promptTokens = undefined;
        counterFailure = (error as Error).message;
      }
    }

    if (promptTokens === undefined && availablePromptTokens !== undefined) {
      try {
        let estimatedPromptTokens = validTokenCount(
          this.safetyEstimator.estimatePromptTokens(request),
          'context safety estimator',
        );
        if (estimatedPromptTokens > availablePromptTokens) {
          for (const unit of optional) {
            if (omitted.has(unit.id)) continue;
            omitted.add(unit.id);
            request = requestFromCandidates(input.request, candidates, omitted);
            estimatedPromptTokens = validTokenCount(
              this.safetyEstimator.estimatePromptTokens(request),
              'context safety estimator',
            );
            if (estimatedPromptTokens <= availablePromptTokens) break;
          }
          if (estimatedPromptTokens > availablePromptTokens) {
            throw new ContextBudgetExceededError(
              estimatedPromptTokens,
              availablePromptTokens,
              'conservative_estimate',
            );
          }
        }
        safetyEstimate = {
          version: 1,
          source: 'local',
          accuracy: 'conservative',
          purpose: 'overflow_protection',
          provider,
          model,
          estimatorId: this.safetyEstimator.id,
          estimatedPromptTokens,
          calculatedAt: createdAt,
          displayable: false,
        };
      } catch (error) {
        if (error instanceof ContextBudgetExceededError) throw error;
        throw new ContextSafetyEstimationError(this.safetyEstimator.id, (error as Error).message);
      }
    }

    const allItems = candidates.flatMap((candidate) => snapshotItems(
      candidate,
      createdAt,
      omitted,
    ));
    const items = boundedWithFirst(allItems, MAX_SNAPSHOT_ITEMS);
    const budgetMeasurement = promptTokens ?? safetyEstimate?.estimatedPromptTokens;
    const compressionRecommended = budgetMeasurement !== undefined
      && availablePromptTokens !== undefined
      && availablePromptTokens > 0
      && budgetMeasurement / availablePromptTokens >= compressionThresholdRatio;
    const contextSnapshotId = randomUUID();
    const contextSnapshot = deepFreeze<ContextSnapshot>({
      version: 1,
      id: contextSnapshotId,
      runId: input.runId,
      sessionId: input.sessionId,
      provider,
      model,
      createdAt,
      budget: capability
        ? {
            status: 'known',
            maxContextTokens: capability.maxContextTokens,
            reservedOutputTokens,
            availablePromptTokens: availablePromptTokens!,
            compressionThresholdRatio,
          }
        : {
            status: 'unknown',
            reason: `No verified context-window capability is registered for ${provider}/${model}.`,
          },
      items,
      totalItemCount: allItems.length,
      itemsTruncated: allItems.length > items.length,
      compressionRecommended,
      safetyEstimate,
      localTokenLedger: promptTokens === undefined
        ? {
            version: 1,
            source: 'local',
            accuracy: 'unavailable',
            provider,
            model,
            reason: counterFailure
              ? `Exact token counter ${counterResolution.counter?.id ?? 'unknown'} failed: ${counterFailure}`
              : counterResolution.reason,
            countedAt: createdAt,
          }
        : {
            version: 1,
            source: 'local',
            accuracy: 'exact',
            provider,
            model,
            tokenizerId: counterResolution.counter!.id,
            promptTokens,
            countedAt: createdAt,
          },
    });
    const allMessageShapes = request.messages.map(messageShape);
    const messages = boundedWithFirst(allMessageShapes, MAX_SNAPSHOT_MESSAGES);
    const allToolNames = request.tools?.map((tool) => tool.function.name) ?? [];
    const toolNames = allToolNames.slice(0, MAX_SNAPSHOT_TOOLS);
    const modelRequestSnapshot = deepFreeze<ModelRequestSnapshot>({
      version: 1,
      id: randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      stage: input.stage,
      requestIndex: input.requestIndex,
      provider,
      model,
      createdAt,
      messages,
      totalMessageCount: allMessageShapes.length,
      messagesTruncated: allMessageShapes.length > messages.length,
      toolNames,
      totalToolCount: allToolNames.length,
      toolsTruncated: allToolNames.length > toolNames.length,
      toolChoice: toolChoiceLabel(request.tool_choice),
      temperature: request.temperature,
      maxOutputTokens: request.max_tokens,
      reasoningEffort: request.reasoning_effort,
      thinkingMode: request.thinking?.type,
      preserveThinking: request.thinking?.clear_thinking === false ? true : undefined,
      stream: request.stream === true,
      contextSnapshotId,
      payloadHash: hashJson({
        model: request.model,
        messages: allMessageShapes,
        toolNames: allToolNames,
        toolChoice: toolChoiceLabel(request.tool_choice),
        temperature: request.temperature,
        maxOutputTokens: request.max_tokens,
        reasoningEffort: request.reasoning_effort,
        thinking: request.thinking,
        stream: request.stream === true,
      }),
    });
    return {
      request,
      modelRequestSnapshot,
      contextSnapshot,
      compressionRecommended,
      omittedCandidateIds: [...omitted],
    };
  }
}

function optionalOmissionUnits(
  candidates: ContextMessageCandidate[],
): Array<{ id: string; priority: number; order: number }> {
  return candidates.flatMap((candidate) => candidate.segments
    ? candidate.segments
        .filter((segment) => !segment.required)
        .map((segment) => ({ id: segment.id, priority: segment.priority, order: segment.order }))
    : candidate.required
      ? []
      : [{ id: candidate.id, priority: candidate.priority, order: candidate.order }])
    .sort((left, right) => left.priority - right.priority || left.order - right.order || left.id.localeCompare(right.id));
}

function validTokenCount(value: number, source: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${source} returned an invalid value`);
  }
  return value;
}

function resolveExactCounter(
  capability: ModelTokenizerCapability | undefined,
  counter: ExactContextTokenCounter | undefined,
  provider: string,
  model: string,
): { counter?: ExactContextTokenCounter; reason: string } {
  const modelRef = `${provider}/${model}`;
  if (!capability) {
    return { reason: `No tokenizer capability classification is registered for ${modelRef}.` };
  }
  if (capability.status === 'unavailable') {
    return { reason: capability.reason };
  }
  if (!counter) {
    return { reason: `Exact token counter ${capability.counterId} is declared for ${modelRef} but is not registered.` };
  }
  if (counter.id !== capability.counterId) {
    return {
      reason: `Exact token counter mismatch for ${modelRef}: expected ${capability.counterId}, received ${counter.id}.`,
    };
  }
  try {
    if (!counter.supports(provider, model)) {
      return { reason: `Exact token counter ${counter.id} does not support ${modelRef}.` };
    }
  } catch (error) {
    return { reason: `Exact token counter ${counter.id} capability check failed: ${(error as Error).message}` };
  }
  return { counter, reason: '' };
}

function inferCandidates(messages: ChatMessage[]): ContextMessageCandidate[] {
  return messages.map((message, index) => {
    const kind = contextKind(message, index, messages.length);
    const participatesInToolSequence = message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0;
    return {
      id: `message-${index}`,
      order: index,
      message,
      kind,
      source: {
        kind: message.role === 'system'
          ? 'prompt'
          : message.role === 'tool'
            ? 'tool'
            : 'message',
        id: message.tool_call_id ?? `message-${index}`,
      },
      priority: kind === 'system_prompt'
        ? 100
        : kind === 'user_input'
          ? 90
          : participatesInToolSequence
            ? 85
            : 50,
      required: kind === 'system_prompt' || kind === 'user_input' || participatesInToolSequence,
      sensitive: true,
    };
  });
}

function normalizeCandidates(candidates: ContextMessageCandidate[]): ContextMessageCandidate[] {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) throw new Error(`Duplicate context candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    if (candidate.segments) {
      if (typeof candidate.message.content !== 'string') {
        throw new Error(`Segmented context candidate ${candidate.id} must use text content.`);
      }
      const assembled = candidate.segments.map((segment) => segment.text).join('');
      if (assembled !== candidate.message.content) {
        throw new Error(`Segmented context candidate ${candidate.id} does not match its message content.`);
      }
      for (const segment of candidate.segments) {
        if (ids.has(segment.id)) throw new Error(`Duplicate context candidate id: ${segment.id}`);
        ids.add(segment.id);
      }
    }
  }
  return [...candidates].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function requestFromCandidates(
  base: ChatRequest,
  candidates: ContextMessageCandidate[],
  omitted: Set<string>,
): ChatRequest {
  return {
    ...base,
    messages: candidates
      .filter((candidate) => !omitted.has(candidate.id))
      .map((candidate) => candidate.segments
        ? {
            ...candidate.message,
            content: candidate.segments
              .filter((segment) => !omitted.has(segment.id))
              .map((segment) => segment.text)
              .join(''),
          }
        : candidate.message),
  };
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

function contextKind(message: ChatMessage, index: number, total: number): ContextItemKind {
  if (message.role === 'system') return 'system_prompt';
  if (message.role === 'tool') return 'tool_result';
  if (message.role === 'user' && index === total - 1) return 'user_input';
  return 'recent_message';
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

function providerFromModelRef(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : 'unknown';
}

function modelFromRef(model: string): string {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(slash + 1) : model;
}

function boundedWithFirst<T>(values: T[], max: number): T[] {
  if (values.length <= max) return values;
  if (max <= 1) return values.slice(0, max);
  return [values[0]!, ...values.slice(-(max - 1))];
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPRESSION_THRESHOLD_RATIO;
  return Math.min(0.95, Math.max(0.5, value));
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
