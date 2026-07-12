// @littlesheep/gateway — channel/types.ts
// Core type contracts for the channel plugin system.
//
// A ChannelPlugin is an adapter that connects a communication channel
// (QQ Bot, 飞书, Webhook, Telegram) to the agent. The ChannelManager
// owns plugin lifecycle: register → start → stop → remove (cascade delete).
//
// Flow:
//   1. Channel receives a message → constructs InboundChannelMessage
//   2. Channel calls ctx.resolveSession() to find/create the bound session
//   3. Channel calls ctx.runAgent(message, sessionId) → runner.run({ origin:'channel' })
//   4. Channel sends the reply back via plugin.send() or directly

import type { ZodSchema } from 'zod';
import type { SessionId } from '@littlesheep/types';
import type { ChannelConfig, ConversationPolicy } from '@littlesheep/config';
import type { LogFn } from '@littlesheep/runner';

/** Channel instance id (unique within config, e.g. "tg-home-bot"). */
export type ChannelId = string;

/**
 * A message arriving from a channel (user → agent).
 * Channels construct this from their platform-specific payload.
 */
export interface InboundChannelMessage {
  /** User's text input. */
  text: string;
  /** External conversation id (e.g. Telegram chat.id, QQ group id). */
  externalConversationId: string;
  /** External user id (e.g. Telegram user.id). */
  externalUserId: string;
  /** Whether this message came from a group chat (vs DM). */
  isGroup: boolean;
  /** Display name of the sender (for logging/UI). */
  userName?: string;
  /** Original platform payload (for debugging; not persisted). */
  raw?: unknown;
}

/**
 * A message going out to a channel (agent → user).
 * Channels format this for their platform (Markdown, rich text, etc.).
 */
export interface OutboundChannelMessage {
  /** Reply text from the agent. */
  text: string;
  /** Target conversation id. */
  externalConversationId: string;
  /** Target user id (optional, for DMs). */
  externalUserId?: string;
}

/**
 * Resolved runtime config for a started channel.
 * `secrets` are already decrypted/resolved (not env var references).
 */
export interface ChannelRuntimeConfig {
  /** Channel instance id. */
  id: ChannelId;
  /** Channel type (matches plugin.type). */
  type: string;
  /** Display name. */
  name?: string;
  /** DM conversation policy. */
  dmPolicy: ConversationPolicy;
  /** Group conversation policy. */
  groupPolicy: ConversationPolicy;
  /** Model override (provider/model). */
  model?: string;
  /** Channel-specific options (validated by plugin.optionsSchema). */
  options: Record<string, unknown>;
  /** Resolved secrets: { key: 'actual_value' }. */
  secrets: Record<string, string>;
}

/**
 * Context passed to ChannelPlugin.start(). Provides everything the plugin
 * needs to resolve sessions and invoke the agent.
 */
export interface ChannelContext {
  /** Resolved runtime config (secrets decrypted). */
  config: ChannelRuntimeConfig;
  /**
   * Resolve or create a session for this channel + external conversation.
   * - If a session already exists for (channelId, externalConversationId),
   *   returns its id.
   * - Otherwise creates a new session with channelId/origin stamped in metadata.
   */
  resolveSession(externalConversationId: string, externalUserId: string): Promise<SessionId>;
  /**
   * Run the agent on an inbound message. Returns the reply text.
   * Internally calls runner.run({ sessionId, text, origin: 'channel', channelId }).
   */
  runAgent(
    message: InboundChannelMessage,
    sessionId: SessionId,
  ): Promise<{ reply: string; ok: boolean; error?: string }>;
  /** Structured logger. */
  log: LogFn;
  /** Abort signal — fired when the channel is stopping. */
  signal: AbortSignal;
}

/**
 * Contract for channel adapters. Each channel type (qqbot, feishu, webhook,
 * telegram) implements this interface.
 */
export interface ChannelPlugin {
  /** Channel type identifier (e.g. 'telegram', 'webhook'). */
  readonly type: string;
  /** Human-readable name for UI/logs. */
  readonly displayName: string;
  /** Optional zod schema for validating plugin-specific options. */
  readonly optionsSchema?: ZodSchema;
  /** Secret keys this plugin requires (e.g. ['TELEGRAM_BOT_TOKEN']). */
  readonly requiredSecrets: string[];
  /** Whether the plugin is currently running (started, not yet stopped). */
  readonly running: boolean;
  /**
   * Start the channel: connect to the platform, begin polling/listening.
   * Called by ChannelManager.start(). Must store the ctx for later use.
   */
  start(ctx: ChannelContext): Promise<void>;
  /** Stop the channel: disconnect, release resources. Idempotent. */
  stop(): Promise<void>;
  /**
   * Send a message back to the channel (optional — some channels send
   * directly in their message handler via the platform API).
   */
  send?(msg: OutboundChannelMessage): Promise<void>;
}

/**
 * Factory that creates a ChannelPlugin instance. Registered with
 * ChannelManager.registerType() and called when a channel config is started.
 */
export type ChannelPluginFactory = () => ChannelPlugin;

/** Re-export config types for convenience. */
export type { ChannelConfig, ConversationPolicy };
