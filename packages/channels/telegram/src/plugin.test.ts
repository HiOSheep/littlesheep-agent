// @littlesheep/channel-telegram — plugin.test.ts
// Tests for TelegramChannelPlugin using a mock fetch to simulate the Telegram API.
//
// Each test controls getUpdates responses via a queue, then verifies that
// messages are processed and replies are sent via sendMessage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChannelContext, ChannelRuntimeConfig, InboundChannelMessage } from '@littlesheep/gateway';
import type { SessionId } from '@littlesheep/types';
import { asSessionId } from '@littlesheep/types';
import { TelegramChannelPlugin, TELEGRAM_BOT_TOKEN_SECRET } from './plugin.js';

// ── Telegram API mock types ──────────────────────────────────────────────

interface ApiCall {
  method: string;
  params: Record<string, unknown>;
}

interface MockFetch {
  fetch: typeof globalThis.fetch;
  calls: ApiCall[];
  /** Queue of getUpdates responses (shifted on each call). */
  setGetUpdatesQueue: (responses: unknown[]) => void;
  /** Set a custom getMe response (e.g. to simulate invalid token). */
  setGetMeResponse: (resp: unknown) => void;
  /** Resolves when the next sendMessage call happens. */
  waitForSendMessage: () => Promise<Record<string, unknown>>;
  /** Resolves when N sendMessage calls have happened. */
  waitForSendMessages: (count: number) => Promise<ApiCall[]>;
}

/** Build a mock fetch that simulates the Telegram Bot API. */
function makeMockFetch(): MockFetch {
  const calls: ApiCall[] = [];
  let getMeResponse: unknown = {
    ok: true,
    result: { id: 123456, username: 'test_bot', first_name: 'Test Bot' },
  };
  let getUpdatesQueue: unknown[] = [{ ok: true, result: [] }];
  let sendMessageResolvers: ((value: ApiCall) => void)[] = [];

  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    // Respect abort signal.
    if (init?.signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    const params = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    const urlString = String(url);

    if (urlString.includes('/getMe')) {
      calls.push({ method: 'getMe', params });
      return makeResponse(getMeResponse);
    }

    if (urlString.includes('/getUpdates')) {
      calls.push({ method: 'getUpdates', params });
      const resp = getUpdatesQueue.shift() ?? { ok: true, result: [] };
      return makeResponse(resp);
    }

    if (urlString.includes('/sendMessage')) {
      calls.push({ method: 'sendMessage', params });
      sendMessageResolvers.shift()?.({ method: 'sendMessage', params });
      return makeResponse({ ok: true, result: { message_id: 1, date: 0, text: params.text } });
    }

    if (urlString.includes('/sendChatAction')) {
      calls.push({ method: 'sendChatAction', params });
      return makeResponse({ ok: true, result: true });
    }

    return makeResponse({ ok: false, description: 'unknown method' }, 404);
  }) as typeof globalThis.fetch;

  return {
    fetch,
    calls,
    setGetUpdatesQueue: (responses: unknown[]) => {
      getUpdatesQueue = responses;
    },
    setGetMeResponse: (resp: unknown) => {
      getMeResponse = resp;
    },
    waitForSendMessage: () =>
      new Promise((resolve) => {
        sendMessageResolvers.push((call) => resolve(call.params));
      }),
    waitForSendMessages: (count: number) =>
      new Promise((resolve) => {
        const collected: ApiCall[] = [];
        for (let i = 0; i < count; i++) {
          sendMessageResolvers.push((call) => {
            collected.push(call);
            if (collected.length === count) resolve(collected);
          });
        }
      }),
  };
}

/** Build a JSON Response object. */
function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Mock ChannelContext ──────────────────────────────────────────────────

interface MockCtxOptions {
  /** Override runAgent to throw (simulates agent failure). */
  agentError?: string;
  /** Override runAgent reply text. */
  agentReply?: string;
  /** Override resolveSession to throw. */
  resolveError?: string;
  /** Override options. */
  options?: Record<string, unknown>;
}

