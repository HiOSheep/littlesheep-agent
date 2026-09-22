// @littlesheep/tools — builtin/edit.ts
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { CORE_SOURCE_READ_ONLY_ERROR, findProtectedWriteRoot, resolveToolPath } from '../path-protection.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';
import { observationFailure, observedRangeCoversMatch, readVerifiedFile } from '../file-observation.js';

const EditInput = z.object({
  file_path: z.string(),
  old_string: z.string().describe('Exact text to find (must be unique).'),
  new_string: z.string().describe('Replacement text.'),
});

export const editTool: AgentTool = {
  name: 'edit',
  description: 'Edit a file by replacing an exact string. Requires approval.',
  inputSchema: EditInput,
  requiresApproval: true,
  execution: parallelFilePolicy('file_path', 'write'),
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, old_string, new_string } = EditInput.parse(input);
    const targetPath = resolveToolPath(file_path, ctx.cwd);
    const protectedRoot = findProtectedWriteRoot(targetPath, ctx);
    if (protectedRoot) {
      return { ok: false, error: `${CORE_SOURCE_READ_ONLY_ERROR}: ${targetPath}` };
    }
    const authorization = await authorizeToolAccess('edit', { file_path: targetPath }, ctx, {
      defaultRequiresApproval: true,
    });
    if (!authorization.allowed) return { ok: false, error: 'Approval denied' };
    if (!existsSync(targetPath)) {
      return { ok: false, error: `File not found: ${targetPath}` };
    }
    // The version check runs before the checkpoint: a stale target must not
    // produce a rollback preimage for an edit that will be refused anyway.
    const verified = await readVerifiedFile(ctx, targetPath, 'any');
    if (!verified.ok) {
      ctx.observation?.invalidate(targetPath);
      return observationFailure(verified);
    }
    await ctx.versioning?.beforeFileMutation(targetPath);
    const committed = await ctx.observation!.withPathLock(targetPath, async () => {
      // Re-verify and match against the same bytes inside the lock, so the
      // unique match this edit relies on is still true when the write happens.
      const locked = await readVerifiedFile(ctx, targetPath, 'any');
      if (!locked.ok) return locked;
      const content = locked.bytes.toString('utf8');
      const occurrences = content.split(old_string).length - 1;
      if (occurrences === 0) {
        return { ok: false as const, error: 'old_string not found in file' };
      }
      if (occurrences > 1) {
        return { ok: false as const, error: `old_string is not unique (${occurrences} matches)` };
      }
      const matchIndex = content.indexOf(old_string);
      if (!observedRangeCoversMatch(locked.snapshot, content, matchIndex, old_string)) {
        return {
          ok: false as const,
          errorKind: 'observation_missing' as const,
          error: `${targetPath}: this edit is outside the lines that were read; read that range before editing it`,
        };
      }
      await writeFile(targetPath, content.replace(old_string, new_string), 'utf8');
      return { ok: true as const };
    });
    ctx.observation?.invalidate(targetPath);
    if (!committed.ok) {
      return 'errorKind' in committed
        ? observationFailure({ ok: false, errorKind: committed.errorKind, error: committed.error })
        : { ok: false, error: committed.error };
    }
    ctx.log?.('info', `edited ${targetPath}`);
    return { output: `Edited ${targetPath}: replaced ${old_string.length} chars` };
  }),
};
