// Owns Monaco-backed line comment interaction, view zones, and attachment publication.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type * as Monaco from 'monaco-editor'
import type { AttachmentRef, AttachmentLineComment } from '../api'
import {
  didLineCommentGestureDrag,
  resolveLineCommentGesture,
  type LineCommentRange,
} from './line-comment-gesture'

export interface WorkspaceLineComment extends AttachmentLineComment {
  id: string
  createdAt: number
}

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
  onAddAttachment: (attachment: AttachmentRef) => void
  lineNumbers?: WorkspaceLineNumberMapping
  alignToEditor?: boolean
  buildAttachment?: (comment: WorkspaceLineComment) => AttachmentRef
}

interface LineMetric {
  top: number
  height: number
}

type LineCommentZoneHost = {
  key: string
  startLine: number
  endLine: number
  modelStartLine: number
  modelEndLine: number
  top: number
  height: number
  host: HTMLDivElement
} & (
  | { kind: 'editor' }
  | { kind: 'comment'; comment: WorkspaceLineComment }
)

interface PendingLineCommentGesture {
  pointerId: number
  pressedLine: number
  startX: number
  startY: number
  didDrag: boolean
}

interface LineCommentEditorZoneRecord {
  id: string
  key: string
  viewZone: Monaco.editor.IViewZone
}

