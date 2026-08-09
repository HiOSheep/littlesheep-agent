// Pure Git porcelain, numstat and unified-diff parsing for workspace review.

import type {
  WorkspaceReviewDiffHunk,
  WorkspaceReviewFile,
  WorkspaceReviewFileStatus,
} from '../../shared/workspace-review-contracts.js'

export interface WorkspaceReviewStatusRecord {
  path: string
  oldPath?: string
  code: string
  staged: boolean
  unstaged: boolean
}

export interface WorkspaceReviewNumstatRecord {
  path: string
  oldPath?: string
  additions: number
  deletions: number
  binary: boolean
}

export interface WorkspaceReviewParsedDiff {
  hunks: WorkspaceReviewDiffHunk[]
  truncated: boolean
}

export function parsePorcelainStatus(buffer: Buffer): WorkspaceReviewStatusRecord[] {
  const fields = splitNullFields(buffer)
  const records: WorkspaceReviewStatusRecord[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined || field.length < 4) continue
    const code = field.slice(0, 2)
    const path = normalizeGitPath(field.slice(3))
    let oldPath: string | undefined
    if (/[RC]/u.test(code)) {
      const next = fields[index + 1]
      if (next) {
        oldPath = normalizeGitPath(next)
        index += 1
      }
    }
    records.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      code,
      staged: code !== '??' && code[0] !== ' ',
      unstaged: code === '??' || code[1] !== ' ',
    })
  }
  return records
}

export function parseNumstat(buffer: Buffer): WorkspaceReviewNumstatRecord[] {
  const fields = splitNullFields(buffer)
  const records: WorkspaceReviewNumstatRecord[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined) continue
    const firstTab = field.indexOf('\t')
    const secondTab = firstTab < 0 ? -1 : field.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additionsText = field.slice(0, firstTab)
    const deletionsText = field.slice(firstTab + 1, secondTab)
    const inlinePath = field.slice(secondTab + 1)
    const binary = additionsText === '-' || deletionsText === '-'
    const additions = binary ? 0 : Number(additionsText) || 0
    const deletions = binary ? 0 : Number(deletionsText) || 0
    if (inlinePath) {
      records.push({ path: normalizeGitPath(inlinePath), additions, deletions, binary })
      continue
    }
    const oldPath = fields[index + 1]
    const path = fields[index + 2]
    if (!oldPath || !path) continue
    index += 2
    records.push({
      path: normalizeGitPath(path),
      oldPath: normalizeGitPath(oldPath),
      additions,
      deletions,
      binary,
    })
  }
  return records
}

export function parseUnifiedDiff(rawDiff: string): WorkspaceReviewDiffHunk[] {
  return parseUnifiedDiffBounded(rawDiff, Number.POSITIVE_INFINITY).hunks
}

export function parseUnifiedDiffBounded(rawDiff: string, maxLines: number): WorkspaceReviewParsedDiff {
  const hunks: WorkspaceReviewDiffHunk[] = []
  let current: WorkspaceReviewDiffHunk | null = null
  let oldLine = 0
  let newLine = 0
  let renderedLines = 0
  let truncated = false
  for (const line of rawDiff.replace(/\r\n/gu, '\n').split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/u.exec(line)
    if (header) {
      if (renderedLines >= maxLines) {
        truncated = true
        break
      }
      oldLine = Number(header[1])
      newLine = Number(header[3])
      current = {
        header: line,
        oldStart: oldLine,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newLine,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    const rendered = line.startsWith('+')
      || line.startsWith('-')
      || line.startsWith(' ')
      || line.startsWith('\\')
    if (rendered && renderedLines >= maxLines) {
      truncated = true
      break
    }
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'addition', content: line.slice(1), oldLine: null, newLine })
      newLine += 1
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'deletion', content: line.slice(1), oldLine, newLine: null })
      oldLine += 1
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', content: line.slice(1), oldLine, newLine })
      oldLine += 1
      newLine += 1
    } else if (line.startsWith('\\')) {
      current.lines.push({ kind: 'meta', content: line, oldLine: null, newLine: null })
    }
    if (rendered) renderedLines += 1
  }
  return { hunks, truncated }
}

export function workspaceReviewStatusFromCode(code: string): WorkspaceReviewFileStatus {
  if (code === '??') return 'untracked'
  if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted'
  if (code.includes('R')) return 'renamed'
  if (code.includes('C')) return 'copied'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  if (code.includes('T')) return 'type-changed'
  return 'modified'
}

export function scopeStatusRecord(
  record: WorkspaceReviewStatusRecord,
  scopePrefix: string,
): WorkspaceReviewStatusRecord | null {
  if (!scopePrefix) return record
  const currentInside = record.path.startsWith(scopePrefix)
  const oldInside = Boolean(record.oldPath?.startsWith(scopePrefix))
  if (currentInside) {
    const code = oldInside ? record.code : record.code.replace(/[RC]/gu, 'A')
    return statusRecord(record.path, code, oldInside ? record.oldPath : undefined)
  }
  if (oldInside && record.code.includes('R') && record.oldPath) {
    const code = record.code[0] === 'R' ? 'D ' : ' D'
    return statusRecord(record.oldPath, code)
  }
  return null
}

export function normalizeGitPath(value: string): string {
  return value.replace(/^\.\//u, '')
}

export function nativeRelativePathToGitPath(value: string): string {
  return process.platform === 'win32' ? value.replace(/\\/gu, '/') : value
}

export function literalGitPathspec(path: string): string {
  return `:(literal)${normalizeGitPath(path)}`
}

export function toRepositoryPath(workspaceRelativePath: string, scopePrefix: string): string {
  return `${scopePrefix}${normalizeGitPath(workspaceRelativePath)}`
}

export function toWorkspaceRelativePath(repositoryPath: string, scopePrefix: string): string {
  const normalized = normalizeGitPath(repositoryPath)
  return scopePrefix && normalized.startsWith(scopePrefix)
    ? normalized.slice(scopePrefix.length)
    : normalized
}

export function compareReviewFiles(left: WorkspaceReviewFile, right: WorkspaceReviewFile): number {
  return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' })
}

function statusRecord(path: string, code: string, oldPath?: string): WorkspaceReviewStatusRecord {
  return {
    path,
    ...(oldPath ? { oldPath } : {}),
    code,
    staged: code !== '??' && code[0] !== ' ',
    unstaged: code === '??' || code[1] !== ' ',
  }
}

function splitNullFields(buffer: Buffer): string[] {
  return buffer.toString('utf8').split('\0').filter((field) => field.length > 0)
}
