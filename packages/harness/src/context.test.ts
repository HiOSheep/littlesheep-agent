// @littlesheep/harness — context.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRunContext, readBootstrapFiles } from './context.js';
import { createMockSessionManager, createMockMemoryStore } from './tests/helpers.js';
import { DEFAULT_CONFIG } from '@littlesheep/config';
import { DEFAULT_BRANDING } from '@littlesheep/branding';
import { textMessage } from '@littlesheep/types';
import type { Message } from '@littlesheep/types';

describe('readBootstrapFiles', () => {
  it('skips missing files, returns map keyed by full filename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-ctx-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# agents');
      writeFileSync(join(dir, 'MEMORY.md'), '# must be indexed, not bootstrapped');
      // SOUL/USER/TOOLS absent
      const out = await readBootstrapFiles(dir);
      expect(out['AGENTS.md']).toBe('# agents');
      expect(out['SOUL.md']).toBeUndefined();
      expect(Object.keys(out)).toEqual(['AGENTS.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildRunContext', () => {
  it('assembles ctx without eagerly reading daily/long-term memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-ctx-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# agents rules');
      const prior = textMessage('user', 'prior');
      const sm = createMockSessionManager({ history: [prior] });
      const ms = createMockMemoryStore();
      const ctx = await buildRunContext({
        sessionId: 's1',
        inbound: textMessage('user', 'go'),
        sessionManager: sm,
        memoryStore: ms,
        tools: [],
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'openai/gpt-4o',
        bootstrapDir: dir,
      });
      expect(ctx.sessionId).toBe('s1');
      expect(ctx.model).toBe('openai/gpt-4o');
      expect(ctx.history).toEqual([prior]);
      expect(ctx.bootstrap['AGENTS.md']).toBe('# agents rules');
      expect(ctx.toolContext.sessionId).toBe('s1');
      expect(ctx.toolContext.cwd).toBe(process.cwd());
      expect(ctx.produced).toEqual([]);
      expect(ctx.prelude).toBeUndefined();
      expect(ms.readDaily).not.toHaveBeenCalled();
      expect(ms.readLongTerm).not.toHaveBeenCalled();
      expect(sm.readRecent).toHaveBeenCalledWith(
        's1',
        DEFAULT_CONFIG.sessions.compaction.keepRecent,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bootstrapDir defaults to cwd when omitted', async () => {
    const sm = createMockSessionManager();
    const ms = createMockMemoryStore();
    const ctx = await buildRunContext({
      sessionId: 's1',
      inbound: textMessage('user', 'go'),
      sessionManager: sm,
      memoryStore: ms,
      tools: [],
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'm',
    });
    // ctx.bootstrap is always defined (may be empty object if cwd has no .md)
    expect(ctx.bootstrap).toBeDefined();
    expect(typeof ctx.bootstrap).toBe('object');
  });

  it('loads the versioned session summary without replacing recent messages', async () => {
    const prior = textMessage('assistant', 'recent reply');
    const compaction = {
      version: 1 as const,
      id: 'summary-1',
      collapsedCount: 40,
      summary: 'Earlier task constraints and decisions.',
      compactedAt: '2026-07-13T01:00:00.000Z',
      sourceStartMessageId: 'message-1',
      sourceEndMessageId: 'message-40',
      sourceStartAt: '2026-07-12T01:00:00.000Z',
      sourceEndAt: '2026-07-13T00:00:00.000Z',
    };
    const sm = createMockSessionManager({
      history: [prior],
      metadata: {
        createdAt: '2026-07-12T01:00:00.000Z',
        updatedAt: '2026-07-13T01:00:00.000Z',
        messageCount: 41,
        compacted: true,
        compaction,
      },
    });
    const ctx = await buildRunContext({
      sessionId: 's1',
      inbound: textMessage('user', 'continue'),
      sessionManager: sm,
      memoryStore: createMockMemoryStore(),
      tools: [],
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'openai/gpt-5.5',
    });

    expect(ctx.sessionSummary).toEqual(compaction);
    expect(ctx.history).toEqual([prior]);
  });

  it('runId auto-generated when absent', async () => {
    const sm = createMockSessionManager();
    const ms = createMockMemoryStore();
    const ctx = await buildRunContext({
      sessionId: 's1',
      inbound: textMessage('user', 'go'),
      sessionManager: sm,
      memoryStore: ms,
      tools: [],
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'm',
    });
    expect(ctx.runId).toBeTruthy();
    expect(typeof ctx.runId).toBe('string');
  });

  it('forwards signal + approve + log into toolContext', async () => {
    const sm = createMockSessionManager();
    const ms = createMockMemoryStore();
    const ac = new AbortController();
    const approve = async () => true;
    const log = () => {};
    const ctx = await buildRunContext({
      sessionId: 's1',
      inbound: textMessage('user', 'go'),
      sessionManager: sm,
      memoryStore: ms,
      tools: [],
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'm',
      signal: ac.signal,
      approve,
      log,
    });
    expect(ctx.signal).toBe(ac.signal);
    expect(ctx.toolContext.signal).toBe(ac.signal);
    expect(ctx.toolContext.approve).toBe(approve);
    expect(ctx.toolContext.log).toBe(log);
  });

  it('preserves attachment metadata on RunContext without reading attachment content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ls-ctx-attachment-'));
    try {
      const attachments = [{
        path: join(root, 'missing-notes.md'),
        name: 'notes.md',
        kind: 'document' as const,
        mimeType: 'text/markdown',
        size: 2048,
      }];

      const ctx = await buildRunContext({
        sessionId: 's1',
        inbound: textMessage('user', 'inspect the attachment'),
        sessionManager: createMockSessionManager(),
        memoryStore: createMockMemoryStore(),
        tools: [],
        config: DEFAULT_CONFIG,
        branding: DEFAULT_BRANDING,
        model: 'test/model',
        cwd: root,
        attachments,
      });

      expect(ctx.attachments).toBe(attachments);
      expect(ctx.attachments?.[0]).toMatchObject({
        name: 'notes.md',
        kind: 'document',
        size: 2048,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ─── M3: history filtering ─────────────────────────────────────────────

  it('history 含 tool 消息 → ctx.history 过滤后只含 text 消息', async () => {
    const toolMsg: Message = {
      id: 't1',
      role: 'tool',
      timestamp: new Date().toISOString(),
      content: [{ type: 'tool_result', result: { callId: 'c1', ok: true, output: 'x' } }],
    };
    const textMsg = textMessage('user', 'previous question');
    const sm = createMockSessionManager({ history: [toolMsg, textMsg] });
    const ms = createMockMemoryStore();
    const ctx = await buildRunContext({
      sessionId: 's1',
      inbound: textMessage('user', 'go'),
      sessionManager: sm,
      memoryStore: ms,
      tools: [],
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'm',
    });
    expect(ctx.history).toEqual([textMsg]);
    expect(ctx.history.every((m) => m.role !== 'tool')).toBe(true);
  });

  it('links the next inbound message to the latest clarification request', async () => {
    const request = {
      id: 'run-1:clarification',
      kind: 'missing_information' as const,
      sourceStage: 'decide' as const,
      createdAt: '2026-07-10T00:00:00.000Z',
      originalRequest: 'edit that file',
      blockingReason: 'target missing',
      questions: [{ id: 'question-1', field: 'path', prompt: 'Which file?', required: true }],
    };
    const assistant = textMessage('assistant', 'Which file?', { clarificationRequest: request });
    const inbound = textMessage('user', 'README.md');
    const sm = createMockSessionManager({ history: [assistant] });
    const ctx = await buildRunContext({
      sessionId: 's1',
      inbound,
      sessionManager: sm,
      memoryStore: createMockMemoryStore(),
      tools: [],
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'm',
    });

    expect(ctx.clarificationResponse).toEqual({
      requestId: request.id,
      answer: 'README.md',
      answeredAt: inbound.timestamp,
    });
    expect(inbound.clarificationResponse).toEqual(ctx.clarificationResponse);
  });

  it('does not link an inbound message when clarification is not the latest turn', async () => {
    const assistant = textMessage('assistant', 'Which file?', {
      clarificationRequest: {
        id: 'old:clarification',
        kind: 'missing_information',
        sourceStage: 'decide',
        createdAt: '2026-07-10T00:00:00.000Z',
        originalRequest: 'edit it',
        blockingReason: 'target missing',
        questions: [{ id: 'question-1', field: 'path', prompt: 'Which file?', required: true }],
      },
    });
    const resolvedUser = textMessage('user', 'README.md');
    const sm = createMockSessionManager({ history: [assistant, resolvedUser] });
    const ctx = await buildRunContext({
      sessionId: 's1',
      inbound: textMessage('user', 'new unrelated request'),
      sessionManager: sm,
      memoryStore: createMockMemoryStore(),
      tools: [],
      config: DEFAULT_CONFIG,
      branding: DEFAULT_BRANDING,
      model: 'm',
    });

    expect(ctx.clarificationResponse).toBeUndefined();
  });
});
