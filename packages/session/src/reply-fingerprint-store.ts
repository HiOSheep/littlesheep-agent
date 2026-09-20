// Session-scoped published-reply text index and final-settlement registry with
// restart-safe atomic persistence. Settlement identity is the gate; the text
// index records what was published and still backs the legacy text-only callers.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FinalReplyReservation, Message, SessionId } from '@littlesheep/types';
import { normalizeUserFacingReply } from '@littlesheep/types';
import { acquireLock } from './lock.js';
import { atomicWriteText } from './atomic-file.js';

const REGISTRY_VERSION = 1;
const REGISTRY_HEADER = JSON.stringify({
  type: 'littlesheep.reply-fingerprint-registry',
  version: REGISTRY_VERSION,
});

const SETTLEMENT_REGISTRY_VERSION = 1 as const;
const SETTLEMENT_REGISTRY_FILE = (registry: string): string => `${registry}.settlements.json`;

interface SettlementRecord extends FinalReplyReservation {
  status: 'reserved' | 'settled';
  createdAt: string;
  settledAt?: string;
}

interface SettlementRegistry {
  type: 'littlesheep.reply-settlement-registry';
  version: typeof SETTLEMENT_REGISTRY_VERSION;
  records: SettlementRecord[];
}

export class ReplyFingerprintStore {
  constructor(
    private readonly sessionsDir: string,
    private readonly lockTimeoutMs: number,
  ) {}

  /**
   * Atomically record a normalized reply fingerprint for one session.
   * Returns false when the same visible text is already recorded; callers that
   * allow a repeat treat that as "already published", not as a failure.
   */
  async reserve(sessionId: SessionId, reply: string): Promise<boolean> {
    const normalized = normalizeUserFacingReply(reply);
    if (!normalized) return false;

    const registry = this.registryFile(sessionId);
    await mkdir(dirname(registry), { recursive: true });
    const handle = await acquireLock(registry, this.lockTimeoutMs);
    try {
      if (!existsSync(registry)) {
        await this.initializeFromTranscript(sessionId, registry);
      }
      const fingerprint = hashReply(normalized);
      if (await containsFingerprint(registry, fingerprint)) return false;
      await appendFile(registry, `${fingerprint}\n`, 'utf8');
      return true;
    } finally {
      await handle.release();
    }
  }

  /**
   * Reserve a reply under the identity shared by FINALIZE and durable replay.
   * Identity, not wording, is what is enforced: the same settlement is
   * idempotent across restarts and replay, while a different settlement may
   * publish the same visible text (repeating an earlier turn's wording is
   * allowed). The text index keeps one hashed line per published reply for
   * audit and for the legacy text-only reserve() callers.
   */
  async reserveSettlement(sessionId: SessionId, reservation: FinalReplyReservation): Promise<boolean> {
    validateReservation(reservation);
    const registry = this.registryFile(sessionId);
    await mkdir(dirname(registry), { recursive: true });
    const handle = await acquireLock(registry, this.lockTimeoutMs);
    try {
      if (!existsSync(registry)) await this.initializeFromTranscript(sessionId, registry);
      const legacyReserved = await containsFingerprint(registry, reservation.replyFingerprint);
      const sidecar = SETTLEMENT_REGISTRY_FILE(registry);
      const current = await readSettlementRegistry(sessionId, sidecar, registry);
      const existing = current.records.find((record) => record.settlementId === reservation.settlementId);
      if (existing) {
        if (!sameReservation(existing, reservation)) return false;
        // A crash between sidecar creation and the legacy append is repaired
        // on retry; this keeps old reserveAssistantReply callers compatible.
        if (!legacyReserved) await appendFile(registry, `${reservation.replyFingerprint}\n`, 'utf8');
        return true;
      }
      const now = new Date().toISOString();
      current.records.push({ ...reservation, status: 'reserved', createdAt: now });
      await writeSettlementRegistry(sidecar, current);
      if (!legacyReserved) {
        await appendFile(registry, `${reservation.replyFingerprint}\n`, 'utf8');
      }
      return true;
    } finally {
      await handle.release();
    }
  }

