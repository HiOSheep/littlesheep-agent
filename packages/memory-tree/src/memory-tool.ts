// @littlesheep/memory-tree - agent-facing index/expand/search tools.

import { z } from 'zod';
import type { AgentTool } from '@littlesheep/types';
import type { BranchIndex, MemoryQueryResult } from './types.js';
import type { MemoryNavigationServiceLike } from './memory-service.js';

const MemoryTreeInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('root_index') }),
  z.object({ action: z.literal('branch_index'), branch: z.string().min(1) }),
  z.object({ action: z.literal('release'), atomIds: z.array(z.string().min(1)).min(1).max(30) }),
  z.object({
    action: z.literal('expand'),
    branch: z.string().min(1),
    nodeId: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(30).optional(),
    tokenBudget: z.number().int().min(64).max(4_000).optional(),
    cursor: z.string().optional(),
    disclosureLevel: z.enum(['D2', 'D3']).optional(),
  }),
  z.object({
    action: z.literal('deep_search'),
    query: z.string().min(1),
    branch: z.string().min(1),
    limit: z.number().int().min(1).max(30).optional(),
    tokenBudget: z.number().int().min(64).max(4_000).optional(),
    cursor: z.string().optional(),
    subtreeRootId: z.string().min(1).optional(),
  }),
]);

const CompatibilitySearchInput = z.object({
  query: z.string().min(1),
  branch: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(30).optional(),
});

const CompatibilityDeepSearchInput = z.object({
  query: z.string().min(1),
  branch: z.string().min(1),
  limit: z.number().int().min(1).max(30).optional(),
  tokenBudget: z.number().int().min(64).max(4_000).optional(),
  subtreeRootId: z.string().min(1).optional(),
});

export interface MemoryToolOptions {
  /** Existing read-side trust envelope, applied to the complete tool payload. */
  envelope?: (content: string) => string;
}

function renderIndex(index: BranchIndex): string {
  const lines = [
    `# ${index.displayName}`,
    index.summary,
    `Source: ${index.source}`,
    '',
    ...index.entries.map((entry) => {
      const children = entry.hasChildren ? ' -> has child index' : '';
      const keys = entry.searchKeys?.length ? `; keys: ${entry.searchKeys.join(', ')}` : '';
      const evidence = entry.evidence
        ? `; evidence=${entry.evidence.disclosureLevel}/${entry.evidence.statementKind}/${entry.evidence.epistemicStatus}; authority=${entry.evidence.authorityScope.kind}; atom=${entry.evidence.atomId}@${entry.evidence.atomRevision}`
        : '';
      return `- [${entry.id}] ${entry.title}: ${entry.summary}${children}${keys}${evidence}`;
    }),
  ];
  if (index.truncated) lines.push('', `Index bounded. Continue with cursor: ${index.nextCursor ?? '(narrow the query)'}`);
  return lines.join('\n');
}

function renderQuery(result: MemoryQueryResult): string {
  const lines = [
    `# Memory ${result.action === 'expand' ? 'Expansion' : 'Deep Search'}`,
    `Budget: ${result.tokensUsed}/${result.tokenBudget} tokens; duplicates skipped: ${result.dedupedCount}.`,
  ];
  if (result.fragments.length === 0) lines.push('', 'No new matching memory fragments were returned.');
  for (const fragment of result.fragments) {
    lines.push(
      '',
      `## [${fragment.id}] T${fragment.tier} - ${fragment.matchReason}`,
      `Source: ${fragment.metadata.source} (${fragment.metadata.kind}); generated: ${fragment.metadata.generatedAt}`,
      ...(fragment.evidence ? [
        `Evidence: ${fragment.evidence.disclosureLevel}; ${fragment.evidence.statementKind}/${fragment.evidence.epistemicStatus}; authority=${fragment.evidence.authorityScope.kind}; boundary=${fragment.evidence.conflict ? 'conflicted' : 'contextual'}`,
      ] : []),
      fragment.content,
    );
  }
  if (result.childIndex?.length) {
    lines.push('', '# Child Index');
    for (const entry of result.childIndex) lines.push(`- [${entry.id}] ${entry.title}: ${entry.summary}`);
  }
  if (result.truncated) {
    lines.push('', `Result bounded. Continue with cursor ${result.nextCursor ?? '(narrow the branch/query)'} instead of assuming the branch is exhausted.`);
  }
  for (const error of result.errors) lines.push('', `Degraded source ${error.branchId}: ${error.message}`);
  return lines.join('\n');
}

function envelope(content: string, options: MemoryToolOptions): string {
  return options.envelope ? options.envelope(content) : content;
}

function queryMeta(action: string, branch: string, result: MemoryQueryResult): Record<string, unknown> {
  return {
    action,
    branch,
    fragments: result.fragments.length,
    tokensUsed: result.tokensUsed,
    truncated: result.truncated,
    memoryKnownState: result.knownState,
    memoryKnownStateDelta: result.knownStateDelta,
    memoryFragmentIds: result.fragments.map((fragment) => fragment.evidence?.atomId ?? fragment.id),
  };
}

