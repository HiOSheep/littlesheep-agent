import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react'
import type * as Monaco from 'monaco-editor'
import {
  EMPTY_LINE_COMMENT_DRAFT,
  formatLineRange,
  LINE_COMMENT_ADD_BUTTON_SIZE,
  LINE_COMMENT_TEXTAREA_MIN_HEIGHT,
  readCssPixelValue,
  reduceLineCommentDraft,
  updateZoneHeight,
  type WorkspaceLineComment,
} from './line-comment-model'
import type { LineCommentRange } from './line-comment-gesture'
import type { LineCommentEditorZoneRecord } from './line-comment-view-zones'

export {
  createLineCommentFromDraft, LINE_COMMENT_EDITOR_INITIAL_ZONE_HEIGHT,
  lineCommentZoneHeight, resolveLineCommentAddButtonLeft, sameLineCommentRange,
  type WorkspaceLineComment,
} from './line-comment-model'
export { useLineCommentViewZones, type LineCommentViewZoneSpec } from './line-comment-view-zones'

export function useLineCommentDraft() {
  const [state, dispatch] = useReducer(reduceLineCommentDraft, EMPTY_LINE_COMMENT_DRAFT)
  const begin = useCallback((range: LineCommentRange) => dispatch({ type: 'begin', range }), [])
  const change = useCallback((text: string) => dispatch({ type: 'change', text }), [])
  const cancel = useCallback(() => dispatch({ type: 'cancel' }), [])
  return {
    editingRange: state.editingRange,
    draftText: state.draftText,
    state,
    begin,
    change,
    cancel,
  }
}

export function LineCommentAddButton({
  sourceLine,
  top,
  lineHeight,
  left,
  onClick,
}: {
  sourceLine: number
  top: number
  lineHeight: number
  left: number
  onClick: () => void
}) {
  return (
    <button
      className="workspace-line-comment-add"
      type="button"
      aria-label={`为第 ${sourceLine} 行添加评论`}
      style={{
        top: top + Math.max(0, (lineHeight - LINE_COMMENT_ADD_BUTTON_SIZE) / 2),
        left,
      }}
      onClick={onClick}
    >
      <span className="workspace-line-comment-add-icon" aria-hidden="true" />
    </button>
  )
}

export function LineCommentEditor({
  textareaRef,
  draftText,
  range,
  onDraftChange,
  onCancel,
  onPublish,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>
  draftText: string
  range: LineCommentRange
  onDraftChange: (text: string) => void
  onCancel: () => void
  onPublish: () => void
}) {
  return (
    <form
      className="workspace-line-comment-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onPublish()
      }}
    >
      <div className="workspace-line-comment-editor-heading">
        <strong>发布评论</strong>
      </div>
      <textarea
        ref={textareaRef}
        value={draftText}
        onChange={(event) => onDraftChange(event.target.value)}
        placeholder="添加此更改的上下文"
        rows={3}
        maxLength={4000}
      />
      <div className="workspace-line-comment-editor-actions">
        <span>{formatLineRange(range.startLine, range.endLine)}</span>
        <button type="button" onClick={onCancel}>取消</button>
        <button type="submit" disabled={!draftText.trim()}>发布评论</button>
      </div>
    </form>
  )
}

export function LineCommentCard({ comment }: { comment: WorkspaceLineComment }) {
  return (
    <article className="workspace-line-comment-card" data-comment-line={comment.startLine}>
      <p>{comment.text}</p>
      <div className="workspace-line-comment-card-meta">
        <span>{formatLineRange(comment.startLine, comment.endLine ?? comment.startLine)}</span>
        <span>已发布</span>
      </div>
    </article>
  )
}

