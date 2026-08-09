import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { readGitLines, resolveGitMergeBase } from './lib/affected-verification-base.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(new URL('./run-affected-verification.mjs', import.meta.url));

describe('affected verification Git baseline', () => {
  it('fails closed when Git change-set discovery fails', () => {
    const spawn = vi.fn(() => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: bad object',
    }));

    expect(() => readGitLines(['diff', '--name-only'], repoRoot, spawn)).toThrow(
      /git diff --name-only failed with exit 128.*bad object/s,
    );
  });

  it('uses the resolved merge-base commit as the effective baseline', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: '0123456789abcdef\n',
      stderr: '',
    }));

    expect(resolveGitMergeBase('origin/main', repoRoot, spawn)).toBe('0123456789abcdef');
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['merge-base', 'origin/main', 'HEAD'],
      { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
    );
  });

  it('fails closed when the requested base cannot be resolved', () => {
    const spawn = vi.fn(() => ({
      status: 128,
      stdout: '',
      stderr: 'fatal: Not a valid object name missing/base',
    }));

    expect(() => resolveGitMergeBase('missing/base', repoRoot, spawn)).toThrow(
      /stopped to avoid missing committed changes/,
    );
  });

  it('exits before selection when the CLI receives a missing base ref', () => {
    const result = spawnSync(
      process.execPath,
      [scriptPath, '--list', '--base=refs/heads/__littlesheep_missing_base_fixture__'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Affected verification stopped to avoid missing committed changes');
    expect(result.stdout).not.toContain('[affected] files:');
  });
});
