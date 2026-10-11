// @littlesheep/tools — builtin/edit.ts
import { z } from 'zod';
import { existsSync } from 'node:fs';
import type { AgentTool } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import {
  CORE_SOURCE_READ_ONLY_KIND,
  coreSourceReadOnlyMessage,
  findProtectedWriteRoot,
  resolveToolPath,
} from '../path-protection.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';
import { observationFailure, observedRangeCoversMatch, readVerifiedFile } from '../file-observation.js';
import { inspectWorkspaceFilePath } from '../workspace-file-guard.js';
import { replaceFileAtomically } from '../workspace-file-operations.js';
import { isNativeWorkspaceFileInvocation } from '../native-workspace-file-invocation.js';

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
  // Re-applying the same replacement is a new operation when the Runtime recorded a later successful change
  // to the same path (HC-04); with no such record it stays the replay the ledger refuses.
  reRunnableAfterResourceChange: true,
  execution: parallelFilePolicy('file_path', 'write'),
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, old_string, new_string } = EditInput.parse(input);
    const requestedPath = resolveToolPath(file_path, ctx.cwd);
    const guard = await inspectWorkspaceFilePath(file_path, ctx, 'write');
    const targetPath = guard.safe && guard.targetPath ? guard.targetPath : requestedPath;
    const protectedRoot = findProtectedWriteRoot(targetPath, ctx);
    if (protectedRoot) {
      return {
        ok: false,
        error: coreSourceReadOnlyMessage(targetPath),
        meta: { errorKind: CORE_SOURCE_READ_ONLY_KIND },
      };
    }
    if (guard.attemptedWorkspace && !guard.safe) {
      return { ok: false, error: `Workspace path could not be verified: ${guard.reason ?? 'unknown boundary'}` };
    }
    const authorization = await authorizeToolAccess('edit', { file_path: targetPath }, ctx, {
      defaultRequiresApproval: true,
      workspaceFileWriteGuard: isNativeWorkspaceFileInvocation(ctx, 'edit'),
      forceApproval: guard.attemptedWorkspace && !guard.safe,
    });
    if (!authorization.allowed) return { ok: false, error: 'Approval denied' };
    const pinned = await guard.withPinnedDirectories(async () => {
      if (guard.safe && !await guard.revalidate()) {
        return { ok: false, error: 'Workspace path changed before the edit; retry after the workspace is stable.' };
      }
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
        if (guard.safe && !await guard.revalidate()) {
          return {
            ok: false as const,
            errorKind: 'observation_missing' as const,
            error: 'Workspace directory identity changed before the edit; read the file again after the workspace is stable.',
          };
        }
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
        const replaced = await replaceFileAtomically(
          targetPath,
          locked.bytes,
          content.replace(old_string, new_string),
          async () => !guard.safe || await guard.revalidate(),
        );
        if (!replaced.ok) {
          return {
            ok: false as const,
            errorKind: replaced.reason === 'target_changed' ? 'observation_stale' as const : 'observation_missing' as const,
            error: replaced.reason === 'target_changed'
              ? 'The file changed while the replacement was being prepared; read it again before retrying.'
              : 'Workspace path changed before the replacement could be committed.',
          };
        }
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
    });
    return pinned.ok ? pinned.value : {
      ok: false, error: `Workspace directory protection unavailable: ${pinned.reason}`,
      meta: { errorKind: 'permission_safety_unavailable' },
    };
  }),
};
