// @littlesheep/tools — wrapper.ts
// Tool execution wrapper: centralizes timing + error handling so individual
// tools only implement their core business logic.
//
// Contract reminder (see types/tool.ts): execute() must not throw — it returns
// { ok: false } on error. This wrapper enforces that contract uniformly.

import type { ToolContext, ToolResult } from '@littlesheep/types';

/**
 * The core logic of a tool, stripped of cross-cutting concerns.
 * Implementations should:
 *   - Throw on unexpected errors (the wrapper converts to ok:false).
 *   - Return a partial ToolResult WITHOUT callId/durationMs (wrapper fills them).
 *   - May omit `ok` on success paths (defaults to true).
 */
export type ToolHandler<I = unknown> = (
  input: I,
  ctx: ToolContext,
) => Promise<Omit<ToolResult, 'callId' | 'durationMs' | 'ok'> & { ok?: boolean }>;

/**
 * Wrap a tool handler with uniform timing + error handling.
 *
 * Guarantees:
 *   - `durationMs` is always present and accurate (covers success, business
 *     failure, and thrown exceptions).
 *   - `callId` is set to '' (filled later by the executor with ToolCall.id).
 *   - Thrown errors are converted to { ok:false, error } — never rethrows.
 *
 * This is the single place where the `AgentTool.execute` contract
 * ("must not throw — return ok:false on error") is enforced mechanically,
 * so individual tools cannot accidentally violate it.
 */
export function withToolTiming<I = unknown>(
  handler: ToolHandler<I>,
): (input: unknown, ctx: ToolContext) => Promise<ToolResult> {
  return async (input: unknown, ctx: ToolContext): Promise<ToolResult> => {
    const start = Date.now();
    try {
      const result = await handler(input as I, ctx);
      // `ok` defaults to true when omitted — success path convenience.
      const { ok = true, ...rest } = result;
      return {
        callId: '',
        ok,
        ...rest,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        callId: '',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  };
}
