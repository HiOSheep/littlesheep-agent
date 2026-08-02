import type { BrandingConfig } from '@littlesheep/branding';
import type { Config } from '@littlesheep/config';
import type { LlmClient } from '@littlesheep/llm';
import type { MemoryRunRefinementServiceLike } from '@littlesheep/memory-tree';

export interface DecideStageDeps {
  llm: LlmClient;
  model: string;
  config: Config;
  branding: BrandingConfig;
  memoryRefiner?: MemoryRunRefinementServiceLike;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export interface DecodedPlan {
  assessment?: {
    userNeed?: string;
    complexity?: unknown;
    goal?: string;
    successCriteria?: unknown;
    missingInfo?: unknown;
    needsClarification?: boolean;
    requiresTaskBook?: boolean;
    maxExtraScopeRatio?: unknown;
    rationale?: string;
  };
  clarification?: {
    blockingReason?: string;
    questions?: DecodedClarificationQuestion[];
  };
  taskBook?: {
    goal?: string;
    complexity?: unknown;
    successCriteria?: unknown;
    overdeliveryPolicy?: {
      maxExtraScopeRatio?: unknown;
      guidance?: string;
    };
    steps?: DecodedPlanStep[];
  };
  plan?: DecodedPlanStep[];
}

export interface DecodedClarificationQuestion {
  id?: string;
  field?: string;
  prompt?: string;
  required?: boolean;
  options?: unknown;
  defaultValue?: string;
}

export interface DecodedPlanStep {
  id?: string;
  title?: string;
  description?: string;
  tools?: unknown;
  toolProposal?: {
    name?: unknown;
    input?: unknown;
  };
  requiresApproval?: boolean;
  execution?: {
    mode?: unknown;
    dependsOn?: unknown;
    resources?: unknown;
    sideEffect?: unknown;
  };
  acceptanceCriteria?: unknown;
  expectedOutput?: string;
  status?: unknown;
}

export const DECIDE_SYSTEM_PROMPT = `You are the DECIDE stage of a hard-control-flow agent.
First calibrate the user's actual need, then decompose it into concrete steps.

Return ONLY a JSON object, no markdown:
{
  "assessment": {
    "userNeed": "precise user need",
    "complexity": "trivial|simple|standard|complex",
    "goal": "concrete goal for this run",
    "successCriteria": ["what must be true to count as done"],
    "missingInfo": [],
    "needsClarification": false,
    "requiresTaskBook": true,
    "maxExtraScopeRatio": 1.5,
    "rationale": "short reason"
  },
  "clarification": {
    "blockingReason": "why execution cannot safely continue",
    "questions": [
      {
        "field": "machine-readable field",
        "prompt": "specific user-facing question",
        "required": true,
        "options": [],
        "defaultValue": "optional safe default"
      }
    ]
  },
  "taskBook": {
    "goal": "same concrete goal",
    "complexity": "trivial|simple|standard|complex",
    "successCriteria": ["what must be true to count as done"],
    "overdeliveryPolicy": {
      "maxExtraScopeRatio": 1.5,
      "guidance": "slightly exceed expectations only when it helps; never exceed 3x scope/cost"
    },
    "steps": [
      {
        "id": "step-1",
        "title": "short label",
        "description": "step description",
        "tools": ["toolName1"],
        "requiresApproval": false,
        "execution": {
          "mode": "serial|parallel",
          "dependsOn": ["earlier-step-id"],
          "resources": [{"key":"workspace:relative/path","mode":"read|write"}],
          "sideEffect": "none|read|write|external"
        },
        "acceptanceCriteria": ["how this step is complete"],
        "expectedOutput": "artifact or result"
      }
    ]
  }
}

Rules:
- Demand calibration comes first: avoid using a cannon for a mosquito.
- Trivial/simple tasks should have 1 brief step and minimal overhead.
- Standard/complex tasks need stage goals and acceptance criteria.
- Natural-language fields that can reach the user (assessment, clarification, goals, criteria, step titles/descriptions and expected outputs) must use the user's language and follow the active SOUL.md voice. Keep IDs, tool names, status values and runtime facts machine-stable.
- Aim to be a little more helpful than requested, but never more than 3x the user's requested scope/cost.
- If key information is missing and guessing would be harmful, set needsClarification=true and list missingInfo.
- When needsClarification=true, fill clarification.blockingReason and one answerable question per missing field.
- Clarification prompts must use the same language as the user's request. Include options/defaultValue only when they are genuinely safe.
- Each step must have a non-empty "description".
- "tools" lists tool names this step may use (from the available tools list). Omit if none.
- "toolProposal" is optional and is only valid when a separate Runtime block supplies one explicit tool schema. It has shape {"name":"exactToolName","input":{...}} and remains a proposal until Runtime validation.
- "requiresApproval" is true for steps that should pause for user approval.
- Omit "execution" unless the scheduling contract is complete. Missing or unsafe contracts run serially.
- Use mode="parallel" only for genuinely independent work. dependsOn may reference earlier stable step ids only.
- Parallel steps must list the complete resource envelope. Use workspace:<relative path> for files/directories and stable names for non-file resources.
- Parallel steps may use only explicitly listed parallel-safe tools. Use tools=[] for a pure model step; do not omit tools on a parallel step.
- sideEffect is the highest expected class. external effects and approval-requiring steps always run serially.
- Keep plans minimal: prefer 1-3 steps unless the task is genuinely complex. Never invent tool names.

Compatibility: if you cannot produce taskBook, return the old {"plan":[...]} shape.`;
