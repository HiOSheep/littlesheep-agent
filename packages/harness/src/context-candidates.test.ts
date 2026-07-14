import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@littlesheep/llm';
import { textMessage } from '@littlesheep/types';
import { buildRunRequestCandidates } from './context-candidates.js';
import { makeCtx } from './tests/helpers.js';

describe('buildRunRequestCandidates', () => {
  it('links system, history, inbound, retry constraints, and tool results to explicit sources', () => {
    const first = textMessage('user', 'old request');
    const second = textMessage('assistant', 'old reply');
    const ctx = makeCtx({
      inbound: textMessage('user', 'current request'),
      history: [first, second],
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old request' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'current request' },
      { role: 'assistant', content: '', tool_calls: [{
        id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' },
      }] },
      { role: 'tool', content: 'result', tool_call_id: 'call-1', name: 'read' },
      { role: 'user', content: 'return JSON only' },
    ];

    const candidates = buildRunRequestCandidates(ctx, 'execute', messages);

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      'system_prompt',
      'recent_message',
      'recent_message',
      'user_input',
      'workflow_state',
      'tool_result',
      'output_constraint',
    ]);
    expect(candidates[1]?.source.id).toBe(first.id);
    expect(candidates[2]?.source.id).toBe(second.id);
    expect(candidates[3]?.source.id).toBe(ctx.inbound.id);
    expect(candidates[5]).toMatchObject({ required: true, source: { kind: 'tool', id: 'call-1' } });
    expect(candidates[6]).toMatchObject({ required: true, source: { kind: 'workflow' } });
  });

  it('marks stage-generated user summaries as workflow state', () => {
    const ctx = makeCtx();
    const candidates = buildRunRequestCandidates(ctx, 'verify', [
      { role: 'system', content: 'verify policy' },
      { role: 'user', content: 'execution evidence' },
    ], { history: [], primaryUserKind: 'workflow_state' });

    expect(candidates[1]).toMatchObject({
      kind: 'workflow_state',
      required: true,
      source: { kind: 'workflow', id: 'verify:workflow-input' },
    });
  });

  it('preserves source-aware system segments for Context budgeting', () => {
    const ctx = makeCtx();
    const systemSegments = [{
      id: 'memory-root-index',
      order: 0,
      text: 'memory index',
      kind: 'memory_index' as const,
      source: { kind: 'memory' as const, id: 'root-index' },
      priority: 95,
      required: true,
      sensitive: true,
      scope: 'global' as const,
    }];
    const candidates = buildRunRequestCandidates(ctx, 'reply', [
      { role: 'system', content: 'memory index' },
      { role: 'user', content: 'hello' },
    ], { history: [], systemSegments });

    expect(candidates[0]?.segments).toEqual(systemSegments);
  });

  it('accounts for attachment manifest and loaded content before the primary user message', () => {
    const ctx = makeCtx();
    const candidates = buildRunRequestCandidates(ctx, 'execute', [
      { role: 'system', content: 'policy' },
      { role: 'user', content: 'manifest' },
      { role: 'user', content: 'loaded attachment content' },
      { role: 'user', content: 'summarize the file' },
    ], {
      history: [],
      insertedBeforePrimary: [
        {
          id: 'attachment-manifest',
          kind: 'attachment_manifest',
          source: { kind: 'attachment', id: 'manifest' },
          priority: 92,
          required: true,
        },
        {
          id: 'attachment-content:file-1',
          kind: 'project_knowledge',
          source: { kind: 'attachment', id: 'file-1', path: 'file.txt' },
          priority: 65,
          required: false,
        },
      ],
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      'system_prompt',
      'attachment_manifest',
      'project_knowledge',
      'user_input',
    ]);
  });
});
