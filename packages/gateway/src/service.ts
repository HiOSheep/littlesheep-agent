// @littlesheep/gateway — service.ts
// GatewayService: top-level service that manages channel plugin lifecycle
// for the Electron APP. Wraps DefaultChannelManager + ChannelSessionStore.
//
// Embedded in-process (not a subprocess) per project hard constraint:
// "Gateway must be embedded in Electron main process (not separate)".
//
// Lifecycle:
//   APP bootstrap → createGatewayService() → start() → channels running
//   API key change → setRunner(newRunner) → channels keep running
//   APP quit → stop() → channels stopped (sessions preserved)
//
// Restart safety: typesRegistered flag prevents registerType() from throwing
// on a stop()→start() cycle (factories stay registered across restarts).

import type { AgentRunner, LogFn } from '@littlesheep/runner';
import type { Config } from '@littlesheep/config';
import { DefaultChannelManager, buildRuntimeConfig } from './channel/manager.js';
import { ChannelSessionStore } from './channel/session-binding.js';
import type { ChannelPlugin, ChannelPluginFactory } from './channel/types.js';

/** Options for createGatewayService. */
export interface CreateGatewayServiceOptions {
  /** The agent runner (for runAgent in ChannelContext). */
  runner: AgentRunner;
  /** Path to the bindings.json file (~/.littlesheep/channels/bindings.json). */
  bindingsFile: string;
  /** App config — reads config.channels.channels for channel definitions. */
  config: Config;
  /** Plugin factories to register, keyed by channel type. */
  pluginFactories: Map<string, ChannelPluginFactory>;
  /** Structured logger. */
  log?: LogFn;
}

/** Top-level gateway service managing all channel plugins. */
export interface GatewayService {
  /**
   * Start all enabled channels from config.channels.channels.
   * Serial startup with per-channel error isolation — one failing channel
   * does not prevent others from starting. Idempotent.
   */
  start(): Promise<void>;
  /**
   * Stop all running channels. Preserves sessions and factory registrations
   * so start() can be called again. Idempotent.
   */
  stop(): Promise<void>;
  /**
   * Hot-swap the runner reference (e.g. after API key change triggers a
   * runner rebuild). Channels keep running; new runAgent calls use the
   * new runner.
   */
  setRunner(runner: AgentRunner): void;
  /**
   * Update the config reference (e.g. after config.json is edited on disk
   * and the user triggers a reload from the UI). The new config takes
   * effect on the next start() or reload() call.
   */
  setConfig(config: Config): void;
  /**
   * Atomic reload: stop all channels, then start with the current config.
   * Used by the UI "重新加载" button after editing config.json.
   */
  reload(): Promise<void>;
  /** List currently running channel plugins. */
  list(): ChannelPlugin[];
  /** Whether start() has been called and stop() has not yet been called. */
  readonly started: boolean;
}

/**
 * Resolve channel secrets: values starting with '$' are treated as env var
 * references (e.g. '$TELEGRAM_BOT_TOKEN' → process.env.TELEGRAM_BOT_TOKEN).
 * Other values are passed through as-is. Missing env vars emit a warning.
 */