function makeMockCtx(opts: MockCtxOptions = {}): {
  ctx: ChannelContext;
  controller: AbortController;
  resolveCalls: { convId: string; userId: string }[];
  runCalls: { message: InboundChannelMessage; sessionId: SessionId }[];
} {
  const controller = new AbortController();
  const resolveCalls: { convId: string; userId: string }[] = [];
  const runCalls: { message: InboundChannelMessage; sessionId: SessionId }[] = [];

  const config: ChannelRuntimeConfig = {
    id: 'tg-test',
    type: 'telegram',
    name: 'Test Telegram',
    dmPolicy: { type: 'open' },
    groupPolicy: { type: 'disabled' },
    model: undefined,
    secrets: { [TELEGRAM_BOT_TOKEN_SECRET]: 'test-bot-token' },
    options: {
      pollingTimeout: 0,
      errorBackoffMs: 100,
      pollIntervalMs: 50,
      sendTypingAction: false,
      ...opts.options,
    },
  };

  const ctx: ChannelContext = {
    config,
    async resolveSession(convId: string, userId: string): Promise<SessionId> {
      resolveCalls.push({ convId, userId });
      if (opts.resolveError) throw new Error(opts.resolveError);
      return asSessionId('tg-session-id');
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

// ── Helpers to build Telegram updates ────────────────────────────────────

function makeTextUpdate(
  updateId: number,
  chatId: number,
  text: string,
  opts?: {
    userId?: number;
    chatType?: 'private' | 'group' | 'supergroup' | 'channel';
    username?: string;
    firstName?: string;
  },
): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: {
        id: opts?.userId ?? 111,
        username: opts?.username,
        first_name: opts?.firstName ?? 'Alice',
      },
      chat: {
        id: chatId,
        type: opts?.chatType ?? 'private',
      },
      text,
      date: 1700000000,
    },
  };
}

function makeNonTextUpdate(updateId: number, chatId: number): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      from: { id: 111, first_name: 'Alice' },
      chat: { id: chatId, type: 'private' },
      sticker: { file_id: 'sticker-1', emoji: '👋' },
      date: 1700000000,
    },
  };
}

