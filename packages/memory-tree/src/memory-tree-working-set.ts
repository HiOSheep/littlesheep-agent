// Owns the bounded set of memory atoms currently admitted to one Agent run.

import type {
  MemoryAccessLedger,
  MemoryBranchContext,
  MemoryFragment,
  MemoryIndexEntry,
  MemoryReleaseResult,
} from './types.js';
import { fragmentIndexEntry } from './memory-tree-evidence.js';
import { cloneMemoryKnownState, updateMemoryKnownState } from './known-state.js';
import { estimateTokens } from './util.js';

export interface ActiveMemoryRun {
  context: MemoryBranchContext;
  ledger: MemoryAccessLedger;
  branchTokens: Map<string, number>;
  dedupKeys: Set<string>;
  activeFragments: Map<string, { dedupKey: string; branchId: string; tokens: number }>;
}

export interface MemoryWorkingSetConfig {
  perBranchTokenBudget: number;
  sanitize?: (content: string) => string;
}

export interface MemoryFragmentSelection {
  fragments: MemoryFragment[];
  excluded: Array<{ fragment: MemoryFragment; reason: string }>;
  overflowIndex: MemoryIndexEntry[];
  tokensUsed: number;
  dedupedCount: number;
  truncated: boolean;
}

export function totalWorkingSetRemaining(run: ActiveMemoryRun): number {
  return Math.max(0, run.ledger.totalTokenBudget - run.ledger.tokensUsed);
}

export function availableWorkingSetBudget(
  run: ActiveMemoryRun,
  branchId: string,
  requested: number,
  config: MemoryWorkingSetConfig,
): number {
  const branchUsed = run.branchTokens.get(branchId) ?? 0;
  const branchRemaining = Math.max(0, config.perBranchTokenBudget - branchUsed);
  return Math.max(0, Math.min(requested, branchRemaining, totalWorkingSetRemaining(run)));
}

export function consumeWorkingSetTokens(run: ActiveMemoryRun, branchId: string, tokens: number): void {
  run.ledger.tokensUsed += tokens;
  run.branchTokens.set(branchId, (run.branchTokens.get(branchId) ?? 0) + tokens);
}

export function selectBranchWorkingSet(
  run: ActiveMemoryRun,
  branchId: string,
  fragments: MemoryFragment[],
  budget: number,
  config: MemoryWorkingSetConfig,
): MemoryFragmentSelection {
  const ordered = fragments
    .map((fragment) => sanitizeFragment({ ...fragment, branchId }, config))
    .sort((left, right) => right.priority - left.priority || left.tokenEstimate - right.tokenEstimate);
  const selected: MemoryFragment[] = [];
  const excluded: MemoryFragmentSelection['excluded'] = [];
  const overflowIndex: MemoryIndexEntry[] = [];
  let used = 0;
  let dedupedCount = 0;
  let truncated = false;

  for (const fragment of ordered) {
    if (run.dedupKeys.has(fragment.dedupKey)) {
      dedupedCount += 1;
      excluded.push({ fragment, reason: 'Duplicate evidence was already adopted earlier in this run.' });
      continue;
    }
    const remaining = budget - used;
    if (remaining <= 0) {
      truncated = true;
      excluded.push({ fragment, reason: 'Run or branch memory budget was exhausted.' });
      break;
    }
    if (fragment.tokenEstimate > remaining) {
      overflowIndex.push(fragmentIndexEntry(fragment));
      excluded.push({ fragment, reason: 'Atom content exceeded the remaining memory token budget.' });
      truncated = true;
      continue;
    }
    selected.push(fragment);
    used += fragment.tokenEstimate;
    run.dedupKeys.add(fragment.dedupKey);
    trackActiveFragment(run, fragment);
  }
  run.ledger.dedupKeys = [...run.dedupKeys];
  consumeWorkingSetTokens(run, branchId, used);
  return { fragments: selected, excluded, overflowIndex, tokensUsed: used, dedupedCount, truncated };
}

