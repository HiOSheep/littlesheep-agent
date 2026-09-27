// Checkpoint manifest persistence, interrupted-run recovery and bounded pruning.
//
// Owns the files under `backups/versioning/`: one JSON manifest per checkpoint, a record per *unfinished*
// checkpoint whose name is the checkpoint id, and the retention pass. It does not decide what a checkpoint
// means — the transaction flow is git-checkpoint.ts, and the path rules are git-checkpoint-files.ts.
//
// The start path is the reason this is a separate module with its own vocabulary. A start has to know whether
// any checkpoint is unfinished, and the obvious implementation — read and JSON-parse every manifest — costs one
// file read per retained checkpoint on every launch, on the path to execution readiness. Two rules replace it:
//
//   * an unfinished checkpoint is announced by a file in `pending-runs/`, written *before* its manifest, so
//     recovery reads that directory (normally empty) and nothing else. A record whose manifest does not exist
//     yet is the crash window between the two writes and is simply dropped. A data root from before this record
//     existed has no such directory; that is detected once and falls back to the full scan, so an interrupted
//     run from the previous version is still recovered.
//   * retention reads modification times only once the directory has run past the cap by a slack, and then
//     deletes all the way back down. That pays the pass once per slack checkpoints instead of once per start,
//     while still bounding what is kept on disk.
import { readFile, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { VersionCheckpointManifest } from '@littlesheep/types';
import { atomicJsonWrite, listJsonFiles, pathExists } from './git-checkpoint-files.js';

/**
 * How far past `maxCheckpoints` the manifest directory may grow before modification times are read again.
 */
const PRUNE_SLACK = 32;

export const RECOVERED_INCOMPLETE_CHECKPOINT = 'recovered-incomplete-checkpoint';

export interface CheckpointManifestStoreOptions {
  manifestsDir: string;
  pendingRunsDir: string;
  maxCheckpoints: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export class CheckpointManifestStore {
  private readonly manifestsDir: string;
  private readonly pendingRunsDir: string;
  private readonly maxCheckpoints: number;
  private readonly log?: CheckpointManifestStoreOptions['log'];

  constructor(options: CheckpointManifestStoreOptions) {
    this.manifestsDir = options.manifestsDir;
    this.pendingRunsDir = options.pendingRunsDir;
    this.maxCheckpoints = options.maxCheckpoints;
    this.log = options.log;
  }

  manifestPath(id: string): string {
    return join(this.manifestsDir, `${id}.json`);
  }

  async write(manifest: VersionCheckpointManifest): Promise<void> {
    await atomicJsonWrite(this.manifestPath(manifest.id), manifest);
  }

  async read(id: string): Promise<VersionCheckpointManifest> {
    const parsed = JSON.parse(await readFile(this.manifestPath(id), 'utf8')) as VersionCheckpointManifest;
    if (parsed.version !== 1 || parsed.id !== id) throw new Error(`invalid checkpoint manifest ${id}`);
    return parsed;
  }

  /** Record that this checkpoint is the one an interrupted start has to finish. */
  async markPending(id: string): Promise<void> {
    await atomicJsonWrite(join(this.pendingRunsDir, `${id}.json`), { version: 1, id });
  }

  async clearPending(id: string): Promise<void> {
    await rm(join(this.pendingRunsDir, `${id}.json`), { force: true }).catch(() => undefined);
  }

  /**
   * Close out every checkpoint that was left pending, reading only the manifests that can be pending.
   *
   * Must run before a new manifest is written, so a start recovers what the previous one abandoned instead of
   * leaving it unreadable as `pending` forever.
   */
  async recoverPending(): Promise<void> {
    const legacyScan = !await pathExists(this.pendingRunsDir);
    await mkdir(this.pendingRunsDir, { recursive: true });
    for (const file of await listJsonFiles(legacyScan ? this.manifestsDir : this.pendingRunsDir)) {
      const id = basename(file, '.json');
      try {
        const manifest = await this.read(id);
        if (manifest.status !== 'pending') {
          await this.clearPending(id);
          continue;
        }
        await this.write({
          ...manifest,
          status: 'partial',
          completedAt: new Date().toISOString(),
          warningCodes: [...new Set([...manifest.warningCodes, RECOVERED_INCOMPLETE_CHECKPOINT])],
        } satisfies VersionCheckpointManifest);
        await this.clearPending(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // The run died between its pending record and its manifest. Nothing to recover.
          await this.clearPending(id);
          continue;
        }
        this.log?.('warn', `versioning: failed to recover pending manifest ${file}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Drop manifests beyond the cap — but only once the directory has run past it by the slack.
   *
   * Knowing which manifests are oldest costs a `stat` per manifest, and this runs at the end of every
   * completion. Paying it only when the directory is meaningfully over the cap, and then deleting all the way
   * back down, makes it one pass per slack manifests instead of one pass per start, with the retained set
   * bounded by `maxCheckpoints + PRUNE_SLACK` instead of growing without limit.
   */
  async prune(): Promise<void> {
    const files = await listJsonFiles(this.manifestsDir);
    if (files.length <= this.maxCheckpoints + PRUNE_SLACK) return;
    const sorted = await Promise.all(files.map(async (file) => ({ file, modified: (await stat(file)).mtimeMs })));
    sorted.sort((left, right) => right.modified - left.modified);
    await Promise.all(sorted.slice(this.maxCheckpoints).map((entry) => rm(entry.file, { force: true })));
  }
}
