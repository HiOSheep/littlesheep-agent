// Owns source line-number projection and interaction targets for inline deleted diff zones.
import type * as Monaco from 'monaco-editor'

const DELETED_MARGIN_ZONE_SELECTOR = '.inline-deleted-margin-view-zone'
const DELETED_CONTENT_ZONE_SELECTOR = '.view-lines.line-delete[monaco-view-zone]'
const DELETED_LINE_NUMBER_CLASS = 'workspace-review-inline-deleted-line-number'
const DELETED_LINE_NUMBER_SIGNATURE = 'workspaceReviewDeletedLineNumbers'

interface ReviewLineChange {
  originalStartLineNumber: number
  originalEndLineNumber: number
  modifiedStartLineNumber?: number
  modifiedEndLineNumber?: number
}

interface ReviewOriginalModel {
  getLineCount(): number
  getLineContent(lineNumber: number): string
}

export interface InlineDeletedLineNumberGroup {
  originalModelLineNumbers: number[]
  sourceLineNumbers: string[]
  sourceLines: string[]
}

export interface ReviewInlineDeletedLineNumbers {
  refresh(): void
  dispose(): void
}

export interface InlineDeletedLineTarget {
  originalModelLineNumber: number
  sourceLineNumber: number
  sourceLine: string
  top: number
  height: number
  modifiedAnchorModelLine: number
  contentZone: HTMLElement
}

/**
 * Monaco renders deleted lines as view zones in an inline diff, so its normal
 * line-number callback never sees them. This keeps a source-number layer
 * attached to those zones without changing either diff text model.
 */
export function attachReviewInlineDeletedLineNumbers(
  editor: Monaco.editor.IStandaloneDiffEditor,
  sourceLineNumber: (originalModelLineNumber: number) => string,
  lineHeightOption: Monaco.editor.EditorOption.lineHeight,
  onTargetsChange: (targets: InlineDeletedLineTarget[]) => void = () => undefined,
): ReviewInlineDeletedLineNumbers {
  const modifiedEditor = editor.getModifiedEditor()
  const editorRoot = modifiedEditor.getDomNode()
  if (!editorRoot) return { refresh: () => undefined, dispose: () => undefined }

  let frame: number | null = null
  let disposed = false
  const refresh = () => {
    if (disposed || frame !== null) return
    frame = window.requestAnimationFrame(() => {
      frame = null
      onTargetsChange(syncInlineDeletedLineNumbers(
        editor,
        editorRoot,
        sourceLineNumber,
        lineHeightOption,
      ))
    })
  }
  const subscriptions = [
    editor.onDidUpdateDiff(refresh),
    editor.onDidChangeModel(refresh),
    modifiedEditor.onDidLayoutChange(refresh),
    modifiedEditor.onDidChangeConfiguration(refresh),
    modifiedEditor.onDidScrollChange(refresh),
  ]
  const observer = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver((records) => {
      if (mutationTouchesDeletedZone(records)) refresh()
    })
  observer?.observe(editorRoot, { childList: true, subtree: true })
  refresh()

  return {
    refresh,
    dispose: () => {
      disposed = true
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = null
      observer?.disconnect()
      subscriptions.forEach((subscription) => subscription.dispose())
      clearInlineDeletedLineNumbers(editorRoot)
      onTargetsChange([])
    },
  }
}

export function collectInlineDeletedLineNumberGroups(
  changes: readonly ReviewLineChange[],
  originalModel: ReviewOriginalModel,
  sourceLineNumber: (originalModelLineNumber: number) => string,
): InlineDeletedLineNumberGroup[] {
  const lineCount = originalModel.getLineCount()
  return changes
    .filter((change) => change.originalEndLineNumber !== 0)
    .map((change) => {
      const start = change.originalStartLineNumber
      const end = change.originalEndLineNumber
      const originalModelLineNumbers = start >= 1 && end >= start && end <= lineCount
        ? Array.from({ length: end - start + 1 }, (_, index) => start + index)
        : []
      return {
        originalModelLineNumbers,
        sourceLineNumbers: originalModelLineNumbers.map(sourceLineNumber),
        sourceLines: originalModelLineNumbers.map((lineNumber) => originalModel.getLineContent(lineNumber)),
      }
    })
}

/** Returns the first rendered row occupied by each original model line. */
export function resolveDeletedLineViewRowStarts(
  sourceLines: readonly string[],
  renderedViewLines: readonly string[],
): number[] {
  if (sourceLines.length === 0 || renderedViewLines.length < sourceLines.length) return []
  const exact = matchRenderedRows(sourceLines, renderedViewLines, 0, 0, new Map())
  if (exact) return exact

  // Token rendering can normalize unusual whitespace. Preserve a stable,
  // one-row minimum fallback rather than allowing later labels to disappear.
  return sourceLines.map((_, index) => index)
}