export function resolveChannelSecrets(
  secrets: Record<string, string>,
  log: LogFn,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (value.startsWith('$')) {
      const envName = value.slice(1);
      const envValue = process.env[envName];
      if (envValue) {
        resolved[key] = envValue;
      } else {
        log('warn', `channel: secret "${key}" references env var "${envName}" which is unset`);
      }
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/** Create a GatewayService. Does not start any channels — call start() to begin. */
export function createGatewayService(opts: CreateGatewayServiceOptions): GatewayService {
  const log: LogFn = opts.log ?? (() => {});
  const sessionStore = new ChannelSessionStore({ bindingsFile: opts.bindingsFile });
  const channelManager = new DefaultChannelManager({
    runner: opts.runner,
    sessionStore,
    log,
  });

  let typesRegistered = false;
  let started = false;
  let currentConfig = opts.config;
  // Monotonic operation counter — each start/stop/reload call gets a unique
  // seq number for log correlation. Helps diagnose concurrency issues:
  // interleaved seq numbers in logs reveal re-entrant/concurrent operations.
  let opSeq = 0;

  return {
    get started() {
      return started;
    },

    async start(): Promise<void> {
      const seq = ++opSeq;
      const t0 = performance.now();
      log('info', `gateway: [start#${seq}] begin`);

      if (started) {
        log('info', `gateway: [start#${seq}] already running — no-op`);
        return;
      }

      // Register plugin factories (only on first start — restart reuses
      // registrations to avoid registerType() "already registered" throws).
      if (!typesRegistered) {
        const regT0 = performance.now();
        for (const [type, factory] of opts.pluginFactories) {
          channelManager.registerType(type, factory);
        }
        typesRegistered = true;
        log(
          'info',
          `gateway: [start#${seq}] registered ${opts.pluginFactories.size} channel type(s) (${(performance.now() - regT0).toFixed(1)}ms)`,
        );
      }

      // Start each enabled channel from config. Serial with per-channel
      // try/catch so one failure doesn't block the rest.
      const channels = currentConfig.channels?.channels ?? [];
      const enabled = channels.filter((c) => c.enabled);
      const skipped = channels.length - enabled.length;
      log(
        'info',
        `gateway: [start#${seq}] config loaded — ${channels.length} channel(s) defined, ${enabled.length} enabled, ${skipped} disabled`,
      );

      const startedIds: string[] = [];
      const failedIds: string[] = [];
      for (let i = 0; i < enabled.length; i++) {
        const channelConfig = enabled[i]!;
        const chT0 = performance.now();
        log(
          'info',
          `gateway: [start#${seq}] starting channel "${channelConfig.id}" (${channelConfig.type}) [${i + 1}/${enabled.length}]`,
        );
        try {
          const resolvedSecrets = resolveChannelSecrets(channelConfig.secrets ?? {}, log);
          const runtimeConfig = buildRuntimeConfig(channelConfig, resolvedSecrets);
          await channelManager.start(runtimeConfig);
          startedIds.push(channelConfig.id);
          const chDur = (performance.now() - chT0).toFixed(1);
          log(
            'info',
            `gateway: [start#${seq}] ✓ channel "${channelConfig.id}" (${channelConfig.type}) started (${chDur}ms)`,
          );
        } catch (err) {
          failedIds.push(channelConfig.id);
          const chDur = (performance.now() - chT0).toFixed(1);
          log(
            'error',
            `gateway: [start#${seq}] channel "${channelConfig.id}" (${channelConfig.type}) failed to start (${chDur}ms): ${(err as Error).message}`,
          );
        }
      }

      started = true;
      const dur = (performance.now() - t0).toFixed(1);
      log(
        'info',
        failedIds.length > 0
          ? `gateway: [start#${seq}] complete — ok: [${startedIds.join(', ')}], failed: [${failedIds.join(', ')}] (${dur}ms total)`
          : `gateway: [start#${seq}] complete — ok: [${startedIds.join(', ')}] (${dur}ms total)`,
      );
    },

    async stop(): Promise<void> {
      const seq = ++opSeq;
      const t0 = performance.now();
      log('info', `gateway: [stop#${seq}] begin`);

      if (!started) {
        log('info', `gateway: [stop#${seq}] not running — no-op`);
        return;
      }
      await channelManager.stopAll();
      started = false;
      const dur = (performance.now() - t0).toFixed(1);
      log('info', `gateway: [stop#${seq}] complete (${dur}ms)`);
    },

    setRunner(runner: AgentRunner): void {
      channelManager.setRunner(runner);
    },

    setConfig(config: Config): void {
      currentConfig = config;
      // Log the current started state — if setConfig is called while a
      // reload is mid-flight (between stop and start), started will be false
      // here, and the next start() will pick up this new config. This helps
      // diagnose the race between setConfig and reload.
      log('info', `gateway: [setConfig] config reference updated (started=${started})`);
    },

    async reload(): Promise<void> {
      const seq = ++opSeq;
      const t0 = performance.now();
      log('info', `gateway: [reload#${seq}] begin`);
      const stopT0 = performance.now();
      await this.stop();
      log(
        'info',
        `gateway: [reload#${seq}] stop phase done (${(performance.now() - stopT0).toFixed(1)}ms)`,
      );
      const startT0 = performance.now();
      await this.start();
      log(
        'info',
        `gateway: [reload#${seq}] start phase done (${(performance.now() - startT0).toFixed(1)}ms)`,
      );
      log(
        'info',
        `gateway: [reload#${seq}] complete (${(performance.now() - t0).toFixed(1)}ms total)`,
      );
    },

    list(): ChannelPlugin[] {
      return channelManager.list();
    },
  };
}
