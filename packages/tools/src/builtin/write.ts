// @littlesheep/tools — builtin/write.ts
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
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
import { CORE_SOURCE_READ_ONLY_ERROR, findProtectedWriteRoot, resolveToolPath } from '../path-protection.js';
import { withToolTiming } from '../wrapper.js';
import { parallelFilePolicy } from '../execution-policy.js';

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
      return { ok: false, error: `${CORE_SOURCE_READ_ONLY_ERROR}: ${targetPath}` };
    }
    const authorization = await authorizeToolAccess('write', { file_path: targetPath }, ctx, {
      defaultRequiresApproval: true,
    });
    if (!authorization.allowed) return { ok: false, error: 'Approval denied' };
    await ctx.versioning?.beforeFileMutation(targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content, 'utf8');
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
