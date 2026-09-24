// One bounded report of what a checkpoint directory holds right now.
//
// A scan is a query, so its counts and its per-record findings describe the
// directory as it is at that moment. They used to accumulate for the whole
// process lifetime inside the store, which made every repeated check inflate the
// same finding: after one failed startup discovery and one user retry the desktop
// app told the user "2 份恢复记录无法读取" for a single unreadable file. Findings
// that a scan cannot see for itself (stale temporary files, pruning, directory
// I/O) are kept by the caller instead of being re-derived here.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunCheckpoint } from '@littlesheep/types';
import {
  MAX_LEGACY_CONTEXT_SNAPSHOT_IDS,
  checkpointFileHash,
  errorMessage,
  idFromFileName,
  validateCheckpoint,
} from './run-checkpoint-codec.js';
import { RunCheckpointValidationError } from './run-checkpoint-errors.js';

export interface RunCheckpointDiagnostic {
  kind: 'corrupt' | 'incompatible' | 'temporary' | 'invalid_name' | 'io';
  file: string;
  message: string;
  recordedAt: string;
}

export interface RunCheckpointStoreDiagnostics {
  rootDir: string;
  scannedFiles: number;
  readFiles: number;
  validFiles: number;
  /** Records the last scan could not read or validate, counted once per file. */
  invalidFiles: number;
  /** Findings that do not describe one of those records; see `RunCheckpointScanReport`. */
  warningFindings: RunCheckpointDiagnostic[];
  diagnostics: RunCheckpointDiagnostic[];
}

export interface RunCheckpointStoredRecord {
  checkpoint: RunCheckpoint;
  file: string;
  modifiedAt: number;
}

export interface RunCheckpointScanReport {
  records: RunCheckpointStoredRecord[];
  /** Findings that belong to a file counted in `invalidFiles`. */
  recordFindings: RunCheckpointDiagnostic[];
  /** Findings about the directory itself: listing, stat, caps, unreadable names. */
  warningFindings: RunCheckpointDiagnostic[];
  scannedFiles: number;
  readFiles: number;
  validFiles: number;
  invalidFiles: number;
}

export interface RunCheckpointScanOptions {
  rootDir: string;
  maxFileBytes: number;
  maxReadEntries: number;
  now: () => Date;
}

export interface RunCheckpointRecordRead {
  kind: 'missing' | 'valid' | 'invalid';
  record?: RunCheckpointStoredRecord;
  /** Empty unless the read produced a finding of its own. */
  findings: RunCheckpointDiagnostic[];
}

/** Scan the directory and report this pass only. */
export async function scanRunCheckpointDirectory(options: RunCheckpointScanOptions): Promise<RunCheckpointScanReport> {
  const report: RunCheckpointScanReport = {
    records: [],
    recordFindings: [],
    warningFindings: [],
    scannedFiles: 0,
    readFiles: 0,
    validFiles: 0,
    invalidFiles: 0,
  };
  await mkdir(options.rootDir, { recursive: true });
  let entries;
  try {
    entries = await readdir(options.rootDir, { withFileTypes: true });
  } catch (error) {
    report.warningFindings.push(finding(options, 'io', options.rootDir, `Unable to list checkpoints: ${errorMessage(error)}`));
    return report;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(options.rootDir, entry.name));
  report.scannedFiles += files.length;
  const filesByAge: Array<{ file: string; modifiedAt: number }> = [];
  for (const file of files) {
    try {
      filesByAge.push({ file, modifiedAt: (await stat(file)).mtimeMs });
    } catch (error) {
      report.warningFindings.push(finding(options, 'io', file, `Unable to stat checkpoint: ${errorMessage(error)}`));
    }
  }
  filesByAge.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const boundedFiles = filesByAge.slice(0, options.maxReadEntries).map((entry) => entry.file);
  if (files.length > boundedFiles.length) {
    report.warningFindings.push(finding(options, 'io', options.rootDir, `Checkpoint scan capped at ${options.maxReadEntries} files.`));
  }
  for (const file of boundedFiles) {
    const result = await readRunCheckpointRecord({ ...options, file });
    report.readFiles += result.kind === 'missing' ? 0 : 1;
    if (result.kind === 'valid' && result.record) {
      report.validFiles += 1;
      report.records.push(result.record);
    } else if (result.kind === 'invalid') {
      report.invalidFiles += 1;
      report.recordFindings.push(...result.findings);
    } else {
      report.warningFindings.push(...result.findings);
    }
  }
  return report;
}

/**
 * Read one checkpoint file.
 *
 * The findings belong to the file and are returned instead of stored, so a caller
 * that keeps a ledger and a caller that reports one scan can both use this without
 * agreeing on what a counter means.
 */
export async function readRunCheckpointRecord(
  options: Omit<RunCheckpointScanOptions, 'rootDir' | 'maxReadEntries'> & { file: string; expectedId?: string },
): Promise<RunCheckpointRecordRead> {
  const { file } = options;
  if (!existsSync(file)) return { kind: 'missing', findings: [] };
  let raw: string;
  try {
    const details = await stat(file);
    if (details.size > options.maxFileBytes) {
      return {
        kind: 'invalid',
        findings: [finding(options, 'corrupt', file, `Checkpoint file exceeds the ${options.maxFileBytes}-byte limit.`)],
      };
    }
    raw = await readFile(file, 'utf8');
  } catch (error) {
    return { kind: 'invalid', findings: [finding(options, 'io', file, `Unable to read checkpoint: ${errorMessage(error)}`)] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { kind: 'invalid', findings: [finding(options, 'corrupt', file, `Invalid checkpoint JSON: ${errorMessage(error)}`)] };
  }
  try {
    const checkpoint = validateCheckpoint(parsed, options.maxFileBytes, MAX_LEGACY_CONTEXT_SNAPSHOT_IDS);
    if (options.expectedId !== undefined && checkpoint.id !== options.expectedId) {
      return {
        kind: 'invalid',
        findings: [finding(options, 'invalid_name', file, 'Checkpoint id does not match its hashed filename lookup.')],
      };
    }
    if (checkpointFileHash(checkpoint.id) !== idFromFileName(file)) {
      return {
        kind: 'invalid',
        findings: [finding(options, 'invalid_name', file, 'Checkpoint filename hash does not match the stored checkpoint id.')],
      };
    }
    const details = await stat(file);
    return { kind: 'valid', record: { checkpoint, file, modifiedAt: details.mtimeMs }, findings: [] };
  } catch (error) {
    const kind = error instanceof RunCheckpointValidationError && /version/i.test(error.message)
      ? 'incompatible'
      : 'corrupt';
    return { kind: 'invalid', findings: [finding(options, kind, file, errorMessage(error))] };
  }
}

/** Newest first by recorded creation time, then by file modification time. */
export function compareCheckpointRecordsNewest(
  left: RunCheckpointStoredRecord,
  right: RunCheckpointStoredRecord,
): number {
  const time = Date.parse(right.checkpoint.createdAt) - Date.parse(left.checkpoint.createdAt);
  return time || right.modifiedAt - left.modifiedAt;
}

function finding(
  options: Pick<RunCheckpointScanOptions, 'now'>,
  kind: RunCheckpointDiagnostic['kind'],
  file: string,
  message: string,
): RunCheckpointDiagnostic {
  return { kind, file, message, recordedAt: options.now().toISOString() };
}
