// @littlesheep/channel-webhook — plugin.ts
// WebhookChannelPlugin: receives messages via HTTP POST on 127.0.0.1.
//
// This is the simplest channel — no SDK dependency, just a plain HTTP server.
// External systems (reverse proxy, ngrok, automation tools) forward messages
// to the local webhook endpoint.
//
// Protocol:
//   POST {path}
//   Headers:
//     Content-Type: application/json
//     X-Signature-256: sha256=<hex>   (if hmacSecret configured)
//     Authorization: Bearer <token>    (if bearerToken configured)
//   Body:
//     { "text": "...", "conversationId": "...", "userId": "...",
//       "isGroup": false, "userName": "..." }
//   Response:
//     200 { "ok": true, "reply": "...", "sessionId": "..." }
//     4xx/5xx { "ok": false, "error": "..." }
//
//   GET {path}  → health check: 200 { "ok": true, "service": "webhook-channel" }

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelPlugin, ChannelPluginFactory, ChannelContext } from '@littlesheep/plugins';
import { WebhookOptionsSchema, type WebhookOptions } from './options-schema.js';

/** Default port if not specified in options. */
const DEFAULT_PORT = 9876;

/** Max request body size (1 MB) — protects against memory exhaustion. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Webhook channel plugin — receives messages via HTTP POST on loopback.
 *
 * Security:
 *   - Listens on 127.0.0.1 only (no public network exposure)
 *   - Optional HMAC-SHA256 signature verification
 *   - Optional bearer token authorization
 *   - Body size limited to 1 MB
 */
export class WebhookChannelPlugin implements ChannelPlugin {
  readonly type = 'webhook';
  readonly displayName = 'Webhook';
  readonly requiredSecrets: string[] = [];
  readonly optionsSchema = WebhookOptionsSchema;

  private _running = false;
  private _ctx: ChannelContext | null = null;
  private _server: Server | null = null;
  private _options: WebhookOptions | null = null;
  private _abortListener: (() => void) | null = null;

  get running(): boolean {
    return this._running;
  }

  /** The actual address the server is listening on (null if not started).
   *  Useful when port=0 was used (OS assigns a free port). */
  get address(): { port: number; host: string } | null {
    if (!this._server) return null;
    const addr = this._server.address();
    if (addr && typeof addr === 'object') {
      return { port: addr.port, host: addr.address };
    }
    return null;
  }

