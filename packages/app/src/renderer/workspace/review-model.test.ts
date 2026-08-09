import { describe, expect, it } from 'vitest'
import type { WorkspaceReviewFile } from '../../shared/workspace-review-contracts'
import {
  buildWorkspaceReviewTree,
  collectWorkspaceReviewFolderPaths,
  selectWorkspaceReviewPath,
} from './review-model'

describe('workspace review tree', () => {
  it('contains only directories needed by changed files and aggregates line counts', () => {
    const tree = buildWorkspaceReviewTree([
      reviewFile('src/main/a.ts', 3, 1),
      reviewFile('src/ui/b.tsx', 5, 2),
      reviewFile('README.md', 1, 0),
    ])
    expect(tree.map((node) => node.name)).toEqual(['src', 'README.md'])
    expect(tree[0]).toMatchObject({ kind: 'folder', path: 'src', additions: 8, deletions: 3, fileCount: 2 })
    expect(collectWorkspaceReviewFolderPaths(tree)).toEqual(['src', 'src/main', 'src/ui'])
  })

  it('keeps a POSIX backslash filename distinct from a nested path', () => {
    const tree = buildWorkspaceReviewTree([
      reviewFile('a\\b.ts', 1, 0),
      reviewFile('a/b.ts', 2, 0),
    ])
    expect(tree.map((node) => `${node.kind}:${node.path}`)).toEqual([
      'folder:a',
      'file:a\\b.ts',
    ])
  })

  it('keeps a selected changed file and falls back when it disappears', () => {
    const files = [reviewFile('a.ts', 1, 0), reviewFile('b.ts', 2, 1)]
    expect(selectWorkspaceReviewPath(files, 'b.ts')).toBe('b.ts')
    expect(selectWorkspaceReviewPath(files, 'missing.ts')).toBe('a.ts')
    expect(selectWorkspaceReviewPath([], 'a.ts')).toBeNull()
  })

  it('marks folder totals unavailable when a child count is bounded', () => {
    const unavailable = { ...reviewFile('src/large.txt', 0, 0), countAvailable: false }
    const tree = buildWorkspaceReviewTree([reviewFile('src/a.ts', 1, 0), unavailable])
    expect(tree[0]).toMatchObject({
      kind: 'folder',
      path: 'src',
      additions: 1,
      deletions: 0,
      countAvailable: false,
    })
  })
})

function reviewFile(path: string, additions: number, deletions: number): WorkspaceReviewFile {
  return {
    path,
    absolutePath: `D:\\repo\\${path.replace(/\//gu, '\\')}`,
    status: 'modified',
    additions,
    deletions,
    staged: false,
    unstaged: true,
    binary: false,
    countAvailable: true,
  }
}
