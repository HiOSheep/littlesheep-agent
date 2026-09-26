// RS-07 file-side acceptance: real files on disk, real tools, injected faults, and the bytes that are
// actually there afterwards.
//
// The point of this script is the last part of that sentence. A mock can place a control point, but it
// cannot tell us what a user's file looks like after the agent was refused, so every scenario below
// writes real bytes into a temporary workspace, reads them back from disk with `readFile`, and asserts
// on those bytes rather than on a tool's own report of itself.
//
// Run: node scripts/verify-file-consistency-faults.mjs

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_BRANDING } from '../packages/branding/dist/index.js';
import { DEFAULT_CONFIG } from '../packages/config/dist/index.js';
import { createRunner } from '../packages/runner/dist/runner.js';

const startedAt = performance.now();
const dataDir = await mkdtemp(join(tmpdir(), 'littlesheep-file-faults-'));
const workspace = join(dataDir, 'workplace');
const originalDataDir = process.env.LITTLESHEEP_DATA_DIR;
const originalFetch = globalThis.fetch;
const scenarios = [];
const limits = [];
let blockedNetworkAttempts = 0;
let runner;
let report;
let failure;

try {
  globalThis.fetch = async () => {
    blockedNetworkAttempts += 1;
    throw new Error('Network access is forbidden during the file consistency acceptance.');
  };
  process.env.LITTLESHEEP_DATA_DIR = dataDir;
  await mkdir(workspace, { recursive: true });

  // The default memory backend is enough here: this acceptance is about file bytes, and asking for v3
  // would demand the isolated-data marker that memory acceptance creates.
  const config = structuredClone(DEFAULT_CONFIG);
  runner = await createRunner({
    config,
    branding: DEFAULT_BRANDING,
    model: 'acceptance/model',
    llm: idleLlm(),
    skillsDirs: [],
  });

  const sessionA = await runner.sessionManager.create('acceptance/model');
  const sessionB = await runner.sessionManager.create('acceptance/model');
  const tool = (name) => runner.infra.registry.get(name).tool;
  const context = (sessionId, overrides = {}) => ({
    sessionId,
    runId: 'run-file-faults',
    cwd: workspace,
    containerRoot: dataDir,
    protectedWriteRoots: [],
    permissionMode: 'full',
    observation: runner.infra.fileObservations.forSession(sessionId),
    approve: async () => true,
    ...overrides,
  });
  const disk = (name) => readFile(join(workspace, name), 'utf8');

  // ─── 1. Same size, same mtime, different bytes ───────────────────────────────────────────────────
  {
    const path = 'same-size.txt';
    await writeFile(join(workspace, path), 'alpha\nbeta\n', 'utf8');
    const before = await readFile(join(workspace, path));
    const read = await tool('read').execute({ file_path: path }, context(sessionA.id));
    assert.equal(read.ok, undefined ?? read.ok);
    assert(read.output.includes('alpha'), 'The read did not deliver the file.');

    // Same byte length and the mtime put back exactly where it was: only the content differs.
    const spoofed = Buffer.from('ALPHA\nBETA\n', 'utf8');
    assert.equal(spoofed.length, before.length, 'The spoofed rewrite is not the same size.');
    const stats = await stat0(join(workspace, path));
    await writeFile(join(workspace, path), spoofed);
    await utimes(join(workspace, path), stats.atime, stats.mtime);

    const edit = await tool('edit').execute({
      file_path: path, old_string: 'alpha', new_string: 'alpha2',
    }, context(sessionA.id));
    assert.equal(edit.ok, false, 'A same-size rewrite that kept the mtime was not refused.');
    assert.equal(edit.meta?.errorKind, 'observation_stale', `Unexpected refusal: ${JSON.stringify(edit.meta)}`);
    assert.equal(await disk(path), 'ALPHA\nBETA\n', 'The refused edit still changed the file on disk.');
    scenarios.push({
      scenario: '同大小 / 保留 mtime 的改写',
      evidence: { sizeBytes: before.length, mtimePreserved: true, errorKind: edit.meta.errorKind, diskAfter: 'external-bytes' },
      result: 'pass',
    });
  }

  // ─── 2. A change somewhere else in the file ───────────────────────────────────────────────────────
  {
    const path = 'elsewhere.txt';
    await writeFile(join(workspace, path), 'one\ntwo\nthree\n', 'utf8');
    await tool('read').execute({ file_path: path }, context(sessionA.id));
    // The user edits the last line while the model is still looking at the first one.
    await writeFile(join(workspace, path), 'one\ntwo\nthree-edited\n', 'utf8');
    const edit = await tool('edit').execute({
      file_path: path, old_string: 'one', new_string: 'one-edited',
    }, context(sessionA.id));
    assert.equal(edit.ok, false, 'An edit was applied although another region had changed.');
    assert.equal(edit.meta?.errorKind, 'observation_stale');
    assert.equal(await disk(path), 'one\ntwo\nthree-edited\n', 'The refused edit overwrote the user\'s change.');
    scenarios.push({
      scenario: '其他区域发生变化',
      evidence: { errorKind: edit.meta.errorKind, userChangeIntact: true },
      result: 'pass',
    });
  }

  // ─── 3. Partial read, then the read that makes the write legal ────────────────────────────────────
  {
    const path = 'partial.txt';
    await writeFile(join(workspace, path), 'first\nsecond\nthird\n', 'utf8');
    await tool('read').execute({ file_path: path, limit: 1 }, context(sessionA.id));
    const write = await tool('write').execute({
      file_path: path, content: 'replaced\n',
    }, context(sessionA.id));
    assert.equal(write.ok, false, 'A write after a partial read was allowed.');
    assert.equal(write.meta?.errorKind, 'observation_missing', `Unexpected refusal: ${JSON.stringify(write.meta)}`);
    assert.equal(await disk(path), 'first\nsecond\nthird\n', 'The refused write still changed the file.');

    // The documented recovery: read it properly, then the same write goes through.
    await tool('read').execute({ file_path: path }, context(sessionA.id));
    const retry = await tool('write').execute({ file_path: path, content: 'replaced\n' }, context(sessionA.id));
    assert.notEqual(retry.ok, false, `The write after a full read was refused: ${retry.error}`);
    assert.equal(await disk(path), 'replaced\n', 'The accepted write did not reach the disk.');
    scenarios.push({
      scenario: '部分 read → 拒绝 → 重读后成功',
      evidence: { refusedKind: write.meta.errorKind, recovered: true, diskAfter: 'replaced' },
      result: 'pass',
    });
  }

  // ─── 4. A read the runtime had to truncate ────────────────────────────────────────────────────────
  {
    const path = 'huge.txt';
    const lines = Array.from({ length: 20_000 }, (_value, index) => `line ${index} ${'y'.repeat(60)}`);
    await writeFile(join(workspace, path), `${lines.join('\n')}\n`, 'utf8');
    const read = await tool('read').execute({ file_path: path }, context(sessionA.id));
    assert.equal(read.sanitized, true, 'A 20k-line read was delivered whole; this scenario no longer tests truncation.');
    const write = await tool('write').execute({ file_path: path, content: 'short\n' }, context(sessionA.id));
    assert.equal(write.ok, false, 'A truncated read still licensed an overwrite.');
    assert(['observation_missing', 'observation_stale', 'observation_unsupported'].includes(write.meta?.errorKind),
      `Unexpected refusal kind: ${JSON.stringify(write.meta)}`);
    const onDisk = await disk(path);
    assert(onDisk.startsWith('line 0 '), 'The refused write changed the truncated file.');
    scenarios.push({
      scenario: '清洗 / 截断的读取',
      evidence: { truncated: true, errorKind: write.meta.errorKind, diskIntact: true },
      result: 'pass',
    });
  }

  // ─── 5. The path now points somewhere else ────────────────────────────────────────────────────────
  if (process.platform !== 'win32' || process.env.LS_ACCEPT_SYMLINKS === '1') {
    const real = 'link-target.txt';
    const other = 'link-other.txt';
    const link = 'link.txt';
    await writeFile(join(workspace, real), 'target-one\n', 'utf8');
    await writeFile(join(workspace, other), 'other-one\n', 'utf8');
    await symlink(join(workspace, real), join(workspace, link), 'file');
    await tool('read').execute({ file_path: link }, context(sessionA.id));
    // The link is repointed at another file between the read and the write.
    await unlink(join(workspace, link));
    await symlink(join(workspace, other), join(workspace, link), 'file');
    const write = await tool('write').execute({ file_path: link, content: 'redirected\n' }, context(sessionA.id));
    assert.equal(write.ok, false, 'A repointed link was written through.');
    assert.equal(await disk(other), 'other-one\n', 'The redirect wrote into the new target.');
    assert.equal(await disk(real), 'target-one\n', 'The redirect wrote into the old target.');
    scenarios.push({
      scenario: '路径重定向（符号链接改指）',
      evidence: { errorKind: write.meta?.errorKind ?? 'refused', bothTargetsIntact: true },
      result: 'pass',
    });
  } else {
    // Windows without the symlink privilege still has junctions, and a directory that is swapped for a
    // junction redirects the same relative path to a different file.
    const originalDir = join(workspace, 'redirected-dir');
    const elsewhereDir = join(workspace, 'elsewhere-dir');
    await mkdir(originalDir, { recursive: true });
    await mkdir(elsewhereDir, { recursive: true });
    await writeFile(join(originalDir, 'note.txt'), 'original-side\n', 'utf8');
    await writeFile(join(elsewhereDir, 'note.txt'), 'other-side\n', 'utf8');
    await tool('read').execute({ file_path: 'redirected-dir/note.txt' }, context(sessionA.id));
    await rm(originalDir, { recursive: true, force: true });
    await runCommand('cmd', ['/c', 'mklink', '/J', originalDir, elsewhereDir]);
    const write = await tool('write').execute({
      file_path: 'redirected-dir/note.txt', content: 'redirected\n',
    }, context(sessionA.id));
    assert.equal(write.ok, false, 'A directory replaced by a junction was written through.');
    assert.equal(await readFile(join(elsewhereDir, 'note.txt'), 'utf8'), 'other-side\n',
      'The redirected write landed in the junction target.');
    scenarios.push({
      scenario: '路径重定向（目录改为 junction）',
      evidence: { errorKind: write.meta?.errorKind ?? 'refused', junctionTargetIntact: true },
      result: 'pass',
    });
    limits.push('Windows 上以目录 junction 代替符号链接来验证路径重定向；符号链接版本在其它平台或设置 '
      + 'LS_ACCEPT_SYMLINKS=1 时运行。');
  }

  // ─── 6. Delete and recreate ───────────────────────────────────────────────────────────────────────
  {
    const path = 'recreated.txt';
    await writeFile(join(workspace, path), 'original\n', 'utf8');
    await tool('read').execute({ file_path: path }, context(sessionA.id));
    await unlink(join(workspace, path));
    await writeFile(join(workspace, path), 'original\n', 'utf8');
    const sameBytes = await tool('edit').execute({
      file_path: path, old_string: 'original', new_string: 'edited',
    }, context(sessionA.id));
    // Recreated with identical bytes: the observation is by content, so this is the same version.
    assert.notEqual(sameBytes.ok, false, `An identical recreation was refused: ${sameBytes.error}`);
    assert.equal(await disk(path), 'edited\n');

    await unlink(join(workspace, path));
    await writeFile(join(workspace, path), 'different\n', 'utf8');
    const changedBytes = await tool('edit').execute({
      file_path: path, old_string: 'original', new_string: 'edited',
    }, context(sessionA.id));
    assert.equal(changedBytes.ok, false, 'A recreation with different bytes was written through.');
    assert.equal(await disk(path), 'different\n', 'The refused edit changed the recreated file.');
    scenarios.push({
      scenario: '删除后重建（同内容 / 不同内容）',
      evidence: {
        identicalRecreationAllowed: true,
        differentRecreationKind: changedBytes.meta?.errorKind,
        diskAfter: 'different',
      },
      result: 'pass',
    });
  }

  // ─── 7. Two sessions creating the same new file ───────────────────────────────────────────────────
  {
    const path = 'concurrent.txt';
    const first = await tool('write').execute({ file_path: path, content: 'from-a\n' }, context(sessionA.id));
    assert.notEqual(first.ok, false, `The first creation failed: ${first.error}`);
    // Session B never observed this file, so its write is refused rather than silently replacing it.
    const second = await tool('write').execute({ file_path: path, content: 'from-b\n' }, context(sessionB.id));
    assert.equal(second.ok, false, 'A second session overwrote a file it had never read.');
    assert.equal(await disk(path), 'from-a\n', 'The refused concurrent write changed the file.');
    // And the honest recovery: B reads it, then B may write it.
    await tool('read').execute({ file_path: path }, context(sessionB.id));
    const third = await tool('write').execute({ file_path: path, content: 'from-b\n' }, context(sessionB.id));
    assert.notEqual(third.ok, false, `The write after a read was refused: ${third.error}`);
    assert.equal(await disk(path), 'from-b\n');
    scenarios.push({
      scenario: '并发创建',
      evidence: { secondSessionKind: second.meta?.errorKind, recoveredAfterRead: true },
      result: 'pass',
    });
  }

  // ─── 8. Cross-session commit ──────────────────────────────────────────────────────────────────────
  {
    const path = 'cross-session.txt';
    await writeFile(join(workspace, path), 'v1\n', 'utf8');
    await tool('read').execute({ file_path: path }, context(sessionA.id));
    await tool('read').execute({ file_path: path }, context(sessionB.id));
    const committed = await tool('write').execute({ file_path: path, content: 'v2\n' }, context(sessionB.id));
    assert.notEqual(committed.ok, false, `Session B could not commit: ${committed.error}`);
    // Session A's observation is older than what is on disk now, so its edit is refused.
    const late = await tool('edit').execute({ file_path: path, old_string: 'v1', new_string: 'v3' }, context(sessionA.id));
    assert.equal(late.ok, false, 'A stale session wrote over another session\'s commit.');
    assert.equal(await disk(path), 'v2\n', 'The refused edit undid the other session\'s commit.');
    scenarios.push({
      scenario: '跨会话提交',
      evidence: { errorKind: late.meta?.errorKind, committedContentIntact: true },
      result: 'pass',
    });
  }

  // ─── 9. An approval that never arrives ────────────────────────────────────────────────────────────
  {
    const path = 'approval.txt';
    await writeFile(join(workspace, path), 'unchanged\n', 'utf8');
    await tool('read').execute({ file_path: path }, context(sessionA.id));
    let approveCalled = 0;
    const denied = await tool('write').execute({ file_path: path, content: 'granted\n' }, context(sessionA.id, {
      permissionMode: 'restricted',
      approve: async () => { approveCalled += 1; return false; },
    }));
    assert.equal(denied.ok, false, 'A write proceeded without approval.');
    assert(approveCalled > 0, 'The approval path was never consulted.');
    assert.equal(await disk(path), 'unchanged\n', 'The denied write changed the file.');
    scenarios.push({
      scenario: '审批等待 / 被拒',
      evidence: { approvalConsulted: approveCalled, errorKind: denied.meta?.errorKind ?? 'denied', diskUnchanged: true },
      result: 'pass',
    });
  }

  // ─── 10. An exec that changed the file and then failed ────────────────────────────────────────────
  {
    const path = 'exec-partial.txt';
    await writeFile(join(workspace, path), 'before-exec\n', 'utf8');
    await tool('read').execute({ file_path: path }, context(sessionA.id));
    const exec = await tool('exec').execute({
      command: `node -e "require('node:fs').writeFileSync('exec-partial.txt','written-by-exec'); process.exit(3)"`,
    }, context(sessionA.id));
    assert.equal(exec.ok, false, 'The failing command reported success.');
    assert.equal(await disk(path), 'written-by-exec', 'The partial exec did not reach the disk; this scenario is void.');
    // The file changed underneath the observation, so the follow-up edit is refused even though the
    // command "failed".
    const afterExec = await tool('edit').execute({
      file_path: path, old_string: 'before-exec', new_string: 'after-exec',
    }, context(sessionA.id));
    assert.equal(afterExec.ok, false, 'An edit was applied on top of a partially applied command.');
    assert.equal(await disk(path), 'written-by-exec', 'The refused edit changed the file.');
    scenarios.push({
      scenario: 'exec 部分失败',
      evidence: { execFailureReported: true, errorKind: afterExec.meta?.errorKind, diskKeepsExecOutput: true },
      result: 'pass',
    });
  }

  // ─── 11. A restart: what the session still knows ──────────────────────────────────────────────────
  {
    const path = 'restart.txt';
    await writeFile(join(workspace, path), 'before-restart\n', 'utf8');
    await tool('read').execute({ file_path: path }, context(sessionA.id));
    await runner.shutdown();
    runner = await createRunner({
      config: structuredClone(config),
      branding: DEFAULT_BRANDING,
      model: 'acceptance/model',
      llm: idleLlm(),
      skillsDirs: [],
    });
    const afterRestart = await tool('edit').execute({
      file_path: path, old_string: 'before-restart', new_string: 'after-restart',
    }, context(sessionA.id));
    assert.equal(afterRestart.ok, false, 'A restarted process wrote over a file it had not read in this process.');
    assert.equal(await disk(path), 'before-restart\n', 'The refused edit after the restart changed the file.');
    await tool('read').execute({ file_path: path }, context(sessionA.id));
    const reread = await tool('edit').execute({
      file_path: path, old_string: 'before-restart', new_string: 'after-restart',
    }, context(sessionA.id));
    assert.notEqual(reread.ok, false, `The edit after a re-read was refused: ${reread.error}`);
    assert.equal(await disk(path), 'after-restart\n');
    scenarios.push({
      scenario: '进程重启',
      evidence: { refusedKind: afterRestart.meta?.errorKind, recoveredAfterRead: true },
      result: 'pass',
    });
  }

  assert.equal(blockedNetworkAttempts, 0, 'The acceptance attempted network access.');
  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    workspace: { isolated: true, realFiles: true },
    scenarios,
    limits: [
      'Every scenario asserts the bytes on disk, not a tool report; the model is replaced by a '
      + 'controlled double only so tool calls can be placed deterministically.',
      'Checkpoint failure is not exercised here: this acceptance drives the tools directly, and the'
      + ' rollback checkpoint store belongs to the desktop entry point.',
      ...limits,
    ],
    network: { blockedAttempts: blockedNetworkAttempts },
    resources: {
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      rssMiB: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100,
    },
  };
} catch (error) {
  failure = error;
} finally {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.LITTLESHEEP_DATA_DIR;
  else process.env.LITTLESHEEP_DATA_DIR = originalDataDir;
  try { await runner?.shutdown(); } catch (error) { failure ??= error; }
  try { await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { failure ??= error; }
}

if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failure) throw failure;

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => (error ? reject(error) : resolve()));
  });
}

async function stat0(path) {
  const { stat } = await import('node:fs/promises');
  return stat(path);
}

function idleLlm() {
  return {
    async chat() { return { content: '好的。', toolCalls: [], finishReason: 'stop' }; },
    async chatStream(_request, onDelta) {
      onDelta({ type: 'delta', delta: '好的。' });
      onDelta({ type: 'done', finishReason: 'stop' });
      return { content: '好的。', toolCalls: [], finishReason: 'stop' };
    },
    async embed() { return { embeddings: [], model: '', usage: { promptTokens: 0 } }; },
  };
}
