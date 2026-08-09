import { spawnSync } from 'node:child_process';

export function readGitLines(args, cwd, spawn = spawnSync) {
  const result = spawn('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(
      `git ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}.`
        + (detail ? ` ${detail}` : ''),
    );
  }
  return result.stdout?.trim()
    ? result.stdout.split(/\r?\n/).filter(Boolean)
    : [];
}

export function resolveGitMergeBase(base, cwd, spawn = spawnSync) {
  const result = spawn('git', ['merge-base', base, 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;

  const mergeBase = result.stdout?.trim();
  if (result.status === 0 && mergeBase) return mergeBase;

  const exitStatus = result.status ?? 'unknown';
  const gitDetail = result.stderr?.trim();
  const detail = gitDetail ? ` Git reported: ${gitDetail}` : '';
  throw new Error(
    `Cannot resolve Git merge-base for "${base}" against HEAD (exit ${exitStatus}).${detail} `
      + 'Affected verification stopped to avoid missing committed changes. '
      + 'Fetch the base ref or pass --base=<ref>.',
  );
}
