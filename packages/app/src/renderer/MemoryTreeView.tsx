// Memory tree control surface for the authoritative runtime index and resources.
// The view never creates a renderer-only copy of memory data.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getMemoryTreeOverview,
  getMemoryTreeNodeDetail,
  manageMemoryTreeResource,
  manageMemoryTreeNode,
  updateProjectMemoryProjection,
  updateMemoryLearningPolicy,
  type MemoryTreeBranchId,
  type MemoryTreeManagementAction,
  type MemoryResourceManagementAction,
  type MemoryTreeNodeOverview,
  type MemoryTreeNodeDetail,
  type MemoryTreeOverview,
  type MemoryTreeProjectOverview,
  type ProjectMemoryProjectionState,
} from './api'
import { resourceKindLabel } from './memory-resource-labels'
import { compactPath, formatDateTime, formatRelativeDate } from './memory-tree/format'
import { boundedNodeDetailCache } from './memory-tree/detail-cache'
import { MemoryMigrationPanel } from './memory-tree/migration-panel'
import { MemoryNodeRow } from './memory-tree/node-row'
import { useMemoryAtomActions } from './memory-tree/use-memory-atom-actions'
import { useMemoryMigration } from './memory-tree/use-memory-migration'

type MemoryBranchFilter = 'all' | MemoryTreeBranchId | 'resources' | 'archive' | 'migration'
type MemoryTreeResourceOverview = MemoryTreeOverview['resources'][number]
type ConfirmationRequest =
  | {
      kind: 'node'
      node: MemoryTreeNodeOverview
      action: Extract<MemoryTreeManagementAction, 'delete' | 'promote'>
    }
  | {
      kind: 'project'
      project: MemoryTreeProjectOverview
      action: 'force-sync' | 'remove'
    }
  | {
      kind: 'resource'
      resource: MemoryTreeResourceOverview
      action: 'remove' | 'disable'
    }
  | { kind: 'migration'; action: 'migrate' | 'rollback' }
type ProjectProjectionAction = 'enable' | 'sync' | 'force-sync' | 'export' | 'disable' | 'remove'

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

