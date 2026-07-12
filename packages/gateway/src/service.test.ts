// @littlesheep/gateway — service.test.ts
// Tests for GatewayService: start/stop/setRunner lifecycle, secret resolution,
// error isolation, and restart re-entrancy.
//
// Uses a mock ChannelPlugin and a mock AgentRunner (no real LLM/session files).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asSessionId, type Session, type SessionMetadata } from '@littlesheep/types';
import type { AgentRunner, RunnerResult, RunInput } from '@littlesheep/runner';
import { DEFAULT_CONFIG, type Config, type ChannelConfig } from '@littlesheep/config';
import { createGatewayService, resolveChannelSecrets } from './service.js';
import type {
  ChannelPlugin,
  ChannelPluginFactory,
  ChannelContext,
} from './channel/types.js';

// ── Mocks ────────────────────────────────────────────────────────────────

/** Mock plugin that records lifecycle calls and exposes its context for tests. */
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

  /** Test-only: the context passed to start(). */
  get ctx(): ChannelContext | null {
    return this._ctx;
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
}

/** Minimal mock runner: in-memory sessions, no real LLM. */
function makeMockRunner(): AgentRunner {
  const sessions = new Map<string, Session>();
  let counter = 0;
  const sessionManager = {
    async create(model?: string, _title?: string, meta?: Partial<SessionMetadata>): Promise<Session> {
      counter++;
      const id = asSessionId(`s-${counter}`);
      const now = new Date().toISOString();
      const session: Session = {
        id,
        metadata: { createdAt: now, updatedAt: now, messageCount: 0, model, ...meta },
        messages: [],
      };
      sessions.set(id, session);
      return session;
    },
    async delete() {},
    async list() { return Array.from(sessions.keys()); },
    async listByChannel() { return []; },
  } as unknown as AgentRunner['sessionManager'];

  return {
    async run(input: RunInput): Promise<RunnerResult> {
      return {
        runId: 'run-1',
        sessionId: input.sessionId ?? asSessionId('default'),
        status: 'ok',
        reply: `echo: ${input.text}`,
        error: undefined,
        messages: [],
        trace: [],
        durationMs: 0,
      };
    },
    async runStream(input: RunInput): Promise<RunnerResult> {
      return this.run(input);
    },
    async replay() { return null; },
    async shutdown() {},
    state: { sessionId: undefined, model: 'mock' },
    sessionManager,
    infra: {} as AgentRunner['infra'],
    model: 'mock',
  };
}

/** Build a mock plugin factory that records every instance created. */
function makeMockPluginFactory(opts?: {
  type?: string;
  requiredSecrets?: string[];
  startError?: string;
}): { factory: ChannelPluginFactory; instances: MockPlugin[] } {
  const instances: MockPlugin[] = [];
  const type = opts?.type ?? 'mock';
  const factory: ChannelPluginFactory = () => {
    const inst = new MockPlugin({
      type,
      requiredSecrets: opts?.requiredSecrets,
      startError: opts?.startError,
    });
    instances.push(inst);
    return inst;
  };
  return { factory, instances };
}

// ── Test helpers ─────────────────────────────────────────────────────────