  async start(ctx: ChannelContext): Promise<void> {
    if (this._running) {
      throw new Error('webhook channel: already running');
    }

    // Parse + validate options.
    const parsed = WebhookOptionsSchema.safeParse(ctx.config.options);
    if (!parsed.success) {
      throw new Error(
        `webhook channel: invalid options: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }
    this._options = parsed.data;
    this._ctx = ctx;

    const port = this._options.port ?? DEFAULT_PORT;
    const path = this._options.path ?? '/webhook';

    // Create HTTP server.
    this._server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        ctx.log('error', `webhook: unhandled error: ${(err as Error).message}`);
        this.sendJson(res, 500, { ok: false, error: 'internal server error' });
      });
    });

    // Listen on abort signal → stop the server.
    this._abortListener = () => {
      this.stop().catch((err) => {
        ctx.log('error', `webhook: stop-on-abort failed: ${(err as Error).message}`);
      });
    };
    ctx.signal.addEventListener('abort', this._abortListener, { once: true });

    // Start listening on loopback only.
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this._server = null;
        reject(new Error(`webhook channel: failed to listen on port ${port}: ${err.message}`));
      };
      this._server!.once('error', onError);
      this._server!.listen(port, '127.0.0.1', () => {
        this._server!.off('error', onError);
        // Read the actual port (may differ from requested when port=0).
        const actualPort = this.address?.port ?? port;
        ctx.log('info', `webhook: listening on http://127.0.0.1:${actualPort}${path}`);
        resolve();
      });
    });

    this._running = true;
  }

  async stop(): Promise<void> {
    if (!this._running && !this._server) return;

    // Remove abort listener.
    if (this._abortListener && this._ctx) {
      this._ctx.signal.removeEventListener('abort', this._abortListener);
      this._abortListener = null;
    }

    // Close the server (waits for in-flight connections to drain).
    if (this._server) {
      await new Promise<void>((resolve) => {
        this._server!.close(() => resolve());
      });
      this._server = null;
    }

    this._running = false;
    this._ctx?.log('info', 'webhook: stopped');
  }

  // ── Request handling ─────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = this._ctx!;
    const options = this._options!;
    const path = options.path ?? '/webhook';

    // Normalize URL (strip query string).
    const url = req.url ?? '/';
    const urlPath = url.split('?')[0]!;

    // Health check: GET to the webhook path.
    if (req.method === 'GET' && urlPath === path) {
      this.sendJson(res, 200, { ok: true, service: 'webhook-channel' });
      return;
    }

    // Only POST to the configured path is accepted.
    if (req.method !== 'POST' || urlPath !== path) {
      this.sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }

    // Read raw body.
    const body = await this.readBody(req);
    if (body === null) {
      this.sendJson(res, 413, { ok: false, error: 'request body too large' });
      return;
    }

    // Verify bearer token (if configured).
    if (options.bearerToken) {
      const authHeader = req.headers['authorization'];
      if (!this.verifyBearer(authHeader, options.bearerToken)) {
        ctx.log('warn', 'webhook: unauthorized (invalid bearer token)');
        this.sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
    }

    // Verify HMAC signature (if configured).
    if (options.hmacSecret) {
      const sigHeader = req.headers['x-signature-256'];
      if (!this.verifyHmac(body, sigHeader, options.hmacSecret)) {
        ctx.log('warn', 'webhook: invalid signature');
        this.sendJson(res, 401, { ok: false, error: 'invalid signature' });
        return;
      }
    }

    // Parse JSON body.
    let payload: WebhookPayload;
    try {
      payload = JSON.parse(body.toString('utf8')) as WebhookPayload;
    } catch {
      this.sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
      return;
    }

    // Validate required fields.
    if (typeof payload.text !== 'string' || payload.text.length === 0) {
      this.sendJson(res, 400, { ok: false, error: 'field "text" is required and must be non-empty' });
      return;
    }
    if (typeof payload.conversationId !== 'string' || typeof payload.userId !== 'string') {
      this.sendJson(res, 400, { ok: false, error: 'fields "conversationId" and "userId" are required' });
      return;
    }

    // Construct InboundChannelMessage.
    const message = {
      text: payload.text,
      requestKey: typeof payload.messageId === 'string' && payload.messageId.trim()
        ? `webhook:${payload.messageId.trim()}`
        : typeof req.headers['idempotency-key'] === 'string' && req.headers['idempotency-key'].trim()
          ? `webhook:${req.headers['idempotency-key'].trim()}`
          : undefined,
      externalConversationId: payload.conversationId,
      externalUserId: payload.userId,
      isGroup: payload.isGroup === true,
      userName: payload.userName,
      raw: payload,
    };

    // Resolve session + run agent.
    try {
      const sessionId = await ctx.resolveSession(
        message.externalConversationId,
        message.externalUserId,
      );
      const result = await ctx.runAgent(message, sessionId);

      if (result.ok) {
        ctx.log('info', `webhook: replied to ${message.externalUserId} (session ${sessionId})`);
      } else {
        ctx.log('warn', `webhook: agent error for ${message.externalUserId}: ${result.error}`);
      }

      this.sendJson(res, 200, {
        ok: result.ok,
        reply: result.reply,
        sessionId,
        error: result.error,
      });
    } catch (err) {
      ctx.log('error', `webhook: processing failed: ${(err as Error).message}`);
      this.sendJson(res, 500, { ok: false, error: 'processing failed' });
    }
  }

  /** Read the raw request body, enforcing a size limit. Returns null if too large. */
  private async readBody(req: IncomingMessage): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        return null; // too large
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** Verify HMAC-SHA256 signature in constant time. */
  private verifyHmac(body: Buffer, sigHeader: string | string[] | undefined, secret: string): boolean {
    if (typeof sigHeader !== 'string') return false;
    // Expected format: "sha256=<hex>"
    const match = /^sha256=([a-fA-F0-9]+)$/.exec(sigHeader);
    if (!match) return false;

    const expected = Buffer.from(match[1]!, 'hex');
    const computed = createHmac('sha256', secret).update(body).digest();

    if (expected.length !== computed.length) return false;
    return timingSafeEqual(expected, computed);
  }

  /** Verify bearer token in constant time. */
  private verifyBearer(authHeader: string | string[] | undefined, expected: string): boolean {
    if (typeof authHeader !== 'string') return false;
    const match = /^Bearer\s+(.+)$/.exec(authHeader);
    if (!match) return false;

    const provided = Buffer.from(match[1]!);
    const expectedBuf = Buffer.from(expected);
    if (provided.length !== expectedBuf.length) return false;
    return timingSafeEqual(provided, expectedBuf);
  }

  /** Send a JSON response. */
  private sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    res.end(json);
  }
}

/** Expected shape of the webhook POST body. */
interface WebhookPayload {
  text: string;
  messageId?: string;
  conversationId: string;
  userId: string;
  isGroup?: boolean;
  userName?: string;
}

/** Factory that creates a WebhookChannelPlugin instance. */
export const createWebhookPlugin: ChannelPluginFactory = () => new WebhookChannelPlugin();
