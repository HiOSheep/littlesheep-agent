// File preview toolbar controls; preview and draft state remain owned by preview-pane.
import type { FocusEvent, MouseEvent } from 'react'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FolderGlyphIcon, VSCodeIcon } from '../ui/icons'
import { CodeWrapToggle } from '../ui/code-wrap-toggle'
import { SplitButton } from '../ui/split-button'
import { transientTriggerProps } from '../ui/transient'
import { type HtmlRunState } from './html-run'
import { OPEN_WITH_REVEAL_ID, OPEN_WITH_VSCODE_ID, type WorkspaceOpenWith } from './use-workspace-open-with'

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
  onOpenHtmlInApp,
  onOpenHtmlExternal,
  onToggleCodeWrap,
  onToggleMarkdownSource,
  onToggleHtmlSource,
  onToggleEditing,
  onOpenInVSCode,
  openWith,
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
  /** Hands the already-running page to the in-app browser tab. */
  onOpenHtmlInApp: () => void
  /** Hands the already-running page to the system's default browser. */
  onOpenHtmlExternal: () => void
  onToggleMarkdownSource: () => void
  onToggleHtmlSource: () => void
  onToggleEditing: () => void
  onOpenInVSCode: () => void | Promise<void>
  /** Which application opens this file, when the pane has one to offer. */
  openWith?: WorkspaceOpenWith
  onToggleCodeWrap: () => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const markdownSourceTip = showMarkdownSource ? '返回渲染预览' : '查看 Markdown 源代码'
  const editingTip = editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑'
  const htmlReady = htmlRun.status === 'running' && Boolean(htmlRun.url)

  return (
    <div className="workspace-preview-actions">
      {isHtml && (
        <>
          {/* The page is already served and running inside the pane, so these two only decide *where*
              the reader wants it opened next. Nothing navigates on its own any more, and the toolbar
              carries no run/reload/stop controls: the service starts with the preview and the frame
              is handed a fresh URL every time the file is saved. */}
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            disabled={!htmlReady}
            onClick={onOpenHtmlInApp}
            {...tipHandlers('在应用内浏览器中打开这个页面', onTipChange)}
          >
            应用内浏览器
          </button>
          <button
            {...transientTriggerProps()}
            className="workspace-files-text-btn"
            type="button"
            disabled={!htmlReady}
            onClick={onOpenHtmlExternal}
            {...tipHandlers('用系统默认浏览器打开这个页面', onTipChange)}
          >
            系统浏览器
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
      {openWith && (() => {
        const currentHandler = openWith.handlers.find((handler) => handler.id === openWith.currentId) ?? null
        const currentIsVSCode = openWith.currentId === OPEN_WITH_VSCODE_ID
        const currentLabel = currentIsVSCode
          ? 'Visual Studio Code'
          : currentHandler?.label ?? '系统默认应用'
        return (
          <SplitButton
            className="workspace-preview-open-with"
            icon={currentIsVSCode ? <VSCodeIcon /> : <FolderGlyphIcon />}
            label={`打开方式：${currentLabel}`}
            primaryTip={`用 ${currentLabel} 打开这个文件`}
            menuLabel="选择打开方式"
            onPrimary={openWith.openWithCurrent}
            onTipChange={onTipChange}
            items={[
              ...(canOpenExternalVSCode
                ? [{
                    id: OPEN_WITH_VSCODE_ID,
                    label: 'Visual Studio Code（默认）',
                    icon: <VSCodeIcon />,
                    active: currentIsVSCode,
                    onSelect: () => openWith.openWith(OPEN_WITH_VSCODE_ID),
                  }]
                : []),
              ...openWith.handlers.map((handler) => ({
                id: handler.id,
                label: handler.isDefault ? `${handler.label}（默认）` : handler.label,
                hint: handler.executable,
                active: handler.id === openWith.currentId,
                // Every option carries the icon of the program it would start; the folder glyph
                // stays as the fallback for a host that could not read one (2026-10-02).
                icon: handler.icon
                  ? <img className="workspace-open-with-icon" src={handler.icon} alt="" aria-hidden="true" />
                  : <FolderGlyphIcon />,
                onSelect: () => openWith.openWith(handler.id),
              })),
              {
                id: OPEN_WITH_REVEAL_ID,
                label: '显示文件位置',
                icon: <FolderGlyphIcon />,
                dividerBefore: true,
                onSelect: openWith.reveal,
              },
            ]}
          />
        )
      })()}
      {!openWith && canOpenExternalVSCode && (
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
