// @littlesheep/plugins — channel/manager.test.ts
// Tests for DefaultChannelManager: register, start, stop, remove (cascade delete).
//
// Uses a mock ChannelPlugin and a mock AgentRunner (no real LLM/session files).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId, type SessionId, type Session, type SessionMetadata } from '@littlesheep/types';
import type { AgentRunner, RunnerResult, RunInput } from '@littlesheep/runner';
import { SessionManager } from '@littlesheep/session';
import type { ChannelConfig } from '@littlesheep/config';
import { ChannelSessionStore } from './session-binding.js';
import { DefaultChannelManager, buildRuntimeConfig } from './manager.js';
import type {
  ChannelPlugin,
  ChannelPluginFactory,
  ChannelContext,
  ChannelRuntimeConfig,
  InboundChannelMessage,
} from './types.js';

// ── Mocks ────────────────────────────────────────────────────────────────

/** Mock plugin that records lifecycle calls. */
class MockPlugin implements ChannelPlugin {
  readonly type: string;
  readonly displayName: string;
  readonly requiredSecrets: string[];
  private _running = false;
  private _ctx: ChannelContext | null = null;
  startCalls = 0;
  stopCalls = 0;
  private readonly startError?: string;

  constructor(opts: {
    type: string;
    requiredSecrets?: string[];
    startError?: string;
  }) {
    this.type = opts.type;
    this.displayName = `Mock ${opts.type}`;
    this.requiredSecrets = opts.requiredSecrets ?? [];
    this.startError = opts.startError;
  }

  get running(): boolean {
    return this._running;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.startCalls++;
    this._ctx = ctx;
    if (this.startError) throw new Error(this.startError);
    this._running = true;
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    this._running = false;
  }

  /** Test helper: simulate an inbound message through the context. */
  async simulateInbound(message: InboundChannelMessage): Promise<string> {
    if (!this._ctx) throw new Error('plugin not started');
    const sessionId = await this._ctx.resolveSession(
      message.externalConversationId,
      message.externalUserId,
    );
    const result = await this._ctx.runAgent(message, sessionId);
    return result.reply;
  }

  /** Test helper: access the abort signal. */
  get signal(): AbortSignal | null {
    return this._ctx?.signal ?? null;
  }
}

/** Mock runner: in-memory session map + recorded runs. */
function makeMockRunner(): {
  runner: AgentRunner;
  runs: RunInput[];
  sessions: Map<string, Session>;
  deletedSessions: SessionId[];
} {
  const runs: RunInput[] = [];
  const sessions = new Map<string, Session>();
  const deletedSessions: SessionId[] = [];
  let sessionCounter = 0;

  const sessionManager = {
    async create(model?: string, _title?: string, meta?: Partial<SessionMetadata>): Promise<Session> {
      sessionCounter++;
      const id = asSessionId(`session-${sessionCounter}`);
      const now = new Date().toISOString();
      const metadata: SessionMetadata = {
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        model,
        ...meta,
      };
      const session: Session = { id, metadata, messages: [] };
      sessions.set(id, session);
      return session;
    },
    async delete(sessionId: SessionId): Promise<void> {
      if (sessions.delete(sessionId)) {
        deletedSessions.push(sessionId);
      }
    },
    // Unused in these tests but required by the interface:
    sessionFile: () => '/tmp/mock',
    async loadMetadata() { return null; },
    async append() {},
    async read() { return []; },
    async readRecent() { return []; },
    async updateMetadata() {},
    async load() { return null; },
    async list() { return Array.from(sessions.keys()); },
    async listByChannel(channelId: string): Promise<SessionId[]> {
      const matched: SessionId[] = [];
      for (const s of sessions.values()) {
        if (s.metadata.channelId === channelId) matched.push(s.id);
      }
      return matched;
    },
    async stat() { return null; },
  };

  const runner: AgentRunner = {
    async run(input: RunInput): Promise<RunnerResult> {
      runs.push(input);
      const result: RunnerResult = {
        runId: `run-${runs.length}`,
        sessionId: (input.sessionId ?? asSessionId('default')) as SessionId,
        status: 'ok',
        reply: `echo: ${input.text}`,
        error: undefined,
        messages: [],
        trace: [],
        durationMs: 0,
      };
      return result;
    },
    async runStream(input: RunInput): Promise<RunnerResult> {
      return this.run(input);
    },
    async replay() { return null; },
    async shutdown() {},
    state: { sessionId: undefined, model: 'mock-model' },
    // Cast: SessionManager is a class with private opts, but we only need
    // the SessionManagerLike shape for these tests.
    sessionManager: sessionManager as unknown as SessionManager,
    infra: {} as AgentRunner['infra'],
    model: 'mock-model',
  };

  return { runner, runs, sessions, deletedSessions };
}

