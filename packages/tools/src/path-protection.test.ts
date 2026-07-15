import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ToolContext } from '@littlesheep/types';
import {
  commandReferencesProtectedRoot,
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
});
