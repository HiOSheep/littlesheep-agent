// Resolves repository scope, revision layers, branch, and upstream metadata for review.

import { relative, resolve } from 'node:path'
import { runReadOnlyGit } from './workspace-git-command.js'
import {
  classifyGitFailure,
  isNotRepositoryFailure,
  WorkspaceGitReadError,
} from './workspace-git-failure.js'
import {
  literalGitPathspec,
  nativeRelativePathToGitPath,
  normalizeGitPath,
} from './workspace-git-review-parsers.js'

export interface RepositoryContext {
  repositoryRoot: string
  scopePathspec: string
  scopePrefix: string
}

export async function resolveRepositoryContext(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<RepositoryContext | null> {
  const rootResult = await runReadOnlyGit(workspacePath, ['rev-parse', '--show-toplevel'], {
    allowExitCodes: [0, 128],
    signal,
  })
  if (rootResult.code !== 0) {
    // UX-28 item 1: a non-zero `rev-parse` is not automatically "not a repository". The
    // stderr is classified, so a damaged object store or a `safe.directory` refusal is
    // reported as itself; only a genuine "not a git repository" stays null.
    const failure = classifyGitFailure(new Error(rootResult.stderr || 'git rev-parse failed'))
    if (isNotRepositoryFailure(failure)) return null
    throw new WorkspaceGitReadError(failure)
  }
  const repositoryRoot = resolve(rootResult.stdout.toString('utf8').trim())
  const scope = normalizeGitPath(nativeRelativePathToGitPath(relative(repositoryRoot, workspacePath)))
  if (scope === '..' || scope.startsWith('../')) return null
  return {
    repositoryRoot,
    scopePathspec: scope ? literalGitPathspec(scope) : '.',
    scopePrefix: scope ? `${scope}/` : '',
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
    '--', ...pathspecs,
  ]
}

export async function readDetachedHead(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const detached = await runReadOnlyGit(repositoryRoot, ['rev-parse', '--short', 'HEAD'], {
    allowExitCodes: [0, 128],
    signal,
  })
  const sha = detached.stdout.toString('utf8').trim()
  return sha ? `detached@${sha}` : undefined
}
