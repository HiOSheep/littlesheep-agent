// @littlesheep/channel-qqbot — plugin.test.ts
// Tests for QqbotChannelPlugin using mock fetch + mock WebSocket.
//
// Each test controls WebSocket events (simulate op codes, close, error) and
// verifies that events are processed and replies are sent via the HTTP API.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ChannelContext, ChannelRuntimeConfig, InboundChannelMessage } from '@littlesheep/plugins';
import type { SessionId } from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import {
  QqbotChannelPlugin,
  QQBOT_APPID_SECRET,
  QQBOT_APPSECRET_SECRET,
} from './plugin.js';

// ── WebSocket op codes (mirrors plugin.ts) ──────────────────────────────

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

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
  tokenStatus?: number;
  gatewayResponse?: unknown;
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
    access_token: 'test-token',
    expires_in: 7200,
  };
  const tokenStatus = opts.tokenStatus ?? 200;
  const gatewayResp = opts.gatewayResponse ?? {
    url: 'wss://test.qqbot.gateway',
  };
  const sendMsgResp = opts.sendMessageResponse ?? { id: 'msg-id-1' };
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

    if (urlString.includes('/app/getAppAccessToken')) {
      return makeResponse(tokenResp, tokenStatus);
    }
    if (urlString.includes('/gateway')) {
      return makeResponse(gatewayResp);
    }
    if (urlString.includes('/v2/groups/') || urlString.includes('/v2/users/')) {
      return makeResponse(sendMsgResp, sendMsgStatus);
    }
    return makeResponse({ code: -1, message: 'not found' }, 404);
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
    id: 'qqbot-test',
    type: 'qqbot',
    name: 'Test QQ Bot',
    dmPolicy: { type: 'open' },
    groupPolicy: { type: 'open' },
    model: undefined,
    secrets: {
      [QQBOT_APPID_SECRET]: 'test_appid',
      [QQBOT_APPSECRET_SECRET]: 'test_appsecret',
      ...opts.secrets,
    },
    options: {
      reconnectDelayMs: 100,
      reconnectMaxDelayMs: 1000,
      tokenRefreshBufferMs: 0,
      heartbeatIntervalBufferMs: 0,
      ...opts.options,
    },
  };

  const ctx: ChannelContext = {
    config,
    async resolveSession(convId: string, userId: string): Promise<SessionId> {
      resolveCalls.push({ convId, userId });
      if (opts.resolveError) throw new Error(opts.resolveError);
      return asSessionId('qqbot-session-id');
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

// ── Helpers to build QQ Bot WebSocket messages ──────────────────────────

function makeHello(heartbeatInterval: number): string {
  return JSON.stringify({
    op: OP_HELLO,
    d: { heartbeat_interval: heartbeatInterval },
  });
}

function makeReady(sessionId: string): string {
  return JSON.stringify({
    op: OP_DISPATCH,
    s: 1,
    t: 'READY',
    d: {
      session_id: sessionId,
      user: { id: 'bot-1', name: 'TestBot' },
      version: 1,
    },
  });
}

function makeGroupAtMessage(
  groupOpenId: string,
  content: string,
  opts?: { messageId?: string; userId?: string },
): string {
  return JSON.stringify({
    op: OP_DISPATCH,
    s: 2,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: opts?.messageId ?? 'msg-test-1',
      content,
      group_open_id: groupOpenId,
      author: {
        id: opts?.userId ?? 'user-1',
        member_openid: opts?.userId ?? 'user-1',
      },
      timestamp: String(Math.floor(Date.now() / 1000)),
    },
  });
}

function makeC2cMessage(
  userOpenId: string,
  content: string,
  opts?: { messageId?: string },
): string {
  return JSON.stringify({
    op: OP_DISPATCH,
    s: 3,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: opts?.messageId ?? 'msg-test-2',
      content,
      author: {
        id: userOpenId,
        user_openid: userOpenId,
      },
      timestamp: String(Math.floor(Date.now() / 1000)),
    },
  });
}

function makeHeartbeatAck(): string {
  return JSON.stringify({ op: OP_HEARTBEAT_ACK });
}

