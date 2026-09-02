// Owns Monaco-backed line comment interaction, view zones, and attachment publication.
import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import type { AttachmentRef } from '../api'
import type { FloatingHelpTip } from '../ui/floating-help'
import {
  didLineCommentGestureDrag,
  resolveLineCommentGesture,
  type LineCommentRange,
} from './line-comment-gesture'
import {
  createLineCommentFromDraft,
  LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT,
  lineCommentZoneHeight,
  resolveLineCommentAddButtonLeft,
  sameLineCommentRange,
  LineCommentAddButton,
  LineCommentCard,
  LineCommentEditor,
  useEditorAlignedLayerBounds,
  useLineCommentDraft,
  useLineCommentEditorAutoSize,
  useLineCommentViewZones,
  type LineCommentViewZoneSpec,
  type WorkspaceLineComment,
} from './line-comment-surface'

export {
  LINE_COMMENT_ADD_BUTTON_SIZE,
  resolveLineCommentAddButtonLeft,
  type WorkspaceLineComment,
} from './line-comment-model'

export interface WorkspaceLineNumberMapping {
  toSourceLine: (modelLineNumber: number) => number | null
  toModelLine: (sourceLineNumber: number) => number | null
}

interface WorkspaceLineCommentOverlayProps {
  editor: Monaco.editor.ICodeEditor | null
  monaco: typeof Monaco | null
  readOnly: boolean
  filePath: string
  fileName: string
  comments: WorkspaceLineComment[]
  onCommentsChange: (comments: WorkspaceLineComment[]) => void
  onCommentUpdate: (previous: WorkspaceLineComment, next: WorkspaceLineComment, attachment: AttachmentRef) => void
  onCommentDelete: (comment: WorkspaceLineComment) => void
  onAddAttachment: (attachment: AttachmentRef) => void
  onTipChange?: (tip: FloatingHelpTip | null) => void
  lineNumbers?: WorkspaceLineNumberMapping
  alignToEditor?: boolean
  buildAttachment?: (comment: WorkspaceLineComment) => AttachmentRef
}

interface LineMetric {
  top: number
  height: number
}

interface PendingLineCommentGesture {
  pointerId: number
  pressedLine: number
  startX: number
  startY: number
  didDrag: boolean
}

const IDENTITY_LINE_NUMBERS: WorkspaceLineNumberMapping = {
  toSourceLine: (lineNumber) => lineNumber,
  toModelLine: (lineNumber) => lineNumber,
}

/**
 * Monaco owns the scrolling surface: the add button follows visible line
 * coordinates while editors and published cards live in native view zones.
 */
