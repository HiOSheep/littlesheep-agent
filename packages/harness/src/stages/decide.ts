// @littlesheep/harness - stages/decide.ts
// DECIDE: calibrates the user's need, builds a structured task book, and
// validates tool names. 3 retries on parse failure -> RECOVER.

import type {
  RunContext,
  StageResult,
  PlanStep,
  NeedAssessment,
  TaskBook,
  TaskComplexity,
  ClarificationQuestion,
  ClarificationRequest,
  PartialReplanRequest,
} from '@littlesheep/types';
import type { LlmClient, ChatMessage } from '@littlesheep/llm';
import type { Config } from '@littlesheep/config';
import type { BrandingConfig } from '@littlesheep/branding';
import { assembleSystemPrompt, resolvePromptConfig } from '@littlesheep/prompt';
import { toChatMessage, textOf, callLlmForJson, userChatMessage, asStringArray } from './_shared.js';
import { appendSystemPromptAddons } from '../profile-prompt.js';

export interface DecideStageDeps {
  llm: LlmClient;
  model: string;
  config: Config;
  branding: BrandingConfig;
}

const SYSTEM_PROMPT = `You are the DECIDE stage of a hard-control-flow agent.
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
- Aim to be a little more helpful than requested, but never more than 3x the user's requested scope/cost.
- If key information is missing and guessing would be harmful, set needsClarification=true and list missingInfo.
- When needsClarification=true, fill clarification.blockingReason and one answerable question per missing field.
- Clarification prompts must use the same language as the user's request. Include options/defaultValue only when they are genuinely safe.
- Each step must have a non-empty "description".
- "tools" lists tool names this step may use (from the available tools list). Omit if none.
- "requiresApproval" is true for steps that should pause for user approval.
- Keep plans minimal: prefer 1-3 steps unless the task is genuinely complex. Never invent tool names.

Compatibility: if you cannot produce taskBook, return the old {"plan":[...]} shape.`;

interface DecodedPlan {
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

interface DecodedClarificationQuestion {
  id?: string;
  field?: string;
  prompt?: string;
  required?: boolean;
  options?: unknown;
  defaultValue?: string;
}

interface DecodedPlanStep {
  id?: string;
  title?: string;
  description?: string;
  tools?: unknown;
  requiresApproval?: boolean;
  acceptanceCriteria?: unknown;
  expectedOutput?: string;
  status?: unknown;
}

const COMPLEXITIES: readonly TaskComplexity[] = ['trivial', 'simple', 'standard', 'complex'];
const STEP_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked', 'skipped']);

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeComplexity(value: unknown): TaskComplexity {
  return typeof value === 'string' && COMPLEXITIES.includes(value as TaskComplexity)
    ? value as TaskComplexity
    : 'standard';
}

function defaultExtraScopeRatio(complexity: TaskComplexity): number {
  if (complexity === 'trivial') return 1;
  if (complexity === 'simple') return 1.25;
  if (complexity === 'complex') return 2;
  return 1.5;
}

function normalizeExtraScopeRatio(value: unknown, complexity: TaskComplexity): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  const ratio = Number.isFinite(parsed) ? parsed : defaultExtraScopeRatio(complexity);
  return Math.min(3, Math.max(1, ratio));
}

function requiresStructuredTaskBook(complexity: TaskComplexity): boolean {
  // Complexity is the code-level boundary. The model may describe the task,
  // but it cannot opt a standard/complex task out of the structured contract
  // or inflate a trivial/simple task into a multi-step task book.
  return complexity === 'standard' || complexity === 'complex';
}

function usesChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function fallbackQuestionPrompt(missing: string, inboundText: string): string {
  return usesChinese(inboundText)
    ? `请补充${missing}。`
    : `Please provide ${missing}.`;
}

