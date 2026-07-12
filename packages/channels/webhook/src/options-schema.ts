// @littlesheep/channel-webhook — options-schema.ts
// Zod schema for webhook channel options.
//
// These options come from ChannelConfig.options (validated by the plugin's
// optionsSchema in ChannelPlugin). They control the HTTP server behavior:
// where to listen, how to authenticate incoming webhooks.

import { z } from 'zod';

/**
 * Options for the webhook channel.
 *
 * The webhook channel starts an HTTP server on 127.0.0.1 (loopback only —
 * no public network exposure). External systems (reverse proxy, ngrok, etc.)
 * forward webhooks to this local port.
 */
export const WebhookOptionsSchema = z.object({
  /** Port to listen on (default 9876). Use 0 to let the OS assign a free port. */
  port: z.number().int().min(0).max(65535).default(9876),
  /** URL path to receive webhooks on (default '/webhook'). */
  path: z.string().regex(/^\//, 'path must start with /').default('/webhook'),
  /**
   * HMAC-SHA256 secret for signature verification.
   * If set, requests must include header:
   *   X-Signature-256: sha256=<hex>
   * where <hex> is the HMAC-SHA256 of the raw request body.
   * If unset, signature verification is skipped (not recommended for production).
   */
  hmacSecret: z.string().optional(),
  /**
   * Bearer token for authorization.
   * If set, requests must include header:
   *   Authorization: Bearer <token>
   * If unset, no authorization check.
   */
  bearerToken: z.string().optional(),
});

export type WebhookOptions = z.infer<typeof WebhookOptionsSchema>;