export function createMemoryTreeTool(memory: MemoryNavigationServiceLike, options: MemoryToolOptions = {}): AgentTool {
  return {
    name: 'memory_tree',
    description:
      'Navigate persistent memory in order: root index, branch_index, expand a node/query, then branch-scoped deep_search only if needed. ' +
      'The runtime rejects skipped levels. Atoms returned by expand or deep_search enter this run\'s active Context working set. ' +
      'Use release when an active atom no longer helps; release affects only this run and never changes raw records or persistent atom projections. ' +
      'Results are budgeted, deduplicated and source-traced per run.',
    inputSchema: MemoryTreeInput,
    async execute(input, ctx) {
      const startedAt = Date.now();
      try {
        const parsed = MemoryTreeInput.parse(input);
        let output: string;
        let meta: Record<string, unknown>;
        switch (parsed.action) {
          case 'root_index':
            output = await memory.rootIndex();
            meta = { action: parsed.action };
            break;
          case 'branch_index': {
            const index = await memory.branchIndex(ctx.runId, parsed.branch);
            output = renderIndex(index);
            meta = {
              action: parsed.action,
              branch: parsed.branch,
              entries: index.entries.length,
              truncated: index.truncated,
              memoryKnownState: index.knownState,
            };
            break;
          }
          case 'release': {
            if (!memory.release) throw new Error('This runtime does not support run-scoped memory release.');
            const result = await memory.release(ctx.runId, parsed.atomIds);
            output = [
              '# Memory Context Release',
              `Released: ${result.releasedAtomIds.join(', ') || 'none'}.`,
              `Not active: ${result.notActiveAtomIds.join(', ') || 'none'}.`,
              `Freed memory budget: ${result.freedTokens} tokens.`,
            ].join('\n');
            meta = {
              action: parsed.action,
              memoryContextAction: 'release',
              memoryReleasedAtomIds: result.releasedAtomIds,
              memoryNotActiveAtomIds: result.notActiveAtomIds,
              memoryKnownState: result.knownState,
              memoryKnownStateDelta: result.knownStateDelta,
            };
            break;
          }
          case 'expand': {
            const result = await memory.expand(ctx.runId, {
              branchId: parsed.branch,
              nodeId: parsed.nodeId,
              query: parsed.query,
              limit: parsed.limit,
              tokenBudget: parsed.tokenBudget,
              cursor: parsed.cursor,
              disclosureLevel: parsed.disclosureLevel,
            });
            output = renderQuery(result);
            meta = queryMeta(parsed.action, parsed.branch, result);
            break;
          }
          case 'deep_search': {
            const result = await memory.deepSearch(ctx.runId, {
              query: parsed.query,
              branchId: parsed.branch,
              limit: parsed.limit,
              tokenBudget: parsed.tokenBudget,
              cursor: parsed.cursor,
              subtreeRootId: parsed.subtreeRootId,
            });
            output = renderQuery(result);
            meta = queryMeta(parsed.action, parsed.branch, result);
            break;
          }
        }
        return { callId: '', ok: true, output: envelope(output, options), durationMs: Date.now() - startedAt, meta };
      } catch (error) {
        return { callId: '', ok: false, error: (error as Error).message, durationMs: Date.now() - startedAt };
      }
    },
  };
}

/** Keeps old calls safe by turning them into index navigation, never a direct content search. */
export function createMemorySearchCompatibilityTool(
  memory: MemoryNavigationServiceLike,
  options: MemoryToolOptions = {},
): AgentTool {
  return {
    name: 'memory_search',
    description: 'Compatibility index navigator. Without branch it returns the root index; with branch it returns that branch index. It never searches memory content directly.',
    inputSchema: CompatibilitySearchInput,
    async execute(input, ctx) {
      const startedAt = Date.now();
      try {
        const parsed = CompatibilitySearchInput.parse(input);
        if (!parsed.branch) {
          const output = [
            await memory.rootIndex(),
            '',
            `No memory content was searched for "${parsed.query}". Choose one branch, then call memory_search with that branch or memory_tree branch_index.`,
          ].join('\n');
          return {
            callId: '',
            ok: true,
            output: envelope(output, options),
            durationMs: Date.now() - startedAt,
            meta: { action: 'root_index', searched: false, nextAction: 'branch_index' },
          };
        }
        const index = await memory.branchIndex(ctx.runId, parsed.branch);
        const output = [
          renderIndex(index),
          '',
          `No memory content was searched for "${parsed.query}". Next, call memory_tree expand on branch "${parsed.branch}" with a relevant nodeId or this query.`,
        ].join('\n');
        return {
          callId: '',
          ok: true,
          output: envelope(output, options),
          durationMs: Date.now() - startedAt,
          meta: {
            action: 'branch_index',
            branch: parsed.branch,
            searched: false,
            entries: index.entries.length,
            truncated: index.truncated,
            nextAction: 'expand',
            memoryKnownState: index.knownState,
          },
        };
      } catch (error) {
        return { callId: '', ok: false, error: (error as Error).message, durationMs: Date.now() - startedAt };
      }
    },
  };
}

/** Dedicated compatibility name for the same branch-scoped v3 deep-search path. */
export function createMemoryDeepSearchCompatibilityTool(
  memory: MemoryNavigationServiceLike,
  options: MemoryToolOptions = {},
): AgentTool {
  return {
    name: 'memory_deep_search',
    description:
      'Search only one already indexed and expanded memory branch or subtree. ' +
      'Uses the Memory v3 Catalog hierarchy, FTS and local vector candidates under the same budgets and access ledger.',
    inputSchema: CompatibilityDeepSearchInput,
    async execute(input, ctx) {
      const startedAt = Date.now();
      try {
        const parsed = CompatibilityDeepSearchInput.parse(input);
        const result = await memory.deepSearch(ctx.runId, {
          query: parsed.query,
          branchId: parsed.branch,
          limit: parsed.limit,
          tokenBudget: parsed.tokenBudget,
          subtreeRootId: parsed.subtreeRootId,
        });
        return {
          callId: '',
          ok: true,
          output: envelope(renderQuery(result), options),
          durationMs: Date.now() - startedAt,
          meta: queryMeta('deep_search', parsed.branch, result),
        };
      } catch (error) {
        return { callId: '', ok: false, error: (error as Error).message, durationMs: Date.now() - startedAt };
      }
    },
  };
}
