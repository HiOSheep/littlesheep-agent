// Deterministic execution-context fingerprint used by safe checkpoint boundaries.
import { createHash } from 'node:crypto';
import type { RunCheckpoint, RunContext } from '@littlesheep/types';
import { stableSerialize } from './run-checkpoint-codec.js';

export function fingerprintRunExecutionContext(ctx: RunContext): {
  executionContextFingerprint: string;
  executionContextComponents: NonNullable<RunCheckpoint['safeSegmentBoundary']>['executionContextComponents'];
} {
  const components = {
    identity: {
      runId: ctx.runId,
      sessionId: String(ctx.sessionId),
      inbound: ctx.inbound,
      cwd: ctx.cwd,
      workspaceContext: ctx.workspaceContext,
      model: ctx.model,
    },
    tools: {
      tools: ctx.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        requiresApproval: tool.requiresApproval,
        source: ctx.toolSources?.[tool.name],
      })).sort((left, right) => left.name.localeCompare(right.name)),
    },
    configuration: {
      resolvedRunConfig: ctx.resolvedRunConfig ? {
        ...ctx.resolvedRunConfig,
        resolvedAt: undefined,
        // The checkpoint records effective policy values; whether they came
        // from defaults or explicit per-run overrides is audit metadata only.
        userOverrides: undefined,
      } : undefined,
      // Current host-owned permission and workspace facts participate in the
      // restore match. They are hashed, never serialized as an authority token;
      // a restart without the same current Main snapshot fails before Harness.
      toolPermission: {
        permissionMode: ctx.toolContext.permissionMode,
        permissionPreset: ctx.toolContext.permissionPreset,
        approvalPolicy: ctx.toolContext.approvalPolicy,
        permissionPolicyV2: ctx.toolContext.permissionPolicyV2,
        workspaceFileWrites: ctx.toolContext.workspaceFileWrites,
        shellIsolation: ctx.toolContext.shellIsolation,
        fullAccessConfirmed: ctx.toolContext.fullAccessConfirmed,
        workspaceRoot: ctx.toolContext.workspaceRoot,
        dataRoot: ctx.toolContext.dataRoot,
        containerRoot: ctx.toolContext.containerRoot,
        protectedWriteRoots: ctx.toolContext.protectedWriteRoots,
      },
    },
    prompt: {
      bootstrap: ctx.bootstrap,
      profilePromptAddon: ctx.profilePromptAddon,
      reasoningPromptAddon: ctx.reasoningPromptAddon,
    },
    memory: {
      sessionSummary: ctx.sessionSummary,
      prelude: ctx.prelude,
      memoryRootIndex: ctx.memoryRootIndex,
      initialMemoryContext: ctx.initialMemoryContext,
      memoryKnownState: ctx.memoryKnownState ? {
        ...ctx.memoryKnownState,
        updatedAt: undefined,
        references: ctx.memoryKnownState.references.map((reference) => ({
          ...reference,
          firstSeenAt: undefined,
          updatedAt: undefined,
        })),
      } : undefined,
      memoryContextWorkingSet: ctx.memoryContextWorkingSet ? {
        ...ctx.memoryContextWorkingSet,
        updatedAt: undefined,
      } : undefined,
    },
  };
  const executionContextComponents = Object.fromEntries(Object.entries(components).map(([key, value]) => (
    [key, createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex')]
  ))) as NonNullable<RunCheckpoint['safeSegmentBoundary']>['executionContextComponents'];
  return {
    executionContextFingerprint: createHash('sha256')
      .update(stableSerialize(executionContextComponents), 'utf8')
      .digest('hex'),
    executionContextComponents,
  };
}
