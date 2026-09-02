// @littlesheep/channel-qqbot — plugin.ts
// QqbotChannelPlugin: receives messages via QQ Bot WebSocket gateway.
//
// Uses QQ Bot's WebSocket mode — the bot connects to QQ's gateway server via
// WebSocket, receives events in real-time, and sends replies via HTTP API.
// No public callback URL is needed.
//
// No SDK dependency — uses plain fetch() for HTTP API calls and the built-in
// global WebSocket (Node.js 22+) for the gateway connection.
//
// Flow:
//   1. start(): get access_token → get gateway URL → connect WebSocket
//   2. WebSocket handshake:
//      - Receive op 10 (Hello) with heartbeat_interval
//      - Send op 2 (Identify) with token + intents
//      - Receive op 0 (Dispatch) t="READY" with session_id
//   3. Message loop:
//      - op 0 (Dispatch): handle events (READY, GROUP_AT_MESSAGE_CREATE, C2C_MESSAGE_CREATE)
//      - op 1 (Heartbeat request from server): send heartbeat immediately
//      - op 7 (Reconnect): close and reconnect
//      - op 9 (Invalid Session): re-identify
//      - op 11 (Heartbeat ACK): mark heartbeat acknowledged
//   4. Heartbeat: send op 1 every heartbeat_interval ms
//   5. For message events:
//      - Extract text from content (trim leading spaces from @bot mention)
//      - Call ctx.resolveSession() + ctx.runAgent()
//      - Send reply via HTTP API (with msg_id for passive reply)
//   6. stop(): abort in-flight requests, close WebSocket, clear heartbeat timer
//   7. Auto-reconnect with exponential backoff on WebSocket disconnect
//
// Security:
//   - App credentials (appid, appsecret) never logged
//   - All API calls use HTTPS
//   - Access token cached and refreshed before expiry

import {
  abortableDelay,
  type ChannelPlugin,
  type ChannelPluginFactory,
  type ChannelContext,
  type InboundChannelMessage,
} from '@littlesheep/plugins';
import { QqbotOptionsSchema, type QqbotOptions } from './options-schema.js';

// ── Secret names ────────────────────────────────────────────────────────

export const QQBOT_APPID_SECRET = 'QQBOT_APPID';
export const QQBOT_APPSECRET_SECRET = 'QQBOT_APPSECRET';

// ── WebSocket op codes ──────────────────────────────────────────────────

/** Server → Client: event dispatch (READY, MESSAGE_CREATE, etc.) */
const OP_DISPATCH = 0;
/** Client → Server: heartbeat | Server → Client: heartbeat request */
const OP_HEARTBEAT = 1;
/** Client → Server: initial authentication */
const OP_IDENTIFY = 2;
/** Server → Client: must reconnect */
const OP_RECONNECT = 7;
/** Server → Client: invalid session, must re-identify */
const OP_INVALID_SESSION = 9;
/** Server → Client: connection established, contains heartbeat_interval */
const OP_HELLO = 10;
/** Server → Client: heartbeat acknowledged */
const OP_HEARTBEAT_ACK = 11;

// ── Intents (bitmask) ───────────────────────────────────────────────────

/** Receive GROUP_AT_MESSAGE_CREATE events (group @bot messages). */
const INTENT_GROUP_AT_MESSAGE = 1 << 6; // 64
/** Receive C2C_MESSAGE_CREATE events (friend messages). */
const INTENT_C2C_MESSAGE = 1 << 25; // 33554432
/** Default intents: group + C2C messages. */
const DEFAULT_INTENTS = INTENT_GROUP_AT_MESSAGE | INTENT_C2C_MESSAGE;

// ── Connection timeout for WebSocket handshake (ms) ─────────────────────

const WS_CONNECT_TIMEOUT_MS = 30_000;

// ── Minimal QQ Bot API types ────────────────────────────────────────────

interface AccessTokenResponse {
  access_token: string;
  expires_in: number;
  /** Some API versions return expire_in (without 's'). */
  expire_in?: number;
}

interface GatewayResponse {
  url: string;
}

/** WebSocket message envelope from QQ Bot gateway. */
interface WsMessage {
  op: number;
  /** Sequence number (present in op 0 dispatch). */
  s?: number;
  /** Event type (present in op 0 dispatch). */
  t?: string;
  /** Event data. */
  d?: unknown;
}

/** Hello data (op 10). */
interface HelloData {
  heartbeat_interval: number;
}