  /** Mark an existing settlement reservation durable after session append. */
  async settleSettlement(sessionId: SessionId, reservation: FinalReplyReservation): Promise<void> {
    validateReservation(reservation);
    const registry = this.registryFile(sessionId);
    await mkdir(dirname(registry), { recursive: true });
    const handle = await acquireLock(registry, this.lockTimeoutMs);
    try {
      if (!existsSync(registry)) await this.initializeFromTranscript(sessionId, registry);
      const sidecar = SETTLEMENT_REGISTRY_FILE(registry);
      const current = await readSettlementRegistry(sessionId, sidecar, registry);
      const existing = current.records.find((record) => record.settlementId === reservation.settlementId);
      if (!existing) throw new Error(`session: settlement reservation not found: ${reservation.settlementId}`);
      if (!sameReservation(existing, reservation)) {
        throw new Error(`session: settlement reservation conflicts: ${reservation.settlementId}`);
      }
      if (existing.status === 'settled') return;
      existing.status = 'settled';
      existing.settledAt = new Date().toISOString();
      await writeSettlementRegistry(sidecar, current);
    } finally {
      await handle.release();
    }
  }

  /** Read one settlement state for crash/reconnect recovery. */
  async settlementStatus(
    sessionId: SessionId,
    settlementId: string,
  ): Promise<'reserved' | 'settled' | undefined> {
    const registry = this.registryFile(sessionId);
    if (!existsSync(registry)) return undefined;
    const sidecar = SETTLEMENT_REGISTRY_FILE(registry);
    const current = await readSettlementRegistry(sessionId, sidecar, registry);
    return current.records.find((record) => record.settlementId === settlementId)?.status;
  }

