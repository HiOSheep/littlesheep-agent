import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getMemoryTreeOverview,
  manageMemoryTreeNode,
  updateMemoryLearningPolicy,
  type MemoryTreeBranchId,
  type MemoryTreeManagementAction,
  type MemoryTreeNodeOverview,
  type MemoryTreeOverview,
} from './api'
import { Markdown } from './Markdown'

type MemoryBranchFilter = 'all' | MemoryTreeBranchId | 'archive'
type ConfirmationRequest = {
  node: MemoryTreeNodeOverview
  action: Extract<MemoryTreeManagementAction, 'delete' | 'promote'>
}

const BRANCH_LABELS: Record<MemoryTreeBranchId, string> = {
  'long-term': '长期记忆',
  project: '项目记忆',
  daily: '每日流水',
  experience: '经验库',
}

const SCOPE_LABELS: Record<MemoryTreeNodeOverview['scope'], string> = {
  global: '全局',
  workspace: '工作区',
  project: '项目',
  session: '会话',
}

export function MemoryTreeView() {
  const [overview, setOverview] = useState<MemoryTreeOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [experienceThreshold, setExperienceThreshold] = useState(0.65)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [branchFilter, setBranchFilter] = useState<MemoryBranchFilter>('all')
  const [query, setQuery] = useState('')
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null)
  const [managingNodeId, setManagingNodeId] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
  const [confirmationVisible, setConfirmationVisible] = useState(false)
  const confirmationTimerRef = useRef(0)

  async function load(silent = false) {
    if (silent) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const next = await getMemoryTreeOverview()
      setOverview(next)
      setExpandedNodeId((current) => current && next.nodes.some((node) => node.id === current) ? current : null)
    } catch (err) {
      setError((err as Error).message)
      if (!silent) setOverview(null)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    if (overview) setExperienceThreshold(overview.learningPolicy.experienceWriteThreshold)
  }, [overview?.learningPolicy.experienceWriteThreshold])

  useEffect(() => () => window.clearTimeout(confirmationTimerRef.current), [])

  useEffect(() => {
    if (!confirmation) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeConfirmation()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmation])

  async function saveLearningPolicy() {
    setSavingPolicy(true)
    setError(null)
    try {
      const saved = await updateMemoryLearningPolicy(experienceThreshold)
      setOverview((current) => current ? {
        ...current,
        learningPolicy: { experienceWriteThreshold: saved.experienceWriteThreshold },
      } : current)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSavingPolicy(false)
    }
  }

  function openConfirmation(request: ConfirmationRequest) {
    window.clearTimeout(confirmationTimerRef.current)
    setConfirmation(request)
    setConfirmationVisible(false)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setConfirmationVisible(true))
    })
  }

  function closeConfirmation() {
    setConfirmationVisible(false)
    window.clearTimeout(confirmationTimerRef.current)
    confirmationTimerRef.current = window.setTimeout(() => setConfirmation(null), 220)
  }

  async function executeAction(node: MemoryTreeNodeOverview, action: MemoryTreeManagementAction) {
    setManagingNodeId(node.id)
    setError(null)
    try {
      await manageMemoryTreeNode(node.id, action)
      closeConfirmation()
      if (action === 'delete') setExpandedNodeId(null)
      await load(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setManagingNodeId(null)
    }
  }

  function requestAction(node: MemoryTreeNodeOverview, action: MemoryTreeManagementAction) {
    if (action === 'delete' || (action === 'promote' && node.tier === 2)) {
      openConfirmation({ node, action })
      return
    }
    void executeAction(node, action)
  }

  const filteredNodes = useMemo(() => {
    if (!overview) return []
    const needle = query.trim().toLocaleLowerCase()
    return overview.nodes.filter((node) => {
      if (branchFilter === 'archive') {
        if (node.status !== 'archived') return false
      } else {
        if (node.status !== 'active') return false
        if (branchFilter !== 'all' && node.branch !== branchFilter) return false
      }
      if (!needle) return true
      return [
        node.summary,
        node.content,
        node.reason,
        node.scopeKey ?? '',
        node.project?.name ?? '',
        ...node.retrievalKeys,
        ...node.sourceRefs,
        ...node.sourceRunIds,
      ].some((value) => value.toLocaleLowerCase().includes(needle))
    })
  }, [branchFilter, overview, query])

  const matchingProjects = useMemo(() => {
    if (!overview || branchFilter !== 'project') return []
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return overview.projects
    return overview.projects.filter((project) =>
      `${project.name}\n${project.path}`.toLocaleLowerCase().includes(needle),
    )
  }, [branchFilter, overview, query])

  const activeNodeCount = overview?.nodes.filter((node) => node.status === 'active').length ?? 0
  const selectedBranch = branchFilter !== 'all' && branchFilter !== 'archive'
    ? overview?.branches.find((branch) => branch.id === branchFilter)
    : null

  return (
    <div className="memory-tree-page">
      <div className="memory-tree-heading">
        <span>
          <h2>记忆树</h2>
          <p>这里展示并管理 LS 实际用于索引、检索和上下文介入的记忆。</p>
        </span>
        <button
          className="memory-tree-refresh"
          type="button"
          onClick={() => void load(true)}
          disabled={loading || refreshing}
        >
          {refreshing ? '刷新中' : '刷新'}
        </button>
      </div>

      {error && <div className="dialog-error">记忆树操作失败：{error}</div>}
      {loading && !overview && <div className="memory-tree-loading">正在读取运行时记忆索引...</div>}

      {overview && (
        <>
          <section className="memory-tree-summary" aria-label="记忆树概况">
            <MemoryTreeStat label="运行中" value={String(activeNodeCount)} />
            <MemoryTreeStat label="已归档" value={String(overview.totals.archivedMemories)} />
            <MemoryTreeStat label="近期命中" value={String(overview.recentAccesses.length)} />
            <MemoryTreeStat label="项目" value={String(overview.totals.projects)} />
          </section>

          <section className="memory-learning-row" aria-label="经验学习策略">
            <span>
              <strong>经验写入阈值</strong>
              <small>只影响后续自动写入</small>
            </span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={experienceThreshold}
              aria-label="经验写入阈值"
              onChange={(event) => setExperienceThreshold(Number(event.target.value))}
            />
            <output>{Math.round(experienceThreshold * 100)}%</output>
            <button
              type="button"
              onClick={() => void saveLearningPolicy()}
              disabled={savingPolicy || experienceThreshold === overview.learningPolicy.experienceWriteThreshold}
            >
              {savingPolicy ? '保存中' : '保存'}
            </button>
          </section>

          <div className="memory-control-plane">
            <nav className="memory-branch-nav" aria-label="记忆分支">
              <MemoryBranchButton
                active={branchFilter === 'all'}
                label="全部记忆"
                count={activeNodeCount}
                onClick={() => setBranchFilter('all')}
              />
              {overview.branches.map((branch) => (
                <MemoryBranchButton
                  key={branch.id}
                  active={branchFilter === branch.id}
                  label={branch.title}
                  count={branch.indexedCount}
                  onClick={() => setBranchFilter(branch.id)}
                />
              ))}
              <div className="memory-branch-divider" />
              <MemoryBranchButton
                active={branchFilter === 'archive'}
                label="归档记忆"
                count={overview.totals.archivedMemories}
                onClick={() => setBranchFilter('archive')}
              />
            </nav>

            <section className="memory-node-pane">
              <label className="memory-search-field">
                <span aria-hidden="true" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索记忆、来源或索引键"
                  aria-label="搜索记忆"
                />
                {query && (
                  <button type="button" onClick={() => setQuery('')} aria-label="清除搜索">×</button>
                )}
              </label>

              <div className="memory-node-pane-heading">
                <span>
                  <strong>{branchTitle(branchFilter)}</strong>
                  <small>{selectedBranch?.whenToUse ?? branchDescription(branchFilter)}</small>
                </span>
                <output>{filteredNodes.length}</output>
              </div>

              {branchFilter === 'project' && matchingProjects.length > 0 && (
                <div className="memory-runtime-projects">
                  <div className="memory-runtime-projects-label">运行时项目来源</div>
                  {matchingProjects.map((project) => (
                    <div className="memory-runtime-project" key={project.id}>
                      <span>
                        <strong>{project.name}</strong>
                        <small>{compactPath(project.path)}</small>
                      </span>
                      <time dateTime={project.lastActiveAt}>{formatDateTime(project.lastActiveAt)}</time>
                    </div>
                  ))}
                </div>
              )}

              <div className="memory-node-list">
                {filteredNodes.map((node) => (
                  <MemoryNodeRow
                    key={node.id}
                    node={node}
                    expanded={expandedNodeId === node.id}
                    busy={managingNodeId === node.id}
                    onToggle={() => setExpandedNodeId((current) => current === node.id ? null : node.id)}
                    onAction={(action) => requestAction(node, action)}
                  />
                ))}
                {filteredNodes.length === 0 && (
                  <div className="memory-tree-empty-row">
                    {query ? '没有匹配的记忆。' : branchFilter === 'archive' ? '归档中没有记忆。' : '这个分支还没有索引记忆。'}
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      )}

      {confirmation && (
        <div className={`memory-confirmation-layer ${confirmationVisible ? 'visible' : ''}`}>
          <button className="memory-confirmation-scrim" type="button" onClick={closeConfirmation} aria-label="关闭确认窗口" />
          <div className="memory-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-confirmation-title">
            <h3 id="memory-confirmation-title">
              {confirmation.action === 'delete' ? '删除这条记忆？' : '提升为 T1 记忆？'}
            </h3>
            <p>
              {confirmation.action === 'delete'
                ? '删除后它不会再进入上下文，并从记忆列表移除；审计记录仍会保留。'
                : 'T1 具有最高介入优先级，可能更频繁地进入后续上下文。'}
            </p>
            <blockquote>{confirmation.node.summary}</blockquote>
            <div className="memory-confirmation-actions">
              <button type="button" onClick={closeConfirmation} autoFocus>取消</button>
              <button
                className={confirmation.action === 'delete' ? 'danger' : 'primary'}
                type="button"
                disabled={managingNodeId === confirmation.node.id}
                onClick={() => void executeAction(confirmation.node, confirmation.action)}
              >
                {managingNodeId === confirmation.node.id
                  ? '处理中'
                  : confirmation.action === 'delete' ? '确认删除' : '确认提升'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MemoryTreeStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="memory-tree-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function MemoryBranchButton({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button className={`memory-branch-button ${active ? 'active' : ''}`} type="button" onClick={onClick}>
      <span className="memory-branch-dot" aria-hidden="true" />
      <strong>{label}</strong>
      <small>{count}</small>
    </button>
  )
}

function MemoryNodeRow({
  node,
  expanded,
  busy,
  onToggle,
  onAction,
}: {
  node: MemoryTreeNodeOverview
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onAction: (action: MemoryTreeManagementAction) => void
}) {
  const highestTier = node.branch === 'daily' ? 2 : 1
  const histories = [
    ...node.writeHistory.map((record) => ({
      id: record.id,
      at: record.at,
      title: writeDecisionLabel(record.decision),
      detail: record.reason,
    })),
    ...node.managementHistory.map((record) => ({
      id: record.id,
      at: record.at,
      title: managementActionLabel(record.action),
      detail: record.reason,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 6)

  return (
    <article className={`memory-node-row ${expanded ? 'expanded' : ''} status-${node.status}`}>
      <button className="memory-node-summary" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className="memory-node-tier">T{node.tier}</span>
        <span className="memory-node-summary-copy">
          <strong>{node.summary}</strong>
          <small>
            {BRANCH_LABELS[node.branch]} · {scopeText(node)} · {node.status === 'archived' ? '已归档' : formatRelativeDate(node.updatedAt)}
          </small>
        </span>
        {node.hitCount > 0 && <span className="memory-node-hit-count">命中 {node.hitCount}</span>}
        <span className="memory-node-chevron" aria-hidden="true" />
      </button>

      <div className="memory-node-details" aria-hidden={!expanded}>
        <div className="memory-node-details-inner">
          <div className="memory-node-content"><Markdown text={node.content} /></div>

          <dl className="memory-node-metadata">
            <div><dt>写入理由</dt><dd>{node.reason}</dd></div>
            <div><dt>作用范围</dt><dd>{scopeText(node)}{node.scopeKey ? ` · ${compactPath(node.scopeKey)}` : ''}</dd></div>
            <div><dt>来源</dt><dd>{sourceText(node)}</dd></div>
            <div><dt>可靠度</dt><dd>{Math.round(node.confidence * 100)}% 置信 · {Math.round(node.importance * 100)}% 重要</dd></div>
          </dl>

          {node.retrievalKeys.length > 0 && (
            <div className="memory-node-keys">
              {node.retrievalKeys.map((key) => <span key={key}>{key}</span>)}
            </div>
          )}

          <section className="memory-node-subsection">
            <strong>近期命中</strong>
            {node.recentHits.length > 0 ? (
              <div className="memory-hit-list">
                {node.recentHits.map((hit) => (
                  <div key={`${hit.runId}:${hit.at}`}>
                    <span>{hit.action === 'deep_search' ? '分支深搜' : '索引展开'}{hit.query ? ` · ${hit.query}` : ''}</span>
                    <time dateTime={hit.at}>{formatDateTime(hit.at)}</time>
                  </div>
                ))}
              </div>
            ) : (
              <p>本次应用运行期间暂无命中。</p>
            )}
          </section>

          <section className="memory-node-subsection">
            <strong>变更记录</strong>
            {histories.length > 0 ? (
              <div className="memory-history-list">
                {histories.map((record) => (
                  <div key={record.id}>
                    <span><b>{record.title}</b>{record.detail}</span>
                    <time dateTime={record.at}>{formatDateTime(record.at)}</time>
                  </div>
                ))}
              </div>
            ) : (
              <p>暂无变更记录。</p>
            )}
          </section>

          <div className="memory-node-actions">
            {node.status === 'active' ? (
              <>
                <button type="button" disabled={busy || node.tier <= highestTier} onClick={() => onAction('promote')}>提升</button>
                <button type="button" disabled={busy || node.tier >= 3} onClick={() => onAction('demote')}>降级</button>
                <button type="button" disabled={busy} onClick={() => onAction('archive')}>归档</button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => onAction('restore')}>恢复</button>
            )}
            <button className="danger" type="button" disabled={busy} onClick={() => onAction('delete')}>删除</button>
          </div>
        </div>
      </div>
    </article>
  )
}

function branchTitle(filter: MemoryBranchFilter): string {
  if (filter === 'all') return '全部记忆'
  if (filter === 'archive') return '归档记忆'
  return BRANCH_LABELS[filter]
}

function branchDescription(filter: MemoryBranchFilter): string {
  if (filter === 'archive') return '已暂停运行时介入、仍可恢复的记忆。'
  return '沿索引查看内容、来源、作用范围和近期命中。'
}

function scopeText(node: MemoryTreeNodeOverview): string {
  if (node.project) return `项目：${node.project.name}`
  return SCOPE_LABELS[node.scope]
}

function sourceText(node: MemoryTreeNodeOverview): string {
  if (node.sourceRefs.length > 0) return node.sourceRefs.map(compactPath).join(' · ')
  const stages = node.sourceStages.map((stage) => ({
    evolve: '任务复盘',
    capture: '每日捕获',
    tool: '记忆工具',
    migration: '旧数据迁移',
  })[stage])
  const runs = node.sourceRunIds.slice(-2).map((runId) => `run ${runId.slice(0, 8)}`)
  return [...new Set([...stages, ...runs])].join(' · ') || '运行时记忆树'
}

function writeDecisionLabel(decision: string): string {
  return ({
    created: '自动写入',
    merged: '自动合并',
    reinforced: '来源强化',
    rejected: '拒绝写入',
    queued: '等待恢复',
  } as Record<string, string>)[decision] ?? decision
}

function managementActionLabel(action: MemoryTreeManagementAction): string {
  return ({
    archive: '归档',
    restore: '恢复',
    delete: '删除',
    promote: '提升',
    demote: '降级',
  } as Record<MemoryTreeManagementAction, string>)[action]
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return path
  return `${parts[0]}\\...\\${parts.slice(-2).join('\\')}`
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatRelativeDate(value: string): string {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return value
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (elapsed < hour) return `${Math.max(1, Math.floor(elapsed / minute))}分`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}小时`
  return `${Math.floor(elapsed / day)}天`
}