function syncInlineDeletedLineNumbers(
  editor: Monaco.editor.IStandaloneDiffEditor,
  editorRoot: HTMLElement,
  sourceLineNumber: (originalModelLineNumber: number) => string,
  lineHeightOption: Monaco.editor.EditorOption.lineHeight,
): InlineDeletedLineTarget[] {
  const originalModel = editor.getOriginalEditor().getModel()
  const changes = editor.getLineChanges()
  if (!originalModel || !changes) {
    clearInlineDeletedLineNumbers(editorRoot)
    return []
  }

  const groups = collectInlineDeletedLineNumberGroups(changes, originalModel, sourceLineNumber)
  const deletedChanges = changes.filter((change) => change.originalEndLineNumber !== 0)
  const contentZones = new Map<string, HTMLElement>()
  editorRoot.querySelectorAll<HTMLElement>(DELETED_CONTENT_ZONE_SELECTOR).forEach((zone) => {
    clearDeletedLineTargets(zone)
    const zoneId = zone.getAttribute('monaco-view-zone')
    if (zoneId) contentZones.set(zoneId, zone)
  })
  const marginZones = Array.from(
    editorRoot.querySelectorAll<HTMLElement>(DELETED_MARGIN_ZONE_SELECTOR),
  )
  const layout = editor.getModifiedEditor().getLayoutInfo()
  const lineHeight = editor.getModifiedEditor().getOption(lineHeightOption)
  const editorRootRect = editorRoot.getBoundingClientRect()
  const targets: InlineDeletedLineTarget[] = []

  marginZones.forEach((marginZone, index) => {
    const group = groups[index]
    const change = deletedChanges[index]
    const zoneId = marginZone.getAttribute('monaco-view-zone')
    const contentZone = zoneId ? contentZones.get(zoneId) : undefined
    if (!group || group.sourceLines.length === 0 || !contentZone) {
      clearMarginZoneLineNumbers(marginZone)
      return
    }

    const renderedRows = Array.from(contentZone.children)
      .filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('view-line'))
    const rowStarts = resolveDeletedLineViewRowStarts(
      group.sourceLines,
      renderedRows.map((row) => row.textContent ?? ''),
    )
    if (rowStarts.length !== group.sourceLines.length) {
      clearMarginZoneLineNumbers(marginZone)
      return
    }

    const rowTops = rowStarts.map((rowIndex) => readRowTop(renderedRows[rowIndex], rowIndex, lineHeight))
    const contentTop = contentZone.getBoundingClientRect().top - editorRootRect.top
    group.sourceLineNumbers.forEach((lineNumber, lineIndex) => {
      const numericLineNumber = Number.parseInt(lineNumber, 10)
      if (!Number.isSafeInteger(numericLineNumber) || numericLineNumber < 1) return
      const firstRow = rowStarts[lineIndex]!
      const nextRow = rowStarts[lineIndex + 1] ?? renderedRows.length
      for (let rowIndex = firstRow; rowIndex < nextRow; rowIndex += 1) {
        const row = renderedRows[rowIndex]
        if (!row) continue
        row.dataset.workspaceReviewDeletedModelLine = String(group.originalModelLineNumbers[lineIndex])
        row.dataset.workspaceReviewDeletedSourceLine = String(numericLineNumber)
      }
      targets.push({
        originalModelLineNumber: group.originalModelLineNumbers[lineIndex]!,
        sourceLineNumber: numericLineNumber,
        sourceLine: group.sourceLines[lineIndex] ?? '',
        top: contentTop + rowTops[lineIndex]!,
        height: Math.max(lineHeight, (nextRow - firstRow) * lineHeight),
        modifiedAnchorModelLine: resolveModifiedAnchorModelLine(change),
        contentZone,
      })
    })
    const signature = JSON.stringify({
      lineNumbers: group.sourceLineNumbers,
      rowTops,
      lineHeight,
      lineNumbersLeft: layout.lineNumbersLeft,
      lineNumbersWidth: layout.lineNumbersWidth,
    })
    const visibleLineNumberCount = group.sourceLineNumbers.filter(Boolean).length
    if (
      marginZone.dataset[DELETED_LINE_NUMBER_SIGNATURE] === signature
      && marginZone.querySelectorAll(`.${DELETED_LINE_NUMBER_CLASS}`).length === visibleLineNumberCount
    ) return

    clearMarginZoneLineNumbers(marginZone)
    group.sourceLineNumbers.forEach((lineNumber, lineIndex) => {
      if (!lineNumber) return
      const node = marginZone.ownerDocument.createElement('div')
      node.className = DELETED_LINE_NUMBER_CLASS
      node.textContent = lineNumber
      node.style.top = `${rowTops[lineIndex]}px`
      node.style.left = `${layout.lineNumbersLeft}px`
      node.style.width = `${layout.lineNumbersWidth}px`
      node.style.height = `${lineHeight}px`
      node.style.lineHeight = `${lineHeight}px`
      marginZone.appendChild(node)
    })
    marginZone.dataset[DELETED_LINE_NUMBER_SIGNATURE] = signature
  })
  return targets
}

