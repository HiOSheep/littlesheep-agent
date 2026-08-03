import {
  assembleSystemPromptBundle,
  resolvePromptConfig,
  type SystemPromptBundle,
} from '@littlesheep/prompt';
import type { RunContext } from '@littlesheep/types';
import {
  renderCompactAutonomousReadTaskGuidance,
  renderCompactAutonomousReadWorkspace,
  resolveCompactAutonomousReadExecutionTools,
} from '../../compact-autonomous-read-task.js';
import {
  appendSystemPromptBundleAddons,
  buildCompactBehaviorProfileAddon,
  buildCompactUserFacingVoiceAddon,
} from '../../profile-prompt.js';
import type { ExecuteStageDeps } from './contracts.js';
import { renderPlanGuidance, renderTaskBookGuidance } from './guidance.js';

export async function buildExecuteSystemPrompt(
  deps: ExecuteStageDeps,
  ctx: RunContext,
): Promise<SystemPromptBundle> {
  const resolved = resolvePromptConfig(deps.config, deps.branding);
  const compactReadTools = resolveCompactAutonomousReadExecutionTools(ctx);
  const base = await assembleSystemPromptBundle(resolved, {
    tools: compactReadTools ? [] : ctx.tools,
    bootstrap: compactReadTools ? {} : ctx.bootstrap ?? {},
    prelude: compactReadTools ? undefined : ctx.prelude,
    sessionSummary: compactReadTools ? undefined : ctx.sessionSummary,
    memoryRootIndex: compactReadTools ? undefined : ctx.memoryRootIndex,
    initialMemoryContext: compactReadTools ? undefined : ctx.initialMemoryContext,
  }, compactReadTools ? 'none' : undefined);
  const guidance = compactReadTools && ctx.taskBook
    ? renderCompactAutonomousReadTaskGuidance(ctx.taskBook)
    : ctx.taskBook
      ? renderTaskBookGuidance(ctx.taskBook)
      : ctx.plan?.length
        ? renderPlanGuidance(ctx.plan)
        : '';

  return appendSystemPromptBundleAddons(base, [
    ...(compactReadTools ? [{
      id: 'compact-read-workspace',
      text: renderCompactAutonomousReadWorkspace(resolved.workspace),
      kind: 'project_knowledge' as const,
      source: { kind: 'configuration' as const, id: 'workspace', path: resolved.workspace },
      scope: 'workspace' as const,
    }] : []),
    {
      id: 'execution-plan',
      text: guidance,
      kind: 'workflow_state',
      source: { kind: 'workflow', id: 'execution-plan', runId: ctx.runId },
    },
    {
      id: 'profile',
      text: compactReadTools ? buildCompactBehaviorProfileAddon(ctx) : ctx.profilePromptAddon,
    },
    { id: 'reasoning', text: ctx.reasoningPromptAddon },
    ...(compactReadTools ? [{
      id: 'compact-user-facing-voice',
      text: buildCompactUserFacingVoiceAddon(ctx),
    }] : []),
  ]);
}
