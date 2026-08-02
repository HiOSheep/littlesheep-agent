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

export interface ExplicitSingleToolInstruction {
  tool: AgentTool;
  schema: object;
}

/** Resolve the only deterministic tool shortcut accepted by DECIDE/EXECUTE. */
export function resolveExplicitSingleToolInstruction(
  ctx: Pick<RunContext, 'classification' | 'inbound' | 'tools'>,
): ExplicitSingleToolInstruction | undefined {
  const classification = ctx.classification;
  const activity = classification?.activity ?? activityFromMessageClass(classification?.type);
  if (activity !== 'execute'
    || classification?.source !== 'rules'
    || classification.reason !== 'explicit tool instruction') {
    return undefined;
  }

  const inboundText = ctx.inbound.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (isExplicitContinuationRequest(inboundText)) return undefined;

  const requestedNames = extractExplicitToolInstructionNames(inboundText);
  if (requestedNames.length !== 1) return undefined;
  const requestedName = requestedNames[0]!;
  const matches = ctx.tools.filter((tool) => tool.name.toLowerCase() === requestedName);
  if (matches.length !== 1) return undefined;

  const tool = matches[0]!;
  const schema = resolveToolSchema(tool);
  if (!schema) return undefined;
  return { tool, schema };
}

export function renderExplicitToolProposalContract(
  instruction: ExplicitSingleToolInstruction,
): string {
  const schema = JSON.stringify(instruction.schema);
  return `# Explicit single-tool DECIDE contract

The user explicitly named exactly one registered tool: \`${instruction.tool.name}\`.
You are the DECIDE stage. Calibrate the user's need and return ONLY one raw JSON object. This contract does not authorize execution: Runtime will validate the proposal, permissions and schema again.

When the request can be completed by one call to this tool, the successful JSON shape is:
{
  "assessment": {
    "userNeed": "precise need in the user's language",
    "complexity": "trivial|simple",
    "goal": "concrete goal in the user's language",
    "successCriteria": ["observable completion condition"],
    "missingInfo": [],
    "needsClarification": false,
    "requiresTaskBook": false,
    "maxExtraScopeRatio": 1,
    "rationale": "short reason"
  },
  "taskBook": {
    "goal": "same concrete goal",
    "complexity": "trivial|simple",
    "successCriteria": ["same observable completion condition"],
    "steps": [{
      "toolProposal": {"name":"${instruction.tool.name}","input":{}},
      "tools": ["${instruction.tool.name}"],
      "id": "step-1",
      "title": "short label in the user's language",
      "description": "one concrete step in the user's language",
      "acceptanceCriteria": ["how Runtime can verify the result"],
      "expectedOutput": "result the user requested"
    }]
  }
}

Replace the empty \`input\` object with concrete arguments inferred from the user's request and conforming to the JSON Schema below. Do not copy an empty object when the schema has required fields.

In that one-step case, returning \`tools\`: ["${instruction.tool.name}"] without the matching \`toolProposal\` is invalid. Check this requirement before returning the JSON object.

If required arguments cannot be inferred safely, set \`assessment.needsClarification\` to true and return a \`clarification\` object with a blocking reason and specific questions. If more than this one tool or more than one call is required, omit \`toolProposal\` and return a minimal ordinary TaskBook with acceptance criteria. Never propose another tool name.

Natural-language fields must use the user's language. Keep IDs, tool names and enum values machine-stable. Do not include markdown or prose outside the JSON object.

Tool description: ${instruction.tool.description}
Input JSON Schema: ${schema}`;
}

function resolveToolSchema(tool: AgentTool): object | undefined {
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
