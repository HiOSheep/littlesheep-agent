// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useMemo, useState } from 'react'
import {
  listWorkspaceArtifacts,
  type WorkspaceArtifactRecord
} from '../api'
import { fileActionLabel } from '../composer/message-files'
import { FloatingHelpTip, buildFloatingHelpTip, buildFloatingHelpTipFromElement } from '../ui/floating-help'
import { FileGlyphIcon, RefreshIcon, SearchIcon } from '../ui/icons'
import { transientTriggerProps } from '../ui/transient'
import { compactPath, formatDateTime } from './path-utils'
import { WorkspacePlaceholder } from './placeholder'
import { WorkspaceArtifactActionFilter, WorkspaceArtifactScopeFilter, WorkspaceArtifactSourceFilter } from './types'


export function WorkspaceArtifacts({
  workspacePath,
  sessionId,
  artifactVersion,
  onOpenFile,
  onTipChange,
}: {
  workspacePath: string
  sessionId?: string
  artifactVersion: number
  onOpenFile: (path: string) => void
  onTipChange: (tip: FloatingHelpTip | null) => void
}) {
  const [records, setRecords] = useState<WorkspaceArtifactRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<WorkspaceArtifactScopeFilter>('project')
  const [source, setSource] = useState<WorkspaceArtifactSourceFilter>('all')
  const [action, setAction] = useState<WorkspaceArtifactActionFilter>('all')
  const [query, setQuery] = useState('')

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    listWorkspaceArtifacts(workspacePath, scope === 'session' ? sessionId : undefined, 200)
      .then((nextRecords) => {
        if (!disposed) setRecords(nextRecords)
      })
      .catch((err) => {
        if (!disposed) {
          setRecords([])
          setError((err as Error).message)
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [artifactVersion, scope, sessionId, workspacePath])

  const filteredRecords = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return records.filter((record) => {
      if (source !== 'all' && record.source !== source) return false
      if (action !== 'all' && record.action !== action) return false
      if (!normalizedQuery) return true
      return [
        record.name,
        record.path,
        record.toolName ?? '',
        record.runId ?? '',
      ].join(' ').toLowerCase().includes(normalizedQuery)
    })
  }, [action, query, records, source])

  const sourceCounts = useMemo(() => ({
    all: records.length,
    agent: records.filter((record) => record.source === 'agent').length,
    user: records.filter((record) => record.source === 'user').length,
  }), [records])

  const actionCounts = useMemo(() => ({
    all: records.length,
    created: records.filter((record) => record.action === 'created').length,
    modified: records.filter((record) => record.action === 'modified').length,
    attached: records.filter((record) => record.action === 'attached').length,
  }), [records])

  function refreshArtifacts() {
    setLoading(true)
    setError('')
    listWorkspaceArtifacts(workspacePath, scope === 'session' ? sessionId : undefined, 200)
      .then(setRecords)
      .catch((err) => {
        setRecords([])
        setError((err as Error).message)
      })
      .finally(() => setLoading(false))
  }

  return (
    <div className="workspace-artifacts">
      <header className="workspace-artifacts-header workspace-page-leading-row">
        <div className="workspace-artifacts-title">
          <strong>产物管理</strong>
          <small>{compactPath(workspacePath)}</small>
        </div>
        <button
          {...transientTriggerProps()}
          className="workspace-files-icon-btn"
          type="button"
          aria-label="刷新产物"
          onClick={refreshArtifacts}
          onMouseEnter={(event) => onTipChange(buildFloatingHelpTip('刷新产物', event.clientX, event.clientY))}
          onMouseMove={(event) => onTipChange(buildFloatingHelpTip('刷新产物', event.clientX, event.clientY))}
          onMouseLeave={() => onTipChange(null)}
          onFocus={(event) => onTipChange(buildFloatingHelpTipFromElement('刷新产物', event.currentTarget))}
          onBlur={() => onTipChange(null)}
        >
          <RefreshIcon />
        </button>
      </header>
      <div className="workspace-artifacts-controls">
        <div className="workspace-artifacts-filter-group" aria-label="产物范围">
          <ArtifactFilterButton active={scope === 'project'} label="项目" onClick={() => setScope('project')} />
          <ArtifactFilterButton active={scope === 'session'} label="对话" disabled={!sessionId} onClick={() => setScope('session')} />
        </div>
        <div className="workspace-artifacts-filter-group" aria-label="产物来源">
          <ArtifactFilterButton active={source === 'all'} label="全部" count={sourceCounts.all} onClick={() => setSource('all')} />
          <ArtifactFilterButton active={source === 'agent'} label="Agent" count={sourceCounts.agent} onClick={() => setSource('agent')} />
          <ArtifactFilterButton active={source === 'user'} label="用户" count={sourceCounts.user} onClick={() => setSource('user')} />
        </div>
        <div className="workspace-artifacts-filter-group" aria-label="产物动作">
          <ArtifactFilterButton active={action === 'all'} label="全部动作" count={actionCounts.all} onClick={() => setAction('all')} />
          <ArtifactFilterButton active={action === 'created'} label="新建" count={actionCounts.created} onClick={() => setAction('created')} />
          <ArtifactFilterButton active={action === 'modified'} label="修改" count={actionCounts.modified} onClick={() => setAction('modified')} />
          <ArtifactFilterButton active={action === 'attached'} label="附件" count={actionCounts.attached} onClick={() => setAction('attached')} />
        </div>
        <label className="workspace-artifacts-search">
          <span aria-hidden="true"><SearchIcon /></span>
          <input
            value={query}
            type="search"
            placeholder="筛选文件、路径或工具..."
            aria-label="筛选产物"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className={`workspace-artifacts-list ${filteredRecords.length === 0 ? 'empty' : ''}`}>
        {loading && <WorkspacePlaceholder title="读取中" text="正在加载项目产物索引。" />}
        {!loading && error && <WorkspacePlaceholder title="产物读取失败" text={error} />}
        {!loading && !error && filteredRecords.length === 0 && (
          <WorkspacePlaceholder
            title={records.length === 0 ? '暂无产物' : '没有匹配产物'}
            text={records.length === 0 ? 'agent 写入、修改文件或你在内置编辑器保存文件后，会沉淀到这里。' : '调整筛选条件可以重新看到隐藏的产物。'}
          />
        )}
        {!loading && !error && filteredRecords.length > 0 && filteredRecords.map((record) => (
          <button
            key={record.id}
            className={`workspace-artifact-row ${record.action} ${record.source}`}
            type="button"
            onClick={() => onOpenFile(record.path)}
          >
            <span className="workspace-artifact-row-icon" aria-hidden="true">
              <FileGlyphIcon />
            </span>
            <span className="workspace-artifact-row-main">
              <strong>{record.name}</strong>
              <small>{compactPath(record.path)}</small>
            </span>
            <span className="workspace-artifact-row-meta">
              <em>{record.source === 'agent' ? 'Agent' : '用户'}</em>
              <em>{fileActionLabel(record.action)}</em>
              <time>{formatDateTime(Date.parse(record.createdAt))}</time>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}


export function ArtifactFilterButton({
  active,
  label,
  count,
  disabled = false,
  onClick,
}: {
  active: boolean
  label: string
  count?: number
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`workspace-artifacts-filter ${active ? 'active' : ''}`}
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={onClick}
    >
      <span>{label}</span>
      {count !== undefined && <small>{count}</small>}
    </button>
  )
}