function buildClarificationRequest(
  parsed: DecodedPlan,
  assessment: NeedAssessment,
  inboundText: string,
  runId: string,
  createdAt: string,
): ClarificationRequest {
  const rawQuestions = Array.isArray(parsed.clarification?.questions)
    ? parsed.clarification.questions
    : [];
  const questions: ClarificationQuestion[] = rawQuestions
    .map((question, index): ClarificationQuestion | null => {
      const missing = assessment.missingInfo?.[index] ?? `missing-information-${index + 1}`;
      const prompt = cleanString(question.prompt) ?? fallbackQuestionPrompt(missing, inboundText);
      const options = asStringArray(question.options).map((option) => option.trim()).filter(Boolean);
      return {
        id: cleanString(question.id) ?? `question-${index + 1}`,
        field: cleanString(question.field) ?? missing,
        prompt,
        required: question.required !== false,
        options: options.length > 0 ? options : undefined,
        defaultValue: cleanString(question.defaultValue),
      };
    })
    .filter((question): question is ClarificationQuestion => question !== null);

  if (questions.length === 0) {
    const missingInfo = assessment.missingInfo && assessment.missingInfo.length > 0
      ? assessment.missingInfo
      : [usesChinese(inboundText) ? '继续执行所需的具体信息' : 'the specific information needed to continue'];
    for (const [index, missing] of missingInfo.entries()) {
      questions.push({
        id: `question-${index + 1}`,
        field: missing,
        prompt: fallbackQuestionPrompt(missing, inboundText),
        required: true,
      });
    }
  }

  return {
    id: `${runId}:clarification`,
    kind: 'missing_information',
    sourceStage: 'decide',
    createdAt,
    originalRequest: inboundText,
    blockingReason: cleanString(parsed.clarification?.blockingReason)
      ?? (usesChinese(inboundText)
        ? '缺少安全、准确执行任务所需的关键信息。'
        : 'Key information required for safe and accurate execution is missing.'),
    missingInfo: assessment.missingInfo,
    questions,
  };
}

function normalizePlan(
  raw: DecodedPlanStep[] | undefined,
  availableToolNames: Set<string>,
): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const plan: PlanStep[] = [];
  for (const step of raw) {
    const description = cleanString(step?.description) ?? cleanString(step?.title);
    if (!description) continue;
    const tools = Array.isArray(step.tools)
      ? step.tools.filter((t): t is string => typeof t === 'string' && availableToolNames.has(t))
      : undefined;
    const acceptanceCriteria = asStringArray(step.acceptanceCriteria).map((s) => s.trim()).filter(Boolean);
    const status = typeof step.status === 'string' && STEP_STATUSES.has(step.status)
      ? step.status as PlanStep['status']
      : undefined;
    plan.push({
      id: cleanString(step.id),
      title: cleanString(step.title),
      description,
      tools: tools && tools.length > 0 ? tools : undefined,
      requiresApproval: step.requiresApproval === true ? true : undefined,
      acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : undefined,
      expectedOutput: cleanString(step.expectedOutput),
      status,
    });
  }
  return plan;
}

function compactLightweightPlan(
  plan: PlanStep[],
  goal: string,
  successCriteria: string[],
): PlanStep[] {
  const tools = [...new Set(plan.flatMap((step) => step.tools ?? []))];
  const expectedOutput = [...plan]
    .reverse()
    .map((step) => step.expectedOutput)
    .find((value): value is string => !!value);

  return [{
    id: plan[0]?.id ?? 'step-1',
    title: goal.slice(0, 120),
    description: goal.slice(0, 1_200),
    tools: tools.length > 0 ? tools : undefined,
    requiresApproval: plan.some((step) => step.requiresApproval) ? true : undefined,
    acceptanceCriteria: successCriteria.length > 0 ? successCriteria : undefined,
    expectedOutput,
    status: 'pending',
  }];
}

function buildAssessmentAndTaskBook(
  parsed: DecodedPlan,
  plan: PlanStep[],
  inboundText: string,
): { assessment: NeedAssessment; taskBook: TaskBook } {
  const rawAssessment = parsed.assessment ?? {};
  const rawTaskBook = parsed.taskBook ?? {};
  const complexity = normalizeComplexity(rawAssessment.complexity ?? rawTaskBook.complexity);
  const goal =
    cleanString(rawAssessment.goal)
    ?? cleanString(rawTaskBook.goal)
    ?? cleanString(rawAssessment.userNeed)
    ?? cleanString(inboundText.slice(0, 240))
    ?? 'Address the user request';
  const successCriteria = asStringArray(rawAssessment.successCriteria).map((s) => s.trim()).filter(Boolean);
  const taskBookCriteria = asStringArray(rawTaskBook.successCriteria).map((s) => s.trim()).filter(Boolean);
  const criteria = successCriteria.length > 0
    ? successCriteria
    : taskBookCriteria.length > 0
      ? taskBookCriteria
      : [`The reply or output satisfies: ${goal}`];
  const missingInfo = asStringArray(rawAssessment.missingInfo).map((s) => s.trim()).filter(Boolean);
  const maxExtraScopeRatio = normalizeExtraScopeRatio(
    rawAssessment.maxExtraScopeRatio ?? rawTaskBook.overdeliveryPolicy?.maxExtraScopeRatio,
    complexity,
  );
  const requiresTaskBook = requiresStructuredTaskBook(complexity);

  const assessment: NeedAssessment = {
    userNeed: cleanString(rawAssessment.userNeed) ?? goal,
    complexity,
    goal,
    successCriteria: criteria,
    missingInfo: missingInfo.length > 0 ? missingInfo : undefined,
    needsClarification: rawAssessment.needsClarification === true ? true : undefined,
    requiresTaskBook,
    maxExtraScopeRatio,
    rationale: cleanString(rawAssessment.rationale),
  };

  const taskBook: TaskBook = {
    assessment,
    goal,
    complexity,
    successCriteria: criteria,
    steps: plan,
    overdeliveryPolicy: {
      maxExtraScopeRatio,
      guidance: cleanString(rawTaskBook.overdeliveryPolicy?.guidance)
        ?? 'Slightly exceed expectations only when it helps the stated goal; do not exceed the calibrated scope limit.',
    },
  };

  return { assessment, taskBook };
}

