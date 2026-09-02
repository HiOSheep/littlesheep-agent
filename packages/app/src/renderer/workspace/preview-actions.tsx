// File preview toolbar controls; preview and draft state remain owned by preview-pane.
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { VSCodeIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'

export function WorkspacePreviewActions({
  editable,
  isMarkdown,
  isHtml,
  editing,
  showMarkdownSource,
  showHtmlSource,
  canOpenExternalVSCode,
  onToggleMarkdownSource,
  onToggleHtmlSource,
  onToggleEditing,
  onOpenInVSCode,
  onTipChange,
}: {
  editable: boolean
  isMarkdown: boolean
  isHtml: boolean
  editing: boolean
  showMarkdownSource: boolean
  showHtmlSource: boolean
  canOpenExternalVSCode: boolean
  onToggleMarkdownSource: () => void
  onToggleHtmlSource: () => void
  onToggleEditing: () => void
  onOpenInVSCode: () => void | Promise<void>
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const markdownSourceTip = showMarkdownSource ? '返回渲染预览' : '查看 Markdown 源代码'
  const editingTip = editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑'

  return (
    <div className="workspace-preview-actions">
      {editable && (
        <>
          {isMarkdown && (
            <button
              {...transientTriggerProps()}
              className={`workspace-files-text-btn ${showMarkdownSource ? 'active' : ''}`}
              type="button"
              aria-pressed={showMarkdownSource}
              onClick={onToggleMarkdownSource}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(markdownSourceTip, event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(markdownSourceTip, event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(markdownSourceTip, event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              {showMarkdownSource ? '查看预览' : '查看源代码'}
            </button>
          )}
          {isHtml && (
            <button
              {...transientTriggerProps()}
              className={`workspace-files-text-btn ${showHtmlSource ? 'active' : ''}`}
              type="button"
              aria-pressed={showHtmlSource}
              onClick={onToggleHtmlSource}
              onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(showHtmlSource ? '返回 HTML 渲染预览' : '查看 HTML 源代码', event.clientX, event.clientY))}
              onMouseMove={(event) => onTipChange(buildFloatingHelpTip(showHtmlSource ? '返回 HTML 渲染预览' : '查看 HTML 源代码', event.clientX, event.clientY))}
              onMouseLeave={() => onTipChange(null)}
              onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(showHtmlSource ? '返回 HTML 渲染预览' : '查看 HTML 源代码', event.currentTarget))}
              onBlur={() => onTipChange(null)}
            >
              {showHtmlSource ? '查看预览' : '查看源代码'}
            </button>
          )}
          <button
            {...transientTriggerProps()}
            className={`workspace-files-text-btn ${editing ? 'active' : ''}`}
            type="button"
            aria-pressed={editing}
            onClick={onToggleEditing}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(editingTip, event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip(editingTip, event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(editingTip, event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            {editing ? '只读' : '编辑'}
          </button>
        </>
      )}
      {canOpenExternalVSCode && (
        <button
          {...transientTriggerProps()}
          className="workspace-files-icon-btn"
          type="button"
          aria-label="用外部 VS Code 打开文件"
          onClick={() => void onOpenInVSCode()}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开文件', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip('用外部 VS Code 打开文件', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('用外部 VS Code 打开文件', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <VSCodeIcon />
        </button>
      )}
    </div>
  )
}
