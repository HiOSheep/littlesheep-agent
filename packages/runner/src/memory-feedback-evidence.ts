import type { RunContext } from '@littlesheep/types';

const NON_EVIDENTIARY_TOOL_NAMES = new Set([
  'memory_tree',
  'memory_search',
  'memory_deep_search',
  'use_skill',
]);

export function independentSuccessfulToolCallIds(ctx: RunContext): string[] {
  const toolNameByCallId = new Map<string, string>();
  for (const message of ctx.produced) {
    for (const block of message.content) {
      if (block.type !== 'tool_calls') continue;
      for (const call of block.calls) toolNameByCallId.set(call.id, call.name);
    }
  }
  return (ctx.toolResults ?? [])
    .filter((result) => {
      if (!result.ok) return false;
      const toolName = toolNameByCallId.get(result.callId);
      return Boolean(toolName && !NON_EVIDENTIARY_TOOL_NAMES.has(toolName));
    })
    .map((result) => result.callId);
}
