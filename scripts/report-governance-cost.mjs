#!/usr/bin/env node
//
// Governance-cost pilot measurement for the repository agent constraints slimming work
// (formerly the 2026-09-28 taskbook, GA-04 in its section 4 and the comparison plan in
// section 5; the taskbook is retired and its surviving facts live in
// docs/decision/project-status.md). It is a read-only, deterministic measurement of two
// static facts a coding agent pays for under the current rule package:
//
//   (a) entry reading   — which local Markdown documents docs/README.md points at, their bytes and
//                         SHA-256, so "how much must be read to start" is a number, not an opinion
//   (b) verification surface — what the affected-verification selector chooses for the current tree,
//                         plus the same plan for explicit change fixtures
//
// It is NOT the paired coding-agent experiment section 5 describes: no sessions, no model calls, no
// completion-rate, wall-clock or token data. The report is a fixed schema so two runs can be diffed.
// Unavailable fields are reported as null with a note; nothing here is estimated.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitMergeBase } from './lib/affected-verification-base.mjs';
import { createAffectedTestPlan, isAppBuildSensitivePath } from './lib/affected-verification-inputs.mjs';
import {
  discoverWorkspaceProjects,
  includeDependents,
  normalizeRepoPath,
  projectsForFiles,
} from './workspace-projects.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), '..');
const ENTRY_DOCUMENT = 'docs/README.md';
const SELECTOR_SCRIPT = 'scripts/run-affected-verification.mjs';
const ENTRY_LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g;
const EXTERNAL_LINK_PATTERN = /^[a-z][a-z\d+.-]*:/iu;
const selectorMaxBuffer = 32 * 1024 * 1024;

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    repo: null,
    base: process.env.LITTLESHEEP_BASE_REF || 'origin/main',
    out: null,
    fixtures: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      index += 1;
      return value;
    };

    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--repo') options.repo = nextValue();
    else if (arg.startsWith('--repo=')) options.repo = arg.slice('--repo='.length);
    else if (arg === '--base') options.base = nextValue();
    else if (arg.startsWith('--base=')) options.base = arg.slice('--base='.length);
    else if (arg === '--out') options.out = nextValue();
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg === '--fixtures') options.fixtures = nextValue();
    else if (arg.startsWith('--fixtures=')) options.fixtures = arg.slice('--fixtures='.length);
    else throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
  }

  if (typeof options.base !== 'string' || options.base.trim() === '') {
    throw new Error('--base must be a non-empty Git ref.');
  }
  return options;
}

function usage() {
  return [
    'Measure the static governance cost of the current rule package (read-only pilot, not a gate).',
    '',
    'Usage:',
    `  node scripts/report-governance-cost.mjs [--repo=<path>] [--base=<ref>] [--out=<json path>] [--fixtures=<json path>]`,
    '',
    `Defaults: --repo is this repository, --base is origin/main (or LITTLESHEEP_BASE_REF).`,
    'Without --out the JSON report goes to stdout; with --out it is written there.',
    '--fixtures points at {"fixtures":[{"id":"E1","files":["packages/..."]}]} and adds the',
    'affected-verification plan each fixture file list would select.',
    '',
    'This is a deterministic pilot measurement of entry reading and',
    'verification selection. It is not the multi-session coding-agent A/B experiment and not a',
    'product gate: it says nothing about completion rate, wall-clock time or token usage.',
  ].join('\n');
}

