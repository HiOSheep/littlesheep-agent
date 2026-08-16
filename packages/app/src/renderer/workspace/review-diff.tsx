// Presents layered staged, unstaged, and untracked diffs in the shared Monaco surface.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type * as Monaco from 'monaco-editor'
import { workspaceLanguageForPath } from '../../shared/workspace-languages'
import type {
  AttachmentRef,
  WorkspaceReviewDiffLayer,
  WorkspaceReviewFile,
  WorkspaceReviewFileDiff,
} from '../api'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FileGlyphIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { WorkspaceCodeDiffEditor } from './code-editor'
import { WorkspaceLineCommentOverlay, type WorkspaceLineComment } from './line-comments'
import { WorkspacePlaceholder } from './placeholder'
import { buildWorkspaceReviewEditorModel } from './review-diff-model'
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

export function WorkspaceReviewDiff({
  file,
  diff,
  sideBySide,
  emptyState,
  loading,
  error,
  lineCommentsByScope,
  onSideBySideChange,
  onLineCommentsChange,
  onAddAttachment,
  onOpenFile,
  onTipChange,
}: {
  file: WorkspaceReviewFile | null
  diff: WorkspaceReviewFileDiff | null
  sideBySide: boolean
  emptyState?: ReactNode
  loading: boolean
  error: string
  lineCommentsByScope: Record<string, WorkspaceLineComment[]>
  onSideBySideChange: (sideBySide: boolean) => void
  onLineCommentsChange: (scope: string, comments: WorkspaceLineComment[]) => void
  onAddAttachment: (attachment: AttachmentRef) => void
  onOpenFile: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <section className="workspace-review-diff" aria-label="文件差异">
      <WorkspaceReviewDiffHeader
        file={file}
        sideBySide={sideBySide}
        onSideBySideChange={onSideBySideChange}
        onOpenFile={onOpenFile}
        onTipChange={onTipChange}
      />
      <div className="workspace-review-diff-scroll">
        {emptyState}
        {!emptyState && loading && <WorkspacePlaceholder title="读取差异" text="正在生成文件 diff。" />}
        {!emptyState && !loading && error && <WorkspacePlaceholder title="差异读取失败" text={error} />}
        {!emptyState && !loading && !error && diff?.layers.map((layer) => (
          <WorkspaceReviewDiffLayerView
            workspacePath={diff.workspacePath}
            file={diff.file}
            layer={layer}
            sideBySide={sideBySide}
            lineCommentsByScope={lineCommentsByScope}
            onLineCommentsChange={onLineCommentsChange}
            onAddAttachment={onAddAttachment}
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
  onAddAttachment,
}: {
  workspacePath: string
  file: WorkspaceReviewFile
  layer: WorkspaceReviewDiffLayer
  sideBySide: boolean
  lineCommentsByScope: Record<string, WorkspaceLineComment[]>
  onLineCommentsChange: (scope: string, comments: WorkspaceLineComment[]) => void
  onAddAttachment: (attachment: AttachmentRef) => void
}) {
  const model = useMemo(() => buildWorkspaceReviewEditorModel(layer), [layer])
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
      <div className="workspace-review-layer-header">{LAYER_LABELS[layer.kind]}</div>
      {layer.binary && <WorkspacePlaceholder title="二进制文件" text="该层不提供逐行差异。" />}
      {layer.notice && <div className="workspace-review-notice">{layer.notice}</div>}
      {!layer.binary && layer.hunks.length === 0 && (
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
              onAddAttachment={onAddAttachment}
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
              onAddAttachment={onAddAttachment}
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
              onAddAttachment={onAddAttachment}
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
  sideBySide,
  onSideBySideChange,
  onOpenFile,
  onTipChange,
}: {
  file: WorkspaceReviewFile | null
  sideBySide: boolean
  onSideBySideChange: (sideBySide: boolean) => void
  onOpenFile: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  if (!file) return <div className="workspace-review-diff-header workspace-page-leading-row" />
  return (
    <div className="workspace-review-diff-header workspace-page-leading-row">
      <div className="workspace-review-diff-title">
        <strong>{file.path.split('/').at(-1) ?? file.path}</strong>
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
          <FileGlyphIcon />
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
