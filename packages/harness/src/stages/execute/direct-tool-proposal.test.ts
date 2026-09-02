import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { asSessionId, textMessage, type NetworkReadPolicy } from '@littlesheep/types';
import { makeCtx, makeTool } from '../../tests/helpers.js';
import { resolveDirectToolProposal } from './direct-tool-proposal.js';

describe('direct tool proposal safety gate', () => {
  it.each(['full', 'research', 'restricted'] as const)(
    'rejects a hard-denied web_search proposal before execution in %s mode',
    (permissionMode) => {
      const webSearch = webTool('web_search');
      const ctx = makeCtx({
        inbound: textMessage('user', '请只使用 web_search 工具搜索最新公开资料'),
        classification: explicitToolClassification(),
        tools: [webSearch],
        toolSources: { web_search: 'builtin' },
        toolContext: {
          sessionId: asSessionId('direct-proposal-session'),
          permissionMode,
          networkPolicy: webPolicy({ enabled: false, mode: 'disabled' }),
        },
      });
      const taskBook = webTaskBook({ query: '最新公开资料' });
      ctx.taskBook = taskBook;

      expect(resolveDirectToolProposal(ctx, taskBook, taskBook.steps[0]!, undefined, {
        stepId: 'step-1',
        resources: [],
        sideEffect: 'read',
      })).toBeUndefined();
    },
  );

  it('rejects a safe web_search proposal when strict read approval would require the broker', () => {
    const webSearch = webTool('web_search');
    const ctx = makeCtx({
      inbound: textMessage('user', '请只使用 web_search 工具搜索最新公开资料'),
      classification: explicitToolClassification(),
      tools: [webSearch],
      toolSources: { web_search: 'builtin' },
      toolContext: {
        permissionMode: 'research',
        networkPolicy: webPolicy({ strictReadApproval: true }),
      },
    });
    const taskBook = webTaskBook({ query: '最新公开资料' });
    ctx.taskBook = taskBook;

    expect(resolveDirectToolProposal(ctx, taskBook, taskBook.steps[0]!, undefined, {
      stepId: 'step-1',
      resources: [],
      sideEffect: 'read',
    })).toBeUndefined();
  });

  it('admits a normal public web_search proposal when the resolved policy allows it', () => {
    const webSearch = webTool('web_search');
    const ctx = makeCtx({
      inbound: textMessage('user', '请只使用 web_search 工具搜索最新公开资料'),
      classification: explicitToolClassification(),
      tools: [webSearch],
      toolSources: { web_search: 'builtin' },
      toolContext: {
        permissionMode: 'restricted',
        networkPolicy: webPolicy(),
      },
    });
    const taskBook = webTaskBook({ query: '最新公开资料' });
    ctx.taskBook = taskBook;

    expect(resolveDirectToolProposal(ctx, taskBook, taskBook.steps[0]!, undefined, {
      stepId: 'step-1',
      resources: [],
      sideEffect: 'read',
    })).toMatchObject({ tool: webSearch, input: { query: '最新公开资料' } });
  });
});

function webTool(name: 'web_search' | 'web_fetch') {
  return makeTool(name, { ok: true, output: 'unused' }, {
    inputSchema: name === 'web_search'
      ? z.object({ query: z.string() })
      : z.object({ url: z.string() }),
  });
}

function explicitToolClassification() {
  return {
    activity: 'execute' as const,
    type: 'problem' as const,
    confidence: 0.99,
    source: 'rules' as const,
    reason: 'explicit tool instruction',
  };
}

function webTaskBook(input: unknown) {
  return {
    assessment: {
      userNeed: 'search public web',
      complexity: 'trivial' as const,
      goal: 'search public web',
      successCriteria: ['return bounded search results'],
      requiresTaskBook: false,
      maxExtraScopeRatio: 1,
    },
    goal: 'search public web',
    complexity: 'trivial' as const,
    successCriteria: ['return bounded search results'],
    steps: [{
      id: 'step-1',
      description: 'search public web',
      tools: ['web_search'],
      toolProposal: { name: 'web_search', input },
      execution: { mode: 'serial' as const, sideEffect: 'read' as const },
    }],
    overdeliveryPolicy: { maxExtraScopeRatio: 1, guidance: 'stay focused' },
  };
}

function webPolicy(overrides: Partial<NetworkReadPolicy> = {}): NetworkReadPolicy {
  return {
    version: 1,
    enabled: true,
    providerId: 'tavily',
    mode: 'public_anonymous',
    allowDomains: [],
    blockDomains: [],
    strictReadApproval: false,
    maxResults: 10,
    maxQueryChars: 2_000,
    maxQueriesPerRun: 4,
    maxFetchesPerRun: 4,
    maxConcurrentRequests: 4,
    searchTimeoutMs: 15_000,
    fetchTimeoutMs: 20_000,
    totalTimeoutMs: 90_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxExtractedChars: 40_000,
    maxRedirects: 5,
    cacheEnabled: true,
    cacheTtlSeconds: 300,
    cacheMaxBytes: 64 * 1024 * 1024,
    browserFallback: 'approval_required',
    sensitiveQueryPolicy: 'approve',
    ...overrides,
  };
}
