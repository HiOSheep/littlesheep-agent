// Presents layered staged, unstaged, and untracked diffs with line numbers.
import type { WorkspaceReviewDiffLayer, WorkspaceReviewFile, WorkspaceReviewFileDiff } from '../api'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FileGlyphIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { WorkspacePlaceholder } from './placeholder'
import { ReviewLineCounts } from './review-line-counts'

export function WorkspaceReviewDiff({
  file,
  diff,
  loading,
  error,
  onOpenFile,
  onTipChange,
}: {
  file: WorkspaceReviewFile | null
  diff: WorkspaceReviewFileDiff | null
  loading: boolean
  error: string
  onOpenFile: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  return (
    <section className="workspace-review-diff" aria-label="文件差异">
      <WorkspaceReviewDiffHeader file={file} onOpenFile={onOpenFile} onTipChange={onTipChange} />
      <div className="workspace-review-diff-scroll">
        {loading && <WorkspacePlaceholder title="读取差异" text="正在生成文件 diff。" />}
        {!loading && error && <WorkspacePlaceholder title="差异读取失败" text={error} />}
        {!loading && !error && diff?.layers.map((layer) => (
          <WorkspaceReviewDiffLayerView layer={layer} key={layer.kind} />
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

function WorkspaceReviewDiffLayerView({ layer }: { layer: WorkspaceReviewDiffLayer }) {
  return (
    <section aria-label={LAYER_LABELS[layer.kind]}>
      <div className="workspace-review-hunk-header">{LAYER_LABELS[layer.kind]}</div>
      {layer.binary && <WorkspacePlaceholder title="二进制文件" text="该层不提供逐行差异。" />}
      {layer.notice && <div className="workspace-review-notice">{layer.notice}</div>}
      {!layer.binary && layer.hunks.length === 0 && (
        <WorkspacePlaceholder title="没有可显示的行差异" text="Git 没有为该层返回普通 unified diff。" />
      )}
      {!layer.binary && layer.hunks.map((hunk, index) => (
        <div className="workspace-review-hunk" key={`${hunk.header}:${index}`}>
          <div className="workspace-review-hunk-header">{hunk.header}</div>
          {hunk.lines.map((line, lineIndex) => (
            <div
              className={`workspace-review-diff-line ${line.kind}`}
              key={`${lineIndex}:${line.oldLine}:${line.newLine}`}
            >
              <span className="workspace-review-line-number old">{line.oldLine ?? ''}</span>
              <span className="workspace-review-line-number new">{line.newLine ?? ''}</span>
              <span className="workspace-review-line-marker" aria-hidden="true">
                {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : line.kind === 'context' ? ' ' : '\\'}
              </span>
              <code>{line.content || ' '}</code>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}

function WorkspaceReviewDiffHeader({
  file,
  onOpenFile,
  onTipChange,
}: {
  file: WorkspaceReviewFile | null
  onOpenFile: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  if (!file) return <div className="workspace-review-diff-header" />
  return (
    <div className="workspace-review-diff-header">
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
