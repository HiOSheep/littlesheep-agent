// @littlesheep/channel-feishu — plugin.test.ts
// Tests for FeishuChannelPlugin using mock fetch + mock WebSocket.
//
// Each test controls WebSocket events (simulate messages, close, error) and
// verifies that events are processed and replies are sent via the im/v1/messages API.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import type { ChannelContext, ChannelRuntimeConfig, InboundChannelMessage } from '@littlesheep/plugins';
import type { SessionId } from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import {
  FeishuChannelPlugin,
  FEISHU_APP_ID_SECRET,
  FEISHU_APP_SECRET_SECRET,
  FEISHU_VERIFICATION_TOKEN_SECRET,
  FEISHU_ENCRYPT_KEY_SECRET,
} from './plugin.js';

// ── Mock WebSocket ──────────────────────────────────────────────────────

interface WsEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

class MockWebSocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;

  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState: number = MockWebSocket.CONNECTING;

  private listeners = new Map<string, Set<(event: WsEvent) => void>>();
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Simulate async connection open on next tick.
    setTimeout(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this._dispatch('open', {});
      }
    }, 0);
  }

  addEventListener(type: string, listener: (event: WsEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: WsEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this._dispatch('close', { code, reason });
  }

  // ── Test helpers ──

  /** Simulate receiving a text message from the server. */
  receive(data: string): void {
    this._dispatch('message', { data });
  }

  /** Simulate the server closing the connection. */
  serverClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this._dispatch('close', { code, reason });
  }

  private _dispatch(type: string, event: WsEvent): void {
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }

  static get last(): MockWebSocket | undefined {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }
}

// ── Mock fetch ──────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

interface MockFetchOptions {
  tokenResponse?: unknown;
  registerResponse?: unknown;
  sendMessageResponse?: unknown;
  sendMessageStatus?: number;
}

interface MockFetch {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
}

function makeMockFetch(opts: MockFetchOptions = {}): MockFetch {
  const calls: FetchCall[] = [];
  const tokenResp = opts.tokenResponse ?? {
    code: 0,
    msg: 'ok',
    tenant_access_token: 't-test-token',
    expire: 7200,
  };
  const registerResp = opts.registerResponse ?? {
    code: 0,
    msg: 'ok',
    data: { endpoint: 'wss://test.feishu.cn/ws', register_id: 'r-1', expire_at: 9999999999 },
  };
  const sendMsgResp = opts.sendMessageResponse ?? { code: 0, msg: 'ok' };
  const sendMsgStatus = opts.sendMessageStatus ?? 200;

  const fetch = async (url: UrlArg, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const urlString = typeof url === 'string' ? url : url.toString();
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url: urlString, method: init?.method ?? 'GET', body });

    if (urlString.includes('/auth/v3/tenant_access_token/internal')) {
      return makeResponse(tokenResp);
    }
    if (urlString.includes('/callback/ws/endpoint.register')) {
      return makeResponse(registerResp);
    }
    if (urlString.includes('/im/v1/messages')) {
      return makeResponse(sendMsgResp, sendMsgStatus);
    }
    return makeResponse({ code: -1, msg: 'not found' }, 404);
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type UrlArg = string | URL | Request;

// ── Mock ChannelContext ─────────────────────────────────────────────────

