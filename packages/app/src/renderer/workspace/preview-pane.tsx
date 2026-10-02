// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import {
  openExternalHref,
  type AttachmentRef,
  type WorkspacePreview
} from '../api'
import { Markdown } from '../Markdown'
import type { FloatingHelpTip } from '../ui/floating-help'
import { FileGlyphIcon } from '../ui/icons'
import {
  workspaceSessionKey,
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId
} from '../workspace-persistence'
import { WorkspaceCodeEditor, workspaceEditorModelPath } from './code-editor'
import { WorkspaceHtmlPreviewSurface } from './html-preview-surface'
import { WorkspacePreviewDiskNotice } from './preview-disk-notice'
import { workspaceDiskNotice } from './preview-disk-state'
import { useWorkspaceDiskWatch } from './use-workspace-disk-watch'
import { WorkspaceOfficePreview } from './office-preview-panel'
import { attachmentFileUrl, shouldOfferExternalVSCode } from './path-utils'
import { WorkspacePreviewBreadcrumbs } from './preview-breadcrumbs'
import { WorkspacePlaceholder } from './placeholder'
import { resolveWorkspacePreviewEditorState, workspaceDraftOutcome } from './preview-draft'
import { useWorkspaceOpenWith } from './use-workspace-open-with'
import { WorkspacePreviewActions } from './preview-actions'
import { HtmlRunNotice } from './html-run-notice'
import { useHtmlRun } from './use-html-run'
import { useCodeWrapPreference } from '../ui/code-wrap-preference'
import { WorkspaceLineCommentOverlay, type WorkspaceLineComment } from './line-comments'
import { workspaceSaveErrorMessage } from './workspace-errors'
import { reportWorkspacePreviewVisible } from './workspace-timing'

const EMPTY_LINE_COMMENTS: WorkspaceLineComment[] = []

