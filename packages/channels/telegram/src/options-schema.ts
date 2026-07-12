// @littlesheep/channel-telegram — options-schema.ts
// Zod schema for Telegram channel options.
//
// The Telegram channel uses long polling (getUpdates) to receive messages.
// No SDK dependency — just plain HTTP calls to the Telegram Bot API.

import { z } from 'zod';

/**
 * Options for the Telegram channel.
 *
 * The bot token is provided via `ChannelConfig.secrets.TELEGRAM_BOT_TOKEN`
 * (required, listed in ChannelPlugin.requiredSecrets). These options control
 * polling behavior and API endpoint.
 */
export const TelegramOptionsSchema = z.object({
  /** Telegram Bot API base URL (default: https://api.telegram.org). */
  apiBase: z.string().url().default('https://api.telegram.org'),
  /**
   * Long polling timeout in seconds (passed to getUpdates `timeout` param).
   * The server holds the connection open for up to this many seconds waiting
   * for new updates. Default: 30.
   */
  pollingTimeout: z.number().int().min(0).max(50).default(30),
  /**
   * Delay (ms) before retrying after a poll error (network/API failure).
   * Prevents tight error loops. Default: 5000.
   */
  errorBackoffMs: z.number().int().min(100).default(5000),
  /**
   * Minimum delay (ms) between consecutive getUpdates calls.
   * With long polling (pollingTimeout > 0), the HTTP request itself blocks
   * for up to `pollingTimeout` seconds, so this is usually 0 in production.
   * Set to a small value (e.g. 50) in tests with pollingTimeout=0 to prevent
   * tight polling loops. Default: 0.
   */
  pollIntervalMs: z.number().int().min(0).default(0),
  /**
   * Which update types to receive. Empty/omitted = all types.
   * Default: ['message'] (only message updates, skip edited messages, etc.)
   */
  allowedUpdates: z.array(z.string()).default(['message']),
  /**
   * Whether to send "typing" chat action while the agent is processing.
   * Improves UX by showing the bot is working. Default: true.
   */
  sendTypingAction: z.boolean().default(true),
});

export type TelegramOptions = z.infer<typeof TelegramOptionsSchema>;
