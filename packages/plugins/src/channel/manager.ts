// @littlesheep/plugins — channel/manager.ts
// DefaultChannelManager: manages channel plugin lifecycle.
//
// Responsibilities:
//   - Register channel plugin factories by type
//   - Start channels (instantiate plugin, provide ChannelContext, call plugin.start)
//   - Stop channels (plugin.stop, abort signal, keep sessions)
//   - Remove channels (stop + cascade delete bound sessions)
//   - List running channels
//   - Stop all channels (shutdown)
//
// Cascade delete flow (remove):
//   plugin.stop() → sessionStore.findByChannel() → sessionManager.delete(each) → sessionStore.unbindChannel()

import { formatWebEvidenceSources, type SessionId } from '@littlesheep/types';
import { prepareAuthoritativeRunnerResult, type AgentRunner, type LogFn } from '@littlesheep/runner';
import type { ChannelConfig } from '@littlesheep/config';
import { ChannelSessionStore } from './session-binding.js';
import type {
  ChannelPlugin,
  ChannelPluginFactory,
  ChannelContext,
  ChannelRuntimeConfig,
  ChannelId,
  InboundChannelMessage,
} from './types.js';
import { PairingState } from './policy.js';

/** A running channel instance: plugin + its abort controller. */
interface RunningChannel {
  plugin: ChannelPlugin;
  abortController: AbortController;
  channelId: ChannelId;
}

/** Options for DefaultChannelManager. */
export interface ChannelManagerOptions {
  /** The agent runner (for runAgent in ChannelContext). */
  runner: AgentRunner;
  /** Channel session binding store (for resolveSession + cascade delete). */
  sessionStore: ChannelSessionStore;
  /** Structured logger. */
  log?: LogFn;
}

/**
 * Manages channel plugin lifecycle: register, start, stop, remove.
 *
 * Each running channel gets its own AbortController — when stop() is called,
 * the signal fires so the plugin can clean up its network connections.
 */
export class DefaultChannelManager {
  /** Registered plugin factories: type → factory. */
  private factories = new Map<string, ChannelPluginFactory>();
  /** Running channel instances: channelId → RunningChannel. */
  private running = new Map<ChannelId, RunningChannel>();
  /** In-memory pairing state (for pairing policy). */
  private pairingState = new PairingState();
  /** The agent runner (used by runAgent in ChannelContext). */
  private runner: AgentRunner;
  /** Channel session binding store. */
  private sessionStore: ChannelSessionStore;
  /** Logger. */
  private log: LogFn;

  constructor(opts: ChannelManagerOptions) {
    this.runner = opts.runner;
    this.sessionStore = opts.sessionStore;
    this.log = opts.log ?? (() => {});
  }

  /** Number of currently running channels. */
  get runningCount(): number {
    return this.running.size;
  }

  /**
   * Swap the agent runner reference. Used when API key changes trigger a runner
   * rebuild — channels keep running, but new runAgent calls use the new runner.
   * The plugin host calls this after rebuilding the core runner.
   */
  setRunner(runner: AgentRunner): void {
    this.runner = runner;
    this.log('info', 'channel: runner reference swapped');
  }

