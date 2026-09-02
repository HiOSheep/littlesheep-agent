// Pure TaskBook graph validation and conservative parallel-wave selection.

import { isAbsolute, relative, resolve } from 'node:path';
import { toolResourcesConflict } from '@littlesheep/tools';
import { describeToolAccess, resolvePermissionDecision } from '@littlesheep/safety';
import type {
  AgentTool,
  PlanStep,
  TaskBook,
  TaskStepSideEffect,
  ToolContext,
  ToolResourceAccess,
} from '@littlesheep/types';
import { resolveStepId } from './failure-policy.js';

export const DEFAULT_MAX_PARALLEL_TASK_STEPS = 2 as const;
export const MAX_PARALLEL_TASK_STEPS = 4 as const;

export interface ScheduledTaskStep {
  id: string;
  index: number;
  step: PlanStep;
  mode: 'serial' | 'parallel';
  dependsOn: string[];
  resources: ToolResourceAccess[];
  sideEffect?: TaskStepSideEffect;
  downgradeReason?: string;
}

export type TaskStepGraphResult =
  | { ok: true; steps: ScheduledTaskStep[] }
  | { ok: false; error: string };

export function buildTaskStepGraph(
  taskBook: TaskBook,
  tools: readonly AgentTool[],
  toolContext: ToolContext,
): TaskStepGraphResult {
  const ids = new Set<string>();
  const indexById = new Map<string, number>();
  for (const [index, step] of taskBook.steps.entries()) {
    const id = resolveStepId(step, index);
    if (ids.has(id)) return { ok: false, error: `TaskBook contains duplicate step id: ${id}` };
    ids.add(id);
    indexById.set(id, index);
    step.id = id;
  }

  const toolByName = new Map(tools.map((tool) => [tool.name, tool]));
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
    const resources = normalizeStepResources(step.execution?.resources ?? [], toolContext.cwd);
    const downgradeReason = parallelDowngradeReason(step, resources, toolByName, toolContext);
    scheduled.push({
      id,
      index,
      step,
      mode: step.execution?.mode === 'parallel' && !downgradeReason ? 'parallel' : 'serial',
      dependsOn,
      resources,
      sideEffect: step.execution?.sideEffect,
      ...(downgradeReason ? { downgradeReason } : {}),
    });
  }
  return { ok: true, steps: scheduled };
}

export function nextTaskStepWave(
  steps: readonly ScheduledTaskStep[],
  pendingIds: ReadonlySet<string>,
  completedIds: ReadonlySet<string>,
  maxParallel: number = DEFAULT_MAX_PARALLEL_TASK_STEPS,
): ScheduledTaskStep[] {
  const limit = Math.max(1, Math.min(MAX_PARALLEL_TASK_STEPS, Math.trunc(maxParallel) || 1));
  const wave: ScheduledTaskStep[] = [];
  for (const candidate of steps) {
    if (!pendingIds.has(candidate.id)) continue;
    const ready = candidate.dependsOn.every((dependency) => completedIds.has(dependency));
    if (candidate.mode === 'serial') {
      if (wave.length > 0) break;
      return ready ? [candidate] : [];
    }
    if (!ready) continue;
    if (wave.some((active) => toolResourcesConflict(active.resources, candidate.resources))) continue;
    wave.push(candidate);
    if (wave.length >= limit) break;
  }
  return wave;
}

