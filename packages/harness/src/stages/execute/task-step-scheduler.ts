// Pure TaskBook dependency validation.
//
// Multi-step plans always run one step at a time now: the automatic
// dependency-aware parallel waves (and the resource-conflict packing that went
// with them) were part of the second execution system that the lean plan
// removes. What remains is the validation that keeps a plan executable at all:
// unique step ids, dependencies that point at earlier steps, and the resource
// envelope each step declares for permission and side-effect checks.

import { isAbsolute, resolve } from 'node:path';
import type {
  PlanStep,
  TaskBook,
  TaskStepSideEffect,
  ToolContext,
  ToolResourceAccess,
} from '@littlesheep/types';
import { resolveStepId } from './failure-policy.js';

export interface ScheduledTaskStep {
  id: string;
  index: number;
  step: PlanStep;
  dependsOn: string[];
  resources: ToolResourceAccess[];
  sideEffect?: TaskStepSideEffect;
}

export type TaskStepGraphResult =
  | { ok: true; steps: ScheduledTaskStep[] }
  | { ok: false; error: string };

export function buildTaskStepGraph(taskBook: TaskBook, toolContext: ToolContext): TaskStepGraphResult {
  const ids = new Set<string>();
  const indexById = new Map<string, number>();
  for (const [index, step] of taskBook.steps.entries()) {
    const id = resolveStepId(step, index);
    if (ids.has(id)) return { ok: false, error: `TaskBook contains duplicate step id: ${id}` };
    ids.add(id);
    indexById.set(id, index);
    step.id = id;
  }

  const scheduled: ScheduledTaskStep[] = [];
  for (const [index, step] of taskBook.steps.entries()) {
    const id = step.id!;
    const dependsOn = [...new Set(step.execution?.dependsOn ?? [])];
    for (const dependency of dependsOn) {
      const dependencyIndex = indexById.get(dependency);
      if (dependencyIndex === undefined) {
        return { ok: false, error: `TaskBook step ${id} depends on unknown step ${dependency}` };
      }
      if (dependencyIndex >= index) {
        return { ok: false, error: `TaskBook step ${id} must depend only on earlier steps (${dependency})` };
      }
    }
    scheduled.push({
      id,
      index,
      step,
      dependsOn,
      resources: normalizeStepResources(step.execution?.resources ?? [], toolContext.cwd),
      sideEffect: step.execution?.sideEffect,
    });
  }
  return { ok: true, steps: scheduled };
}

/** The first pending step whose dependencies are already completed, in plan order. */
export function nextTaskStep(
  steps: readonly ScheduledTaskStep[],
  pendingIds: ReadonlySet<string>,
  completedIds: ReadonlySet<string>,
): ScheduledTaskStep | undefined {
  return steps.find((candidate) => pendingIds.has(candidate.id)
    && candidate.dependsOn.every((dependency) => completedIds.has(dependency)));
}

function normalizeStepResources(
  resources: readonly ToolResourceAccess[],
  cwd: string,
): ToolResourceAccess[] {
  const normalized = new Map<string, ToolResourceAccess['mode']>();
  for (const resource of resources) {
    const key = normalizeResourceKey(resource.key, cwd);
    if (!key) continue;
    const previous = normalized.get(key);
    normalized.set(key, previous === 'write' || resource.mode === 'write' ? 'write' : 'read');
  }
  return [...normalized].map(([key, mode]) => ({ key, mode }));
}

function normalizeResourceKey(value: string, cwd: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('workspace:')) return fileResourceKey(resolve(cwd, trimmed.slice('workspace:'.length)));
  if (trimmed.startsWith('fs:')) {
    const path = trimmed.slice(3);
    return fileResourceKey(isAbsolute(path) ? path : resolve(cwd, path));
  }
  return trimmed;
}

function fileResourceKey(path: string): string {
  const normalized = resolve(path).replace(/\\/gu, '/').replace(/\/+$/u, '');
  return `fs:${process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized}`;
}