export const LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT = 152
export const LINE_COMMENT_TEXTAREA_MIN_HEIGHT = 62
export const LINE_COMMENT_ADD_BUTTON_SIZE = 22
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
  onAddAttachment,
  lineNumbers = IDENTITY_LINE_NUMBERS,
  alignToEditor = false,
  buildAttachment,
}: WorkspaceLineCommentOverlayProps) {
  const [hoveredLine, setHoveredLine] = useState<number | null>(null)
  const [editingRange, setEditingRange] = useState<LineCommentRange | null>(null)
  const [draftText, setDraftText] = useState('')
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [zoneHosts, setZoneHosts] = useState<LineCommentZoneHost[]>([])
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const editorZoneRecordRef = useRef<LineCommentEditorZoneRecord | null>(null)
  const editorSizeFrameRef = useRef<number>()
  const layerRef = useRef<HTMLDivElement>(null)
  const [layerBounds, setLayerBounds] = useState<CSSProperties>()
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
  const visibleZoneHosts = activeEditingRange === null
    ? zoneHosts.filter((zone) => zone.kind !== 'editor')
    : zoneHosts
  const editorZoneHost = zoneHosts.find((zone) => zone.kind === 'editor')?.host ?? null

  const syncLayerBounds = useCallback(() => {
    if (!alignToEditor) {
      setLayerBounds((current) => current === undefined ? current : undefined)
      return
    }
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
      display: editorRect.width > 0.5 && editorRect.height > 0.5 ? undefined : 'none',
    } satisfies CSSProperties
    setLayerBounds((current) => sameLayerBounds(current, next) ? current : next)
  }, [alignToEditor, editor])

  const syncDraftEditorSize = useCallback(() => {
    const textarea = draftRef.current
    const record = editorZoneRecordRef.current
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
    const formHeight = form.getBoundingClientRect().height
    if (!Number.isFinite(formHeight) || formHeight <= 0) return
    const overlayStyle = window.getComputedStyle(overlay)
    const nextZoneHeight = Math.ceil(
      formHeight
      + readCssPixelValue(overlayStyle.paddingTop)
      + readCssPixelValue(overlayStyle.paddingBottom),
    )
    if (record.viewZone.heightInPx === nextZoneHeight) return

    record.viewZone.heightInPx = nextZoneHeight
    editor.changeViewZones((accessor) => accessor.layoutZone(record.id))
    setZoneHosts((current) => updateZoneHeight(current, record.key, nextZoneHeight))
  }, [editor])

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
        const modelLine = readCommentableLine(event.target, monaco)
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

  useLayoutEffect(() => {
    syncLayerBounds()
  }, [layoutVersion, syncLayerBounds])

  useEffect(() => {
    if (!alignToEditor || typeof ResizeObserver === 'undefined') return
    const editorNode = editor?.getDomNode()
    const offsetParent = layerRef.current?.offsetParent
    if (!editorNode || !(offsetParent instanceof HTMLElement)) return
    const observer = new ResizeObserver(syncLayerBounds)
    observer.observe(editorNode)
    observer.observe(offsetParent)
    return () => observer.disconnect()
  }, [alignToEditor, editor, syncLayerBounds])

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
      const line = readCommentableLine(mouseTarget, monaco)
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
      const rawReleasedLine = readCommentableLine(releaseTarget, monaco)
      const releasedLine = rawReleasedLine !== null && lineNumbers.toSourceLine(rawReleasedLine) !== null
        ? rawReleasedLine
        : null
      if (resolutionFrame !== null) window.cancelAnimationFrame(resolutionFrame)
      resolutionFrame = window.requestAnimationFrame(() => {
        resolutionFrame = null
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
    if (readOnly) return
    if (editingRange !== null) setEditingRange(null)
    if (draftText !== '') setDraftText('')
  }, [draftText, editingRange, readOnly])

  useEffect(() => {
    if (activeEditingRange === null) return
    const frame = window.requestAnimationFrame(() => draftRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [activeEditingRange, editorZoneHost])

  useLayoutEffect(() => {
    if (!editorZoneHost) return
    syncDraftEditorSize()
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
      editorZoneRecordRef.current = null
      setZoneHosts([])
      return
    }
    const model = editor.getModel()
    if (!model) {
      editorZoneRecordRef.current = null
      setZoneHosts([])
      return
    }
    const nextHosts: LineCommentZoneHost[] = []
    const zoneIds: string[] = []
    let nextEditorZoneRecord: LineCommentEditorZoneRecord | null = null
    let disposed = false
    editor.changeViewZones((accessor) => {
      if (activeEditingRange !== null && activeSourceRange !== null) {
        const host = createZoneHost('editor')
        const modelStartLine = Math.min(activeEditingRange.startLine, model.getLineCount())
        const modelEndLine = Math.min(activeEditingRange.endLine, model.getLineCount())
        const height = LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT
        const key = `editor:${modelStartLine}-${modelEndLine}`
        const zone: LineCommentZoneHost = {
          key,
          kind: 'editor',
          startLine: activeSourceRange.startLine,
          endLine: activeSourceRange.endLine,
          modelStartLine,
          modelEndLine,
          top: -height,
          height,
          host,
        }
        const viewZone: Monaco.editor.IViewZone = {
          afterLineNumber: modelEndLine,
          heightInPx: height,
          domNode: host,
          onDomNodeTop: (top) => {
            zone.top = top
            if (!disposed) setZoneHosts((current) => updateZoneTop(current, zone.key, top))
          },
        }
        const id = accessor.addZone(viewZone)
        nextEditorZoneRecord = { id, key, viewZone }
        zoneIds.push(id)
        nextHosts.push(zone)
      }
      for (const { comment, modelRange } of mappedComments) {
        const host = createZoneHost('comment')
        const modelStartLine = Math.min(modelRange.startLine, model.getLineCount())
        const modelEndLine = Math.min(modelRange.endLine, model.getLineCount())
        const height = lineCommentZoneHeight(comment.text)
        const zone: LineCommentZoneHost = {
          key: comment.id,
          kind: 'comment',
          startLine: comment.startLine,
          endLine: comment.endLine ?? comment.startLine,
          modelStartLine,
          modelEndLine,
          top: -height,
          height,
          comment,
          host,
        }
        zoneIds.push(accessor.addZone({
          afterLineNumber: modelEndLine,
          heightInPx: height,
          domNode: host,
          onDomNodeTop: (top) => {
            zone.top = top
            if (!disposed) setZoneHosts((current) => updateZoneTop(current, zone.key, top))
          },
        }))
        nextHosts.push(zone)
      }
    })
    editorZoneRecordRef.current = nextEditorZoneRecord
    setZoneHosts(nextHosts)
    return () => {
      disposed = true
      if (editorZoneRecordRef.current === nextEditorZoneRecord) {
        editorZoneRecordRef.current = null
      }
      editor.changeViewZones((accessor) => {
        for (const zoneId of zoneIds) accessor.removeZone(zoneId)
      })
    }
  }, [activeEditingRange, activeSourceRange, editor, mappedComments])

  useEffect(() => {
    if (!editor || !monaco) return
    const decorations = editor.createDecorationsCollection()
    const update = () => {
      const next = [] as Monaco.editor.IModelDeltaDecoration[]
      if (hoveredLine) {
        next.push({
          range: new monaco.Range(hoveredLine, 1, hoveredLine, 1),
          options: {
            isWholeLine: true,
            className: 'workspace-comment-hover-line',
          },
        })
      }
      for (const { modelRange } of mappedComments) {
        next.push({
          range: new monaco.Range(modelRange.startLine, 1, modelRange.endLine, 1),
          options: {
            isWholeLine: true,
            className: 'workspace-comment-published-line',
            linesDecorationsClassName: 'workspace-comment-line-marker',
          },
        })
      }
      decorations.set(next)
    }
    update()
    return () => decorations.clear()
  }, [editor, hoveredLine, mappedComments, monaco])

  const hoveredMetric = useMemo(
    () => hoveredLine === null ? null : readLineMetric(editor, hoveredLine),
    [editor, hoveredLine, layoutVersion],
  )
  const addButtonLeft = useMemo(
    () => editor ? resolveLineCommentAddButtonLeft(editor.getLayoutInfo()) : null,
    [editor, layoutVersion],
  )
  const hoveredSourceLine = hoveredLine === null ? null : lineNumbers.toSourceLine(hoveredLine)
  function beginComment(range: LineCommentRange) {
    if (!readOnly || !mapModelRangeToSource(range, lineNumbers)) return
    setHoveredLine(range.endLine)
    setEditingRange(range)
    setDraftText('')
    editor?.revealLineInCenterIfOutsideViewport(range.endLine)
  }

  function cancelComment() {
    setEditingRange(null)
    setDraftText('')
  }

  function toggleComment(range: LineCommentRange) {
    if (!readOnly) return
    if (editingRange?.startLine === range.startLine && editingRange.endLine === range.endLine) {
      cancelComment()
      return
    }
    beginComment(range)
  }

  function publishComment() {
    if (!readOnly || editingRange === null) return
    const sourceRange = mapModelRangeToSource(editingRange, lineNumbers)
    if (!sourceRange) return
    const text = draftText.trim()
    if (!text) return
    const comment: WorkspaceLineComment = {
      id: createCommentId(),
      startLine: sourceRange.startLine,
      ...(sourceRange.endLine === sourceRange.startLine ? {} : { endLine: sourceRange.endLine }),
      text,
      createdAt: Date.now(),
    }
    onCommentsChange([...comments, comment])
    onAddAttachment(buildAttachment?.(comment) ?? {
      path: filePath,
      contextPath: filePath,
      name: fileName,
      kind: 'file',
      lineComments: [{
        startLine: comment.startLine,
        ...(comment.endLine === undefined ? {} : { endLine: comment.endLine }),
        text: comment.text,
      }],
    })
    cancelComment()
  }

  return (
    <div
      ref={layerRef}
      className={`workspace-line-comment-layer ${alignToEditor ? 'editor-aligned' : ''}`}
      style={layerBounds}
      aria-label="代码行评论"
    >
      {readOnly && hoveredLine !== null && hoveredSourceLine !== null && hoveredMetric
        && addButtonLeft !== null && activeEditingRange === null && (
        <button
          className="workspace-line-comment-add"
          type="button"
          aria-label={`为第 ${hoveredSourceLine} 行添加评论`}
          style={{
            top: hoveredMetric.top + Math.max(0, (hoveredMetric.height - LINE_COMMENT_ADD_BUTTON_SIZE) / 2),
            left: addButtonLeft,
          }}
          onClick={() => toggleComment({ startLine: hoveredLine, endLine: hoveredLine })}
        >
          <span className="workspace-line-comment-add-icon" aria-hidden="true" />
        </button>
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
                <button
                  type="button"
                  onClick={cancelComment}
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!draftText.trim()}
                >
                  发布评论
                </button>
              </div>
            </form>
          ) : (
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

export function resolveLineCommentAddButtonLeft(
  layout: Pick<
    Monaco.editor.EditorLayoutInfo,
    'lineNumbersLeft' | 'lineNumbersWidth' | 'decorationsLeft' | 'decorationsWidth' | 'contentLeft'
  >,
): number | null {
  const lineNumberRight = layout.lineNumbersLeft + layout.lineNumbersWidth
  const gutterLeft = Math.max(lineNumberRight, layout.decorationsLeft)
  const gutterRight = Math.min(layout.contentLeft, layout.decorationsLeft + layout.decorationsWidth)
  const gutterWidth = gutterRight - gutterLeft
  if (gutterWidth < LINE_COMMENT_ADD_BUTTON_SIZE) return null
  return gutterLeft + (gutterWidth - LINE_COMMENT_ADD_BUTTON_SIZE) / 2
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

function sameLayerBounds(current: CSSProperties | undefined, next: CSSProperties): boolean {
  if (!current) return false
  return current.top === next.top
    && current.left === next.left
    && current.width === next.width
    && current.height === next.height
    && current.display === next.display
}

export function createCommentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `line-comment-${crypto.randomUUID()}`
  }
  return `line-comment-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createZoneHost(kind: 'editor' | 'comment'): HTMLDivElement {
  const host = document.createElement('div')
  host.className = `workspace-line-comment-zone ${kind}`
  host.setAttribute('aria-hidden', 'true')
  return host
}

export function updateZoneTop<T extends { key: string; top: number }>(
  zones: T[],
  key: string,
  top: number,
): T[] {
  const index = zones.findIndex((zone) => zone.key === key)
  if (index < 0 || zones[index]?.top === top) return zones
  const next = [...zones]
  next[index] = { ...next[index]!, top }
  return next
}

export function updateZoneHeight<T extends { key: string; height: number }>(
  zones: T[],
  key: string,
  height: number,
): T[] {
  const index = zones.findIndex((zone) => zone.key === key)
  if (index < 0 || zones[index]?.height === height) return zones
  const next = [...zones]
  next[index] = { ...next[index]!, height }
  return next
}

export function readCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function lineCommentZoneHeight(text: string): number {
  const estimatedLines = Math.max(1, Math.ceil(text.length / 72))
  return Math.min(132, 58 + estimatedLines * 18)
}

export function formatLineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}-${endLine} 行`
}