/** Build a mock plugin factory that records every instance created. */
function makeMockPluginFactory(opts?: {
  type?: string;
  requiredSecrets?: string[];
  startError?: string;
}): { factory: ChannelPluginFactory; instances: MockPlugin[] } {
  const instances: MockPlugin[] = [];
  const type = opts?.type ?? 'mock';
  const requiredSecrets = opts?.requiredSecrets;
  const startError = opts?.startError;

  const factory: ChannelPluginFactory = () => {
    const inst = new MockPlugin({ type, requiredSecrets, startError });
    instances.push(inst);
    return inst;
  };

  return { factory, instances };
}

// ── Test setup ───────────────────────────────────────────────────────────

let tmpDir: string;
let bindingsFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ls-mgr-'));
  bindingsFile = join(tmpDir, 'channels', 'bindings.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeManager() {
  const mock = makeMockRunner();
  const sessionStore = new ChannelSessionStore({ bindingsFile });
  const manager = new DefaultChannelManager({
    runner: mock.runner,
    sessionStore,
  });
  return { manager, mock, sessionStore };
}

function makeRuntimeConfig(overrides?: Partial<ChannelRuntimeConfig>): ChannelRuntimeConfig {
  return {
    id: 'ch-1',
    type: 'mock',
    name: 'Mock Channel',
    dmPolicy: { type: 'open' },
    groupPolicy: { type: 'disabled' },
    model: undefined,
    options: {},
    secrets: {},
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('DefaultChannelManager', () => {
  describe('registerType', () => {
    it('registers a plugin factory by type', () => {
      const { manager } = makeManager();
      const { factory } = makeMockPluginFactory();
      manager.registerType('mock', factory);
      // No throw = success.
      expect(manager.runningCount).toBe(0);
    });

    it('throws when registering a duplicate type', () => {
      const { manager } = makeManager();
      const { factory } = makeMockPluginFactory();
      manager.registerType('mock', factory);
      expect(() => manager.registerType('mock', factory)).toThrow(/already registered/);
    });
  });

  describe('start', () => {
    it('starts a registered plugin and tracks it as running', async () => {
      const { manager } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      const plugin = await manager.start(makeRuntimeConfig());

      expect(plugin).toBe(instances[0]);
      expect(plugin.running).toBe(true);
      expect(instances[0]!.startCalls).toBe(1);
      expect(manager.runningCount).toBe(1);
      expect(manager.list()).toContain(plugin);
    });

    it('throws when starting an unregistered type', async () => {
      const { manager } = makeManager();
      await expect(manager.start(makeRuntimeConfig({ type: 'unknown' }))).rejects.toThrow(
        /not registered/,
      );
    });

    it('throws when required secrets are missing', async () => {
      const { manager } = makeManager();
      const { factory } = makeMockPluginFactory({ requiredSecrets: ['BOT_TOKEN'] });
      manager.registerType('mock', factory);

      await expect(manager.start(makeRuntimeConfig({ secrets: {} }))).rejects.toThrow(
        /missing required secrets: BOT_TOKEN/,
      );
    });

    it('starts when required secrets are provided', async () => {
      const { manager } = makeManager();
      const { factory } = makeMockPluginFactory({ requiredSecrets: ['BOT_TOKEN'] });
      manager.registerType('mock', factory);

      const plugin = await manager.start(
        makeRuntimeConfig({ secrets: { BOT_TOKEN: 'tok-123' } }),
      );
      expect(plugin.running).toBe(true);
    });

    it('throws when starting an already-running channel', async () => {
      const { manager } = makeManager();
      const { factory } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig({ id: 'ch-1' }));
      await expect(manager.start(makeRuntimeConfig({ id: 'ch-1' }))).rejects.toThrow(
        /already running/,
      );
    });

    it('wraps plugin.start errors with channel context', async () => {
      const { manager } = makeManager();
      const { factory } = makeMockPluginFactory({ startError: 'connection refused' });
      manager.registerType('mock', factory);

      await expect(manager.start(makeRuntimeConfig())).rejects.toThrow(
        /failed to start: connection refused/,
      );
      expect(manager.runningCount).toBe(0);
    });
  });

  describe('stop', () => {
    it('stops a running channel and calls plugin.stop', async () => {
      const { manager } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      const plugin = await manager.start(makeRuntimeConfig());
      await manager.stop('ch-1');

      expect(plugin.running).toBe(false);
      expect(instances[0]!.stopCalls).toBe(1);
      expect(manager.runningCount).toBe(0);
    });

    it('fires the abort signal so the plugin can clean up', async () => {
      const { manager } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig());
      const signalBefore = instances[0]!.signal;
      expect(signalBefore?.aborted).toBe(false);

      await manager.stop('ch-1');

      expect(signalBefore?.aborted).toBe(true);
    });

    it('stop on a non-running channel is a no-op (no throw)', async () => {
      const { manager } = makeManager();
      await manager.stop('nonexistent');
      expect(manager.runningCount).toBe(0);
    });

    it('stop preserves sessions (does not cascade delete)', async () => {
      const { manager, mock } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig());
      // Simulate inbound to create a session.
      await instances[0]!.simulateInbound({
        text: 'hi',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });
      expect(mock.sessions.size).toBe(1);

      await manager.stop('ch-1');

      // Sessions preserved.
      expect(mock.sessions.size).toBe(1);
      expect(mock.deletedSessions).toHaveLength(0);
    });
  });

  describe('remove (cascade delete)', () => {
    it('removes channel and cascade-deletes all bound sessions', async () => {
      const { manager, mock, sessionStore } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig());
      // Create 2 sessions via inbound messages.
      await instances[0]!.simulateInbound({
        text: 'hi',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });
      await instances[0]!.simulateInbound({
        text: 'hello',
        externalConversationId: 'chat-2',
        externalUserId: 'user-2',
        isGroup: false,
      });
      expect(mock.sessions.size).toBe(2);

      // Verify bindings recorded.
      const bindingsBefore = await sessionStore.findByChannel('ch-1');
      expect(bindingsBefore).toHaveLength(2);

      await manager.remove('ch-1');

      // All sessions deleted.
      expect(mock.deletedSessions).toHaveLength(2);
      expect(mock.sessions.size).toBe(0);
      // Bindings cleared.
      const bindingsAfter = await sessionStore.findByChannel('ch-1');
      expect(bindingsAfter).toHaveLength(0);
      // Manager no longer running the channel.
      expect(manager.runningCount).toBe(0);
    });

    it('remove on non-running channel still cleans bindings', async () => {
      const { manager, mock, sessionStore } = makeManager();
      // Pre-populate bindings without a running channel.
      await sessionStore.bind({
        channelId: 'ch-orphan',
        sessionId: 's-orphan',
        externalConversationId: 'chat-x',
      });
      // Put a fake session in the mock runner so delete is exercised.
      const orphan = await mock.runner.sessionManager.create();
      // Re-bind with the real session id so delete hits a real session.
      await sessionStore.unbindChannel('ch-orphan');
      await sessionStore.bind({
        channelId: 'ch-orphan',
        sessionId: orphan.id,
        externalConversationId: 'chat-x',
      });

      await manager.remove('ch-orphan');

      expect(mock.deletedSessions).toContain(orphan.id);
      const remaining = await sessionStore.findByChannel('ch-orphan');
      expect(remaining).toHaveLength(0);
    });

    it('remove tolerates session delete failures (continues cascade)', async () => {
      const { manager, mock, sessionStore } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig());
      await instances[0]!.simulateInbound({
        text: 'hi',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });

      // Sabotage sessionManager.delete so it throws.
      const originalDelete = mock.runner.sessionManager.delete.bind(mock.runner.sessionManager);
      mock.runner.sessionManager.delete = async () => {
        throw new Error('disk error');
      };

      // Should not throw — errors are logged and cascade continues.
      await manager.remove('ch-1');

      // Bindings still cleared.
      const remaining = await sessionStore.findByChannel('ch-1');
      expect(remaining).toHaveLength(0);
      expect(manager.runningCount).toBe(0);

      // Restore for cleanup.
      mock.runner.sessionManager.delete = originalDelete;
    });
  });

  describe('list', () => {
    it('returns empty array when nothing is running', () => {
      const { manager } = makeManager();
      expect(manager.list()).toEqual([]);
    });

    it('returns all running plugins', async () => {
      const { manager } = makeManager();
      const { factory } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      const p1 = await manager.start(makeRuntimeConfig({ id: 'ch-1' }));
      const p2 = await manager.start(makeRuntimeConfig({ id: 'ch-2' }));

      expect(manager.list()).toHaveLength(2);
      expect(manager.list()).toEqual(expect.arrayContaining([p1, p2]));
    });
  });

  describe('stopAll', () => {
    it('stops all running channels', async () => {
      const { manager } = makeManager();
      const { factory } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig({ id: 'ch-1' }));
      await manager.start(makeRuntimeConfig({ id: 'ch-2' }));
      await manager.start(makeRuntimeConfig({ id: 'ch-3' }));
      expect(manager.runningCount).toBe(3);

      await manager.stopAll();

      expect(manager.runningCount).toBe(0);
      expect(manager.list()).toHaveLength(0);
    });

    it('stopAll preserves sessions', async () => {
      const { manager, mock } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig({ id: 'ch-1' }));
      await instances[0]!.simulateInbound({
        text: 'hi',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });

      await manager.stopAll();

      expect(mock.sessions.size).toBe(1);
      expect(mock.deletedSessions).toHaveLength(0);
    });

    it('stopAll on empty manager is a no-op', async () => {
      const { manager } = makeManager();
      await manager.stopAll();
      expect(manager.runningCount).toBe(0);
    });
  });

  describe('resolveSession (via plugin context)', () => {
    it('creates a new session on first inbound from a conversation', async () => {
      const { manager, mock } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig());
      const reply = await instances[0]!.simulateInbound({
        text: 'hi',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });

      expect(reply).toBe('echo: hi');
      expect(mock.sessions.size).toBe(1);
      // Session metadata should be stamped with channel info.
      const session = Array.from(mock.sessions.values())[0]!;
      expect(session.metadata.channelId).toBe('ch-1');
      expect(session.metadata.origin).toBe('channel');
      expect(session.metadata.externalConversationId).toBe('chat-1');
    });

    it('reuses existing session on subsequent inbound from same conversation', async () => {
      const { manager, mock } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig());
      await instances[0]!.simulateInbound({
        text: 'first',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });
      await instances[0]!.simulateInbound({
        text: 'second',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });

      // Same conversation → same session.
      expect(mock.sessions.size).toBe(1);
      expect(mock.runs).toHaveLength(2);
    });

    it('creates separate sessions for different conversations', async () => {
      const { manager, mock } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig());
      await instances[0]!.simulateInbound({
        text: 'hi',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });
      await instances[0]!.simulateInbound({
        text: 'hello',
        externalConversationId: 'chat-2',
        externalUserId: 'user-2',
        isGroup: false,
      });

      expect(mock.sessions.size).toBe(2);
    });
  });

  describe('runAgent (via plugin context)', () => {
    it('calls runner.run with origin=channel and channelId', async () => {
      const { manager, mock } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      await manager.start(makeRuntimeConfig());
      await instances[0]!.simulateInbound({
        text: 'ping',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });

      expect(mock.runs).toHaveLength(1);
      expect(mock.runs[0]!.origin).toBe('channel');
      expect(mock.runs[0]!.channelId).toBe('ch-1');
      expect(mock.runs[0]!.externalConversationId).toBe('chat-1');
      expect(mock.runs[0]!.text).toBe('ping');
    });

    it('returns ok=false and error when runner.run throws', async () => {
      const { manager, mock } = makeManager();
      const { factory, instances } = makeMockPluginFactory();
      manager.registerType('mock', factory);

      // Sabotage runner.run.
      mock.runner.run = async () => {
        throw new Error('LLM timeout');
      };

      await manager.start(makeRuntimeConfig());

      // Directly exercise runAgent path via simulateInbound (which calls runAgent).
      // First create a session so resolveSession succeeds.
      const session = await mock.runner.sessionManager.create();
      // Now call runAgent directly through the context by simulating inbound
      // — but resolveSession will create a session first, then runAgent throws.
      const reply = await instances[0]!.simulateInbound({
        text: 'hi',
        externalConversationId: 'chat-1',
        externalUserId: 'user-1',
        isGroup: false,
      });

      expect(reply).toBe('');
      // session was created (resolveSession succeeded) even though runAgent failed.
      void session;
    });
  });
});