interface MockCtxOptions {
  agentError?: string;
  agentReply?: string;
  resolveError?: string;
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

interface MockCtx {
  ctx: ChannelContext;
  controller: AbortController;
  resolveCalls: { convId: string; userId: string }[];
  runCalls: { message: InboundChannelMessage; sessionId: SessionId }[];
}

function makeMockCtx(opts: MockCtxOptions = {}): MockCtx {
  const controller = new AbortController();
  const resolveCalls: { convId: string; userId: string }[] = [];
  const runCalls: { message: InboundChannelMessage; sessionId: SessionId }[] = [];

  const config: ChannelRuntimeConfig = {
    id: 'feishu-test',
    type: 'feishu',
    name: 'Test Feishu',
    dmPolicy: { type: 'open' },
    groupPolicy: { type: 'open' },
    model: undefined,
    secrets: {
      [FEISHU_APP_ID_SECRET]: 'cli_test_app',
      [FEISHU_APP_SECRET_SECRET]: 'test_secret',
      ...opts.secrets,
    },
    options: {
      reconnectDelayMs: 100,
      reconnectMaxDelayMs: 1000,
      tokenRefreshBufferMs: 0,
      ...opts.options,
    },
  };

  const ctx: ChannelContext = {
    config,
    async resolveSession(convId: string, userId: string): Promise<SessionId> {
      resolveCalls.push({ convId, userId });
      if (opts.resolveError) throw new Error(opts.resolveError);
      return asSessionId('feishu-session-id');
    },
    async runAgent(message: InboundChannelMessage, sessionId: SessionId) {
      runCalls.push({ message, sessionId });
      if (opts.agentError) {
        return { reply: '', ok: false, error: opts.agentError };
      }
      return { reply: opts.agentReply ?? `echo: ${message.text}`, ok: true };
    },
    log: () => {},
    signal: controller.signal,
  };

  return { ctx, controller, resolveCalls, runCalls };
}

// ── Helpers to build Feishu events ──────────────────────────────────────

function makeMessageEvent(
  chatId: string,
  text: string,
  opts?: {
    openId?: string;
    chatType?: 'p2p' | 'group';
    messageType?: string;
    content?: string;
    messageId?: string;
  },
): unknown {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    event_type: 'im.message.receive_v1',
    token: 'test-verify-token',
    event: {
      sender: {
        sender_id: {
          open_id: opts?.openId ?? 'ou_test_user',
        },
        sender_type: 'user',
      },
      message: {
        message_id: opts?.messageId ?? 'om_test_msg',
        create_time: String(Math.floor(Date.now() / 1000)),
        chat_id: chatId,
        chat_type: opts?.chatType ?? 'p2p',
        message_type: opts?.messageType ?? 'text',
        content: opts?.content ?? JSON.stringify({ text }),
      },
    },
  };
}

function makeWsEvent(payload: unknown): string {
  return JSON.stringify({ type: 'event', data: payload });
}

/** Encrypt a payload using AES-256-CBC (Feishu's encryption scheme). */
function encryptPayload(encryptKey: string, data: unknown): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

// ── Wait helpers ────────────────────────────────────────────────────────

/** Wait for at least one WebSocket to be created and opened. */
async function waitForWs(timeout = 5000): Promise<MockWebSocket> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ws = MockWebSocket.last;
    if (ws && ws.readyState === MockWebSocket.OPEN) return ws;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('WebSocket did not connect within timeout');
}

/** Wait for N sendMessage fetch calls. */
async function waitForSendMessage(mockFetch: MockFetch, count = 1, timeout = 5000): Promise<FetchCall[]> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const sendCalls = mockFetch.calls.filter((c) => c.url.includes('/im/v1/messages'));
    if (sendCalls.length >= count) return sendCalls;
    await new Promise((r) => setTimeout(r, 5));
  }
  const actual = mockFetch.calls.filter((c) => c.url.includes('/im/v1/messages')).length;
  throw new Error(`Expected ${count} sendMessage calls, got ${actual}`);
}

