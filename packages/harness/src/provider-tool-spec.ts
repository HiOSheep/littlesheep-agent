// @littlesheep/harness — provider-tool-spec.ts
//
// Provider-facing tool definition. Extracted from the tool loop so the planner
// and the tool loop can advertise the same tool block, which is what keeps the
// cached prefix shared: the provider caches the tool block ahead of the
// messages, so a block that differs between calls invalidates everything after
// it, including the transcript. Kept byte-identical to the loop's conversion.
import type { z } from 'zod';
import { zodToJsonSchema, type ToolSpec } from '@littlesheep/llm';
import type { AgentTool } from '@littlesheep/types';

export function toolToSpec(tool: AgentTool): ToolSpec {
  const explicit = tool.inputSchema.jsonSchema;
  const parameters = explicit
    ? explicit as object
    : zodToJsonSchema(tool.inputSchema as unknown as z.ZodTypeAny);
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters },
  };
}

/** Provider tool list for a set of runtime tools; undefined when there are none. */
export function toProviderTools(tools: readonly AgentTool[] | undefined): ToolSpec[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(toolToSpec);
}