/** READY event data (op 0, t="READY"). */
interface ReadyData {
  session_id: string;
  user?: {
    id: string;
    name?: string;
    avatar?: string;
  };
  version?: number;
}

/** GROUP_AT_MESSAGE_CREATE event data. */
interface GroupAtMessageData {
  id: string;
  content: string;
  group_open_id: string;
  author: {
    id?: string;
    member_openid?: string;
  };
  timestamp?: string;
}

/** C2C_MESSAGE_CREATE event data. */
interface C2cMessageData {
  id: string;
  content: string;
  author: {
    id?: string;
    user_openid?: string;
  };
  timestamp?: string;
}

/** Send message response. */
interface SendMessageResponse {
  id?: string;
  content?: string;
}

/** Error response from QQ Bot API. */
interface ApiErrorResponse {
  code: number;
  message: string;
  data?: unknown;
}

// ── Plugin ──────────────────────────────────────────────────────────────

/**
 * QQ Bot channel plugin — receives messages via WebSocket gateway.
 *
 * The bot connects to QQ's WebSocket gateway, authenticates with an access
 * token, and receives events in real-time. On disconnect, it automatically
 * reconnects with exponential backoff. The access token is cached and
 * refreshed before expiry.
 */
export class QqbotChannelPlugin implements ChannelPlugin {
  readonly type = 'qqbot';
  readonly displayName = 'QQ Bot';
  readonly requiredSecrets = [QQBOT_APPID_SECRET, QQBOT_APPSECRET_SECRET];
  readonly optionsSchema = QqbotOptionsSchema;

  private _running = false;
  private _ctx: ChannelContext | null = null;
  private _options: QqbotOptions | null = null;

  // Secrets
  private _appId = '';
  private _appSecret = '';

  // Token management
  private _accessToken: string | null = null;
  private _tokenExpiry = 0;

  // WebSocket + connection loop
  private _ws: WebSocket | null = null;
  private _internalAbort: AbortController | null = null;
  private _ctxSignalListener: (() => void) | null = null;
  private _connectLoopPromise: Promise<void> | null = null;

  // Heartbeat
  private _heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSeq: number | null = null;
  private _heartbeatAcked = true;

  get running(): boolean {
    return this._running;
  }

