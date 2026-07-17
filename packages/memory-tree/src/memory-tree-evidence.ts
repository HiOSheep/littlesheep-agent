// Converts selected and omitted v3 memory evidence into KnownState and Catalog access observations.

import type {
  LogFn,
  MemoryBranch,
  MemoryBranchAccessObservation,
  MemoryBranchContext,
  MemoryFragment,
  MemoryIndexEntry,
} from './types.js';
import { estimateTokens } from './util.js';
import type { KnownStateMemoryReference, MemoryKnownState } from './v3/contracts.js';
import { updateMemoryKnownState, type KnownStateUpdate } from './known-state.js';

export interface FragmentEvidenceSelection {
  fragments: MemoryFragment[];
  excluded: Array<{ fragment: MemoryFragment; reason: string }>;
}

export function indexEvidenceUpdates(
  rawEntries: MemoryIndexEntry[],
  selectedEntries: MemoryIndexEntry[],
): { updates: KnownStateUpdate[]; observations: MemoryBranchAccessObservation[] } {
  const selectedIds = new Set(selectedEntries.map((entry) => entry.id));
  const updates: KnownStateUpdate[] = [];
  const observations: MemoryBranchAccessObservation[] = [];
  for (const entry of rawEntries) {
    if (!entry.evidence) continue;
    const enteredContext = selectedIds.has(entry.id);
    const envelope = enteredContext
      ? structuredClone(entry.evidence)
      : { ...structuredClone(entry.evidence), truncated: true };
    const decision = envelope.conflict ? 'conflicted' : enteredContext ? 'adopted' : 'excluded';
    const reason = envelope.conflict
      ? 'D1 metadata exposed an unresolved or disputed memory; it cannot be treated as settled fact.'
      : enteredContext
        ? 'D1 atom summary and evidence metadata entered the branch index Context.'
        : 'D1 candidate was outside the bounded branch-index Context.';
    updates.push({ envelope, decision, reason, stage: 'branch_index' });
    observations.push({
      atomId: envelope.atomId,
      path: envelope.retrievalPath,
      matchReason: envelope.matchReason,
      enteredContext,
      disclosureLevel: 'D1',
      tokensUsed: enteredContext
        ? estimateTokens(`${entry.title}\n${entry.summary}\n${(entry.searchKeys ?? []).join(' ')}`)
        : 0,
    });
  }
  return { updates, observations };
}

export function applyFragmentEvidence(
  knownState: MemoryKnownState,
  selection: FragmentEvidenceSelection,
  stage: 'expand' | 'deep_search',
): KnownStateMemoryReference[] {
  const updates: KnownStateUpdate[] = [];
  for (const fragment of selection.fragments) {
    if (!fragment.evidence) continue;
    updates.push({
      envelope: structuredClone(fragment.evidence),
      decision: fragment.evidence.conflict ? 'conflicted' : 'adopted',
      reason: fragment.evidence.conflict
        ? 'Memory content entered Context with an explicit unresolved/disputed marker.'
        : `${fragment.evidence.disclosureLevel} memory evidence entered Context within budget.`,
      stage,
    });
  }
  for (const excluded of selection.excluded) {
    if (!excluded.fragment.evidence) continue;
    const existing = knownState.references.find((reference) => reference.atomId === excluded.fragment.evidence!.atomId);
    if (excluded.reason.startsWith('Duplicate evidence') && existing?.decision === 'adopted') {
      continue;
    }
    const envelope = { ...structuredClone(excluded.fragment.evidence), truncated: true };
    updates.push({
      envelope,
      decision: envelope.conflict ? 'conflicted' : 'excluded',
      reason: envelope.conflict
        ? `Conflicted memory remained non-authoritative. ${excluded.reason}`
        : excluded.reason,
      stage,
    });
  }
  return updateMemoryKnownState(knownState, updates, new Date().toISOString());
}

export function fragmentAccessObservations(
  selection: FragmentEvidenceSelection,
): MemoryBranchAccessObservation[] {
  return [
    ...selection.fragments.flatMap((fragment) => fragment.evidence ? [{
      atomId: fragment.evidence.atomId,
      path: fragment.evidence.retrievalPath,
      matchReason: fragment.evidence.matchReason,
      enteredContext: true,
      disclosureLevel: fragment.evidence.disclosureLevel,
      tokensUsed: fragment.tokenEstimate,
    }] : []),
    ...selection.excluded.flatMap(({ fragment, reason }) => fragment.evidence ? [{
      atomId: fragment.evidence.atomId,
      path: fragment.evidence.retrievalPath,
      matchReason: `${fragment.evidence.matchReason} Excluded: ${reason}`,
      enteredContext: false,
      disclosureLevel: fragment.evidence.disclosureLevel,
      tokensUsed: 0,
    }] : []),
  ];
}

export async function recordBranchAccess(
  branch: MemoryBranch,
  context: MemoryBranchContext,
  observations: MemoryBranchAccessObservation[],
  log?: LogFn,
): Promise<void> {
  if (!branch.recordAccess || observations.length === 0) return;
  try {
    await branch.recordAccess(context, observations);
  } catch (error) {
    log?.('warn', `memory-tree: failed to persist v3 access evidence for "${branch.id}": ${(error as Error).message}`);
  }
}

export function fragmentIndexEntry(fragment: MemoryFragment): MemoryIndexEntry {
  const heading = fragment.content.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1];
  return {
    id: fragment.id,
    title: heading ?? fragment.id,
    summary: `${fragment.matchReason} Source: ${fragment.metadata.source}; about ${fragment.tokenEstimate} tokens.`,
    hasChildren: true,
    searchKeys: [fragment.metadata.kind, fragment.branchId],
    updatedAt: fragment.metadata.generatedAt,
    evidence: fragment.evidence ? { ...structuredClone(fragment.evidence), truncated: true } : undefined,
    metadata: { source: fragment.metadata.source, tier: fragment.tier, omittedForBudget: true },
  };
}
