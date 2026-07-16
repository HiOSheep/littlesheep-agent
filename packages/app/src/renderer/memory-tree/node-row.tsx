import type {
  MemoryAtomManagementAction,
  MemoryTreeManagementAction,
  MemoryTreeNodeDetail,
  MemoryTreeNodeOverview,
} from '../api'
import { Markdown } from '../Markdown'
import { compactPath, formatDateTime, formatRelativeDate } from './format'
import { MemoryAtomActions } from './atom-actions'

const BRANCH_LABELS = {
  'long-term': '长期记忆',
  project: '项目记忆',
  daily: '每日流水',
  experience: '经验库',
} as const

const SCOPE_LABELS = {
  global: '全局',
  workspace: '工作区',
  project: '项目',
  session: '会话',
} as const

export function MemoryNodeRow({
  node,
  detail,
  detailLoading,
  expanded,
  busy,
  onToggle,
  onRequestEvidence,
  onAction,
  atomManagementEnabled,
  onAtomAction,
  onExportAtom,
}: {
  node: MemoryTreeNodeOverview
  detail?: MemoryTreeNodeDetail
  detailLoading: boolean
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onRequestEvidence: () => void
  onAction: (action: MemoryTreeManagementAction) => void
  atomManagementEnabled: boolean
  onAtomAction: (action: MemoryAtomManagementAction) => void
  onExportAtom: () => void
}) {
  const highestTier = node.branch === 'daily' ? 2 : 1
  const histories = detail ? [
    ...detail.writeHistory.map((record) => ({
      id: record.id,
      at: record.at,
      title: writeDecisionLabel(record.decision),
      detail: record.reason,
    })),
    ...detail.managementHistory.map((record) => ({
      id: record.id,
      at: record.at,
      title: managementActionLabel(record.action),
      detail: record.reason,
    })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 6) : []

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
          {detailLoading && !detail && <div className="memory-node-detail-loading">正在展开记忆...</div>}
          {detail && <div className="memory-node-content"><Markdown text={detail.content} /></div>}

          <dl className="memory-node-metadata">
            <div><dt>写入理由</dt><dd>{node.reason}</dd></div>
            <div><dt>作用范围</dt><dd>{scopeText(node)}{node.scopeKey ? ` · ${compactPath(node.scopeKey)}` : ''}</dd></div>
            <div><dt>来源</dt><dd>{detail ? sourceText(detail) : '按需读取中'}</dd></div>
            <div><dt>可靠度</dt><dd>{Math.round(node.confidence * 100)}% 置信 · {Math.round(node.importance * 100)}% 重要</dd></div>
          </dl>

          {(detail?.retrievalKeys ?? node.retrievalKeys).length > 0 && (
            <div className="memory-node-keys">
              {(detail?.retrievalKeys ?? node.retrievalKeys).map((key) => <span key={key}>{key}</span>)}
            </div>
          )}

          {detail?.v3 && <MemoryV3EvidenceSummary detail={detail} />}

          {detail?.disclosureLevel !== 'D3' && (
            <button
              className="memory-disclosure-button"
              type="button"
              disabled={detailLoading}
              onClick={onRequestEvidence}
            >
              {detailLoading ? '读取中' : '展开证据与历史'}
            </button>
          )}

          {detail?.disclosureLevel === 'D3' && <section className="memory-node-subsection">
            <strong>近期命中</strong>
            {detail.recentHits.length > 0 ? (
              <div className="memory-hit-list">
                {detail.recentHits.map((hit) => (
                  <div key={`${hit.runId}:${hit.at}`}>
                    <span>{hit.action === 'deep_search' ? '分支深搜' : '索引展开'}{hit.query ? ` · ${hit.query}` : ''}</span>
                    <time dateTime={hit.at}>{formatDateTime(hit.at)}</time>
                  </div>
                ))}
              </div>
            ) : <p>本次应用运行期间暂无命中。</p>}
          </section>}

          {detail?.disclosureLevel === 'D3' && <section className="memory-node-subsection">
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
            ) : <p>暂无变更记录。</p>}
          </section>}

          {detail?.v3?.history && (
            <section className="memory-node-subsection">
              <strong>v3 事件时间线</strong>
              {detail.v3.history.entries.length > 0 ? (
                <div className="memory-history-list">
                  {detail.v3.history.entries.map((entry) => (
                    <div key={`${entry.kind}:${entry.id}`}>
                      <span><b>{memoryHistoryKindLabel(entry.kind)}</b>{entry.summary}</span>
                      <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
                    </div>
                  ))}
                </div>
              ) : <p>暂无事件记录。</p>}
            </section>
          )}

          <div className="memory-node-actions">
            {node.status === 'active' ? (
              <>
                <button type="button" disabled={busy || Boolean(node.invalidatedAt) || node.tier <= highestTier} onClick={() => onAction('promote')}>提升</button>
                <button type="button" disabled={busy || Boolean(node.invalidatedAt) || node.tier >= 3} onClick={() => onAction('demote')}>降级</button>
                <button type="button" disabled={busy || Boolean(node.invalidatedAt)} onClick={() => onAction('archive')}>归档</button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => onAction('restore')}>恢复</button>
            )}
            <button className="danger" type="button" disabled={busy} onClick={() => onAction('delete')}>删除</button>
            <MemoryAtomActions
              node={node}
              enabled={atomManagementEnabled}
              busy={busy}
              onRequest={onAtomAction}
              onExport={onExportAtom}
            />
          </div>
        </div>
      </div>
    </article>
  )
}

