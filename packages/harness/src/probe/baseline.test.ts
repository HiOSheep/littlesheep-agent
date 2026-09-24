// SP-08 baseline probe runner.
//
// Usage:
//   npx vitest run packages/harness/src/probe/baseline.test.ts
//
// Writes a per-request shape report for every frozen load to
// `docs/reference/cache-baseline/latest.md`, so the same probe can be run against
// a different checkout or commit and the two reports compared line by line. Copy
// the file to a `baseline-<freeze>.md` name to freeze a comparison; the probe
// itself only ever writes `latest.md` plus the per-load JSON beside it.
//
// The reports are deterministic and Provider-free apart from the timestamp line
// every document in `docs/` must carry. They contain request character counts,
// shared-prefix characters and tool-catalog digests -- no prompt text, no session
// content, no keys.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROZEN_LOADS, type ProbeReport } from './frozen-load.js';

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/reference/cache-baseline',
);

/** The implementation version this report describes. */
const FREEZE = process.env.LS_BASELINE_FREEZE ?? currentCommit();

function currentCommit(): string {
  try {
    return `git ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()}`;
  } catch {
    return 'unknown (git unavailable)';
  }
}

async function runAll(): Promise<ProbeReport[]> {
  const reports: ProbeReport[] = [];
  for (const load of FROZEN_LOADS) {
    reports.push(await load.run({ probe: load.name, freeze: FREEZE }));
  }
  return reports;
}

function render(reports: ProbeReport[]): string {
  // Every document under `docs/` must carry a second-precision update line and at
  // least one Chinese line; the numbers themselves stay deterministic.
  const updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lines: string[] = [
    '# Cache request-shape baseline',
    '',
    `最后更新：${updatedAt}`,
    '',
    `Freeze: ${FREEZE}`,
    '',
    '本文件由 `packages/harness/src/probe/baseline.test.ts` 在每次 harness 测试运行时重新生成：',
    '只统计请求字符数、共享前缀字符数与工具目录摘要，不调用供应商，也不含提示词正文或会话内容。',
  ];
  for (const report of reports) {
    lines.push(
      '',
      `## Load: ${report.probe}`,
      '',
      `- model: ${report.model}`,
      `- tools: ${report.toolNames.join(', ')}`,
      '',
      '| # | request | chars | messages | shared prefix (chars) | shared ratio | stable head | catalog |',
      '| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    );
    for (const request of report.requests) {
      lines.push(
        `| ${request.index} | ${request.label} | ${request.characters} | ${request.messages} `
        + `| ${request.sharedPrefixCharacters ?? '-'} | ${request.sharedPrefixRatio ?? '-'} `
        + `| ${request.stableHeadCharacters} | ${request.catalog} |`,
      );
    }
  }
  lines.push(
    '',
    'Character counts only. No token estimate, no cost estimate, and no Provider',
    'cache-hit evidence: this probe never calls a Provider.',
    '',
  );
  return lines.join('\n');
}

describe('cache baseline probe', () => {
  it('records the request shape of every frozen load', async () => {
    const reports = await runAll();
    mkdirSync(OUT_DIR, { recursive: true });

    const summary = render(reports);
    writeFileSync(join(OUT_DIR, 'latest.md'), summary, 'utf8');
    // Only the rendered report is written: the per-load JSON dumps had no reader (the
    // numbers are all in latest.md) and were removed as unreferenced artefacts.
    // The probe is only a baseline when it actually produced requests.
    for (const report of reports) {
      expect(report.requests.length, `${report.probe} produced requests`).toBeGreaterThan(0);
    }
    expect(summary).toContain('Cache request-shape baseline');
    expect(readFileSync(join(OUT_DIR, 'latest.md'), 'utf8')).toBe(summary);
  });
});