function resolveModifiedAnchorModelLine(change: ReviewLineChange | undefined): number {
  if (!change) return 0
  if (change.modifiedEndLineNumber && change.modifiedEndLineNumber > 0) {
    return change.modifiedEndLineNumber
  }
  return Math.max(0, (change.modifiedStartLineNumber ?? 1) - 1)
}

function matchRenderedRows(
  sourceLines: readonly string[],
  renderedViewLines: readonly string[],
  sourceIndex: number,
  renderedIndex: number,
  memo: Map<string, number[] | null>,
): number[] | null {
  if (sourceIndex === sourceLines.length) {
    return renderedIndex === renderedViewLines.length ? [] : null
  }
  const key = `${sourceIndex}:${renderedIndex}`
  if (memo.has(key)) return memo.get(key) ?? null

  const remainingSourceLines = sourceLines.length - sourceIndex - 1
  const lastPossibleEnd = renderedViewLines.length - remainingSourceLines
  let renderedLine = ''
  for (let end = renderedIndex + 1; end <= lastPossibleEnd; end += 1) {
    renderedLine += renderedViewLines[end - 1] ?? ''
    if (canonicalLine(renderedLine) !== canonicalLine(sourceLines[sourceIndex] ?? '')) continue
    const rest = matchRenderedRows(sourceLines, renderedViewLines, sourceIndex + 1, end, memo)
    if (rest) {
      const result = [renderedIndex, ...rest]
      memo.set(key, result)
      return result
    }
  }
  memo.set(key, null)
  return null
}

function canonicalLine(value: string): string {
  return value
    .replace(/\u00a0/gu, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/gu, '')
    .replace(/[ \t]+/gu, ' ')
}

function readRowTop(row: HTMLElement | undefined, rowIndex: number, lineHeight: number): number {
  const top = row ? Number.parseFloat(row.style.top) : Number.NaN
  return Number.isFinite(top) ? top : rowIndex * lineHeight
}

function mutationTouchesDeletedZone(records: readonly MutationRecord[]): boolean {
  for (const record of records) {
    const changedNodes = [...record.addedNodes, ...record.removedNodes]
    if (changedNodes.length > 0 && changedNodes.every(isDeletedLineNumberNode)) continue
    const target = record.target instanceof Element ? record.target : record.target.parentElement
    if (target?.closest(DELETED_CONTENT_ZONE_SELECTOR)) return true
    if (changedNodes.some(nodeTouchesDeletedZone)) return true
  }
  return false
}

function nodeTouchesDeletedZone(node: Node): boolean {
  if (!(node instanceof Element)) return false
  return node.matches(`${DELETED_MARGIN_ZONE_SELECTOR}, ${DELETED_CONTENT_ZONE_SELECTOR}`)
    || node.querySelector(`${DELETED_MARGIN_ZONE_SELECTOR}, ${DELETED_CONTENT_ZONE_SELECTOR}`) !== null
}

function isDeletedLineNumberNode(node: Node): boolean {
  return node instanceof Element && node.classList.contains(DELETED_LINE_NUMBER_CLASS)
}

function clearInlineDeletedLineNumbers(editorRoot: HTMLElement): void {
  editorRoot.querySelectorAll<HTMLElement>(DELETED_MARGIN_ZONE_SELECTOR).forEach(clearMarginZoneLineNumbers)
  editorRoot.querySelectorAll<HTMLElement>(DELETED_CONTENT_ZONE_SELECTOR).forEach(clearDeletedLineTargets)
}

function clearMarginZoneLineNumbers(marginZone: HTMLElement): void {
  marginZone.querySelectorAll(`.${DELETED_LINE_NUMBER_CLASS}`).forEach((node) => node.remove())
  delete marginZone.dataset[DELETED_LINE_NUMBER_SIGNATURE]
}

function clearDeletedLineTargets(contentZone: HTMLElement): void {
  contentZone.querySelectorAll<HTMLElement>('.view-line').forEach((row) => {
    delete row.dataset.workspaceReviewDeletedModelLine
    delete row.dataset.workspaceReviewDeletedSourceLine
  })
}
