import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceResourceIndexStore } from './workspace-resource-index.js';

let root: string;
let dataDir: string;
let workspace: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ls-workspace-index-'));
  dataDir = join(root, 'data');
  workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('WorkspaceResourceIndexStore', () => {
  it('indexes bounded metadata, skips sensitive/heavy paths, and restores after restart', async () => {
    mkdirSync(join(workspace, 'src'), { recursive: true });
    mkdirSync(join(workspace, 'node_modules', 'dependency'), { recursive: true });
    mkdirSync(join(workspace, '.git'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), '{"name":"demo"}', 'utf8');
    writeFileSync(join(workspace, 'src', 'main.ts'), 'PRIVATE-SOURCE-BODY', 'utf8');
    writeFileSync(join(workspace, 'node_modules', 'dependency', 'index.js'), 'skip', 'utf8');
    writeFileSync(join(workspace, '.env'), 'SECRET=1', 'utf8');
    writeFileSync(join(workspace, 'private.pem'), 'PRIVATE KEY', 'utf8');

    const store = new WorkspaceResourceIndexStore({ dataDir });
    const first = await store.sync(workspace, { boundaryKind: 'project', projectId: 'project-1' });

    expect(first.snapshot.scan.status).toBe('complete');
    expect(first.snapshot.files.map((file) => file.relativePath)).toEqual(['package.json', 'src/main.ts']);
    expect(first.snapshot.files.find((file) => file.relativePath === 'src/main.ts')).toMatchObject({
      kind: 'code',
      owner: 'user',
    });
    expect(first.indexPath.startsWith(join(dataDir, 'workspace', 'resource-indexes'))).toBe(true);
    expect(existsSync(first.indexPath)).toBe(true);

    const restarted = new WorkspaceResourceIndexStore({ dataDir });
    const restored = await restarted.sync(workspace, { boundaryKind: 'project', projectId: 'project-1' });
    expect(restored.changed).toBe(false);
    expect(restored.snapshot.files).toEqual(first.snapshot.files);
    const rendered = await restarted.render(first.indexPath, 'main.ts');
    expect(rendered).toContain('src/main.ts');
    expect(rendered).not.toContain('PRIVATE-SOURCE-BODY');
  });

  it('continues a bounded directory scan from the persisted cursor after restart', async () => {
    mkdirSync(join(workspace, 'src', 'nested'), { recursive: true });
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'root.txt'), 'root', 'utf8');
    writeFileSync(join(workspace, 'src', 'source.ts'), 'source', 'utf8');
    writeFileSync(join(workspace, 'src', 'nested', 'deep.ts'), 'deep', 'utf8');
    writeFileSync(join(workspace, 'docs', 'guide.md'), 'guide', 'utf8');

    const limits = { maxDirectoriesPerSync: 1, rescanIntervalMs: 60_000 };
    const firstStore = new WorkspaceResourceIndexStore({ dataDir, limits });
    const first = await firstStore.sync(workspace);
    expect(first.snapshot.scan.status).toBe('scanning');
    expect(first.snapshot.files.map((file) => file.relativePath)).toEqual(['root.txt']);

    const restarted = new WorkspaceResourceIndexStore({ dataDir, limits });
    let current = await restarted.sync(workspace);
    for (let attempt = 0; current.snapshot.scan.status === 'scanning' && attempt < 8; attempt += 1) {
      current = await restarted.sync(workspace);
    }
    expect(current.snapshot.scan.status).toBe('complete');
    expect(current.snapshot.files.map((file) => file.relativePath)).toEqual([
      'docs/guide.md',
      'root.txt',
      'src/nested/deep.ts',
      'src/source.ts',
    ]);
  });

  it('applies exact agent/user changes immediately and removes deleted paths without a full scan', async () => {
    const store = new WorkspaceResourceIndexStore({ dataDir });
    const userFile = join(workspace, 'notes.md');
    writeFileSync(userFile, 'notes', 'utf8');
    await store.sync(workspace);

    const generated = join(workspace, 'generated.ts');
    writeFileSync(generated, 'generated', 'utf8');
    const changed = await store.sync(workspace, {
      changes: [{ path: generated, source: 'agent' }],
    });
    expect(changed.snapshot.files.find((file) => file.relativePath === 'generated.ts')).toMatchObject({ owner: 'agent' });

    rmSync(userFile, { force: true });
    const removed = await store.sync(workspace, {
      changes: [{ path: userFile, source: 'user' }],
    });
    expect(removed.snapshot.files.some((file) => file.relativePath === 'notes.md')).toBe(false);
  });

  it('reconciles external deletion on the next bounded generation and enforces the file cap', async () => {
    let now = Date.UTC(2026, 0, 1);
    for (let index = 0; index < 8; index += 1) {
      writeFileSync(join(workspace, `file-${index}.txt`), String(index), 'utf8');
    }
    const store = new WorkspaceResourceIndexStore({
      dataDir,
      now: () => now,
      limits: { maxFiles: 4, rescanIntervalMs: 100 },
    });
    const first = await store.sync(workspace);
    expect(first.snapshot.files).toHaveLength(4);
    expect(first.snapshot.scan.truncated).toBe(true);

    const removedPath = join(workspace, first.snapshot.files[0]!.relativePath);
    rmSync(removedPath, { force: true });
    now += 1000;
    const rescanned = await store.sync(workspace);
    expect(rescanned.snapshot.files).toHaveLength(4);
    expect(rescanned.snapshot.files.some((file) => join(workspace, file.relativePath) === removedPath)).toBe(false);
  });

  it('keeps large scans and concurrent change updates bounded and serializable', async () => {
    for (let directory = 0; directory < 40; directory += 1) {
      const dir = join(workspace, `module-${directory}`);
      mkdirSync(dir, { recursive: true });
      for (let file = 0; file < 10; file += 1) {
        writeFileSync(join(dir, `file-${file}.ts`), `${directory}:${file}`, 'utf8');
      }
    }
    const limits = {
      maxFiles: 128,
      maxDirectoriesPerSync: 4,
      maxPendingDirectories: 16,
      maxEntriesPerDirectory: 128,
    };
    const store = new WorkspaceResourceIndexStore({ dataDir, limits });
    let snapshot = (await store.sync(workspace)).snapshot;
    expect(snapshot.scan.scannedDirectories).toBeLessThanOrEqual(4);
    expect(snapshot.scan.queue.length).toBeLessThanOrEqual(16);
    expect(snapshot.files.length).toBeLessThanOrEqual(256);
    for (let attempt = 0; snapshot.scan.status === 'scanning' && attempt < 20; attempt += 1) {
      snapshot = (await store.sync(workspace)).snapshot;
    }
    expect(snapshot.scan.status).toBe('complete');
    expect(snapshot.files.length).toBeLessThanOrEqual(128);
    expect(snapshot.scan.truncated).toBe(true);

    const first = join(workspace, 'concurrent-a.ts');
    const second = join(workspace, 'concurrent-b.ts');
    writeFileSync(first, 'a', 'utf8');
    writeFileSync(second, 'b', 'utf8');
    await Promise.all([
      store.sync(workspace, { changes: [{ path: first, source: 'agent' }] }),
      store.sync(workspace, { changes: [{ path: second, source: 'user' }] }),
    ]);
    const final = await store.sync(workspace);
    expect(final.snapshot.files.some((file) => file.relativePath === 'concurrent-a.ts' && file.owner === 'agent')).toBe(true);
    expect(final.snapshot.files.some((file) => file.relativePath === 'concurrent-b.ts' && file.owner === 'user')).toBe(true);
  });
});
