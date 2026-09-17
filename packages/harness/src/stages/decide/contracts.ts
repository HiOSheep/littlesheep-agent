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
  /** Lean v2 wire dependency list; Runtime expands it into serial execution policy. */
  dependsOn?: unknown;
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

/**
 * Lean wire -> internal contract ownership:
 * - assessment goal/criteria/complexity -> NeedAssessment
 * - taskBook.steps intent/dependencies/criteria -> PlanStep[]
 * - Runtime derives stable missing ids, initial status, scope ratio, approval,
 *   resources, side-effect class, scheduling fallback, and TaskBook envelope.
 */
export const DECIDE_WIRE_FIELD_MAP = Object.freeze({
  assessment: ['userNeed', 'complexity', 'goal', 'successCriteria', 'missingInfo', 'needsClarification', 'rationale'],
  clarification: ['blockingReason', 'questions'],
  step: ['id', 'title', 'description', 'tools', 'toolProposal', 'dependsOn', 'acceptanceCriteria', 'expectedOutput'],
  runtimeDerived: ['status', 'requiresTaskBook', 'maxExtraScopeRatio', 'requiresApproval', 'resources', 'sideEffect', 'executionMode', 'overdeliveryPolicy'],
} as const);

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
    "steps": [
      {
        "id": "step-1",
        "title": "short label",
        "description": "step description",
        "tools": ["toolName1"],
        "dependsOn": ["earlier-step-id"],
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
- "dependsOn" may reference earlier step ids only. Runtime chooses serial/parallel scheduling from validated tool/resource facts.
- Do not propose approval decisions, resource envelopes, side-effect classes, initial status, or scope ratios; Runtime owns them.
- Keep plans minimal: prefer 1-3 steps unless the task is genuinely complex. Never invent tool names.

Compatibility: if you cannot produce taskBook, return the old {"plan":[...]} shape.`;
