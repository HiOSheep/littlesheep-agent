// Resolves repository scope, revision layers, branch, and upstream metadata for review.

import { relative, resolve } from 'node:path'
import { runReadOnlyGit } from './workspace-git-command.js'
import {
  literalGitPathspec,
  nativeRelativePathToGitPath,
  normalizeGitPath,
} from './workspace-git-review-parsers.js'

export interface RepositoryContext {
  repositoryRoot: string
  scopePathspec: string
  scopePrefix: string
  hasHead: boolean
}

export async function resolveRepositoryContext(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<RepositoryContext | null> {
  const rootResult = await runReadOnlyGit(workspacePath, ['rev-parse', '--show-toplevel'], {
    allowExitCodes: [0, 128],
    signal,
  })
  if (rootResult.code !== 0) return null
  const repositoryRoot = resolve(rootResult.stdout.toString('utf8').trim())
  const scope = normalizeGitPath(nativeRelativePathToGitPath(relative(repositoryRoot, workspacePath)))
  if (scope === '..' || scope.startsWith('../')) return null
  const headResult = await runReadOnlyGit(repositoryRoot, ['rev-parse', '--verify', 'HEAD'], {
    allowExitCodes: [0, 128],
    signal,
  })
  return {
    repositoryRoot,
    scopePathspec: scope ? literalGitPathspec(scope) : '.',
    scopePrefix: scope ? `${scope}/` : '',
    hasHead: headResult.code === 0,
  }
}

export function repositoryDiffArgs(
  repository: RepositoryContext,
  layer: 'staged' | 'unstaged',
  numstat: boolean,
  pathspecs = [repository.scopePathspec],
): string[] {
  return [
    'diff',
    ...(layer === 'staged' ? ['--cached'] : []),
    ...(numstat ? ['--numstat', '-z'] : ['--no-color', '--unified=3']),
    '--no-ext-diff', '--no-textconv', '--find-renames',
    ...(layer === 'staged' && repository.hasHead ? ['HEAD'] : []),
    '--', ...pathspecs,
  ]
}

export async function readRepositoryMetadata(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<{ branch?: string; upstream?: string; ahead: number; behind: number }> {
  const [branch, upstream] = await Promise.all([
    readBranch(repositoryRoot, signal),
    readUpstream(repositoryRoot, signal),
  ])
  return { branch, ...upstream }
}

async function readBranch(repositoryRoot: string, signal?: AbortSignal): Promise<string | undefined> {
  const branch = await runReadOnlyGit(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    allowExitCodes: [0, 1, 128],
    signal,
  })
  if (branch.code === 0) return branch.stdout.toString('utf8').trim() || undefined
  const detached = await runReadOnlyGit(repositoryRoot, ['rev-parse', '--short', 'HEAD'], {
    allowExitCodes: [0, 128],
    signal,
  })
  const sha = detached.stdout.toString('utf8').trim()
  return sha ? `detached@${sha}` : undefined
}

async function readUpstream(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<{ upstream?: string; ahead: number; behind: number }> {
  const upstreamResult = await runReadOnlyGit(
    repositoryRoot,
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { allowExitCodes: [0, 128], signal },
  )
  if (upstreamResult.code !== 0) return { ahead: 0, behind: 0 }
  const upstream = upstreamResult.stdout.toString('utf8').trim()
  if (!upstream) return { ahead: 0, behind: 0 }
  const counts = await runReadOnlyGit(
    repositoryRoot,
    ['rev-list', '--left-right', '--count', `${upstream}...HEAD`],
    { allowExitCodes: [0, 128], signal },
  )
  if (counts.code !== 0) return { upstream, ahead: 0, behind: 0 }
  const [behindText, aheadText] = counts.stdout.toString('utf8').trim().split(/\s+/u)
  return {
    upstream,
    ahead: Number(aheadText) || 0,
    behind: Number(behindText) || 0,
  }
}
