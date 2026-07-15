// Extension workspace panels, files, terminal, artifacts, and view helpers.
import { useEffect, useMemo, useState } from 'react'
import {
  listWorkspaceArtifacts,
  listWorkspaceTerminalActivity,
  type TerminalActivityRecord,
  type WorkspaceArtifactRecord
} from '../api'
import { ChatMessage } from '../chat/types'
import { fileActionLabel } from '../composer/message-files'
import { FileGlyphIcon, SearchIcon } from '../ui/icons'
import {
  buildWorkspaceRecoverySnapshot,
  type WorkspaceFileDraftState,
  type WorkspaceOpenRequest,
  type WorkspacePanelTabId
} from '../workspace-persistence'
import { buildWorkspaceActivityFeed, collectWorkspaceArtifacts, mergeWorkspaceArtifacts, workspaceActivitySearchText, workspaceArtifactRecordToRef } from './activity'
import { compactPath, formatDateTime, isSamePath, lastPathSegment } from './path-utils'
import { WORKSPACE_ACTIVITY_FILTERS, WorkspaceActivityKindFilter } from './types'


export function WorkspaceOverview({
  workspacePath,
  workplacePath,
  activeTab,
  activeTabLabel,
  openTabs,
  openRequest,
  sessionId,
  sessionTitle,
  messages,
  artifactVersion,
  fileDrafts,
  onOpenFile,
}: {
  workspacePath: string
  workplacePath: string
  activeTab: WorkspacePanelTabId
  activeTabLabel: string
  openTabs: WorkspacePanelTabId[]
  openRequest: WorkspaceOpenRequest | null
  sessionId?: string
  sessionTitle?: string
  messages: ChatMessage[]
  artifactVersion: number
  fileDrafts: Record<string, WorkspaceFileDraftState>
  onOpenFile: (path: string) => void
}) {
  const [terminalActivities, setTerminalActivities] = useState<TerminalActivityRecord[]>([])
  const [terminalActivityError, setTerminalActivityError] = useState('')
  const [indexedArtifacts, setIndexedArtifacts] = useState<WorkspaceArtifactRecord[]>([])
  const [artifactError, setArtifactError] = useState('')
  const [activityKindFilter, setActivityKindFilter] = useState<WorkspaceActivityKindFilter>('all')
  const [activityQuery, setActivityQuery] = useState('')
  const messageArtifacts = useMemo(() => collectWorkspaceArtifacts(messages), [messages])
  const artifacts = useMemo(
    () => mergeWorkspaceArtifacts([
      ...indexedArtifacts.map(workspaceArtifactRecordToRef),
      ...messageArtifacts,
    ]),
    [indexedArtifacts, messageArtifacts],
  )
  const activityItems = useMemo(
    () => buildWorkspaceActivityFeed(messages, terminalActivities, indexedArtifacts),
    [indexedArtifacts, messages, terminalActivities],
  )
  const activityCounts = useMemo(() => {
    const counts: Record<WorkspaceActivityKindFilter, number> = {
      all: activityItems.length,
      agent: 0,
      artifact: 0,
      terminal: 0,
    }
    for (const item of activityItems) counts[item.kind] += 1
    return counts
  }, [activityItems])
  const filteredActivityItems = useMemo(() => {
    const query = activityQuery.trim().toLowerCase()
    return activityItems.filter((item) => {
      if (activityKindFilter !== 'all' && item.kind !== activityKindFilter) return false
      if (!query) return true
      return workspaceActivitySearchText(item).includes(query)
    })
  }, [activityItems, activityKindFilter, activityQuery])
  const recoverySnapshot = useMemo(
    () => buildWorkspaceRecoverySnapshot({
      activeTab,
      openTabs,
      openRequest,
      drafts: fileDrafts,
    }),
    [activeTab, fileDrafts, openRequest, openTabs],
  )
  const recoveryItems = [
    { label: '标签', value: `${openTabs.length}`, detail: recoverySnapshot.activeFileTab ? `当前文件 · ${lastPathSegment(recoverySnapshot.activeFileTab.path)}` : `当前 · ${activeTabLabel}` },
    { label: '文件', value: recoverySnapshot.openFileTabs.length > 0 ? `${recoverySnapshot.openFileTabs.length}` : '0', detail: recoverySnapshot.recentFilePath ? compactPath(recoverySnapshot.recentFilePath) : '暂无打开文件' },
    { label: '产物', value: `${artifacts.length}`, detail: artifactError || (artifacts.length > 0 ? '已从消息与索引合并' : '等待 agent 产出') },
    { label: '终端', value: `${terminalActivities.length}`, detail: terminalActivityError || (terminalActivities.length > 0 ? '已恢复最近命令' : '暂无命令记录') },
  ]

  useEffect(() => {
    let disposed = false
    setArtifactError('')
    listWorkspaceArtifacts(workspacePath, sessionId, 30)
      .then((records) => {
        if (!disposed) setIndexedArtifacts(records)
      })
      .catch((err) => {
        if (!disposed) {
          setIndexedArtifacts([])
          setArtifactError((err as Error).message)
        }
      })
    return () => {
      disposed = true
    }
  }, [artifactVersion, workspacePath, sessionId])

  useEffect(() => {
    let disposed = false
    setTerminalActivityError('')
    listWorkspaceTerminalActivity(workspacePath, sessionId, 8)
      .then((records) => {
        if (!disposed) setTerminalActivities(records)
      })
      .catch((err) => {
        if (!disposed) {
          setTerminalActivities([])
          setTerminalActivityError((err as Error).message)
        }
      })
    return () => {
      disposed = true
    }
  }, [workspacePath, sessionId])

  return (
    <div className="workspace-overview">
      <section className="workspace-overview-section">
        <div className="workspace-overview-label">当前工作区</div>
        <div className="workspace-overview-path">{compactPath(workspacePath)}</div>
        <small>{isSamePath(workspacePath, workplacePath) ? '未选择项目时使用 LS 默认 workplace。' : workspacePath}</small>
      </section>
      <section className="workspace-overview-section">
        <div className="workspace-overview-label">当前对话</div>
        <div className="workspace-overview-path">{sessionTitle ?? '新对话'}</div>
        <small>产物、命令和执行过程会按当前会话与工作区汇总到这里。</small>
      </section>
      <section className="workspace-overview-section">
        <div className="workspace-overview-section-head">
          <div className="workspace-overview-label">恢复状态</div>
          <small>{recoverySnapshot.dirtyDraftCount > 0 ? `${recoverySnapshot.dirtyDraftCount} 个未保存草稿` : '现场已同步'}</small>
        </div>
        <div className="workspace-recovery-grid" aria-label="工作现场恢复摘要">
          {recoveryItems.map((item) => (
            <div key={item.label} className="workspace-recovery-item">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </div>
          ))}
        </div>
      </section>
      <section className={`workspace-overview-section ${artifacts.length === 0 ? 'muted' : ''}`}>
        <div className="workspace-overview-label">阶段产物</div>
        {artifacts.length === 0 ? (
          <>
            <div className="workspace-overview-path">暂无文件产物</div>
            <small>{artifactError || 'agent 新建或修改文件后，会在这里沉淀入口。'}</small>
          </>
        ) : (
          <div className="workspace-overview-artifacts">
            {artifacts.map((artifact) => (
              <button
                key={`${artifact.action}:${artifact.path}`}
                className={`workspace-overview-artifact ${artifact.action}`}
                type="button"
                onClick={() => onOpenFile(artifact.path)}
              >
                <span className="workspace-overview-artifact-icon" aria-hidden="true">
                  <FileGlyphIcon />
                </span>
                <span className="workspace-overview-artifact-main">
                  <strong>{artifact.name}</strong>
                  <small>{fileActionLabel(artifact.action)} · {compactPath(artifact.path)}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className={`workspace-overview-section ${activityItems.length === 0 ? 'muted' : ''}`}>
        <div className="workspace-overview-section-head">
          <div className="workspace-overview-label">最近活动</div>
          <small>{filteredActivityItems.length > 0 ? `${filteredActivityItems.length}/${activityItems.length} 条` : ''}</small>
        </div>
        {activityItems.length === 0 ? (
          <>
            <div className="workspace-overview-path">暂无工作现场记录</div>
            <small>{terminalActivityError || '对话执行、文件产物和终端命令会在这里形成时间线。'}</small>
          </>
        ) : (
          <>
            <div className="workspace-activity-controls">
              <div className="workspace-activity-filter-group" role="group" aria-label="活动类型筛选">
                {WORKSPACE_ACTIVITY_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    className={`workspace-activity-filter ${activityKindFilter === filter.id ? 'active' : ''}`}
                    type="button"
                    disabled={activityCounts[filter.id] === 0}
                    aria-pressed={activityKindFilter === filter.id}
                    onClick={() => setActivityKindFilter(filter.id)}
                  >
                    <span>{filter.label}</span>
                    <small>{activityCounts[filter.id]}</small>
                  </button>
                ))}
              </div>
              <label className="workspace-activity-search">
                <SearchIcon />
                <input
                  value={activityQuery}
                  placeholder="筛选活动..."
                  spellCheck={false}
                  onChange={(event) => setActivityQuery(event.target.value)}
                />
              </label>
            </div>
            {filteredActivityItems.length === 0 ? (
              <div className="workspace-activity-empty">没有匹配的活动记录</div>
            ) : (
              <div className="workspace-activity-feed">
                {filteredActivityItems.map((item) => (
                  <button
                    key={item.id}
                    className={`workspace-activity-row ${item.kind}`}
                    type="button"
                    disabled={!item.artifact}
                    onClick={() => item.artifact ? onOpenFile(item.artifact.path) : undefined}
                  >
                    <span className="workspace-activity-glyph" aria-hidden="true" />
                    <span className="workspace-activity-main">
                      <span className="workspace-activity-title">{item.title}</span>
                      <small>{item.detail}</small>
                    </span>
                    <span className="workspace-activity-time">{formatDateTime(item.timestamp)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
