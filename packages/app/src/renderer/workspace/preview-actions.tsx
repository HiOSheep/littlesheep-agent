// File preview toolbar controls; preview and draft state remain owned by preview-pane.
import type { FocusEvent, MouseEvent } from 'react'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { VSCodeIcon } from '../ui/icons'
import { CodeWrapToggle } from '../ui/code-wrap-toggle'
import { transientTriggerProps } from '../ui/transient'
import { htmlRunActions, type HtmlRunState } from './html-run'

const tipHandlers = (
  label: string,
  onTipChange: (tip: FloatingHelpTip | null) => void,
) => ({
  onMouseEnter: (event: MouseEvent<HTMLElement>) => onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY)),
  onMouseMove: (event: MouseEvent<HTMLElement>) => onTipChange(buildFloatingHelpTip(label, event.clientX, event.clientY)),
  onMouseLeave: () => onTipChange(null),
  onFocus: (event: FocusEvent<HTMLElement>) => onTipChange(buildFloatingHelpTipFromElement(label, event.currentTarget)),
  onBlur: () => onTipChange(null),
})

export function WorkspacePreviewActions({
  editable,
  isMarkdown,
  isHtml,
  editing,
  showMarkdownSource,
  showHtmlSource,
  canOpenExternalVSCode,
  showCodeWrapToggle,
  codeWrapEnabled,
  htmlRun,
  onRunHtml,
  onReloadHtml,
  onStopHtml,
  onToggleCodeWrap,
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
  showCodeWrapToggle: boolean
  codeWrapEnabled: boolean
  htmlRun: HtmlRunState
  onRunHtml: () => void
  onReloadHtml: () => void
  onStopHtml: () => void
  onToggleMarkdownSource: () => void
  onToggleHtmlSource: () => void
  onToggleEditing: () => void
  onOpenInVSCode: () => void | Promise<void>
  onToggleCodeWrap: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const markdownSourceTip = showMarkdownSource ? '返回渲染预览' : '查看 Markdown 源代码'
  const editingTip = editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑'
  const run = htmlRunActions(htmlRun)
  const runTip = htmlRun.status === 'running'
    ? '在隔离的本地地址重新打开这个页面'
    : '运行这个页面：使用磁盘上的当前版本，脚本与本地资源按浏览器语义加载'

  return (
    <div className="workspace-preview-actions">
      {isHtml && (
        <>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            disabled={!run.run}
            onClick={onRunHtml}
            {...tipHandlers(runTip, onTipChange)}
          >
            {run.label}
          </button>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            disabled={!run.reload}
            onClick={onReloadHtml}
            {...tipHandlers('重新加载运行中的页面：磁盘上已改动的文件会被重新读取', onTipChange)}
          >
            重新加载
          </button>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            disabled={!run.stop}
            onClick={onStopHtml}
            {...tipHandlers('停止本地运行服务；已打开的页面重新加载会失败', onTipChange)}
          >
            停止
          </button>
        </>
      )}
      {showCodeWrapToggle && (
        <CodeWrapToggle
          className="workspace-files-icon-btn code-wrap-toggle"
          wrapped={codeWrapEnabled}
          onToggle={onToggleCodeWrap}
        />
      )}
      {editable && (
        <>
          {isMarkdown && (
            <button
              {...transientTriggerProps()}
              className={`workspace-files-text-btn ${showMarkdownSource ? 'active' : ''}`}
              type="button"
              aria-pressed={showMarkdownSource}
              onClick={onToggleMarkdownSource}
              {...tipHandlers(markdownSourceTip, onTipChange)}
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
              {...tipHandlers(showHtmlSource ? '返回 HTML 渲染预览' : '查看 HTML 源代码', onTipChange)}
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
            {...tipHandlers(editingTip, onTipChange)}
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
          {...tipHandlers('用外部 VS Code 打开文件', onTipChange)}
        >
          <VSCodeIcon />
        </button>
      )}
    </div>
  )
}
