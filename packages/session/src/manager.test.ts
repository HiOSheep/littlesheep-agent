import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { asSessionId, textMessage, type CompactionSummaryV2 } from '@littlesheep/types';
import { SessionCompactionStore } from './compaction-store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ls-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('SessionManager', () => {
  it('creates and loads a session', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create('openai/gpt-4o', 'test session');
    expect(session.id).toBeTruthy();
    expect(session.metadata.title).toBe('test session');
    expect(session.messages).toHaveLength(0);

    const loaded = await sm.load(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.metadata.model).toBe('openai/gpt-4o');
  });

  it('appends and reads messages', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create();
    const msgs = [
      textMessage('user', 'hello'),
      textMessage('assistant', 'hi there'),
    ];
    await sm.append(session.id, msgs);
    const read = await sm.read(session.id);
    expect(read).toHaveLength(2);
    expect(read[0]!.role).toBe('user');
    expect(read[1]!.content[0]).toMatchObject({ type: 'text', text: 'hi there' });
  });

  it('readRecent returns last N messages', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create();
    const msgs = Array.from({ length: 5 }, (_, i) => textMessage('user', `msg ${i}`));
    await sm.append(session.id, msgs);
    const recent = await sm.readRecent(session.id, 2);
    expect(recent).toHaveLength(2);
    expect(recent[1]!.content[0]).toMatchObject({ type: 'text', text: 'msg 4' });
  });

  it('lists sessions', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    await sm.create();
    await sm.create();
    const list = await sm.list();
    expect(list).toHaveLength(2);
  });

  it('returns null for missing session', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const loaded = await sm.load(asSessionId('nonexistent-id'));
    expect(loaded).toBeNull();
  });

  it('updates metadata', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create();
    await sm.append(session.id, [textMessage('user', 'x')]);
    await sm.updateMetadata(session.id, { title: 'updated title' });
    const loaded = await sm.load(session.id);
    expect(loaded!.metadata.title).toBe('updated title');
    expect(loaded!.metadata.messageCount).toBe(1);
  });

  it('recovers an interrupted compaction transaction on the next metadata read', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create();
    await sm.append(session.id, [textMessage('user', 'source', {
      id: 'source-message',
      timestamp: '2026-07-16T10:00:00.000Z',
    })]);
    const summary: CompactionSummaryV2 = {
      version: 2,
      id: 'summary-recovery',
      collapsedCount: 1,
      summary: 'Recovered summary.',
      compactedAt: '2026-07-16T10:01:00.000Z',
      sourceStartMessageId: 'source-message',
      sourceEndMessageId: 'source-message',
      sourceStartAt: '2026-07-16T10:00:00.000Z',
      sourceEndAt: '2026-07-16T10:00:00.000Z',
      cache: {
        version: 1,
        namespace: 'session-summary',
        dataClass: 'semantic',
        compressionDepth: 1,
        disclosureLevel: 'D1',
        vectorClass: 'semantic-cache',
        sourceRefs: ['session:source-message'],
        contentHash: 'a'.repeat(64),
        createdAt: '2026-07-16T10:01:00.000Z',
      },
      sourceRanges: [{
        messageCount: 1,
        sourceStartMessageId: 'source-message',
        sourceEndMessageId: 'source-message',
        sourceStartAt: '2026-07-16T10:00:00.000Z',
        sourceEndAt: '2026-07-16T10:00:00.000Z',
        sourceHash: 'b'.repeat(64),
      }],
      sourceSummaryIds: [],
      mergedSummaryCount: 1,
      sourceHash: 'b'.repeat(64),
      lineageHash: 'c'.repeat(64),
    };
    const store = new SessionCompactionStore(tmpDir);
    await expect(store.commit(session.id, summary, async () => {
      throw new Error('simulated metadata failure');
    })).rejects.toThrow('simulated metadata failure');

    await expect(sm.loadMetadata(session.id)).resolves.toMatchObject({
      compacted: true,
      compaction: { id: summary.id, version: 2 },
    });
    await expect(sm.loadCompactionProjection(session.id, summary.id)).resolves.toEqual(summary);
  });

  // ── delete() ────────────────────────────────────────────────────────────

  it('delete removes the session file', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create();
    expect(await sm.list()).toHaveLength(1);

    await sm.delete(session.id);

    expect(await sm.list()).toHaveLength(0);
    expect(await sm.load(session.id)).toBeNull();
  });

  it('delete tolerates missing files (ENOENT)', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    // Deleting a non-existent session should not throw.
    await expect(sm.delete(asSessionId('never-existed'))).resolves.toBeUndefined();
  });

  it('delete cleans up the lock file', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create();
    await sm.delete(session.id);

    // Lock file should not linger after delete.
    const { existsSync } = await import('node:fs');
    expect(existsSync(sm.sessionFile(session.id) + '.lock')).toBe(false);
  });

  // ── create(meta) ────────────────────────────────────────────────────────

  it('create accepts meta and persists it in the header', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create('openai/gpt-4o', 'channel session', {
      channelId: 'ch-1',
      origin: 'channel',
      externalConversationId: 'ext-conv-123',
    });

    expect(session.metadata.channelId).toBe('ch-1');
    expect(session.metadata.origin).toBe('channel');
    expect(session.metadata.externalConversationId).toBe('ext-conv-123');

    // Reload to verify persistence.
    const loaded = await sm.load(session.id);
    expect(loaded!.metadata.channelId).toBe('ch-1');
    expect(loaded!.metadata.origin).toBe('channel');
    expect(loaded!.metadata.externalConversationId).toBe('ext-conv-123');
  });

  it('create without meta is backward compatible (no channelId)', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const session = await sm.create('openai/gpt-4o', 'local session');

    expect(session.metadata.channelId).toBeUndefined();
    expect(session.metadata.origin).toBeUndefined();
  });

  // ── listByChannel() ─────────────────────────────────────────────────────

  it('listByChannel returns only sessions bound to that channel', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    // 2 sessions for channel-A, 1 for channel-B, 1 local (no channel).
    const a1 = await sm.create(undefined, undefined, { channelId: 'ch-A', origin: 'channel' });
    const a2 = await sm.create(undefined, undefined, { channelId: 'ch-A', origin: 'channel' });
    const b1 = await sm.create(undefined, undefined, { channelId: 'ch-B', origin: 'channel' });
    await sm.create(); // local, no channelId

    const channelA = await sm.listByChannel('ch-A');
    expect(channelA).toHaveLength(2);
    expect(channelA).toContain(a1.id);
    expect(channelA).toContain(a2.id);

    const channelB = await sm.listByChannel('ch-B');
    expect(channelB).toHaveLength(1);
    expect(channelB).toContain(b1.id);
  });

  it('listByChannel returns empty for unknown channel', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    await sm.create(undefined, undefined, { channelId: 'ch-A', origin: 'channel' });

    const result = await sm.listByChannel('nonexistent-channel');
    expect(result).toHaveLength(0);
  });

  it('listByChannel excludes sessions after delete', async () => {
    const sm = new SessionManager({ sessionsDir: tmpDir });
    const s1 = await sm.create(undefined, undefined, { channelId: 'ch-A', origin: 'channel' });
    await sm.create(undefined, undefined, { channelId: 'ch-A', origin: 'channel' });

    expect(await sm.listByChannel('ch-A')).toHaveLength(2);
    await sm.delete(s1.id);
    expect(await sm.listByChannel('ch-A')).toHaveLength(1);
  });
});