let tmpDir: string;
let bindingsFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ls-svc-'));
  bindingsFile = join(tmpDir, 'channels', 'bindings.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a Config with the given channel configs (all other fields default). */
function makeConfig(channels: ChannelConfig[]): Config {
  return {
    ...DEFAULT_CONFIG,
    channels: { channels },
  };
}

function makeChannelConfig(overrides?: Partial<ChannelConfig>): ChannelConfig {
  return {
    id: 'ch-1',
    type: 'mock',
    enabled: true,
    dmPolicy: { type: 'open' },
    groupPolicy: { type: 'disabled' },
    secrets: {},
    options: {},
    ...overrides,
  };
}

/** Captured log entries. */
type LogCapture = { level: string; msg: string }[];

function makeLogCapture(): { log: (level: 'info' | 'warn' | 'error', msg: string) => void; entries: LogCapture } {
  const entries: LogCapture = [];
  return {
    log: (level, msg) => entries.push({ level, msg }),
    entries,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('GatewayService', () => {
  describe('start', () => {
    it('registers all factories and starts enabled channels on first call', async () => {
      const { factory, instances } = makeMockPluginFactory({ type: 'mock' });
      const factories = new Map([['mock', factory]]);
      const config = makeConfig([makeChannelConfig({ id: 'ch-1', type: 'mock' })]);
      const service = createGatewayService({
        runner: makeMockRunner(),
        bindingsFile,
        config,
        pluginFactories: factories,
      });

      expect(service.started).toBe(false);
      await service.start();

      expect(service.started).toBe(true);
      expect(instances).toHaveLength(1);
      expect(instances[0]!.startCalls).toBe(1);
      expect(instances[0]!.running).toBe(true);
      expect(service.list()).toHaveLength(1);
    });

    it('is idempotent — repeated start() does not re-register or re-start', async () => {
      const { factory, instances } = makeMockPluginFactory({ type: 'mock' });
      const factories = new Map([['mock', factory]]);
      const config = makeConfig([makeChannelConfig({ id: 'ch-1', type: 'mock' })]);
      const service = createGatewayService({
        runner: makeMockRunner(),
        bindingsFile,
        config,
        pluginFactories: factories,
      });

      await service.start();
      await service.start(); // idempotent — no-op

      expect(instances).toHaveLength(1); // no second instance created
      expect(instances[0]!.startCalls).toBe(1); // not started twice
      expect(service.list()).toHaveLength(1);
    });

    it('skips channels with enabled=false', async () => {
      const { factory, instances } = makeMockPluginFactory({ type: 'mock' });
      const factories = new Map([['mock', factory]]);
      const config = makeConfig([
        makeChannelConfig({ id: 'ch-on', type: 'mock', enabled: true }),
        makeChannelConfig({ id: 'ch-off', type: 'mock', enabled: false }),
      ]);
      const { log, entries } = makeLogCapture();
      const service = createGatewayService({
        runner: makeMockRunner(),
        bindingsFile,
        config,
        pluginFactories: factories,
        log,
      });

      await service.start();

      expect(instances).toHaveLength(1); // only the enabled one
      expect(service.list()).toHaveLength(1);
      expect(service.list()[0]!.running).toBe(true);
      // A summary log mentioning disabled channels was emitted.
      expect(entries.some((e) => e.msg.includes('1 disabled'))).toBe(true);
    });

    it('one failing channel does not block others from starting', async () => {
      const { factory: goodFactory, instances: goodInstances } = makeMockPluginFactory({ type: 'good' });
      const { factory: badFactory } = makeMockPluginFactory({ type: 'bad', startError: 'connection refused' });
      const factories = new Map([['good', goodFactory], ['bad', badFactory]]);
      const config = makeConfig([
        makeChannelConfig({ id: 'ch-bad', type: 'bad' }),
        makeChannelConfig({ id: 'ch-good', type: 'good' }),
      ]);
      const { log, entries } = makeLogCapture();
      const service = createGatewayService({
        runner: makeMockRunner(),
        bindingsFile,
        config,
        pluginFactories: factories,
        log,
      });

      await service.start();

      // Good channel started despite bad channel failing.
      expect(goodInstances).toHaveLength(1);
      expect(goodInstances[0]!.running).toBe(true);
      expect(service.list()).toHaveLength(1);
      // Error was logged with channel id and message.
      expect(
        entries.some(
          (e) => e.level === 'error' && e.msg.includes('ch-bad') && e.msg.includes('connection refused'),
        ),
      ).toBe(true);
    });

    it('resolves $VAR secret references from process.env', async () => {
      process.env['TEST_CHANNEL_TOKEN'] = 'real-token-123';
      try {
        const { factory, instances } = makeMockPluginFactory({
          type: 'mock',
          requiredSecrets: ['TEST_CHANNEL_TOKEN'],
        });
        const factories = new Map([['mock', factory]]);
        const config = makeConfig([
          makeChannelConfig({
            id: 'ch-1',
            type: 'mock',
            secrets: { TEST_CHANNEL_TOKEN: '$TEST_CHANNEL_TOKEN' },
          }),
        ]);
        const service = createGatewayService({
          runner: makeMockRunner(),
          bindingsFile,
          config,
          pluginFactories: factories,
        });

        await service.start();

        // Plugin started (no "missing required secrets" throw).
        expect(instances[0]!.running).toBe(true);
        // Resolved secret reached the plugin's runtime config.
        expect(instances[0]!.ctx?.config.secrets['TEST_CHANNEL_TOKEN']).toBe('real-token-123');
      } finally {
        delete process.env['TEST_CHANNEL_TOKEN'];
      }
    });

    it('warns when a $VAR secret references an unset env var', async () => {
      const envName = 'UNSET_TEST_TOKEN_XYZ';
      delete process.env[envName];
      const { factory, instances } = makeMockPluginFactory({
        type: 'mock',
        requiredSecrets: [], // no required secrets so start succeeds
      });
      const factories = new Map([['mock', factory]]);
      const config = makeConfig([
        makeChannelConfig({
          id: 'ch-1',
          type: 'mock',
          secrets: { OPTIONAL_TOKEN: `$${envName}` },
        }),
      ]);
      const { log, entries } = makeLogCapture();
      const service = createGatewayService({
        runner: makeMockRunner(),
        bindingsFile,
        config,
        pluginFactories: factories,
        log,
      });

      await service.start();

      // Channel still started (secret was optional, not in requiredSecrets).
      expect(instances[0]!.running).toBe(true);
      // A warning was logged about the unset env var.
      expect(entries.some((e) => e.level === 'warn' && e.msg.includes(envName))).toBe(true);
    });
  });

  describe('stop', () => {
    it('stops all running channels', async () => {
      const { factory, instances } = makeMockPluginFactory({ type: 'mock' });
      const factories = new Map([['mock', factory]]);
      const config = makeConfig([
        makeChannelConfig({ id: 'ch-1', type: 'mock' }),
        makeChannelConfig({ id: 'ch-2', type: 'mock' }),
      ]);
      const service = createGatewayService({
        runner: makeMockRunner(),
        bindingsFile,
        config,
        pluginFactories: factories,
      });

      await service.start();
      expect(service.list()).toHaveLength(2);

      await service.stop();

      expect(service.started).toBe(false);
      expect(service.list()).toHaveLength(0);
      expect(instances.every((i) => i.stopCalls === 1)).toBe(true);
    });

    it('is idempotent — stop() when not started is a no-op', async () => {
      const service = createGatewayService({
        runner: makeMockRunner(),
        bindingsFile,
        config: makeConfig([]),
        pluginFactories: new Map(),
      });

      await service.stop(); // no throw
      expect(service.started).toBe(false);
    });
  });

  describe('setRunner', () => {
    it('hot-swaps the runner reference without restarting channels', async () => {
      const { factory, instances } = makeMockPluginFactory({ type: 'mock' });
      const factories = new Map([['mock', factory]]);
      const config = makeConfig([makeChannelConfig({ id: 'ch-1', type: 'mock' })]);
      const originalRunner = makeMockRunner();
      const service = createGatewayService({
        runner: originalRunner,
        bindingsFile,
        config,
        pluginFactories: factories,
      });

      await service.start();
      const newRunner = makeMockRunner();
      service.setRunner(newRunner);

      // Channel still running (not restarted).
      expect(instances[0]!.running).toBe(true);
      expect(instances[0]!.startCalls).toBe(1); // no restart triggered
      // No throw = success; the new runner is now used for subsequent runAgent calls.
    });
  });

  describe('restart (stop → start cycle)', () => {
    it('does not throw registerType "already registered" on restart', async () => {
      const { factory, instances } = makeMockPluginFactory({ type: 'mock' });
      const factories = new Map([['mock', factory]]);
      const config = makeConfig([makeChannelConfig({ id: 'ch-1', type: 'mock' })]);
      const service = createGatewayService({
        runner: makeMockRunner(),
        bindingsFile,
        config,
        pluginFactories: factories,
      });

      // First cycle.
      await service.start();
      await service.stop();

      // Second cycle — must not throw "already registered".
      await service.start();

      // A new plugin instance was created for the second start.
      expect(instances).toHaveLength(2);
      expect(service.list()).toHaveLength(1);
      expect(service.started).toBe(true);
    });
  });
});

describe('resolveChannelSecrets', () => {
  it('resolves $VAR references from process.env', () => {
    process.env['MY_TEST_KEY'] = 'secret-value';
    try {
      const result = resolveChannelSecrets(
        { KEY1: '$MY_TEST_KEY', KEY2: 'literal-value' },
        () => {},
      );
      expect(result).toEqual({ KEY1: 'secret-value', KEY2: 'literal-value' });
    } finally {
      delete process.env['MY_TEST_KEY'];
    }
  });

  it('omits secrets whose env var is unset and logs a warning', () => {
    delete process.env['UNSET_KEY_XYZ'];
    const warnings: string[] = [];
    const result = resolveChannelSecrets(
      { MISSING: '$UNSET_KEY_XYZ', PRESENT: 'literal' },
      (level, msg) => { if (level === 'warn') warnings.push(msg); },
    );
    // Missing env var → omitted from result.
    expect(result).toEqual({ PRESENT: 'literal' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('UNSET_KEY_XYZ');
  });

  it('passes through literal values (no $ prefix)', () => {
    const result = resolveChannelSecrets(
      { A: 'plain', B: 'another', C: '' },
      () => {},
    );
    expect(result).toEqual({ A: 'plain', B: 'another', C: '' });
  });

  it('handles empty secrets map', () => {
    const result = resolveChannelSecrets({}, () => {});
    expect(result).toEqual({});
  });
});
