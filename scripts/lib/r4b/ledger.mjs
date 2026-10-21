// Write-once record storage and refuse-by-default ledger writing.
//
// A record file represents exactly one (batch, task, trial) evaluation and is
// immutable: it is written to a temporary sibling and renamed into place, and
// an existing file is never replaced. Interruption tests inject a failing io
// adapter and assert no partial record survives.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertEvaluationRecord, assertLedger, sha256Text } from './contract.mjs';
import { recordFileName } from './trials.mjs';

export const RECORDS_DIR = 'docs/reference/rcd-r4b-v2-records';
export const LEDGER_PATH = 'docs/reference/rcd-r4b-v2-ledger-2026-10-21.json';
export const REPORT_PATH = 'docs/reference/rcd-r4b-v2-report-2026-10-21.md';

export const DEFAULT_IO = Object.freeze({
  exists: (path) => existsSync(path),
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writeFile: (path, data) => writeFileSync(path, data, 'utf8'),
  rename: (from, to) => renameSync(from, to),
  remove: (path) => rmSync(path, { force: true }),
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
});

function nextTempPath(path) {
  return `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
}

function atomicWrite(path, bytes, io, code) {
  const temporary = nextTempPath(path);
  try {
    io.writeFile(temporary, bytes);
    io.rename(temporary, path);
  } catch (error) {
    try { io.remove(temporary); } catch { /* best effort */ }
    const failure = new Error(`${code}: ${error instanceof Error ? error.message : String(error)}`);
    failure.code = code;
    failure.cause = error;
    throw failure;
  }
}

export function writeRecordAtomic({ dir, record, task, options = {}, io = DEFAULT_IO }) {
  assertEvaluationRecord(record, { ...options, task });
  io.mkdir(dir);
  const path = resolve(dir, recordFileName(record.recordId));
  if (io.exists(path)) {
    const error = new Error(`LEDGER_RECORD_EXISTS: refusing to overwrite ${path}`);
    error.code = 'LEDGER_RECORD_EXISTS';
    error.recordPath = path;
    throw error;
  }
  atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`, io, 'LEDGER_RECORD_WRITE_FAILED');
  return { path, sha256: sha256Text(JSON.stringify(record)) };
}

export function readRecords({ dir, tasks = [], options = {} }) {
  const files = ioReadDir(dir).filter((name) => name.endsWith('.json')).sort();
  const records = [];
  const seen = new Set();
  for (const file of files) {
    const path = resolve(dir, file);
    let record;
    try {
      record = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      const failure = new Error(`LEDGER_RECORD_PARSE_FAILED: ${path}: ${error instanceof Error ? error.message : String(error)}`);
      failure.code = 'LEDGER_RECORD_PARSE_FAILED';
      throw failure;
    }
    const task = tasks.find((entry) => entry.id === record.taskId) ?? null;
    assertEvaluationRecord(record, { ...options, task });
    const key = `${record.taskId}:${record.trial}`;
    if (seen.has(key)) {
      const failure = new Error(`LEDGER_DUPLICATE_IDENTITY: ${key}`);
      failure.code = 'LEDGER_DUPLICATE_IDENTITY';
      throw failure;
    }
    seen.add(key);
    records.push({ ...record, recordPath: path.replaceAll('\\', '/') });
  }
  return records;
}

function ioReadDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Write a batch ledger. Existing ledgers are refused by default; an explicit
 * `allowRegenerate` is only for rebuilding a summary from immutable records.
 */
export function writeLedgerAtomic({ path, ledger, options = {}, allowRegenerate = false, io = DEFAULT_IO }) {
  assertLedger(ledger, options);
  io.mkdir(resolve(path, '..'));
  if (!allowRegenerate && io.exists(path)) {
    const error = new Error(`LEDGER_EXISTS: refusing to overwrite ${path}; use --regenerate-ledger to rebuild a summary from immutable records`);
    error.code = 'LEDGER_EXISTS';
    throw error;
  }
  atomicWrite(path, `${JSON.stringify(ledger, null, 2)}\n`, io, 'LEDGER_WRITE_FAILED');
  return { path, sha256: sha256Text(JSON.stringify(ledger)) };
}

/** Build a ledger object from immutable records plus the display-only legacy rows. */
export function buildLedger({ records, batchId, suiteId, metrics, legacy, generatedAt = new Date().toISOString() }) {
  const tiers = new Set(records.map((record) => record.evidenceTier));
  if (tiers.size !== 1) {
    const error = new Error(`MIXED_EVIDENCE_TIER: ledger records span ${[...tiers].join(', ')}`);
    error.code = 'MIXED_EVIDENCE_TIER';
    throw error;
  }
  return {
    schemaVersion: 2,
    contractVersion: '2.0.0',
    suiteId,
    batchId,
    generatedAt,
    evidenceTier: [...tiers][0],
    records,
    metrics,
    legacy,
  };
}
