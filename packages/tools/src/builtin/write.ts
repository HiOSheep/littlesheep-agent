// @littlesheep/tools — builtin/write.ts
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  AgentTool,
  DurableEffectOutcomeQueryResult,
  DurableEffectProjection,
  EffectReconcileContext,
  ReconciliationValue,
} from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import {
  CORE_SOURCE_READ_ONLY_KIND,
  coreSourceReadOnlyMessage,
  findProtectedWriteRoot,
  resolveToolPath,
} from '../path-protection.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';
import { observationFailure, readVerifiedFile } from '../file-observation.js';

const WriteInput = z.object({
  file_path: z.string().describe('Absolute path to write.'),
  content: z.string().describe('Content to write.'),
});

export const writeTool: AgentTool = {
  name: 'write',
  description: 'Write content to a file (overwrites if exists). Requires approval.',
  inputSchema: WriteInput,
  requiresApproval: true,
  execution: parallelFilePolicy('file_path', 'write'),
  // Recovery key: the target path plus the digest of the intended bytes. No
  // content text is persisted, only enough to prove the file on disk is the
  // one this effect meant to produce.
  reconciliationKey(input) {
    const parsed = WriteInput.safeParse(input);
    if (!parsed.success) return undefined;
    return {
      path: parsed.data.file_path,
      sha256: contentDigest(parsed.data.content),
      bytes: Buffer.byteLength(parsed.data.content, 'utf8'),
    };
  },
  async reconcileEffect(effect, ctx) {
    return reconcileWriteEffect(effect, ctx);
  },
  execute: withToolTiming(async (input, ctx) => {
    const { file_path, content } = WriteInput.parse(input);
    const targetPath = resolveToolPath(file_path, ctx.cwd);
    const protectedRoot = findProtectedWriteRoot(targetPath, ctx);
    if (protectedRoot) {
      return {
        ok: false,
        error: coreSourceReadOnlyMessage(targetPath),
        meta: { errorKind: CORE_SOURCE_READ_ONLY_KIND },
      };
    }
    const authorization = await authorizeToolAccess('write', { file_path: targetPath }, ctx, {
      defaultRequiresApproval: true,
    });
    if (!authorization.allowed) return { ok: false, error: 'Approval denied' };
    const targetExists = existsSync(targetPath);
    if (targetExists) {
      // Overwriting is only allowed for a file this session actually read in
      // full, and the check happens before the checkpoint so a stale target
      // never produces a rollback preimage for a write that will not happen.
      const verified = await readVerifiedFile(ctx, targetPath, 'full');
      if (!verified.ok) {
        ctx.observation?.invalidate(targetPath);
        return observationFailure(verified);
      }
      await ctx.versioning?.beforeFileMutation(targetPath);
      const committed = await ctx.observation!.withPathLock(targetPath, async () => {
        // Re-verify inside the lock: another session of this host may have
        // written the same path while this call was waiting for approval.
        const locked = await readVerifiedFile(ctx, targetPath, 'full');
        if (!locked.ok) return locked;
        await writeFile(targetPath, content, 'utf8');
        return { ok: true as const };
      });
      ctx.observation?.invalidate(targetPath);
      if (!committed.ok) return observationFailure(committed);
      ctx.log?.('info', `wrote ${targetPath} (${content.length} chars)`);
      return { output: `Wrote ${content.length} chars to ${targetPath}` };
    }
    // A new file needs no observation: there is no version to overwrite. The
    // exclusive create flag is what makes it safe, so a racing creator loses
    // instead of being silently replaced.
    await ctx.versioning?.beforeFileMutation(targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return observationFailure({
          ok: false,
          errorKind: 'target_exists',
          error: `${targetPath} appeared while this write was being prepared; read it before overwriting it`,
        });
      }
      throw error;
    }
    ctx.log?.('info', `wrote ${targetPath} (${content.length} chars)`);
    return { output: `Wrote ${content.length} chars to ${targetPath}` };
  }),
};

function contentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

interface WriteReconciliationKey {
  path: string;
  sha256: string;
  bytes?: number;
}

function readWriteReconciliationKey(value: ReconciliationValue | undefined): WriteReconciliationKey | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = record.path;
  const sha256 = record.sha256;
  if (typeof path !== 'string' || typeof sha256 !== 'string') return undefined;
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return { path, sha256 };
}

/**
 * Only observe. A matching digest confirms the intended bytes are present.
 * A missing or changed file stays unknown (another writer may have removed it), rather than
 * guessing, because another writer may have changed the target afterwards.
 */
async function reconcileWriteEffect(
  effect: DurableEffectProjection,
  ctx: EffectReconcileContext,
): Promise<DurableEffectOutcomeQueryResult> {
  const key = readWriteReconciliationKey(effect.reconciliationKey);
  if (!key) return { known: false, reason: 'write effect has no bounded reconciliation key' };
  if (!isAbsolute(key.path)) return { known: false, reason: 'write effect target is not an absolute path' };
  try {
    if (!ctx.authorizeRead || !await ctx.authorizeRead(key.path)) {
      return { known: false, reason: 'write reconciliation read requires host authorization' };
    }
    const digest = createHash('sha256').update(await readFile(key.path)).digest('hex');
    if (digest === key.sha256) {
      return { known: true, status: 'succeeded', evidenceRef: `write:${key.sha256.slice(0, 12)}` };
    }
    ctx.log?.('warn', 'write: reconciliation target differs from the intended content', {
      path: key.path,
    });
    return { known: false, reason: 'write target content differs from the intended write' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { known: false, reason: 'write target is missing; prior effect outcome is unknown' };
    }
    return {
      known: false,
      reason: `write target could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
