// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import {
  openWorkspacePathInVSCode,
  previewWorkspaceFile,
  saveWorkspaceFile,
  type WorkspacePreview
} from '../api'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FileGlyphIcon, VSCodeIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import {
  type WorkspaceFileDraftState,
  type WorkspaceFileTabId
} from '../workspace-persistence'
import { attachmentFileUrl, countEditorLines, detectEditorEol, formatDateTime, formatEditorLanguageLabel, formatFileSize, lastPathSegment, shouldOfferExternalVSCode, utf8ByteLength, workspaceBreadcrumbs } from './path-utils'
import { WorkspacePlaceholder } from './placeholder'
import { configureLittleSheepMonaco } from './monaco-language-support'
import { LITTLE_SHEEP_MONACO_THEME } from './monaco-theme'

export const MonacoEditor = lazy(async () => {
  const [monacoReact, monaco] = await Promise.all([
    import('@monaco-editor/react'),
    import('monaco-editor'),
  ])
  monacoReact.loader.config({ monaco })
  return { default: monacoReact.default }
})

export function WorkspaceFileView({
  tabId,
  root,
  path,
  sessionId,
  draft,
  onDraftChange,
  onRequestFileSaveApproval,
  onWorkspaceArtifactsChanged,
  onWorkspaceFileSaved,
  onTipChange,
}: {
  tabId: WorkspaceFileTabId
  root: string
  path: string
  sessionId?: string
  draft?: WorkspaceFileDraftState
  onDraftChange: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onRequestFileSaveApproval: (detail: unknown) => Promise<boolean>
  onWorkspaceArtifactsChanged: () => void
  onWorkspaceFileSaved: (root: string, path: string, preview: WorkspacePreview) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [preview, setPreview] = useState<WorkspacePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  useEffect(() => {
    let alive = true
    const requestId = ++requestRef.current
    setPreview(null)
    setError('')
    setLoading(true)
    previewWorkspaceFile(root, path)
      .then((result) => {
        if (!alive || requestId !== requestRef.current) return
        setPreview(result)
      })
      .catch((err) => {
        if (!alive || requestId !== requestRef.current) return
        setError((err as Error).message)
      })
      .finally(() => {
        if (!alive || requestId !== requestRef.current) return
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [root, path])

  async function openInVSCode() {
    try {
      await openWorkspacePathInVSCode(root, path)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function saveFile(nextPath: string, content: string, expectedModifiedAt?: number): Promise<WorkspacePreview> {
    const approved = await onRequestFileSaveApproval({
      path: nextPath,
      root,
      relativePath: workspaceBreadcrumbs(root, nextPath).join('/'),
    })
    if (!approved) throw new Error('已取消保存。')
    const nextPreview = await saveWorkspaceFile(root, nextPath, content, expectedModifiedAt, sessionId)
    setPreview(nextPreview)
    onWorkspaceArtifactsChanged()
    onWorkspaceFileSaved(root, nextPath, nextPreview)
    return nextPreview
  }

  return (
    <WorkspacePreviewPane
      preview={preview}
      loading={loading}
      error={error}
      selectedPath={path}
      workspacePath={root}
      tabId={tabId}
      draft={draft}
      onOpenInVSCode={openInVSCode}
      onSaveFile={saveFile}
      onDraftChange={onDraftChange}
      onTipChange={onTipChange}
    />
  )
}

export function WorkspacePreviewPane({
  preview,
  loading,
  error,
  selectedPath,
  workspacePath,
  tabId,
  draft,
  onOpenInVSCode,
  onSaveFile,
  onDraftChange,
  onTipChange,
}: {
  preview: WorkspacePreview | null
  loading: boolean
  error: string
  selectedPath: string
  workspacePath: string
  tabId?: WorkspaceFileTabId
  draft?: WorkspaceFileDraftState
  onOpenInVSCode: () => void | Promise<void>
  onSaveFile: (path: string, content: string, expectedModifiedAt?: number) => Promise<WorkspacePreview>
  onDraftChange?: (tab: WorkspaceFileTabId, draft: WorkspaceFileDraftState | null) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const title = preview?.name ?? (selectedPath ? lastPathSegment(selectedPath) : '预览')
  const meta = preview ? `${formatFileSize(preview.size)}${preview.modifiedAt ? ` · ${formatDateTime(preview.modifiedAt)}` : ''}` : ''
  const breadcrumbs = selectedPath ? workspaceBreadcrumbs(workspacePath, selectedPath) : []
  const editable = preview?.kind === 'text' || preview?.kind === 'markdown'
  const editorLanguage = preview?.kind === 'markdown'
    ? 'markdown'
    : preview?.kind === 'text'
      ? preview.language || 'text'
      : ''
  const editorLanguageLabel = formatEditorLanguageLabel(editorLanguage)
  const canOpenExternalVSCode = preview ? shouldOfferExternalVSCode(preview) : false
  const [editing, setEditing] = useState(false)
  const [editorText, setEditorText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [saveError, setSaveError] = useState('')
  const dirty = editable && editorText !== savedText
  const editorLineCount = editable ? countEditorLines(editorText) : 0
  const editorEol = editable ? detectEditorEol(editorText) : ''
  const editorSize = editable ? formatFileSize(utf8ByteLength(editorText)) : ''

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
      modifiedAt: next.modifiedAt ?? preview.modifiedAt,
      editorText: next.editorText ?? editorText,
      savedText: next.savedText ?? savedText,
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

  useEffect(() => {
    const content = editable ? preview.content : ''
    const canRestoreDraft = editable && preview && draft?.path === preview.path && draft.modifiedAt === preview.modifiedAt
    const nextEditorText = canRestoreDraft ? draft.editorText : content
    const nextSavedText = canRestoreDraft ? draft.savedText : content
    const nextEditing = canRestoreDraft ? draft.editing : false
    setEditorText(nextEditorText)
    setSavedText(nextSavedText)
    setEditing(nextEditing)
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
  }, [preview?.path, preview?.modifiedAt, editable])

  async function saveEditorContent() {
    if (!editable || !preview || !dirty || saving) return
    setSaving(true)
    setSaveError('')
    setSaveMessage('')
    try {
      const nextPreview = await onSaveFile(preview.path, editorText, preview.modifiedAt)
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
      <div className="workspace-preview-header">
        <div className="workspace-preview-title">
          <span>
            {title}
            {editable && <b className="workspace-preview-editor-badge">内置 VS Code · {editorLanguageLabel}</b>}
          </span>
          {breadcrumbs.length > 0 ? (
            <div className="workspace-preview-breadcrumbs" aria-label="文件路径">
              {breadcrumbs.map((part, index) => (
                <span key={`${part}-${index}`}>
                  {index > 0 && <i aria-hidden="true">/</i>}
                  <em>{part}</em>
                </span>
              ))}
            </div>
          ) : (
            <small>{preview?.relativePath || (selectedPath ? selectedPath : '选择一个文件查看内容')}</small>
          )}
        </div>
        {selectedPath && (
          <div className="workspace-preview-actions">
            {editable && (
              <>
                <button
                  {...transientTriggerProps()}
                  className={`workspace-files-text-btn ${editing ? 'active' : ''}`}
                  type="button"
                  aria-pressed={editing}
                  onClick={() => updateEditing(!editing)}
                  onMouseEnter={(event) => onTipChange(buildFloatingHelpTip(editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑', event.clientX, event.clientY))}
                  onMouseMove={(event) => onTipChange(buildFloatingHelpTip(editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑', event.clientX, event.clientY))}
                  onMouseLeave={() => onTipChange(null)}
                  onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement(editing ? '切换到只读代码视图' : '在内置 VS Code 编辑器中编辑', event.currentTarget))}
                  onBlur={() => onTipChange(null)}
                >
                  {editing ? '只读' : '编辑'}
                </button>
                <button
                  {...transientTriggerProps()}
                  className="workspace-files-text-btn"
                  type="button"
                  disabled={!dirty || saving}
                  onClick={() => void saveEditorContent()}
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
        )}
      </div>
      {meta && <div className="workspace-preview-meta">{meta}</div>}
      {(saveMessage || saveError) && (
        <div className={`workspace-editor-status ${saveError ? 'error' : ''}`}>
          {saveError || saveMessage}
        </div>
      )}
      <div
        className="workspace-preview-body"
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
        {!loading && !error && editable && (
          <div className="workspace-editor-shell">
            <div className="workspace-editor-monaco">
              <Suspense fallback={<WorkspacePlaceholder title="载入编辑器" text="正在打开内置代码编辑器。" />}>
                <MonacoEditor
                  height="100%"
                  language={editorLanguage}
                  value={editorText}
                  theme={LITTLE_SHEEP_MONACO_THEME}
                  beforeMount={configureLittleSheepMonaco}
                  onChange={(value) => updateEditorText(value ?? '')}
                  options={{
                    automaticLayout: true,
                    bracketPairColorization: { enabled: true },
                    cursorBlinking: 'smooth',
                    detectIndentation: true,
                    folding: true,
                    fontFamily: 'Consolas, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
                    fontSize: 12,
                    fontWeight: '500',
                    formatOnPaste: true,
                    guides: { bracketPairs: true, indentation: true },
                    lineDecorationsWidth: 8,
                    lineNumbers: 'on',
                    lineNumbersMinChars: 3,
                    minimap: { enabled: false },
                    overviewRulerBorder: false,
                    padding: { top: 10, bottom: 10 },
                    readOnly: !editing,
                    renderLineHighlight: editing ? 'all' : 'none',
                    renderWhitespace: 'selection',
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    tabSize: 2,
                    wordWrap: 'on',
                  }}
                />
              </Suspense>
            </div>
            <div className="workspace-editor-statusbar" aria-label="内置代码工作台状态">
              <span>{editing ? (dirty ? '编辑中*' : '编辑中') : '只读'}</span>
              <span>{editorLanguageLabel}</span>
              <span>{editorLineCount} 行</span>
              <span>{editorSize}</span>
              <span>{editorEol}</span>
              <span>{dirty ? '未保存' : '已同步'}</span>
            </div>
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
