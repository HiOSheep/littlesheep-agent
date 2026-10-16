import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AgentTool, TaskRequirementStatus, ToolContext } from '@littlesheep/types';
import { authorizeToolAccess } from '@littlesheep/safety';
import { inspectWorkspaceFilePath } from '../workspace-file-guard.js';
import { isNativeWorkspaceFileInvocation } from '../native-workspace-file-invocation.js';
import { withToolTiming } from '../wrapper.js';

export const EXPLICIT_FILE_CHECK_TOOL_NAME = 'runtime_check_file_content';
const EmptyInput = z.object({}).strict();
const MAX_CHECKED_FILE_BYTES = 1024 * 1024;
const MAX_EXPECTED_CONTENT_BYTES = 16 * 1024;

export interface ExplicitFileContentCheckRequest {
  runId: string;
  requirementId: string;
  /** A simple relative workspace path parsed from one exact user request. */
  filePath: string;
  /** Kept in the in-memory tool closure only; never returned or persisted. */
  expectedContent: string;
}

export interface ExplicitFileContentCheckReceipt {
  version: 1;
  requirementId: string;
  evidenceId: string;
  fileStateEvidenceId: string;
  status: TaskRequirementStatus;
  resourceRef: string;
  contentHash?: string;
  reasonCode?: 'permission_denied' | 'path_unverified' | 'file_missing' | 'not_regular_file' | 'file_too_large' | 'read_failed' | 'cancelled';
}

const runtimeFileContentCheckTools = new WeakSet<AgentTool>();

/** Internal identity check used by ToolExecutionService to apply only the native read guard. */
export function isRuntimeFileContentCheckTool(tool: AgentTool): boolean {
  return runtimeFileContentCheckTools.has(tool);
}

/**
 * Create a run-scoped, read-only checker for one exact user-declared content
 * requirement. The model chooses no path or expected value; it can only ask
 * Runtime to inspect the target already extracted from the original message.
 */
export function createExplicitFileContentCheckTool(request: ExplicitFileContentCheckRequest): AgentTool {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(request.filePath)
    || request.filePath === '.' || request.filePath === '..' || request.filePath.includes('..')
    || !request.runId.trim() || !request.requirementId.trim()) {
    throw new Error('explicit file content check requires a bounded root-level workspace filename');
  }
  const expectedBytes = Buffer.from(request.expectedContent, 'utf8');
  if (expectedBytes.length > MAX_EXPECTED_CONTENT_BYTES) {
    throw new Error('explicit file content check exceeds the bounded expectation size');
  }

  const tool: AgentTool = {
    name: EXPLICIT_FILE_CHECK_TOOL_NAME,
    description: 'Check whether the file named in the user request currently has the exact requested content. Returns a bounded pass/fail result without showing file contents.',
    inputSchema: EmptyInput,
    execution: {
      concurrency: 'exclusive',
      resources: () => [{ key: `workspace:${request.filePath.replaceAll('\\', '/')}`, mode: 'read' }],
    },
    execute: withToolTiming(async (input, ctx) => {
      const parsed = EmptyInput.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'This Runtime check does not accept model-supplied file paths or content.' };
      const result = await inspectExpectedFile(request, ctx, expectedBytes);
      return {
        // A blocked check is a successfully observed outcome of the checker;
        // it does not mean the requirement passed.
        ok: true,
        output: result.receipt.status === 'passed'
          ? 'The requested file content matches.'
          : result.receipt.status === 'failed'
            ? 'The requested file exists, but its content does not match.'
            : 'The requested file content could not be safely checked.',
        meta: { taskOutcomeCheck: result.receipt },
      };
    }),
  };
  runtimeFileContentCheckTools.add(tool);
  return tool;
}

