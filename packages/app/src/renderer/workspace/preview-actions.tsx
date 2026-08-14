// File preview toolbar controls; preview and draft state remain owned by preview-pane.
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { VSCodeIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'

export function WorkspacePreviewActions({
  editable,
  isMarkdown,
  editing,
  showMarkdownSource,
  dirty,
  saving,
  canOpenExternalVSCode,
  onToggleMarkdownSource,
  onToggleEditing,
  onSave,
  onOpenInVSCode,
  onTipChange,
}: {
  editable: boolean
  isMarkdown: boolean
  editing: boolean
  showMarkdownSource: boolean
  dirty: boolean
  saving: boolean
  canOpenExternalVSCode: boolean
  onToggleMarkdownSource: () => void
  onToggleEditing: () => void
  onSave: () => void
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
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            disabled={!dirty || saving}
            onClick={onSave}
            onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('保存当前文件', event.clientX, event.clientY))}
            onMouseMove={(event) => onTipChange(buildFloatingHelpTip('保存当前文件', event.clientX, event.clientY))}
            onMouseLeave={() => onTipChange(null)}
            onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('保存当前文件', event.currentTarget))}
            onBlur={() => onTipChange(null)}
          >
            {saving ? '保存中' : dirty ? '保存*' : '保存'}
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