  async start(ctx: ChannelContext): Promise<void> {
    if (this._running) {
      throw new Error('qqbot channel: already running');
    }

    // Parse + validate options.
    const parsed = QqbotOptionsSchema.safeParse(ctx.config.options);
    if (!parsed.success) {
      throw new Error(
        `qqbot channel: invalid options: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }
    this._options = parsed.data;
    this._ctx = ctx;

    // Get required secrets.
    this._appId = ctx.config.secrets[QQBOT_APPID_SECRET] ?? '';
    this._appSecret = ctx.config.secrets[QQBOT_APPSECRET_SECRET] ?? '';
    if (!this._appId || !this._appSecret) {
      throw new Error(
        `qqbot channel: missing required secrets: ${QQBOT_APPID_SECRET} and/or ${QQBOT_APPSECRET_SECRET}`,
      );
    }

    // Set up internal abort controller linked to ctx.signal.
    this._internalAbort = new AbortController();
    this._ctxSignalListener = () => {
      this._internalAbort?.abort();
      this.stop().catch((err) => {
        ctx.log('error', `qqbot: stop-on-abort failed: ${(err as Error).message}`);
      });
    };
    ctx.signal.addEventListener('abort', this._ctxSignalListener, { once: true });

    // Get initial token (validates credentials).
    try {
      await this.getAccessToken();
      ctx.log('info', 'qqbot: authenticated successfully');
    } catch (err) {
      this._cleanupSignal();
      throw new Error(`qqbot channel: failed to get access_token: ${(err as Error).message}`);
    }

    // Start connection loop (async, not awaited).
    this._running = true;
    this._connectLoopPromise = this.connectLoop();
  }

  async stop(): Promise<void> {
    if (!this._running && !this._connectLoopPromise) return;

    // Abort in-flight requests.
    this._internalAbort?.abort();

    // Clear heartbeat timer.
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }

    // Close WebSocket if open.
    if (this._ws) {
      try {
        if (
          this._ws.readyState === WebSocket.OPEN ||
          this._ws.readyState === WebSocket.CONNECTING
        ) {
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
    this._ctx?.log('info', 'qqbot: stopped');
  }

  private _cleanupSignal(): void {
    if (this._ctxSignalListener && this._ctx) {
      this._ctx.signal.removeEventListener('abort', this._ctxSignalListener);
      this._ctxSignalListener = null;
    }
    this._internalAbort = null;
  }

  // ── Token management ──────────────────────────────────────────────────

  /** Get a valid access_token, refreshing if expired or about to expire. */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    const buffer = this._options!.tokenRefreshBufferMs;

    // Return cached token if still valid (with buffer).
    if (this._accessToken && now < this._tokenExpiry - buffer) {
      return this._accessToken;
    }

    const url = `${this._options!.authBase}/app/getAppAccessToken`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appid: this._appId, secret: this._appSecret }),
      signal: this._internalAbort!.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw new Error(`HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as AccessTokenResponse;
    if (!data.access_token) {
      throw new Error('response missing access_token');
    }

    // expire_in (without 's') is used by some API versions; prefer expires_in.
    const expireSeconds = data.expires_in ?? data.expire_in ?? 7200;

    this._accessToken = data.access_token;
    this._tokenExpiry = now + expireSeconds * 1000;
    return this._accessToken;
  }

  // ── WebSocket connection loop ─────────────────────────────────────────

  /** Main connection loop: get gateway → connect → handle → reconnect on close. */
  private async connectLoop(): Promise<void> {
    const signal = this._internalAbort!.signal;
    const ctx = this._ctx!;
    const options = this._options!;
    let reconnectDelay = options.reconnectDelayMs;

    while (!signal.aborted) {
      try {
        const token = await this.getAccessToken();
        const wsUrl = await this.getGatewayUrl(token);

        ctx.log('info', 'qqbot: connecting to WebSocket');
        await this.connectWebSocket(wsUrl, signal);

        // WebSocket closed normally — reset backoff.
        reconnectDelay = options.reconnectDelayMs;
      } catch (err) {
        if (signal.aborted) break;
        ctx.log('warn', `qqbot: connection error: ${(err as Error).message}`);
      }

      // Clear state before reconnecting.
      this._lastSeq = null;

      // Wait before reconnecting (exponential backoff).
      if (!signal.aborted) {
        ctx.log('info', `qqbot: reconnecting in ${reconnectDelay}ms`);
        await this.sleep(reconnectDelay, signal);
        reconnectDelay = Math.min(reconnectDelay * 2, options.reconnectMaxDelayMs);
      }
    }
  }

  /** Get the WebSocket gateway URL via HTTP API. */
  private async getGatewayUrl(token: string): Promise<string> {
    const url = `${this._options!.apiBase}/gateway`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `QQBot ${token}`,
      },
      signal: this._internalAbort!.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw new Error(`gateway HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as GatewayResponse;
    if (!data.url) {
      throw new Error('gateway response missing url');
    }

    return data.url;
  }

  /**
   * Connect to a WebSocket gateway and process messages until closed.
   * Resolves when the WebSocket closes (normally or due to error).
   */
  private connectWebSocket(wsUrl: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(wsUrl);
      this._ws = ws;
      this._heartbeatAcked = true;
      this._lastSeq = null;

      const onAbort = () => {
        try {
          ws.close(1000, 'aborted');
        } catch {
          // Ignore — already closing/closed.
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Connection timeout — if no Hello received, close and let reconnect loop retry.
      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ctx_log(this._ctx, 'warn', 'qqbot: WebSocket connection timeout');
          try {
            ws.close(1000, 'timeout');
          } catch {
            // Ignore.
          }
        }
      }, WS_CONNECT_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        ctx_log(this._ctx, 'info', 'qqbot: WebSocket connected');
      });

      ws.addEventListener('message', (event) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        this.handleWsMessage(data).catch((err) => {
          ctx_log(this._ctx, 'error', `qqbot: message handler error: ${(err as Error).message}`);
        });
      });

      ws.addEventListener('close', (event) => {
        clearTimeout(timeout);
        this._clearHeartbeat();
        signal.removeEventListener('abort', onAbort);
        this._ws = null;
        ctx_log(
          this._ctx,
          'info',
          `qqbot: WebSocket closed (code ${event.code}${event.reason ? ': ' + event.reason : ''})`,
        );
        resolve();
      });

      ws.addEventListener('error', () => {
        // Error is usually followed by close — don't resolve here.
        ctx_log(this._ctx, 'warn', 'qqbot: WebSocket error');
      });
    });
  }

  // ── WebSocket message handling ────────────────────────────────────────

  /** Parse and dispatch a WebSocket message by op code. */
  private async handleWsMessage(raw: string): Promise<void> {
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      ctx_log(this._ctx, 'warn', 'qqbot: received non-JSON WebSocket message');
      return;
    }

    switch (msg.op) {
      case OP_HELLO: {
        // Connection established — start heartbeat and send Identify.
        const hello = msg.d as HelloData | undefined;
        const interval = hello?.heartbeat_interval ?? 30000;
        this.startHeartbeat(interval);
        await this.sendIdentify();
        break;
      }

      case OP_DISPATCH: {
        // Track sequence number for heartbeats.
        if (typeof msg.s === 'number') {
          this._lastSeq = msg.s;
        }
        // Dispatch by event type.
        await this.handleDispatch(msg.t, msg.d);
        break;
      }

      case OP_HEARTBEAT: {
        // Server requested a heartbeat — send immediately.
        this.sendHeartbeat();
        break;
      }

      case OP_HEARTBEAT_ACK: {
        this._heartbeatAcked = true;
        break;
      }

      case OP_RECONNECT: {
        // Server requests reconnect — close the WebSocket.
        ctx_log(this._ctx, 'info', 'qqbot: server requested reconnect');
        try {
          this._ws?.close(4000, 'server requested reconnect');
        } catch {
          // Ignore.
        }
        break;
      }

      case OP_INVALID_SESSION: {
        // Session is invalid; always re-identify.
        ctx_log(this._ctx, 'warn', 'qqbot: invalid session, re-identifying');
        // The d field indicates whether resumable (boolean). We always re-identify.
        await this.sendIdentify();
        break;
      }

      default:
        ctx_log(this._ctx, 'info', `qqbot: unknown op code: ${msg.op}`);
    }
  }

  /** Handle a dispatch event by type. */
  private async handleDispatch(eventType: string | undefined, data: unknown): Promise<void> {
    switch (eventType) {
      case 'READY': {
        const ready = data as ReadyData | undefined;
        if (ready?.session_id) {
          ctx_log(
            this._ctx,
            'info',
            `qqbot: ready (session: ${ready.session_id}, bot: ${ready.user?.name ?? ready.user?.id ?? 'unknown'})`,
          );
        }
        break;
      }

      case 'RESUMED': {
        ctx_log(this._ctx, 'info', 'qqbot: session resumed');
        break;
      }

      case 'GROUP_AT_MESSAGE_CREATE': {
        await this.handleGroupAtMessage(data as GroupAtMessageData);
        break;
      }

      case 'C2C_MESSAGE_CREATE': {
        await this.handleC2cMessage(data as C2cMessageData);
        break;
      }

      default:
        // Silently ignore other event types (presence, typing, etc.)
        ctx_log(this._ctx, 'info', `qqbot: ignoring event type: ${eventType ?? 'unknown'}`);
    }
  }

  /** Process a group @ message event. */
  private async handleGroupAtMessage(data: GroupAtMessageData): Promise<void> {
    if (!data?.content || !data.group_open_id) return;

    // Trim leading spaces (from @bot mention stripping).
    const text = data.content.trim();
    if (!text) return;

    const messageId = data.id;
    const groupOpenId = data.group_open_id;
    const userId = data.author?.member_openid ?? data.author?.id ?? 'unknown';

    const inbound: InboundChannelMessage = {
      text,
      requestKey: `qqbot:${messageId}`,
      externalConversationId: groupOpenId,
      externalUserId: userId,
      isGroup: true,
      userName: userId,
      raw: data,
    };

    await this.processMessage(inbound, messageId, 'group', groupOpenId, userId);
  }

  /** Process a C2C (friend) message event. */
  private async handleC2cMessage(data: C2cMessageData): Promise<void> {
    if (!data?.content) return;

    const text = data.content.trim();
    if (!text) return;

    const messageId = data.id;
    const userOpenId = data.author?.user_openid ?? data.author?.id ?? 'unknown';

    const inbound: InboundChannelMessage = {
      text,
      requestKey: `qqbot:${messageId}`,
      externalConversationId: userOpenId,
      externalUserId: userOpenId,
      isGroup: false,
      userName: userOpenId,
      raw: data,
    };

    await this.processMessage(inbound, messageId, 'c2c', userOpenId, userOpenId);
  }

  /** Common message processing: resolve session → run agent → send reply. */
  private async processMessage(
    inbound: InboundChannelMessage,
    messageId: string,
    replyType: 'group' | 'c2c',
    targetId: string,
    userId: string,
  ): Promise<void> {
    try {
      const sessionId = await this._ctx!.resolveSession(
        inbound.externalConversationId,
        inbound.externalUserId,
      );
      const result = await this._ctx!.runAgent(inbound, sessionId);

      const replyText = result.ok
        ? result.finalReplySettlement
          ? result.finalReplySettlement.status === 'settled' ? result.finalReplySettlement.reply : ''
          : result.reply
        : `⚠️ Error: ${result.error ?? 'processing failed'}`;

      if (replyText && replyText.length > 0) {
        await this.sendReply(replyType, targetId, replyText, messageId);
      }

      ctx_log(
        this._ctx,
        result.ok ? 'info' : 'warn',
        `qqbot: ${result.ok ? 'replied to' : 'error for'} ${userId} in ${replyType} ${targetId}`,
      );
    } catch (err) {
      ctx_log(this._ctx, 'error', `qqbot: message handling failed: ${(err as Error).message}`);
      // Best-effort error notification.
      await this.sendReply(replyType, targetId, '⚠️ Sorry, something went wrong.', messageId).catch(
        () => {},
      );
    }
  }

  // ── Reply ─────────────────────────────────────────────────────────────

  /** Send a text reply, splitting if it exceeds the configured length. */
  private async sendReply(
    replyType: 'group' | 'c2c',
    targetId: string,
    text: string,
    messageId: string,
  ): Promise<void> {
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
      await this.sendQqbotMessage(replyType, targetId, chunk, messageId);
    }
  }

  /** Send a single text message via the QQ Bot HTTP API. */
  private async sendQqbotMessage(
    replyType: 'group' | 'c2c',
    targetId: string,
    text: string,
    msgId: string,
  ): Promise<void> {
    const token = await this.getAccessToken();
    const url =
      replyType === 'group'
        ? `${this._options!.apiBase}/v2/groups/${targetId}/messages`
        : `${this._options!.apiBase}/v2/users/${targetId}/messages`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({
        content: text,
        msg_type: 0, // 0 = text
        msg_id: msgId, // Required for passive replies
      }),
      signal: this._internalAbort!.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => 'unknown');
      throw new Error(`sendMessage HTTP ${res.status}: ${body}`);
    }

    const data = (await res.json()) as SendMessageResponse | ApiErrorResponse;
    // Check for API-level error (QQ Bot returns 200 with error body).
    if ('code' in data && typeof data.code === 'number' && data.code !== 0) {
      throw new Error(`sendMessage code ${data.code}: ${data.message}`);
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────

  /** Start the heartbeat timer with the server-specified interval. */
  private startHeartbeat(intervalMs: number): void {
    this._clearHeartbeat();
    // Send heartbeats slightly before the deadline to avoid disconnections.
    const buffer = this._options!.heartbeatIntervalBufferMs;
    const delay = Math.max(1000, intervalMs - buffer);
    this._heartbeatAcked = true;

    const tick = () => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
      if (!this._heartbeatAcked) {
        // Last heartbeat wasn't ACKed — connection may be stale, close it.
        ctx_log(this._ctx, 'warn', 'qqbot: heartbeat not ACKed, closing connection');
        try {
          this._ws.close(4001, 'heartbeat timeout');
        } catch {
          // Ignore.
        }
        return;
      }
      this._heartbeatAcked = false;
      this.sendHeartbeat();
    };

    this._heartbeatTimer = setInterval(tick, delay);
  }

  /** Clear the heartbeat timer. */
  private _clearHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── WebSocket send helpers ────────────────────────────────────────────

  /** Send an Identify payload to authenticate the WebSocket connection. */
  private async sendIdentify(): Promise<void> {
    const token = await this.getAccessToken();
    this._sendWs({
      op: OP_IDENTIFY,
      d: {
        token: `QQBot ${token}`,
        intents: DEFAULT_INTENTS,
        shard: [0, 1],
      },
    });
    ctx_log(this._ctx, 'info', 'qqbot: sent Identify');
  }

  /** Send a heartbeat with the last received sequence number. */
  private sendHeartbeat(): void {
    this._sendWs({
      op: OP_HEARTBEAT,
      d: this._lastSeq,
    });
  }

  /** Send a JSON message through the WebSocket (no-op if not open). */
  private _sendWs(msg: WsMessage): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────

  /** Abortable sleep — resolves early if signal fires. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return abortableDelay(ms, signal);
  }
}

/** Factory that creates a QqbotChannelPlugin instance. */
export const createQqbotPlugin: ChannelPluginFactory = () => new QqbotChannelPlugin();

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
