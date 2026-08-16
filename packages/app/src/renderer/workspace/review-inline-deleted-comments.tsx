// Owns line-comment editing and publication for Monaco inline deleted view zones.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type * as Monaco from 'monaco-editor'
import type { AttachmentRef } from '../api'
import { didLineCommentGestureDrag, type LineCommentRange } from './line-comment-gesture'
import {
  createCommentId,
  formatLineRange,
  LINE_COMMENT_ADD_BUTTON_SIZE,
  LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT,
  LINE_COMMENT_TEXTAREA_MIN_HEIGHT,
  lineCommentZoneHeight,
  readCssPixelValue,
  resolveLineCommentAddButtonLeft,
  updateZoneHeight,
  updateZoneTop,
  type WorkspaceLineComment,
} from './line-comments'
import type { InlineDeletedLineTarget } from './review-inline-deleted-line-numbers'

interface InlineDeletedCommentZone {
  key: string
  kind: 'editor' | 'comment'
  startLine: number
  endLine: number
  top: number
  height: number
  host: HTMLDivElement
  viewZone: Monaco.editor.IViewZone
  comment?: WorkspaceLineComment
}

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
  const [editingRange, setEditingRange] = useState<LineCommentRange | null>(null)
  const [draftText, setDraftText] = useState('')
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [zoneHosts, setZoneHosts] = useState<InlineDeletedCommentZone[]>([])
  const [layerBounds, setLayerBounds] = useState<CSSProperties>()
  const layerRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const editorZoneRef = useRef<{ id: string; zone: InlineDeletedCommentZone } | null>(null)
  const editorSizeFrameRef = useRef<number>()
  const targetBySourceLine = useMemo(
    () => new Map(targets.map((target) => [target.sourceLineNumber, target])),
    [targets],
  )
  const targetBySourceLineRef = useRef(targetBySourceLine)
  targetBySourceLineRef.current = targetBySourceLine
  const targetAnchorKey = targets
    .map((target) => `${target.sourceLineNumber}:${target.modifiedAnchorModelLine}`)
    .join('|')
  const editorZoneHost = zoneHosts.find((zone) => zone.kind === 'editor')?.host ?? null
  const visibleZoneHosts = editingRange === null
    ? zoneHosts.filter((zone) => zone.kind !== 'editor')
    : zoneHosts

  const syncLayerBounds = useCallback(() => {
    const layer = layerRef.current
    const editorNode = editor?.getDomNode()
    const offsetParent = layer?.offsetParent
    if (!layer || !editorNode || !(offsetParent instanceof HTMLElement)) return
    const editorRect = editorNode.getBoundingClientRect()
    const parentRect = offsetParent.getBoundingClientRect()
    const next = {
      top: editorRect.top - parentRect.top,
      left: editorRect.left - parentRect.left,
      width: editorRect.width,
      height: editorRect.height,
      display: targets.length > 0 && editorRect.width > 0.5 && editorRect.height > 0.5
        ? undefined
        : 'none',
    } satisfies CSSProperties
    setLayerBounds((current) => sameLayerBounds(current, next) ? current : next)
  }, [editor, targets.length])

  const syncDraftEditorSize = useCallback(() => {
    const textarea = draftRef.current
    const record = editorZoneRef.current
    if (!editor || !textarea || !record) return
    textarea.style.height = '0px'
    const textareaHeight = Math.max(
      LINE_COMMENT_TEXTAREA_MIN_HEIGHT,
      Math.ceil(textarea.scrollHeight),
    )
    textarea.style.height = `${textareaHeight}px`
    const form = textarea.closest<HTMLFormElement>('.workspace-line-comment-editor')
    const overlay = form?.parentElement
    if (!form || !overlay) return
    const overlayStyle = window.getComputedStyle(overlay)
    const nextZoneHeight = Math.ceil(
      form.getBoundingClientRect().height
      + readCssPixelValue(overlayStyle.paddingTop)
      + readCssPixelValue(overlayStyle.paddingBottom),
    )
    if (!Number.isFinite(nextZoneHeight) || nextZoneHeight <= 0) return
    if (record.zone.viewZone.heightInPx === nextZoneHeight) return
    record.zone.viewZone.heightInPx = nextZoneHeight
    editor.changeViewZones((accessor) => accessor.layoutZone(record.id))
    setZoneHosts((current) => updateZoneHeight(current, record.zone.key, nextZoneHeight))
  }, [editor])

  useLayoutEffect(syncLayerBounds, [syncLayerBounds, targets])

  useEffect(() => {
    if (!editor) return
    const subscription = editor.onDidLayoutChange(() => setLayoutVersion((value) => value + 1))
    return () => subscription.dispose()
  }, [editor])

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const editorNode = editor?.getDomNode()
    const offsetParent = layerRef.current?.offsetParent
    if (!editorNode || !(offsetParent instanceof HTMLElement)) return
    const observer = new ResizeObserver(syncLayerBounds)
    observer.observe(editorNode)
    observer.observe(offsetParent)
    return () => observer.disconnect()
  }, [editor, syncLayerBounds])

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
    setEditingRange(null)
    setDraftText('')
  }, [editingRange, targetBySourceLine])

  useEffect(() => {
    if (!editingRange) return
    const frame = window.requestAnimationFrame(() => draftRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [editingRange, editorZoneHost])

  useLayoutEffect(() => {
    if (editorZoneHost) syncDraftEditorSize()
  }, [draftText, editorZoneHost, syncDraftEditorSize])

  useEffect(() => {
    const textarea = draftRef.current
    if (!editorZoneHost || !textarea || typeof ResizeObserver === 'undefined') return
    let observedWidth = textarea.getBoundingClientRect().width
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width
      if (nextWidth === undefined || Math.abs(nextWidth - observedWidth) < 0.5) return
      observedWidth = nextWidth
      window.cancelAnimationFrame(editorSizeFrameRef.current ?? 0)
      editorSizeFrameRef.current = window.requestAnimationFrame(syncDraftEditorSize)
    })
    observer.observe(textarea)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(editorSizeFrameRef.current ?? 0)
      editorSizeFrameRef.current = undefined
    }
  }, [editorZoneHost, syncDraftEditorSize])

  useLayoutEffect(() => {
    if (!editor) {
      editorZoneRef.current = null
      setZoneHosts([])
      return
    }
    const targetMap = targetBySourceLineRef.current
    const zones: InlineDeletedCommentZone[] = []
    const zoneIds: string[] = []
    let nextEditorZone: { id: string; zone: InlineDeletedCommentZone } | null = null
    let disposed = false
    editor.changeViewZones((accessor) => {
      if (editingRange && hasDeletedLineRange(editingRange, targetMap)) {
        const target = targetMap.get(editingRange.endLine)!
        const zone = createDeletedCommentZone(
          `editor:${editingRange.startLine}-${editingRange.endLine}`,
          'editor',
          editingRange,
          target.modifiedAnchorModelLine,
          LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT,
        )
        zone.viewZone.onDomNodeTop = (top) => {
          zone.top = top
          if (!disposed) setZoneHosts((current) => updateZoneTop(current, zone.key, top))
        }
        const id = accessor.addZone(zone.viewZone)
        nextEditorZone = { id, zone }
        zoneIds.push(id)
        zones.push(zone)
      }
      for (const comment of comments) {
        const range = { startLine: comment.startLine, endLine: comment.endLine ?? comment.startLine }
        if (!hasDeletedLineRange(range, targetMap)) continue
        const target = targetMap.get(range.endLine)!
        const zone = createDeletedCommentZone(
          comment.id,
          'comment',
          range,
          target.modifiedAnchorModelLine,
          lineCommentZoneHeight(comment.text),
          comment,
        )
        zone.viewZone.onDomNodeTop = (top) => {
          zone.top = top
          if (!disposed) setZoneHosts((current) => updateZoneTop(current, zone.key, top))
        }
        zoneIds.push(accessor.addZone(zone.viewZone))
        zones.push(zone)
      }
    })
    editorZoneRef.current = nextEditorZone
    setZoneHosts(zones)
    return () => {
      disposed = true
      if (editorZoneRef.current === nextEditorZone) editorZoneRef.current = null
      editor.changeViewZones((accessor) => zoneIds.forEach((zoneId) => accessor.removeZone(zoneId)))
    }
  }, [comments, editingRange, editor, targetAnchorKey])

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
    setEditingRange(range)
    setDraftText('')
    setHoveredLine(range.endLine)
    const anchor = targetBySourceLineRef.current.get(range.endLine)?.modifiedAnchorModelLine ?? 0
    if (anchor > 0) editor?.revealLineInCenterIfOutsideViewport(anchor)
  }

  function cancelComment() {
    setEditingRange(null)
    setDraftText('')
  }

  function toggleComment(range: LineCommentRange) {
    if (editingRange?.startLine === range.startLine && editingRange.endLine === range.endLine) {
      cancelComment()
      return
    }
    beginComment(range)
  }

  function publishComment() {
    if (!editingRange) return
    const text = draftText.trim()
    if (!text) return
    const comment: WorkspaceLineComment = {
      id: createCommentId(),
      startLine: editingRange.startLine,
      ...(editingRange.endLine === editingRange.startLine ? {} : { endLine: editingRange.endLine }),
      text,
      createdAt: Date.now(),
    }
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
          <button
            className="workspace-line-comment-add"
            type="button"
            aria-label={`为第 ${hoveredTarget.sourceLineNumber} 行添加评论`}
            style={{
              top: hoveredTarget.top + Math.max(0, (hoveredTarget.height - LINE_COMMENT_ADD_BUTTON_SIZE) / 2),
              left: addButtonLeft,
            }}
            onClick={() => toggleComment({
              startLine: hoveredTarget.sourceLineNumber,
              endLine: hoveredTarget.sourceLineNumber,
            })}
          >
            <span className="workspace-line-comment-add-icon" aria-hidden="true" />
          </button>
        </>
      )}
      {visibleZoneHosts.map((zone) => (
        <div
          className={`workspace-line-comment-overlay-zone ${zone.kind}`}
          key={zone.key}
          style={{ top: zone.top, height: zone.height }}
        >
          {zone.kind === 'editor' ? (
            <form
              className="workspace-line-comment-editor"
              onSubmit={(event) => {
                event.preventDefault()
                publishComment()
              }}
            >
              <div className="workspace-line-comment-editor-heading">
                <strong>发布评论</strong>
              </div>
              <textarea
                ref={draftRef}
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                placeholder="添加此更改的上下文"
                rows={3}
                maxLength={4000}
              />
              <div className="workspace-line-comment-editor-actions">
                <span>{formatLineRange(zone.startLine, zone.endLine)}</span>
                <button type="button" onClick={cancelComment}>取消</button>
                <button type="submit" disabled={!draftText.trim()}>发布评论</button>
              </div>
            </form>
          ) : zone.comment ? (
            <article
              className="workspace-line-comment-card"
              data-comment-line={zone.comment.startLine}
            >
              <p>{zone.comment.text}</p>
              <div className="workspace-line-comment-card-meta">
                <span>{formatLineRange(zone.comment.startLine, zone.comment.endLine ?? zone.comment.startLine)}</span>
                <span>已发布</span>
              </div>
            </article>
          ) : null}
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

function createDeletedCommentZone(
  key: string,
  kind: InlineDeletedCommentZone['kind'],
  range: LineCommentRange,
  afterLineNumber: number,
  height: number,
  comment?: WorkspaceLineComment,
): InlineDeletedCommentZone {
  const host = document.createElement('div')
  host.className = `workspace-line-comment-zone ${kind}`
  host.setAttribute('aria-hidden', 'true')
  const viewZone: Monaco.editor.IViewZone = {
    afterLineNumber,
    heightInPx: height,
    domNode: host,
  }
  return {
    key,
    kind,
    startLine: range.startLine,
    endLine: range.endLine,
    top: -height,
    height,
    host,
    viewZone,
    ...(comment ? { comment } : {}),
  }
}

function sameLayerBounds(current: CSSProperties | undefined, next: CSSProperties): boolean {
  if (!current) return false
  return current.top === next.top
    && current.left === next.left
    && current.width === next.width
    && current.height === next.height
    && current.display === next.display
}
