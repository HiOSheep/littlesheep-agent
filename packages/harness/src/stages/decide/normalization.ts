import type {
  ClarificationQuestion,
  ClarificationRequest,
  NeedAssessment,
  PlanStep,
  TaskBook,
  TaskComplexity,
} from '@littlesheep/types';
import { asStringArray } from '../_shared.js';
import type { DecodedPlan, DecodedPlanStep } from './contracts.js';

const COMPLEXITIES: readonly TaskComplexity[] = ['trivial', 'simple', 'standard', 'complex'];
const STEP_STATUSES = new Set(['pending', 'in_progress', 'done', 'blocked', 'skipped']);

export function buildClarificationRequest(
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

export function normalizePlan(
  raw: DecodedPlanStep[] | undefined,
  availableToolNames: Set<string>,
): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const plan: PlanStep[] = [];
  for (const step of raw) {
    const description = cleanString(step?.description) ?? cleanString(step?.title);
    if (!description) continue;
    const tools = Array.isArray(step.tools)
      ? step.tools.filter((tool): tool is string => typeof tool === 'string' && availableToolNames.has(tool))
      : undefined;
    const acceptanceCriteria = asStringArray(step.acceptanceCriteria).map((item) => item.trim()).filter(Boolean);
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

export function compactLightweightPlan(
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

export function buildAssessmentAndTaskBook(
  parsed: DecodedPlan,
  plan: PlanStep[],
  inboundText: string,
): { assessment: NeedAssessment; taskBook: TaskBook } {
  const rawAssessment = parsed.assessment ?? {};
  const rawTaskBook = parsed.taskBook ?? {};
  const complexity = normalizeComplexity(rawAssessment.complexity ?? rawTaskBook.complexity);
  const goal = cleanString(rawAssessment.goal)
    ?? cleanString(rawTaskBook.goal)
    ?? cleanString(rawAssessment.userNeed)
    ?? cleanString(inboundText.slice(0, 240))
    ?? 'Address the user request';
  const successCriteria = asStringArray(rawAssessment.successCriteria).map((item) => item.trim()).filter(Boolean);
  const taskBookCriteria = asStringArray(rawTaskBook.successCriteria).map((item) => item.trim()).filter(Boolean);
  const criteria = successCriteria.length > 0
    ? successCriteria
    : taskBookCriteria.length > 0
      ? taskBookCriteria
      : [`The reply or output satisfies: ${goal}`];
  const missingInfo = asStringArray(rawAssessment.missingInfo).map((item) => item.trim()).filter(Boolean);
  const maxExtraScopeRatio = normalizeExtraScopeRatio(
    rawAssessment.maxExtraScopeRatio ?? rawTaskBook.overdeliveryPolicy?.maxExtraScopeRatio,
    complexity,
  );
  const requiresTaskBook = complexity === 'standard' || complexity === 'complex';
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
  return {
    assessment,
    taskBook: {
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
    },
  };
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeComplexity(value: unknown): TaskComplexity {
  return typeof value === 'string' && COMPLEXITIES.includes(value as TaskComplexity)
    ? value as TaskComplexity
    : 'standard';
}

function normalizeExtraScopeRatio(value: unknown, complexity: TaskComplexity): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN;
  const fallback = complexity === 'trivial' ? 1 : complexity === 'simple' ? 1.25 : complexity === 'complex' ? 2 : 1.5;
  return Math.min(3, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

function usesChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function fallbackQuestionPrompt(missing: string, inboundText: string): string {
  return usesChinese(inboundText) ? `请补充${missing}。` : `Please provide ${missing}.`;
}