  async delete(sessionId: SessionId): Promise<void> {
    const registry = this.registryFile(sessionId);
    await mkdir(dirname(registry), { recursive: true });
    const handle = await acquireLock(registry, this.lockTimeoutMs);
    try {
      await unlink(registry).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await unlink(`${registry}.tmp`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await unlink(SETTLEMENT_REGISTRY_FILE(registry)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await unlink(`${SETTLEMENT_REGISTRY_FILE(registry)}.tmp`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } finally {
      await handle.release();
    }
  }

  registryFile(sessionId: SessionId): string {
    return join(this.sessionsDir, '.reply-fingerprints', `${sessionId}.sha256`);
  }

  private async initializeFromTranscript(sessionId: SessionId, registry: string): Promise<void> {
    const temporary = `${registry}.tmp`;
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    const file = await open(temporary, 'wx');
    try {
      await file.write(`${REGISTRY_HEADER}\n`);
      const transcript = join(this.sessionsDir, `${sessionId}.jsonl`);
      if (existsSync(transcript)) {
        for await (const message of readMessages(transcript)) {
          if (message.role !== 'assistant') continue;
          const normalized = normalizeUserFacingReply(messageText(message));
          if (!normalized) continue;
          await file.write(`${hashReply(normalized)}\n`);
        }
      }
      await file.close();
      await rename(temporary, registry);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function validateReservation(reservation: FinalReplyReservation): void {
  if (reservation.version !== 1
    || !reservation.settlementId.trim()
    || !reservation.reply.trim()
    || !/^[a-f0-9]{64}$/u.test(reservation.replyFingerprint)
    || !reservation.modelRequestId.trim()) {
    throw new Error('session: invalid final reply settlement reservation');
  }
}

function sameReservation(left: FinalReplyReservation, right: FinalReplyReservation): boolean {
  return left.settlementId === right.settlementId
    && left.reply === right.reply
    && left.replyFingerprint === right.replyFingerprint
    && left.modelRequestId === right.modelRequestId;
}

async function readSettlementRegistry(
  sessionId: SessionId,
  sidecar: string,
  legacyRegistry: string,
): Promise<SettlementRegistry> {
  if (!existsSync(sidecar)) {
    return initializeSettlementRegistryFromTranscript(sessionId, sidecar, legacyRegistry);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(sidecar, 'utf8'));
  } catch (error) {
    throw new Error(`session: invalid settlement registry ${sidecar}: ${(error as Error).message}`);
  }
  if (!isSettlementRegistry(parsed)) throw new Error(`session: unsupported settlement registry: ${sidecar}`);
  return parsed;
}

async function initializeSettlementRegistryFromTranscript(
  sessionId: SessionId,
  sidecar: string,
  legacyRegistry: string,
): Promise<SettlementRegistry> {
  const registry: SettlementRegistry = {
    type: 'littlesheep.reply-settlement-registry',
    version: SETTLEMENT_REGISTRY_VERSION,
    records: [],
  };
  const transcript = join(dirname(dirname(legacyRegistry)), `${sessionId}.jsonl`);
  if (existsSync(transcript)) {
    for await (const message of readMessages(transcript)) {
      const settlement = message.finalReplySettlement;
      if (!settlement || settlement.version !== 1) continue;
      if (!settlement.settlementId || !settlement.reply || !settlement.replyFingerprint || !settlement.modelRequestId) continue;
      if (registry.records.some((record) => record.settlementId === settlement.settlementId)) continue;
      registry.records.push({
        version: 1,
        settlementId: settlement.settlementId,
        reply: settlement.reply,
        replyFingerprint: settlement.replyFingerprint,
        modelRequestId: settlement.modelRequestId,
        status: settlement.status === 'settled' ? 'settled' : 'reserved',
        createdAt: message.timestamp,
        ...(settlement.status === 'settled' ? { settledAt: message.timestamp } : {}),
      });
    }
  }
  if (registry.records.length > 0) await writeSettlementRegistry(sidecar, registry);
  return registry;
}

async function writeSettlementRegistry(path: string, registry: SettlementRegistry): Promise<void> {
  await atomicWriteText(path, JSON.stringify(registry) + '\n');
}

function isSettlementRegistry(value: unknown): value is SettlementRegistry {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SettlementRegistry>;
  if (candidate.type !== 'littlesheep.reply-settlement-registry' || candidate.version !== SETTLEMENT_REGISTRY_VERSION || !Array.isArray(candidate.records)) return false;
  return candidate.records.every((record) => {
    if (!record || typeof record !== 'object') return false;
    const item = record as Partial<SettlementRecord>;
    return item.version === 1
      && typeof item.settlementId === 'string'
      && typeof item.reply === 'string'
      && typeof item.replyFingerprint === 'string'
      && typeof item.modelRequestId === 'string'
      && (item.status === 'reserved' || item.status === 'settled')
      && typeof item.createdAt === 'string'
      && (item.settledAt === undefined || typeof item.settledAt === 'string');
  });
}

async function containsFingerprint(registry: string, fingerprint: string): Promise<boolean> {
  let firstLine = true;
  for await (const line of readLines(registry)) {
    if (firstLine) {
      firstLine = false;
      if (line !== REGISTRY_HEADER) {
        throw new Error(`session: unsupported reply fingerprint registry: ${registry}`);
      }
      continue;
    }
    if (line === fingerprint) return true;
  }
  if (firstLine) throw new Error(`session: empty reply fingerprint registry: ${registry}`);
  return false;
}

async function* readMessages(path: string): AsyncGenerator<Message> {
  for await (const line of readLines(path)) {
    try {
      const parsed = JSON.parse(line) as Partial<Message> & { type?: string };
      if (parsed.type !== 'metadata' && parsed.id && parsed.role && Array.isArray(parsed.content)) {
        yield parsed as Message;
      }
    } catch {
      // Session readers already tolerate corrupt lines; preserve that recovery behavior here.
    }
  }
}

async function* readLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim()) yield line.trim();
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function hashReply(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
