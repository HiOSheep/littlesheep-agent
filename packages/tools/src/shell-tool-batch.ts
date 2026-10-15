// Freeze validated Shell calls before Main asks for approval. This module stores no reusable grants.
import type { AgentTool, ToolContext, ToolRegistration } from '@littlesheep/types';
import { authorizeShellBatch, isShellExecutor, type ShellAuthorizationFailure, type ShellBatchResult } from './shell-authorization.js';
import type { ToolInvocationRequest } from './tool-execution-service.js';

export async function prepareShellToolBatch(input: {
  requests: readonly ToolInvocationRequest[];
  registrations: ReadonlyMap<string, ToolRegistration>;
  context: ToolContext;
  timeoutMs: number;
  allowedToolNames?: ReadonlySet<string>;
  serialize<T>(task: () => Promise<T>): Promise<T>;
}): Promise<{ inputs: ReadonlyMap<number, unknown>; batch: ShellBatchResult }> {
  const inputs = new Map<number, unknown>();
  const items: { index: number; tool: AgentTool; input: unknown; signal?: AbortSignal }[] = [];
  for (const [index, request] of input.requests.entries()) {
    const registration = input.registrations.get(request.name);
    if (request.name !== 'exec' || !registration || (input.allowedToolNames && !input.allowedToolNames.has('exec'))) continue;
    try {
      const parsed = Object.freeze(registration.tool.inputSchema.parse(structuredClone(request.input)));
      inputs.set(index, parsed);
      if (registration.source === 'builtin' && isShellExecutor(registration.tool)) {
        items.push({ index, tool: registration.tool, input: parsed, signal: request.signal });
      }
    } catch { /* The ordinary ToolExecutionService validation record owns schema failures. */ }
  }
  if (!items.length) return { inputs, batch: { grants: new Map(), failures: new Map(), close() {} } };
  try {
    return { inputs, batch: await input.serialize(() => authorizeShellBatch(items, input.context, input.timeoutMs)) };
  } catch {
    return { inputs, batch: { grants: new Map(), failures: new Map(items.map((item) => [item.index,
      { status: 'approval_unavailable', errorKind: 'approval_unavailable', message: 'Shell authorization cancelled or unavailable' } satisfies ShellAuthorizationFailure])), close() {} } };
  }
}
