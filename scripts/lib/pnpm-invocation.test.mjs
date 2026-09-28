import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PNPM_OVERRIDE_ENV,
  PnpmNotFoundError,
  pnpmFailureDetail,
  pnpmInvocation,
  resolvePnpmExecutable,
  resolvePnpmInvocation,
} from './pnpm-invocation.mjs';

const roots = [];

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-pnpm-invocation-'));
  roots.push(root);
  return root;
}

async function writePnpm(directory, name = 'pnpm.cmd') {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, '@echo off\r\nexit /b 0\r\n', 'utf8');
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('pnpm resolution', () => {
  it('finds pnpm on PATH and reports where it came from', async () => {
    const root = await scratch();
    const onPath = join(root, 'on-path');
    const executable = await writePnpm(onPath);
    const resolved = resolvePnpmExecutable({
      platform: 'win32',
      env: { PATH: onPath },
      exists: existsSync,
    });
    expect(resolved.executable).toBe(executable);
    expect(resolved.source).toBe('PATH');
  });

  it('falls back to the npm global prefix configured in the user .npmrc', async () => {
    const root = await scratch();
    // The real shape of the trap: pnpm is installed, PATH does not contain it, and the only
    // record of where it went is `prefix=` in the npm user configuration.
    const prefix = join(root, 'npm-global');
    const executable = await writePnpm(prefix);
    await writeFile(join(root, '.npmrc'), `prefix=${prefix}\r\ncache=${join(root, 'cache')}\r\n`, 'utf8');
    const resolved = resolvePnpmExecutable({
      platform: 'win32',
      env: { PATH: join(root, 'empty'), USERPROFILE: root },
      exists: existsSync,
    });
    expect(resolved.executable).toBe(executable);
    expect(resolved.source).toContain('.npmrc');
  });

  it('lets the explicit override win over PATH, and refuses an override that is not there', async () => {
    const root = await scratch();
    const onPath = join(root, 'on-path');
    await writePnpm(onPath);
    const explicit = await writePnpm(join(root, 'explicit'), 'pnpm.exe');

    const resolved = resolvePnpmExecutable({
      platform: 'win32',
      env: { PATH: onPath, [PNPM_OVERRIDE_ENV]: explicit },
      exists: existsSync,
    });
    expect(resolved.executable).toBe(explicit);
    expect(resolved.source).toBe(PNPM_OVERRIDE_ENV);

    const missing = join(root, 'explicit', 'nope.cmd');
    expect(() => resolvePnpmExecutable({
      platform: 'win32',
      env: { PATH: onPath, [PNPM_OVERRIDE_ENV]: missing },
      exists: existsSync,
    })).toThrow(PnpmNotFoundError);
    try {
      resolvePnpmExecutable({
        platform: 'win32',
        env: { PATH: onPath, [PNPM_OVERRIDE_ENV]: missing },
        exists: existsSync,
      });
    } catch (error) {
      expect(error.message).toContain(PNPM_OVERRIDE_ENV);
      expect(error.message).toContain(missing);
    }
  });

  it('names pnpm, every searched path, and the fix when nothing is found', async () => {
    const root = await scratch();
    let error;
    try {
      resolvePnpmExecutable({
        platform: 'win32',
        env: { PATH: join(root, 'a') + ';' + join(root, 'b'), APPDATA: join(root, 'appdata') },
        exists: () => false,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PnpmNotFoundError);
    expect(error.code).toBe('PNPM_NOT_FOUND');
    expect(error.message).toContain('pnpm was not found');
    expect(error.message).toContain(join(root, 'a', 'pnpm.cmd'));
    expect(error.message).toContain(join(root, 'b', 'pnpm.cmd'));
    expect(error.message).toContain(PNPM_OVERRIDE_ENV);
    expect(error.searched.length).toBeGreaterThan(1);
  });

  it('takes the first PATH entry that carries pnpm, and skips ones that do not', async () => {
    const root = await scratch();
    const first = join(root, 'first');
    const second = join(root, 'second');
    await writePnpm(second);
    const resolved = resolvePnpmExecutable({
      platform: 'win32',
      env: { PATH: [join(root, 'empty'), first, second].join(';') },
      exists: existsSync,
    });
    expect(resolved.executable).toBe(join(second, 'pnpm.cmd'));
    expect(resolved.searched).toContain(join(first, 'pnpm.cmd'));
  });
});

describe('pnpm invocation', () => {
  it('runs a Windows .cmd through the command interpreter without re-parsing the dependent filter', () => {
    const invocation = pnpmInvocation('C:\\tools\\npm-global\\pnpm.cmd', ['--filter', '@littlesheep/web...', 'run', 'build'], {
      platform: 'win32',
      env: { ComSpec: 'cmd.exe' },
    });
    expect(invocation.command).toBe('cmd.exe');
    expect(invocation.args).toEqual([
      '/d', '/s', '/c',
      'C:\\tools\\npm-global\\pnpm.cmd',
      '--filter', '@littlesheep/web...', 'run', 'build',
    ]);
    // The filter is one argv element, so the trailing `...` reaches pnpm intact.
    expect(invocation.args.filter((value) => value.includes('...'))).toEqual(['@littlesheep/web...']);
  });

  it('runs a POSIX executable directly', () => {
    const invocation = pnpmInvocation('/usr/local/bin/pnpm', ['run', 'build'], { platform: 'linux', env: {} });
    expect(invocation).toMatchObject({ command: '/usr/local/bin/pnpm', args: ['run', 'build'] });
  });

  it('never describes a failed command as success', async () => {
    const root = await scratch();
    await mkdir(root, { recursive: true });
    const failing = join(root, 'pnpm.cmd');
    await writeFile(failing, '@echo off\r\necho simulated build failure 1>&2\r\nexit /b 7\r\n', 'utf8');
    const invocation = resolvePnpmInvocation(['run', 'ensure:app-build'], {
      platform: 'win32',
      env: { PATH: root },
      exists: existsSync,
    });
    const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', stdio: 'pipe' });
    expect(result.status).toBe(7);
    expect(pnpmFailureDetail(result, invocation)).toContain('exited with code 7');
    expect(pnpmFailureDetail(result, invocation)).toContain('simulated build failure');
  });

  it('reports a spawn that could not start at all, and returns null for a command that worked', () => {
    const invocation = { displayCommand: ['missing-pnpm', 'run', 'build'] };
    const failed = pnpmFailureDetail({ error: new Error('spawn ENOENT'), status: null }, invocation);
    expect(failed).toContain('could not start missing-pnpm run build');
    expect(failed).toContain('spawn ENOENT');
    expect(pnpmFailureDetail({ status: 0, stdout: '', stderr: '', error: undefined }, invocation)).toBeNull();
  });
});