export function useLineCommentEditorAutoSize<TZone extends { key: string; height: number }>(input: {
  editor: Monaco.editor.ICodeEditor | null
  editorZoneHost: HTMLDivElement | null
  draftText: string
  textareaRef: RefObject<HTMLTextAreaElement>
  editorZoneRecordRef: MutableRefObject<LineCommentEditorZoneRecord | null>
  setZoneHosts: Dispatch<SetStateAction<TZone[]>>
}): void {
  const frameRef = useRef<number>()
  const sync = useCallback(() => {
    const textarea = input.textareaRef.current
    const record = input.editorZoneRecordRef.current
    if (!input.editor || !textarea || !record) return
    textarea.style.height = '0px'
    const textareaHeight = Math.max(LINE_COMMENT_TEXTAREA_MIN_HEIGHT, Math.ceil(textarea.scrollHeight))
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
    input.editor.changeViewZones((accessor) => accessor.layoutZone(record.id))
    input.setZoneHosts((current) => updateZoneHeight(current, record.zone.key, nextZoneHeight))
  }, [input.editor, input.editorZoneRecordRef, input.setZoneHosts, input.textareaRef])

  useEffect(() => {
    if (!input.editorZoneHost) return
    const frame = window.requestAnimationFrame(() => input.textareaRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [input.editorZoneHost, input.textareaRef])

  useLayoutEffect(() => {
    if (input.editorZoneHost) sync()
  }, [input.draftText, input.editorZoneHost, sync])

  useEffect(() => {
    const textarea = input.textareaRef.current
    if (!input.editorZoneHost || !textarea || typeof ResizeObserver === 'undefined') return
    let observedWidth = textarea.getBoundingClientRect().width
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width
      if (nextWidth === undefined || Math.abs(nextWidth - observedWidth) < 0.5) return
      observedWidth = nextWidth
      window.cancelAnimationFrame(frameRef.current ?? 0)
      frameRef.current = window.requestAnimationFrame(sync)
    })
    observer.observe(textarea)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frameRef.current ?? 0)
      frameRef.current = undefined
    }
  }, [input.editorZoneHost, input.textareaRef, sync])
}

export function useEditorAlignedLayerBounds(input: {
  editor: Monaco.editor.ICodeEditor | null
  enabled: boolean
  visible: boolean
  refreshKey: string | number
}): {
  layerRef: RefObject<HTMLDivElement>
  layerBounds: CSSProperties | undefined
} {
  const layerRef = useRef<HTMLDivElement>(null)
  const [layerBounds, setLayerBounds] = useState<CSSProperties>()
  const sync = useCallback(() => {
    if (!input.enabled) {
      setLayerBounds((current) => current === undefined ? current : undefined)
      return
    }
    const layer = layerRef.current
    const editorNode = input.editor?.getDomNode()
    const offsetParent = layer?.offsetParent
    if (!layer || !editorNode || !(offsetParent instanceof HTMLElement)) return
    const editorRect = editorNode.getBoundingClientRect()
    const parentRect = offsetParent.getBoundingClientRect()
    const next = {
      top: editorRect.top - parentRect.top,
      left: editorRect.left - parentRect.left,
      width: editorRect.width,
      height: editorRect.height,
      display: input.visible && editorRect.width > 0.5 && editorRect.height > 0.5 ? undefined : 'none',
    } satisfies CSSProperties
    setLayerBounds((current) => sameLayerBounds(current, next) ? current : next)
  }, [input.editor, input.enabled, input.visible])

  useLayoutEffect(() => sync(), [input.refreshKey, sync])

  useEffect(() => {
    if (!input.enabled || typeof ResizeObserver === 'undefined') return
    const editorNode = input.editor?.getDomNode()
    const offsetParent = layerRef.current?.offsetParent
    if (!editorNode || !(offsetParent instanceof HTMLElement)) return
    const observer = new ResizeObserver(sync)
    observer.observe(editorNode)
    observer.observe(offsetParent)
    return () => observer.disconnect()
  }, [input.editor, input.enabled, sync])

  return { layerRef, layerBounds }
}

function sameLayerBounds(current: CSSProperties | undefined, next: CSSProperties): boolean {
  if (!current) return false
  return current.top === next.top
    && current.left === next.left
    && current.width === next.width
    && current.height === next.height
    && current.display === next.display
}
