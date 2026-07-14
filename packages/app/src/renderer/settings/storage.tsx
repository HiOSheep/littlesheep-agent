// Settings navigation and page composition.
import { useEffect,useState } from 'react'
import {
cancelDataRootOperation,
getDataRootStatus,
requestDataRootMigration,
requestDataRootRollback,
restartApplication,
selectDataRootTarget,
type DataRootMigrationState,
type DataRootStatus
} from '../api'


export function SettingsStoragePage() {
  const [status, setStatus] = useState<DataRootStatus | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void getDataRootStatus()
      .then((next) => {
        if (active) setStatus(next)
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
    }
  }, [])

  async function runStatusAction(label: string, action: () => Promise<DataRootStatus>) {
    if (busyAction) return
    setBusyAction(label)
    setError(null)
    try {
      setStatus(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }

  async function chooseMigrationTarget() {
    if (busyAction) return
    setBusyAction('select')
    setError(null)
    try {
      const target = await selectDataRootTarget()
      if (target) setStatus(await requestDataRootMigration(target))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }

  async function restartNow() {
    if (busyAction) return
    setBusyAction('restart')
    setError(null)
    try {
      await restartApplication()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusyAction(null)
    }
  }

  const pendingMigration = status?.pendingMigration
  const pendingRollback = status?.pendingRollback
  const pending = !!pendingMigration || !!pendingRollback

  return (
    <div className="settings-module-page storage-settings-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <h2>存储与数据</h2>
        <p>管理 LS 的配置、会话、记忆、插件数据和默认工作区位置。迁移只在重启后的启动阶段执行。</p>
      </header>

      <section className="storage-settings-section" aria-label="数据目录状态">
        <div className="storage-settings-heading">
          <strong>当前状态</strong>
          <span>{status?.managed === false ? '环境变量接管' : '应用管理'}</span>
        </div>
        <div className="storage-settings-row">
          <span>
            <strong>当前数据目录</strong>
            <small>LS 当前读取和写入的权威目录</small>
          </span>
          <code>{status?.currentDataDir ?? '读取中...'}</code>
        </div>
        {status?.environmentOverride && (
          <div className="storage-settings-notice" data-tone="neutral">
            当前目录由 <code>LITTLESHEEP_DATA_DIR</code> 指定。应用内迁移与回滚已禁用，避免与环境配置冲突。
          </div>
        )}
      </section>

      {pending && (
        <section className="storage-settings-section" aria-label="待处理的数据目录操作">
          <div className="storage-settings-heading">
            <strong>等待重启</strong>
            <span>{pendingMigration ? migrationPhaseLabel(pendingMigration.phase) : '等待回滚'}</span>
          </div>
          <div className="storage-settings-row">
            <span>
              <strong>{pendingMigration ? '迁移目标' : '回滚目标'}</strong>
              <small>{pendingMigration ? '源目录会被保留，校验完成后才切换' : '回到前一个仍然存在的数据目录'}</small>
            </span>
            <code>{pendingMigration?.targetDir ?? pendingRollback?.toDir}</code>
          </div>
          {(pendingMigration?.error || pendingRollback?.error) && (
            <div className="storage-settings-notice" data-tone="error">
              {pendingMigration?.error ?? pendingRollback?.error}
            </div>
          )}
          <div className="storage-settings-actions">
            <button
              type="button"
              onClick={() => void runStatusAction('cancel', cancelDataRootOperation)}
              disabled={!!busyAction}
            >
              取消待处理操作
            </button>
            <button
              className="primary"
              type="button"
              onClick={() => void restartNow()}
              disabled={!!busyAction}
            >
              {busyAction === 'restart' ? '正在重启' : '重启并执行'}
            </button>
          </div>
        </section>
      )}

      {!pending && status?.managed !== false && (
        <section className="storage-settings-section" aria-label="数据目录操作">
          <div className="storage-settings-heading">
            <strong>目录管理</strong>
            <span>下次启动生效</span>
          </div>
          <div className="storage-settings-row">
            <span>
              <strong>迁移完整数据根</strong>
              <small>目标必须不存在或为空；复制、重绑定和哈希校验成功后才会原子切换</small>
            </span>
            <button type="button" onClick={() => void chooseMigrationTarget()} disabled={!!busyAction}>
              {busyAction === 'select' ? '选择中' : '选择新位置'}
            </button>
          </div>
          {status?.canRollback && status.previousDataDir && (
            <div className="storage-settings-row">
              <span>
                <strong>回滚到前一个目录</strong>
                <small>{status.previousDataDir}</small>
              </span>
              <button
                type="button"
                onClick={() => void runStatusAction('rollback', requestDataRootRollback)}
                disabled={!!busyAction}
              >
                登记回滚
              </button>
            </div>
          )}
        </section>
      )}

      {status?.lastMigration && (
        <section className="storage-settings-section" aria-label="最近迁移记录">
          <div className="storage-settings-heading">
            <strong>最近迁移</strong>
            <span>{new Date(status.lastMigration.completedAt).toLocaleString('zh-CN')}</span>
          </div>
          <div className="storage-settings-row compact">
            <span>
              <strong>{status.lastMigration.fileCount} 个文件</strong>
              <small>{formatDataSize(status.lastMigration.totalBytes)}，完整清单已通过 SHA-256 校验</small>
            </span>
            <code>{status.lastMigration.targetDir}</code>
          </div>
        </section>
      )}

      {error && <div className="storage-settings-notice" data-tone="error" role="alert">{error}</div>}
    </div>
  )
}


export function migrationPhaseLabel(phase: DataRootMigrationState['phase']): string {
  if (phase === 'copying') return '复制中断，等待续传'
  if (phase === 'verifying') return '校验中断，等待续传'
  if (phase === 'committing') return '提交中断，等待恢复'
  if (phase === 'failed') return '上次迁移失败'
  return '迁移已登记'
}


export function formatDataSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
