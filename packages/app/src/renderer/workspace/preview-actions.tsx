// File preview toolbar controls; preview and draft state remain owned by preview-pane.
import type { FocusEvent, MouseEvent } from 'react'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { ExternalOpenIcon, FolderGlyphIcon, VSCodeIcon, WorkspaceFeatureIcon } from '../ui/icons'
import { CodeWrapToggle } from '../ui/code-wrap-toggle'
import { SplitButton } from '../ui/split-button'
import { transientTriggerProps } from '../ui/transient'
import { type HtmlRunState } from './html-run'
import { OPEN_WITH_REVEAL_ID, OPEN_WITH_VSCODE_ID, type WorkspaceOpenWith } from './use-workspace-open-with'

/**
 * The two destinations for an already-running HTML page, offered inside the "打开方式" menu rather
 * than as two labelled buttons of their own (asked for 2026-10-03: the row should carry only what
 * changes what the pane shows).
 */
export const HTML_BROWSER_IN_APP_ID = 'html-browser-in-app'
export const HTML_BROWSER_EXTERNAL_ID = 'html-browser-external'

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
        // The folder is a choice like any other, not only a one-off entry in the list: picking it
        // makes the primary segment reveal the file from then on (asked for 2026-10-03,
        // "the file should let me choose whether VS Code or the folder opens it").
        const currentIsFolder = openWith.currentId === OPEN_WITH_REVEAL_ID
        const currentLabel = currentIsFolder
          ? '文件夹'
          : currentIsVSCode
            ? 'Visual Studio Code'
            : currentHandler?.label ?? '系统默认应用'
        return (
          <SplitButton
            className="workspace-preview-open-with"
            icon={currentIsVSCode ? <VSCodeIcon /> : <FolderGlyphIcon />}
            label={`打开方式：${currentLabel}`}
            primaryTip={currentIsFolder ? '在文件夹中显示这个文件' : `用 ${currentLabel} 打开这个文件`}
            menuLabel="选择打开方式"
            onPrimary={openWith.openWithCurrent}
            onTipChange={onTipChange}
            items={[
              ...(canOpenExternalVSCode
                ? [{
                    id: OPEN_WITH_VSCODE_ID,
                    // No "（默认）" here: the system already has a default handler for this file, and
                    // it is marked on its own row. Two rows claiming to be the default read as a bug
                    // (reported 2026-10-03); the current choice is carried by the `active` mark and
                    // by the button itself.
                    label: 'Visual Studio Code',
                    icon: <VSCodeIcon />,
                    active: currentIsVSCode,
                    onSelect: () => openWith.openWith(OPEN_WITH_VSCODE_ID),
                  }]
                : []),
              ...openWith.handlers.map((handler) => ({
                id: handler.id,
                label: handler.isDefault ? `${handler.label}（系统默认）` : handler.label,
                hint: handler.executable,
                active: handler.id === openWith.currentId,
                // Every option carries the icon of the program it would start; the folder glyph
                // stays as the fallback for a host that could not read one (2026-10-02).
                icon: handler.icon
                  ? <img className="workspace-open-with-icon" src={handler.icon} alt="" aria-hidden="true" />
                  : <FolderGlyphIcon />,
                onSelect: () => openWith.openWith(handler.id),
              })),
              // A running page asks a different question from "which program opens this file":
              // where to hand the *running* page. Both answers belong beside the open-with list.
              ...(isHtml
                ? [
                    {
                      id: HTML_BROWSER_IN_APP_ID,
                      label: '应用内浏览器',
                      icon: <WorkspaceFeatureIcon id="browser" />,
                      ...(htmlReady ? {} : { hint: '页面还没有开始运行' }),
                      disabled: !htmlReady,
                      dividerBefore: true,
                      onSelect: onOpenHtmlInApp,
                    },
                    {
                      id: HTML_BROWSER_EXTERNAL_ID,
                      label: '系统浏览器',
                      icon: <ExternalOpenIcon />,
                      ...(htmlReady ? {} : { hint: '页面还没有开始运行' }),
                      disabled: !htmlReady,
                      onSelect: onOpenHtmlExternal,
                    },
                  ]
                : []),
              {
                id: OPEN_WITH_REVEAL_ID,
                label: '文件夹（显示文件位置）',
                icon: <FolderGlyphIcon />,
                // Selecting it both reveals now and stays the choice, exactly like the launchers
                // above: the primary segment is whatever the reader picked last.
                active: currentIsFolder,
                dividerBefore: true,
                onSelect: () => openWith.openWith(OPEN_WITH_REVEAL_ID),
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
