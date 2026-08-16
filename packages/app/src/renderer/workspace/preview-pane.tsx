// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useMemo, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import {
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
import { attachmentFileUrl, countEditorLines, detectEditorEol, formatDateTime, formatEditorLanguageLabel, formatFileSize, shouldOfferExternalVSCode, utf8ByteLength, workspaceBreadcrumbs } from './path-utils'
import { WorkspacePlaceholder } from './placeholder'
import { resolveWorkspacePreviewEditorState } from './preview-draft'
import { WorkspacePreviewActions } from './preview-actions'
import { WorkspaceLineCommentOverlay, type WorkspaceLineComment } from './line-comments'

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
  onDraftChange,
  comments,
  onCommentsChange,
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
  onDraftChange?: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  comments?: WorkspaceLineComment[]
  onCommentsChange?: (comments: WorkspaceLineComment[]) => void
  onAddAttachment?: (attachment: AttachmentRef) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const breadcrumbs = selectedPath ? workspaceBreadcrumbs(workspacePath, selectedPath) : []
  const pathParts = breadcrumbs.length > 0
    ? breadcrumbs
    : [preview?.relativePath || selectedPath || '选择一个文件查看内容']
  const isMarkdown = preview?.kind === 'markdown'
  const editable = preview?.kind === 'text' || isMarkdown
  const editorLanguage = preview?.kind === 'markdown'
    ? 'markdown'
    : preview?.kind === 'text'
      ? preview.language || 'text'
      : ''
  const editorLanguageLabel = formatEditorLanguageLabel(editorLanguage)
  const canOpenExternalVSCode = preview ? shouldOfferExternalVSCode(preview) : false
  const initialEditorState = resolveWorkspacePreviewEditorState(preview, draft)
  const [editing, setEditing] = useState(initialEditorState.editing)
  const [showMarkdownSource, setShowMarkdownSource] = useState(
    isMarkdown && initialEditorState.editing,
  )
  const [editorText, setEditorText] = useState(initialEditorState.editorText)
  const [savedText, setSavedText] = useState(initialEditorState.savedText)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [saveError, setSaveError] = useState('')
  const [editorHandle, setEditorHandle] = useState<{
    editor: Monaco.editor.IStandaloneCodeEditor
    monaco: typeof Monaco
  } | null>(null)
  const editorVisible = editable && (!isMarkdown || showMarkdownSource)
  const dirty = editable && editorText !== savedText
  const editorLineCount = editable ? countEditorLines(editorText) : 0
  const editorEol = editable ? detectEditorEol(editorText) : ''
  const editorSize = editable ? formatFileSize(utf8ByteLength(editorText)) : ''
  const previewSize = preview ? formatFileSize(preview.size) : ''
  const previewModifiedAt = preview?.modifiedAt ? formatDateTime(preview.modifiedAt) : ''
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
  }), [editing])

  function emitDraft(next: {
    editorText?: string
    savedText?: string
    editing?: boolean
    modifiedAt?: number
    path?: string
  }) {
    if (!tabId || !onDraftChange) return
    if (!editable || !preview || (preview.kind !== 'text' && preview.kind !== 'markdown')) {
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
    updateEditing(!editing)
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
    setSaving(false)
    setSaveMessage('')
    setSaveError('')
    if (editable && preview && (preview.kind === 'text' || preview.kind === 'markdown')) {
      if (tabId && onDraftChange) onDraftChange(tabId, {
        path: preview.path,
        modifiedAt: preview.modifiedAt,
        editorText: nextEditorText,
        savedText: nextSavedText,
        editing: nextEditing,
      })
    } else {
      if (tabId && onDraftChange) onDraftChange(tabId, null)
    }
  }, [sessionId, preview?.path, preview?.modifiedAt, editable, isMarkdown])

  async function saveEditorContent() {
    if (!editable || !preview || !dirty || saving) return
    setSaving(true)
    setSaveError('')
    setSaveMessage('')
    try {
      const nextPreview = await onSaveFile(preview.path, editorText, draft?.modifiedAt ?? preview.modifiedAt)
      if (nextPreview.kind === 'text' || nextPreview.kind === 'markdown') {
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
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="workspace-preview-pane">
      <div className="workspace-preview-header workspace-page-leading-row">
        <div className="workspace-preview-breadcrumbs" aria-label="文件路径">
          {pathParts.map((part, index) => (
            <span key={`${part}-${index}`}>
              {index > 0 && <i aria-hidden="true">/</i>}
              <em>{part}</em>
            </span>
          ))}
        </div>
        {selectedPath && (
          <WorkspacePreviewActions
            editable={editable}
            isMarkdown={isMarkdown}
            editing={editing}
            showMarkdownSource={showMarkdownSource}
            dirty={dirty}
            saving={saving}
            canOpenExternalVSCode={canOpenExternalVSCode}
            onToggleMarkdownSource={toggleMarkdownSource}
            onToggleEditing={toggleEditing}
            onSave={() => void saveEditorContent()}
            onOpenInVSCode={onOpenInVSCode}
            onTipChange={onTipChange}
          />
        )}
      </div>
      {(saveMessage || saveError) && (
        <div className={`workspace-editor-status ${saveError ? 'error' : ''}`}>
          {saveError || saveMessage}
        </div>
      )}
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
        {!loading && !error && !preview && <WorkspacePlaceholder title="文件预览" text="代码和文本进入内置 VS Code 工作台；图片、PDF 和 Office 文件在 LS 内部预览。" />}
        {!loading && !error && isMarkdown && !showMarkdownSource && (
          <div className="workspace-preview-markdown">
            <Markdown text={editorText} />
          </div>
        )}
        {!loading && !error && editorVisible && (
          <div className="workspace-editor-monaco">
              <WorkspaceCodeEditor
              height="100%"
              language={editorLanguage}
              path={workspaceEditorModelPath(workspacePath, preview.path, workspaceSessionKey(sessionId))}
              value={editorText}
              loading={<WorkspacePlaceholder title="载入编辑器" text="正在打开内置代码编辑器。" />}
                onChange={(value) => updateEditorText(value ?? '')}
                onMount={(editor, monaco) => setEditorHandle({ editor, monaco })}
              options={editorOptions}
              />
              {preview && onCommentsChange && onAddAttachment && (
                <WorkspaceLineCommentOverlay
                  editor={editorHandle?.editor ?? null}
                  monaco={editorHandle?.monaco ?? null}
                  readOnly={!editing}
                  filePath={preview.path}
                  fileName={preview.name}
                  comments={comments ?? EMPTY_LINE_COMMENTS}
                  onCommentsChange={onCommentsChange}
                  onAddAttachment={onAddAttachment}
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
            <FileGlyphIcon />
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
      {preview && (
        <div className="workspace-preview-statusbar" aria-label="文件预览状态">
          {editable && <span>{isMarkdown && !showMarkdownSource ? '预览' : editing ? (dirty ? '编辑中*' : '编辑中') : '只读'}</span>}
          {editable && <span>{editorLanguageLabel}</span>}
          {editable && <span>{editorLineCount} 行</span>}
          <span>{editable ? editorSize : previewSize}</span>
          {previewModifiedAt && <span>{previewModifiedAt}</span>}
          {editable && <span>{editorEol}</span>}
          {editable && <span>{dirty ? '未保存' : '已同步'}</span>}
        </div>
      )}
    </div>
  )
}

function WorkspaceOfficePreview({
  preview,
}: {
  preview: Extract<WorkspacePreview, { kind: 'office' }>
}) {
  return (
    <div className={`workspace-office-preview ${preview.officeKind}`}>
      <div className="workspace-office-heading">
        <strong>{officeKindLabel(preview.officeKind)}</strong>
        {preview.note && <span>{preview.note}</span>}
        {preview.truncated && <span>内容较多，已按预览上限截取。</span>}
      </div>
      {preview.sections.length === 0 && (
        <div className="workspace-office-empty">文件已在 LS 内打开，但没有提取到可显示的文字。</div>
      )}
      {preview.officeKind === 'spreadsheet' ? (
        <div className="workspace-office-sheets">
          {preview.sections.map((section) => (
            <section className="workspace-office-sheet" key={section.title}>
              <h3>{section.title}</h3>
              <div className="workspace-office-table-wrap">
                <table>
                  <tbody>
                    {(section.rows ?? []).map((row, rowIndex) => (
                      <tr key={`${section.title}-${rowIndex}`}>
                        {row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{cell}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="workspace-office-sections">
          {preview.sections.map((section) => (
            <section className="workspace-office-section" key={section.title}>
              <h3>{section.title}</h3>
              {(section.paragraphs ?? []).map((paragraph, index) => (
                <p key={`${section.title}-${index}`}>{paragraph}</p>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function officeKindLabel(kind: Extract<WorkspacePreview, { kind: 'office' }>['officeKind']): string {
  if (kind === 'spreadsheet') return '表格预览'
  if (kind === 'presentation') return '演示文稿预览'
  return '文档预览'
}
