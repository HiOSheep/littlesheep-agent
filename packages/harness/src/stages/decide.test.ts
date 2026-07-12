// @littlesheep/harness — stages/decide.test.ts
import { describe, it, expect } from 'vitest';
import { createDecideStage } from './decide.js';
import { createMockLlm, textResponse, makeCtx, makeTool } from '../tests/helpers.js';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage } from '@littlesheep/types';

const deps = { model: 'test', config: DEFAULT_CONFIG, branding: DEFAULT_BRANDING };

describe('decideStage', () => {
  it('parses a valid plan, transitions to execute', async () => {
    const tool = makeTool('read', { ok: true, output: '' });
    const llm = createMockLlm(textResponse('{"plan":[{"description":"read file","tools":["read"]}]}'));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'read the file') });
    const res = await stage(ctx);
    expect(res.next).toBe('execute');
    expect(res.ok).toBe(true);
    expect(ctx.plan).toHaveLength(1);
    expect(ctx.plan![0].description).toBe('read file');
    expect(ctx.plan![0].tools).toEqual(['read']);
  });

  it('includes the active behavior profile in the planning system prompt', async () => {
    const systemPrompts: string[] = [];
    const llm = createMockLlm((request) => {
      systemPrompts.push(String(request.messages[0]?.content ?? ''));
      return textResponse('{"plan":[{"description":"inspect the repository"}]}');
    });
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'inspect the repository') });
    ctx.profilePromptAddon = 'PROFILE_SENTINEL_DECIDE';

    await stage(ctx);

    expect(systemPrompts[0]).toContain('PROFILE_SENTINEL_DECIDE');
  });

  it('extracts JSON from markdown-wrapped response', async () => {
    const llm = createMockLlm(textResponse('```json\n{"plan":[{"description":"step"}]}\n```'));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'do it') });
    const res = await stage(ctx);
    expect(res.next).toBe('execute');
    expect(ctx.plan).toHaveLength(1);
  });

  it('filters out tool names not in the registry', async () => {
    const tool = makeTool('read', { ok: true, output: '' });
    const llm = createMockLlm(textResponse(
      '{"plan":[{"description":"step","tools":["read","nonexistent"]}]}',
    ));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'go') });
    const res = await stage(ctx);
    expect(res.next).toBe('execute');
    expect(ctx.plan![0].tools).toEqual(['read']);
  });

  it('3 parse failures → recover', async () => {
    const llm = createMockLlm([
      textResponse('not json'),
      textResponse('still not json'),
      textResponse('nope'),
    ]);
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'go') });
    const res = await stage(ctx);
    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
    expect(ctx.lastError?.stage).toBe('decide');
    expect(llm.chat).toHaveBeenCalledTimes(3);
  });

  it('empty response → recover', async () => {
    const llm = createMockLlm(textResponse(''));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'go') });
    const res = await stage(ctx);
    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
  });

  it('plan with no valid steps (empty descriptions) → recover', async () => {
    const llm = createMockLlm(textResponse('{"plan":[{"description":""}]}'));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'go') });
    const res = await stage(ctx);
    expect(res.next).toBe('recover');
    expect(res.ok).toBe(false);
  });

  it('preserves requiresApproval flag', async () => {
    const llm = createMockLlm(textResponse(
      '{"plan":[{"description":"risky step","requiresApproval":true}]}',
    ));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'go') });
    const res = await stage(ctx);
    expect(res.next).toBe('execute');
    expect(ctx.plan![0].requiresApproval).toBe(true);
  });

  it('parses taskBook demand calibration and clamps overdelivery to 3x', async () => {
    const tool = makeTool('read', { ok: true, output: '' });
    const llm = createMockLlm(textResponse(JSON.stringify({
      assessment: {
        userNeed: 'review the core loop',
        complexity: 'complex',
        goal: 'identify core loop gaps',
        successCriteria: ['gaps are identified', 'next action is clear'],
        requiresTaskBook: true,
        maxExtraScopeRatio: 9,
      },
      taskBook: {
        goal: 'identify core loop gaps',
        complexity: 'complex',
        successCriteria: ['gaps are identified', 'next action is clear'],
        overdeliveryPolicy: { maxExtraScopeRatio: 9, guidance: 'stay focused' },
        steps: [{
          id: 'step-1',
          title: 'Inspect',
          description: 'inspect core files',
          tools: ['read', 'missing'],
          acceptanceCriteria: ['state machine files inspected'],
          expectedOutput: 'gap list',
        }],
      },
    })));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ tools: [tool], inbound: textMessage('user', 'review the core') });

    const res = await stage(ctx);

    expect(res.next).toBe('execute');
    expect(ctx.needAssessment?.complexity).toBe('complex');
    expect(ctx.needAssessment?.maxExtraScopeRatio).toBe(3);
    expect(ctx.taskBook?.goal).toBe('identify core loop gaps');
    expect(ctx.taskBook?.successCriteria).toEqual(['gaps are identified', 'next action is clear']);
    expect(ctx.taskBook?.steps[0].tools).toEqual(['read']);
    expect(ctx.taskBook?.steps[0].acceptanceCriteria).toEqual(['state machine files inspected']);
  });

  it('routes to ask_user when demand calibration says required information is missing', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      assessment: {
        userNeed: 'edit a target file',
        complexity: 'simple',
        goal: 'edit the requested file',
        successCriteria: ['target file is known'],
        missingInfo: ['target file path'],
        needsClarification: true,
        requiresTaskBook: false,
        maxExtraScopeRatio: 1.25,
      },
      clarification: {
        blockingReason: 'A target must be selected before editing.',
        questions: [{
          field: 'targetPath',
          prompt: 'Which file should I edit?',
          required: true,
          options: ['README.md', 'package.json'],
          defaultValue: 'README.md',
        }],
      },
      taskBook: {
        goal: 'edit the requested file',
        complexity: 'simple',
        successCriteria: ['target file is known'],
        steps: [],
      },
    })));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', 'edit that file') });

    const res = await stage(ctx);

    expect(res.next).toBe('ask_user');
    expect(res.ok).toBe(true);
    expect(ctx.lastError).toBeUndefined();
    expect(ctx.clarificationRequest).toMatchObject({
      kind: 'missing_information',
      sourceStage: 'decide',
      blockingReason: 'A target must be selected before editing.',
      missingInfo: ['target file path'],
    });
    expect(ctx.clarificationRequest?.questions[0]).toEqual({
      id: 'question-1',
      field: 'targetPath',
      prompt: 'Which file should I edit?',
      required: true,
      options: ['README.md', 'package.json'],
      defaultValue: 'README.md',
    });
    expect(ctx.plan?.[0].id).toBe('clarify');
  });

  it('builds a fallback clarification question from missingInfo', async () => {
    const llm = createMockLlm(textResponse(JSON.stringify({
      assessment: {
        userNeed: 'write a file',
        complexity: 'simple',
        goal: 'write the requested file',
        successCriteria: ['path is known'],
        missingInfo: ['目标文件路径'],
        needsClarification: true,
        requiresTaskBook: false,
      },
      taskBook: { steps: [] },
    })));
    const stage = createDecideStage({ ...deps, llm });
    const ctx = makeCtx({ inbound: textMessage('user', '帮我写到那个文件里') });

    const res = await stage(ctx);

    expect(res.next).toBe('ask_user');
    expect(ctx.clarificationRequest?.questions[0]?.prompt).toBe('请补充目标文件路径。');
  });

  it('revises only failed/incomplete steps and preserves completed evidence', async () => {
    const prompts: string[] = [];
    const llm = createMockLlm((request) => {
      prompts.push(String(request.messages.at(-1)?.content ?? ''));
      return textResponse(JSON.stringify({
        assessment: {
          userNeed: 'expanded unrelated scope',
          complexity: 'complex',
          goal: 'replace the original goal',
          successCriteria: ['different criterion'],
          requiresTaskBook: true,
          maxExtraScopeRatio: 3,
        },
        taskBook: {
          goal: 'replace the original goal',
          complexity: 'complex',
          successCriteria: ['different criterion'],
          steps: [
            { id: 'step-1', description: 'maliciously change completed step' },
            { id: 'step-2', description: 'retry step two with the corrected path' },
            { id: 'step-3', description: 'verify the corrected result' },
          ],
        },
      }));
    });
    const stage = createDecideStage({ ...deps, llm });
    const previousTaskBook = {
      assessment: {
        userNeed: 'complete the original workflow',
        complexity: 'standard' as const,
        goal: 'complete the original goal',
        successCriteria: ['original criterion'],
        requiresTaskBook: true,
        maxExtraScopeRatio: 1.5,
      },
      goal: 'complete the original goal',
      complexity: 'standard' as const,
      successCriteria: ['original criterion'],
      steps: [
        { id: 'step-1', description: 'completed original step', status: 'done' as const },
        { id: 'step-2', description: 'failed original step', status: 'failed' as const },
        { id: 'step-3', description: 'pending original step', status: 'pending' as const },
      ],
      overdeliveryPolicy: { maxExtraScopeRatio: 1.5, guidance: 'keep original scope' },
    };
    const ctx = makeCtx({
      inbound: textMessage('user', 'complete the original workflow'),
      taskBook: previousTaskBook,
    });
    ctx.taskExecution = {
      goal: previousTaskBook.goal,
      complexity: 'standard',
      status: 'failed',
      startedAt: '2026-07-10T00:00:00.000Z',
      steps: [
        {
          stepId: 'step-1', description: 'completed original step', status: 'done',
          startedAt: '2026-07-10T00:00:00.000Z', output: 'authoritative evidence',
          toolCallIds: [], toolResults: [],
        },
        {
          stepId: 'step-2', description: 'failed original step', status: 'failed',
          startedAt: '2026-07-10T00:00:01.000Z', error: 'wrong path', failureKind: 'not_found',
          toolCallIds: [], toolResults: [],
        },
      ],
    };
    ctx.partialReplanRequest = {
      attempt: 1,
      requestedAt: '2026-07-10T00:00:02.000Z',
      targetStepIds: ['step-2', 'step-3'],
      reason: 'wrong path',
      feedback: 'use the corrected path and then verify',
    };
    ctx.replanHistory = [{
      ...ctx.partialReplanRequest,
      preservedStepIds: ['step-1'],
    }];
    ctx.verifyFeedback = ctx.partialReplanRequest.feedback;

    const res = await stage(ctx);

    expect(res.next).toBe('execute');
    expect(ctx.taskBook?.goal).toBe('complete the original goal');
    expect(ctx.taskBook?.successCriteria).toEqual(['original criterion']);
    expect(ctx.taskBook?.overdeliveryPolicy.maxExtraScopeRatio).toBe(1.5);
    expect(ctx.taskBook?.steps[0]).toMatchObject({
      id: 'step-1', description: 'completed original step', status: 'done',
    });
    expect(ctx.taskBook?.steps[1]).toMatchObject({
      id: 'step-2', description: 'retry step two with the corrected path', status: 'pending',
    });
    expect(ctx.taskBook?.steps[2]).toMatchObject({
      id: 'step-3', description: 'verify the corrected result', status: 'pending',
    });
    expect(ctx.replanHistory?.[0]?.revisedStepIds).toEqual(['step-2', 'step-3']);
    expect(ctx.replanHistory?.[0]?.decidedAt).toBeTruthy();
    expect(prompts[0]).toContain('Only these step ids may be revised: step-2, step-3');
    expect(prompts[0]).toContain('authoritative evidence');
  });
});
