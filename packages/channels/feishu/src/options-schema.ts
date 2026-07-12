// @littlesheep/channel-feishu — options-schema.ts
// Zod schema for Feishu channel options.
//
// The Feishu channel uses long connection (WebSocket) mode — the bot connects
// to Feishu's server via WebSocket, and Feishu pushes events through the
// connection. No public callback URL is needed.
//
// Secrets (provided via ChannelConfig.secrets):
//   Required: FEISHU_APP_ID, FEISHU_APP_SECRET
//   Optional: FEISHU_VERIFICATION_TOKEN, FEISHU_ENCRYPT_KEY

import { z } from 'zod';

/**
 * Options for the Feishu channel.
 *
 * These control API endpoints, token refresh timing, reconnection behavior,
 * and message splitting. All sensitive credentials (app_id, app_secret,
 * verification_token, encrypt_key) are provided via `ChannelConfig.secrets`,
 * not options.
 */
export const FeishuOptionsSchema = z.object({
  /**
   * Feishu Open API base URL.
   * Default: https://open.feishu.cn (China). Use https://open.larksuite.com
   * for international (Lark).
   */
  apiBase: z.string().url().default('https://open.feishu.cn'),

  /**
   * Buffer (ms) before tenant_access_token expiry to trigger a refresh.
   * The token is valid for 7200s (2h); refreshing this many ms early avoids
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
   * Maximum text length (chars) per sendMessage call. Feishu has a practical
   * limit on text message content; replies longer than this are split into
   * multiple messages. Default: 4000.
   */
  messageSplitLength: z.number().int().min(100).max(4000).default(4000),
});

export type FeishuOptions = z.infer<typeof FeishuOptionsSchema>;
