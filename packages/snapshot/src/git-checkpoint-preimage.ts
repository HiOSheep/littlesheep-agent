// Preimage resolution for the data shadow repository: which commit the preimage is, and which paths it covers.
//
// Both answers come from git, and that is the point of this module. It used to be a walk of the data root — a
// recursive readdir plus one `lstat` per managed file — on the path to execution readiness, every start,
// measured at 7.2 s on a 4,730-file fixture and worse on a real 31k-file root. `git ls-files` plus `git status`
// answer the same questions in two processes with no per-file stat, so a start now costs what actually changed
// instead of what the data root contains.
//
// It does not decide what a checkpoint is (git-checkpoint.ts) or where the shadow repository lives
// (git-client.ts); it decides what one data commit must cover, and when a commit can be skipped entirely.
import { join } from 'node:path';
import { ShadowGitRepository, type WorkTreeChange } from './git-client.js';
import { DATA_ROOT_FILES, isManagedDataPath, safeLstat, toGitPath } from './git-checkpoint-files.js';
import { buildSignature, readSignature, writeSignature } from './preimage-signature.js';

/** What one data commit covers. */
export interface DataPathSelection {
  /** Every managed path the commit will cover, sorted — what the manifest publishes. */
  paths: string[];
  /** New paths to name explicitly to `git add`; the only paths this start stat-ed. */
  changed: string[];
  /** Whether the index already tracks anything, i.e. whether `git add -u` has work to do. */
  updateTracked: boolean;
}

export interface PreimageResolution {
  commit: string | undefined;
  trackedCount: number;
  reused: boolean;
}

export interface DataPathSelectionOptions {
  dataRoot: string;
  maxFileBytes: number;
}

/**
 * Opt-in preimage timing, same switch and prefix as the runner's run marks so one report can show both.
 */
function markPreimage(stage: string, paths: number): void {
  if (process.env['LITTLESHEEP_BOOTSTRAP_TIMING'] !== '1') return;
  console.log(`[run-timing] ${JSON.stringify({ scope: 'preimage', stage, paths })}`);
}

/**
 * Which paths a data commit covers, taken from git rather than from a walk of the data root.
 *
 * Three sources, and each one exists for a reason the others cannot cover:
 *
 *  - `git ls-files` — everything already versioned. One process, no `stat`; these are the entries `git add -u`
 *    updates, including the removals of paths that are tracked and no longer on disk.
 *  - `git status` — the paths that are new or changed *now*. Only these are stat-ed, which is the point: the
 *    `maxFileBytes` ceiling is applied where it matters (a new oversized file is still refused) instead of once
 *    per managed file per start.
 *  - `DATA_ROOT_FILES` — named root files are added if they exist on disk even when git did not report them,
 *    because they are the memory/config/session state a rollback exists for.
 *
 * All three pass through the same string rules (`isManagedDataPath`, and through it `dataDirectoryExcluded`),
 * so `backups/`, `attachment-cache/`, `models/`, `vectors/`, `*.sqlite` and friends can never enter the
 * selection — which is what makes it safe that `git add -f` overrides the repository's exclude file for the new
 * paths. A path git reports but the rules reject is simply never named to `git add`.
 *
 * One deliberate narrowing: a brand-new file that matches an ignore pattern — the shadow repository's own
 * excludes or a `.gitignore` inside the work tree — is not reported by `git status` and therefore is not
 * versioned on the start that first sees it. Already-tracked paths keep their coverage (they come from
 * `ls-files`, and `git add -u` does not consult ignore rules), so no rollback point that exists today is lost.
 */
export async function selectDataPaths(
  repository: ShadowGitRepository,
  options: DataPathSelectionOptions,
  changes?: readonly WorkTreeChange[],
): Promise<DataPathSelection> {
  const [trackedPaths, workTreeChanges] = await Promise.all([
    repository.trackedPaths().catch(() => []),
    changes ? Promise.resolve(changes) : repository.workTreeChanges(),
  ]);
  const tracked = new Set(trackedPaths);
  const managed = new Set<string>();
  for (const path of trackedPaths) {
    if (isManagedDataPath(path)) managed.add(path);
  }
  const changed: string[] = [];
  for (const change of workTreeChanges) {
    const path = toGitPath(change.path);
    if (managed.has(path) || !isManagedDataPath(path)) continue;
    // A path that is tracked is covered by `git add -u` whether or not it still exists, so it needs no stat.
    if (tracked.has(path)) continue;
    // Untracked and gone: nothing to version, and naming it to `git add` would fail the whole commit.
    if (change.deleted) continue;
    const info = await safeLstat(join(options.dataRoot, path));
    if (!info?.isFile() || info.isSymbolicLink() || info.size > options.maxFileBytes) continue;
    managed.add(path);
    changed.push(path);
  }
  for (const file of DATA_ROOT_FILES) {
    if (managed.has(file) || !isManagedDataPath(file)) continue;
    const info = await safeLstat(join(options.dataRoot, file));
    if (!info?.isFile() || info.isSymbolicLink() || info.size > options.maxFileBytes) continue;
    managed.add(file);
    changed.push(file);
  }
  return {
    paths: [...managed].sort(),
    changed: changed.sort(),
    updateTracked: trackedPaths.length > 0,
  };
}

/**
 * The commit this data root's preimage is at, and whether it had to be written.
 *
 * Both branches ask git instead of the filesystem. The fast path costs two processes — is anything different
 * from HEAD, and is HEAD still the recorded commit — and writes nothing. The slow path used to be that walk; it
 * is now the same status answer, one `ls-files`, a stat of the handful of paths git reported as new, and two
 * `add` processes.
 *
 * The fast path stays even though it rarely fires (the app writes into managed directories between launches, so
 * the tree is usually dirty): it is what makes a start that changed nothing free, and its failure mode is the
 * cheap branch, not a lost rollback point.
 */
export async function resolvePreimage(
  repository: ShadowGitRepository,
  options: DataPathSelectionOptions,
  message: string,
  allowEmpty: boolean,
  stage: 'bootstrap' | 'preimage',
): Promise<PreimageResolution> {
  const gitDir = repository.gitDir;
  const [stored, head, changes] = await Promise.all([
    readSignature(gitDir),
    repository.head(),
    repository.workTreeChanges(),
  ]);
  if (head !== undefined && changes.length === 0) {
    if (stored?.commit === head) {
      markPreimage(`${stage}-reused`, stored.trackedCount);
      return { commit: head, trackedCount: stored.trackedCount, reused: true };
    }
    // HEAD moved without anything pending: the previous run's completion committed its own effects. HEAD is
    // then the preimage, and the record only needs to point at it again — one `ls-files`, no walk, no commit.
    const trackedCount = await repository.trackedPaths()
      .then((paths) => paths.length)
      .catch(() => stored?.trackedCount ?? 0);
    await writeSignature(gitDir, buildSignature(head, trackedCount));
    markPreimage(`${stage}-reused`, trackedCount);
    return { commit: head, trackedCount, reused: true };
  }
  // The status answer is already in hand, so the selection costs one `ls-files` and a `lstat` per new path.
  const selection = await selectDataPaths(repository, options, changes);
  const commit = await repository.commitWorkTreeChanges(selection, message, allowEmpty);
  markPreimage(`${stage}-committed`, selection.paths.length);
  if (commit) await writeSignature(gitDir, buildSignature(commit, selection.paths.length));
  return { commit, trackedCount: selection.paths.length, reused: false };
}
