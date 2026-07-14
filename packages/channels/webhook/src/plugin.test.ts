// @littlesheep/channel-webhook — plugin.test.ts
// Tests for WebhookChannelPlugin using real HTTP requests.
//
// Each test starts the plugin on port 0 (OS-assigned) to avoid conflicts,
// then sends HTTP requests via the global fetch API (Node 22+).

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import type { ChannelContext, ChannelRuntimeConfig, InboundChannelMessage } from '@littlesheep/plugins';
import type { SessionId } from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import { WebhookChannelPlugin } from './plugin.js';

const FETCH_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/** Shape of webhook JSON responses (for type-safe assertions in tests). */
interface WebhookResponse {
  ok: boolean;
  reply?: string;
  error?: string;
  sessionId?: string;
  service?: string;
}

/** Parse a fetch Response as a typed webhook response. */
async function parseBody(res: Response): Promise<WebhookResponse> {
  return (await res.json()) as WebhookResponse;
}

// ── Mock ChannelContext ──────────────────────────────────────────────────

interface MockContextOptions {
  port?: number;
  path?: string;
  hmacSecret?: string;
  bearerToken?: string;
  /** Override runAgent to throw (simulates agent failure). */
  agentError?: string;
  /** Override resolveSession to throw. */
  resolveError?: string;
}

function makeMockContext(opts: MockContextOptions = {}): {
  ctx: ChannelContext;
  controller: AbortController;
  resolveCalls: { convId: string; userId: string }[];
  runCalls: { message: InboundChannelMessage; sessionId: SessionId }[];
} {
  const controller = new AbortController();
  const resolveCalls: { convId: string; userId: string }[] = [];
  const runCalls: { message: InboundChannelMessage; sessionId: SessionId }[] = [];

  const config: ChannelRuntimeConfig = {
    id: 'wh-test',
    type: 'webhook',
    name: 'Test Webhook',
    dmPolicy: { type: 'open' },
    groupPolicy: { type: 'disabled' },
    model: undefined,
    secrets: {},
    options: {
      port: opts.port ?? 0,
      path: opts.path ?? '/webhook',
      ...(opts.hmacSecret ? { hmacSecret: opts.hmacSecret } : {}),
      ...(opts.bearerToken ? { bearerToken: opts.bearerToken } : {}),
    },
  };

  const ctx: ChannelContext = {
    config,
    async resolveSession(convId: string, userId: string): Promise<SessionId> {
      resolveCalls.push({ convId, userId });
      if (opts.resolveError) throw new Error(opts.resolveError);
      return asSessionId('test-session-id');
    },
    async runAgent(message: InboundChannelMessage, sessionId: SessionId) {
      runCalls.push({ message, sessionId });
      if (opts.agentError) {
        return { reply: '', ok: false, error: opts.agentError };
      }
      return { reply: `echo: ${message.text}`, ok: true };
    },
    log: () => {},
    signal: controller.signal,
  };

  return { ctx, controller, resolveCalls, runCalls };
}

