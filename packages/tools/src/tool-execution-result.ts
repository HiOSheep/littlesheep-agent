// Normalizes resource policy, step metadata, and sanitized tool results.

import type {
  AgentTool,
  ToolContext,
  ToolResourceAccess,
  ToolResult,
} from '@littlesheep/types';
import { sanitizeWebEvidenceProjection } from '@littlesheep/types';
import { sanitizeOutput, type SanitizeOptions } from './sanitize.js';

export function resolveToolExecutionPolicy(
  tool: AgentTool,
  input: unknown,
  context: ToolContext,
): { concurrency: 'parallel' | 'exclusive'; resources: readonly ToolResourceAccess[] } {
  if (tool.execution?.concurrency !== 'parallel') return { concurrency: 'exclusive', resources: [] };
  try {
    const resources = (tool.execution.resources?.(input, context) ?? [])
      .filter((resource) => resource && typeof resource.key === 'string' && resource.key.trim())
      .map((resource) => ({
        key: resource.key.trim(),
        mode: resource.mode === 'write' ? 'write' as const : 'read' as const,
      }));
    return { concurrency: 'parallel', resources };
  } catch {
    return { concurrency: 'exclusive', resources: [] };
  }
}

export function stampToolStep(result: ToolResult, stepId?: string): ToolResult {
  if (!stepId) return result;
  return { ...result, meta: { ...(result.meta ?? {}), stepId } };
}

export function sanitizeToolResult(result: ToolResult, options: SanitizeOptions): ToolResult {
  const durable = result.output === undefined ? undefined : sanitizeOutput(result.output, options);
  const model = result.modelOutput === undefined ? undefined : sanitizeOutput(result.modelOutput, options);
  if (!durable && !model) return result;
  return {
    ...result,
    ...(durable ? { output: durable.output } : {}),
    ...(model ? { modelOutput: model.output } : {}),
    sanitized: durable?.sanitized === true || model?.sanitized === true || result.sanitized === true,
    meta: {
      ...(result.meta ?? {}),
      ...(durable?.truncated ? { outputTruncated: true } : {}),
      ...(model?.truncated ? { modelOutputTruncated: true } : {}),
    },
  };
}

/** Remove run-local model evidence before any durable or returned projection. */
export function durableToolResult(result: ToolResult): ToolResult {
  const { modelOutput: _modelOutput, webEvidence: rawWebEvidence, ...durable } = result;
  const webEvidence = sanitizeWebEvidenceProjection(rawWebEvidence);
  return { ...durable, ...(webEvidence ? { webEvidence } : {}) };
}

export function projectToolInput(tool: AgentTool, input: unknown): unknown {
  try {
    return tool.persistence?.projectInput(input) ?? input;
  } catch {
    return { redacted: true, projectionError: true };
  }
}

/**
 * Finish one invocation's result.
 *
 * A tool may declare a precise, bounded reason for a returned failure in
 * `meta.errorKind` (observation_stale, target_exists, ...). Carrying it into the
 * invocation outcome keeps the audit and the failure classifier accurate instead
 * of collapsing every refusal into `failed`. Plugins share this channel, so the
 * shape is restricted to lower-case identifiers; anything else is ignored.
 */
export function invocationOutcomeForResult(
  result: ToolResult,
  callId: string,
): { result: ToolResult; errorKind?: string } {
  const declared = (result.meta as Record<string, unknown> | undefined)?.['errorKind'];
  const bounded = typeof declared === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(declared)
    ? declared
    : undefined;
  return {
    result: { ...result, callId },
    ...(bounded && !result.ok ? { errorKind: bounded } : {}),
  };
}
