import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Message, SessionId } from '@littlesheep/types';
import { normalizeUserFacingReply } from '@littlesheep/types';
import { acquireLock } from './lock.js';

const REGISTRY_VERSION = 1;
const REGISTRY_HEADER = JSON.stringify({
  type: 'littlesheep.reply-fingerprint-registry',
  version: REGISTRY_VERSION,
});

export class ReplyFingerprintStore {
  constructor(
    private readonly sessionsDir: string,
    private readonly lockTimeoutMs: number,
  ) {}

  /**
   * Atomically reserve a normalized reply fingerprint for one session.
   * Returns false when the same visible text has already been reserved.
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
