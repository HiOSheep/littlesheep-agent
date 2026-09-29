import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectEntryReading,
  collectFixturePlans,
  collectFreshnessSurface,
  parseArgs,
} from './report-governance-cost.mjs';

const scriptPath = fileURLToPath(new URL('./report-governance-cost.mjs', import.meta.url));

/**
 * A hook or wrapper can export GIT_DIR / GIT_INDEX_FILE into the test process; left in place they
 * would make the fixture commands act on this repository instead of the throwaway one.
 */
const GIT_ENV = Object.freeze((() => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  return env;
})());

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV, stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit ${result.status}: ${String(result.stderr ?? '').trim()}`);
  }
  return String(result.stdout ?? '').trim();
}

function runScript(root, args) {
  return spawnSync(process.execPath, [scriptPath, `--repo=${root}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

const PROJECT_STATUS = [
  '# 项目状态',
  '',
  '最后更新：2026-09-01 00:00:00',
  '',
  '夹具正文。',
  '',
].join('\n');

const ARCHITECTURE_PRINCIPLES = [
  '# 架构原则',
  '',
  '没有秒级时间行。',
  '',
].join('\n');

const PACKAGE_X_README = [
  '# x 包',
  '',
  '最后更新：2026-09-01 00:00:00',
  '',
].join('\n');

const PACKAGE_Y_README = [
  '# y 包',
  '',
  '没有秒级时间行。',
  '',
].join('\n');

const E1_SOURCE = 'export const wrap = true;\n';

const ENTRY_DOCUMENT = [
  '# 夹具文档入口',
  '',
  '最后更新：2026-09-01 00:00:00',
  '',
  '- [项目状态](decision/project-status.md)',
  '- [架构原则](principles/architecture-principles.md)',
  '- [外部文档](https://example.invalid/guide.md)',
  '- [锚点](#现在先做什么)',
  '- [非 Markdown 附件](reference/notes.txt)',
  '- [尚未落盘的文档](reference/no-such-document.md)',
  '',
].join('\n');

const FIXTURE_FILES = Object.freeze({
  'docs/README.md': ENTRY_DOCUMENT,
  'docs/decision/project-status.md': PROJECT_STATUS,
  'docs/principles/architecture-principles.md': ARCHITECTURE_PRINCIPLES,
  'docs/reference/notes.txt': 'not markdown\n',
  'packages/x/README.md': PACKAGE_X_README,
  'packages/y/README.md': PACKAGE_Y_README,
  'packages/app/src/renderer/ui/code-wrap-preference.ts': E1_SOURCE,
});

async function createFixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), 'ls-governance-cost-'));
  for (const [path, content] of Object.entries(FIXTURE_FILES)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }
  git(root, ['init', '-q']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'governance cost fixture']);
  return root;
}

describe('governance cost pilot report', () => {
  it('parses the documented CLI surface', () => {
    expect(parseArgs(['--repo=somewhere', '--base=abc123', '--out=report.json', '--fixtures=fixtures.json']))
      .toMatchObject({
        repo: 'somewhere',
        base: 'abc123',
        out: 'report.json',
        fixtures: 'fixtures.json',
        help: false,
      });
    expect(() => parseArgs(['--sample=dirty'])).toThrow(/Unknown option/u);
  });

  it('reads the entry documents linked from docs/README.md with bytes and sha256', async () => {
    const root = await createFixtureRepository();
    try {
      const reading = collectEntryReading(root);

      expect(reading.documents.map((document) => document.path)).toEqual([
        'docs/decision/project-status.md',
        'docs/principles/architecture-principles.md',
        'docs/reference/no-such-document.md',
      ]);
      expect(reading.missing).toEqual(['docs/reference/no-such-document.md']);

      const projectStatus = reading.documents[0];
      expect(projectStatus).toMatchObject({
        exists: true,
        bytes: Buffer.byteLength(PROJECT_STATUS),
        sha256: createHash('sha256').update(PROJECT_STATUS).digest('hex'),
      });
      const principles = reading.documents[1];
      expect(principles).toMatchObject({
        exists: true,
        bytes: Buffer.byteLength(ARCHITECTURE_PRINCIPLES),
        sha256: createHash('sha256').update(ARCHITECTURE_PRINCIPLES).digest('hex'),
      });
      expect(reading.documents[2]).toEqual({
        path: 'docs/reference/no-such-document.md',
        exists: false,
      });

      // External links, anchors and non-Markdown targets never enter the reading set.
      expect(reading.documents).toHaveLength(3);
      expect(reading.totalBytes)
        .toBe(Buffer.byteLength(PROJECT_STATUS) + Buffer.byteLength(ARCHITECTURE_PRINCIPLES));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('counts the tracked second-precision stamp surface per group', async () => {
    const root = await createFixtureRepository();
    try {
      const freshness = collectFreshnessSurface(root);

      expect(freshness.stampPattern).toContain('最后更新');
      expect(freshness.candidateDocsCount).toBe(3);
      expect(freshness.trackedPackagesReadmeCount).toBe(2);
      expect(freshness.matchedFileCount).toBe(3);
      expect(freshness.matchedDocsCount).toBe(2);
      expect(freshness.matchedPackagesCount).toBe(1);
      expect(freshness.matchedPaths).toEqual([
        'docs/README.md',
        'docs/decision/project-status.md',
        'packages/x/README.md',
      ]);
      expect(freshness.matchedBytes).toBe(
        Buffer.byteLength(ENTRY_DOCUMENT)
          + Buffer.byteLength(PROJECT_STATUS)
          + Buffer.byteLength(PACKAGE_X_README),
      );
      expect(freshness.unreadable).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the deterministic plan mode for fixture file lists', async () => {
    const root = await createFixtureRepository();
    try {
      const head = git(root, ['rev-parse', 'HEAD']);
      const plans = await collectFixturePlans(root, head, [
        { id: 'E1', files: ['packages/app/src/renderer/ui/code-wrap-preference.ts'] },
        { id: 'DOCS', files: ['docs/README.md'] },
        { id: 'E1-DELETED', files: ['packages/app/src/renderer/ui/absent.ts'] },
      ]);

      expect(plans).toEqual([
        { id: 'E1', mode: 'related', fullTests: false, appBuildSensitive: true, relatedCount: 1 },
        { id: 'DOCS', mode: 'skip', fullTests: false, appBuildSensitive: false, relatedCount: 0 },
        { id: 'E1-DELETED', mode: 'changed-fallback', fullTests: false, appBuildSensitive: true, relatedCount: 1 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed with a readable reason when the base ref cannot be resolved', async () => {
    const root = await createFixtureRepository();
    try {
      const result = runScript(root, ['--base=refs/heads/does-not-exist']);

      expect(result.status).not.toBe(0);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('[governance-cost] Cannot resolve Git merge-base');
      expect(result.stderr).toContain('refs/heads/does-not-exist');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed instead of reporting an empty verification surface when the selector cannot run', async () => {
    const root = await createFixtureRepository();
    try {
      const result = runScript(root, ['--base=HEAD']);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('[governance-cost] Affected-verification selector failed');
      expect(result.stderr).toContain('scripts/run-affected-verification.mjs');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