function parallelDowngradeReason(
  step: PlanStep,
  resources: readonly ToolResourceAccess[],
  toolByName: ReadonlyMap<string, AgentTool>,
  toolContext: ToolContext,
): string | undefined {
  if (step.execution?.mode !== 'parallel') return undefined;
  if (!step.execution.sideEffect) return 'parallel policy has no sideEffect';
  if (step.execution.sideEffect === 'external') return 'external effects execute serially';
  if (step.requiresApproval && toolContext.permissionMode !== 'full') return 'approval-requiring steps execute serially';
  if (!Array.isArray(step.tools)) return 'parallel steps require an explicit tool list';
  const selectedTools = step.tools.map((name) => toolByName.get(name));
  if (selectedTools.some((tool) => !tool)) return 'parallel step references an unavailable tool';
  if (toolContext.permissionMode !== 'full'
    && toolContext.networkPolicy?.strictReadApproval === true
    && selectedTools.some((tool) => tool !== undefined && isStrictReadTool(tool.name))) {
    return 'strict read approval requires serial approval for runtime-owned read tools';
  }
  if (selectedTools.some((tool) => (
    (tool!.requiresApproval && toolContext.permissionMode !== 'full')
    || tool!.execution?.concurrency !== 'parallel'
  ))) {
    return 'parallel step includes a non-parallel or approval-requiring tool';
  }
  if (step.execution.sideEffect === 'none' && (resources.length > 0 || selectedTools.length > 0)) {
    return 'no-effect parallel steps must be pure model work';
  }
  if (step.execution.sideEffect === 'read' && resources.some((resource) => resource.mode === 'write')) {
    return 'read-only parallel step declares a write resource';
  }
  if (step.execution.sideEffect !== 'none' && resources.length === 0) {
    return 'parallel resource envelope is empty';
  }
  if (step.execution.sideEffect === 'write' && !resources.some((resource) => resource.mode === 'write')) {
    return 'write parallel step has no write resource';
  }
  if (toolContext.permissionMode === 'restricted'
    && selectedTools.length > 0
    && selectedTools.some((tool, index) => tool !== undefined && plannedToolRequiresApproval(
      tool,
      step,
      toolContext,
      index,
    ))) {
    return 'restricted permission mode requires serial approval for non-safe or unproven tool access';
  }
  if (toolContext.permissionMode === 'research' && step.execution.sideEffect === 'write') {
    return 'research permission mode requires serial approval for writes';
  }
  if (resources.some((resource) => resourceOutsideContainer(resource, toolContext.containerRoot))) {
    return 'container-external resources require serial approval';
  }
  return undefined;
}

function isStrictReadTool(toolName: string): boolean {
  return toolName === 'web_search'
    || toolName === 'web_fetch'
    || toolName === 'memory_tree'
    || toolName === 'memory_search'
    || toolName === 'memory_deep_search'
    || toolName === 'session_status'
}

function plannedToolRequiresApproval(
  tool: AgentTool,
  step: PlanStep,
  toolContext: ToolContext,
  toolIndex: number,
): boolean {
  if (toolContext.permissionMode === 'full') return false;
  const proposalInput = step.toolProposal
    && step.toolProposal.name === tool.name
    && step.tools?.length === 1
    ? step.toolProposal.input
    : undefined;
  const descriptor = describeToolAccess(tool.name, proposalInput, toolContext);
  if (descriptor.hardDecision === 'deny') return true;
  const decision = resolvePermissionDecision(toolContext.permissionMode ?? 'restricted', descriptor, {
    strictReadApproval: toolContext.networkPolicy?.strictReadApproval === true,
  });
  if (decision === 'approval' || decision === 'deny') return true;
  if (tool.requiresApproval === true && descriptor.safeReadClass === 'none') return true;
  // A multi-tool parallel step cannot prove which input will be used for a
  // URL-sensitive read; keep it serial until Runtime has a concrete proposal.
  if (isUrlSensitiveWebTool(tool.name) && proposalInput === undefined) return true;
  return toolIndex < 0;
}

function isUrlSensitiveWebTool(toolName: string): boolean {
  return toolName === 'web_fetch';
}

function normalizeStepResources(resources: readonly ToolResourceAccess[], cwd: string): ToolResourceAccess[] {
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

function resourceOutsideContainer(resource: ToolResourceAccess, containerRoot: string | undefined): boolean {
  if (!resource.key.startsWith('fs:')) return false;
  if (!containerRoot) return true;
  const path = resource.key.slice(3);
  const normalizedRoot = resolve(containerRoot);
  const normalizedPath = resolve(path);
  const relation = relative(normalizedRoot, normalizedPath);
  return relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation);
}
