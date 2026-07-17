// User-facing memory document view. Internal atoms and vector metadata stay hidden.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getMemoryFilesPayload,
  readMemoryFile,
  writeMemoryFile, type MemoryActivationProjection, type MemoryFileDetail,
  type MemoryFileName,
  type MemoryFileOverview,
} from './api'
import { Markdown } from './Markdown'
import { formatMemoryFileBytes, MemoryActivationLevels } from './memory-files-presentation'
import { CheckIcon, FileGlyphIcon, RefreshIcon, SearchIcon } from './ui/icons'

export function MemoryTreeView() {
  const [files, setFiles] = useState<MemoryFileOverview[]>([])
  const [activation, setActivation] = useState<MemoryActivationProjection | null>(null)
  const [selectedName, setSelectedName] = useState<MemoryFileName>('SOUL.md')
  const [detail, setDetail] = useState<MemoryFileDetail | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailRevision, setDetailRevision] = useState(0)
  const detailRequestRef = useRef<AbortController | null>(null)
  const selectedNameRef = useRef<MemoryFileName>(selectedName)
  const mountedRef = useRef(true)

  useEffect(() => {
    selectedNameRef.current = selectedName
  }, [selectedName])

  async function loadFiles(silent = false) {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const payload = await getMemoryFilesPayload()
      const next = payload.files
      if (!mountedRef.current) return
      setFiles(next)
      setActivation(payload.activation)
      setSelectedName((current) => next.some((file) => file.name === current)
        ? current
        : next.find((file) => file.name === 'SOUL.md')?.name ?? next[0]?.name ?? 'SOUL.md')
      if (silent) setDetailRevision((revision) => revision + 1)
    } catch (loadError) {
      if (mountedRef.current) setError((loadError as Error).message)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    void loadFiles()
    return () => {
      mountedRef.current = false
      detailRequestRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    detailRequestRef.current?.abort()
    const controller = new AbortController()
    detailRequestRef.current = controller
    setDetail(null)
    setLoadingDetail(true)
    setError(null)
    void readMemoryFile(selectedName, controller.signal)
      .then((next) => {
        if (!mountedRef.current || controller.signal.aborted) return
        setDetail(next)
        setDraft(next.content)
      })
      .catch((loadError) => {
        if (!controller.signal.aborted && mountedRef.current) setError((loadError as Error).message)
      })
      .finally(() => {
        if (detailRequestRef.current === controller) detailRequestRef.current = null
        if (mountedRef.current && !controller.signal.aborted) setLoadingDetail(false)
      })
    return () => controller.abort()
  }, [detailRevision, selectedName])

  const visibleFiles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return files
    return files.filter((file) => `${file.name}\n${file.description}`.toLocaleLowerCase().includes(needle))
  }, [files, query])

  const dirty = detail?.editable === true && draft !== detail.content

  async function save() {
    if (!detail?.editable || !dirty) return
    setSaving(true)
    setError(null)
    try {
      const saved = await writeMemoryFile(detail.name, draft)
      if (!mountedRef.current) return
      setDetail((current) => current?.name === saved.name ? saved : current)
      if (selectedNameRef.current === saved.name) setDraft(saved.content)
      setFiles((current) => current.map((file) => file.name === saved.name ? saved : file))
    } catch (saveError) {
      if (mountedRef.current) setError((saveError as Error).message)
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  return (
    <div className="memory-files-page">
      <header className="memory-files-heading">
        <h2>记忆树</h2>
        <button
          className="memory-files-icon-button"
          type="button"
          title="刷新记忆文件"
          aria-label="刷新记忆文件"
          onClick={() => void loadFiles(true)}
          disabled={loading}
        >
          <RefreshIcon />
        </button>
      </header>

      {error && <div className="dialog-error">记忆文件操作失败：{error}</div>}

      {activation && <MemoryActivationLevels activation={activation} />}

      <div className="memory-files-layout">
        <aside className="memory-files-sidebar">
          <label className="memory-files-search">
            <SearchIcon />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索记忆文件"
              aria-label="搜索记忆文件"
            />
          </label>
          <div className="memory-files-list" aria-label="记忆文件">
            {visibleFiles.map((file) => (
              <button
                key={file.name}
                type="button"
                className={`memory-file-row ${selectedName === file.name ? 'active' : ''}`}
                aria-current={selectedName === file.name ? 'page' : undefined}
                onClick={() => setSelectedName(file.name)}
              >
                <FileGlyphIcon />
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.description}</small>
                </span>
                <small className="memory-file-size">{formatMemoryFileBytes(file.size)}</small>
              </button>
            ))}
            {!loading && visibleFiles.length === 0 && (
              <div className="memory-files-empty">没有匹配的记忆文件</div>
            )}
          </div>
        </aside>

        <main className="memory-file-content">
          {loadingDetail || !detail || detail.name !== selectedName ? (
            <div className="memory-files-loading">正在读取...</div>
          ) : (
            <section key={detail.name} className="memory-file-document">
              <div className="memory-file-toolbar">
                <span>
                  <strong>{detail.name}</strong>
                  <small>{detail.editable ? '可编辑' : '只读'}</small>
                </span>
                {detail.editable && (
                  <button
                    type="button"
                    className="memory-file-save"
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                  >
                    <CheckIcon />
                    {saving ? '保存中' : '保存'}
                  </button>
                )}
              </div>
              {detail.editable ? (
                <textarea
                  className="memory-file-editor"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck={false}
                  aria-label={`编辑 ${detail.name}`}
                />
              ) : (
                <div className="memory-file-preview">
                  <Markdown text={detail.content || '（空文件）'} />
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
