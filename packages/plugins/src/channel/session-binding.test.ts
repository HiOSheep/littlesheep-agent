// @littlesheep/plugins — channel/session-binding.test.ts
// Tests for ChannelSessionStore: bind, unbind, findByChannel, findBySession.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelSessionStore } from './session-binding.js';
import { asSessionId } from '@littlesheep/types';

let tmpDir: string;
let bindingsFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ls-channels-'));
  bindingsFile = join(tmpDir, 'channels', 'bindings.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ChannelSessionStore', () => {
  it('load returns empty array when file does not exist', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    const bindings = await store.load();
    expect(bindings).toEqual([]);
  });

  it('bind creates a new binding and persists to disk', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    const record = await store.bind({
      channelId: 'tg-1',
      sessionId: 'session-uuid-1',
      externalConversationId: 'chat-42',
    });

    expect(record.channelId).toBe('tg-1');
    expect(record.sessionId).toBe('session-uuid-1');
    expect(record.externalConversationId).toBe('chat-42');
    expect(record.createdAt).toBeTruthy();

    // File should exist on disk.
    expect(existsSync(bindingsFile)).toBe(true);
    const raw = JSON.parse(readFileSync(bindingsFile, 'utf8'));
    expect(raw.bindings).toHaveLength(1);
    expect(raw.bindings[0]).toEqual(record);
  });

  it('bind updates existing binding in place (same channelId + sessionId)', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    const first = await store.bind({
      channelId: 'tg-1',
      sessionId: 'session-1',
    });
    // Update with new externalConversationId.
    const updated = await store.bind({
      channelId: 'tg-1',
      sessionId: 'session-1',
      externalConversationId: 'chat-99',
    });

    // createdAt preserved, externalConversationId updated.
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.externalConversationId).toBe('chat-99');

    const all = await store.load();
    expect(all).toHaveLength(1); // not duplicated
  });

  it('findByChannel returns only bindings for that channel', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    await store.bind({ channelId: 'tg-1', sessionId: 's1' });
    await store.bind({ channelId: 'tg-1', sessionId: 's2' });
    await store.bind({ channelId: 'qq-1', sessionId: 's3' });

    const tg1 = await store.findByChannel('tg-1');
    expect(tg1).toHaveLength(2);
    expect(tg1.map((b) => b.sessionId)).toEqual(expect.arrayContaining(['s1', 's2']));

    const qq1 = await store.findByChannel('qq-1');
    expect(qq1).toHaveLength(1);
    expect(qq1[0]!.sessionId).toBe('s3');
  });

  it('findBySession returns the binding or null', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    await store.bind({ channelId: 'tg-1', sessionId: 's1' });

    const found = await store.findBySession(asSessionId('s1'));
    expect(found).not.toBeNull();
    expect(found!.channelId).toBe('tg-1');

    const notFound = await store.findBySession(asSessionId('nonexistent'));
    expect(notFound).toBeNull();
  });

  it('unbindChannel removes all bindings for a channel and returns them', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    await store.bind({ channelId: 'tg-1', sessionId: 's1' });
    await store.bind({ channelId: 'tg-1', sessionId: 's2' });
    await store.bind({ channelId: 'qq-1', sessionId: 's3' });

    const removed = await store.unbindChannel('tg-1');
    expect(removed).toHaveLength(2);
    expect(removed.map((b) => b.sessionId)).toEqual(expect.arrayContaining(['s1', 's2']));

    // Remaining bindings should only be qq-1.
    const remaining = await store.load();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.channelId).toBe('qq-1');
  });

  it('unbindChannel returns empty for unknown channel', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    await store.bind({ channelId: 'tg-1', sessionId: 's1' });

    const removed = await store.unbindChannel('nonexistent');
    expect(removed).toEqual([]);

    // Original binding untouched.
    const all = await store.load();
    expect(all).toHaveLength(1);
  });

  it('load tolerates corrupt JSON (returns empty)', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    // Write corrupt JSON to the file.
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(tmpDir, 'channels'), { recursive: true });
    await writeFile(bindingsFile, '{ corrupt json }}}', 'utf8');

    const bindings = await store.load();
    expect(bindings).toEqual([]);
  });

  it('save creates parent directory if missing', async () => {
    const store = new ChannelSessionStore({ bindingsFile });
    // bindingsFile is in tmpDir/channels/ which doesn't exist yet.
    expect(existsSync(join(tmpDir, 'channels'))).toBe(false);

    await store.bind({ channelId: 'tg-1', sessionId: 's1' });

    expect(existsSync(join(tmpDir, 'channels'))).toBe(true);
    expect(existsSync(bindingsFile)).toBe(true);
  });
});