function runGit(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' });
  if (result.error) {
    throw new Error(`Cannot run git in ${repoRoot}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? '').trim();
    throw new Error(`git ${args.join(' ')} failed with exit ${result.status}.${detail ? ` ${detail}` : ''}`);
  }
  return String(result.stdout ?? '');
}

function comparePaths(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * (a) Documents the entry page points at. Only local Markdown files count: external links, anchors
 * and non-Markdown targets are skipped, and a linked file that is absent is reported as
 * `exists: false` instead of being dropped or estimated.
 */
export function collectEntryReading(repoRoot) {
  const indexPath = resolve(repoRoot, ENTRY_DOCUMENT);
  if (!existsSync(indexPath)) {
    throw new Error(`Entry document ${ENTRY_DOCUMENT} not found under ${repoRoot}; entry reading cannot be measured.`);
  }

  const content = readFileSync(indexPath, 'utf8');
  const seen = new Set();
  const documents = [];
  const missing = [];

  for (const match of content.matchAll(ENTRY_LINK_PATTERN)) {
    const rawTarget = match[1].trim().replace(/^<|>$/gu, '');
    if (!rawTarget || rawTarget.startsWith('#') || rawTarget.startsWith('//')) continue;
    if (EXTERNAL_LINK_PATTERN.test(rawTarget)) continue;

    const withoutFragment = rawTarget.split('#', 1)[0].split('?', 1)[0];
    if (!withoutFragment) continue;
    let target = withoutFragment;
    try {
      target = decodeURIComponent(withoutFragment);
    } catch {
      target = withoutFragment;
    }
    if (!/\.md$/iu.test(target)) continue;

    const absolute = resolve(dirname(indexPath), target);
    const repoPath = normalizeRepoPath(relative(repoRoot, absolute));
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);

    if (!existsSync(absolute)) {
      documents.push({ path: repoPath, exists: false });
      missing.push(repoPath);
      continue;
    }
    const buffer = readFileSync(absolute);
    documents.push({
      path: repoPath,
      exists: true,
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    });
  }

  documents.sort((left, right) => comparePaths(left.path, right.path));
  missing.sort(comparePaths);
  const totalBytes = documents.reduce((sum, document) => sum + (document.bytes ?? 0), 0);
  return { documents, totalBytes, missing };
}

/**
 * (b) What the affected-verification selector picks for the current tree. The selector stays the
 * single authority; this only projects its JSON onto counts so two rule packages can be diffed.
 * A selector that cannot run is a hard failure: an empty surface would read as "nothing to verify".
 */
export function collectVerificationSurface(repoRoot, base) {
  const args = [SELECTOR_SCRIPT, '--list', '--json', `--base=${base}`];
  const display = `node ${args.join(' ')}`;
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: selectorMaxBuffer,
  });
  if (result.error) {
    throw new Error(`Affected-verification selector could not be started (${display}): ${result.error.message}`);
  }
  const stderr = String(result.stderr ?? '').trim();
  if (result.status !== 0) {
    throw new Error(
      `Affected-verification selector failed (${display}) with exit ${result.status}.`
        + `${stderr ? ` ${stderr}` : ''}`,
    );
  }

  let plan;
  try {
    plan = JSON.parse(String(result.stdout ?? ''));
  } catch (error) {
    throw new Error(`Affected-verification selector did not print JSON (${display}): ${error instanceof Error ? error.message : String(error)}`);
  }

  const count = (value) => (Array.isArray(value) ? value.length : null);
  return {
    command: display,
    exitCode: result.status,
    changedFileCount: count(plan.changedFiles),
    affectedPackageCount: count(plan.affectedPackages),
    typecheckConfigPathCount: count(plan.typecheckConfigPaths),
    testPlanMode: typeof plan.testPlan?.mode === 'string' ? plan.testPlan.mode : null,
    appBuildSensitive: typeof plan.appBuildSensitive === 'boolean' ? plan.appBuildSensitive : null,
  };
}

/** Machine-readable fixture input: {"fixtures":[{"id":"E1","files":["packages/..."]}]}. */
export function loadFixtureFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read --fixtures file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.fixtures)) {
    throw new Error('--fixtures must be a JSON object with a "fixtures" array.');
  }
  return parsed.fixtures.map((fixture, index) => {
    if (!fixture || typeof fixture !== 'object') {
      throw new Error(`fixtures[${index}] must be an object with "id" and "files".`);
    }
    if (typeof fixture.id !== 'string' || fixture.id.trim() === '') {
      throw new Error(`fixtures[${index}] needs a non-empty string "id".`);
    }
    if (!Array.isArray(fixture.files) || fixture.files.length === 0
      || fixture.files.some((file) => typeof file !== 'string' || file.trim() === '')) {
      throw new Error(`fixture ${fixture.id} needs "files" as a non-empty array of repository-relative paths.`);
    }
    return {
      id: fixture.id,
      files: [...new Set(fixture.files.map((file) => normalizeRepoPath(file.trim())))].sort(comparePaths),
    };
  });
}

/**
 * The plan a fixture's file list would select. This calls the selector's own planning functions with
 * the same inputs the selector builds for a synthetic sample (`{}` options), instead of faking a
 * dirty tree, because a fixture describes a change that is not present in this worktree.
 */
export async function collectFixturePlans(repoRoot, base, fixtures) {
  const projects = await discoverWorkspaceProjects(repoRoot);
  return fixtures.map((fixture) => {
    const plan = createAffectedTestPlan(fixture.files, base, repoRoot, {});
    const affectedPackages = includeDependents(projects, projectsForFiles(projects, fixture.files));
    return {
      id: fixture.id,
      mode: plan.mode,
      fullTests: plan.fullTests,
      appBuildSensitive: fixture.files.some((file) => isAppBuildSensitivePath(file, affectedPackages)),
      relatedCount: plan.relatedTestRelevantFiles.length,
    };
  });
}

function collectNullFields(value, prefix = '') {
  if (value === null) return [prefix || '(root)'];
  if (Array.isArray(value) || typeof value !== 'object') return [];
  const fields = [];
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'notes') continue;
    fields.push(...collectNullFields(entry, prefix ? `${prefix}.${key}` : key));
  }
  return fields;
}

function buildNotes(options, report) {
  const notes = [
    '这是确定性的静态治理成本试点测量，只覆盖两类可复核事实：入口阅读量和验证选择面。它不是任务书第 5 节的多会话 coding-agent A/B 对照：没有会话、没有模型调用，也没有完成率、墙钟耗时或 token 数字，因此不得据此宣称效率提升或统计显著。',
    '真实多会话 A/B 对照未执行（受本次会话成本与客户端限制）；结论只覆盖本报告内可复核的静态治理成本，不代表规则包候选的正确性或安全性。',
    '本脚本只读工作树、不访问网络、不调用任何 Provider；唯一写入是 --out 指定的报告文件。',
    'entryReading 只统计 docs/README.md 链接到的本地 Markdown 文档；入口文档自身的字节不重复计入。',
    `verificationSurface 来自 ${report.verificationSurface.command}，只记录数量、testPlan.mode 与 appBuildSensitive，不记录具体文件清单。`,
  ];
  const { missing } = report.entryReading;
  if (missing.length > 0) {
    notes.push(`入口链接中有 ${missing.length} 份本地 Markdown 在当前工作树不存在，按 exists:false 记入 missing、不做估算：${missing.join(', ')}。`);
  }
  if (options.fixtures) {
    notes.push('fixtures 的计划由 createAffectedTestPlan(files, baseResolved, repo, {}) 与 isAppBuildSensitivePath(file, <该 fixture 的受影响包集合>) 直接计算，不经过 selector 的 --changed 路径；fixture 只描述文件清单，不代表真实改动已经存在。');
  } else {
    notes.push('本次未提供 --fixtures，fixtures 为空数组。');
  }
  const nullFields = collectNullFields(report);
  if (nullFields.length > 0) {
    notes.push(`以下字段无法从现有输入取得，按 null 记录、未做估算：${nullFields.join(', ')}。`);
  }
  return notes;
}

export async function createReport(options) {
  const repoRoot = resolve(options.repo ?? defaultRepoRoot);
  if (!existsSync(repoRoot)) {
    throw new Error(`--repo does not exist: ${repoRoot}`);
  }
  const repoHead = runGit(repoRoot, ['rev-parse', 'HEAD']).trim() || null;
  // Fail closed before measuring anything else: a base that cannot be resolved would silently
  // shrink the verification surface to the working tree alone.
  const baseResolved = resolveGitMergeBase(options.base, repoRoot);

  const report = {
    schemaVersion: 1,
    report: 'governance-cost',
    measuredAt: new Date().toISOString(),
    repoHead,
    base: options.base,
    baseResolved,
    entryReading: collectEntryReading(repoRoot),
    verificationSurface: collectVerificationSurface(repoRoot, options.base),
    fixtures: options.fixtures ? await collectFixturePlans(repoRoot, baseResolved, loadFixtureFile(options.fixtures)) : [],
    notes: [],
  };
  report.notes = buildNotes(options, report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[governance-cost] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    const report = await createReport(options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) {
      const outPath = resolve(options.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, output, 'utf8');
      console.error(`[governance-cost] wrote ${outPath}`);
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    console.error(`[governance-cost] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    console.error(`[governance-cost] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