// ── Test setup ───────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;
let mock: MockFetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mock = makeMockFetch();
  globalThis.fetch = mock.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('TelegramChannelPlugin', () => {
  describe('static properties', () => {
    it('has correct type, displayName, and requiredSecrets', () => {
      const plugin = new TelegramChannelPlugin();
      expect(plugin.type).toBe('telegram');
      expect(plugin.displayName).toBe('Telegram');
      expect(plugin.requiredSecrets).toEqual([TELEGRAM_BOT_TOKEN_SECRET]);
      expect(plugin.running).toBe(false);
      expect(plugin.botInfo).toBeNull();
    });
  });

  describe('start', () => {
    it('verifies bot token via getMe and starts polling', async () => {
      const { ctx } = makeMockCtx();
      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);

      expect(plugin.running).toBe(true);
      expect(plugin.botInfo).toEqual({ id: 123456, username: 'test_bot', first_name: 'Test Bot' });

      // getMe should have been called.
      const getMeCalls = mock.calls.filter((c) => c.method === 'getMe');
      expect(getMeCalls).toHaveLength(1);

      await plugin.stop();
    });

    it('throws when getMe fails (invalid token)', async () => {
      mock.setGetMeResponse({ ok: false, description: 'Unauthorized', error_code: 401 });
      const { ctx } = makeMockCtx();
      const plugin = new TelegramChannelPlugin();
      await expect(plugin.start(ctx)).rejects.toThrow(/getMe failed/);
      expect(plugin.running).toBe(false);
    });

    it('throws when getMe returns HTTP error', async () => {
      mock.setGetMeResponse({ ok: false, description: 'Server error' });
      // Override fetch to return HTTP 500 for getMe
      globalThis.fetch = vi.fn(async () => makeResponse({ ok: false, description: 'error' }, 500)) as typeof globalThis.fetch;
      const { ctx } = makeMockCtx();
      const plugin = new TelegramChannelPlugin();
      await expect(plugin.start(ctx)).rejects.toThrow(/getMe failed/);
    });

    it('throws when bot token is missing', async () => {
      const { ctx } = makeMockCtx();
      ctx.config.secrets = {};
      const plugin = new TelegramChannelPlugin();
      await expect(plugin.start(ctx)).rejects.toThrow(/missing required secret/);
    });

    it('throws on invalid options', async () => {
      const { ctx } = makeMockCtx({ options: { pollingTimeout: 999 } });
      const plugin = new TelegramChannelPlugin();
      await expect(plugin.start(ctx)).rejects.toThrow(/invalid options/);
    });

    it('throws when started twice', async () => {
      const { ctx } = makeMockCtx();
      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await expect(plugin.start(ctx)).rejects.toThrow(/already running/);
      await plugin.stop();
    });
  });

  describe('message processing', () => {
    it('processes a text message and sends a reply via sendMessage', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(100, 500, 'hello')] },
      ]);
      const { ctx, runCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);

      const sendParams = await mock.waitForSendMessage();

      // Verify sendMessage was called with the reply text.
      expect(sendParams.chat_id).toBe(500);
      expect(sendParams.text).toBe('echo: hello');

      // Verify the agent was called with the right message.
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0]!.message.text).toBe('hello');
      expect(runCalls[0]!.message.externalConversationId).toBe('500');
      expect(runCalls[0]!.message.externalUserId).toBe('111');
      expect(runCalls[0]!.message.isGroup).toBe(false);

      await plugin.stop();
    });

    it('uses chat.id as externalConversationId', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(101, 99999, 'hi')] },
      ]);
      const { ctx, resolveCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await mock.waitForSendMessage();

      expect(resolveCalls[0]!.convId).toBe('99999');

      await plugin.stop();
    });

    it('sets isGroup=true for group chats', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(102, 600, 'group msg', { chatType: 'group' })] },
      ]);
      const { ctx, runCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await mock.waitForSendMessage();

      expect(runCalls[0]!.message.isGroup).toBe(true);

      await plugin.stop();
    });

    it('sets isGroup=false for supergroup chats treated as groups', async () => {
      // supergroup is NOT private, so isGroup should be true.
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(103, 700, 'sg msg', { chatType: 'supergroup' })] },
      ]);
      const { ctx, runCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await mock.waitForSendMessage();

      expect(runCalls[0]!.message.isGroup).toBe(true);

      await plugin.stop();
    });

    it('extracts userName from username when available', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(104, 800, 'hi', { username: 'bob_handle' })] },
      ]);
      const { ctx, runCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await mock.waitForSendMessage();

      expect(runCalls[0]!.message.userName).toBe('bob_handle');

      await plugin.stop();
    });

    it('falls back to first_name when username is not set', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(105, 900, 'hi', { username: undefined, firstName: 'Charlie' })] },
      ]);
      const { ctx, runCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await mock.waitForSendMessage();

      expect(runCalls[0]!.message.userName).toBe('Charlie');

      await plugin.stop();
    });

    it('skips non-text messages (e.g. stickers)', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeNonTextUpdate(106, 1000)] },
      ]);
      const { ctx, runCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);

      // Give the poll loop a tick to process.
      await new Promise((r) => setTimeout(r, 50));

      // No sendMessage calls should have been made.
      expect(runCalls).toHaveLength(0);
      const sendCalls = mock.calls.filter((c) => c.method === 'sendMessage');
      expect(sendCalls).toHaveLength(0);

      await plugin.stop();
    });

    it('skips updates without a message object', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [{ update_id: 107, callback_query: { id: 'cb1' } }] },
      ]);
      const { ctx, runCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);

      await new Promise((r) => setTimeout(r, 50));

      expect(runCalls).toHaveLength(0);

      await plugin.stop();
    });

    it('processes multiple messages in a single batch', async () => {
      mock.setGetUpdatesQueue([
        {
          ok: true,
          result: [
            makeTextUpdate(110, 1100, 'first'),
            makeTextUpdate(111, 1100, 'second'),
            makeTextUpdate(112, 1100, 'third'),
          ],
        },
      ]);
      const { ctx, runCalls } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await mock.waitForSendMessages(3);

      expect(runCalls).toHaveLength(3);
      expect(runCalls[0]!.message.text).toBe('first');
      expect(runCalls[1]!.message.text).toBe('second');
      expect(runCalls[2]!.message.text).toBe('third');

      await plugin.stop();
    });

    it('advances offset after processing updates', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(200, 1200, 'msg')] },
      ]);
      const { ctx } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await mock.waitForSendMessage();

      // Wait for the next poll cycle to happen (pollIntervalMs + buffer).
      await new Promise((r) => setTimeout(r, 150));

      // Check the second getUpdates call has offset = 201.
      const getUpdatesCalls = mock.calls.filter((c) => c.method === 'getUpdates');
      // First call: offset=0, second call: offset=201.
      expect(getUpdatesCalls.length).toBeGreaterThanOrEqual(2);
      expect(getUpdatesCalls[1]!.params.offset).toBe(201);

      await plugin.stop();
    });
  });

  describe('reply handling', () => {
    it('sends error message when agent reports failure', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(300, 1300, 'hi')] },
      ]);
      const { ctx } = makeMockCtx({ agentError: 'LLM is down' });

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      const sendParams = await mock.waitForSendMessage();

      // Should send the error message as reply.
      expect(sendParams.text).toContain('Error');
      expect(sendParams.text).toContain('LLM is down');

      await plugin.stop();
    });

    it('sends error message when resolveSession throws', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(301, 1400, 'hi')] },
      ]);
      const { ctx } = makeMockCtx({ resolveError: 'DB locked' });

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      const sendParams = await mock.waitForSendMessage();

      // Should send a fallback error message.
      expect(sendParams.text).toContain('wrong');

      await plugin.stop();
    });

    it('splits long replies into multiple messages (>4096 chars)', async () => {
      const longReply = 'x'.repeat(10000);
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(302, 1500, 'long')] },
      ]);
      const { ctx } = makeMockCtx({ agentReply: longReply });

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);

      // Wait for 3 sendMessage calls (10000 / 4096 = 2.44 → 3 parts).
      const sendCalls = await mock.waitForSendMessages(3);

      // Verify total text length matches.
      const totalLen = sendCalls.reduce((sum, c) => sum + (c.params.text as string).length, 0);
      expect(totalLen).toBe(10000);

      // Each part should be ≤ 4096.
      for (const call of sendCalls) {
        expect((call.params.text as string).length).toBeLessThanOrEqual(4096);
      }

      await plugin.stop();
    });

    it('does not send empty replies', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(303, 1600, 'hi')] },
      ]);
      const { ctx } = makeMockCtx({ agentReply: '' });

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);

      // Give the poll loop time to process.
      await new Promise((r) => setTimeout(r, 100));

      const sendCalls = mock.calls.filter((c) => c.method === 'sendMessage');
      expect(sendCalls).toHaveLength(0);

      await plugin.stop();
    });
  });

  describe('typing indicator', () => {
    it('sends typing action when sendTypingAction is enabled', async () => {
      mock.setGetUpdatesQueue([
        { ok: true, result: [makeTextUpdate(400, 1700, 'hi')] },
      ]);
      const { ctx } = makeMockCtx({ options: { sendTypingAction: true } });

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await mock.waitForSendMessage();

      const chatActionCalls = mock.calls.filter((c) => c.method === 'sendChatAction');
      expect(chatActionCalls.length).toBeGreaterThanOrEqual(1);
      expect(chatActionCalls[0]!.params.action).toBe('typing');
      expect(chatActionCalls[0]!.params.chat_id).toBe(1700);

      await plugin.stop();
    });
  });

  describe('error handling', () => {
    it('retries polling after a network error', async () => {
      // First call throws, second returns updates.
      const originalFetch = globalThis.fetch;
      let getUpdatesCallCount = 0;
      let sendMessageParams: Record<string, unknown> | null = null;
      let sendMessageResolve: ((p: Record<string, unknown>) => void) | null = null;
      globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        const urlString = String(url);
        if (urlString.includes('/getMe')) {
          return makeResponse({ ok: true, result: { id: 1, username: 'b', first_name: 'B' } });
        }
        if (urlString.includes('/getUpdates')) {
          getUpdatesCallCount++;
          if (getUpdatesCallCount === 1) {
            throw new Error('ECONNRESET');
          }
          return makeResponse({ ok: true, result: [makeTextUpdate(500, 1800, 'retry ok')] });
        }
        if (urlString.includes('/sendMessage')) {
          const params = init?.body ? JSON.parse(init.body as string) : {};
          sendMessageParams = params;
          sendMessageResolve?.(params);
          return makeResponse({ ok: true, result: { message_id: 1 } });
        }
        if (urlString.includes('/sendChatAction')) {
          return makeResponse({ ok: true, result: true });
        }
        return makeResponse({ ok: false }, 404);
      }) as typeof globalThis.fetch;

      const sendPromise = new Promise<Record<string, unknown>>((resolve) => {
        sendMessageResolve = resolve;
      });

      const { ctx } = makeMockCtx();
      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      const sendParams = await sendPromise;

      // The message was eventually processed despite the first error.
      expect(sendParams.text).toBe('echo: retry ok');
      void sendMessageParams;

      await plugin.stop();
      globalThis.fetch = originalFetch;
    });

    it('retries polling after an API error response', async () => {
      mock.setGetUpdatesQueue([
        { ok: false, description: 'Internal error', error_code: 500 },
        { ok: true, result: [makeTextUpdate(501, 1900, 'after error')] },
      ]);
      const { ctx } = makeMockCtx();

      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      const sendParams = await mock.waitForSendMessage();

      expect(sendParams.text).toBe('echo: after error');

      await plugin.stop();
    });
  });

  describe('stop', () => {
    it('stops polling and sets running=false', async () => {
      const { ctx } = makeMockCtx();
      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);

      // Let a few poll cycles run.
      await new Promise((r) => setTimeout(r, 50));

      const callsBeforeStop = mock.calls.filter((c) => c.method === 'getUpdates').length;
      expect(callsBeforeStop).toBeGreaterThanOrEqual(1);

      await plugin.stop();

      expect(plugin.running).toBe(false);

      // Wait a bit and verify no significant new calls (allow 1 for in-flight).
      await new Promise((r) => setTimeout(r, 100));
      const callsAfterStop = mock.calls.filter((c) => c.method === 'getUpdates').length;
      expect(callsAfterStop - callsBeforeStop).toBeLessThanOrEqual(1);
    });

    it('stop is idempotent', async () => {
      const { ctx } = makeMockCtx();
      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);
      await plugin.stop();
      await expect(plugin.stop()).resolves.not.toThrow();
    });

    it('ctx.signal abort stops the plugin', async () => {
      const { ctx, controller } = makeMockCtx();
      const plugin = new TelegramChannelPlugin();
      await plugin.start(ctx);

      // Let polling start.
      await new Promise((r) => setTimeout(r, 50));

      controller.abort();

      // Give the abort listener + stop() time to complete.
      await new Promise((r) => setTimeout(r, 200));

      expect(plugin.running).toBe(false);
    });

    it('stop without start is a no-op', async () => {
      const plugin = new TelegramChannelPlugin();
      await expect(plugin.stop()).resolves.not.toThrow();
      expect(plugin.running).toBe(false);
    });
  });
});
