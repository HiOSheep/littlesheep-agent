// Refines the run memory working set after DECIDE turns a vague request into a precise TaskBook.

import {
  composeMemoryTaskQuery,
  type MemoryRunRefinementServiceLike,
  type MemoryTaskQuery,
  type MemoryTaskQuerySegment,
} from '@littlesheep/memory-tree';
import type { RunContext, TaskBook } from '@littlesheep/types';
import { ingestMemoryKnownState } from './memory-known-state.js';
import { writeMemoryState } from './memory-state.js';

const MAX_REFINEMENT_QUERY_CHARS = 1_600;
const MAX_REFINEMENT_STEPS = 6;
const MAX_CONTEXT_ATOMS = 128;

export interface TaskBookMemoryRefinementResult {
  query: string;
  addedAtomIds: string[];
  skippedReason?: 'empty-query' | 'duplicate-query' | 'refinement-limit';
}

export interface TaskBookMemoryRefinementMeta {
  addedAtoms: number;
  skippedReason?: string;
  error?: string;
}

export function buildTaskBookMemoryQuery(
  taskBook: TaskBook,
  targetStepIds: readonly string[] = [],
): string {
  const targeted = new Set(targetStepIds);
  const steps = taskBook.steps
    .filter((step) => targeted.size === 0
      ? step.status !== 'done' && step.status !== 'skipped'
      : Boolean(step.id && targeted.has(step.id)))
    .slice(0, MAX_REFINEMENT_STEPS);
  const lines = [
    `Goal: ${clean(taskBook.goal)}`,
    ...taskBook.successCriteria.slice(0, 6).map((criterion) => `Success: ${clean(criterion)}`),
    ...steps.flatMap((step) => [
      `Step: ${clean([step.title, step.description].filter(Boolean).join(' - '))}`,
      ...(step.acceptanceCriteria ?? []).slice(0, 3).map((criterion) => `Accept: ${clean(criterion)}`),
    ]),
  ].filter((line) => !line.endsWith(': '));
  return lines.join('\n').slice(0, MAX_REFINEMENT_QUERY_CHARS).trim();
}

export function buildTaskBookMemoryTaskQuery(
  taskBook: TaskBook,
  targetStepIds: readonly string[] = [],
): MemoryTaskQuery {
  const targeted = new Set(targetStepIds);
  const steps = taskBook.steps
    .filter((step) => targeted.size === 0
      ? step.status !== 'done' && step.status !== 'skipped'
      : Boolean(step.id && targeted.has(step.id)))
    .slice(0, MAX_REFINEMENT_STEPS);
  const anchors: Array<{ text: string; weight: number }> = [
    { text: taskBook.goal, weight: 1 },
    ...taskBook.successCriteria.slice(0, 6).map((text) => ({ text, weight: 0.92 })),
    ...steps.flatMap((step) => [
      { text: [step.title, step.description].filter(Boolean).join(' - '), weight: 0.88 },
      ...(step.acceptanceCriteria ?? []).slice(0, 3).map((text) => ({ text, weight: 0.82 })),
    ]),
  ];
  const segments: MemoryTaskQuerySegment[] = [];
  const exclusions: string[] = [];
  for (const anchor of anchors) {
    const parsed = composeMemoryTaskQuery(clean(anchor.text));
    for (const segment of parsed.positiveSegments) {
      segments.push({ ...segment, weight: Math.min(segment.weight, anchor.weight) });
    }
    exclusions.push(...parsed.excludedPhrases);
  }
  const query = buildTaskBookMemoryQuery(taskBook, targetStepIds);
  const base = composeMemoryTaskQuery(query);
  const positiveSegments = uniqueSegments(segments).slice(0, 16);
  const positiveText = positiveSegments.map((segment) => segment.text).join('\n').slice(0, 1_800);
  const excludedPhrases = [...new Set(exclusions)].slice(0, 8);
  return {
    ...base,
    positiveText,
    positiveSegments,
    retrievalText: [positiveText, ...excludedPhrases].filter(Boolean).join('\n').slice(0, 1_800),
    excludedPhrases,
  };
}

