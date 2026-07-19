// Settings page for the LS-managed development environment registry.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getDevelopmentEnvironments,
  importDevelopmentEnvironment,
  removeDevelopmentEnvironment,
  saveDevelopmentEnvironmentPreference,
  type DevelopmentEnvironmentInfo,
  type DevelopmentEnvironmentSnapshot,
} from '../api/development-environments'
import { FolderGlyphIcon, RefreshIcon, TrashIcon } from '../ui/icons'

export function SettingsDevelopmentEnvironmentsPage() {
  const [snapshot, setSnapshot] = useState<DevelopmentEnvironmentSnapshot | null>(null)
  const [versions, setVersions] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const aliveRef = useRef(true)

  useEffect(() => () => {
    aliveRef.current = false
  }, [])

  async function load(force = false) {
    if (force) setRefreshing(true)
    setError('')
    try {
      const next = await getDevelopmentEnvironments(force)
      if (!aliveRef.current) return
      setSnapshot(next)
      setVersions(snapshotVersions(next))
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (force && aliveRef.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const groups = useMemo(() => {
    const environments = snapshot?.environments ?? []
    return [
      { title: '运行时', items: environments.filter((item) => item.category === 'runtime') },
      { title: '编译工具链', items: environments.filter((item) => item.category === 'compiler') },
      { title: '开发工具', items: environments.filter((item) => item.category === 'tooling') },
    ].filter((group) => group.items.length > 0)
  }, [snapshot])

  async function save(environment: DevelopmentEnvironmentInfo) {
    if (busyId) return
    setBusyId(environment.id)
    setError('')
    setNotice('')
    try {
      const version = versions[environment.id]?.trim() || null
      const next = await saveDevelopmentEnvironmentPreference({ environmentId: environment.id, version })
      if (!aliveRef.current) return
      setSnapshot(next)
      setVersions(snapshotVersions(next))
      setNotice(`${environment.label} 的版本偏好已保存。`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (aliveRef.current) setBusyId(null)
    }
  }

  async function importEnvironment(environment: DevelopmentEnvironmentInfo) {
    if (busyId) return
    setBusyId(`import:${environment.id}`)
    setError('')
    setNotice('')
    try {
      const version = versions[environment.id]?.trim() || null
      const next = await importDevelopmentEnvironment({ environmentId: environment.id, version })
      if (!aliveRef.current) return
      setSnapshot(next)
      setVersions(snapshotVersions(next, environment.id, version ?? ''))
      setNotice(`${environment.label} 已导入并完成版本校验。`)
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (aliveRef.current) setBusyId(null)
    }
  }

  async function removeEnvironmentVersion(environment: DevelopmentEnvironmentInfo, version: string) {
    if (busyId) return
    setBusyId(`remove:${environment.id}:${version}`)
    setError('')
    setNotice('')
    try {
      const next = await removeDevelopmentEnvironment({ environmentId: environment.id, version })
      if (!aliveRef.current) return
      setSnapshot(next)
      setVersions(snapshotVersions(next))
      setNotice(`${environment.label} ${version} 已从 LS 工具链目录移除。`)
    } catch (cause) {
      if (aliveRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (aliveRef.current) setBusyId(null)
    }
  }

  return (
    <div className="settings-module-page development-environments-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <div className="development-environments-heading-row">
          <div>
            <h2>开发环境</h2>
         <p>版本偏好保存在 LS 数据根。终端优先使用 LS 已管理的运行时，系统工具只作为明确的降级来源。</p>
          </div>
          <button
            className="development-environments-refresh"
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <RefreshIcon />
            <span>{refreshing ? '检测中' : '重新检测'}</span>
          </button>
        </div>
      </header>

      <section className="development-environments-root" aria-label="开发环境目录">
        <span>LS 工具链目录</span>
        <code title={snapshot?.toolchainsRoot}>{snapshot?.toolchainsRoot ?? '读取中...'}</code>
      </section>

      <div className="storage-settings-notice development-environments-notice" data-tone="neutral">
        保存版本只改变 LS 的目标偏好；要让目标版本真正生效，请先导入已下载并解压的工具链。填写 `3.12` 这类版本系列时，LS 会选择已导入的最高匹配补丁版本。导入时 LS 会复制文件、校验可执行文件和版本，系统版本只在目标版本尚未准备好时降级使用。
      </div>

      {groups.map((group) => (
        <section key={group.title} className="development-environment-group" aria-label={group.title}>
          <div className="development-environment-group-title">{group.title}</div>
          <div className="development-environment-list">
            {group.items.map((environment) => (
              <EnvironmentRow
                key={environment.id}
                environment={environment}
                version={versions[environment.id] ?? ''}
                busy={busyId === environment.id || busyId?.startsWith(`remove:${environment.id}:`) === true}
                importing={busyId === `import:${environment.id}`}
                removing={busyId?.startsWith(`remove:${environment.id}:`) ?? false}
                onVersionChange={(value) => setVersions((current) => ({ ...current, [environment.id]: value }))}
                onSave={() => void save(environment)}
                onImport={() => void importEnvironment(environment)}
                onRemove={(version) => void removeEnvironmentVersion(environment, version)}
              />
            ))}
          </div>
        </section>
      ))}

      {!snapshot && !error && <div className="development-environments-empty">正在读取开发环境状态...</div>}
      {notice && <div className="storage-settings-notice" role="status">{notice}</div>}
      {error && <div className="storage-settings-notice" data-tone="error" role="alert">{error}</div>}
    </div>
  )
}

function EnvironmentRow({
  environment,
  version,
  busy,
  importing,
  removing,
  onVersionChange,
  onSave,
  onImport,
  onRemove,
}: {
  environment: DevelopmentEnvironmentInfo
  version: string
  busy: boolean
  importing: boolean
  removing: boolean
  onVersionChange: (value: string) => void
  onSave: () => void
  onImport: () => void
  onRemove: (version: string) => void
}) {
  const status = environmentStatusLabel(environment)
  const datalistId = `development-environment-versions-${environment.id}`
  return (
    <div className="development-environment-row">
      <div className="development-environment-main">
        <div className="development-environment-title-line">
          <strong>{environment.label}</strong>
          <span className={`development-environment-status ${environment.state}`}>{status}</span>
        </div>
        <small>{environment.description}</small>
        <div className="development-environment-detail">
          <span>实际：{environment.currentVersion ?? '未发现'}</span>
          <span>来源：{sourceLabel(environment.source)}</span>
          {environment.activeManagedVersion && <span>目录版本：{environment.activeManagedVersion}</span>}
          {environment.requestedVersion && <span>目标：{environment.requestedVersion}</span>}
          {environment.executablePath && <code title={environment.executablePath}>{environment.executablePath}</code>}
        </div>
        <p>{environment.note}</p>
        {environment.availableVersions.length > 0 && (
          <div className="development-environment-installed" aria-label={`${environment.label}已安装版本`}>
            <span>已导入：</span>
            {environment.availableVersions.map((item) => (
              <span className="development-environment-version" key={item}>
                <button
                  type="button"
                  className="development-environment-version-select"
                  onClick={() => onVersionChange(item)}
                  title={`将 ${item} 设为目标版本`}
                >
                  {item}
                </button>
                <button
                  type="button"
                  className="development-environment-version-remove"
                  onClick={() => onRemove(item)}
                  disabled={removing}
                  aria-label={`移除 ${environment.label} ${item}`}
                  title={`移除 ${item}`}
                >
                  <TrashIcon />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="development-environment-controls">
        <label>
          <span>目标版本</span>
          <input
            list={datalistId}
            value={version}
            placeholder="自动选择最新版本"
            onChange={(event) => onVersionChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onSave()
              }
            }}
            aria-label={`${environment.label}目标版本`}
          />
          <datalist id={datalistId}>
            {environment.availableVersions.map((item) => <option key={item} value={item} />)}
          </datalist>
        </label>
        <div className="development-environment-action-row">
          <button type="button" onClick={onSave} disabled={busy || importing}>
          {busy ? '保存中' : '保存'}
          </button>
          <button
            type="button"
            className="development-environment-import"
            onClick={onImport}
            disabled={busy || importing}
            title="导入已下载并解压的工具链"
          >
            <FolderGlyphIcon />
            <span>{importing ? '导入中' : '导入'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function environmentStatusLabel(environment: DevelopmentEnvironmentInfo): string {
  if (environment.state === 'ready') return environment.source === 'builtin' ? 'LS 内置' : '已就绪'
  if (environment.state === 'system-fallback') return '系统降级'
  if (environment.state === 'version-pending') return '目标待准备'
  return '未安装'
}

function sourceLabel(source: DevelopmentEnvironmentInfo['source']): string {
  if (source === 'builtin') return 'LS 内置'
  if (source === 'managed') return 'LS 管理'
  if (source === 'system') return '系统'
  return '未发现'
}

function snapshotVersions(
  snapshot: DevelopmentEnvironmentSnapshot,
  fallbackId?: string,
  fallbackVersion = '',
): Record<string, string> {
  return Object.fromEntries(snapshot.environments.map((environment) => [
    environment.id,
    environment.requestedVersion ?? (environment.id === fallbackId ? fallbackVersion : ''),
  ]))
}
