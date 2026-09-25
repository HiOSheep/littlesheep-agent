// Presents layered staged, unstaged, and untracked diffs in the shared Monaco surface.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type * as Monaco from 'monaco-editor'
import { workspaceLanguageForPath } from '../../shared/workspace-languages'
import type {
  AttachmentRef,
  WorkspaceReviewDiffLayer,
  WorkspaceReviewFile,
  WorkspaceReviewFileDiff,
} from '../api'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FeedbackNotice } from '../ui/feedback-notice'
import { diffMetadataLabel, diffMetadataValue } from './review-diff-metadata'
import { FileGlyphIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { WorkspaceCodeDiffEditor } from './code-editor'
import { WorkspaceLineCommentOverlay, type WorkspaceLineComment } from './line-comments'
import { WorkspacePlaceholder } from './placeholder'
import { buildWorkspaceReviewEditorModel } from './review-diff-model'
import type { WorkspaceReviewNotice } from './review-refresh-notice'
import { WorkspaceReviewInlineDeletedComments } from './review-inline-deleted-comments'
import {
  attachReviewInlineDeletedLineNumbers,
  type InlineDeletedLineTarget,
  type ReviewInlineDeletedLineNumbers,
} from './review-inline-deleted-line-numbers'
import {
  buildWorkspaceReviewCommentAttachment,
  workspaceReviewLineCommentScope,
} from './review-line-comments'
import { ReviewLineCounts } from './review-line-counts'

const EMPTY_LINE_COMMENTS: WorkspaceLineComment[] = []
const EMPTY_LAYER_KINDS: WorkspaceReviewDiffLayer['kind'][] = []
/** Stable identity for layers without extended headers (the view memoises on it). */
const EMPTY_DIFF_METADATA: NonNullable<WorkspaceReviewDiffLayer['metadata']> = []

export function WorkspaceReviewDiff({
  file,
  diff,
  sideBySide,
  emptyState,
  loading,
  notices,
  lineCommentsByScope,
  onSideBySideChange,
  onLineCommentsChange,
  onLineCommentUpdate,
  onLineCommentDelete,
  onAddAttachment,
  onOpenFile,
  onTipChange,
  scrollRef,
}: {
  file: WorkspaceReviewFile | null
  diff: WorkspaceReviewFileDiff | null
  sideBySide: boolean
  emptyState?: ReactNode
  loading: boolean
  /** Stale/refresh state for the snapshot and the selected diff, newest first. */
  notices: WorkspaceReviewNotice[]
  lineCommentsByScope: Record<string, WorkspaceLineComment[]>
  onSideBySideChange: (sideBySide: boolean) => void
  onLineCommentsChange: (scope: string, comments: WorkspaceLineComment[]) => void
  onLineCommentUpdate: (
    scope: string,
    previous: WorkspaceLineComment,
    next: WorkspaceLineComment,
    attachment: AttachmentRef,
  ) => void
  onLineCommentDelete: (scope: string, comment: WorkspaceLineComment) => void
  onAddAttachment: (attachment: AttachmentRef) => void
  onOpenFile: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
  scrollRef: RefObject<HTMLDivElement>
}) {
  return (
    <section className="workspace-review-diff" aria-label="文件差异">
      <WorkspaceReviewDiffHeader
        file={file}
        layerKinds={diff?.layers.map((layer) => layer.kind) ?? EMPTY_LAYER_KINDS}
        sideBySide={sideBySide}
        onSideBySideChange={onSideBySideChange}
        onOpenFile={onOpenFile}
        onTipChange={onTipChange}
      />
      <div ref={scrollRef} className="workspace-review-diff-scroll">
        {notices.map((notice) => (
          <FeedbackNotice
            key={notice.key}
            feedback={notice.feedback}
            className="workspace-review-update-notice"
            retryLabel={notice.retryLabel}
            onRetry={notice.onRetry}
            busy={notice.busy}
          />
        ))}
        {emptyState}
        {!emptyState && loading && !diff && <WorkspacePlaceholder title="读取差异" text="正在生成文件 diff。" />}
        {!emptyState && diff?.layers.map((layer) => (
          <WorkspaceReviewDiffLayerView
            workspacePath={diff.workspacePath}
            file={diff.file}
            layer={layer}
            sideBySide={sideBySide}
            lineCommentsByScope={lineCommentsByScope}
            onLineCommentsChange={onLineCommentsChange}
            onLineCommentUpdate={onLineCommentUpdate}
            onLineCommentDelete={onLineCommentDelete}
            onAddAttachment={onAddAttachment}
            onTipChange={onTipChange}
            key={layer.kind}
          />
        ))}
      </div>
    </section>
  )
}

const LAYER_LABELS: Record<WorkspaceReviewDiffLayer['kind'], string> = {
  staged: '已暂存',
  unstaged: '未暂存',
  untracked: '未跟踪',
}

function WorkspaceReviewDiffLayerView({
  workspacePath,
  file,
  layer,
  sideBySide,
  lineCommentsByScope,
  onLineCommentsChange,
  onLineCommentUpdate,
  onLineCommentDelete,
  onAddAttachment,
  onTipChange,
}: {
  workspacePath: string
  file: WorkspaceReviewFile
  layer: WorkspaceReviewDiffLayer
  sideBySide: boolean
  lineCommentsByScope: Record<string, WorkspaceLineComment[]>
  onLineCommentsChange: (scope: string, comments: WorkspaceLineComment[]) => void
  onLineCommentUpdate: (
    scope: string,
    previous: WorkspaceLineComment,
    next: WorkspaceLineComment,
    attachment: AttachmentRef,
  ) => void
  onLineCommentDelete: (scope: string, comment: WorkspaceLineComment) => void
  onAddAttachment: (attachment: AttachmentRef) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const model = useMemo(() => buildWorkspaceReviewEditorModel(layer), [layer])
  const metadata = layer.metadata ?? EMPTY_DIFF_METADATA
  const originalLanguage = workspaceLanguageForPath(file.oldPath ?? file.path)
  const modifiedLanguage = workspaceLanguageForPath(file.path)
  const modelKey = `${layer.kind}:${file.oldPath ?? file.path}->${file.path}`
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)
  const editorModelRef = useRef(model)
  const inlineDeletedLineNumbersRef = useRef<ReviewInlineDeletedLineNumbers | null>(null)
  const [editorHandle, setEditorHandle] = useState<{
    editor: Monaco.editor.IStandaloneDiffEditor
    monaco: typeof Monaco
  } | null>(null)
  const [originalEditorVisible, setOriginalEditorVisible] = useState(false)
  const [inlineDeletedTargets, setInlineDeletedTargets] = useState<InlineDeletedLineTarget[]>([])
  const originalScope = workspaceReviewLineCommentScope(workspacePath, file.path, layer.kind, 'original')
  const modifiedScope = workspaceReviewLineCommentScope(workspacePath, file.path, layer.kind, 'modified')
  const originalLineNumbers = useMemo(() => ({
    toSourceLine: model.originalSourceLine,
    toModelLine: model.originalModelLine,
  }), [model])
  const modifiedLineNumbers = useMemo(() => ({
    toSourceLine: model.modifiedSourceLine,
    toModelLine: model.modifiedModelLine,
  }), [model])
  const originalComments = lineCommentsByScope[originalScope] ?? EMPTY_LINE_COMMENTS
  const modifiedComments = lineCommentsByScope[modifiedScope] ?? EMPTY_LINE_COMMENTS
  const editorOptions = useMemo<Monaco.editor.IStandaloneDiffEditorConstructionOptions>(() => ({
    compactMode: true,
    diffAlgorithm: 'advanced',
    diffWordWrap: 'on',
    enableSplitViewResizing: true,
    hideUnchangedRegions: { enabled: false },
    ignoreTrimWhitespace: false,
    modifiedAriaLabel: `${file.path} 修改后`,
    originalAriaLabel: `${file.oldPath ?? file.path} 修改前`,
    originalEditable: false,
    readOnly: true,
    renderIndicators: false,
    renderMarginRevertIcon: false,
    renderOverviewRuler: false,
    renderSideBySide: sideBySide,
    renderSideBySideInlineBreakpoint: 720,
    useInlineViewWhenSpaceIsLimited: sideBySide,
  }), [file.oldPath, file.path, sideBySide])
  editorModelRef.current = model

  useEffect(() => {
    if (diffEditorRef.current) {
      updateReviewLineNumbers(diffEditorRef.current, model)
      inlineDeletedLineNumbersRef.current?.refresh()
    }
  }, [model, sideBySide])

  useEffect(() => () => {
    inlineDeletedLineNumbersRef.current?.dispose()
    inlineDeletedLineNumbersRef.current = null
    diffEditorRef.current = null
  }, [])

  useEffect(() => {
    if (!editorHandle) {
      setOriginalEditorVisible(false)
      return
    }
    let frame: number | null = null
    const sync = () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = null
        const originalNode = editorHandle.editor.getOriginalEditor().getDomNode()
        const width = originalNode?.getBoundingClientRect().width ?? 0
        setOriginalEditorVisible(width > 0.5)
      })
    }
    const subscriptions = [
      editorHandle.editor.getOriginalEditor().onDidLayoutChange(sync),
      editorHandle.editor.getModifiedEditor().onDidLayoutChange(sync),
      editorHandle.editor.onDidUpdateDiff(sync),
    ]
    sync()
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame)
      subscriptions.forEach((subscription) => subscription.dispose())
    }
  }, [editorHandle, sideBySide])

  return (
    <section className="workspace-review-diff-layer" aria-label={LAYER_LABELS[layer.kind]}>
      {layer.binary && <WorkspacePlaceholder title="二进制文件" text="该层不提供逐行差异。" />}
      {layer.notice && <div className="workspace-review-notice">{layer.notice}</div>}
      {/* A rename or a mode change has no lines to show; its extended headers *are* the
          change (UX-28 item 3), so they are listed instead of "no line diff". */}
      {!layer.binary && metadata.length > 0 && (
        <ul className="workspace-review-diff-metadata">
          {metadata.map((entry) => (
            <li key={`${entry.key}-${entry.value}`}>
              <span>{diffMetadataLabel(entry.key)}</span>
              <span className="workspace-review-diff-metadata-value">{diffMetadataValue(entry)}</span>
            </li>
          ))}
        </ul>
      )}
      {!layer.binary && layer.hunks.length === 0 && metadata.length === 0 && (
        <WorkspacePlaceholder title="没有可显示的行差异" text="Git 没有为该层返回普通 unified diff。" />
      )}
      {!layer.binary && layer.hunks.length > 0 && (
        <div className="workspace-review-monaco-diff">
          <WorkspaceCodeDiffEditor
            height="100%"
            originalLanguage={originalLanguage}
            modifiedLanguage={modifiedLanguage}
            original={model.original}
            modified={model.modified}
            originalModelPath={reviewModelUri(modelKey, 'original', file.oldPath ?? file.path)}
            modifiedModelPath={reviewModelUri(modelKey, 'modified', file.path)}
            loading={<WorkspacePlaceholder title="载入编辑器" text="正在打开内置代码审阅器。" />}
            onMount={(editor, monaco) => {
              diffEditorRef.current = editor
              setEditorHandle({ editor, monaco })
              updateReviewLineNumbers(editor, model)
              inlineDeletedLineNumbersRef.current?.dispose()
              inlineDeletedLineNumbersRef.current = attachReviewInlineDeletedLineNumbers(
                editor,
                (lineNumber) => editorModelRef.current.originalLineNumber(lineNumber),
                monaco.editor.EditorOption.lineHeight,
                setInlineDeletedTargets,
              )
            }}
            options={editorOptions}
          />
          {editorHandle && originalEditorVisible && (
            <WorkspaceLineCommentOverlay
              editor={editorHandle.editor.getOriginalEditor()}
              monaco={editorHandle.monaco}
              readOnly
              filePath={file.absolutePath}
              fileName={file.oldPath?.split('/').at(-1) ?? file.path.split('/').at(-1) ?? file.path}
              comments={originalComments}
              onCommentsChange={(comments) => onLineCommentsChange(originalScope, comments)}
              onCommentUpdate={(previous, next, attachment) => onLineCommentUpdate(originalScope, previous, next, attachment)}
              onCommentDelete={(comment) => onLineCommentDelete(originalScope, comment)}
              onAddAttachment={onAddAttachment}
              onTipChange={onTipChange}
              lineNumbers={originalLineNumbers}
              alignToEditor
              buildAttachment={(comment) => buildWorkspaceReviewCommentAttachment({
                file,
                layer: layer.kind,
                side: 'original',
                model,
                comment,
              })}
            />
          )}
          {editorHandle && (
            <WorkspaceLineCommentOverlay
              editor={editorHandle.editor.getModifiedEditor()}
              monaco={editorHandle.monaco}
              readOnly
              filePath={file.absolutePath}
              fileName={file.path.split('/').at(-1) ?? file.path}
              comments={modifiedComments}
              onCommentsChange={(comments) => onLineCommentsChange(modifiedScope, comments)}
              onCommentUpdate={(previous, next, attachment) => onLineCommentUpdate(modifiedScope, previous, next, attachment)}
              onCommentDelete={(comment) => onLineCommentDelete(modifiedScope, comment)}
              onAddAttachment={onAddAttachment}
              onTipChange={onTipChange}
              lineNumbers={modifiedLineNumbers}
              alignToEditor
              buildAttachment={(comment) => buildWorkspaceReviewCommentAttachment({
                file,
                layer: layer.kind,
                side: 'modified',
                model,
                comment,
              })}
            />
          )}
          {editorHandle && inlineDeletedTargets.length > 0 && (
            <WorkspaceReviewInlineDeletedComments
              editor={editorHandle.editor.getModifiedEditor()}
              targets={inlineDeletedTargets}
              comments={originalComments}
              onCommentsChange={(comments) => onLineCommentsChange(originalScope, comments)}
              onCommentUpdate={(previous, next, attachment) => onLineCommentUpdate(originalScope, previous, next, attachment)}
              onCommentDelete={(comment) => onLineCommentDelete(originalScope, comment)}
              onAddAttachment={onAddAttachment}
              onTipChange={onTipChange}
              buildAttachment={(comment) => buildWorkspaceReviewCommentAttachment({
                file,
                layer: layer.kind,
                side: 'original',
                model,
                comment,
              })}
            />
          )}
        </div>
      )}
    </section>
  )
}