function MemoryV3EvidenceSummary({ detail }: { detail: MemoryTreeNodeDetail }) {
  const v3 = detail.v3!
  return (
    <section className="memory-v3-evidence">
      <div className="memory-v3-badges">
        <span>{memoryDomainLabel(v3.domain)}</span>
        <span>{statementKindLabel(v3.statementKind)}</span>
        <span className={v3.conflict || v3.expired ? 'warning' : ''}>{epistemicStatusLabel(v3.epistemicStatus)}</span>
        <span>{embeddingStatusLabel(v3.embedding.status)}</span>
      </div>
      <dl className="memory-node-metadata">
        <div><dt>版本</dt><dd>r{v3.revision} · {v3.resolutionStatus}</dd></div>
        <div><dt>断言者</dt><dd>{v3.assertedBy.label ?? v3.assertedBy.id ?? v3.assertedBy.kind}</dd></div>
        <div><dt>权威范围</dt><dd>{v3.authorityScope.kind} · {v3.authorityScope.scope}</dd></div>
        <div><dt>验证收益</dt><dd>{v3.verifiedUsefulness.useful} 有效 · {v3.verifiedUsefulness.notUseful + v3.verifiedUsefulness.conflicts + v3.verifiedUsefulness.stale} 负向</dd></div>
        <div><dt>向量</dt><dd>{v3.embedding.modelId ?? '本地目录'}{v3.embedding.dimensions ? ` · ${v3.embedding.dimensions}d` : ''}</dd></div>
        <div><dt>最近验证</dt><dd>{v3.lastVerifiedAt ? formatDateTime(v3.lastVerifiedAt) : '尚未验证'}</dd></div>
      </dl>
      {v3.evidenceRefs.length > 0 && (
        <div className="memory-node-keys">
          {v3.evidenceRefs.slice(0, 12).map((ref) => <span key={ref}>{compactPath(ref)}</span>)}
        </div>
      )}
      {v3.rawRecords && (
        <section className="memory-node-subsection">
          <strong>原始数据记录</strong>
          {v3.rawRecords.length > 0 ? (
            <div className="memory-history-list">
              {v3.rawRecords.map((record) => (
                <div key={record.id}>
                  <span><b>{record.kind}</b>{record.sourceKind} · {record.evidenceRefs.slice(0, 2).join(' · ')}</span>
                  <time dateTime={record.occurredAt}>{formatDateTime(record.occurredAt)}</time>
                </div>
              ))}
            </div>
          ) : <p>该投影来自旧数据或尚未建立原始事件记录。</p>}
        </section>
      )}
      {v3.neighborhood && (v3.neighborhood.entities.length > 0 || v3.neighborhood.relations.length > 0) && (
        <section className="memory-node-subsection">
          <strong>关系邻域</strong>
          <div className="memory-relation-list">
            {v3.neighborhood.entities.map((entity) => <span key={entity.id}>{entity.type} · {entity.label}</span>)}
            {v3.neighborhood.relations.map((relation) => (
              <span key={relation.id}>{relation.fromEntityId} → {relation.type} → {relation.toEntityId}</span>
            ))}
          </div>
        </section>
      )}
    </section>
  )
}

function scopeText(node: MemoryTreeNodeOverview): string {
  if (node.project) return `项目：${node.project.name}`
  return SCOPE_LABELS[node.scope]
}

function sourceText(detail: MemoryTreeNodeDetail): string {
  if (detail.sourceRefs.length > 0) return detail.sourceRefs.map(compactPath).join(' · ')
  const stages = detail.sourceStages.map((stage) => ({
    evolve: '任务复盘', capture: '每日捕获', tool: '记忆工具', migration: '旧数据迁移',
  })[stage])
  const runs = detail.sourceRunIds.slice(-2).map((runId) => `run ${runId.slice(0, 8)}`)
  return [...new Set([...stages, ...runs])].join(' · ') || '运行时记忆树'
}

function writeDecisionLabel(decision: string): string {
  return ({ created: '自动写入', merged: '自动合并', reinforced: '来源强化', rejected: '拒绝写入', queued: '等待恢复' } as Record<string, string>)[decision] ?? decision
}

function managementActionLabel(action: MemoryTreeManagementAction): string {
  return ({ archive: '归档', restore: '恢复', delete: '删除', promote: '提升', demote: '降级' })[action]
}

function memoryDomainLabel(domain: NonNullable<MemoryTreeNodeDetail['v3']>['domain']): string {
  return ({ user: '用户', 'agent-self': 'LS 自身', task: '任务', project: '项目', session: '会话', experience: '经验', knowledge: '知识' })[domain]
}

function statementKindLabel(kind: string): string {
  return ({
    instruction: '指令', goal: '目标', preference: '偏好', value: '价值判断',
    'reported-observation': '报告观察', 'factual-claim': '事实主张', suggestion: '建议',
    hypothesis: '假设', decision: '决定', approval: '批准',
  } as Record<string, string>)[kind] ?? kind
}

function epistemicStatusLabel(status: string): string {
  return ({ reported: '已陈述', observed: '已观察', supported: '有证据', verified: '已验证', disputed: '有争议', refuted: '已否定', unknown: '未知' } as Record<string, string>)[status] ?? status
}

function embeddingStatusLabel(status: NonNullable<MemoryTreeNodeDetail['v3']>['embedding']['status']): string {
  return ({ disabled: '向量关闭', pending: '等待向量', ready: '向量就绪', stale: '向量待更新', failed: '向量失败' })[status]
}

function memoryHistoryKindLabel(kind: NonNullable<NonNullable<MemoryTreeNodeDetail['v3']>['history']>['entries'][number]['kind']): string {
  return ({ access: '访问', feedback: '反馈', event: '事件', audit: '审计' })[kind]
}