/** Start a plugin on port 0 and return the base URL + plugin. */
async function startPlugin(opts: MockContextOptions = {}): Promise<{
  plugin: WebhookChannelPlugin;
  baseUrl: string;
  path: string;
  ctx: ChannelContext;
  controller: AbortController;
  resolveCalls: { convId: string; userId: string }[];
  runCalls: { message: InboundChannelMessage; sessionId: SessionId }[];
}> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const mock = makeMockContext(opts);
    const plugin = new WebhookChannelPlugin();
    await plugin.start(mock.ctx);

    const addr = plugin.address;
    if (!addr) throw new Error('plugin did not start listening');

    if (opts.port === undefined && FETCH_BLOCKED_PORTS.has(addr.port)) {
      await plugin.stop();
      continue;
    }

    const path = opts.path ?? '/webhook';
    return {
      plugin,
      baseUrl: `http://127.0.0.1:${addr.port}`,
      path,
      ctx: mock.ctx,
      controller: mock.controller,
      resolveCalls: mock.resolveCalls,
      runCalls: mock.runCalls,
    };
  }

  throw new Error('plugin could not start on a fetch-safe OS-assigned port');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('WebhookChannelPlugin', () => {
  describe('static properties', () => {
    it('has correct type, displayName, and requiredSecrets', () => {
      const plugin = new WebhookChannelPlugin();
      expect(plugin.type).toBe('webhook');
      expect(plugin.displayName).toBe('Webhook');
      expect(plugin.requiredSecrets).toEqual([]);
      expect(plugin.running).toBe(false);
      expect(plugin.address).toBeNull();
    });
  });

  describe('start', () => {
    it('starts listening on 127.0.0.1 and sets running=true', async () => {
      const { plugin } = await startPlugin();
      expect(plugin.running).toBe(true);
      expect(plugin.address).not.toBeNull();
      expect(plugin.address!.host).toBe('127.0.0.1');
      await plugin.stop();
    });

    it('throws when started twice', async () => {
      const { plugin } = await startPlugin();
      await expect(plugin.start(makeMockContext().ctx)).rejects.toThrow(/already running/);
      await plugin.stop();
    });

    it('throws on invalid options (bad path)', async () => {
      const mock = makeMockContext({ path: 'bad-path' });
      const plugin = new WebhookChannelPlugin();
      await expect(plugin.start(mock.ctx)).rejects.toThrow(/invalid options/);
    });
  });

  describe('health check (GET)', () => {
    it('returns 200 with service info', async () => {
      const { plugin, baseUrl, path } = await startPlugin();
      try {
        const res = await fetch(`${baseUrl}${path}`);
        expect(res.status).toBe(200);
        const body = await parseBody(res);
        expect(body.ok).toBe(true);
        expect(body.service).toBe('webhook-channel');
      } finally {
        await plugin.stop();
      }
    });

    it('returns 404 for GET to wrong path', async () => {
      const { plugin, baseUrl } = await startPlugin();
      try {
        const res = await fetch(`${baseUrl}/wrong`);
        expect(res.status).toBe(404);
      } finally {
        await plugin.stop();
      }
    });
  });

  describe('POST message handling', () => {
    it('accepts a valid POST and returns the agent reply', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin();
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'hello world',
            conversationId: 'chat-1',
            userId: 'user-1',
            isGroup: false,
            userName: 'Alice',
          }),
        });

        expect(res.status).toBe(200);
        const body = await parseBody(res);
        expect(body.ok).toBe(true);
        expect(body.reply).toBe('echo: hello world');
        expect(body.sessionId).toBe('test-session-id');

        // Verify the agent was called with the right message.
        expect(runCalls).toHaveLength(1);
        expect(runCalls[0]!.message.text).toBe('hello world');
        expect(runCalls[0]!.message.externalConversationId).toBe('chat-1');
        expect(runCalls[0]!.message.externalUserId).toBe('user-1');
        expect(runCalls[0]!.message.isGroup).toBe(false);
        expect(runCalls[0]!.message.userName).toBe('Alice');
      } finally {
        await plugin.stop();
      }
    });

    it('passes isGroup=true through correctly', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin();
      try {
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: 'group msg',
            conversationId: 'group-1',
            userId: 'user-1',
            isGroup: true,
          }),
        });
        expect(runCalls[0]!.message.isGroup).toBe(true);
      } finally {
        await plugin.stop();
      }
    });

    it('returns 400 for missing text field', async () => {
      const { plugin, baseUrl, path } = await startPlugin();
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(400);
        const body = await parseBody(res);
        expect(body.error).toContain('text');
      } finally {
        await plugin.stop();
      }
    });

    it('returns 400 for missing conversationId/userId', async () => {
      const { plugin, baseUrl, path } = await startPlugin();
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        });
        expect(res.status).toBe(400);
        const body = await parseBody(res);
        expect(body.error).toContain('conversationId');
      } finally {
        await plugin.stop();
      }
    });

    it('returns 400 for invalid JSON', async () => {
      const { plugin, baseUrl, path } = await startPlugin();
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{ not json }}}',
        });
        expect(res.status).toBe(400);
        const body = await parseBody(res);
        expect(body.error).toContain('invalid JSON');
      } finally {
        await plugin.stop();
      }
    });

    it('returns 404 for POST to wrong path', async () => {
      const { plugin, baseUrl } = await startPlugin();
      try {
        const res = await fetch(`${baseUrl}/wrong`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi', conversationId: 'c', userId: 'u' }),
        });
        expect(res.status).toBe(404);
      } finally {
        await plugin.stop();
      }
    });

    it('still returns 200 when agent reports an error (ok=false)', async () => {
      const { plugin, baseUrl, path } = await startPlugin({ agentError: 'LLM down' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(200);
        const body = await parseBody(res);
        expect(body.ok).toBe(false);
        expect(body.error).toBe('LLM down');
      } finally {
        await plugin.stop();
      }
    });

    it('returns 500 when resolveSession throws', async () => {
      const { plugin, baseUrl, path } = await startPlugin({ resolveError: 'DB locked' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(500);
        const body = await parseBody(res);
        expect(body.ok).toBe(false);
      } finally {
        await plugin.stop();
      }
    });
  });

  describe('HMAC signature verification', () => {
    it('accepts a request with a valid HMAC signature', async () => {
      const secret = 'my-hmac-secret';
      const { plugin, baseUrl, path, runCalls } = await startPlugin({ hmacSecret: secret });
      try {
        const body = JSON.stringify({
          text: 'signed message',
          conversationId: 'c1',
          userId: 'u1',
        });
        const sig = createHmac('sha256', secret).update(body).digest('hex');
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-256': `sha256=${sig}`,
          },
          body,
        });
        expect(res.status).toBe(200);
        expect(runCalls).toHaveLength(1);
      } finally {
        await plugin.stop();
      }
    });

    it('rejects a request with no signature when hmacSecret is set', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin({ hmacSecret: 'secret' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(401);
        expect(runCalls).toHaveLength(0);
      } finally {
        await plugin.stop();
      }
    });

    it('rejects a request with a wrong signature', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin({ hmacSecret: 'secret' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-256': 'sha256=deadbeef',
          },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(401);
        expect(runCalls).toHaveLength(0);
      } finally {
        await plugin.stop();
      }
    });

    it('rejects a request with malformed signature header', async () => {
      const { plugin, baseUrl, path } = await startPlugin({ hmacSecret: 'secret' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-256': 'not-a-valid-format',
          },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(401);
      } finally {
        await plugin.stop();
      }
    });

    it('skips signature check when hmacSecret is not set', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin();
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(200);
        expect(runCalls).toHaveLength(1);
      } finally {
        await plugin.stop();
      }
    });
  });

  describe('bearer token authorization', () => {
    it('accepts a request with a valid bearer token', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin({ bearerToken: 'my-token' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer my-token',
          },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(200);
        expect(runCalls).toHaveLength(1);
      } finally {
        await plugin.stop();
      }
    });

    it('rejects a request with no Authorization header when bearerToken is set', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin({ bearerToken: 'my-token' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(401);
        expect(runCalls).toHaveLength(0);
      } finally {
        await plugin.stop();
      }
    });

    it('rejects a request with a wrong bearer token', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin({ bearerToken: 'my-token' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer wrong-token',
          },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(401);
        expect(runCalls).toHaveLength(0);
      } finally {
        await plugin.stop();
      }
    });

    it('rejects a request with malformed Authorization header', async () => {
      const { plugin, baseUrl, path } = await startPlugin({ bearerToken: 'my-token' });
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic my-token',
          },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(401);
      } finally {
        await plugin.stop();
      }
    });
  });

  describe('combined security (HMAC + bearer)', () => {
    it('requires both HMAC and bearer when both are configured', async () => {
      const secret = 'hmac-secret';
      const token = 'bearer-token';
      const { plugin, baseUrl, path, runCalls } = await startPlugin({
        hmacSecret: secret,
        bearerToken: token,
      });
      try {
        const body = JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' });

        // Missing both → 401 (bearer checked first).
        const r1 = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        expect(r1.status).toBe(401);

        // Only bearer (no HMAC) → 401.
        const r2 = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body,
        });
        expect(r2.status).toBe(401);

        // Only HMAC (no bearer) → 401.
        const sig = createHmac('sha256', secret).update(body).digest('hex');
        const r3 = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature-256': `sha256=${sig}`,
          },
          body,
        });
        expect(r3.status).toBe(401);

        // Both present → 200.
        const r4 = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-Signature-256': `sha256=${sig}`,
          },
          body,
        });
        expect(r4.status).toBe(200);
        expect(runCalls).toHaveLength(1);
      } finally {
        await plugin.stop();
      }
    });
  });

  describe('body size limit', () => {
    it('rejects bodies larger than 1 MB', async () => {
      const { plugin, baseUrl, path, runCalls } = await startPlugin();
      try {
        // Build a body just over 1 MB.
        const bigText = 'x'.repeat(1024 * 1024 + 100);
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: bigText, conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(413);
        expect(runCalls).toHaveLength(0);
      } finally {
        await plugin.stop();
      }
    });
  });

  describe('custom path', () => {
    it('accepts a custom webhook path', async () => {
      const { plugin, baseUrl, runCalls } = await startPlugin({ path: '/api/messages' });
      try {
        const res = await fetch(`${baseUrl}/api/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res.status).toBe(200);
        expect(runCalls).toHaveLength(1);

        // Default path is not available.
        const res2 = await fetch(`${baseUrl}/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'hi', conversationId: 'c1', userId: 'u1' }),
        });
        expect(res2.status).toBe(404);
      } finally {
        await plugin.stop();
      }
    });
  });

  describe('stop', () => {
    it('stops the server and sets running=false', async () => {
      const { plugin, baseUrl, path } = await startPlugin();
      await plugin.stop();
      expect(plugin.running).toBe(false);
      expect(plugin.address).toBeNull();

      // Server should no longer accept connections.
      await expect(fetch(`${baseUrl}${path}`)).rejects.toThrow();
    });

    it('stop is idempotent (calling twice is safe)', async () => {
      const { plugin } = await startPlugin();
      await plugin.stop();
      await expect(plugin.stop()).resolves.not.toThrow();
    });

    it('abort signal stops the server', async () => {
      const { plugin, controller, baseUrl } = await startPlugin();
      controller.abort();
      // Give the abort listener a tick to fire.
      await new Promise((r) => setTimeout(r, 50));
      expect(plugin.running).toBe(false);
      await expect(fetch(baseUrl)).rejects.toThrow();
    });
  });

  describe('end-to-end: same conversation reuses session', () => {
    it('calls resolveSession with the same conversationId for repeat messages', async () => {
      const { plugin, baseUrl, path, resolveCalls, runCalls } = await startPlugin();
      try {
        const body = (text: string) =>
          JSON.stringify({ text, conversationId: 'chat-1', userId: 'user-1' });

        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body('first'),
        });
        await fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body('second'),
        });

        expect(resolveCalls).toHaveLength(2);
        expect(resolveCalls[0]!.convId).toBe('chat-1');
        expect(resolveCalls[1]!.convId).toBe('chat-1');
        expect(runCalls).toHaveLength(2);
      } finally {
        await plugin.stop();
      }
    });
  });
});
