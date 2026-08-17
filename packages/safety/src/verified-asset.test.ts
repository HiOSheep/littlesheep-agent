import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupVerifiedAssetTemporaryFiles,
  downloadVerifiedAsset,
  inspectVerifiedAssetFile,
  type VerifiedAssetExpectation,
} from './verified-asset.js';

const temporaryRoots: string[] = [];
const hello = new TextEncoder().encode('hello');
const helloExpectation = expectation(hello);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('verified asset files', () => {
  it('distinguishes valid, missing, and invalid files with bounded hashing', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'asset.bin');
    expect(await inspectVerifiedAssetFile(path, helloExpectation)).toBe('missing');

    await writeFile(path, hello);
    expect(await inspectVerifiedAssetFile(path, helloExpectation)).toBe('valid');

    await writeFile(path, 'jello', 'utf8');
    expect(await inspectVerifiedAssetFile(path, helloExpectation)).toBe('invalid');
    await writeFile(path, 'hello!', 'utf8');
    expect(await inspectVerifiedAssetFile(path, helloExpectation)).toBe('invalid');
  });

  it('propagates non-missing filesystem failures instead of treating them as cache misses', async () => {
    await expect(inspectVerifiedAssetFile('\0', helloExpectation))
      .rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' });
  });

  it('publishes a synced verified download over an invalid destination', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'nested', 'asset.bin');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'prior', 'utf8');
    const progress: number[] = [];

    await downloadVerifiedAsset({
      destination,
      expected: helloExpectation,
      url: 'https://assets.invalid/asset.bin',
      fetchFn: (async () => new Response(hello)) as typeof fetch,
      label: 'Test asset',
      onBytes: (bytes) => progress.push(bytes),
    });

    expect(await readFile(destination, 'utf8')).toBe('hello');
    expect(await inspectVerifiedAssetFile(destination, helloExpectation)).toBe('valid');
    expect(progress).toEqual([hello.byteLength]);
  });

  it.each([
    ['oversized', new TextEncoder().encode('hello!'), 'exceeded expected size'],
    ['truncated', new TextEncoder().encode('hell'), 'size mismatch'],
    ['wrong hash', new TextEncoder().encode('jello'), 'hash mismatch'],
  ])('rejects %s bodies, preserves the prior destination, and removes its temporary file', async (
    _case,
    body,
    message,
  ) => {
    const root = await temporaryRoot();
    const destination = join(root, 'asset.bin');
    await writeFile(destination, 'prior', 'utf8');

    await expect(downloadVerifiedAsset({
      destination,
      expected: helloExpectation,
      url: 'https://assets.invalid/asset.bin',
      fetchFn: (async () => new Response(body)) as typeof fetch,
      label: 'Test asset',
    })).rejects.toThrow(message);

    expect(await readFile(destination, 'utf8')).toBe('prior');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('cleans up after a response stream interruption', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'asset.bin');
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('he'));
        controller.error(new Error('stream interrupted'));
      },
    });

    await expect(downloadVerifiedAsset({
      destination,
      expected: helloExpectation,
      url: 'https://assets.invalid/asset.bin',
      fetchFn: (async () => new Response(interrupted)) as typeof fetch,
    })).rejects.toThrow('stream interrupted');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('allows concurrent verified publishers to converge on the same destination', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'asset.bin');
    let release!: () => void;
    const released = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const fetchFn = vi.fn(async () => {
      await released;
      return new Response(hello);
    });

    const first = downloadVerifiedAsset({
      destination,
      expected: helloExpectation,
      url: 'https://assets.invalid/asset.bin',
      fetchFn: fetchFn as typeof fetch,
    });
    const second = downloadVerifiedAsset({
      destination,
      expected: helloExpectation,
      url: 'https://assets.invalid/asset.bin',
      fetchFn: fetchFn as typeof fetch,
    });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    release();
    await Promise.all([first, second]);

    expect(await inspectVerifiedAssetFile(destination, helloExpectation)).toBe('valid');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes interrupted PID temps and stale legacy temps within a bounded directory scan', async () => {
    const root = await temporaryRoot();
    const destination = join(root, 'asset.bin');
    const pidTemp = `${destination}.${process.pid}.0123456789abcdef.tmp`;
    const legacyTemp = `${destination}.fedcba9876543210.tmp`;
    const unrelated = join(root, 'unrelated.tmp');
    await Promise.all([
      writeFile(pidTemp, 'partial', 'utf8'),
      writeFile(legacyTemp, 'partial', 'utf8'),
      writeFile(unrelated, 'keep', 'utf8'),
    ]);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await utimes(legacyTemp, old, old);

    await Promise.all([
      cleanupVerifiedAssetTemporaryFiles(destination),
      cleanupVerifiedAssetTemporaryFiles(destination),
    ]);
    expect(await readdir(root)).toEqual(['unrelated.tmp']);

    await downloadVerifiedAsset({
      destination,
      expected: helloExpectation,
      url: 'https://assets.invalid/asset.bin',
      fetchFn: (async () => new Response(hello)) as typeof fetch,
    });

    expect((await readdir(root)).sort()).toEqual(['asset.bin', 'unrelated.tmp']);
  });

  it('rejects an already-aborted request before touching the network', async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => new Response(hello));
    controller.abort(new Error('stop'));

    await expect(downloadVerifiedAsset({
      destination: join(root, 'asset.bin'),
      expected: helloExpectation,
      url: 'https://assets.invalid/asset.bin',
      fetchFn: fetchFn as typeof fetch,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

function expectation(bytes: Uint8Array): VerifiedAssetExpectation {
  return {
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-verified-asset-'));
  temporaryRoots.push(root);
  return root;
}
