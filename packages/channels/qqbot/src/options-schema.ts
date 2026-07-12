// @littlesheep/channel-qqbot — options-schema.ts
// Zod schema for QQ Bot channel options.
//
// The QQ Bot channel uses WebSocket mode — the bot connects to QQ's gateway
// via WebSocket, receives events in real-time, and sends replies via HTTP API.
// No public callback URL is needed.
//
// Secrets (provided via ChannelConfig.secrets):
//   Required: QQBOT_APPID, QQBOT_APPSECRET
//
// References:
//   - QQ Bot open platform: https://bot.q.qq.com/
//   - WebSocket gateway protocol (op-based, similar to Discord)

import { z } from 'zod';

/**
 * Options for the QQ Bot channel.
 *
 * These control API endpoints, token refresh timing, reconnection behavior,
 * heartbeat interval, and message splitting. All sensitive credentials
 * (appid, appsecret) are provided via `ChannelConfig.secrets`, not options.
 */
export const QqbotOptionsSchema = z.object({
  /**
   * QQ Bot API base URL (for gateway + message sending).
   * Default: https://api.sgroup.qq.com
   */
  apiBase: z.string().url().default('https://api.sgroup.qq.com'),

  /**
   * Auth base URL (for getAppAccessToken).
   * Default: https://bots.qq.com
   */
  authBase: z.string().url().default('https://bots.qq.com'),

  /**
   * Buffer (ms) before access_token expiry to trigger a refresh.
   * The token is valid for ~7200s (2h); refreshing this many ms early avoids
   * edge-case 401s during in-flight requests. Default: 300000 (5 min).
   */
  tokenRefreshBufferMs: z.number().int().min(0).default(300000),

  /**
   * Initial delay (ms) before reconnecting after a WebSocket disconnect.
   * Uses exponential backoff: delay doubles each failure up to
   * reconnectMaxDelayMs. Default: 5000.
   */
  reconnectDelayMs: z.number().int().min(100).default(5000),

  /**
   * Maximum delay (ms) for exponential backoff reconnection.
   * Default: 30000.
   */
  reconnectMaxDelayMs: z.number().int().min(1000).default(30000),

  /**
   * Buffer (ms) subtracted from the server-specified heartbeat_interval.
   * We send heartbeats slightly before the deadline to avoid timing
   * disconnections. Default: 5000.
   */
  heartbeatIntervalBufferMs: z.number().int().min(0).default(5000),

  /**
   * Maximum text length (chars) per sendMessage call. QQ Bot text messages
   * have a practical limit of ~2000 chars; replies longer than this are
   * split into multiple messages. Default: 2000.
   */
  messageSplitLength: z.number().int().min(100).max(2000).default(2000),
});

export type QqbotOptions = z.infer<typeof QqbotOptionsSchema>;
