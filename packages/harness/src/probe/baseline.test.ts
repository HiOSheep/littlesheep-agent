// SP-08 baseline probe runner.
//
// Usage:
//   npx vitest run packages/harness/src/probe/baseline.test.ts
//
// Writes a per-request shape report for every frozen load to
// `docs/taskbooks/cache-baseline/`, so the same probe can be run against a
// different checkout or commit and the two reports compared line by line.
//
// The reports are deterministic and Provider-free. They contain request
// character counts, shared-prefix characters and tool-catalog digests -- no
// prompt text, no session content, no keys.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FROZEN_LOADS, type ProbeReport } from './frozen-load.js';

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/taskbooks/cache-baseline',
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
  const lines: string[] = [
    '# Cache request-shape baseline',
    '',
    `Freeze: ${FREEZE}`,
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
    // Pin this freeze's report under its own name too, so re-running the probe
    // never overwrites the record a comparison was made against.
    writeFileSync(
      join(OUT_DIR, `baseline-${FREEZE.replace(/[^A-Za-z0-9._-]+/gu, '-')}.md`),
      summary,
      'utf8',
    );
    for (const report of reports) {
      writeFileSync(
        join(OUT_DIR, `${report.probe}.json`),
        `${JSON.stringify(report, null, 2)}\n`,
        'utf8',
      );
    }
    // The probe is only a baseline when it actually produced requests.
    for (const report of reports) {
      expect(report.requests.length, `${report.probe} produced requests`).toBeGreaterThan(0);
    }
    expect(summary).toContain('Cache request-shape baseline');
    expect(readFileSync(join(OUT_DIR, 'latest.md'), 'utf8')).toBe(summary);
  });
});