export function selectMixedWorkingSet(
  run: ActiveMemoryRun,
  fragments: MemoryFragment[],
  budget: number,
  limit: number,
  config: MemoryWorkingSetConfig,
): MemoryFragmentSelection {
  const ordered = fragments
    .map((fragment) => sanitizeFragment(fragment, config))
    .sort((left, right) => right.priority - left.priority || left.tokenEstimate - right.tokenEstimate);
  const selected: MemoryFragment[] = [];
  const excluded: MemoryFragmentSelection['excluded'] = [];
  const overflowIndex: MemoryIndexEntry[] = [];
  const consumedByBranch = new Map<string, number>();
  let tokensUsed = 0;
  let dedupedCount = 0;
  let truncated = false;

  for (const fragment of ordered) {
    if (run.dedupKeys.has(fragment.dedupKey)) {
      dedupedCount += 1;
      excluded.push({ fragment, reason: 'Duplicate evidence was already adopted earlier in this run.' });
      continue;
    }
    if (selected.length >= limit) {
      overflowIndex.push(fragmentIndexEntry(fragment));
      excluded.push({ fragment, reason: 'Result limit excluded this lower-priority candidate.' });
      truncated = true;
      continue;
    }
    const branchRemaining = availableWorkingSetBudget(run, fragment.branchId, budget, config)
      - (consumedByBranch.get(fragment.branchId) ?? 0);
    const remaining = Math.min(budget - tokensUsed, branchRemaining);
    if (fragment.tokenEstimate > remaining) {
      overflowIndex.push(fragmentIndexEntry(fragment));
      excluded.push({ fragment, reason: 'Atom content exceeded the remaining memory token budget.' });
      truncated = true;
      continue;
    }
    selected.push(fragment);
    tokensUsed += fragment.tokenEstimate;
    consumedByBranch.set(fragment.branchId, (consumedByBranch.get(fragment.branchId) ?? 0) + fragment.tokenEstimate);
    run.dedupKeys.add(fragment.dedupKey);
    trackActiveFragment(run, fragment);
  }
  for (const [branchId, tokens] of consumedByBranch) consumeWorkingSetTokens(run, branchId, tokens);
  run.ledger.dedupKeys = [...run.dedupKeys];
  return { fragments: selected, excluded, overflowIndex, tokensUsed, dedupedCount, truncated };
}

export function releaseWorkingSetAtoms(
  run: ActiveMemoryRun,
  atomIds: string[],
): MemoryReleaseResult & { requestedCount: number } {
  const requested = [...new Set(atomIds.map((atomId) => atomId.trim()).filter(Boolean))].slice(0, 30);
  const releasedAtomIds: string[] = [];
  const notActiveAtomIds: string[] = [];
  let freedTokens = 0;
  for (const atomId of requested) {
    const active = run.activeFragments.get(atomId);
    if (!active) {
      notActiveAtomIds.push(atomId);
      continue;
    }
    run.activeFragments.delete(atomId);
    run.dedupKeys.delete(active.dedupKey);
    const branchUsed = run.branchTokens.get(active.branchId) ?? 0;
    run.branchTokens.set(active.branchId, Math.max(0, branchUsed - active.tokens));
    run.ledger.tokensUsed = Math.max(0, run.ledger.tokensUsed - active.tokens);
    freedTokens += active.tokens;
    releasedAtomIds.push(atomId);
  }
  run.ledger.dedupKeys = [...run.dedupKeys];
  const references = new Map(run.ledger.knownState.references.map((reference) => [reference.atomId, reference]));
  const knownStateDelta = updateMemoryKnownState(
    run.ledger.knownState,
    releasedAtomIds.flatMap((atomId) => {
      const reference = references.get(atomId);
      return reference ? [{
        envelope: reference.envelope,
        decision: 'excluded' as const,
        reason: 'Released from the current run context by an explicit model decision.',
        stage: 'context-release',
      }] : [];
    }),
    new Date().toISOString(),
  );
  return {
    requestedCount: requested.length,
    releasedAtomIds,
    notActiveAtomIds,
    freedTokens,
    knownState: cloneMemoryKnownState(run.ledger.knownState),
    knownStateDelta,
  };
}

function sanitizeFragment(fragment: MemoryFragment, config: MemoryWorkingSetConfig): MemoryFragment {
  const content = config.sanitize ? config.sanitize(fragment.content) : fragment.content;
  return { ...fragment, content, tokenEstimate: estimateTokens(content) };
}

function trackActiveFragment(run: ActiveMemoryRun, fragment: MemoryFragment): void {
  const atomId = fragment.evidence?.atomId ?? fragment.id;
  run.activeFragments.set(atomId, {
    dedupKey: fragment.dedupKey,
    branchId: fragment.branchId,
    tokens: fragment.tokenEstimate,
  });
}
