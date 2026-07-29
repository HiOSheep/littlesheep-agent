// Normalizes resource policy, step metadata, and sanitized tool results.

import type {
  AgentTool,
  ToolContext,
  ToolResourceAccess,
  ToolResult,
} from '@littlesheep/types';
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
  if (result.output === undefined) return result;
  const sanitized = sanitizeOutput(result.output, options);
  return {
    ...result,
    output: sanitized.output,
    sanitized: sanitized.sanitized || result.sanitized === true,
    meta: {
      ...(result.meta ?? {}),
      ...(sanitized.truncated ? { outputTruncated: true } : {}),
    },
  };
}
