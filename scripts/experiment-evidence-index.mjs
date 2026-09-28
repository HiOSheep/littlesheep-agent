#!/usr/bin/env node
// Evidence index for the runtime-autonomy experiment.
//
// RA-01 corrected two things about the previous index: it was produced by an ad-hoc shell command rather
// than a re-runnable entry, and it listed a hash for itself, which cannot be stable because writing the
// index changes the index. This entry excludes itself from the table and names that exclusion explicitly,
// so a reader cannot mistake a missing self-hash for tampering.
//
// It also writes the correction projection for the first round's ledger: those records carry placeholder
// backend and retry values that were written before the facts were collected. The originals are never
// edited — the projection is a separate file that says which fields are unknown and why.
//
// Usage: node scripts/experiment-evidence-index.mjs [--evidence=<dir>] [--check]
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readJsonLines, sha256File, writeJson } from './lib/experiment-ledger.mjs';

const SELF = 'experiment-evidence-index.mjs';

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    args[key] = value ?? true;
  }
  return args;
}

function walk(dir, root = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, root, out);
    else if (entry.isFile()) out.push(relative(root, path).replaceAll('\\', '/'));
  }
  return out;
}

/**
 * The fields the first round wrote as constants. A record that carries them is not wrong about what the
 * run did — it is silent about it, and silence must read as `unknown` rather than as `host`.
 */
const PLACEHOLDER_FIELDS = ['requestedBackend', 'actualBackend', 'retries'];

function correctionProjection(evidenceDir, ledgerName) {
  const ledgerPath = join(evidenceDir, ledgerName);
  if (!existsSync(ledgerPath)) return { generated: false, reason: 'no ledger found' };
  const records = readJsonLines(ledgerPath);
  const corrections = [];
  for (const [index, record] of records.entries()) {
    // Only the batches written before RA-01 carried the constants; a record that has backendEvidence was
    // produced by the corrected entry and is left alone.
    if (record.backendEvidence) continue;
    const fields = {};
    for (const field of PLACEHOLDER_FIELDS) {
      if (record[field] !== undefined) {
        fields[field] = {
          recordedValue: record[field],
          correctedValue: 'unknown',
          reason: field === 'retries'
            ? 'written as a constant before retry counters were collected'
            : 'written as the constant "host" regardless of the backend that ran',
        };
      }
    }
    if (Object.keys(fields).length === 0) continue;
    corrections.push({
      ledgerLine: index + 1,
      batchId: record.batchId,
      caseId: record.caseId,
      arm: record.arm,
      trial: record.trial,
      runId: record.runId ?? null,
      source: 'ledger.jsonl (first round, pre-RA-01)',
      fields,
    });
  }
  const path = join(evidenceDir, 'ledger-corrections.jsonl');
  const body = corrections.map((entry) => JSON.stringify(entry)).join('\n');
  writeJson(join(evidenceDir, 'ledger-corrections-summary.json'), {
    generatedAt: new Date().toISOString(),
    ledger: ledgerName,
    records: records.length,
    correctedRecords: corrections.length,
    fields: PLACEHOLDER_FIELDS,
    note: 'The original ledger is never rewritten. These records carry constants instead of measured values; treat the named fields as unknown.',
  });
  return {
    generated: true,
    path,
    records: records.length,
    correctedRecords: corrections.length,
    body,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceDir = args.evidence ?? process.env.LS_EXPERIMENT_EVIDENCE_DIR ?? 'D:\\littlesheep-evidence\\RASB-2026-09-27';
  if (!existsSync(evidenceDir)) {
    process.stderr.write(`evidence directory not found: ${evidenceDir}\n`);
    process.exitCode = 2;
    return;
  }
  const ledgerName = args.ledger ? relative(evidenceDir, args.ledger) : 'ledger.jsonl';
  const projection = correctionProjection(evidenceDir, ledgerName);
  if (projection.generated) {
    writeFileSync(projection.path, `${projection.body}\n`, 'utf8');
  }

  const files = walk(evidenceDir)
    .filter((file) => !file.endsWith(SELF) && file !== 'EVIDENCE-INDEX.md')
    .filter((file) => !file.startsWith('raw-runs/') || file.endsWith('result-summary.json') || file.endsWith('sandbox-audit.jsonl'))
    .sort();
  const rows = files.map((file) => {
    const path = join(evidenceDir, file);
    const stat = statSync(path);
    return { file, bytes: stat.size, sha256: sha256File(path) };
  });

  const lines = [
    '# RASB-2026-09-27 证据索引',
    '',
    `生成：${new Date().toISOString()}；根目录 \`${evidenceDir}\`（仓库外，含真实运行数据）。`,
    '',
    '本索引由 `scripts/experiment-evidence-index.mjs` 生成，**不含自身**：写索引会改变索引，所以自哈希没有稳定值。',
    '缺失的是这一条，不是其他证据；原始目录仍可用 `Get-FileHash` 独立核对任何一项。',
    '',
    `账本 ${projection.records ?? 0} 条；第一轮占位字段被纠正的记录 ${projection.correctedRecords ?? 0} 条，见 \`ledger-corrections.jsonl\`（原账本不重写）。`,
    '',
    '| 文件 | 字节 | sha256 |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.file} | ${row.bytes} | ${row.sha256} |`),
    '',
  ];
  const text = lines.join('\n');
  if (args.check) {
    const current = join(evidenceDir, 'EVIDENCE-INDEX.md');
    const previous = existsSync(current) ? readFileSync(current, 'utf8') : '';
    process.stdout.write(`${current} ${previous === text ? 'is up to date' : 'is stale, re-run without --check'}\n`);
    process.exitCode = previous === text ? 0 : 1;
    return;
  }
  writeFileSync(join(evidenceDir, 'EVIDENCE-INDEX.md'), text, 'utf8');
  process.stdout.write(`index: ${rows.length} files, ${text.length} bytes; corrections: ${projection.correctedRecords ?? 0}\n`);
}

main();