export async function refineMemoryForTaskBook(
  ctx: RunContext,
  taskBook: TaskBook,
  service: MemoryRunRefinementServiceLike,
  purpose: 'taskbook' | 'replan',
  targetStepIds: readonly string[] = [],
): Promise<TaskBookMemoryRefinementResult> {
  const query = buildTaskBookMemoryQuery(taskBook, targetStepIds);
  const taskQuery = buildTaskBookMemoryTaskQuery(taskBook, targetStepIds);
  const refinement = await service.refineRun({
    runId: ctx.runId,
    query,
    taskQuery,
    purpose,
    maxAtoms: 2,
    tokenBudget: 400,
  });
  ingestMemoryKnownState(ctx, refinement.ledger.knownState, 'decide');
  if (!refinement.context) {
    return { query, addedAtomIds: [], skippedReason: refinement.skippedReason };
  }

  const state = structuredClone(ctx.memoryContextWorkingSet ?? {
    revision: 0,
    activeAtomIds: [],
    releasedAtomIds: [],
    activeCallByAtom: {},
    callAtomIds: {},
    updatedAt: new Date().toISOString(),
  });
  const atomIds = unique(refinement.context.atomIds).slice(0, MAX_CONTEXT_ATOMS);
  const addedAtomIds = atomIds.filter((atomId) => state.activeCallByAtom[atomId] !== 'initial');
  if (addedAtomIds.length === 0) return { query, addedAtomIds: [] };

  const initialMemoryContext = [ctx.initialMemoryContext, refinement.context.content]
    .filter((value): value is string => Boolean(value))
    .join('\n\n---\n\n');
  state.callAtomIds.initial = unique([...(state.callAtomIds.initial ?? []), ...addedAtomIds])
    .slice(-MAX_CONTEXT_ATOMS);
  for (const atomId of addedAtomIds) state.activeCallByAtom[atomId] = 'initial';
  const activeAtomIds = Object.keys(state.activeCallByAtom).slice(-MAX_CONTEXT_ATOMS);
  state.activeCallByAtom = Object.fromEntries(activeAtomIds.map((atomId) => [atomId, state.activeCallByAtom[atomId]!]));
  state.activeAtomIds = activeAtomIds;
  state.releasedAtomIds = state.releasedAtomIds.filter((atomId) => !state.activeCallByAtom[atomId]);
  state.revision += 1;
  state.updatedAt = new Date().toISOString();
  writeMemoryState(ctx, 'decide', { initialMemoryContext, memoryContextWorkingSet: state });
  return { query, addedAtomIds };
}

export async function maybeRefineMemoryForTaskBook(
  ctx: RunContext,
  taskBook: TaskBook,
  service: MemoryRunRefinementServiceLike | undefined,
  purpose: 'taskbook' | 'replan',
  targetStepIds: readonly string[] | undefined,
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void,
): Promise<TaskBookMemoryRefinementMeta | undefined> {
  if (!service) return undefined;
  try {
    const refined = await refineMemoryForTaskBook(ctx, taskBook, service, purpose, targetStepIds);
    return { addedAtoms: refined.addedAtomIds.length, skippedReason: refined.skippedReason };
  } catch (error) {
    const message = (error as Error).message;
    log?.('warn', `memory-v3: TaskBook refinement degraded: ${message}`);
    return { addedAtoms: 0, error: message };
  }
}

function clean(value: string): string {
  return value.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqueSegments(segments: MemoryTaskQuerySegment[]): MemoryTaskQuerySegment[] {
  const byText = new Map<string, MemoryTaskQuerySegment>();
  for (const segment of segments) {
    const key = clean(segment.text).toLocaleLowerCase();
    if (!key) continue;
    const existing = byText.get(key);
    if (!existing || segment.weight > existing.weight) byText.set(key, { ...segment, text: clean(segment.text) });
  }
  return [...byText.values()];
}