const RESOURCE_SCOPE_LABELS: Record<MemoryTreeResourceOverview['scope'], string> = {
  ...SCOPE_LABELS,
  run: '单次运行',
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
  const [nodeDetails, setNodeDetails] = useState<Record<string, MemoryTreeNodeDetail>>({})
  const [loadingNodeDetails, setLoadingNodeDetails] = useState<Set<string>>(() => new Set())
  const [expandedResourceId, setExpandedResourceId] = useState<string | null>(null)
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null)
  const [managingNodeId, setManagingNodeId] = useState<string | null>(null)
  const [managingProjectId, setManagingProjectId] = useState<string | null>(null)
  const [managingResourceId, setManagingResourceId] = useState<string | null>(null)
  const [projectNotice, setProjectNotice] = useState<{ projectId: string; message: string } | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
  const [confirmationVisible, setConfirmationVisible] = useState(false)
  const confirmationTimerRef = useRef(0)
  const confirmationFrameRef = useRef(0)
  const projectNoticeTimerRef = useRef(0)
  const loadRequestRef = useRef(0)
  const nodeDetailRequestsRef = useRef(new Map<string, AbortController>())
  const mountedRef = useRef(true)
  const migration = useMemoryMigration({ active: branchFilter === 'migration', onRegistered: closeConfirmation })
  const atomActions = useMemoryAtomActions({
    overview,
    onReload: () => load(true),
    onError: setError,
  })

  async function load(silent = false, preserveProjectNotice = false) {
    const requestId = ++loadRequestRef.current
    if (!preserveProjectNotice) clearProjectNotice()
    if (silent) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const next = await getMemoryTreeOverview()
      if (!mountedRef.current || requestId !== loadRequestRef.current) return
      setOverview(next)
      setNodeDetails((current) => Object.fromEntries(
        Object.entries(current).filter(([nodeId]) => next.nodes.some((node) => node.id === nodeId)),
      ))
      setExpandedNodeId((current) => current && next.nodes.some((node) => node.id === current) ? current : null)
      setExpandedResourceId((current) => current && next.resources.some((resource) => resource.id === current) ? current : null)
      setExpandedProjectId((current) => current && next.projects.some((project) => project.id === current) ? current : null)
    } catch (err) {
      if (!mountedRef.current || requestId !== loadRequestRef.current) return
      setError((err as Error).message)
      if (!silent) setOverview(null)
    } finally {
      if (!mountedRef.current || requestId !== loadRequestRef.current) return
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadRequestRef.current += 1
      window.clearTimeout(confirmationTimerRef.current)
      window.clearTimeout(projectNoticeTimerRef.current)
      window.cancelAnimationFrame(confirmationFrameRef.current)
      for (const controller of nodeDetailRequestsRef.current.values()) controller.abort()
      nodeDetailRequestsRef.current.clear()
    }
  }, [])

  async function loadNodeDetail(nodeId: string, disclosureLevel: 'D2' | 'D3') {
    const cached = nodeDetails[nodeId]
    if (cached && (cached.disclosureLevel === 'D3' || cached.disclosureLevel === disclosureLevel)) return
    nodeDetailRequestsRef.current.get(nodeId)?.abort()
    const controller = new AbortController()
    nodeDetailRequestsRef.current.set(nodeId, controller)
    setLoadingNodeDetails((current) => new Set(current).add(nodeId))
    try {
      const detail = await getMemoryTreeNodeDetail(nodeId, disclosureLevel, controller.signal)
      if (!mountedRef.current || controller.signal.aborted) return
      setNodeDetails((current) => boundedNodeDetailCache(current, detail))
    } catch (err) {
      if (!controller.signal.aborted && mountedRef.current) setError((err as Error).message)
    } finally {
      if (nodeDetailRequestsRef.current.get(nodeId) === controller) nodeDetailRequestsRef.current.delete(nodeId)
      if (mountedRef.current) {
        setLoadingNodeDetails((current) => {
          const next = new Set(current)
          next.delete(nodeId)
          return next
        })
      }
    }
  }

  useEffect(() => {
    if (overview) setExperienceThreshold(overview.learningPolicy.experienceWriteThreshold)
  }, [overview?.learningPolicy.experienceWriteThreshold])

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
      if (!mountedRef.current) return
      setOverview((current) => current ? {
        ...current,
        learningPolicy: { experienceWriteThreshold: saved.experienceWriteThreshold },
      } : current)
    } catch (err) {
      if (!mountedRef.current) return
      setError((err as Error).message)
    } finally {
      if (mountedRef.current) setSavingPolicy(false)
    }
  }

  function openConfirmation(request: ConfirmationRequest) {
    window.clearTimeout(confirmationTimerRef.current)
    window.cancelAnimationFrame(confirmationFrameRef.current)
    setConfirmation(request)
    setConfirmationVisible(false)
    confirmationFrameRef.current = window.requestAnimationFrame(() => {
      confirmationFrameRef.current = window.requestAnimationFrame(() => {
        if (mountedRef.current) setConfirmationVisible(true)
      })
    })
  }

  function closeConfirmation() {
    setConfirmationVisible(false)
    window.clearTimeout(confirmationTimerRef.current)
    confirmationTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setConfirmation(null)
    }, 220)
  }

  function clearProjectNotice() {
    window.clearTimeout(projectNoticeTimerRef.current)
    projectNoticeTimerRef.current = 0
    setProjectNotice(null)
  }

  function showProjectNotice(projectId: string, message: string) {
    window.clearTimeout(projectNoticeTimerRef.current)
    setProjectNotice({ projectId, message })
    projectNoticeTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setProjectNotice(null)
    }, 4_000)
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
      if (!mountedRef.current) return
      setError((err as Error).message)
    } finally {
      if (mountedRef.current) setManagingNodeId(null)
    }
  }

  function requestAction(node: MemoryTreeNodeOverview, action: MemoryTreeManagementAction) {
    if (action === 'delete' || (action === 'promote' && node.tier === 2)) {
      openConfirmation({ kind: 'node', node, action })
      return
    }
    void executeAction(node, action)
  }

  async function executeProjectAction(project: MemoryTreeProjectOverview, action: ProjectProjectionAction) {
    setManagingProjectId(project.id)
    clearProjectNotice()
    setError(null)
    try {
      const request = action === 'enable'
        ? { action: 'enable' as const }
        : action === 'sync'
          ? { action: 'sync' as const }
          : action === 'force-sync'
            ? { action: 'sync' as const, force: true }
            : action === 'export'
              ? { action: 'export' as const }
              : action === 'remove'
                ? { action: 'disable' as const, removeProjection: true }
                : { action: 'disable' as const }
      const result = await updateProjectMemoryProjection(project.id, request)
      if (!mountedRef.current) return
      if ('cancelled' in result) {
        if (!result.cancelled && result.export) {
          showProjectNotice(
            project.id,
            `已导出 ${result.export.entryCount} 条共享记忆到 ${compactPath(result.export.outputPath)}`,
          )
        }
        return
      }
      setOverview((current) => current ? {
        ...current,
        projects: current.projects.map((entry) => entry.id === project.id
          ? { ...entry, projection: result }
          : entry),
      } : current)
      showProjectNotice(project.id, projectActionNotice(action, result))
      closeConfirmation()
      await load(true, true)
    } catch (err) {
      if (!mountedRef.current) return
      setError((err as Error).message)
    } finally {
      if (mountedRef.current) setManagingProjectId(null)
    }
  }

  function requestProjectAction(project: MemoryTreeProjectOverview, action: ProjectProjectionAction) {
    if (action === 'force-sync' || action === 'remove') {
      openConfirmation({ kind: 'project', project, action })
      return
    }
    void executeProjectAction(project, action)
  }

  async function executeResourceAction(
    resource: MemoryTreeResourceOverview,
    action: MemoryResourceManagementAction,
  ) {
    setManagingResourceId(resource.id)
    setError(null)
    try {
      const result = await manageMemoryTreeResource(resource.id, action)
      if (!mountedRef.current || result.cancelled) return
      closeConfirmation()
      if (action === 'remove') setExpandedResourceId(null)
      await load(true)
    } catch (err) {
      if (!mountedRef.current) return
      setError((err as Error).message)
    } finally {
      if (mountedRef.current) setManagingResourceId(null)
    }
  }

  function requestResourceAction(
    resource: MemoryTreeResourceOverview,
    action: MemoryResourceManagementAction,
  ) {
    if (action === 'remove' || (action === 'disable' && resource.tier === 0)) {
      openConfirmation({ kind: 'resource', resource, action })
      return
    }
    void executeResourceAction(resource, action)
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
        node.reason,
        node.scopeKey ?? '',
        node.project?.name ?? '',
        ...node.retrievalKeys,
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

  const filteredResources = useMemo(() => {
    if (!overview || branchFilter !== 'resources') return []
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return overview.resources
    return overview.resources.filter((resource) => [
      resource.title,
      resource.description,
      resource.kind,
      resource.scopeKey ?? '',
      resource.sourcePath ?? '',
      resource.registryGroup,
      ...resource.indexKeys,
    ].some((value) => value.toLocaleLowerCase().includes(needle)))
  }, [branchFilter, overview, query])

  const activeNodeCount = overview?.nodes.filter((node) => node.status === 'active').length ?? 0
  const selectedBranch = branchFilter !== 'all' && branchFilter !== 'archive'
    && branchFilter !== 'resources' && branchFilter !== 'migration'
    ? overview?.branches.find((branch) => branch.id === branchFilter)
    : null
  const visibleContentCount = branchFilter === 'resources'
    ? filteredResources.length
    : branchFilter === 'migration'
      ? 1
    : filteredNodes.length + (branchFilter === 'project' ? matchingProjects.length : 0)
  const confirmationCopy = confirmation ? describeConfirmation(confirmation) : null
  const confirmationBusy = confirmation?.kind === 'node'
    ? managingNodeId === confirmation.node.id
    : confirmation?.kind === 'project'
      ? managingProjectId === confirmation.project.id
      : confirmation?.kind === 'resource'
        ? managingResourceId === confirmation.resource.id
        : confirmation?.kind === 'migration'
          ? migration.busyAction === confirmation.action
          : false

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

      {(error || migration.error) && <div className="dialog-error">记忆树操作失败：{error ?? migration.error}</div>}
      {loading && !overview && <div className="memory-tree-loading">正在读取运行时记忆索引...</div>}

      {overview && (
        <>
          <section className="memory-tree-summary" aria-label="记忆树概况">
            <MemoryTreeStat label="运行中" value={String(activeNodeCount)} />
            <MemoryTreeStat label="已归档" value={String(overview.totals.archivedMemories)} />
            <MemoryTreeStat label="近期命中" value={String(overview.recentAccesses.length)} />
            <MemoryTreeStat label="项目" value={String(overview.totals.projects)} />
            <MemoryTreeStat label="存储" value={overview.repository.backendKind.toUpperCase()} />
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
              <MemoryBranchButton
                active={branchFilter === 'resources'}
                label="资源目录"
                count={overview.totals.activeResources}
                onClick={() => setBranchFilter('resources')}
              />
              <div className="memory-branch-divider" />
              <MemoryBranchButton
                active={branchFilter === 'archive'}
                label="归档记忆"
                count={overview.totals.archivedMemories}
                onClick={() => setBranchFilter('archive')}
              />
              <MemoryBranchButton
                active={branchFilter === 'migration'}
                label="迁移与目录"
                count={overview.repository.backendKind === 'v3' ? 1 : 0}
                onClick={() => setBranchFilter('migration')}
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
                <output>{visibleContentCount}</output>
              </div>

              {branchFilter === 'project' && matchingProjects.length > 0 && (
                <div className="memory-runtime-projects">
                  <div className="memory-runtime-projects-label">运行时项目来源</div>
                  {matchingProjects.map((project) => (
                    <ProjectMemoryRow
                      key={project.id}
                      project={project}
                      expanded={expandedProjectId === project.id}
                      busy={managingProjectId === project.id}
                      notice={projectNotice?.projectId === project.id ? projectNotice.message : undefined}
                      onToggle={() => setExpandedProjectId((current) => current === project.id ? null : project.id)}
                      onAction={(action) => requestProjectAction(project, action)}
                    />
                  ))}
                </div>
              )}

              {branchFilter === 'migration' ? (
                <MemoryMigrationPanel
                  repository={overview.repository}
                  preflight={migration.preflight}
                  loading={migration.loading}
                  busyAction={migration.busyAction}
                  onRefresh={() => void migration.refresh()}
                  onRequestMigration={() => openConfirmation({ kind: 'migration', action: 'migrate' })}
                  onRequestRollback={() => openConfirmation({ kind: 'migration', action: 'rollback' })}
                  onCancel={() => void migration.cancel()}
                  onRestart={() => void migration.restart()}
                />
              ) : (
              <div className="memory-node-list">
                {branchFilter === 'resources'
                  ? filteredResources.map((resource) => (
                      <MemoryResourceRow
                        key={resource.id}
                        resource={resource}
                        expanded={expandedResourceId === resource.id}
                        busy={managingResourceId === resource.id}
                        onToggle={() => setExpandedResourceId((current) => current === resource.id ? null : resource.id)}
                        onAction={(action) => requestResourceAction(resource, action)}
                      />
                    ))
                  : filteredNodes.map((node) => (
                      <MemoryNodeRow
                        key={node.id}
                        node={node}
                        detail={nodeDetails[node.id]}
                        detailLoading={loadingNodeDetails.has(node.id)}
                        expanded={expandedNodeId === node.id}
                        busy={managingNodeId === node.id || atomActions.busyNodeId === node.id}
                        onToggle={() => {
                          const opening = expandedNodeId !== node.id
                          setExpandedNodeId(opening ? node.id : null)
                          if (opening) void loadNodeDetail(node.id, 'D2')
                        }}
                        onRequestEvidence={() => void loadNodeDetail(node.id, 'D3')}
                        onAction={(action) => requestAction(node, action)}
                        atomManagementEnabled={overview.repository.backendKind === 'v3' && Boolean(node.atomRevision)}
                        onAtomAction={(action) => atomActions.open(node, action)}
                        onExportAtom={() => void atomActions.exportAtom(node)}
                      />
                    ))}
                {visibleContentCount === 0 && (
                    <div className="memory-tree-empty-row">
                      {query
                        ? '没有匹配的内容。'
                        : branchFilter === 'archive'
                          ? '归档中没有记忆。'
                          : branchFilter === 'resources'
                            ? '还没有注册资源。'
                            : '这个分支还没有索引记忆。'}
                    </div>
                  )}
              </div>
              )}
            </section>
          </div>
        </>
      )}

      {atomActions.dialog}

      {confirmation && confirmationCopy && (
        <div className={`memory-confirmation-layer ${confirmationVisible ? 'visible' : ''}`}>
          <button className="memory-confirmation-scrim" type="button" onClick={closeConfirmation} aria-label="关闭确认窗口" />
          <div className="memory-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="memory-confirmation-title">
            <h3 id="memory-confirmation-title">
              {confirmationCopy.title}
            </h3>
            <p>{confirmationCopy.description}</p>
            <blockquote>{confirmationCopy.subject}</blockquote>
            <div className="memory-confirmation-actions">
              <button type="button" onClick={closeConfirmation} autoFocus>取消</button>
              <button
                className={confirmationCopy.danger ? 'danger' : 'primary'}
                type="button"
                disabled={confirmationBusy}
                onClick={() => {
                  if (confirmation.kind === 'node') void executeAction(confirmation.node, confirmation.action)
                  else if (confirmation.kind === 'project') void executeProjectAction(confirmation.project, confirmation.action)
                  else if (confirmation.kind === 'resource') void executeResourceAction(confirmation.resource, confirmation.action)
                  else void migration.request(confirmation.action)
                }}
              >
                {confirmationBusy ? '处理中' : confirmationCopy.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ProjectMemoryRow({
  project,
  expanded,
  busy,
  notice,
  onToggle,
  onAction,
}: {
  project: MemoryTreeProjectOverview
  expanded: boolean
  busy: boolean
  notice?: string
  onToggle: () => void
  onAction: (action: ProjectProjectionAction) => void
}) {
  const state = project.projection
  const status = state?.status ?? 'disabled'
  const privacyWarning = !!state?.projectionExists && !!state.gitRepository && !state.gitIgnored
  return (
    <article className={`memory-runtime-project status-${status} ${expanded ? 'expanded' : ''}`}>
      <button className="memory-runtime-project-summary" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className="memory-runtime-project-copy">
          <strong>{project.name}</strong>
          <small>{compactPath(project.path)}</small>
        </span>
        <span className={`memory-project-status status-${status}`}>{projectionStatusLabel(status)}</span>
        <time dateTime={project.lastActiveAt}>{formatRelativeDate(project.lastActiveAt)}</time>
        <span className="memory-node-chevron" aria-hidden="true" />
      </button>

      <div className="memory-project-details" aria-hidden={!expanded}>
        <div className="memory-project-details-inner">
          <p className="memory-project-explanation">
            权威项目记忆保存在 LS 用户数据中。项目内文件只是经过白名单过滤的私有投影，不会反向覆盖权威记忆。
          </p>
          <dl className="memory-project-metadata">
            <div><dt>当前状态</dt><dd>{projectionStatusLabel(status)}</dd></div>
            <div><dt>投影内容</dt><dd>{state?.entryCount ?? 0} 条{state?.omittedEntryCount ? ` · 过滤 ${state.omittedEntryCount} 条` : ''}</dd></div>
            <div><dt>上次同步</dt><dd>{state?.lastSyncedAt ? formatDateTime(state.lastSyncedAt) : '尚未同步'}</dd></div>
            <div><dt>投影位置</dt><dd title={state?.projectionPath}>{state?.projectionExists ? compactPath(state.projectionPath) : '尚未创建'}</dd></div>
          </dl>

          {state?.status === 'conflict' && (
            <p className="memory-project-callout conflict">{projectionConflictText(state.conflictReason)}</p>
          )}
          {state?.status === 'missing' && (
            <p className="memory-project-callout">投影文件已缺失，权威记忆仍然完整；重新同步即可恢复。</p>
          )}
          {privacyWarning && (
            <p className="memory-project-callout privacy">
              该项目是 Git 仓库，但尚未忽略 {state?.gitIgnorePattern}。LS 不会自动修改 `.gitignore`，提交前请检查私有投影。
            </p>
          )}
          {notice && <p className="memory-project-notice" role="status">{notice}</p>}

          <div className="memory-project-actions">
            {!state?.enabled ? (
              <button type="button" disabled={busy} onClick={() => onAction('enable')}>启用私有投影</button>
            ) : (
              <>
                {status === 'conflict' ? (
                  <button type="button" disabled={busy} onClick={() => onAction('force-sync')}>覆盖并同步</button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => onAction('sync')}>
                    {status === 'missing' ? '重新生成' : status === 'stale' ? '同步更新' : '重新同步'}
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => onAction('export')}>导出共享快照</button>
                <button type="button" disabled={busy} onClick={() => onAction('disable')}>停用</button>
              </>
            )}
            {state?.projectionExists && (
              <button
                className="danger"
                type="button"
                disabled={busy || !state.safeToRemove}
                title={state.safeToRemove ? '停用投影并移除 LS 生成的项目内文件' : '文件已被外部修改，LS 不会删除它'}
                onClick={() => onAction('remove')}
              >
                停用并移除文件
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

function projectionStatusLabel(status: ProjectMemoryProjectionState['status']): string {
  return ({
    disabled: '未启用',
    missing: '文件缺失',
    ready: '已同步',
    stale: '有更新',
    conflict: '发生冲突',
  })[status]
}

function projectionConflictText(reason?: string): string {
  if (reason?.includes('not registered')) {
    return '项目中已有同名文件，但它不是 LS 已登记的投影。覆盖前请确认该文件可以被替换。'
  }
  return '项目内投影文件在上次同步后发生了外部变化。LS 已停止自动覆盖，请确认后再同步。'
}

function projectActionNotice(action: ProjectProjectionAction, state: ProjectMemoryProjectionState): string {
  if (action === 'enable') return state.status === 'conflict' ? projectionConflictText(state.conflictReason) : '私有投影已启用。'
  if (action === 'disable') return '私有投影已停用，项目内文件仍被保留。'
  if (action === 'remove') return '私有投影已停用，LS 生成的项目内文件已移除。'
  return `私有投影已同步，共 ${state.entryCount ?? 0} 条记忆。`
}

function describeConfirmation(request: ConfirmationRequest): {
  title: string
  description: string
  subject: string
  confirmLabel: string
  danger: boolean
} {
  if (request.kind === 'migration') {
    return request.action === 'migrate'
      ? {
          title: '登记 Memory v3 迁移？',
          description: '当前运行不会修改记忆数据。重启后，LS 会在 Runner、外部渠道、SQLite 和 Embedding 初始化前完成快照、构建与校验；失败时继续使用 V2。',
          subject: 'Memory V2 -> V3',
          confirmLabel: '确认登记',
          danger: false,
        }
      : {
          title: '登记 Memory v3 回滚？',
          description: '当前运行不会切换版本。重启后，LS 只有在 V2 源和 V3 数据均未变化时才回到 V2；任何可能丢失新记忆的情况都会拒绝回滚。',
          subject: 'Memory V3 -> V2',
          confirmLabel: '确认登记',
          danger: true,
        }
  }
  if (request.kind === 'node') {
    return request.action === 'delete'
      ? {
          title: '删除这条记忆？',
          description: '删除后它不会再进入上下文，并从记忆列表移除；审计记录仍会保留。',
          subject: request.node.summary,
          confirmLabel: '确认删除',
          danger: true,
        }
      : {
          title: '提升为 T1 记忆？',
          description: 'T1 具有最高介入优先级，可能更频繁地进入后续上下文。',
          subject: request.node.summary,
          confirmLabel: '确认提升',
          danger: false,
        }
  }
  if (request.kind === 'resource') {
    return request.action === 'remove'
      ? {
          title: '移除这项资源登记？',
          description: '只会清理 LS 的索引登记和后续上下文介入，不会删除来源文件。再次扫描到同一来源时，它可以重新登记。',
          subject: request.resource.title,
          confirmLabel: '移除登记',
          danger: true,
        }
      : {
          title: '停用这项核心资源？',
          description: '它将停止进入 T0 根索引和后续上下文。来源文件不会删除，之后仍可从资源目录恢复。',
          subject: request.resource.title,
          confirmLabel: '确认停用',
          danger: false,
        }
  }
  if (request.action === 'remove') {
    return {
      title: '停用并移除私有投影？',
      description: '只会删除经过哈希确认、由 LS 最后写入的项目内投影。用户数据中的权威项目记忆不会删除；文件若已被外部修改，LS 会拒绝操作。',
      subject: request.project.name,
      confirmLabel: '停用并移除',
      danger: true,
    }
  }
  return {
    title: '覆盖项目内投影？',
    description: '当前文件与 LS 上次写入的内容不一致。继续会用最新的白名单项目记忆覆盖该文件，但不会修改用户数据中的权威记忆。',
    subject: request.project.name,
    confirmLabel: '确认覆盖并同步',
    danger: false,
  }
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

function MemoryResourceRow({
  resource,
  expanded,
  busy,
  onToggle,
  onAction,
}: {
  resource: MemoryTreeResourceOverview
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onAction: (action: MemoryResourceManagementAction) => void
}) {
  const automaticallyManaged = resource.scope === 'run'
    || resource.kind === 'project-memory-projection'
    || resource.kind === 'workspace-index'
    || resource.owner !== undefined
  const canRelocate = resource.sourceKind === 'file'
    && resource.scope === 'workspace'
    && resource.registryGroup.startsWith('workspace-docs:')
    && resource.status !== 'active'
  const histories = resource.managementHistory.slice(0, 6)
  return (
    <article className={`memory-node-row ${expanded ? 'expanded' : ''} status-${resource.status}`}>
      <button className="memory-node-summary" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className="memory-node-tier">T{resource.tier}</span>
        <span className="memory-node-summary-copy">
          <strong>{resource.title}</strong>
          <small>
            {resourceKindLabel(resource.kind)} · {resource.status === 'active' ? '已注册' : resourceStatusLabel(resource.status)} · {formatRelativeDate(resource.updatedAt)}
          </small>
        </span>
        <span className="memory-node-hit-count">{resourceAuthorityShortLabel(resource.authority)}</span>
        <span className="memory-node-chevron" aria-hidden="true" />
      </button>

      <div className="memory-node-details" aria-hidden={!expanded}>
        <div className="memory-node-details-inner">
          <p className="memory-resource-description">{resource.description}</p>
          <dl className="memory-node-metadata">
            <div><dt>来源</dt><dd>{resource.sourcePath ? compactPath(resource.sourcePath) : resource.sourceKind}</dd></div>
            <div><dt>权威</dt><dd>{resourceAuthorityLabel(resource.authority)}</dd></div>
            <div><dt>隐私</dt><dd>{resourcePrivacyLabel(resource.privacy)}</dd></div>
            <div><dt>作用范围</dt><dd>{RESOURCE_SCOPE_LABELS[resource.scope]}{resource.scopeKey ? ` · ${compactPath(resource.scopeKey)}` : ''}</dd></div>
            <div><dt>注册组</dt><dd>{resource.registryGroup}</dd></div>
            {resource.owner && (
              <div><dt>生命周期所有者</dt><dd>{resourceOwnerLabel(resource.owner)}</dd></div>
            )}
            <div><dt>更新时间</dt><dd>{formatDateTime(resource.updatedAt)}</dd></div>
          </dl>
          {resource.indexKeys.length > 0 && (
            <div className="memory-node-keys">
              {resource.indexKeys.map((key) => <span key={key}>{key}</span>)}
            </div>
          )}
          <p className="memory-resource-note">资源目录只保存来源和索引信息；正文只有 Agent 沿资源分支显式展开时才读取。</p>
          <section className="memory-node-subsection">
            <strong>生命周期记录</strong>
            {histories.length > 0 ? (
              <div className="memory-history-list">
                {histories.map((record) => (
                  <div key={record.id}>
                    <span><b>{resourceManagementActionLabel(record.action)}</b>{record.reason}</span>
                    <time dateTime={record.at}>{formatDateTime(record.at)}</time>
                  </div>
                ))}
              </div>
            ) : (
              <p>暂无管理操作记录。</p>
            )}
          </section>
          {automaticallyManaged ? (
            <p className="memory-resource-note">
              {resource.scope === 'run'
                ? '这项资源随当前 run 自动登记和清理。'
                : resource.kind === 'project-memory-projection'
                  ? '这项资源由项目记忆投影控制面统一管理。'
                  : resource.kind === 'workspace-index'
                    ? '这项索引由运行时按工作区边界和扫描预算自动维护；索引不包含文件正文。'
                  : resource.owner?.controller === 'plugin-host'
                    ? `这项 Skill 由插件“${resource.owner.id}”统一管理，请在插件页面更改状态。`
                    : '这项 Skill 由技能配置统一管理，请在技能页面更改状态。'}
            </p>
          ) : (
            <div className="memory-node-actions">
              {resource.status === 'active' ? (
                <button type="button" disabled={busy} onClick={() => onAction('disable')}>停用</button>
              ) : resource.status === 'disabled' ? (
                <button type="button" disabled={busy} onClick={() => onAction('restore')}>恢复</button>
              ) : (
                <button type="button" disabled={busy} onClick={() => onAction('restore')}>重新检查</button>
              )}
              {canRelocate && (
                <button type="button" disabled={busy} onClick={() => onAction('rebind')}>重新定位</button>
              )}
              {resource.status !== 'active' && (
                <button className="danger" type="button" disabled={busy} onClick={() => onAction('remove')}>移除登记</button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

function branchTitle(filter: MemoryBranchFilter): string {
  if (filter === 'all') return '全部记忆'
  if (filter === 'resources') return '资源目录'
  if (filter === 'archive') return '归档记忆'
  if (filter === 'migration') return '迁移与目录'
  return BRANCH_LABELS[filter]
}

function branchDescription(filter: MemoryBranchFilter): string {
  if (filter === 'resources') return '查看 Agent、用户、工具、技能和项目文档的权威来源与索引。'
  if (filter === 'archive') return '已暂停运行时介入、仍可恢复的记忆。'
  if (filter === 'migration') return '当前存储版本、目录健康与迁移前置检查。'
  return '沿索引查看内容、来源、作用范围和近期命中。'
}

function resourceStatusLabel(status: MemoryTreeResourceOverview['status']): string {
  return ({ active: '已注册', missing: '来源缺失', disabled: '已停用', conflict: '来源冲突' })[status]
}

function resourceAuthorityLabel(authority: MemoryTreeResourceOverview['authority']): string {
  return ({ authoritative: '权威来源', derived: '派生来源', compatibility: '兼容来源', external: '外部来源' })[authority]
}

function resourceAuthorityShortLabel(authority: MemoryTreeResourceOverview['authority']): string {
  return ({ authoritative: '权威', derived: '派生', compatibility: '兼容', external: '外部' })[authority]
}

function resourcePrivacyLabel(privacy: MemoryTreeResourceOverview['privacy']): string {
  return ({ private: '私有', 'project-private': '项目私有', shareable: '可共享', public: '公开' })[privacy]
}

function resourceManagementActionLabel(action: MemoryTreeResourceOverview['managementHistory'][number]['action']): string {
  return ({
    disable: '停用',
    restore: '恢复',
    'mark-missing': '来源缺失',
    'mark-conflict': '发现冲突',
    remove: '移除登记',
    rebind: '重新定位',
  })[action]
}

function resourceOwnerLabel(owner: NonNullable<MemoryTreeResourceOverview['owner']>): string {
  const kind = ({
    builtin: '内置来源',
    user: '用户技能',
    external: '外部技能目录',
    plugin: '插件',
  } as const)[owner.kind]
  return `${kind} · ${owner.id}`
}
