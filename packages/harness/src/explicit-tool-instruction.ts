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

/** Resolve the only deterministic tool shortcut accepted by DECIDE/EXECUTE. */
export function resolveExplicitSingleToolInstruction(
  ctx: Pick<RunContext, 'classification' | 'inbound' | 'tools'>,
): ExplicitSingleToolInstruction | undefined {
  const resolved = resolveExplicitToolInstructionSet(ctx);
  return resolved?.entries.length === 1 ? resolved.entries[0] : undefined;
}

export function renderExplicitToolProposalContract(
  instructions: ExplicitToolInstructionSet,
): string {
  if (instructions.entries.length !== 1) return renderExplicitMultiToolProposalContract(instructions);
  const instruction = instructions.entries[0]!;
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

function renderExplicitMultiToolProposalContract(instructions: ExplicitToolInstructionSet): string {
  const names = instructions.names.map((name) => `\`${name}\``).join(', ');
  const schemas = instructions.entries.map((entry) => (
    `## ${entry.tool.name}\nDescription: ${entry.tool.description}\nInput JSON Schema: ${JSON.stringify(entry.schema)}`
  )).join('\n\n');
  return `# Explicit multi-tool DECIDE contract

The user explicitly instructed LS to use exactly these registered tools: ${names}.
You are the DECIDE stage. Calibrate the need and return ONLY one raw JSON object. Tool proposals are not execution authority: Runtime will validate every name, input schema, resource boundary, permission decision, dependency and side effect again.

When the request needs multiple separately verifiable calls, preserve them as separate TaskBook steps in the user's requested order. Each executable step must:
- list exactly one of the named tools in \`tools\`;
- include exactly one matching \`toolProposal\` with concrete JSON input;
- include observable acceptance criteria;
- declare serial dependencies when a later call depends on an earlier result;
- describe its resource access and highest side effect in \`execution\` when those facts are known.

Use this shape:
{
  "assessment": {
    "userNeed": "precise need in the user's language",
    "complexity": "trivial|simple|standard|complex",
    "goal": "concrete goal in the user's language",
    "successCriteria": ["observable completion condition"],
    "missingInfo": [],
    "needsClarification": false,
    "requiresTaskBook": true,
    "maxExtraScopeRatio": 1,
    "rationale": "short reason"
  },
  "taskBook": {
    "goal": "same concrete goal",
    "complexity": "trivial|simple|standard|complex",
    "successCriteria": ["same observable completion condition"],
    "steps": [{
      "id": "step-1",
      "title": "short label in the user's language",
      "description": "one concrete step in the user's language",
      "tools": ["exactToolName"],
      "toolProposal": {"name":"exactToolName","input":{}},
      "execution": {
        "mode": "serial",
        "dependsOn": [],
        "resources": [{"key":"workspace:relative/path","mode":"read|write"}],
        "sideEffect": "none|read|write|external"
      },
      "acceptanceCriteria": ["how Runtime can verify this step"],
      "expectedOutput": "result this step should produce"
    }]
  }
}

Infer every required argument from the user's request and the schemas below. If a required argument cannot be inferred safely, request clarification instead of inventing it. Do not add unnamed tools, combine separately requested verification steps, or place two tool calls in one step. Natural-language fields must use the user's language. Keep IDs, tool names and enum values machine-stable. Do not include markdown or prose outside the JSON object.

${schemas}`;
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
