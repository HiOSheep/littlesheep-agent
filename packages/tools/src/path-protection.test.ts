import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ToolContext } from '@littlesheep/types';
import {
  CORE_SOURCE_READ_ONLY_KIND,
  commandReferencesProtectedRoot,
  coreSourceReadOnlyMessage,
  findProtectedWriteRoot,
  isReadOnlyCoreCommand,
} from './path-protection.js';

const ctx: ToolContext = {
  sessionId: 's1' as never,
  runId: 'r1',
  cwd: process.cwd(),
  protectedWriteRoots: [join(process.cwd(), 'packages')],
};

describe('core source path protection', () => {
  it('matches descendants without matching sibling paths', () => {
    expect(findProtectedWriteRoot(join(process.cwd(), 'packages', 'tools', 'src'), ctx)).toBeTruthy();
    expect(findProtectedWriteRoot(join(process.cwd(), 'packages-other', 'file.ts'), ctx)).toBeUndefined();
  });

  it('recognizes protected root literals with either separator style', () => {
    const root = join(process.cwd(), 'packages');
    expect(commandReferencesProtectedRoot(`Get-Content ${root}`, [root])).toBeTruthy();
    expect(commandReferencesProtectedRoot(`Get-Content ${root.replaceAll('\\', '/')}`, [root])).toBeTruthy();
  });

  it('allows conservative diagnostics and rejects shell composition', () => {
    expect(isReadOnlyCoreCommand('rg -n protectedWriteRoots packages')).toBe(true);
    expect(isReadOnlyCoreCommand('git status --short')).toBe(true);
    expect(isReadOnlyCoreCommand('git status; Remove-Item source.ts')).toBe(false);
    expect(isReadOnlyCoreCommand('git diff --output changed.patch')).toBe(false);
    expect(isReadOnlyCoreCommand("Get-Content (Remove-Item source.ts)")).toBe(false);
    expect(isReadOnlyCoreCommand("rg --pre 'node mutate.js' pattern")).toBe(false);
    expect(isReadOnlyCoreCommand('git diff --ext-diff')).toBe(false);
    expect(isReadOnlyCoreCommand('pnpm test')).toBe(false);
  });

  // CE-05: existence is the one probe with no structured equivalent for an
  // arbitrary path, and `Test-Path` returned nothing for it before this change,
  // so a request to inspect a protected directory failed on a read-only question.
  it('allows a single existence probe and still refuses anything composed', () => {
    const root = join(process.cwd(), 'packages');
    expect(isReadOnlyCoreCommand(`Test-Path '${root}'`)).toBe(true);
    expect(isReadOnlyCoreCommand(`Test-Path -LiteralPath '${root}'`)).toBe(true);
    expect(isReadOnlyCoreCommand(`Test-Path -PathType Container '${root}'`)).toBe(true);
    // Every escape from "one command line" stays refused.
    expect(isReadOnlyCoreCommand(`Test-Path '${root}'; Remove-Item '${root}/x.ts'`)).toBe(false);
    expect(isReadOnlyCoreCommand(`Test-Path '${root}' && mkdir '${root}/new'`)).toBe(false);
    expect(isReadOnlyCoreCommand(`Test-Path '${root}' | Out-File list.txt`)).toBe(false);
    expect(isReadOnlyCoreCommand(`Test-Path '${root}' > out.txt`)).toBe(false);
    expect(isReadOnlyCoreCommand(`Test-Path (Get-Item '${root}')`)).toBe(false);
    expect(isReadOnlyCoreCommand(`Test-Path '${root}' \$(Get-Date)`)).toBe(false);
    // `-Credential` turns a local probe into an authentication side channel.
    expect(isReadOnlyCoreCommand(`Test-Path -Credential \$cred '${root}'`)).toBe(false);
  });

  it('names what still works, in one wording shared by every writer', () => {
    const message = coreSourceReadOnlyMessage('D:\\core\\game.html');

    expect(message).toMatch(/core source is read-only/i);
    expect(message).toContain('D:\\core\\game.html');
    expect(message).toContain('Get-ChildItem');
    expect(message).toContain('Test-Path -LiteralPath');
    expect(message).toContain('`glob`');
    expect(message).toContain('Approval cannot override this host-level protection');
    expect(message).toContain('Write into a writable workspace instead of this root');
  });

  it('declares one bounded kind so the loop can classify the refusal without text matching', () => {
    expect(CORE_SOURCE_READ_ONLY_KIND).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
  });
});
