// Coordinates bounded, layered Git review snapshots and per-file diffs for the Local App API.

import { relative, resolve } from 'node:path'
import type {
  WorkspaceReviewDiffLayerKind,
  WorkspaceReviewFile,
  WorkspaceReviewFileDiff,
  WorkspaceReviewSnapshot,
} from '../../shared/workspace-review-contracts.js'
import { GIT_NULL_DEVICE, isGitUnavailable, runReadOnlyGit } from './workspace-git-command.js'
import {
  findNumstat,
  indexNumstat,
  MAX_GIT_DIFF_TOTAL_BYTES,
  readDiffLayer,
} from './workspace-git-diff.js'
import { readDisabledFilterOverrides } from './workspace-git-filters.js'
import {
  readRepositoryMetadata,
  repositoryDiffArgs,
  resolveRepositoryContext,
} from './workspace-git-repository.js'
import {
  compareReviewFiles,
  literalGitPathspec,
  nativeRelativePathToGitPath,
  normalizeGitPath,
  parsePorcelainStatus,
  scopeStatusRecord,
  toRepositoryPath,
  toWorkspaceRelativePath,
  workspaceReviewStatusFromCode,
} from './workspace-git-review-parsers.js'
import { countUntrackedFiles } from './workspace-git-untracked.js'

const MAX_REVIEW_FILES = 2_000

interface DiffRequest {
  kind: WorkspaceReviewDiffLayerKind
  args: string[]
  allowExitCodes?: number[]
}

export interface WorkspaceReviewReadOptions {
  signal?: AbortSignal
}

export async function readWorkspaceReview(
  workspacePath: string,
  options: WorkspaceReviewReadOptions = {},
): Promise<WorkspaceReviewSnapshot> {
  const root = resolve(workspacePath)
  const generatedAt = new Date().toISOString()
  let repository: Awaited<ReturnType<typeof resolveRepositoryContext>>
  try {
    repository = await resolveRepositoryContext(root, options.signal)
  } catch (error) {
    if (isGitUnavailable(error)) {
      return emptySnapshot(root, generatedAt, 'git-unavailable', 'Git 不可用。')
    }
    throw error
  }
  if (!repository) {
    return emptySnapshot(root, generatedAt, 'not-repository', '当前工作区不是 Git 仓库。')
  }

  const filterOverrides = await readDisabledFilterOverrides(repository.repositoryRoot, options.signal)
  const gitOptions = { configOverrides: filterOverrides, signal: options.signal }
  const [statusResult, stagedResult, unstagedResult, metadata] = await Promise.all([
    runReadOnlyGit(repository.repositoryRoot, [
      'status', '--porcelain=v1', '-z', '--untracked-files=all',
      '--ignore-submodules=dirty', '--', repository.scopePathspec,
    ], gitOptions),
    runReadOnlyGit(
      repository.repositoryRoot,
      repositoryDiffArgs(repository, 'staged', true),
      gitOptions,
    ),
    runReadOnlyGit(
      repository.repositoryRoot,
      repositoryDiffArgs(repository, 'unstaged', true),
      gitOptions,
    ),
    readRepositoryMetadata(repository.repositoryRoot, options.signal),
  ])

  const allRecords = parsePorcelainStatus(statusResult.stdout)
    .map((record) => scopeStatusRecord(record, repository.scopePrefix))
    .filter((record): record is NonNullable<typeof record> => record !== null)
  const records = allRecords.slice(0, MAX_REVIEW_FILES)
  const stagedNumstat = indexNumstat(stagedResult.stdout)
  const unstagedNumstat = indexNumstat(unstagedResult.stdout)
  const untrackedScan = await countUntrackedFiles(
    repository.repositoryRoot,
    records.filter((record) => record.code === '??').map((record) => record.path),
    { maxFiles: MAX_REVIEW_FILES, signal: options.signal },
  )
  const files = records.map((record): WorkspaceReviewFile => {
    const stagedStats = record.staged ? findNumstat(stagedNumstat, record.path, record.oldPath) : undefined
    const unstagedStats = record.unstaged && record.code !== '??'
      ? findNumstat(unstagedNumstat, record.path, record.oldPath)
      : undefined
    const untrackedStats = record.code === '??' ? untrackedScan.counts.get(record.path) : undefined
    const countAvailable = record.code === '??'
      ? untrackedStats?.countAvailable === true
      : (!record.staged || stagedStats !== undefined) && (!record.unstaged || unstagedStats !== undefined)
    return {
      path: toWorkspaceRelativePath(record.path, repository.scopePrefix),
      absolutePath: resolve(repository.repositoryRoot, ...record.path.split('/')),
      ...(record.oldPath
        ? { oldPath: toWorkspaceRelativePath(record.oldPath, repository.scopePrefix) }
        : {}),
      status: workspaceReviewStatusFromCode(record.code),
      additions: (stagedStats?.additions ?? 0)
        + (unstagedStats?.additions ?? 0)
        + (untrackedStats?.additions ?? 0),
      deletions: (stagedStats?.deletions ?? 0) + (unstagedStats?.deletions ?? 0),
      countAvailable,
      staged: record.staged,
      unstaged: record.unstaged,
      binary: Boolean(stagedStats?.binary || unstagedStats?.binary || untrackedStats?.binary),
    }
  }).sort(compareReviewFiles)

  return {
    availability: 'ready',
    workspacePath: root,
    repositoryRoot: repository.repositoryRoot,
    branch: metadata.branch,
    ...(metadata.upstream ? { upstream: metadata.upstream } : {}),
    ahead: metadata.ahead,
    behind: metadata.behind,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    countsComplete: files.every((file) => file.countAvailable)
      && !untrackedScan.limited
      && allRecords.length === records.length,
    totalFiles: allRecords.length,
    filesTruncated: allRecords.length > records.length,
    files,
    generatedAt,
  }
}