describe('buildRuntimeConfig', () => {
  it('converts a ChannelConfig + secrets into ChannelRuntimeConfig', () => {
    const config: ChannelConfig = {
      id: 'tg-1',
      type: 'telegram',
      name: 'Home Bot',
      enabled: true,
      dmPolicy: { type: 'allowlist', allowedIds: ['user-1'] },
      groupPolicy: { type: 'disabled' },
      model: 'openai/gpt-4o',
      secrets: { TELEGRAM_BOT_TOKEN: '$TELEGRAM_BOT_TOKEN' },
      options: { polling: true },
    };
    const secrets = { TELEGRAM_BOT_TOKEN: 'real-token-value' };

    const runtime = buildRuntimeConfig(config, secrets);

    expect(runtime.id).toBe('tg-1');
    expect(runtime.type).toBe('telegram');
    expect(runtime.name).toBe('Home Bot');
    expect(runtime.dmPolicy).toEqual({ type: 'allowlist', allowedIds: ['user-1'] });
    expect(runtime.groupPolicy).toEqual({ type: 'disabled' });
    expect(runtime.model).toBe('openai/gpt-4o');
    expect(runtime.options).toEqual({ polling: true });
    expect(runtime.secrets).toEqual({ TELEGRAM_BOT_TOKEN: 'real-token-value' });
  });

  it('passes through undefined model and empty options', () => {
    const config: ChannelConfig = {
      id: 'wh-1',
      type: 'webhook',
      enabled: true,
      dmPolicy: { type: 'open' },
      groupPolicy: { type: 'disabled' },
      secrets: {},
      options: {},
    };
    const runtime = buildRuntimeConfig(config, {});
    expect(runtime.model).toBeUndefined();
    expect(runtime.options).toEqual({});
    expect(runtime.secrets).toEqual({});
  });
});
