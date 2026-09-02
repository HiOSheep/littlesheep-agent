// @littlesheep/channel-telegram — plugin.ts
// TelegramChannelPlugin: receives messages via Telegram Bot API long polling.
//
// No SDK dependency — uses plain fetch() calls to the Telegram Bot API.
// The bot token is provided via ChannelConfig.secrets.TELEGRAM_BOT_TOKEN.
//
// Flow:
//   1. start(): verify token via getMe, start getUpdates long-polling loop
//   2. For each incoming text message:
//      - Construct InboundChannelMessage (externalConversationId = chat.id)
//      - Call ctx.resolveSession() + ctx.runAgent()
//      - Send reply via sendMessage API
//   3. stop(): abort in-flight requests, wait for loop to exit
//
// Security:
//   - Bot token never logged
//   - All API calls use HTTPS
//   - Long polling respects abort signal (clean shutdown)

import { abortableDelay, type ChannelPlugin, type ChannelPluginFactory, type ChannelContext } from '@littlesheep/plugins';
import { TelegramOptionsSchema, type TelegramOptions } from './options-schema.js';

/** Secret name for the bot token (must be in ChannelConfig.secrets). */
export const TELEGRAM_BOT_TOKEN_SECRET = 'TELEGRAM_BOT_TOKEN';

/** Telegram message length limit (characters). */
const MAX_MESSAGE_LENGTH = 4096;

// ── Minimal Telegram API types (only what we use) ───────────────────────

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramBot {
  id: number;
  username: string;
  first_name: string;
}

interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

// ── Plugin ──────────────────────────────────────────────────────────────

/**
 * Telegram channel plugin — receives messages via Bot API long polling.
 *
 * Uses `getUpdates` with a `timeout` parameter for efficient long polling.
 * The polling loop runs asynchronously after start() returns. On stop(),
 * in-flight HTTP requests are aborted via an internal AbortController.
 */
export class TelegramChannelPlugin implements ChannelPlugin {
  readonly type = 'telegram';
  readonly displayName = 'Telegram';
  readonly requiredSecrets = [TELEGRAM_BOT_TOKEN_SECRET];
  readonly optionsSchema = TelegramOptionsSchema;

  private _running = false;
  private _ctx: ChannelContext | null = null;
  private _options: TelegramOptions | null = null;
  private _token: string | null = null;
  private _botInfo: TelegramBot | null = null;
  private _offset = 0;

  /** Internal abort controller — linked to ctx.signal, used for fetch calls. */
  private _internalAbort: AbortController | null = null;
  private _ctxSignalListener: (() => void) | null = null;

  /** The polling loop promise (awaited in stop()). */
  private _pollPromise: Promise<void> | null = null;

  get running(): boolean {
    return this._running;
  }

  /** Bot info from getMe (available after start). */
  get botInfo(): TelegramBot | null {
    return this._botInfo;
  }

