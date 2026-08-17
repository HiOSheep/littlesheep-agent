// Owns line-comment editing and publication for Monaco inline deleted view zones.
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type * as Monaco from 'monaco-editor'
import type { AttachmentRef } from '../api'
import { didLineCommentGestureDrag, type LineCommentRange } from './line-comment-gesture'
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
import type { InlineDeletedLineTarget } from './review-inline-deleted-line-numbers'

interface PendingDeletedLineGesture {
  pointerId: number
  pressedLine: number
  startX: number
  startY: number
  didDrag: boolean
}

export function WorkspaceReviewInlineDeletedComments({
  editor,
  targets,
  comments,
  onCommentsChange,
  onAddAttachment,
  buildAttachment,
}: {
  editor: Monaco.editor.ICodeEditor | null
  targets: InlineDeletedLineTarget[]
  comments: WorkspaceLineComment[]
  onCommentsChange: (comments: WorkspaceLineComment[]) => void
  onAddAttachment: (attachment: AttachmentRef) => void
  buildAttachment: (comment: WorkspaceLineComment) => AttachmentRef
}) {
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const draft = useLineCommentDraft()
  const { editingRange, draftText } = draft
  const [layoutVersion, setLayoutVersion] = useState(0)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const targetBySourceLine = useMemo(
    () => new Map(targets.map((target) => [target.sourceLineNumber, target])),
    [targets],
  )
  const targetBySourceLineRef = useRef(targetBySourceLine)
  targetBySourceLineRef.current = targetBySourceLine
  const targetAnchorKey = targets
    .map((target) => `${target.sourceLineNumber}:${target.modifiedAnchorModelLine}`)
    .join('|')
  const zoneSpecs = useMemo<LineCommentViewZoneSpec[]>(() => {
    const targetMap = targetBySourceLineRef.current
    const specs: LineCommentViewZoneSpec[] = []
    if (editingRange && hasDeletedLineRange(editingRange, targetMap)) {
      specs.push({
        key: `editor:${editingRange.startLine}-${editingRange.endLine}`,
        kind: 'editor',
        range: editingRange,
        afterLineNumber: targetMap.get(editingRange.endLine)!.modifiedAnchorModelLine,
        height: LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT,
      })
    }
    for (const comment of comments) {
      const range = { startLine: comment.startLine, endLine: comment.endLine ?? comment.startLine }
      if (!hasDeletedLineRange(range, targetMap)) continue
      specs.push({
        key: comment.id,
        kind: 'comment',
        range,
        afterLineNumber: targetMap.get(range.endLine)!.modifiedAnchorModelLine,
        height: lineCommentZoneHeight(comment.text),
        comment,
      })
    }
    return specs
  }, [comments, editingRange, targetAnchorKey])
  const {
    zoneHosts,
    setZoneHosts,
    editorZoneRecordRef,
    editorZoneHost,
  } = useLineCommentViewZones(editor, zoneSpecs)
  const visibleZoneHosts = editingRange === null
    ? zoneHosts.filter((zone) => zone.kind !== 'editor')
    : zoneHosts
  const { layerRef, layerBounds } = useEditorAlignedLayerBounds({
    editor,
    enabled: true,
    visible: targets.length > 0,
    refreshKey: `${layoutVersion}:${targetAnchorKey}`,
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
    if (!editor) return
    const subscription = editor.onDidLayoutChange(() => setLayoutVersion((value) => value + 1))
    return () => subscription.dispose()
  }, [editor])

  useEffect(() => {
    const editorHost = editor?.getDomNode()
    if (!editorHost) return
    let pendingGesture: PendingDeletedLineGesture | null = null
    const readTarget = (eventTarget: EventTarget | null) => readDeletedLineTarget(
      eventTarget,
      targetBySourceLineRef.current,
    )
    const updatePendingGesture = (pointerEvent: PointerEvent) => {
      if (!pendingGesture || pointerEvent.pointerId !== pendingGesture.pointerId || pendingGesture.didDrag) return
      pendingGesture.didDrag = didLineCommentGestureDrag(
        pendingGesture.startX,
        pendingGesture.startY,
        pointerEvent.clientX,
        pointerEvent.clientY,
      )
    }
    const handleEditorPointerMove = (event: Event) => {
      const pointerEvent = event as PointerEvent
      const target = readTarget(pointerEvent.target)
      setHoveredLine(target?.sourceLineNumber ?? null)
      updatePendingGesture(pointerEvent)
    }
    const handlePointerDown = (event: Event) => {
      const pointerEvent = event as PointerEvent
      if (!pointerEvent.isPrimary || pointerEvent.button !== 0 || pointerEvent.defaultPrevented) return
      const targetElement = pointerEvent.target instanceof Element ? pointerEvent.target : null
      if (targetElement?.closest('.workspace-line-comment-add, .workspace-line-comment-overlay-zone')) return
      const target = readTarget(pointerEvent.target)
      if (!target) return
      pendingGesture = {
        pointerId: pointerEvent.pointerId,
        pressedLine: target.sourceLineNumber,
        startX: pointerEvent.clientX,
        startY: pointerEvent.clientY,
        didDrag: false,
      }
    }
    const handlePointerUp = (event: Event) => {
      const pointerEvent = event as PointerEvent
      if (!pendingGesture || pointerEvent.pointerId !== pendingGesture.pointerId) return
      const gesture = pendingGesture
      pendingGesture = null
      const releasedLine = readTarget(pointerEvent.target)?.sourceLineNumber ?? null
      const range = resolveDeletedLineRange(
        gesture.pressedLine,
        releasedLine,
        gesture.didDrag,
        targetBySourceLineRef.current,
      )
      if (!range) return
      if (gesture.didDrag) beginComment(range)
      else toggleComment(range)
    }
    const handlePointerCancel = (event: Event) => {
      const pointerEvent = event as PointerEvent
      if (pendingGesture?.pointerId === pointerEvent.pointerId) pendingGesture = null
    }
    const clearHover = (event: PointerEvent) => {
      const relatedTarget = event.relatedTarget
      if (relatedTarget instanceof Element && relatedTarget.closest('.workspace-review-inline-deleted-comments')) return
      setHoveredLine(null)
    }
    editorHost.addEventListener('pointermove', handleEditorPointerMove, true)
    editorHost.addEventListener('pointerdown', handlePointerDown, true)
    editorHost.addEventListener('pointerleave', clearHover)
    window.addEventListener('pointermove', updatePendingGesture, true)
    window.addEventListener('pointerup', handlePointerUp, true)
    window.addEventListener('pointercancel', handlePointerCancel, true)
    return () => {
      editorHost.removeEventListener('pointermove', handleEditorPointerMove, true)
      editorHost.removeEventListener('pointerdown', handlePointerDown, true)
      editorHost.removeEventListener('pointerleave', clearHover)
      window.removeEventListener('pointermove', updatePendingGesture, true)
      window.removeEventListener('pointerup', handlePointerUp, true)
      window.removeEventListener('pointercancel', handlePointerCancel, true)
    }
  }, [editor, editingRange])

  useEffect(() => {
    if (!editingRange || hasDeletedLineRange(editingRange, targetBySourceLine)) return
    draft.cancel()
  }, [draft.cancel, editingRange, targetBySourceLine])

  const hoveredTarget = hoveredLine === null ? null : targetBySourceLine.get(hoveredLine) ?? null
  const addButtonLeft = useMemo(
    () => editor ? resolveLineCommentAddButtonLeft(editor.getLayoutInfo()) : null,
    [editor, layoutVersion],
  )
  const publishedLines = useMemo(() => {
    const lines = new Set<number>()
    for (const comment of comments) {
      const endLine = comment.endLine ?? comment.startLine
      for (let line = comment.startLine; line <= endLine; line += 1) lines.add(line)
    }
    return lines
  }, [comments])

  function beginComment(range: LineCommentRange) {
    if (!hasDeletedLineRange(range, targetBySourceLineRef.current)) return
    draft.begin(range)
    setHoveredLine(range.endLine)
    const anchor = targetBySourceLineRef.current.get(range.endLine)?.modifiedAnchorModelLine ?? 0
    if (anchor > 0) editor?.revealLineInCenterIfOutsideViewport(anchor)
  }

  function cancelComment() {
    draft.cancel()
  }

  function toggleComment(range: LineCommentRange) {
    if (sameLineCommentRange(editingRange, range)) {
      cancelComment()
      return
    }
    beginComment(range)
  }

  function publishComment() {
    const comment = createLineCommentFromDraft(draft.state)
    if (!comment) return
    onCommentsChange([...comments, comment])
    onAddAttachment(buildAttachment(comment))
    cancelComment()
  }

  return (
    <div
      ref={layerRef}
      className="workspace-line-comment-layer editor-aligned workspace-review-inline-deleted-comments"
      style={layerBounds}
      aria-label="删除行评论"
    >
      {targets.map((target) => publishedLines.has(target.sourceLineNumber) && (
        <div
          className="workspace-review-inline-deleted-comment-state published"
          style={{ top: target.top, height: target.height }}
          key={`published:${target.sourceLineNumber}`}
        />
      ))}
      {hoveredTarget && !editingRange && addButtonLeft !== null && (
        <>
          <div
            className="workspace-review-inline-deleted-comment-state hover"
            style={{ top: hoveredTarget.top, height: hoveredTarget.height }}
          />
          <LineCommentAddButton
            sourceLine={hoveredTarget.sourceLineNumber}
            top={hoveredTarget.top}
            lineHeight={hoveredTarget.height}
            left={addButtonLeft}
            onClick={() => toggleComment({
              startLine: hoveredTarget.sourceLineNumber,
              endLine: hoveredTarget.sourceLineNumber,
            })}
          />
        </>
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
            />
          ) : (
            <LineCommentCard comment={zone.comment} />
          )}
        </div>
      ))}
    </div>
  )
}

