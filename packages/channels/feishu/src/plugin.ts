// @littlesheep/channel-feishu — plugin.ts
// FeishuChannelPlugin: receives messages via Feishu long connection (WebSocket).
//
// Uses Feishu's "长连接" (long connection) mode — the bot connects to Feishu's
// server via WebSocket, and Feishu pushes events through the connection.
// No public callback URL is needed (unlike HTTP event subscription).
//
// No SDK dependency — uses plain fetch() for HTTP API calls and the built-in
// global WebSocket (Node.js 22+) for the long connection.
//
// Flow:
//   1. start(): get tenant_access_token → register WS endpoint → connect WebSocket
//   2. WebSocket message loop:
//      - "endpoint.ready" → connection established
//      - "ping" → respond with "pong"
//      - "event" → ack → decrypt (if encrypted) → verify token → process
//   3. For im.message.receive_v1 events:
//      - Extract text from message content
//      - Call ctx.resolveSession() + ctx.runAgent()
//      - Send reply via im/v1/messages API
//   4. stop(): abort in-flight requests, close WebSocket, wait for loop exit
//   5. Auto-reconnect with exponential backoff on WebSocket disconnect
//
// Security:
//   - App credentials (app_id, app_secret) never logged
//   - Optional event encryption (AES-256-CBC with encrypt_key)
//   - Optional verification_token check
//   - All API calls use HTTPS

import { createHash, createDecipheriv } from 'node:crypto';
import { abortableDelay, type ChannelPlugin, type ChannelPluginFactory, type ChannelContext } from '@littlesheep/plugins';
import { FeishuOptionsSchema, type FeishuOptions } from './options-schema.js';

// ── Secret names ────────────────────────────────────────────────────────

export const FEISHU_APP_ID_SECRET = 'FEISHU_APP_ID';
export const FEISHU_APP_SECRET_SECRET = 'FEISHU_APP_SECRET';
export const FEISHU_VERIFICATION_TOKEN_SECRET = 'FEISHU_VERIFICATION_TOKEN';
export const FEISHU_ENCRYPT_KEY_SECRET = 'FEISHU_ENCRYPT_KEY';

// ── Connection timeout for WebSocket handshake (ms) ─────────────────────

const WS_CONNECT_TIMEOUT_MS = 30_000;

// ── Minimal Feishu API types (only what we use) ─────────────────────────

interface FeishuApiResponse {
  code: number;
  msg: string;
  data?: unknown;
}

interface FeishuTokenResponse extends FeishuApiResponse {
  tenant_access_token: string;
  expire: number;
}

interface FeishuRegisterResponse extends FeishuApiResponse {
  data: {
    endpoint: string;
    register_id: string;
    expire_at: number;
  };
}

/** WebSocket message envelope from Feishu. */
interface FeishuWsMessage {
  type: string;
  data: unknown;
}

/** Event data — may be encrypted (encrypt field) or direct. */
interface FeishuEventData {
  event_id?: string;
  event_type?: string;
  token?: string;
  event?: FeishuMessageEvent;
  encrypt?: string;
}

/** im.message.receive_v1 event payload. */
interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type?: string;
  };
  message: {
    message_id: string;
    create_time?: string;
    chat_id: string;
    chat_type?: 'p2p' | 'group';
    message_type?: string;
    content?: string;
  };
}

// ── Plugin ──────────────────────────────────────────────────────────────

/**
 * Feishu channel plugin — receives messages via long connection (WebSocket).
 *
 * The bot connects to Feishu's WebSocket endpoint and receives events in
 * real-time. On disconnect, it automatically reconnects with exponential
 * backoff. The tenant_access_token is cached and refreshed before expiry.
 */
export class FeishuChannelPlugin implements ChannelPlugin {
  readonly type = 'feishu';
  readonly displayName = '飞书';
  readonly requiredSecrets = [FEISHU_APP_ID_SECRET, FEISHU_APP_SECRET_SECRET];
  readonly optionsSchema = FeishuOptionsSchema;

  private _running = false;
  private _ctx: ChannelContext | null = null;
  private _options: FeishuOptions | null = null;

  // Secrets
  private _appId = '';
  private _appSecret = '';
  private _verificationToken: string | null = null;
  private _encryptKey: string | null = null;

  // Token management
  private _tenantAccessToken: string | null = null;
  private _tokenExpiry = 0;

  // WebSocket + connection loop
  private _ws: WebSocket | null = null;
  private _internalAbort: AbortController | null = null;
  private _ctxSignalListener: (() => void) | null = null;
  private _connectLoopPromise: Promise<void> | null = null;

  get running(): boolean {
    return this._running;
  }