export async function readWorkspaceReviewDiff(
  workspacePath: string,
  targetPath: string,
  options: WorkspaceReviewReadOptions = {},
): Promise<WorkspaceReviewFileDiff> {
  const snapshot = await readWorkspaceReview(workspacePath, options)
  if (snapshot.availability !== 'ready' || !snapshot.repositoryRoot) {
    throw new Error(snapshot.message ?? 'Git 审阅不可用。')
  }
  const root = resolve(workspacePath)
  const target = resolve(targetPath)
  const displayPath = normalizeGitPath(nativeRelativePathToGitPath(relative(root, target)))
  const file = snapshot.files.find((candidate) => candidate.path === displayPath)
  if (!file) throw new Error('所选文件已不在当前 Git 更改中。')

  const repository = await resolveRepositoryContext(root, options.signal)
  if (!repository) throw new Error('当前工作区不是 Git 仓库。')
  const filterOverrides = await readDisabledFilterOverrides(repository.repositoryRoot, options.signal)
  const repoPath = toRepositoryPath(file.path, repository.scopePrefix)
  const oldRepoPath = file.oldPath ? toRepositoryPath(file.oldPath, repository.scopePrefix) : undefined
  const pathspecs = oldRepoPath && oldRepoPath !== repoPath
    ? [literalGitPathspec(oldRepoPath), literalGitPathspec(repoPath)]
    : [literalGitPathspec(repoPath)]
  const requests = diffRequests(file, repository, pathspecs, target)
  const maxLayerBytes = Math.max(1, Math.floor(MAX_GIT_DIFF_TOTAL_BYTES / Math.max(1, requests.length)))
  const layers = await Promise.all(requests.map((request) => readDiffLayer(
    repository.repositoryRoot,
    request.kind,
    request.args,
    {
      allowExitCodes: request.allowExitCodes,
      configOverrides: filterOverrides,
      maxBytes: maxLayerBytes,
      signal: options.signal,
    },
  )))
  const hunks = layers.flatMap((layer) => layer.hunks)
  const notice = layers.map((layer) => layer.notice).filter(Boolean).join(' ') || undefined
  return {
    workspacePath: root,
    repositoryRoot: snapshot.repositoryRoot,
    file,
    layers,
    hunks,
    binary: layers.length > 0 && layers.every((layer) => layer.binary),
    truncated: layers.some((layer) => layer.truncated),
    ...(notice ? { notice } : {}),
  }
}

function diffRequests(
  file: WorkspaceReviewFile,
  repository: NonNullable<Awaited<ReturnType<typeof resolveRepositoryContext>>>,
  pathspecs: string[],
  target: string,
): DiffRequest[] {
  if (file.status === 'untracked') {
    return [{
      kind: 'untracked',
      args: [
        'diff', '--no-index', '--no-color', '--unified=3', '--no-ext-diff', '--no-textconv',
        '--', GIT_NULL_DEVICE, target,
      ],
      allowExitCodes: [0, 1],
    }]
  }
  const requests: DiffRequest[] = []
  if (file.staged) {
    requests.push({ kind: 'staged', args: repositoryDiffArgs(repository, 'staged', false, pathspecs) })
  }
  if (file.unstaged) {
    requests.push({ kind: 'unstaged', args: repositoryDiffArgs(repository, 'unstaged', false, pathspecs) })
  }
  return requests
}

function emptySnapshot(
  workspacePath: string,
  generatedAt: string,
  availability: WorkspaceReviewSnapshot['availability'],
  message: string,
): WorkspaceReviewSnapshot {
  return {
    availability,
    workspacePath,
    ahead: 0,
    behind: 0,
    additions: 0,
    deletions: 0,
    countsComplete: true,
    totalFiles: 0,
    filesTruncated: false,
    files: [],
    generatedAt,
    message,
  }
}
