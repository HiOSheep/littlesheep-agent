import type { ContextItemKind, ContextScope, ContextSnapshot, ContextSourceKind, ModelRequestSnapshot } from '@littlesheep/types';

const KINDS: readonly ContextItemKind[] = [
  'system_prompt', 'user_input', 'recent_message', 'summary_memory', 'memory_index',
  'memory_fragment', 'project_knowledge', 'tool_result', 'workflow_state',
  'output_constraint', 'attachment_manifest', 'runtime_event',
];
const SCOPES: readonly ContextScope[] = ['run', 'session', 'project', 'workspace', 'global'];
const SOURCE_KINDS: readonly ContextSourceKind[] = ['prompt', 'message', 'memory', 'tool', 'workflow', 'attachment', 'runtime_event', 'configuration'];

export interface ContextTraceSource {
  kind: ContextItemKind;
  scope: ContextScope;
  /** Only finite source categories; never source ids, names or paths. */
  sourceKinds?: ContextSourceKind[];
  includedItems: number;
  omittedItems: number;
  /** UTF-16 code units, not tokens or wire bytes. */
  includedCharacters: number;
  omittedCharacters: number;
  includedCharactersUnavailable?: boolean;
  omittedCharactersUnavailable?: boolean;
}

/** Content-free, on-demand projection of existing request evidence. No new store. */
export interface ContextTrace {
  version: 1;
  boundary: 'prepared_chat_request';
  requestIndex: number;
  sources: ContextTraceSource[];
  coverage: {
    items: 'complete' | 'partial';
    messages: 'complete' | 'partial';
    tools: 'complete' | 'partial';
    rejectedItems: number;
    /** Existing snapshots do not measure native tool schemas or per-source tokens. */
    sourceTokens: 'unavailable';
    toolSchemaSize: 'unavailable';
  };
  messageCount: number;
  toolCount: number;
  tokens: {
    local: { status: 'exact'; promptTokens: number } | { status: 'unavailable' };
    provider: { status: 'reported'; promptTokens: number; completionTokens: number;
      cachedPromptTokens?: number; uncachedPromptTokens?: number; cacheWriteTokens?: number;
      reasoningTokens?: number } | { status: 'unavailable' };
  };
  compressionRecommended: boolean;
}

/**
 * Call only after the owner has authorized access to the run/session. The join is
 * checked here, but this helper cannot grant access. Never spread snapshot/source
 * objects: ids, paths, hashes, names and free-text reasons may contain private data.
 */
export function buildContextTrace(
  snapshot: ContextSnapshot,
  request: ModelRequestSnapshot,
): ContextTrace | undefined {
  if (snapshot.id !== request.contextSnapshotId || snapshot.runId !== request.runId
    || snapshot.sessionId !== request.sessionId || snapshot.provider !== request.provider
    || snapshot.model !== request.model) return undefined;
  const sources = new Map<string, ContextTraceSource>();
  let rejectedItems = 0;
  for (const item of snapshot.items) {
    if (!KINDS.includes(item.kind) || !SCOPES.includes(item.scope)
      || (item.disposition !== 'included' && item.disposition !== 'omitted')) {
      rejectedItems++;
      continue;
    }
    const key = `${item.kind}:${item.scope}`;
    const source = sources.get(key) ?? {
      kind: item.kind, scope: item.scope, includedItems: 0, omittedItems: 0,
      includedCharacters: 0, omittedCharacters: 0,
      sourceKinds: [],
    };
    const countedCharacters = count(item.characterCount);
    const characters = countedCharacters ?? 0;
    if (SOURCE_KINDS.includes(item.source?.kind) && !source.sourceKinds?.includes(item.source.kind)) {
      source.sourceKinds?.push(item.source.kind);
    }
    if (item.disposition === 'included') {
      if (countedCharacters === undefined) source.includedCharactersUnavailable = true;
      source.includedItems++;
      source.includedCharacters += characters;
    } else {
      if (countedCharacters === undefined) source.omittedCharactersUnavailable = true;
      source.omittedItems++;
      source.omittedCharacters += characters;
    }
    sources.set(key, source);
  }
  const local = snapshot.localTokenLedger;
  const usage = snapshot.providerUsage;
  const promptTokens = count(usage?.promptTokens);
  const completionTokens = count(usage?.completionTokens);
  return {
    version: 1,
    boundary: 'prepared_chat_request',
    requestIndex: count(request.requestIndex) ?? 0,
    sources: [...sources.values()],
    coverage: {
      items: snapshot.itemsTruncated || rejectedItems > 0 ? 'partial' : 'complete',
      messages: request.messagesTruncated ? 'partial' : 'complete',
      tools: request.toolsTruncated ? 'partial' : 'complete',
      rejectedItems, sourceTokens: 'unavailable', toolSchemaSize: 'unavailable',
    },
    messageCount: count(request.totalMessageCount) ?? 0,
    toolCount: count(request.totalToolCount) ?? 0,
    tokens: {
      local: local?.accuracy === 'exact' && count(local.promptTokens) !== undefined
        ? { status: 'exact', promptTokens: local.promptTokens } : { status: 'unavailable' },
      provider: promptTokens !== undefined && completionTokens !== undefined
        ? {
            status: 'reported', promptTokens, completionTokens,
            cachedPromptTokens: subset(usage?.cachedPromptTokens, promptTokens),
            uncachedPromptTokens: subset(usage?.uncachedPromptTokens, promptTokens),
            cacheWriteTokens: subset(usage?.cacheWriteTokens, promptTokens),
            reasoningTokens: subset(usage?.reasoningTokens, completionTokens),
          }
        : { status: 'unavailable' },
    },
    compressionRecommended: snapshot.compressionRecommended === true,
  };
}

function count(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function subset(value: number | undefined, total: number): number | undefined {
  const valid = count(value);
  return valid !== undefined && valid <= total ? valid : undefined;
}