function resolvedStepId(step: PlanStep, index: number): string {
  return step.id ?? `step-${index + 1}`;
}

function compactReplanEvidence(ctx: RunContext, request: PartialReplanRequest): string {
  const targets = new Set(request.targetStepIds);
  const evidence = (ctx.taskExecution?.steps ?? []).map((step) => ({
    stepId: step.stepId,
    status: step.status,
    preserved: step.status === 'done' && !targets.has(step.stepId),
    output: step.output?.slice(0, 600),
    error: step.error,
    failureKind: step.failureKind,
  }));
  return JSON.stringify(evidence);
}

function renderReplanFeedback(ctx: RunContext, request: PartialReplanRequest): string {
  const previous = ctx.taskBook;
  return `\n\n---\nPartial re-plan request (attempt ${request.attempt}):
Reason: ${request.reason}
Feedback: ${request.feedback}
Only these step ids may be revised: ${request.targetStepIds.join(', ')}
Previous task book: ${JSON.stringify(previous)}
Execution evidence: ${compactReplanEvidence(ctx, request)}

Return a complete taskBook using the SAME ids for existing steps.
- Preserve the original goal, success criteria, complexity, and scope limit.
- Do not modify completed steps or add unrelated scope.
- Revise only the listed failed/incomplete steps.
- Keep completed-step evidence as authoritative.`;
}

function mergePartialTaskBook(
  previous: TaskBook,
  generated: TaskBook,
  request: PartialReplanRequest,
  ctx: RunContext,
): TaskBook {
  const targets = new Set(request.targetStepIds);
  const previousIds = previous.steps.map((step, index) => resolvedStepId(step, index));
  const nonTargetIds = new Set(previousIds.filter((id) => !targets.has(id)));
  const generatedById = new Map<string, PlanStep>();
  const replacementPool: PlanStep[] = [];

  generated.steps.forEach((step, index) => {
    const id = resolvedStepId(step, index);
    if (targets.has(id)) generatedById.set(id, step);
    else if (!nonTargetIds.has(id)) replacementPool.push(step);
  });

  const completed = new Map((ctx.taskExecution?.steps ?? []).map((step) => [step.stepId, step]));
  const revisedStepIds: string[] = [];
  const steps = previous.steps.map((step, index): PlanStep => {
    const id = previousIds[index]!;
    if (!targets.has(id)) {
      return {
        ...step,
        id,
        status: completed.get(id)?.status === 'done' ? 'done' : step.status,
      };
    }

    const replacement = generatedById.get(id) ?? replacementPool.shift();
    revisedStepIds.push(id);
    return {
      ...step,
      ...(replacement ?? {}),
      id,
      status: 'pending',
    };
  });

  const record = [...(ctx.replanHistory ?? [])]
    .reverse()
    .find((item) => item.attempt === request.attempt && item.requestedAt === request.requestedAt);
  if (record) {
    record.revisedStepIds = revisedStepIds;
    record.decidedAt = new Date().toISOString();
  }

  return {
    ...previous,
    steps,
    stageResults: previous.stageResults ?? ctx.taskExecution?.steps,
  };
}