export function WorkspaceLineCommentOverlay({
  editor,
  monaco,
  readOnly,
  filePath,
  fileName,
  comments,
  onCommentsChange,
  onCommentUpdate,
  onCommentDelete,
  onAddAttachment,
  onTipChange,
  lineNumbers = IDENTITY_LINE_NUMBERS,
  alignToEditor = false,
  buildAttachment,
}: WorkspaceLineCommentOverlayProps) {
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const draft = useLineCommentDraft()
  const { editingRange, draftText } = draft
  const editingCommentId = draft.state.commentId
  const [layoutVersion, setLayoutVersion] = useState(0)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const mappedEditingRange = useMemo(
    () => editingRange ? mapModelRangeToSource(editingRange, lineNumbers) : null,
    [editingRange, lineNumbers],
  )
  const activeEditingRange = readOnly && mappedEditingRange ? editingRange : null
  const activeSourceRange = readOnly ? mappedEditingRange : null
  const mappedComments = useMemo(() => comments.flatMap((comment) => {
    const modelRange = mapSourceRangeToModel({
      startLine: comment.startLine,
      endLine: comment.endLine ?? comment.startLine,
    }, lineNumbers)
    return modelRange ? [{ comment, modelRange }] : []
  }), [comments, lineNumbers])
  const zoneSpecs = useMemo<LineCommentViewZoneSpec[]>(() => {
    const model = editor?.getModel()
    if (!model) return []
    const specs: LineCommentViewZoneSpec[] = []
    if (activeEditingRange && activeSourceRange) {
      const modelEndLine = Math.min(activeEditingRange.endLine, model.getLineCount())
      specs.push({
        key: `editor:${activeEditingRange.startLine}-${modelEndLine}`,
        kind: 'editor',
        range: activeSourceRange,
        afterLineNumber: modelEndLine,
        height: LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT,
      })
    }
    for (const { comment, modelRange } of mappedComments) {
      if (comment.id === editingCommentId) continue
      specs.push({
        key: comment.id,
        kind: 'comment',
        range: { startLine: comment.startLine, endLine: comment.endLine ?? comment.startLine },
        afterLineNumber: Math.min(modelRange.endLine, model.getLineCount()),
        height: lineCommentZoneHeight(comment.text),
        comment,
      })
    }
    return specs
  }, [activeEditingRange, activeSourceRange, editor, editingCommentId, mappedComments])
  const { zoneHosts, setZoneHosts, editorZoneRecordRef, editorZoneHost }
    = useLineCommentViewZones(editor, zoneSpecs)
  const visibleZoneHosts = activeEditingRange === null
    ? zoneHosts.filter((zone) => zone.kind !== 'editor')
    : zoneHosts
  const { layerRef, layerBounds } = useEditorAlignedLayerBounds({
    editor,
    enabled: alignToEditor,
    visible: true,
    refreshKey: layoutVersion,
  })
  useLineCommentEditorAutoSize({
    editor,
    editorZoneHost,
    draftText,
    textareaRef: draftRef,
    editorZoneRecordRef,
    setZoneHosts,
  })

  useEffect(() => {
    if (!editor || !monaco) return
    const editorHost = editor.getDomNode()
    const clearHoveredLine = (event: PointerEvent) => {
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Element && relatedTarget.closest('.workspace-line-comment-layer')) return
      setHoveredLine(null)
    }
    editorHost?.addEventListener('pointerleave', clearHoveredLine)
    const subscriptions = [
      editor.onMouseMove((event) => {
        const browserEvent = event.event.browserEvent
        const modelLine = readCommentableLineAtClientPoint(
          editor,
          monaco,
          event.target,
          browserEvent.clientX,
          browserEvent.clientY,
        )
        setHoveredLine(modelLine !== null && lineNumbers.toSourceLine(modelLine) !== null
          ? modelLine
          : null)
      }),
      editor.onDidScrollChange(() => setLayoutVersion((value) => value + 1)),
      editor.onDidLayoutChange(() => setLayoutVersion((value) => value + 1)),
      editor.onDidChangeModel(() => setLayoutVersion((value) => value + 1)),
      editor.onDidChangeModelContent(() => setLayoutVersion((value) => value + 1)),
    ]
    return () => {
      editorHost?.removeEventListener('pointerleave', clearHoveredLine)
      subscriptions.forEach((subscription) => subscription.dispose())
    }
  }, [editor, lineNumbers, monaco])

  useEffect(() => {
    if (!editor || !monaco || !readOnly) return
    const editorHost = editor.getDomNode()
    if (!editorHost) return
    let pendingGesture: PendingLineCommentGesture | null = null
    let resolutionFrame: number | null = null
    const beginReadOnlyLineGesture = (event: Event) => {
      const pointerEvent = event as PointerEvent
      if (!pointerEvent.isPrimary || pointerEvent.button !== 0 || pointerEvent.defaultPrevented) return
      const targetElement = pointerEvent.target instanceof Element ? pointerEvent.target : null
      if (targetElement?.closest('.workspace-line-comment-add, .workspace-line-comment-overlay-zone')) return
      const mouseTarget = editor.getTargetAtClientPoint(pointerEvent.clientX, pointerEvent.clientY)
      const line = readCommentableLineAtClientPoint(
        editor,
        monaco,
        mouseTarget,
        pointerEvent.clientX,
        pointerEvent.clientY,
      )
      if (line === null || lineNumbers.toSourceLine(line) === null) return
      pendingGesture = {
        pointerId: pointerEvent.pointerId,
        pressedLine: line,
        startX: pointerEvent.clientX,
        startY: pointerEvent.clientY,
        didDrag: false,
      }
    }
    const updateReadOnlyLineGesture = (event: Event) => {
      const pointerEvent = event as PointerEvent
      if (!pendingGesture || pointerEvent.pointerId !== pendingGesture.pointerId || pendingGesture.didDrag) return
      pendingGesture.didDrag = didLineCommentGestureDrag(
        pendingGesture.startX,
        pendingGesture.startY,
        pointerEvent.clientX,
        pointerEvent.clientY,
      )
    }
    const finishReadOnlyLineGesture = (event: Event) => {
      const pointerEvent = event as PointerEvent
      if (!pendingGesture || pointerEvent.pointerId !== pendingGesture.pointerId) return
      const gesture = pendingGesture
      pendingGesture = null
      const releaseTarget = editor.getTargetAtClientPoint(pointerEvent.clientX, pointerEvent.clientY)
      const rawReleasedLine = readCommentableLineAtClientPoint(
        editor,
        monaco,
        releaseTarget,
        pointerEvent.clientX,
        pointerEvent.clientY,
      )
      const releasedLine = rawReleasedLine !== null && lineNumbers.toSourceLine(rawReleasedLine) !== null
        ? rawReleasedLine
        : null
      const resolveGesture = () => {
        const selection = editor.getSelection()
        const range = resolveLineCommentGesture({
          didDrag: gesture.didDrag,
          pressedLine: gesture.pressedLine,
          releasedLine,
          selection: selection
            ? {
              startLineNumber: selection.startLineNumber,
              endLineNumber: selection.endLineNumber,
              endColumn: selection.endColumn,
            }
            : null,
        })
        if (!range) return
        if (gesture.didDrag) beginComment(range)
        else toggleComment(range)
      }
      if (!gesture.didDrag) {
        resolveGesture()
        return
      }
      if (resolutionFrame !== null) window.cancelAnimationFrame(resolutionFrame)
      resolutionFrame = window.requestAnimationFrame(() => {
        resolutionFrame = null
        resolveGesture()
      })
    }
    const cancelReadOnlyLineGesture = (event: Event) => {
      const pointerEvent = event as PointerEvent
      if (pendingGesture?.pointerId === pointerEvent.pointerId) pendingGesture = null
    }
    editorHost.addEventListener('pointerdown', beginReadOnlyLineGesture, true)
    window.addEventListener('pointermove', updateReadOnlyLineGesture, true)
    window.addEventListener('pointerup', finishReadOnlyLineGesture, true)
    window.addEventListener('pointercancel', cancelReadOnlyLineGesture, true)
    return () => {
      editorHost.removeEventListener('pointerdown', beginReadOnlyLineGesture, true)
      window.removeEventListener('pointermove', updateReadOnlyLineGesture, true)
      window.removeEventListener('pointerup', finishReadOnlyLineGesture, true)
      window.removeEventListener('pointercancel', cancelReadOnlyLineGesture, true)
      if (resolutionFrame !== null) window.cancelAnimationFrame(resolutionFrame)
    }
  }, [editingRange, editor, lineNumbers, monaco, readOnly])

  useEffect(() => {
    if (!readOnly) draft.cancel()
  }, [draft.cancel, readOnly])

  useEffect(() => {
    if (!editor || !monaco) return
    const decorations = editor.createDecorationsCollection()
    const update = () => {
      const next = [] as Monaco.editor.IModelDeltaDecoration[]
      for (const { modelRange } of mappedComments) {
        const endLine = Math.min(modelRange.endLine, editor.getModel()?.getLineCount() ?? modelRange.endLine)
        for (let line = modelRange.startLine; line <= endLine; line += 1) {
          next.push({
            range: new monaco.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              className: 'workspace-comment-published-line',
              marginClassName: 'workspace-comment-published-margin',
            },
          })
        }
      }
      decorations.set(next)
    }
    update()
    return () => decorations.clear()
  }, [editor, mappedComments, monaco])

  const hoveredMetric = useMemo(
    () => hoveredLine === null ? null : readLineMetric(editor, hoveredLine),
    [editor, hoveredLine, layoutVersion],
  )
  const selectedLineMetrics = useMemo(() => {
    if (!activeEditingRange || !editor) return []
    const model = editor.getModel()
    if (!model) return []
    const endLine = Math.min(activeEditingRange.endLine, model.getLineCount())
    const metrics: Array<LineMetric & { line: number }> = []
    for (let line = activeEditingRange.startLine; line <= endLine; line += 1) {
      const metric = readLineMetric(editor, line)
      if (metric) metrics.push({ line, ...metric })
    }
    return metrics
  }, [activeEditingRange, editor, layoutVersion])
  const addButtonLeft = useMemo(
    () => editor ? resolveLineCommentAddButtonLeft(editor.getLayoutInfo()) : null,
    [editor, layoutVersion],
  )
  const hoveredSourceLine = hoveredLine === null ? null : lineNumbers.toSourceLine(hoveredLine)
  function clearEditorSelection() {
    if (!editor || !monaco) return
    const position = editor.getPosition()
    if (!position) return
    editor.setSelection(new monaco.Selection(
      position.lineNumber,
      position.column,
      position.lineNumber,
      position.column,
    ))
  }

  function beginComment(range: LineCommentRange) {
    if (!readOnly || !mapModelRangeToSource(range, lineNumbers)) return
    clearEditorSelection()
    setHoveredLine(range.endLine)
    draft.begin(range)
    editor?.revealLineInCenterIfOutsideViewport(range.endLine)
  }

  function beginEditComment(comment: WorkspaceLineComment) {
    if (!readOnly) return
    const modelRange = mapSourceRangeToModel({
      startLine: comment.startLine,
      endLine: comment.endLine ?? comment.startLine,
    }, lineNumbers)
    if (!modelRange) return
    clearEditorSelection()
    setHoveredLine(modelRange.endLine)
    draft.beginEdit(comment, modelRange)
    editor?.revealLineInCenterIfOutsideViewport(modelRange.endLine)
  }

  function cancelComment() {
    clearEditorSelection()
    draft.cancel()
  }

  function toggleComment(range: LineCommentRange) {
    if (!readOnly) return
    if (sameLineCommentRange(editingRange, range)) {
      cancelComment()
      return
    }
    beginComment(range)
  }

  function publishComment() {
    if (!readOnly || editingRange === null) return
    const sourceRange = mapModelRangeToSource(editingRange, lineNumbers)
    if (!sourceRange) return
    const comment = createLineCommentFromDraft(
      { ...draft.state, editingRange: sourceRange },
      draft.state.commentId || draft.state.commentCreatedAt !== undefined
        ? { id: draft.state.commentId, createdAt: draft.state.commentCreatedAt }
        : undefined,
    )
    if (!comment) return
    const previousComment = draft.state.commentId
      ? comments.find((current) => current.id === draft.state.commentId)
      : undefined
    const nextComments = draft.state.commentId
      ? comments.map((current) => current.id === draft.state.commentId ? comment : current)
      : [...comments, comment]
    onCommentsChange(nextComments)
    const attachment = buildAttachment?.(comment) ?? {
      path: filePath,
      contextPath: filePath,
      name: fileName,
      kind: 'file',
      lineCommentOnly: true,
      lineComments: [{
        id: comment.id,
        startLine: comment.startLine,
        ...(comment.endLine === undefined ? {} : { endLine: comment.endLine }),
        text: comment.text,
      }],
    }
    if (previousComment) onCommentUpdate(previousComment, comment, attachment)
    else onAddAttachment(attachment)
    cancelComment()
  }

  function deleteComment(comment: WorkspaceLineComment) {
    onCommentsChange(comments.filter((current) => current.id !== comment.id))
    onCommentDelete(comment)
  }

  return (
    <div
      ref={layerRef}
      className={`workspace-line-comment-layer ${alignToEditor ? 'editor-aligned' : ''}`}
      style={layerBounds}
      aria-label="代码行评论"
    >
      {activeEditingRange ? selectedLineMetrics.map((metric) => (
        <div
          className="workspace-line-comment-selected-state"
          style={{ top: metric.top, height: metric.height }}
          key={`selected:${metric.line}`}
          aria-hidden="true"
        />
      )) : hoveredMetric && (
        <div
          className="workspace-line-comment-hover-state"
          style={{ top: hoveredMetric.top, height: hoveredMetric.height }}
          aria-hidden="true"
        />
      )}

      {readOnly && hoveredLine !== null && hoveredSourceLine !== null && hoveredMetric
        && addButtonLeft !== null && activeEditingRange === null && (
        <LineCommentAddButton
          sourceLine={hoveredSourceLine}
          top={hoveredMetric.top}
          lineHeight={hoveredMetric.height}
          left={addButtonLeft}
          onClick={() => toggleComment({ startLine: hoveredLine, endLine: hoveredLine })}
        />
      )}

      {visibleZoneHosts.map((zone) => (
        <div
          className={`workspace-line-comment-overlay-zone ${zone.kind}`}
          key={zone.key}
          style={{ top: zone.top, height: zone.height }}
        >
          {zone.kind === 'editor' ? (
            <LineCommentEditor
              textareaRef={draftRef}
              draftText={draftText}
              range={{ startLine: zone.startLine, endLine: zone.endLine }}
              onDraftChange={draft.change}
              onCancel={cancelComment}
              onPublish={publishComment}
              editing={editingCommentId !== undefined}
            />
          ) : (
            <LineCommentCard
              comment={zone.comment}
              onEdit={() => beginEditComment(zone.comment)}
              onDelete={() => deleteComment(zone.comment)}
              onTipChange={onTipChange}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function readCommentableLine(
  target: Monaco.editor.IMouseTarget | null,
  monaco: typeof Monaco,
): number | null {
  if (!target?.position || target.position.lineNumber < 1) return null
  if (target.type === monaco.editor.MouseTargetType.CONTENT_TEXT) {
    return target.position.lineNumber
  }
  if (target.type === monaco.editor.MouseTargetType.CONTENT_EMPTY) {
    return target.detail.isAfterLines ? null : target.position.lineNumber
  }
  if (target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
    return target.detail.isAfterLines ? null : target.position.lineNumber
  }
  return null
}

function readCommentableLineAtClientPoint(
  editor: Monaco.editor.ICodeEditor,
  monaco: typeof Monaco,
  target: Monaco.editor.IMouseTarget | null,
  clientX: number,
  clientY: number,
): number | null {
  const directLine = readCommentableLine(target, monaco)
  if (directLine !== null) return directLine

  const editorNode = editor.getDomNode()
  if (!editorNode) return null
  const editorRect = editorNode.getBoundingClientRect()
  if (
    clientX < editorRect.left
    || clientX >= editorRect.right
    || clientY < editorRect.top
    || clientY >= editorRect.bottom
  ) return null

  const contentX = Math.min(
    editorRect.right - 1,
    Math.max(editorRect.left, editorRect.left + editor.getLayoutInfo().contentLeft + 1),
  )
  return readCommentableLine(editor.getTargetAtClientPoint(contentX, clientY), monaco)
}

function readLineMetric(
  editor: Monaco.editor.ICodeEditor | null,
  line: number,
): LineMetric | null {
  if (!editor || line < 1) return null
  const model = editor.getModel()
  if (!model) return null
  const lineNumber = Math.min(line, model.getLineCount())
  const position = editor.getScrolledVisiblePosition({ lineNumber, column: 1 })
  if (!position) return null
  return { top: position.top, height: position.height }
}

export function mapModelRangeToSource(
  range: LineCommentRange,
  lineNumbers: WorkspaceLineNumberMapping,
): LineCommentRange | null {
  const sourceLines: number[] = []
  for (let modelLine = range.startLine; modelLine <= range.endLine; modelLine += 1) {
    const sourceLine = lineNumbers.toSourceLine(modelLine)
    if (sourceLine === null) return null
    if (sourceLines.length > 0 && sourceLine !== sourceLines[sourceLines.length - 1]! + 1) return null
    sourceLines.push(sourceLine)
  }
  if (sourceLines.length === 0) return null
  return {
    startLine: sourceLines[0]!,
    endLine: sourceLines[sourceLines.length - 1]!,
  }
}

export function mapSourceRangeToModel(
  range: LineCommentRange,
  lineNumbers: WorkspaceLineNumberMapping,
): LineCommentRange | null {
  const modelLines: number[] = []
  for (let sourceLine = range.startLine; sourceLine <= range.endLine; sourceLine += 1) {
    const modelLine = lineNumbers.toModelLine(sourceLine)
    if (modelLine === null) return null
    if (modelLines.length > 0 && modelLine !== modelLines[modelLines.length - 1]! + 1) return null
    modelLines.push(modelLine)
  }
  if (modelLines.length === 0) return null
  return {
    startLine: modelLines[0]!,
    endLine: modelLines[modelLines.length - 1]!,
  }
}