export function WorkspacePreviewPane({
  preview,
  loading,
  error,
  selectedPath,
  workspacePath,
  sessionId,
  tabId,
  draft,
  onOpenInVSCode,
  onSaveFile,
  onOpenBrowserTab,
  onReloadFromDisk,
  onRevealFolder,
  onDraftChange,
  comments,
  onCommentsChange,
  onCommentUpdate,
  onCommentDelete,
  onAddAttachment,
  onTipChange,
}: {
  preview: WorkspacePreview | null
  loading: boolean
  error: string
  selectedPath: string
  workspacePath: string
  sessionId?: string
  tabId?: WorkspaceFileTabId
  draft?: WorkspaceFileDraftState
  onOpenInVSCode: () => void | Promise<void>
  onSaveFile: (path: string, content: string, expectedModifiedAt?: number) => Promise<WorkspacePreview>
  onOpenBrowserTab: (url: string) => void
  /** Re-read the file from disk; used by the external-change notice. */
  onReloadFromDisk?: () => void
  /** Reveals one folder of this file's own path in the file navigator, so a crumb can jump. */
  onRevealFolder?: (path: string) => void
  onDraftChange?: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  comments?: WorkspaceLineComment[]
  onCommentsChange?: (comments: WorkspaceLineComment[]) => void
  onCommentUpdate?: (previous: WorkspaceLineComment, next: WorkspaceLineComment, attachment: AttachmentRef) => void
  onCommentDelete?: (comment: WorkspaceLineComment) => void
  onAddAttachment?: (attachment: AttachmentRef) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const isMarkdown = preview?.kind === 'markdown'
  const isHtml = preview?.kind === 'html'
  const editable = preview?.kind === 'text' || isMarkdown || isHtml
  const editorLanguage = preview?.kind === 'markdown'
    ? 'markdown'
    : preview?.kind === 'html'
      ? 'html'
    : preview?.kind === 'text'
      ? preview.language || 'text'
      : ''
  const canOpenExternalVSCode = preview ? shouldOfferExternalVSCode(preview) : false
  const openWith = useWorkspaceOpenWith({
    root: workspacePath,
    path: selectedPath,
    canOpenInVSCode: canOpenExternalVSCode,
    onOpenInVSCode,
    // An open-with failure is an action error like a failed save, and the pane already shows one
    // line for those, right above the status bar.
    onError: (message) => setSaveError(message),
  })
  // CS-08: first file body on screen. Placeholders, errors and an empty pane are
  // explicitly excluded, so a "读取中" state cannot be mistaken for availability.
  const previewContentVisible = !loading && !error && preview !== null
  useEffect(() => {
    if (!previewContentVisible) return
    const frame = window.requestAnimationFrame(() => reportWorkspacePreviewVisible())
    return () => window.cancelAnimationFrame(frame)
  }, [previewContentVisible])
  const initialEditorState = resolveWorkspacePreviewEditorState(preview, draft)
  const [editing, setEditing] = useState(initialEditorState.editing)
  const [showMarkdownSource, setShowMarkdownSource] = useState(
    isMarkdown && initialEditorState.editing,
  )
  const [showHtmlSource, setShowHtmlSource] = useState(
    isHtml && initialEditorState.editing,
  )
  const [editorText, setEditorText] = useState(initialEditorState.editorText)
  const [savedText, setSavedText] = useState(initialEditorState.savedText)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [saveError, setSaveError] = useState('')
  /** A dismissed disk notice, keyed by the situation it dismissed. */
  const [diskKeptPath, setDiskKeptPath] = useState('')
  const [diskWatchRevision, setDiskWatchRevision] = useState(0)
  const [codeWrapEnabled, setCodeWrapEnabled] = useCodeWrapPreference()
  /** Path whose save confirmation must survive the preview refresh it caused. */
  const savedStatusPathRef = useRef<string | null>(null)
  const [editorHandle, setEditorHandle] = useState<{
    editor: Monaco.editor.IStandaloneCodeEditor
    monaco: typeof Monaco
  } | null>(null)
  const editorVisible = editable && (!isMarkdown || showMarkdownSource) && (!isHtml || showHtmlSource)
  const dirty = editable && editorText !== savedText
  // UX-25 item 3: notice an external change or deletion while the user is still here,
  // not only when a save has to fail. diskKeptPath remembers a dismissed notice so it
  // does not nag until the situation changes again.
  const diskState = useWorkspaceDiskWatch({
    root: workspacePath,
    path: preview?.path ?? '',
    loadedModifiedAt: preview?.modifiedAt,
    enabled: Boolean(preview) && !loading && editable,
    revision: diskWatchRevision,
  })
  const diskNoticeKey = `${diskState}\0${preview?.modifiedAt ?? 0}`
  const diskNotice = diskKeptPath === diskNoticeKey ? null : workspaceDiskNotice(diskState, dirty)
  const editorOptions = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(() => ({
    bracketPairColorization: { enabled: true },
    cursorBlinking: 'smooth',
    detectIndentation: true,
    domReadOnly: !editing,
    extraEditorClassName: editing ? '' : 'workspace-monaco-readonly',
    folding: true,
    formatOnPaste: true,
    guides: { bracketPairs: true, indentation: true },
    lineNumbers: 'on',
    readOnly: !editing,
    renderLineHighlight: editing ? 'all' : 'none',
    renderWhitespace: 'selection',
    tabSize: 2,
    wordWrap: codeWrapEnabled ? 'on' : 'off',
  }), [codeWrapEnabled, editing])

  function emitDraft(next: {
    editorText?: string
    savedText?: string
    editing?: boolean
    modifiedAt?: number
    path?: string
  }) {
    if (!tabId || !onDraftChange) return
    if (!editable || !preview || (preview.kind !== 'text' && preview.kind !== 'markdown' && preview.kind !== 'html')) {
      onDraftChange(tabId, null)
      return
    }
    onDraftChange(tabId, {
      path: next.path ?? preview.path,
      modifiedAt: next.modifiedAt ?? draft?.modifiedAt ?? preview.modifiedAt,
      editorText: next.editorText ?? editorText,
      savedText: next.savedText ?? draft?.savedText ?? savedText,
      editing: next.editing ?? editing,
    })
  }

  function updateEditorText(nextText: string) {
    setEditorText(nextText)
    emitDraft({ editorText: nextText })
  }

  function updateEditing(nextEditing: boolean) {
    setEditing(nextEditing)
    emitDraft({ editing: nextEditing })
  }

  function toggleMarkdownSource() {
    if (!isMarkdown) return
    const nextSourceVisible = !showMarkdownSource
    setShowMarkdownSource(nextSourceVisible)
    if (!nextSourceVisible && editing) updateEditing(false)
  }

  function toggleEditing() {
    if (isMarkdown && !showMarkdownSource) setShowMarkdownSource(true)
    if (isHtml && !showHtmlSource) setShowHtmlSource(true)
    updateEditing(!editing)
  }

  function toggleHtmlSource() {
    if (!isHtml) return
    const nextSourceVisible = !showHtmlSource
    setShowHtmlSource(nextSourceVisible)
    if (!nextSourceVisible && editing) updateEditing(false)
  }

  useEffect(() => {
    const nextState = resolveWorkspacePreviewEditorState(preview, draft)
    const nextEditorText = nextState.editorText
    const nextSavedText = nextState.savedText
    const nextEditing = nextState.editing
    setEditorText(nextEditorText)
    setSavedText(nextSavedText)
    setEditing(nextEditing)
    setShowMarkdownSource(isMarkdown && nextEditing)
    setShowHtmlSource(isHtml && nextEditing)
    setSaving(false)
    // A successful save reloads the preview (its modifiedAt changes), and this reset
    // ran in the same tick: the "已保存" line was cleared before it could be seen.
    // The status now survives exactly the refresh the save itself caused — the ref is
    // consumed here, so switching files or an external change still clears it.
    if (savedStatusPathRef.current === preview?.path) savedStatusPathRef.current = null
    else {
      setSaveMessage(''); setSaveError('')
    }
    // Writing here is what makes an edit dirty for the session; `keep` exists so a
    // still-loading preview cannot be mistaken for "this tab has no editable content"
    // — that deleted every stored draft on remount (see workspaceDraftOutcome).
    const outcome = workspaceDraftOutcome(preview)
    if (outcome === 'persist' && editable && preview && tabId && onDraftChange) {
      onDraftChange(tabId, {
        path: preview.path,
        modifiedAt: preview.modifiedAt,
        editorText: nextEditorText,
        savedText: nextSavedText,
        editing: nextEditing,
      })
    } else if (outcome === 'drop' && tabId && onDraftChange) {
      onDraftChange(tabId, null)
    }
  }, [sessionId, preview?.path, preview?.modifiedAt, editable, isMarkdown, isHtml])

  async function saveEditorContent(): Promise<boolean> {
    if (!editable || !preview || !dirty || saving) return !dirty
    setSaving(true)
    setSaveError('')
    setSaveMessage('')
    try {
      const nextPreview = await onSaveFile(preview.path, editorText, draft?.modifiedAt ?? preview.modifiedAt)
      if (nextPreview.kind === 'text' || nextPreview.kind === 'markdown' || nextPreview.kind === 'html') {
        setEditorText(nextPreview.content)
        setSavedText(nextPreview.content)
        if (tabId && onDraftChange) onDraftChange(tabId, {
          path: nextPreview.path,
          modifiedAt: nextPreview.modifiedAt,
          editorText: nextPreview.content,
          savedText: nextPreview.content,
          editing,
        })
      } else {
        setSavedText(editorText)
        emitDraft({ savedText: editorText })
      }
      setSaveMessage('已保存')
      // Keep the confirmation on screen across the refresh this save triggers.
      savedStatusPathRef.current = preview.path
      return true
    } catch (err) {
      console.debug('[workspace-preview-pane] file save failed', err)
      // A 409/413/415/403 already says what to do; the generic sentence would tell the
      // user to retry something that cannot succeed until they act.
      setSaveError(workspaceSaveErrorMessage(err, '文件保存失败，请稍后重试。'))
      return false
    } finally {
      setSaving(false)
    }
  }

  /** Previewing an HTML file starts its own local service; the toolbar only chooses where to open it. */
  const htmlRun = useHtmlRun({
    workspacePath,
    filePath: preview?.kind === 'html' ? preview.path : '',
    fileModifiedAt: preview?.modifiedAt ?? 0,
    isHtml,
  })

  return (
    <div className="workspace-preview-pane">
      <div className="workspace-preview-header workspace-page-leading-row">
        <WorkspacePreviewBreadcrumbs
          root={workspacePath}
          path={selectedPath}
          fallbackLabel={preview?.relativePath || selectedPath || '选择一个文件查看内容'}
          onRevealFolder={onRevealFolder}
        />
        {selectedPath && (
          <WorkspacePreviewActions
            editable={editable}
            isMarkdown={isMarkdown}
            isHtml={isHtml}
            editing={editing}
            showMarkdownSource={showMarkdownSource}
            showHtmlSource={showHtmlSource}
            canOpenExternalVSCode={canOpenExternalVSCode}
            showCodeWrapToggle={editorVisible} codeWrapEnabled={codeWrapEnabled}
            htmlRun={htmlRun.state}
            onOpenHtmlInApp={() => {
              if (htmlRun.state.url) onOpenBrowserTab(htmlRun.state.url)
            }}
            onOpenHtmlExternal={() => {
              if (htmlRun.state.url) void openExternalHref(htmlRun.state.url)
            }}
            onToggleCodeWrap={() => setCodeWrapEnabled(!codeWrapEnabled)}
            onToggleMarkdownSource={toggleMarkdownSource}
            onToggleHtmlSource={toggleHtmlSource}
            onToggleEditing={toggleEditing}
            onOpenInVSCode={onOpenInVSCode}
            openWith={openWith}
            onTipChange={onTipChange}
          />
        )}
      </div>
      {isHtml && htmlRun.state.status !== 'idle' && (
        <HtmlRunNotice run={htmlRun.state} draftUnsaved={dirty} />
      )}
      {(saveMessage || saveError) && (
        <div className={`workspace-editor-status ${saveError ? 'error' : ''}`}>
          {saveError || saveMessage}
        </div>
      )}
      <WorkspacePreviewDiskNotice
        notice={diskNotice}
        onKeepDraft={() => setDiskKeptPath(diskNoticeKey)}
        onReloadFromDisk={() => {
          setDiskKeptPath(diskNoticeKey)
          setDiskWatchRevision((value) => value + 1)
          onReloadFromDisk?.()
        }}
      />
      <div
        className={`workspace-preview-body ${editorVisible ? 'editor' : ''}`}
        onKeyDownCapture={(event) => {
          if (!editable || !dirty || saving) return
          const key = event.key.toLowerCase()
          if ((event.ctrlKey || event.metaKey) && key === 's') {
            event.preventDefault()
            void saveEditorContent()
          }
        }}
      >
        {loading && <WorkspacePlaceholder title="读取中" text="正在读取文件预览。" />}
        {!loading && error && <WorkspacePlaceholder title="预览失败" text={error} />}
        {!loading && !error && !preview && <WorkspacePlaceholder title="文件预览" text="代码和文本进入内置 VS Code 工作台；HTML、图片、PDF 和 Office 文件在 LS 内部预览。" />}
        {!loading && !error && isMarkdown && !showMarkdownSource && (
          <div className="workspace-preview-markdown">
            <Markdown text={editorText} />
          </div>
        )}
        {!loading && !error && isHtml && !showHtmlSource && (
          <WorkspaceHtmlPreviewSurface
            root={workspacePath}
            path={preview.path}
            name={preview.name}
            content={editorText}
            enabled
            liveUrl={htmlRun.state.status === 'running' ? htmlRun.state.url : ''}
            /* Re-keyed by the file's timestamp: a save reloads the served page in place, without
               restarting the service a browser tab may also be pointing at. */
            liveKey={preview.modifiedAt ?? 0}
          />
        )}
        {!loading && !error && editorVisible && (
          <div className="workspace-editor-monaco">
              <WorkspaceCodeEditor
              height="100%"
              language={editorLanguage}
              path={workspaceEditorModelPath(workspacePath, preview.path, workspaceSessionKey(sessionId))}
              value={editorText}
              loading={<WorkspacePlaceholder title="载入编辑器" text="正在打开内置代码编辑器。" />}
                // Read-only model synchronization is not a user edit and must never write a draft.
                onChange={(value) => { if (editing) updateEditorText(value ?? '') }}
                onMount={(editor, monaco) => setEditorHandle({ editor, monaco })}
              options={editorOptions}
              />
              {preview && onCommentsChange && onCommentUpdate && onCommentDelete && onAddAttachment && (
                <WorkspaceLineCommentOverlay
                  editor={editorHandle?.editor ?? null}
                  monaco={editorHandle?.monaco ?? null}
                  readOnly={!editing}
                  filePath={preview.path}
                  fileName={preview.name}
                  comments={comments ?? EMPTY_LINE_COMMENTS}
                  onCommentsChange={onCommentsChange}
                  onCommentUpdate={onCommentUpdate}
                  onCommentDelete={onCommentDelete}
                  onAddAttachment={onAddAttachment}
                  onTipChange={onTipChange}
                />
              )}
            </div>
        )}
        {!loading && !error && preview?.kind === 'image' && (
          <div className="workspace-preview-media">
            <img src={attachmentFileUrl(preview.path)} alt={preview.name} />
          </div>
        )}
        {!loading && !error && preview?.kind === 'pdf' && (
          <iframe className="workspace-preview-pdf" src={attachmentFileUrl(preview.path)} title={preview.name} />
        )}
        {!loading && !error && preview?.kind === 'office' && (
          <WorkspaceOfficePreview preview={preview} />
        )}
        {!loading && !error && preview?.kind === 'unsupported' && (
          <div className="workspace-preview-unsupported">
            <FileGlyphIcon name={preview.name} />
            <strong>{preview.name}</strong>
            <span>{preview.reason ?? '这个文件类型暂不支持内联预览。'}</span>
            {canOpenExternalVSCode && (
              <div className="workspace-preview-unsupported-actions">
                <button type="button" onClick={() => void onOpenInVSCode()}>
                  用外部 VS Code 打开
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