/** Factory: creates a decide stage. */
export function createDecideStage(deps: DecideStageDeps) {
  return async function decideStage(ctx: RunContext): Promise<StageResult> {
    const resolved = resolvePromptConfig(deps.config, deps.branding);
    const systemPrompt = await assembleSystemPrompt(resolved, {
      tools: ctx.tools,
      bootstrap: ctx.bootstrap ?? {},
      prelude: ctx.prelude,
      memoryRootIndex: ctx.memoryRootIndex,
    });

    const availableToolNames = new Set(ctx.tools.map((t) => t.name));

    const previousTaskBook = ctx.taskBook;
    const partialReplan = ctx.partialReplanRequest;
    // VERIFY -> DECIDE re-entry: a task-book run gets a strict step-scoped
    // contract; legacy plans retain the older whole-plan feedback path.
    const verifyFeedback = partialReplan && previousTaskBook
      ? renderReplanFeedback(ctx, partialReplan)
      : ctx.verifyFeedback
        ? `\n\n---\nPrevious plan did not achieve the goal. Verify feedback:\n${ctx.verifyFeedback}\nPlease produce a REVISED assessment and taskBook that addresses this feedback.`
        : '';
    ctx.verifyFeedback = undefined;

    const inboundText = textOf(ctx.inbound) || '(empty message)';
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: appendSystemPromptAddons(
          systemPrompt + '\n\n---\n\n' + SYSTEM_PROMPT,
          ctx.profilePromptAddon,
        ),
      },
      ...ctx.history.map(toChatMessage),
      userChatMessage(inboundText + verifyFeedback, ctx.attachments),
    ];

    let parsed: DecodedPlan | null;
    let attempts: number;
    try {
      ({ parsed, attempts } = await callLlmForJson<DecodedPlan>(
        deps.llm,
        deps.model,
        messages,
        { maxAttempts: 3, maxTokens: 1800, signal: ctx.signal },
      ));
    } catch (e) {
      ctx.lastError = {
        stage: 'decide',
        message: `transport error: ${(e as Error).message}`,
      };
      return { stage: 'decide', next: 'recover', ok: false, error: ctx.lastError.message };
    }

    if (!parsed) {
      ctx.lastError = {
        stage: 'decide',
        message: `failed to decode decision after ${attempts} attempt(s)`,
      };
      return { stage: 'decide', next: 'recover', ok: false, error: ctx.lastError.message };
    }

    // Prefer the new taskBook shape, but keep accepting legacy { plan: [...] }.
    let plan = normalizePlan(parsed.taskBook?.steps, availableToolNames);
    if (plan.length === 0) {
      plan = normalizePlan(parsed.plan, availableToolNames);
    }

    if (plan.length === 0 && parsed.assessment?.needsClarification === true) {
      plan = [{
        id: 'clarify',
        title: 'Clarify missing information',
        description: 'Ask the user for the missing information before executing.',
        acceptanceCriteria: ['The user supplies the blocking information.'],
        status: 'pending',
      }];
    }

    if (plan.length === 0) {
      ctx.lastError = { stage: 'decide', message: 'decoded decision had no valid steps' };
      return { stage: 'decide', next: 'recover', ok: false, error: ctx.lastError.message };
    }

    const built = buildAssessmentAndTaskBook(parsed, plan, inboundText);
    let assessment = built.assessment;
    let taskBook = built.taskBook;

    if (!partialReplan && !assessment.needsClarification && !assessment.requiresTaskBook) {
      plan = compactLightweightPlan(plan, assessment.goal, assessment.successCriteria);
      taskBook = { ...taskBook, steps: plan };
    }

    if (assessment.needsClarification) {
      ctx.needAssessment = assessment;
      ctx.taskBook = taskBook;
      ctx.plan = plan;
      ctx.clarificationRequest = buildClarificationRequest(
        parsed,
        assessment,
        inboundText,
        ctx.runId,
        new Date().toISOString(),
      );
      return {
        stage: 'decide',
        next: 'ask_user',
        ok: true,
        meta: {
          complexity: assessment.complexity,
          needsClarification: true,
          missingInfo: assessment.missingInfo,
          clarificationRequestId: ctx.clarificationRequest.id,
          llmAttempts: attempts,
        },
      };
    }

    if (partialReplan && previousTaskBook) {
      taskBook = mergePartialTaskBook(previousTaskBook, taskBook, partialReplan, ctx);
      assessment = previousTaskBook.assessment;
      plan = taskBook.steps;
    }

    ctx.needAssessment = assessment;
    ctx.taskBook = taskBook;
    ctx.plan = plan;
    ctx.onToolEvent?.({ type: 'task_book', taskBook });

    return {
      stage: 'decide',
      next: 'execute',
      ok: true,
      meta: {
        planSteps: plan.length,
        complexity: assessment.complexity,
        maxExtraScopeRatio: assessment.maxExtraScopeRatio,
        requiresTaskBook: assessment.requiresTaskBook,
        partialReplan: partialReplan
          ? { attempt: partialReplan.attempt, targetStepIds: partialReplan.targetStepIds }
          : undefined,
        llmAttempts: attempts,
      },
    };
  };
}