  async start(ctx: ChannelContext): Promise<void> {
    if (this._running) {
      throw new Error('telegram channel: already running');
    }

    // Parse + validate options.
    const parsed = TelegramOptionsSchema.safeParse(ctx.config.options);
    if (!parsed.success) {
      throw new Error(
        `telegram channel: invalid options: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      );
    }
    this._options = parsed.data;
    this._ctx = ctx;

    // Get bot token from secrets.
    this._token = ctx.config.secrets[TELEGRAM_BOT_TOKEN_SECRET] ?? '';
    if (!this._token) {
      throw new Error(
        `telegram channel: missing required secret: ${TELEGRAM_BOT_TOKEN_SECRET}`,
      );
    }

    // Set up internal abort controller linked to ctx.signal.
    this._internalAbort = new AbortController();
    this._ctxSignalListener = () => {
      this._internalAbort?.abort();
      // Also run full stop() to clean up running state (fire-and-forget).
      this.stop().catch((err) => {
        ctx.log('error', `telegram: stop-on-abort failed: ${(err as Error).message}`);
      });
    };
    ctx.signal.addEventListener('abort', this._ctxSignalListener, { once: true });

    // Verify bot token via getMe.
    try {
      this._botInfo = await this.callApi<TelegramBot>('getMe', {}, this._internalAbort.signal);
      ctx.log('info', `telegram: connected as @${this._botInfo.username} (${this._botInfo.first_name})`);
    } catch (err) {
      this._cleanupSignal();
      throw new Error(`telegram channel: getMe failed: ${(err as Error).message}`);
    }

    // Start polling loop (async, not awaited).
    this._running = true;
    this._pollPromise = this.pollLoop();
  }

  async stop(): Promise<void> {
    if (!this._running && !this._pollPromise) return;

    // Abort in-flight requests.
    this._internalAbort?.abort();

    // Wait for polling loop to finish (tolerate abort errors).
    if (this._pollPromise) {
      await this._pollPromise.catch(() => {});
      this._pollPromise = null;
    }

    this._cleanupSignal();
    this._running = false;
    this._ctx?.log('info', 'telegram: stopped');
  }

  private _cleanupSignal(): void {
    if (this._ctxSignalListener && this._ctx) {
      this._ctx.signal.removeEventListener('abort', this._ctxSignalListener);
      this._ctxSignalListener = null;
    }
    this._internalAbort = null;
  }

  // ── Polling loop ──────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    const signal = this._internalAbort!.signal;
    const options = this._options!;
    const ctx = this._ctx!;

    while (!signal.aborted) {
      try {
        const updates = await this.callApi<TelegramUpdate[]>('getUpdates', {
          offset: this._offset,
          timeout: options.pollingTimeout,
          allowed_updates: options.allowedUpdates,
        }, signal);

        for (const update of updates) {
          if (signal.aborted) break;
          // Advance offset to acknowledge this update.
          this._offset = update.update_id + 1;
          // Handle update (fire-and-forget — don't block the poll loop).
          this.handleUpdate(update).catch((err) => {
            ctx.log('error', `telegram: handleUpdate error: ${(err as Error).message}`);
          });
        }

        // Small delay between polls (prevents tight loops when pollingTimeout=0).
        if (options.pollIntervalMs > 0 && !signal.aborted) {
          await this.sleep(options.pollIntervalMs, signal);
        }
      } catch (err) {
        if (signal.aborted) break;
        ctx.log('warn', `telegram: poll error: ${(err as Error).message}`);
        await this.sleep(options.errorBackoffMs, signal);
      }
    }
  }

  /** Handle a single Telegram update — extract message, run agent, send reply. */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const ctx = this._ctx!;
    const message = update.message ?? update.edited_message;

    // Skip updates without a message.
    if (!message) return;

    // Skip non-text messages (stickers, photos, etc.) — log and ignore.
    if (typeof message.text !== 'string') {
      ctx.log('info', `telegram: skipping non-text message from chat ${message.chat.id}`);
      return;
    }

    // Determine if this is a group or DM.
    const isGroup = message.chat.type !== 'private';

    // Construct InboundChannelMessage.
    const inbound = {
      text: message.text,
      requestKey: `telegram:${message.message_id}`,
      // Use chat.id as conversation id — same chat = same session.
      externalConversationId: String(message.chat.id),
      externalUserId: String(message.from?.id ?? 'unknown'),
      isGroup,
      userName: message.from?.username ?? message.from?.first_name,
      raw: message,
    };

    // Send typing indicator (best-effort, don't block on failure).
    if (this._options!.sendTypingAction) {
      this.callApi('sendChatAction', {
        chat_id: message.chat.id,
        action: 'typing',
      }, this._internalAbort!.signal).catch(() => {});
    }

    // Resolve session + run agent.
    try {
      const sessionId = await ctx.resolveSession(
        inbound.externalConversationId,
        inbound.externalUserId,
      );
      const result = await ctx.runAgent(inbound, sessionId);

      // Send reply.
      const replyText = result.ok
        ? result.finalReplySettlement
          ? result.finalReplySettlement.status === 'settled' ? result.finalReplySettlement.reply : ''
          : result.reply
        : `⚠️ Error: ${result.error ?? 'processing failed'}`;

      if (replyText && replyText.length > 0) {
        await this.sendReply(message.chat.id, replyText);
      }

      ctx.log(
        result.ok ? 'info' : 'warn',
        `telegram: ${result.ok ? 'replied to' : 'error for'} ${inbound.externalUserId} in chat ${message.chat.id}`,
      );
    } catch (err) {
      ctx.log('error', `telegram: message handling failed: ${(err as Error).message}`);
      // Best-effort error notification to the user.
      await this.sendReply(message.chat.id, '⚠️ Sorry, something went wrong.').catch(() => {});
    }
  }

  /** Send a text reply, splitting if it exceeds Telegram's 4096 char limit. */
  private async sendReply(chatId: number, text: string): Promise<void> {
    const signal = this._internalAbort!.signal;

    if (text.length <= MAX_MESSAGE_LENGTH) {
      await this.callApi('sendMessage', { chat_id: chatId, text }, signal);
      return;
    }

    // Split into chunks of MAX_MESSAGE_LENGTH.
    let remaining = text;
    let part = 1;
    while (remaining.length > 0 && !signal.aborted) {
      const chunk = remaining.slice(0, MAX_MESSAGE_LENGTH);
      remaining = remaining.slice(MAX_MESSAGE_LENGTH);
      await this.callApi('sendMessage', { chat_id: chatId, text: chunk }, signal);
      part++;
    }
  }

  // ── Telegram API client ───────────────────────────────────────────────

  /** Call a Telegram Bot API method. Throws on HTTP error or API error. */
  private async callApi<T>(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<T> {
    const url = `${this._options!.apiBase}/bot${this._token}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => 'unknown');
      throw new Error(`Telegram API ${method} HTTP ${res.status}: ${errorBody}`);
    }

    const data = (await res.json()) as TelegramResponse<T>;
    if (!data.ok || data.result === undefined) {
      throw new Error(`Telegram API ${method} error: ${data.description ?? 'unknown'}`);
    }

    return data.result;
  }

  /** Abortable sleep — resolves early if signal fires. */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return abortableDelay(ms, signal);
  }
}

/** Factory that creates a TelegramChannelPlugin instance. */
export const createTelegramPlugin: ChannelPluginFactory = () => new TelegramChannelPlugin();