function readDeletedLineTarget(
  eventTarget: EventTarget | null,
  targets: Map<number, InlineDeletedLineTarget>,
): InlineDeletedLineTarget | null {
  if (!(eventTarget instanceof Element)) return null
  const row = eventTarget.closest<HTMLElement>('[data-workspace-review-deleted-source-line]')
  const sourceLine = Number.parseInt(row?.dataset.workspaceReviewDeletedSourceLine ?? '', 10)
  return Number.isSafeInteger(sourceLine) ? targets.get(sourceLine) ?? null : null
}

export function resolveDeletedLineRange(
  pressedLine: number,
  releasedLine: number | null,
  didDrag: boolean,
  targets: Map<number, InlineDeletedLineTarget>,
): LineCommentRange | null {
  if (releasedLine === null) return null
  if (didDrag && pressedLine === releasedLine) return null
  const range = {
    startLine: Math.min(pressedLine, releasedLine),
    endLine: Math.max(pressedLine, releasedLine),
  }
  return hasDeletedLineRange(range, targets) ? range : null
}

function hasDeletedLineRange(
  range: LineCommentRange,
  targets: Map<number, InlineDeletedLineTarget>,
): boolean {
  for (let line = range.startLine; line <= range.endLine; line += 1) {
    if (!targets.has(line)) return false
  }
  return true
}