async function inspectExpectedFile(
  request: ExplicitFileContentCheckRequest,
  context: ToolContext,
  expectedBytes: Buffer,
): Promise<{ receipt: ExplicitFileContentCheckReceipt }> {
  const fallbackRef = safeResourceRef(request.filePath);
  if (context.signal?.aborted) return { receipt: blocked(request, fallbackRef, 'cancelled') };

  const requestedPath = resolve(context.cwd, request.filePath);
  const guard = await inspectWorkspaceFilePath(request.filePath, context, 'read');
  if (guard.attemptedWorkspace && !guard.safe) {
    return { receipt: blocked(request, fallbackRef, 'path_unverified') };
  }
  const targetPath = guard.safe && guard.targetPath ? guard.targetPath : requestedPath;
  const authorization = await authorizeToolAccess('read', { file_path: targetPath }, context, {
    workspaceFileReadGuard: guard.safe && isNativeWorkspaceFileInvocation(context, EXPLICIT_FILE_CHECK_TOOL_NAME),
    forceApproval: guard.attemptedWorkspace && !guard.safe,
  });
  if (!authorization.allowed) return { receipt: blocked(request, fallbackRef, 'permission_denied') };

  const pinned = await guard.withPinnedDirectories(async () => {
    if (context.signal?.aborted) return blocked(request, fallbackRef, 'cancelled');
    if (guard.safe && !await guard.revalidate()) return blocked(request, fallbackRef, 'path_unverified');
    let handle;
    try {
      handle = await open(targetPath, 'r');
      if (guard.safe && (!await guard.revalidate() || !await guard.verifyOpenedHandle(handle))) {
        return blocked(request, fallbackRef, 'path_unverified');
      }
      const stats = await handle.stat();
      if (!stats.isFile()) return blocked(request, fallbackRef, 'not_regular_file');
      if (stats.size > MAX_CHECKED_FILE_BYTES) return blocked(request, fallbackRef, 'file_too_large');
      const bytes = await handle.readFile();
      if (context.signal?.aborted) return blocked(request, fallbackRef, 'cancelled');
      if (guard.safe && !await guard.revalidate()) return blocked(request, fallbackRef, 'path_unverified');
      const contentHash = sha256(bytes);
      const matched = bytes.equals(expectedBytes);
      const status: TaskRequirementStatus = matched ? 'passed' : 'failed';
      return {
        version: 1 as const,
        requirementId: request.requirementId,
        evidenceId: stableEvidenceId(request, contentHash, status),
        fileStateEvidenceId: stableEvidenceId(request, contentHash, 'file-state'),
        status,
        resourceRef: fallbackRef,
        contentHash,
      } satisfies ExplicitFileContentCheckReceipt;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'ENOENT'
        ? missingFile(request, fallbackRef)
        : blocked(request, fallbackRef, 'read_failed');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  });
  if (!pinned.ok) return { receipt: blocked(request, fallbackRef, 'path_unverified') };
  return { receipt: pinned.value };
}

function missingFile(request: ExplicitFileContentCheckRequest, resourceRef: string): ExplicitFileContentCheckReceipt {
  return {
    version: 1,
    requirementId: request.requirementId,
    evidenceId: stableEvidenceId(request, 'file_missing', 'failed'),
    fileStateEvidenceId: stableEvidenceId(request, 'file_missing', 'file-state'),
    status: 'failed',
    resourceRef,
    reasonCode: 'file_missing',
  };
}

function blocked(
  request: ExplicitFileContentCheckRequest,
  resourceRef: string,
  reasonCode: NonNullable<ExplicitFileContentCheckReceipt['reasonCode']>,
): ExplicitFileContentCheckReceipt {
  return {
    version: 1,
    requirementId: request.requirementId,
    evidenceId: stableEvidenceId(request, reasonCode, 'blocked'),
    fileStateEvidenceId: stableEvidenceId(request, reasonCode, 'file-state-blocked'),
    status: 'blocked',
    resourceRef,
    reasonCode,
  };
}

function stableEvidenceId(request: ExplicitFileContentCheckRequest, observed: string, status: string): string {
  return `file-check:${sha256(`${request.runId}\0${request.requirementId}\0${request.filePath}\0${observed}\0${status}`).slice(0, 32)}`;
}

function safeResourceRef(filePath: string): string {
  // This checker only accepts root-level relative names from the explicit
  // parser. Keep the final persisted reference relative even if cwd is absolute.
  const normalized = filePath.replaceAll('\\', '/');
  if (isAbsolute(filePath) || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    return 'workspace:unavailable';
  }
  const relativePath = relative('.', normalized).replaceAll('\\', '/');
  return `workspace:${relativePath.slice(0, 180)}`;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
