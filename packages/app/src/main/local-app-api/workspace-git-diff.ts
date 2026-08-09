// Parses bounded Git numstat and unified-diff output into review layer contracts.

import type {
  WorkspaceReviewDiffLayer,
  WorkspaceReviewDiffLayerKind,
} from '../../shared/workspace-review-contracts.js'
import {
  runReadOnlyGit,
  type GitConfigOverride,
} from './workspace-git-command.js'
import { parseNumstat, parseUnifiedDiffBounded } from './workspace-git-review-parsers.js'

export const MAX_GIT_DIFF_TOTAL_BYTES = 8 * 1024 * 1024
export const MAX_GIT_DIFF_LINES_PER_LAYER = 5_000

type NumstatRecord = ReturnType<typeof parseNumstat>[number]

export function indexNumstat(buffer: Buffer): Map<string, NumstatRecord> {
  const records = new Map<string, NumstatRecord>()
  for (const record of parseNumstat(buffer)) {
    records.set(record.path, record)
    if (record.oldPath) records.set(record.oldPath, record)
  }
  return records
}

export function findNumstat(
  records: Map<string, NumstatRecord>,
  path: string,
  oldPath?: string,
): NumstatRecord | undefined {
  return records.get(path) ?? (oldPath ? records.get(oldPath) : undefined)
}

export async function readDiffLayer(
  repositoryRoot: string,
  kind: WorkspaceReviewDiffLayerKind,
  args: string[],
  options: {
    allowExitCodes?: number[]
    configOverrides?: readonly GitConfigOverride[]
    maxBytes: number
    signal?: AbortSignal
  },
): Promise<WorkspaceReviewDiffLayer> {
  const result = await runReadOnlyGit(repositoryRoot, args, {
    allowExitCodes: options.allowExitCodes,
    maxBytes: options.maxBytes,
    allowTruncated: true,
    configOverrides: options.configOverrides,
    signal: options.signal,
  })
  const rawDiff = result.stdout.toString('utf8')
  const binary = /(?:Binary files .* differ|GIT binary patch)/u.test(rawDiff)
  const parsed = binary
    ? { hunks: [], truncated: false }
    : parseUnifiedDiffBounded(rawDiff, MAX_GIT_DIFF_LINES_PER_LAYER)
  const truncated = result.truncated || parsed.truncated
  const limitMb = Math.max(1, Math.round(options.maxBytes / 1024 / 1024))
  const notice = result.truncated
    ? `该层 Diff 内容较大，已按 ${limitMb} MB 上限截断。`
    : parsed.truncated
      ? `该层 Diff 行数较多，已显示前 ${MAX_GIT_DIFF_LINES_PER_LAYER} 行。`
      : !binary && rawDiff && parsed.hunks.length === 0
      ? '该层使用了普通 unified diff 之外的格式。'
      : undefined
  return { kind, hunks: parsed.hunks, binary, truncated, ...(notice ? { notice } : {}) }
}