  async start(ctx: ChannelContext): Promise<void> {
    if (this._running) {
      throw new Error('feishu channel: already running');
    }

    // Parse + validate options.
    const parsed = FeishuOptionsSchema.safeParse(ctx.config.options);
    if (!parsed.success) {
      throw new Error(
        `feishu channel: invalid options: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }
    this._options = parsed.data;
    this._ctx = ctx;

    // Get required secrets.
    this._appId = ctx.config.secrets[FEISHU_APP_ID_SECRET] ?? '';
    this._appSecret = ctx.config.secrets[FEISHU_APP_SECRET_SECRET] ?? '';
    if (!this._appId || !this._appSecret) {
      throw new Error(
        `feishu channel: missing required secrets: ${FEISHU_APP_ID_SECRET} and/or ${FEISHU_APP_SECRET_SECRET}`,
      );
    }

    // Optional secrets.
    this._verificationToken = ctx.config.secrets[FEISHU_VERIFICATION_TOKEN_SECRET] || null;
    this._encryptKey = ctx.config.secrets[FEISHU_ENCRYPT_KEY_SECRET] || null;

    // Set up internal abort controller linked to ctx.signal.
    this._internalAbort = new AbortController();
    this._ctxSignalListener = () => {
      this._internalAbort?.abort();
      this.stop().catch((err) => {
        ctx.log('error', `feishu: stop-on-abort failed: ${(err as Error).message}`);
      });
    };
    ctx.signal.addEventListener('abort', this._ctxSignalListener, { once: true });

    // Get initial token (validates credentials).
    try {
      await this.getTenantAccessToken();
      ctx.log('info', 'feishu: authenticated successfully');
    } catch (err) {
      this._cleanupSignal();
      throw new Error(`feishu channel: failed to get tenant_access_token: ${(err as Error).message}`);
    }

    // Start connection loop (async, not awaited).
    this._running = true;
    this._connectLoopPromise = this.connectLoop();
  }

  async stop(): Promise<void> {
    if (!this._running && !this._connectLoopPromise) return;

    // Abort in-flight requests.
    this._internalAbort?.abort();

    // Close WebSocket if open.
    if (this._ws) {
      try {
        if (this._ws.readyState === WebSocket.OPEN) {
          this._ws.close(1000, 'shutdown');
        } else if (this._ws.readyState === WebSocket.CONNECTING) {
          this._ws.close(1000, 'shutdown');
        }
      } catch {
        // Ignore close errors — we're shutting down anyway.
      }
    }

    // Wait for connect loop to finish.
    if (this._connectLoopPromise) {
      await this._connectLoopPromise.catch(() => {});
      this._connectLoopPromise = null;
    }

    this._cleanupSignal();
    this._ws = null;
    this._running = false;
    this._ctx?.log('info', 'feishu: stopped');
  }

  private _cleanupSignal(): void {
    if (this._ctxSignalListener && this._ctx) {
      this._ctx.signal.removeEventListener('abort', this._ctxSignalListener);
      this._ctxSignalListener = null;
    }
    this._internalAbort = null;
  }

  // ── Token management ──────────────────────────────────────────────────

  /** Get a valid tenant_access_token, refreshing if expired or about to expire. */
  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    const buffer = this._options!.tokenRefreshBufferMs;

    // Return cached token if still valid (with buffer).
    if (this._tenantAccessToken && now < this._tokenExpiry - buffer) {
      return this._tenantAccessToken;
    }

    const url = `${this._options!.apiBase}/open-apis/auth/v3/tenant_access_token/internal`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this._appId, app_secret: this._appSecret }),
      signal: this._internalAbort!.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw new Error(`HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as FeishuTokenResponse;
    if (data.code !== 0) {
      throw new Error(`code ${data.code}: ${data.msg}`);
    }

    this._tenantAccessToken = data.tenant_access_token;
    this._tokenExpiry = now + data.expire * 1000;
    return this._tenantAccessToken;
  }

  // ── WebSocket connection loop ─────────────────────────────────────────

  /** Main connection loop: register → connect → handle → reconnect on close. */
  private async connectLoop(): Promise<void> {
    const signal = this._internalAbort!.signal;
    const ctx = this._ctx!;
    const options = this._options!;
    let reconnectDelay = options.reconnectDelayMs;

    while (!signal.aborted) {
      try {
        const token = await this.getTenantAccessToken();
        const wsUrl = await this.registerEndpoint(token);

        ctx.log('info', 'feishu: connecting to WebSocket');
        await this.connectWebSocket(wsUrl, signal);

        // WebSocket closed normally — reset backoff.
        reconnectDelay = options.reconnectDelayMs;
      } catch (err) {
        if (signal.aborted) break;
        ctx.log('warn', `feishu: connection error: ${(err as Error).message}`);
      }

      // Wait before reconnecting (exponential backoff).
      if (!signal.aborted) {
        ctx.log('info', `feishu: reconnecting in ${reconnectDelay}ms`);
        await this.sleep(reconnectDelay, signal);
        reconnectDelay = Math.min(reconnectDelay * 2, options.reconnectMaxDelayMs);
      }
    }
  }

  /** Register a WebSocket endpoint via HTTP API. Returns the WSS URL. */
  private async registerEndpoint(token: string): Promise<string> {
    const url = `${this._options!.apiBase}/callback/ws/endpoint.register`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ app_id: this._appId }),
      signal: this._internalAbort!.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw new Error(`register endpoint HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as FeishuRegisterResponse;
    if (data.code !== 0) {
      throw new Error(`register endpoint code ${data.code}: ${data.msg}`);
    }

    return data.data.endpoint;
  }

  /**
   * Connect to a WebSocket endpoint and process messages until closed.
   * Resolves when the WebSocket closes (normally or due to error).
   */
  private connectWebSocket(wsUrl: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl);
      this._ws = ws;

      const onAbort = () => {
        try {
          ws.close(1000, 'aborted');
        } catch {
          // Ignore — already closing/closed.
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Connection timeout — if no open event, close and let reconnect loop retry.
      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ctx_log(this._ctx, 'warn', 'feishu: WebSocket connection timeout');
          try {
            ws.close(1000, 'timeout');
          } catch {
            // Ignore.
          }
        }
      }, WS_CONNECT_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        ctx_log(this._ctx, 'info', 'feishu: WebSocket connected');
      });

      ws.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        this.handleWsMessage(data).catch((err) => {
          ctx_log(this._ctx, 'error', `feishu: message handler error: ${(err as Error).message}`);
        });
      });

      ws.addEventListener('close', (event) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        this._ws = null;
        ctx_log(
          this._ctx,
          'info',
          `feishu: WebSocket closed (code ${event.code}${event.reason ? ': ' + event.reason : ''})`,
        );
        resolve();
      });

      ws.addEventListener('error', () => {
        // Error is usually followed by close — don't resolve here.
        ctx_log(this._ctx, 'warn', 'feishu: WebSocket error');
      });
    });
  }

  // ── WebSocket message handling ────────────────────────────────────────

  /** Parse and dispatch a WebSocket message by type. */
  private async handleWsMessage(raw: string): Promise<void> {
    let msg: FeishuWsMessage;
    try {
      msg = JSON.parse(raw) as FeishuWsMessage;
    } catch {
      ctx_log(this._ctx, 'warn', 'feishu: received non-JSON WebSocket message');
      return;
    }

    // Handle fully-encrypted messages (entire payload is encrypted, no type field).
    const maybeEncrypted = msg as unknown as { encrypt?: string };
    if (this._encryptKey && typeof maybeEncrypted.encrypt === 'string') {
      try {
        const decrypted = this.decryptPayload(maybeEncrypted.encrypt);
        msg = JSON.parse(decrypted) as FeishuWsMessage;
      } catch (err) {
        ctx_log(this._ctx, 'error', `feishu: failed to decrypt message: ${(err as Error).message}`);
        return;
      }
    }

    switch (msg.type) {
      case 'endpoint.ready':
        ctx_log(this._ctx, 'info', 'feishu: endpoint ready');
        break;

      case 'ping': {
        // Respond with pong, echoing the timestamp.
        const ts = (msg.data as { ts?: number })?.ts;
        this.sendWsMessage({ type: 'pong', data: { ts: ts ?? Date.now() } });
        break;
      }

      case 'event': {
        let payload = msg.data as FeishuEventData;

        // If event data is encrypted, decrypt first (need event_id for ack).
        if (this._encryptKey && payload.encrypt) {
          try {
            const decrypted = this.decryptPayload(payload.encrypt);
            payload = JSON.parse(decrypted) as FeishuEventData;
          } catch (err) {
            ctx_log(this._ctx, 'error', `feishu: failed to decrypt event: ${(err as Error).message}`);
            return;
          }
        }

        // Ack the event immediately (Feishu expects ack within 3s).
        if (payload.event_id) {
          this.sendWsMessage({
            type: 'event_ack',
            data: { event_id: payload.event_id },
          });
        }

        // Handle the event (fire-and-forget — don't block the message loop).
        this.handleEventPayload(payload).catch((err) => {
          ctx_log(this._ctx, 'error', `feishu: event handler error: ${(err as Error).message}`);
        });
        break;
      }

      default:
        ctx_log(this._ctx, 'info', `feishu: unknown message type: ${msg.type}`);
    }
  }

  /** Process a decrypted event payload — verify token, extract message, run agent. */
  private async handleEventPayload(payload: FeishuEventData): Promise<void> {
    // Verify token (if verification_token is configured).
    if (this._verificationToken && payload.token !== this._verificationToken) {
      ctx_log(this._ctx, 'warn', 'feishu: event token verification failed, skipping');
      return;
    }

    // Only handle text messages.
    if (payload.event_type !== 'im.message.receive_v1') {
      ctx_log(this._ctx, 'info', `feishu: skipping event type: ${payload.event_type ?? 'unknown'}`);
      return;
    }

    const event = payload.event;
    if (!event?.message) return;

    // Skip non-text messages (images, files, etc.).
    if (event.message.message_type !== 'text') {
      ctx_log(
        this._ctx,
        'info',
        `feishu: skipping non-text message (type: ${event.message.message_type ?? 'unknown'})`,
      );
      return;
    }

    // Parse message content: {"text": "hello world"}.
    let text: string;
    try {
      const content = JSON.parse(event.message.content ?? '{}') as { text?: string };
      text = content.text ?? '';
    } catch {
      ctx_log(this._ctx, 'warn', 'feishu: failed to parse message content');
      return;
    }

    if (!text) return;

    // Construct InboundChannelMessage.
    const chatId = event.message.chat_id;
    const isGroup = event.message.chat_type === 'group';
    const openId = event.sender?.sender_id?.open_id ?? 'unknown';

    const inbound = {
      text,
      requestKey: `feishu:${event.message.message_id}`,
      externalConversationId: chatId,
      externalUserId: openId,
      isGroup,
      userName: openId,
      raw: event,
    };

    // Resolve session + run agent.
    try {
      const sessionId = await this._ctx!.resolveSession(
        inbound.externalConversationId,
        inbound.externalUserId,
      );
      const result = await this._ctx!.runAgent(inbound, sessionId);

      const replyText = result.ok
        ? result.reply
        : `⚠️ Error: ${result.error ?? 'processing failed'}`;

      if (replyText && replyText.length > 0) {
        await this.sendReply(chatId, replyText);
      }

      ctx_log(
        this._ctx,
        result.ok ? 'info' : 'warn',
        `feishu: ${result.ok ? 'replied to' : 'error for'} ${openId} in chat ${chatId}`,
      );
    } catch (err) {
      ctx_log(this._ctx, 'error', `feishu: message handling failed: ${(err as Error).message}`);
      // Best-effort error notification.
      await this.sendReply(chatId, '⚠️ Sorry, something went wrong.').catch(() => {});
    }
  }

  // ── Reply ─────────────────────────────────────────────────────────────

  /** Send a text reply, splitting if it exceeds the configured length. */
  private async sendReply(chatId: string, text: string): Promise<void> {
    const splitLength = this._options!.messageSplitLength;
    const chunks: string[] = [];

    if (text.length <= splitLength) {
      chunks.push(text);
    } else {
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, splitLength));
        remaining = remaining.slice(splitLength);
      }
    }

    for (const chunk of chunks) {
      await this.sendFeishuMessage(chatId, chunk);
    }
  }

  /** Send a single text message via the im/v1/messages API. */
  private async sendFeishuMessage(chatId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const url = `${this._options!.apiBase}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
      signal: this._internalAbort!.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw new Error(`sendMessage HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as FeishuApiResponse;
    if (data.code !== 0) {
      throw new Error(`sendMessage code ${data.code}: ${data.msg}`);
    }
  }

  // ── Encryption ────────────────────────────────────────────────────────

  /**
   * Decrypt an encrypted event payload using AES-256-CBC.
   * Key: SHA256(encrypt_key). IV: first 16 bytes of ciphertext.
   */
  private decryptPayload(encrypt: string): string {
    const key = createHash('sha256').update(this._encryptKey!).digest();
    const encrypted = Buffer.from(encrypt, 'base64');
    const iv = encrypted.subarray(0, 16);
    const ciphertext = encrypted.subarray(16);

    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }

  // ── Utilities ─────────────────────────────────────────────────────────

  /** Send a JSON message through the WebSocket (no-op if not open). */
  private sendWsMessage(msg: FeishuWsMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  /** Abortable sleep — resolves early if signal fires. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return abortableDelay(ms, signal);
  }
}

/** Factory that creates a FeishuChannelPlugin instance. */
export const createFeishuPlugin: ChannelPluginFactory = () => new FeishuChannelPlugin();

// ── Helper: safe logging (handles null ctx during shutdown) ──────────────

function ctx_log(
  ctx: ChannelContext | null,
  level: 'info' | 'warn' | 'error',
  message: string,
): void {
  if (ctx) {
    ctx.log(level, message);
  }
}
