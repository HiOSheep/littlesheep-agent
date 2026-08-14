// Presents layered staged, unstaged, and untracked diffs in the shared Monaco surface.
import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import type * as Monaco from 'monaco-editor'
import { workspaceLanguageForPath } from '../../shared/workspace-languages'
import type { WorkspaceReviewDiffLayer, WorkspaceReviewFile, WorkspaceReviewFileDiff } from '../api'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FileGlyphIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { WorkspaceCodeDiffEditor } from './code-editor'
import { WorkspacePlaceholder } from './placeholder'
import { buildWorkspaceReviewEditorModel } from './review-diff-model'
import { ReviewLineCounts } from './review-line-counts'

export function WorkspaceReviewDiff({
  file,
  diff,
  sideBySide,
  emptyState,
  loading,
  error,
  onSideBySideChange,
  onOpenFile,
  onTipChange,
}: {
  file: WorkspaceReviewFile | null
  diff: WorkspaceReviewFileDiff | null
  sideBySide: boolean
  emptyState?: ReactNode
  loading: boolean
  error: string
  onSideBySideChange: (sideBySide: boolean) => void
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
          <WorkspaceReviewDiffLayerView file={diff.file} layer={layer} sideBySide={sideBySide} key={layer.kind} />
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
  file,
  layer,
  sideBySide,
}: {
  file: WorkspaceReviewFile
  layer: WorkspaceReviewDiffLayer
  sideBySide: boolean
}) {
  const model = useMemo(() => buildWorkspaceReviewEditorModel(layer), [layer])
  const originalLanguage = workspaceLanguageForPath(file.oldPath ?? file.path)
  const modifiedLanguage = workspaceLanguageForPath(file.path)
  const modelKey = `${layer.kind}:${file.oldPath ?? file.path}->${file.path}`
  const diffEditorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null)

  useEffect(() => {
    if (diffEditorRef.current) updateReviewLineNumbers(diffEditorRef.current, model)
  }, [model])

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
            onMount={(editor) => {
              diffEditorRef.current = editor
              updateReviewLineNumbers(editor, model)
            }}
            options={{
              compactMode: true,
              diffAlgorithm: 'advanced',
              diffWordWrap: 'on',
              enableSplitViewResizing: true,
              hideUnchangedRegions: { enabled: false },
              ignoreTrimWhitespace: false,
              lineNumbers: 'on',
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
            }}
          />
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
