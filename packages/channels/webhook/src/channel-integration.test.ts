import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChannelSessionStore,
  DefaultChannelManager,
  type ChannelManagerOptions,
  type ChannelRuntimeConfig,
} from '@littlesheep/plugins';
import type { Session, SessionMetadata, WebEvidenceProjection } from '@littlesheep/types';
import { asSessionId, type SessionId } from '@littlesheep/types';
import { WebhookChannelPlugin } from './plugin.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('Webhook channel through DefaultChannelManager', () => {
  it('returns bounded Web evidence sources over a real loopback request', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'littlesheep-webhook-channel-'));
    cleanups.push(() => rm(dataRoot, { recursive: true, force: true }));

    const evidence: WebEvidenceProjection = {
      version: 1,
      providerId: 'tavily',
      generatedAt: '2026-09-01T00:00:00.000Z',
      completeness: 'partial',
      citationIds: ['web-channel-integration-source'],
      citations: [{
        id: 'web-channel-integration-source',
        origin: 'https://example.com',
        url: 'https://example.com/article',
        urlHash: 'a'.repeat(64),
        title: 'Integration source',
        fetchedAt: '2026-09-01T00:00:00.000Z',
        status: 'partial',
        truncated: true,
      }],
      citationCount: 1,
      documentCount: 1,
      cached: false,
      partial: true,
      truncated: true,
      blocked: true,
      stale: false,
      errorKinds: ['web_provider_rate_limited'],
    };
    const sessionManager = fakeSessionManager();
    const runner = fakeRunner(sessionManager, evidence);
    const manager = new DefaultChannelManager({
      runner,
      sessionStore: new ChannelSessionStore({ bindingsFile: join(dataRoot, 'bindings.json') }),
    });
    manager.registerType('webhook', () => new WebhookChannelPlugin());

    const config: ChannelRuntimeConfig = {
      id: 'webhook-integration',
      type: 'webhook',
      name: 'Webhook integration',
      dmPolicy: { type: 'open' },
      groupPolicy: { type: 'disabled' },
      secrets: {},
      options: { port: 0, path: '/integration' },
    };
    const plugin = await manager.start(config) as WebhookChannelPlugin;
    cleanups.push(() => manager.stop(config.id));
    const address = plugin.address;
    if (!address) throw new Error('webhook integration did not bind a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/integration`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'integration-query-marker',
        conversationId: 'integration-conversation',
        userId: 'integration-user',
      }),
    });
    const body = await response.json() as { ok?: boolean; reply?: string; sessionId?: string };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe('webhook-session-1');
    expect(body.reply).toContain('Sources (partial, truncated, blocked):');
    expect(body.reply).toContain('Integration source');
    expect(body.reply).toContain('fetchedAt: 2026-09-01T00:00:00.000Z');
    expect(body.reply).toContain('[citation:web-channel-integration-source]');
    expect(body.reply).not.toContain('PRIVATE_PAGE_BODY');
    expect(body.reply).not.toContain('integration-query-marker');
    expect(body.reply).not.toContain('web_provider_rate_limited');
  });
});

function fakeRunner(sessionManager: ChannelManagerOptions['runner']['sessionManager'], evidence: WebEvidenceProjection): ChannelManagerOptions['runner'] {
  const runner: Partial<ChannelManagerOptions['runner']> = {
    async run(input: { sessionId?: SessionId; text?: string }) {
      return {
        runId: 'webhook-channel-run',
        sessionId: input.sessionId ?? asSessionId('webhook-session'),
        status: 'ok',
        reply: 'Reply from bounded Web evidence.',
        messages: [],
        trace: [],
        durationMs: 0,
        webEvidence: evidence,
      };
    },
    sessionManager,
    model: 'test-model',
    state: { sessionId: undefined, model: 'test-model' },
  };
  return runner as ChannelManagerOptions['runner'];
}

function fakeSessionManager(): ChannelManagerOptions['runner']['sessionManager'] {
  let nextId = 0;
  const sessions = new Map<string, Session>();
  const manager: Partial<ChannelManagerOptions['runner']['sessionManager']> = {
    async create(model?: string, _title?: string, metadata?: Partial<SessionMetadata>): Promise<Session> {
      nextId += 1;
      const id = asSessionId(`webhook-session-${nextId}`);
      const now = new Date().toISOString();
      const session: Session = {
        id,
        metadata: { createdAt: now, updatedAt: now, messageCount: 0, model, ...metadata },
        messages: [],
      };
      sessions.set(id, session);
      return session;
    },
    async delete(id: SessionId): Promise<void> { sessions.delete(id); },
  };
  return manager as ChannelManagerOptions['runner']['sessionManager'];
}
