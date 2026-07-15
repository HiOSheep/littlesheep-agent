import type { MemoryTreeOverview, MemoryV3MigrationPreflightOverview } from '../api'
import { formatDateTime } from './format'

export function MemoryMigrationPanel({
  repository,
  preflight,
  loading,
  busyAction,
  onRefresh,
  onRequestMigration,
  onRequestRollback,
  onCancel,
  onRestart,
}: {
  repository: MemoryTreeOverview['repository']
  preflight: MemoryV3MigrationPreflightOverview | null
  loading: boolean
  busyAction: string | null
  onRefresh: () => void
  onRequestMigration: () => void
  onRequestRollback: () => void
  onCancel: () => void
  onRestart: () => void
}) {
  const pending = preflight?.pendingOperation
  return (
    <div className="memory-migration-panel">
      <div className="memory-migration-status-line">
        <span>
          <strong>{repository.backendKind.toUpperCase()}</strong>
          <small>{repository.storageKind === 'atom-catalog' ? '原子目录' : '兼容索引'}</small>
        </span>
        <button type="button" disabled={loading || !!busyAction} onClick={onRefresh}>{loading ? '检查中' : '重新检查'}</button>
      </div>

      {repository.catalog && (
        <dl className="memory-migration-metrics">
          <div><dt>目录完整性</dt><dd>{repository.catalog.integrity}</dd></div>
          <div><dt>atom</dt><dd>{repository.catalog.atomCount}</dd></div>
          <div><dt>向量就绪</dt><dd>{repository.catalog.embedding.ready}</dd></div>
          <div><dt>待维护</dt><dd>{repository.catalog.embedding.pending + repository.catalog.embedding.stale + repository.catalog.embedding.failed}</dd></div>
        </dl>
      )}

      {preflight ? (
        <>
          <dl className="memory-migration-metrics">
            <div><dt>活动版本</dt><dd>{preflight.activeBackend.toUpperCase()}</dd></div>
            <div><dt>待处理操作</dt><dd>{pending ? operationLabel(pending.kind) : '无'}</dd></div>
            <div><dt>当前阶段</dt><dd>{pending ? migrationPhaseLabel(pending.phase) : '未开始'}</dd></div>
            <div><dt>记忆节点</dt><dd>{preflight.source?.nodeCount ?? 0}</dd></div>
            <div><dt>资源登记</dt><dd>{preflight.source?.resourceCount ?? 0}</dd></div>
            <div><dt>源数据</dt><dd>{formatBytes(preflight.source?.totalBytes ?? 0)}</dd></div>
            <div><dt>可用空间</dt><dd>{formatBytes(preflight.storage?.availableBytes ?? 0)}</dd></div>
          </dl>
          <div className={`memory-migration-readiness ${preflight.blockers.length > 0 ? 'blocked' : 'ready'}`}>
            <strong>{migrationReadinessLabel(preflight)}</strong>
            <time dateTime={preflight.checkedAt}>{formatDateTime(preflight.checkedAt)}</time>
          </div>
          {preflight.blockers.map((blocker) => <p className="memory-project-callout conflict" key={blocker}>{blocker}</p>)}
          {pending?.error && <p className="memory-project-callout conflict">{pending.error}</p>}
          <div className="memory-migration-actions">
            {pending ? (
              <>
                {preflight.canCancel && (
                  <button type="button" disabled={!!busyAction} onClick={onCancel}>
                    {busyAction === 'cancel' ? '取消中' : '取消待处理操作'}
                  </button>
                )}
                <button className="primary" type="button" disabled={!!busyAction} onClick={onRestart}>
                  {busyAction === 'restart' ? '正在重启' : pending.phase === 'recovery' ? '重启并恢复' : '重启并执行'}
                </button>
              </>
            ) : (
              <>
                {preflight.canMigrate && (
                  <button className="primary" type="button" disabled={!!busyAction} onClick={onRequestMigration}>
                    准备迁移到 V3
                  </button>
                )}
                {preflight.activeBackend === 'v3' && preflight.rollbackAvailable && (
                  <button type="button" disabled={!!busyAction} onClick={onRequestRollback}>
                    准备回滚到 V2
                  </button>
                )}
              </>
            )}
          </div>
        </>
      ) : (
        <div className="memory-tree-loading">{loading ? '正在检查迁移条件...' : '尚未检查迁移条件。'}</div>
      )}
    </div>
  )
}

function migrationPhaseLabel(
  phase: NonNullable<MemoryV3MigrationPreflightOverview['pendingOperation']>['phase'],
): string {
  return ({
    requested: '已请求', snapshot: '快照', building: '构建', validating: '校验',
    ready: '待提交', committing: '提交', recovery: '待恢复',
  })[phase]
}

function operationLabel(kind: NonNullable<MemoryV3MigrationPreflightOverview['pendingOperation']>['kind']): string {
  return kind === 'migration' ? '迁移到 V3' : '回滚到 V2'
}

function migrationReadinessLabel(preflight: MemoryV3MigrationPreflightOverview): string {
  if (preflight.pendingOperation?.kind === 'migration') {
    return preflight.pendingOperation.phase === 'recovery' ? '迁移等待恢复' : '迁移等待重启'
  }
  if (preflight.pendingOperation?.kind === 'rollback') {
    return preflight.pendingOperation.phase === 'recovery' ? '回滚等待恢复' : '回滚等待重启'
  }
  if (preflight.rollbackAvailable) return '可进入回滚校验'
  if (preflight.canResume) return '可恢复未完成迁移'
  if (preflight.canMigrate) return '迁移前置条件通过'
  return preflight.blockers.length > 0 ? '迁移前置条件未通过' : '当前无需迁移'
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}