function reviewModelUri(modelKey: string, side: 'original' | 'modified', path: string): string {
  const safePath = path.split('/').map(encodeURIComponent).join('/')
  return `inmemory://littlesheep-review/${encodeURIComponent(modelKey)}/${side}/${safePath}`
}

function updateReviewLineNumbers(
  editor: Monaco.editor.IStandaloneDiffEditor,
  model: ReturnType<typeof buildWorkspaceReviewEditorModel>,
): void {
  editor.getOriginalEditor().updateOptions({ lineNumbers: model.originalLineNumber })
  editor.getModifiedEditor().updateOptions({ lineNumbers: model.modifiedLineNumber })
}

function WorkspaceReviewDiffHeader({
  file,
  layerKinds,
  sideBySide,
  onSideBySideChange,
  onOpenFile,
  onTipChange,
}: {
  file: WorkspaceReviewFile | null
  layerKinds: WorkspaceReviewDiffLayer['kind'][]
  sideBySide: boolean
  onSideBySideChange: (sideBySide: boolean) => void
  onOpenFile: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  if (!file) return <div className="workspace-review-diff-header workspace-page-leading-row" />
  return (
    <div className="workspace-review-diff-header workspace-page-leading-row">
      <div className="workspace-review-diff-title">
        <div className="workspace-review-diff-title-main">
          <strong>{file.path.split('/').at(-1) ?? file.path}</strong>
          {layerKinds.length > 0 && (
            <span className="workspace-review-diff-layer-status">
              {layerKinds.map((kind) => LAYER_LABELS[kind]).join(' / ')}
            </span>
          )}
        </div>
        <small>{file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}</small>
      </div>
      <div className="workspace-review-diff-actions">
        <ReviewLineCounts
          additions={file.additions}
          deletions={file.deletions}
          available={file.countAvailable}
        />
        <button
          {...transientTriggerProps()}
          className="workspace-review-icon-button"
          type="button"
          aria-label={sideBySide ? '切换为单列差异' : '切换为双列差异'}
          aria-pressed={sideBySide}
          onClick={() => onSideBySideChange(!sideBySide)}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(sideBySide ? '切换为单列差异' : '切换为双列差异', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip(sideBySide ? '切换为单列差异' : '切换为双列差异', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(sideBySide ? '切换为单列差异' : '切换为双列差异', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <ReviewLayoutIcon sideBySide={sideBySide} />
        </button>
        <button
          {...transientTriggerProps()}
          className="workspace-review-icon-button"
          type="button"
          aria-label="在文件工作台中打开"
          disabled={file.status === 'deleted'}
          onClick={onOpenFile}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('在文件工作台中打开', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip('在文件工作台中打开', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('在文件工作台中打开', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <FileGlyphIcon name={file?.path} />
        </button>
      </div>
    </div>
  )
}

function ReviewLayoutIcon({ sideBySide }: { sideBySide: boolean }) {
  return (
    <svg className="workspace-panel-svg-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2.25" y="3" width="11.5" height="10" rx="1" />
      {sideBySide ? <path d="M8 3v10" /> : <path d="M2.25 8h11.5" />}
    </svg>
  )
}