function makeServerHeartbeat(): string {
  return JSON.stringify({ op: OP_HEARTBEAT });
}

function makeReconnect(): string {
  return JSON.stringify({ op: OP_RECONNECT });
}

function makeInvalidSession(): string {
  return JSON.stringify({ op: OP_INVALID_SESSION, d: false });
}

/** Parse a sent WebSocket message. */
function parseSent(raw: string): { op: number; d?: unknown; t?: string } {
  return JSON.parse(raw) as { op: number; d?: unknown; t?: string };
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

/** Wait for N sendMessage fetch calls (to /v2/groups/ or /v2/users/). */
async function waitForSendMessage(mockFetch: MockFetch, count = 1, timeout = 5000): Promise<FetchCall[]> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const sendCalls = mockFetch.calls.filter(
      (c) => c.url.includes('/v2/groups/') || c.url.includes('/v2/users/'),
    );
    if (sendCalls.length >= count) return sendCalls;
    await new Promise((r) => setTimeout(r, 5));
  }
  const actual = mockFetch.calls.filter(
    (c) => c.url.includes('/v2/groups/') || c.url.includes('/v2/users/'),
  ).length;
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

describe('QqbotChannelPlugin', () => {
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
      const plugin = new QqbotChannelPlugin();
      expect(plugin.type).toBe('qqbot');
      expect(plugin.displayName).toBe('QQ Bot');
      expect(plugin.requiredSecrets).toEqual([QQBOT_APPID_SECRET, QQBOT_APPSECRET_SECRET]);
      expect(plugin.running).toBe(false);
    });
  });

  // ── start lifecycle ────────────────────────────────────────────────

  describe('start', () => {
    it('starts successfully: gets token, gets gateway URL, connects WebSocket', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();

      await plugin.start(ctx);
      expect(plugin.running).toBe(true);

      // Wait for WebSocket to connect.
      const ws = await waitForWs();
      expect(ws.url).toBe('wss://test.qqbot.gateway');

      // Verify token API was called.
      const tokenCalls = mockFetch.calls.filter((c) => c.url.includes('/app/getAppAccessToken'));
      expect(tokenCalls.length).toBe(1);
      expect(tokenCalls[0]!.body).toEqual({ appid: 'test_appid', secret: 'test_appsecret' });

      // Verify gateway API was called.
      const gatewayCalls = mockFetch.calls.filter((c) => c.url.includes('/gateway'));
      expect(gatewayCalls.length).toBe(1);

      await plugin.stop();
    });

    it('throws when QQBOT_APPID is missing', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      ctx.config.secrets = { [QQBOT_APPSECRET_SECRET]: 'secret' };
      const plugin = new QqbotChannelPlugin();

      await expect(plugin.start(ctx)).rejects.toThrow('missing required secrets');
      expect(plugin.running).toBe(false);
    });

    it('throws when QQBOT_APPSECRET is missing', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      ctx.config.secrets = { [QQBOT_APPID_SECRET]: 'appid' };
      const plugin = new QqbotChannelPlugin();

      await expect(plugin.start(ctx)).rejects.toThrow('missing required secrets');
      expect(plugin.running).toBe(false);
    });

    it('throws when token API returns HTTP error', async () => {
      const mockFetch = makeMockFetch({
        tokenResponse: { message: 'invalid credentials' },
        tokenStatus: 401,
      });
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();

      await expect(plugin.start(ctx)).rejects.toThrow('failed to get access_token');
      expect(plugin.running).toBe(false);
    });

    it('throws on double start', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();

      await plugin.start(ctx);
      await expect(plugin.start(ctx)).rejects.toThrow('already running');

      await plugin.stop();
    });
  });

  // ── WebSocket protocol ─────────────────────────────────────────────

  describe('WebSocket protocol', () => {
    it('sends Identify (op 2) after receiving Hello (op 10)', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      // Send Hello with large heartbeat interval (won't fire during test).
      ws.receive(makeHello(60000));

      // Wait for Identify to be sent.
      await sleep(50);

      const identify = ws.sentMessages
        .map((m) => parseSent(m))
        .find((m) => m.op === OP_IDENTIFY);
      expect(identify).toBeDefined();
      const d = identify!.d as { token: string; intents: number; shard: number[] };
      expect(d.token).toBe('QQBot test-token');
      // INTENT_GROUP_AT_MESSAGE (64) | INTENT_C2C_MESSAGE (33554432) = 33554496
      expect(d.intents).toBe(33554496);
      expect(d.shard).toEqual([0, 1]);

      await plugin.stop();
    });

    it('handles READY event and continues processing messages', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, runCalls } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);
      ws.receive(makeReady('test-session-1'));
      await sleep(50);

      // Plugin should still be running and able to process messages.
      ws.receive(makeGroupAtMessage('group-1', 'hello'));
      await waitForSendMessage(mockFetch);
      expect(runCalls.length).toBe(1);

      await plugin.stop();
    });

    it('responds to server heartbeat request (op 1) with heartbeat', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      // Server requests heartbeat (op 1 from server).
      ws.receive(makeServerHeartbeat());
      await sleep(50);

      // Client should have sent a heartbeat (op 1) in response.
      const heartbeats = ws.sentMessages
        .map((m) => parseSent(m))
        .filter((m) => m.op === OP_HEARTBEAT);
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);

      await plugin.stop();
    });

    it('handles heartbeat ACK (op 11) without error', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);
      ws.receive(makeHeartbeatAck());
      await sleep(50);

      // Plugin should still be running.
      expect(plugin.running).toBe(true);

      await plugin.stop();
    });

    it('handles op 7 (server reconnect) by closing connection', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      // Server requests reconnect.
      ws.receive(makeReconnect());
      await sleep(50);

      // The original WebSocket should be closed by the plugin.
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);

      await plugin.stop();
    });

    it('handles op 9 (invalid session) by re-identifying', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      // Count Identify messages so far (should be 1 from the initial handshake).
      const identifyCountBefore = ws.sentMessages.filter(
        (m) => parseSent(m).op === OP_IDENTIFY,
      ).length;
      expect(identifyCountBefore).toBe(1);

      // Send invalid session — plugin should re-identify.
      ws.receive(makeInvalidSession());
      await sleep(50);

      const identifyCountAfter = ws.sentMessages.filter(
        (m) => parseSent(m).op === OP_IDENTIFY,
      ).length;
      expect(identifyCountAfter).toBe(2);

      await plugin.stop();
    });
  });

  // ── Message handling ───────────────────────────────────────────────

  describe('message handling', () => {
    it('processes GROUP_AT_MESSAGE_CREATE and sends reply to /v2/groups/', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, resolveCalls, runCalls } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      ws.receive(makeGroupAtMessage('group-open-1', 'hello world'));
      const sendCalls = await waitForSendMessage(mockFetch);

      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0]!.url).toContain('/v2/groups/group-open-1/messages');

      // Verify resolveSession was called with group_open_id and user id.
      expect(resolveCalls.length).toBe(1);
      expect(resolveCalls[0]!.convId).toBe('group-open-1');
      expect(resolveCalls[0]!.userId).toBe('user-1');

      // Verify runAgent was called with the right message.
      expect(runCalls.length).toBe(1);
      expect(runCalls[0]!.message.text).toBe('hello world');
      expect(runCalls[0]!.message.isGroup).toBe(true);

      // Verify sendMessage body.
      const body = sendCalls[0]!.body as { content: string; msg_type: number; msg_id: string };
      expect(body.content).toBe('echo: hello world');
      expect(body.msg_type).toBe(0);
      expect(body.msg_id).toBe('msg-test-1');

      await plugin.stop();
    });

    it('processes C2C_MESSAGE_CREATE and sends reply to /v2/users/', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, resolveCalls, runCalls } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      ws.receive(makeC2cMessage('user-open-1', 'hi there'));
      const sendCalls = await waitForSendMessage(mockFetch);

      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0]!.url).toContain('/v2/users/user-open-1/messages');

      expect(resolveCalls.length).toBe(1);
      expect(resolveCalls[0]!.convId).toBe('user-open-1');

      expect(runCalls.length).toBe(1);
      expect(runCalls[0]!.message.text).toBe('hi there');
      expect(runCalls[0]!.message.isGroup).toBe(false);

      await plugin.stop();
    });

    it('trims leading spaces from group @ message content', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, runCalls } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      // QQ Bot @ mention stripping leaves leading spaces in content.
      ws.receive(makeGroupAtMessage('group-1', '   hello after spaces'));
      await waitForSendMessage(mockFetch);

      expect(runCalls[0]!.message.text).toBe('hello after spaces');

      await plugin.stop();
    });

    it('uses group_open_id as externalConversationId for group messages', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, resolveCalls } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      ws.receive(makeGroupAtMessage('special-group-id', 'test'));
      await waitForSendMessage(mockFetch);

      expect(resolveCalls[0]!.convId).toBe('special-group-id');

      await plugin.stop();
    });

    it('ignores unknown event types without error', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx, runCalls } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      // Send an unknown dispatch event.
      ws.receive(
        JSON.stringify({
          op: OP_DISPATCH,
          s: 99,
          t: 'GUILD_MEMBER_ADD',
          d: {},
        }),
      );

      await sleep(100);
      expect(runCalls.length).toBe(0);
      // Plugin should still be running.
      expect(plugin.running).toBe(true);

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
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      ws.receive(makeC2cMessage('user-1', 'hello'));
      const sendCalls = await waitForSendMessage(mockFetch);

      expect(sendCalls.length).toBe(1);
      const body = sendCalls[0]!.body as { content: string };
      expect(body.content).toContain('Error');
      expect(body.content).toContain('agent crashed');

      await plugin.stop();
    });

    it('splits long replies with messageSplitLength option', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const longReply = 'A'.repeat(250);
      const { ctx } = makeMockCtx({
        agentReply: longReply,
        options: { messageSplitLength: 100 },
      });
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      ws.receive(makeC2cMessage('user-1', 'test'));
      // 250 chars / 100 = 3 messages (100 + 100 + 50).
      const sendCalls = await waitForSendMessage(mockFetch, 3);

      expect(sendCalls.length).toBe(3);
      const texts = sendCalls.map((c) => (c.body as { content: string }).content);
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
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      ws.receive(makeC2cMessage('user-1', 'hello'));

      // Wait — no sendMessage should be called.
      await sleep(100);
      const sendCalls = mockFetch.calls.filter(
        (c) => c.url.includes('/v2/groups/') || c.url.includes('/v2/users/'),
      );
      expect(sendCalls.length).toBe(0);

      await plugin.stop();
    });

    it('includes msg_id in sendMessage body for passive replies', async () => {
      const mockFetch = makeMockFetch();
      globalThis.fetch = mockFetch.fetch;
      globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

      const { ctx } = makeMockCtx();
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const ws = await waitForWs();

      ws.receive(makeHello(60000));
      await sleep(50);

      ws.receive(makeGroupAtMessage('group-1', 'hello', { messageId: 'om-special-msg-id' }));
      const sendCalls = await waitForSendMessage(mockFetch);

      const body = sendCalls[0]!.body as { msg_id: string };
      expect(body.msg_id).toBe('om-special-msg-id');

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
      const plugin = new QqbotChannelPlugin();
      await plugin.start(ctx);
      const firstWs = await waitForWs();

      // Simulate server closing the connection.
      firstWs.serverClose(1000, 'test close');

      // Wait for reconnection.
      const secondWs = await waitForReconnect(firstWs);
      expect(secondWs).not.toBe(firstWs);
      expect(secondWs.url).toBe('wss://test.qqbot.gateway');

      // Verify gateway was called twice (once per connection).
      // Token is cached, so /app/getAppAccessToken only called once.
      const gatewayCalls = mockFetch.calls.filter((c) => c.url.includes('/gateway'));
      expect(gatewayCalls.length).toBe(2);

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
      const plugin = new QqbotChannelPlugin();
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
      const plugin = new QqbotChannelPlugin();
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
      const plugin = new QqbotChannelPlugin();
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
});