  /**
   * Register a plugin factory for a channel type.
   * Call this before start() — start() looks up the factory by config.type.
   */
  registerType(type: string, factory: ChannelPluginFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`channel type "${type}" is already registered`);
    }
    this.factories.set(type, factory);
    this.log('info', `channel: registered type "${type}"`);
  }

  /** Remove an inactive channel type registration. */
  unregisterType(type: string): boolean {
    const inUse = Array.from(this.running.values()).some((entry) => entry.plugin.type === type)
    if (inUse) throw new Error(`channel type "${type}" is still running`)
    const removed = this.factories.delete(type)
    if (removed) this.log('info', `channel: unregistered type "${type}"`)
    return removed
  }

  hasType(type: string): boolean {
    return this.factories.has(type)
  }

  registeredTypes(): string[] {
    return Array.from(this.factories.keys())
  }

  /**
   * Start a channel from config. Instantiates the plugin, builds the
   * ChannelContext, and calls plugin.start(ctx).
   *
   * @returns The started plugin.
   * @throws If the type is not registered or the plugin fails to start.
   */
  async start(config: ChannelRuntimeConfig): Promise<ChannelPlugin> {
    const channelId = config.id;

    // Already running?
    if (this.running.has(channelId)) {
      throw new Error(`channel "${channelId}" is already running`);
    }

    // Find factory.
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new Error(
        `channel type "${config.type}" is not registered (register it first with registerType())`,
      );
    }

    // Instantiate plugin.
    const plugin = factory();

    // Validate required secrets.
    const missingSecrets = plugin.requiredSecrets.filter((key) => !config.secrets[key]);
    if (missingSecrets.length > 0) {
      throw new Error(
        `channel "${channelId}" (${config.type}) missing required secrets: ${missingSecrets.join(', ')}`,
      );
    }

    // Create abort controller for this channel.
    const abortController = new AbortController();

    // Build ChannelContext.
    const ctx: ChannelContext = {
      config,
      resolveSession: (externalConvId, _externalUserId) =>
        this.resolveSession(channelId, externalConvId, config.model),
      runAgent: (message, sessionId) =>
        this.runAgent(channelId, message, sessionId),
      log: this.log,
      signal: abortController.signal,
    };

    // Log sanitized options (exclude secret fields) for troubleshooting.
    const optionSummary = Object.entries(config.options ?? {})
      .filter(([k]) => k !== 'hmacSecret' && k !== 'bearerToken')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ');
    this.log('info', `channel: "${channelId}" starting (options: ${optionSummary || 'none'})`);

    // Start the plugin.
    const pluginT0 = performance.now();
    try {
      await plugin.start(ctx);
    } catch (err) {
      abortController.abort();
      await plugin.stop().catch((cleanupError) => {
        this.log('warn', `channel: "${channelId}" cleanup after failed start: ${(cleanupError as Error).message}`);
      });
      throw new Error(
        `channel "${channelId}" (${config.type}) failed to start: ${(err as Error).message}`,
      );
    }
    const pluginDur = (performance.now() - pluginT0).toFixed(1);

    // Track it.
    this.running.set(channelId, { plugin, abortController, channelId });
    this.log(
      'info',
      `channel: started "${channelId}" (${config.type}, display="${plugin.displayName}") (${pluginDur}ms)`,
    );

    return plugin;
  }

  /**
   * Stop a channel but keep its sessions (user can restart later).
   * Calls plugin.stop() and fires the abort signal.
   */
  async stop(channelId: ChannelId): Promise<void> {
    const entry = this.running.get(channelId);
    if (!entry) {
      this.log('warn', `channel: stop called for "${channelId}" but it's not running`);
      return;
    }

    const t0 = performance.now();
    // Fire abort signal so the plugin can clean up.
    entry.abortController.abort();

    // Stop the plugin.
    try {
      await entry.plugin.stop();
    } catch (err) {
      this.log('error', `channel: "${channelId}" stop error: ${(err as Error).message}`);
    }

    this.running.delete(channelId);
    const dur = (performance.now() - t0).toFixed(1);
    this.log('info', `channel: stopped "${channelId}" (${dur}ms, sessions preserved)`);
  }

  /**
   * Remove a channel entirely: stop it AND cascade-delete all bound sessions.
   *
   * Cascade delete flow:
   *   1. plugin.stop() + abort
   *   2. sessionStore.findByChannel(channelId) → list of bindings
   *   3. For each binding: sessionManager.delete(sessionId)
   *   4. sessionStore.unbindChannel(channelId) — remove all bindings
   *   5. pairingState.clearChannel(channelId) — clear pairing state
   */
  async remove(channelId: ChannelId): Promise<void> {
    // Stop the channel first.
    await this.stop(channelId);

    // Cascade delete bound sessions.
    const bindings = await this.sessionStore.findByChannel(channelId);
    let deletedCount = 0;
    for (const binding of bindings) {
      try {
        await this.runner.sessionManager.delete(binding.sessionId as SessionId);
        deletedCount++;
      } catch (err) {
        this.log('error', `channel: cascade delete failed for session ${binding.sessionId}: ${(err as Error).message}`);
      }
    }

    // Remove all bindings for this channel.
    await this.sessionStore.unbindChannel(channelId);

    // Clear pairing state.
    this.pairingState.clearChannel(channelId);

    this.log(
      'info',
      `channel: removed "${channelId}" (cascade-deleted ${deletedCount} sessions)`,
    );
  }

  /**
   * List all running channel plugins. `stop()` removes the entry, so a plugin
   * returned here is running: the status payload never carries a
   * loaded-but-stopped channel, and a channel that failed to start is a
   * failure entry instead (contract pinned in manager.test.ts).
   */
  list(): ChannelPlugin[] {
    return Array.from(this.running.values()).map((r) => r.plugin);
  }

  /** Stop all running channels (for shutdown). Does NOT delete sessions. */
  async stopAll(): Promise<void> {
    const t0 = performance.now();
    const ids = Array.from(this.running.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
    const dur = (performance.now() - t0).toFixed(1);
    this.log('info', `channel: stopped all (${ids.length} channels, ${dur}ms)`);
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Resolve or create a session for a channel + external conversation.
   * - Find existing binding by channelId + externalConversationId.
   * - If not found, create a new session with channel metadata.
   * - Record the binding in ChannelSessionStore.
   */
  private async resolveSession(
    channelId: ChannelId,
    externalConversationId: string,
    model?: string,
  ): Promise<SessionId> {
    // 1. Look for an existing binding with matching externalConversationId.
    const bindings = await this.sessionStore.findByChannel(channelId);
    const existing = bindings.find(
      (b) => b.externalConversationId === externalConversationId,
    );
    if (existing) {
      return existing.sessionId as SessionId;
    }

    // 2. Create a new session with channel metadata.
    const session = await this.runner.sessionManager.create(model, undefined, {
      channelId,
      origin: 'channel',
      externalConversationId,
    });

    // 3. Record the binding.
    await this.sessionStore.bind({
      channelId,
      sessionId: session.id,
      externalConversationId,
    });

    this.log(
      'info',
      `channel: created session ${session.id} for channel "${channelId}" (extConv=${externalConversationId})`,
    );

    return session.id;
  }

  /**
   * Run the agent on an inbound channel message.
   * Delegates to runner.run() with origin='channel'.
   */
  private async runAgent(
    channelId: ChannelId,
    message: InboundChannelMessage,
    sessionId: SessionId,
  ): Promise<{ reply: string; ok: boolean; error?: string; finalReplySettlement?: import('@littlesheep/types').FinalReplySettlement }> {
    try {
      const result = await this.runner.run({
        sessionId,
        text: message.text,
        origin: 'channel',
        channelId,
        externalConversationId: message.externalConversationId,
        requestKey: message.requestKey,
      });
      const publishedResult = (result.durableHarnessMode ?? this.runner.durableHarnessMode) === 'next'
        ? await prepareAuthoritativeRunnerResult(this.runner, result)
        : result;
      return {
        reply: appendWebSources(
          publishedResult.finalReplySettlement?.status === 'settled'
            ? publishedResult.finalReplySettlement.reply
            : publishedResult.finalReplySettlement
              ? ''
              : publishedResult.reply ?? '',
          formatWebEvidenceSources(publishedResult.webEvidence),
        ),
        ok: publishedResult.status === 'ok',
        error: publishedResult.error,
        finalReplySettlement: publishedResult.finalReplySettlement,
      };
    } catch (err) {
      return {
        reply: '',
        ok: false,
        error: (err as Error).message,
      };
    }
  }
}

function appendWebSources(reply: string, sources: string): string {
  if (!sources) return reply;
  return reply ? `${reply}\n\n${sources}` : sources;
}

/** Build ChannelRuntimeConfig from a ChannelConfig + resolved secrets. */
export function buildRuntimeConfig(
  config: ChannelConfig,
  secrets: Record<string, string>,
): ChannelRuntimeConfig {
  return {
    id: config.id,
    type: config.type,
    name: config.name,
    dmPolicy: config.dmPolicy,
    groupPolicy: config.groupPolicy,
    model: config.model,
    options: config.options,
    secrets,
  };
}
