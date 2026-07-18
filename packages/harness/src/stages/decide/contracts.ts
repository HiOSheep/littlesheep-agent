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
  requiresApproval?: boolean;
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
- "requiresApproval" is true for steps that should pause for user approval.
- Keep plans minimal: prefer 1-3 steps unless the task is genuinely complex. Never invent tool names.

Compatibility: if you cannot produce taskBook, return the old {"plan":[...]} shape.`;
