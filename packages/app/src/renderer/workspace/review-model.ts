// Builds the sparse changed-file tree and review status labels without renderer state.
import type { WorkspaceReviewFile, WorkspaceReviewFileStatus } from '../../shared/workspace-review-contracts'

export interface WorkspaceReviewTreeFolder {
  kind: 'folder'
  name: string
  path: string
  additions: number
  deletions: number
  countAvailable: boolean
  fileCount: number
  children: WorkspaceReviewTreeNode[]
}

export interface WorkspaceReviewTreeFile {
  kind: 'file'
  name: string
  path: string
  additions: number
  deletions: number
  countAvailable: boolean
  fileCount: 1
  file: WorkspaceReviewFile
}

export type WorkspaceReviewTreeNode = WorkspaceReviewTreeFolder | WorkspaceReviewTreeFile

interface MutableFolder {
  name: string
  path: string
  folders: Map<string, MutableFolder>
  files: WorkspaceReviewFile[]
}

export function buildWorkspaceReviewTree(files: WorkspaceReviewFile[]): WorkspaceReviewTreeNode[] {
  const root: MutableFolder = { name: '', path: '', folders: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let folder = root
    for (const part of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${part}` : part
      let child = folder.folders.get(part)
      if (!child) {
        child = { name: part, path, folders: new Map(), files: [] }
        folder.folders.set(part, child)
      }
      folder = child
    }
    folder.files.push(file)
  }
  return materializeFolder(root).children
}

export function collectWorkspaceReviewFolderPaths(nodes: WorkspaceReviewTreeNode[]): string[] {
  const paths: string[] = []
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    paths.push(node.path, ...collectWorkspaceReviewFolderPaths(node.children))
  }
  return paths
}

export function selectWorkspaceReviewPath(
  files: WorkspaceReviewFile[],
  currentPath: string | null,
): string | null {
  if (currentPath && files.some((file) => file.path === currentPath)) return currentPath
  return files[0]?.path ?? null
}

export function workspaceReviewStatusLabel(status: WorkspaceReviewFileStatus): string {
  if (status === 'added') return 'A'
  if (status === 'deleted') return 'D'
  if (status === 'renamed') return 'R'
  if (status === 'copied') return 'C'
  if (status === 'untracked') return 'U'
  if (status === 'conflicted') return '!'
  if (status === 'type-changed') return 'T'
  return 'M'
}

export function workspaceReviewStatusText(status: WorkspaceReviewFileStatus): string {
  if (status === 'added') return '新增'
  if (status === 'deleted') return '删除'
  if (status === 'renamed') return '重命名'
  if (status === 'copied') return '复制'
  if (status === 'untracked') return '未跟踪'
  if (status === 'conflicted') return '冲突'
  if (status === 'type-changed') return '类型变更'
  return '修改'
}

function materializeFolder(folder: MutableFolder): WorkspaceReviewTreeFolder {
  const children: WorkspaceReviewTreeNode[] = [
    ...[...folder.folders.values()].map(materializeFolder),
    ...folder.files.map((file): WorkspaceReviewTreeFile => ({
      kind: 'file',
      name: file.path.split('/').at(-1) ?? file.path,
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      countAvailable: file.countAvailable,
      fileCount: 1,
      file,
    })),
  ].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return {
    kind: 'folder',
    name: folder.name,
    path: folder.path,
    additions: children.reduce((total, child) => total + child.additions, 0),
    deletions: children.reduce((total, child) => total + child.deletions, 0),
    countAvailable: children.every((child) => child.countAvailable),
    fileCount: children.reduce((total, child) => total + child.fileCount, 0),
    children,
  }
}
