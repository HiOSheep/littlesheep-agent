import { describe, expect, it } from 'vitest';
import {
  BUDGETS,
  PLANNED_TRIAL_COUNT,
  TASK_IDS,
  TRIALS_PER_TASK,
  buildProtocolFrozen,
  buildTrialPlan,
  classifyAttempt,
  evaluateTrialBudget,
  taskDefinitionSha256,
  trialIdentity,
  validateModelConfig,
  validateTrialPlan,
} from './protocol.mjs';

const validModelConfig = {
  providerId: 'deepseek',
  internalModelRef: 'deepseek/deepseek-chat',
  wireModelId: 'deepseek-chat',
  apiProtocol: 'openai-chat-completions',
  baseURL: 'https://api.deepseek.com',
  supportsToolCalls: true,
  temperature: 0,
  maxOutputTokens: 2048,
  timeoutSeconds: 120,
  maxAttempts: 2,
};

describe('R4-D0 trial protocol', () => {
  it('builds exactly four tasks by five trials with unique identities', () => {
    const plan = buildTrialPlan();
    expect(plan).toHaveLength(PLANNED_TRIAL_COUNT);
    expect(new Set(plan.map((item) => item.recordId)).size).toBe(20);
    expect(TASK_IDS.every((taskId) => plan.filter((item) => item.taskId === taskId).length === TRIALS_PER_TASK)).toBe(true);
    expect(validateTrialPlan(plan, { expectedBatchId: plan[0].batchId }).ok).toBe(true);
  });

  it('rejects an out-of-range trial, unknown task and duplicate identity', () => {
    expect(() => trialIdentity({ batchId: 'b', taskId: 'FILE-02-G', trial: 0 })).toThrow(/trial/);
    expect(() => trialIdentity({ batchId: 'b', taskId: 'FILE-02-G', trial: 6 })).toThrow(/trial/);
    expect(() => trialIdentity({ batchId: 'b', taskId: 'FILE-99', trial: 1 })).toThrow(/unknown task/);
    const plan = buildTrialPlan();
    const duplicate = [...plan, plan[0]];
    expect(validateTrialPlan(duplicate).ok).toBe(false);
    expect(validateTrialPlan(duplicate).errors.some((item) => item.includes('duplicate'))).toBe(true);
  });

  it('requires a complete, tool-capable, bounded model configuration', () => {
    expect(validateModelConfig(validModelConfig).ok).toBe(true);
    expect(validateModelConfig({ ...validModelConfig, supportsToolCalls: false }).errors.some((item) => item.includes('supportsToolCalls'))).toBe(true);
    expect(validateModelConfig({ ...validModelConfig, apiProtocol: 'unknown-protocol' }).ok).toBe(false);
    expect(validateModelConfig({ ...validModelConfig, maxOutputTokens: BUDGETS.maxOutputTokensPerRequest + 1 }).ok).toBe(false);
    expect(validateModelConfig({ ...validModelConfig, baseURL: 'http://insecure.example' }).ok).toBe(false);
  });

  it('stops on budget exhaustion instead of raising the budget to finish N=5', () => {
    expect(evaluateTrialBudget({ physicalRequests: 8, outputTokens: 2048 }).stop).toBe(false);
    expect(evaluateTrialBudget({ physicalRequests: 9 }).code).toBe('BUDGET_REQUESTS_EXHAUSTED');
    expect(evaluateTrialBudget({ outputTokens: 2049 }).code).toBe('BUDGET_TOKENS_EXHAUSTED');
    expect(evaluateTrialBudget({ batchPhysicalRequests: BUDGETS.maxBatchPhysicalRequests + 1 }).code).toBe('BUDGET_REQUESTS_EXHAUSTED');
    expect(evaluateTrialBudget({ batchOutputTokens: BUDGETS.maxBatchOutputTokens + 1 }).code).toBe('BUDGET_TOKENS_EXHAUSTED');
  });

  it('classifies capability results separately from infrastructure and stops', () => {
    expect(classifyAttempt({ infrastructureStatus: 'executed', dimensions: { goal: { status: 'passed' }, contract: { status: 'not_applicable' }, mechanism: { status: 'not_exercised' } } }).category).toBe('capability_pass');
    expect(classifyAttempt({ infrastructureStatus: 'executed', dimensions: { goal: { status: 'failed' }, contract: { status: 'not_applicable' }, mechanism: { status: 'not_exercised' } } }).category).toBe('capability_failure');
    expect(classifyAttempt({ infrastructureStatus: 'executed', dimensions: { goal: { status: 'unverified' } } }).category).toBe('capability_unresolved');
    expect(classifyAttempt({ infrastructureStatus: 'harness_error', dimensions: { goal: { status: 'unverified' } } }).category).toBe('infrastructure');
    expect(classifyAttempt({ errorCode: 'BUDGET_REQUESTS_EXHAUSTED' })).toMatchObject({ category: 'stopped', stopCode: 'BUDGET_REQUESTS_EXHAUSTED' });
  });

  it('freezes fingerprints and does not authorize a real provider', () => {
    const frozen = buildProtocolFrozen();
    expect(frozen.mayCallRealProvider).toBe(false);
    expect(frozen.authorization.realProviderAuthorized).toBe(false);
    expect(frozen.plannedTrials).toBe(20);
    expect(frozen.hashes.taskSuite).toMatch(/^[0-9a-f]{64}$/u);
    expect(frozen.hashes.oracleModule).toMatch(/^[0-9a-f]{64}$/u);
    expect(frozen.tasks).toHaveLength(4);
    expect(frozen.tasks.every((task) => /^[0-9a-f]{64}$/u.test(task.definitionSha256))).toBe(true);
    expect(taskDefinitionSha256({ a: 1 })).toBe(taskDefinitionSha256({ a: 1 }));
    expect(frozen.separation.r4cDeliveryRegression).toContain('not a model task score');
  });
});
