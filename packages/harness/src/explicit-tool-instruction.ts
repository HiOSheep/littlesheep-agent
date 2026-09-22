import { extractExplicitToolInstructionNames } from '@littlesheep/classifier';
import { zodToJsonSchema } from '@littlesheep/llm';
import {
  activityFromMessageClass,
  type AgentTool,
  type RunContext,
} from '@littlesheep/types';
import type { z } from 'zod';
import { isExplicitContinuationRequest } from './continuation-intent.js';

const MAX_EXPLICIT_TOOL_SCHEMA_CHARS = 12_000;
const MAX_EXPLICIT_TOOL_SCHEMA_TOTAL_CHARS = 24_000;
const MAX_EXPLICIT_TOOLS = 4;

export interface ExplicitSingleToolInstruction {
  tool: AgentTool;
  schema: object;
}

export interface ExplicitToolInstructionSet {
  entries: ExplicitSingleToolInstruction[];
  names: string[];
}

/** Resolve a bounded set of tools that the user explicitly instructed LS to use. */
export function resolveExplicitToolInstructionSet(
  ctx: Pick<RunContext, 'classification' | 'inbound' | 'tools'>,
  options: { allowContinuation?: boolean } = {},
): ExplicitToolInstructionSet | undefined {
  const classification = ctx.classification;
  const activity = classification?.activity ?? activityFromMessageClass(classification?.type);
  const explicitInstruction = classification?.reasonCode === 'explicit_tool_instruction'
    || (classification?.reasonCode === undefined && classification?.reason === 'explicit tool instruction');
  if (activity !== 'execute'
    || classification?.source !== 'rules'
    || !explicitInstruction) {
    return undefined;
  }

  const inboundText = ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (options.allowContinuation !== true && isExplicitContinuationRequest(inboundText)) return undefined;
  const requestedNames = extractExplicitToolInstructionNames(inboundText);
  if (requestedNames.length === 0 || requestedNames.length > MAX_EXPLICIT_TOOLS) return undefined;

  const entries: ExplicitSingleToolInstruction[] = [];
  let totalSchemaChars = 0;
  for (const requestedName of requestedNames) {
    const matches = ctx.tools.filter((tool) => tool.name.toLowerCase() === requestedName);
    if (matches.length !== 1) return undefined;
    const tool = matches[0]!;
    const schema = resolveBoundedToolJsonSchema(tool);
    if (!schema) return undefined;
    totalSchemaChars += JSON.stringify(schema).length;
    if (totalSchemaChars > MAX_EXPLICIT_TOOL_SCHEMA_TOTAL_CHARS) return undefined;
    entries.push({ tool, schema });
  }

  return { entries, names: entries.map((entry) => entry.tool.name) };
}

/**
 * Bounded Runtime scope note for a turn the user narrowed by naming tools.
 *
 * It travels below the cache boundary like the retrieval contract, and it is the
 * only place the narrowing is announced: the model catalog itself stays fixed
 * for the session, and a call outside this scope is refused at the boundary.
 */
export function renderExplicitToolScopeContract(admittedNames: readonly string[]): string {
  const list = admittedNames.slice(0, MAX_EXPLICIT_TOOLS).join(', ');
  return list
    ? `Runtime tool scope: the user explicitly named ${list}. Only these tools may execute for this request; every other call is refused at the execution boundary. The visible catalog is the session's fixed catalog, not a permission grant.`
    : 'Runtime tool scope: the tools the user named are not admitted for this request. Do not call them; answer from what is already available or ask the user.';
}

/** Build a bounded JSON Schema before exposing any Runtime tool to a model. */
export function resolveBoundedToolJsonSchema(tool: AgentTool): object | undefined {
  const explicit = tool.inputSchema.jsonSchema;
  let schema: object;
  try {
    schema = explicit && typeof explicit === 'object'
      ? explicit as object
      : zodToJsonSchema(tool.inputSchema as unknown as z.ZodTypeAny);
  } catch {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(schema);
    return serialized.length > 0 && serialized.length <= MAX_EXPLICIT_TOOL_SCHEMA_CHARS
      ? schema
      : undefined;
  } catch {
    return undefined;
  }
}