/** Wait for a new WebSocket (different from the old one) to connect. */
async function waitForReconnect(oldWs: MockWebSocket, timeout = 5000): Promise<MockWebSocket> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ws = MockWebSocket.last;
    if (ws && ws !== oldWs && ws.readyState === MockWebSocket.OPEN) return ws;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Did not reconnect within timeout');
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('FeishuChannelPlugin', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebSocket = globalThis.WebSocket;
    MockWebSocket.reset();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    // Give time for any lingering timers to settle.
    await sleep(10);
  });

  // ── Static properties ──────────────────────────────────────────────

  describe('static properties', () => {
    it('has correct type, displayName, and requiredSecrets', () => {
      const plugin = new FeishuChannelPlugin();
      expect(plugin.type).toBe('feishu');
      expect(plugin.displayName).toBe('飞书');
      expect(plugin.requiredSecrets).toEqual([FEISHU_APP_ID_SECRET, FEISHU_APP_SECRET_SECRET]);
      expect(plugin.running).toBe(false);
    });
  });

  // ── start lifecycle ────────────────────────────────────────────────

  describe('start', () => {
    it('starts successfully: gets token, registers endpoint, connects WebSocket', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();

      await plugin.start(ctx);
      expect(plugin.running).toBe(true);

      // Wait for WebSocket to connect.
      const ws = await waitForWs();
      expect(ws.url).toBe('wss://test.feishu.cn/ws');

      // Verify token API was called.
      const tokenCalls = mockFetch.calls.filter((c) => c.url.includes('/auth/v3/tenant_access_token/internal'));
      expect(tokenCalls.length).toBe(1);
      expect(tokenCalls[0]!.body).toEqual({ app_id: 'cli_test_app', app_secret: 'test_secret' });

      // Verify register API was called.
      const registerCalls = mockFetch.calls.filter((c) => c.url.includes('/callback/ws/endpoint.register'));
      expect(registerCalls.length).toBe(1);

      await plugin.stop();
    });

    it('throws when FEISHU_APP_ID is missing', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      ctx.config.secrets = { [FEISHU_APP_SECRET_SECRET]: 'secret' };
      const plugin = new FeishuChannelPlugin();

      await expect(plugin.start(ctx)).rejects.toThrow('missing required secrets');
      expect(plugin.running).toBe(false);
    });

    it('throws when FEISHU_APP_SECRET is missing', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      ctx.config.secrets = { [FEISHU_APP_ID_SECRET]: 'app_id' };
      const plugin = new FeishuChannelPlugin();

      await expect(plugin.start(ctx)).rejects.toThrow('missing required secrets');
      expect(plugin.running).toBe(false);
    });

    it('throws when token API returns error code', async () => {
      const mockFetch = makeMockFetch({
        tokenResponse: { code: 999, msg: 'invalid app_id', tenant_access_token: '', expire: 0 },
      });
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();

      await expect(plugin.start(ctx)).rejects.toThrow('failed to get tenant_access_token');
      expect(plugin.running).toBe(false);
    });

    it('throws on double start', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();

      await plugin.start(ctx);
      await expect(plugin.start(ctx)).rejects.toThrow('already running');

      await plugin.stop();
    });
  });

  // ── Message handling ───────────────────────────────────────────────

  describe('message handling', () => {
    it('processes text message and sends reply', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, resolveCalls, runCalls } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      // Simulate receiving a text message.
      ws.receive(makeWsEvent(makeMessageEvent('oc_chat_1', 'hello world')));

      const sendCalls = await waitForSendMessage(mockFetch);
      expect(sendCalls.length).toBe(1);

      // Verify resolveSession was called with chat_id.
      expect(resolveCalls.length).toBe(1);
      expect(resolveCalls[0]!.convId).toBe('oc_chat_1');
      expect(resolveCalls[0]!.userId).toBe('ou_test_user');

      // Verify runAgent was called.
      expect(runCalls.length).toBe(1);
      expect(runCalls[0]!.message.text).toBe('hello world');
      expect(runCalls[0]!.message.isGroup).toBe(false);

      // Verify sendMessage body.
      const sendBody = sendCalls[0]!.body as { receive_id: string; msg_type: string; content: string };
      expect(sendBody.receive_id).toBe('oc_chat_1');
      expect(sendBody.msg_type).toBe('text');
      expect(JSON.parse(sendBody.content)).toEqual({ text: 'echo: hello world' });

      await plugin.stop();
    });

    it('uses chat_id as externalConversationId', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, resolveCalls } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeWsEvent(makeMessageEvent('oc_special_chat_id', 'test')));

      await waitForSendMessage(mockFetch);
      expect(resolveCalls[0]!.convId).toBe('oc_special_chat_id');

      await plugin.stop();
    });

    it('detects group chat type', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, runCalls } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeWsEvent(makeMessageEvent('oc_group_1', 'hi', { chatType: 'group' })));

      await waitForSendMessage(mockFetch);
      expect(runCalls[0]!.message.isGroup).toBe(true);

      await plugin.stop();
    });

    it('skips non-text messages', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, runCalls } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeWsEvent(makeMessageEvent('oc_1', '', { messageType: 'image' })));

      // Wait a bit — no sendMessage should be called.
      await sleep(100);
      expect(runCalls.length).toBe(0);
      const sendCalls = mockFetch.calls.filter((c) => c.url.includes('/im/v1/messages'));
      expect(sendCalls.length).toBe(0);

      await plugin.stop();
    });

    it('skips non-im.message.receive_v1 events', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, runCalls } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeWsEvent({
        event_id: 'evt-other',
        event_type: 'contact.user.updated_v3',
        token: 'test-verify-token',
        event: {},
      }));

      await sleep(100);
      expect(runCalls.length).toBe(0);

      await plugin.stop();
    });

    it('sends event_ack after receiving an event', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeWsEvent(makeMessageEvent('oc_1', 'test')));

      // Wait for ack to be sent.
      await sleep(50);

      const ack = ws.sentMessages.find((m) => {
        try {
          return (JSON.parse(m) as { type: string }).type === 'event_ack';
        } catch {
          return false;
        }
      });
      expect(ack).toBeDefined();

      await plugin.stop();
    });
  });

  // ── Reply handling ─────────────────────────────────────────────────

  describe('reply handling', () => {
    it('sends error message when agent fails', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx({ agentError: 'agent crashed' });
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeWsEvent(makeMessageEvent('oc_1', 'hello')));

      const sendCalls = await waitForSendMessage(mockFetch);
      expect(sendCalls.length).toBe(1);
      const content = JSON.parse(
        (sendCalls[0]!.body as { content: string }).content,
      ) as { text: string };
      expect(content.text).toContain('Error');
      expect(content.text).toContain('agent crashed');

      await plugin.stop();
    });

    it('splits long replies with small splitLength option', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const longReply = 'A'.repeat(250);
      const { ctx } = makeMockCtx({
        agentReply: longReply,
        options: { messageSplitLength: 100 },
      });
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeWsEvent(makeMessageEvent('oc_1', 'test')));

      // 250 chars / 100 = 3 messages (100 + 100 + 50).
      const sendCalls = await waitForSendMessage(mockFetch, 3);
      expect(sendCalls.length).toBe(3);

      const texts = sendCalls.map((c) => {
        const body = c.body as { content: string };
        return (JSON.parse(body.content) as { text: string }).text;
      });
      expect(texts[0]!.length).toBe(100);
      expect(texts[1]!.length).toBe(100);
      expect(texts[2]!.length).toBe(50);
      expect(texts.join('')).toBe(longReply);

      await plugin.stop();
    });

    it('suppresses empty replies', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx({ agentReply: '' });
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeWsEvent(makeMessageEvent('oc_1', 'hello')));

      // Wait — no sendMessage should be called.
      await sleep(100);
      const sendCalls = mockFetch.calls.filter((c) => c.url.includes('/im/v1/messages'));
      expect(sendCalls.length).toBe(0);

      await plugin.stop();
    });
  });

  // ── Encryption ─────────────────────────────────────────────────────

  describe('encryption', () => {
    it('decrypts encrypted events and processes them', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const encryptKey = 'test-encrypt-key-123';
      const { ctx, runCalls } = makeMockCtx({
        secrets: { [FEISHU_ENCRYPT_KEY_SECRET]: encryptKey },
      });
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      // Build an event and encrypt it.
      const event = makeMessageEvent('oc_encrypted', 'secret message');
      const encrypted = encryptPayload(encryptKey, event);

      // Send as encrypted event.
      ws.receive(JSON.stringify({ type: 'event', data: { encrypt: encrypted } }));

      const sendCalls = await waitForSendMessage(mockFetch);
      expect(runCalls.length).toBe(1);
      expect(runCalls[0]!.message.text).toBe('secret message');

      const content = JSON.parse(
        (sendCalls[0]!.body as { content: string }).content,
      ) as { text: string };
      expect(content.text).toBe('echo: secret message');

      await plugin.stop();
    });

    it('handles encrypted event without encrypt key gracefully (skips)', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      // No encrypt key in secrets.
      const { ctx, runCalls } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      // Send an encrypted event — without encrypt key, it can't be decrypted.
      ws.receive(JSON.stringify({
        type: 'event',
        data: { encrypt: 'some-encrypted-data' },
      }));

      // Wait — no crash, no reply, no agent call.
      await sleep(100);
      expect(runCalls.length).toBe(0);
      const sendCalls = mockFetch.calls.filter((c) => c.url.includes('/im/v1/messages'));
      expect(sendCalls.length).toBe(0);

      await plugin.stop();
    });
  });

  // ── Token verification ─────────────────────────────────────────────

  describe('token verification', () => {
    it('processes event when verification token matches', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, runCalls } = makeMockCtx({
        secrets: { [FEISHU_VERIFICATION_TOKEN_SECRET]: 'test-verify-token' },
      });
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      // makeMessageEvent uses token: 'test-verify-token' by default.
      ws.receive(makeWsEvent(makeMessageEvent('oc_1', 'hello')));

      await waitForSendMessage(mockFetch);
      expect(runCalls.length).toBe(1);

      await plugin.stop();
    });

    it('skips event when verification token does not match', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, runCalls } = makeMockCtx({
        secrets: { [FEISHU_VERIFICATION_TOKEN_SECRET]: 'correct-token' },
      });
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      // Event has token: 'test-verify-token', but plugin expects 'correct-token'.
      ws.receive(makeWsEvent(makeMessageEvent('oc_1', 'hello')));

      await sleep(100);
      expect(runCalls.length).toBe(0);
      const sendCalls = mockFetch.calls.filter((c) => c.url.includes('/im/v1/messages'));
      expect(sendCalls.length).toBe(0);

      await plugin.stop();
    });
  });

  // ── Heartbeat ──────────────────────────────────────────────────────

  describe('heartbeat', () => {
    it('responds to ping with pong', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(JSON.stringify({ type: 'ping', data: { ts: 1234567890 } }));

      // Wait for pong to be sent.
      await sleep(50);

      const pong = ws.sentMessages.find((m) => {
        try {
          return (JSON.parse(m) as { type: string }).type === 'pong';
        } catch {
          return false;
        }
      });
      expect(pong).toBeDefined();
      const pongData = JSON.parse(pong!) as { type: string; data: { ts: number } };
      expect(pongData.data.ts).toBe(1234567890);

      await plugin.stop();
    });
  });

  // ── Reconnection ───────────────────────────────────────────────────

  describe('reconnection', () => {
    it('reconnects after WebSocket closes', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx({
        options: { reconnectDelayMs: 100, reconnectMaxDelayMs: 1000 },
      });
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const firstWs = await waitForWs();

      // Simulate server closing the connection.
      firstWs.serverClose(1000, 'test close');

      // Wait for reconnection.
      const secondWs = await waitForReconnect(firstWs);
      expect(secondWs).not.toBe(firstWs);
      expect(secondWs.url).toBe('wss://test.feishu.cn/ws');

      // Verify register was called twice (once per connection).
      const registerCalls = mockFetch.calls.filter((c) => c.url.includes('/callback/ws/endpoint.register'));
      expect(registerCalls.length).toBe(2);

      await plugin.stop();
    });
  });

  // ── stop lifecycle ─────────────────────────────────────────────────

  describe('stop', () => {
    it('stops cleanly: closes WebSocket, sets running=false', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      await waitForWs();
      expect(plugin.running).toBe(true);

      await plugin.stop();
      expect(plugin.running).toBe(false);
      expect(MockWebSocket.last!.readyState).toBe(MockWebSocket.CLOSED);
    });

    it('is idempotent (double stop does not throw)', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      await waitForWs();

      await plugin.stop();
      await expect(plugin.stop()).resolves.not.toThrow();
      expect(plugin.running).toBe(false);
    });

    it('stops on ctx.signal abort', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, controller } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      await waitForWs();
      expect(plugin.running).toBe(true);

      // Abort the ctx.signal.
      controller.abort();

      // Wait for stop to complete.
      await sleep(100);
      expect(plugin.running).toBe(false);
    });
  });

  // ── Endpoint ready ─────────────────────────────────────────────────

  describe('endpoint.ready', () => {
    it('handles endpoint.ready message without error', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new FeishuChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      // Should not throw or cause any side effects.
      ws.receive(JSON.stringify({ type: 'endpoint.ready', data: { register_id: 'r-1' } }));

      await sleep(50);
      expect(plugin.running).toBe(true);

      await plugin.stop();
    });
  });
});
