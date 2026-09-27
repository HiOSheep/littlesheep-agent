import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultRepoRoot,
  planDesktopShortcutSync,
  powershellInvocation,
  shortcutScriptRelativePath,
  syncDesktopShortcut,
} from './desktop-shortcut.mjs';

describe('desktop shortcut sync planning', () => {
  it('runs on Windows and skips everywhere else', () => {
    expect(planDesktopShortcutSync({ platform: 'win32' })).toEqual({ action: 'run' });
    expect(planDesktopShortcutSync({ platform: 'linux' })).toEqual({
      action: 'skip',
      reason: 'unsupported-platform',
    });
    expect(planDesktopShortcutSync({ platform: 'darwin' })).toEqual({
      action: 'skip',
      reason: 'unsupported-platform',
    });
  });

  it('passes -IfPresent only in best-effort mode', () => {
    const scriptPath = join(defaultRepoRoot, shortcutScriptRelativePath);
    expect(powershellInvocation(scriptPath, { ifPresent: true }).args).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-IfPresent',
    ]);
    expect(powershellInvocation(scriptPath, { ifPresent: false }).args).not.toContain('-IfPresent');
  });
});

describe('desktop shortcut sync execution', () => {
  it('does not touch the script off Windows', async () => {
    const runScript = vi.fn();
    const result = await syncDesktopShortcut({ platform: 'linux', runScript });
    expect(result).toEqual({ status: 'skipped', reason: 'unsupported-platform' });
    expect(runScript).not.toHaveBeenCalled();
  });

  it('calls the Windows script relative to the repository root in best-effort mode', async () => {
    const runScript = vi.fn().mockResolvedValue({ ok: true });
    const result = await syncDesktopShortcut({ platform: 'win32', runScript });
    expect(result).toEqual({ status: 'synced' });
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(runScript.mock.calls[0]?.[0]).toMatchObject({
      repoRoot: defaultRepoRoot,
      scriptPath: join(defaultRepoRoot, shortcutScriptRelativePath),
      ifPresent: true,
    });
  });

  it('reports a best-effort failure without failing the caller', async () => {
    const runScript = vi.fn().mockResolvedValue({ ok: false, detail: 'powershell.exe was not found' });
    const result = await syncDesktopShortcut({ platform: 'win32', runScript });
    expect(result).toEqual({ status: 'failed', detail: 'powershell.exe was not found' });
  });

  it('survives a throwing script in best-effort mode', async () => {
    const runScript = vi.fn().mockRejectedValue(new Error('spawn failed'));
    const result = await syncDesktopShortcut({ platform: 'win32', runScript });
    expect(result).toEqual({ status: 'failed', detail: 'spawn failed' });
  });

  it('propagates failure in strict mode, where the request was explicit', async () => {
    const runScript = vi.fn().mockResolvedValue({ ok: false, detail: 'the link could not be saved' });
    await expect(syncDesktopShortcut({ platform: 'win32', mode: 'strict', runScript }))
      .rejects.toThrow('the link could not be saved');
  });

  it('lets strict mode create a shortcut the best-effort mode would leave alone', async () => {
    const runScript = vi.fn().mockResolvedValue({ ok: true });
    const result = await syncDesktopShortcut({ platform: 'win32', mode: 'strict', runScript });
    expect(result).toEqual({ status: 'synced' });
    expect(runScript.mock.calls[0]?.[0]).toMatchObject({ ifPresent: false });
  });

  it('refuses strict mode off Windows instead of failing later', async () => {
    const runScript = vi.fn();
    await expect(syncDesktopShortcut({ platform: 'linux', mode: 'strict', runScript }))
      .rejects.toThrow('only exists on Windows');
    expect(runScript).not.toHaveBeenCalled();
  });
});
