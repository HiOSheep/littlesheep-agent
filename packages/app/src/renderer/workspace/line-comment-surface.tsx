// Shared Monaco line-comment interaction surface and attachment boundary.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type FocusEvent,
  type MutableRefObject,
  type MouseEvent,
  type RefObject,
  type SetStateAction,
} from 'react'
import type * as Monaco from 'monaco-editor'
import type { FloatingHelpTip } from '../ui/floating-help'
import { buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { RenameIcon, TrashIcon } from '../ui/icons'
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
  const beginEdit = useCallback((comment: WorkspaceLineComment, range?: LineCommentRange) => dispatch({
    type: 'begin',
    range: range ?? { startLine: comment.startLine, endLine: comment.endLine ?? comment.startLine },
    comment: { id: comment.id, createdAt: comment.createdAt, text: comment.text },
  }), [])
  const change = useCallback((text: string) => dispatch({ type: 'change', text }), [])
  const cancel = useCallback(() => dispatch({ type: 'cancel' }), [])
  return {
    editingRange: state.editingRange,
    draftText: state.draftText,
    state,
    begin,
    beginEdit,
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
  editing = false,
}: {
  textareaRef: RefObject<HTMLTextAreaElement>
  draftText: string
  range: LineCommentRange
  onDraftChange: (text: string) => void
  onCancel: () => void
  onPublish: () => void
  editing?: boolean
}) {
  return (
    <form
      className="workspace-line-comment-editor"
      onSubmit={(event) => {
        event.preventDefault()
        onPublish()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <div className="workspace-line-comment-editor-heading">
        <strong>{editing ? '编辑评论' : '发布评论'}</strong>
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
        <button type="submit" disabled={!draftText.trim()}>{editing ? '更新评论' : '发布评论'}</button>
      </div>
    </form>
  )
}

export function LineCommentCard({ comment, onEdit, onDelete, onTipChange }: {
  comment: WorkspaceLineComment
  onEdit: () => void
  onDelete: () => void
  onTipChange?: (tip: FloatingHelpTip | null) => void
}) {
  const showTip = (label: string, event: MouseEvent<HTMLButtonElement>) => {
    onTipChange?.(buildFloatingHelpTip(label, event.clientX, event.clientY))
  }
  const showFocusTip = (label: string, event: FocusEvent<HTMLButtonElement>) => {
    onTipChange?.(buildFloatingHelpTipFromElement(label, event.currentTarget))
  }
  return (
    <article className="workspace-line-comment-card" data-comment-line={comment.startLine}>
      <p>{comment.text}</p>
      <div className="workspace-line-comment-card-meta">
        <span>{formatLineRange(comment.startLine, comment.endLine ?? comment.startLine)}</span>
        <span className="workspace-line-comment-card-status">已发布</span>
        <div className="workspace-line-comment-card-actions">
          <button
            className="workspace-line-comment-action"
            type="button"
            aria-label="编辑评论"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onTipChange?.(null)
              onEdit()
            }}
            onMouseEnter={(event) => showTip('编辑评论', event)}
            onMouseMove={(event) => showTip('编辑评论', event)}
            onMouseLeave={() => onTipChange?.(null)}
            onFocus={(event) => showFocusTip('编辑评论', event)}
            onBlur={() => onTipChange?.(null)}
          >
            <RenameIcon />
          </button>
          <button
            className="workspace-line-comment-action delete"
            type="button"
            aria-label="删除评论"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onTipChange?.(null)
              onDelete()
            }}
            onMouseEnter={(event) => showTip('删除评论', event)}
            onMouseMove={(event) => showTip('删除评论', event)}
            onMouseLeave={() => onTipChange?.(null)}
            onFocus={(event) => showFocusTip('删除评论', event)}
            onBlur={() => onTipChange?.(null)}
          >
            <TrashIcon />
          </button>
        </div>
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

  useLayoutEffect(() => {
    if (!input.editorZoneHost) return
    input.textareaRef.current?.focus()
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
