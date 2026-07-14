// Settings navigation and page composition.
import { useEffect,useMemo,useRef,useState } from 'react'
import {
getPluginsStatus,
reloadPlugins,
setLocalPluginCodeAllowed,
setPluginEnabled,
type PluginsStatusResponse,
type PluginStatus
} from '../api'
import { PluginIcon,RefreshIcon,SearchIcon } from '../ui/icons'


export type PluginListFilter = 'all' | 'builtin' | 'local' | 'channel' | 'tool' | 'skill'


export const PLUGIN_FILTERS: Array<{ id: PluginListFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'builtin', label: '内置' },
  { id: 'local', label: '本地' },
  { id: 'channel', label: '渠道' },
  { id: 'tool', label: '工具' },
  { id: 'skill', label: '技能' },
]


export const PLUGIN_STATE_LABELS: Record<PluginStatus['state'], string> = {
  disabled: '已停用',
  inactive: '按需待命',
  activating: '正在启动',
  active: '运行中',
  blocked: '等待信任',
  failed: '启动失败',
}


export const PLUGIN_CAPABILITY_LABELS: Record<string, string> = {
  channel: '渠道',
  tool: '工具',
  skill: '技能',
}


export const PLUGIN_PERMISSION_LABELS: Record<string, string> = {
  'agent:run': '调用 Agent',
  'channels:register': '注册渠道',
  'tools:register': '注册工具',
  'skills:register': '注册技能',
  network: '访问网络',
  process: '启动进程',
  secrets: '读取所需密钥',
  'filesystem:plugin-data': '读写插件数据',
  'filesystem:workspace': '访问授权工作区',
}


export function SettingsPluginsPage() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PluginListFilter>('all')
  const [status, setStatus] = useState<PluginsStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [expandedPluginId, setExpandedPluginId] = useState<string | null>(null)
  const [confirmLocalCode, setConfirmLocalCode] = useState(false)
  const trustSectionRef = useRef<HTMLElement | null>(null)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestRef.current += 1
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [])

  useEffect(() => {
    if (!confirmLocalCode) return
    const handlePointerDown = (event: PointerEvent) => {
      if (!trustSectionRef.current?.contains(event.target as Node)) setConfirmLocalCode(false)
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [confirmLocalCode])

  const filteredPlugins = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return (status?.plugins ?? []).filter((plugin) => {
      const matchesFilter = filter === 'all'
        || plugin.source === filter
        || plugin.capabilities.includes(filter as 'channel' | 'tool' | 'skill')
      if (!matchesFilter) return false
      if (!needle) return true
      return [
        plugin.name,
        plugin.id,
        plugin.description,
        plugin.publisher ?? '',
        ...plugin.capabilities,
        ...plugin.contributes.channels,
        ...plugin.contributes.tools,
        ...plugin.contributes.skills,
      ].some((value) => value.toLocaleLowerCase('zh-CN').includes(needle))
    })
  }, [filter, query, status])

  async function loadStatus(showLoading = true): Promise<void> {
    const requestId = ++requestRef.current
    if (showLoading) setLoading(true)
    try {
      const next = await getPluginsStatus()
      if (!mountedRef.current || requestId !== requestRef.current) return
      setStatus(next)
      setError(null)
    } catch (loadError) {
      if (!mountedRef.current || requestId !== requestRef.current) return
      setError((loadError as Error).message)
    } finally {
      if (showLoading && mountedRef.current && requestId === requestRef.current) setLoading(false)
    }
  }

  async function handleReload(): Promise<void> {
    setBusyAction('reload')
    setNotice(null)
    try {
      await reloadPlugins()
      if (!mountedRef.current) return
      await loadStatus(false)
      if (!mountedRef.current) return
      setNotice('插件已重新发现并加载')
    } catch (reloadError) {
      if (mountedRef.current) setError((reloadError as Error).message)
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  async function handlePluginEnabled(plugin: PluginStatus, enabled: boolean): Promise<void> {
    setBusyAction(plugin.id)
    setNotice(null)
    try {
      await setPluginEnabled(plugin.id, enabled)
      if (!mountedRef.current) return
      await loadStatus(false)
      if (!mountedRef.current) return
      setNotice(`${plugin.name}已${enabled ? '启用' : '停用'}`)
    } catch (toggleError) {
      if (mountedRef.current) setError((toggleError as Error).message)
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  async function handleLocalCodeAllowed(allowed: boolean): Promise<void> {
    setBusyAction('local-code')
    setNotice(null)
    try {
      await setLocalPluginCodeAllowed(allowed)
      if (!mountedRef.current) return
      await loadStatus(false)
      if (!mountedRef.current) return
      setConfirmLocalCode(false)
      setNotice(allowed ? '已允许执行本地插件代码' : '已停止执行本地插件代码')
    } catch (trustError) {
      if (mountedRef.current) setError((trustError as Error).message)
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }

  const localPluginCount = status?.plugins.filter((plugin) => plugin.source === 'local').length ?? 0
  const operationBusy = busyAction !== null

  return (
    <div className="settings-module-page">
      <header className="settings-module-heading plugin-page-heading">
        <div>
          <div className="settings-module-kicker">扩展</div>
          <h2>插件</h2>
          <p>管理 LS 的可选渠道、工具和本地扩展。</p>
        </div>
        <button
          className="plugin-reload-button"
          type="button"
          onClick={() => void handleReload()}
          disabled={operationBusy}
          aria-label="重新发现并加载插件"
          title="重新加载插件"
        >
          <RefreshIcon />
          <span>{busyAction === 'reload' ? '加载中' : '重新加载'}</span>
        </button>
      </header>

      <section ref={trustSectionRef} className="plugin-trust-section" aria-label="本地插件信任">
        <div className="plugin-trust-summary">
          <span className="plugin-trust-icon" aria-hidden="true"><PluginIcon /></span>
          <span className="plugin-trust-copy">
            <strong>本地插件代码</strong>
            <small>{localPluginCount > 0 ? `已发现 ${localPluginCount} 个本地插件` : '当前未发现本地插件'}</small>
          </span>
          <button
            className={`plugin-switch ${status?.allowLocalCode ? 'checked' : ''}`}
            type="button"
            role="switch"
            aria-checked={status?.allowLocalCode ?? false}
            aria-label="允许执行本地插件代码"
            disabled={!status || operationBusy}
            onClick={() => {
              if (status?.allowLocalCode) void handleLocalCodeAllowed(false)
              else setConfirmLocalCode(true)
            }}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <div
          className={`plugin-trust-confirmation ${confirmLocalCode ? 'visible' : ''}`}
          aria-hidden={!confirmLocalCode}
          {...(!confirmLocalCode ? { inert: '' } : {})}
        >
          <div className="plugin-trust-confirmation-inner">
            <div>
              <strong>信任本机安装的插件代码？</strong>
              <span>本地插件与主进程拥有同等权限，可访问本机数据和网络。只启用来源明确且已审查的插件。</span>
            </div>
            <div className="plugin-trust-actions">
              <button type="button" onClick={() => setConfirmLocalCode(false)}>取消</button>
              <button
                className="danger"
                type="button"
                disabled={operationBusy}
                onClick={() => void handleLocalCodeAllowed(true)}
              >
                确认信任
              </button>
            </div>
          </div>
        </div>
      </section>

      <label className="settings-module-search">
        <SearchIcon />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索插件"
        />
      </label>
      <div className="settings-module-toolbar" role="toolbar" aria-label="插件筛选">
        {PLUGIN_FILTERS.map((item) => (
          <button
            key={item.id}
            className={`settings-filter-pill ${filter === item.id ? 'active' : ''}`}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
        {status && (
          <span className={`plugin-host-state ${status.started ? 'ready' : 'starting'}`}>
            <span aria-hidden="true" />
            {status.started ? `${status.plugins.length} 个插件` : '插件宿主初始化中'}
          </span>
        )}
      </div>

      {notice && <div className="plugin-page-notice" role="status">{notice}</div>}
      {error && <div className="plugin-page-error" role="alert">{error}</div>}

      {loading && (
        <div className="plugin-list-loading">
          <span className="plugin-loading-indicator" aria-hidden="true" />
          正在读取插件状态
        </div>
      )}

      {!loading && status && filteredPlugins.length > 0 && (
        <div className="plugin-list" aria-label="已发现插件">
          {filteredPlugins.map((plugin) => {
            const expanded = expandedPluginId === plugin.id
            const capabilityText = plugin.capabilities
              .map((capability) => PLUGIN_CAPABILITY_LABELS[capability] ?? capability)
              .join(' · ')
            const detailId = `plugin-details-${plugin.id}`
            return (
              <article key={plugin.id} className={`plugin-list-item ${expanded ? 'expanded' : ''}`}>
                <div className="plugin-list-summary">
                  <button
                    className="plugin-list-disclosure"
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={detailId}
                    onClick={() => setExpandedPluginId(expanded ? null : plugin.id)}
                  >
                    <span className="plugin-list-icon" aria-hidden="true"><PluginIcon /></span>
                    <span className="plugin-list-main">
                      <span className="plugin-list-title">
                        <strong>{plugin.name}</strong>
                        <small>v{plugin.version}</small>
                      </span>
                      <span className="plugin-list-description">{plugin.description || plugin.id}</span>
                      <span className="plugin-list-meta">
                        {plugin.source === 'builtin' ? '内置' : '本地'} · {capabilityText}
                      </span>
                      {plugin.error && <span className="plugin-list-error">{plugin.error}</span>}
                    </span>
                    <span className={`plugin-runtime-state ${plugin.state}`}>{PLUGIN_STATE_LABELS[plugin.state]}</span>
                    <span className="plugin-disclosure-chevron" aria-hidden="true" />
                  </button>
                  <button
                    className={`plugin-switch ${plugin.enabled ? 'checked' : ''}`}
                    type="button"
                    role="switch"
                    aria-checked={plugin.enabled}
                    aria-label={`${plugin.enabled ? '停用' : '启用'}${plugin.name}`}
                    disabled={operationBusy}
                    onClick={() => void handlePluginEnabled(plugin, !plugin.enabled)}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
                <div
                  id={detailId}
                  className={`plugin-list-details ${expanded ? 'visible' : ''}`}
                  aria-hidden={!expanded}
                  {...(!expanded ? { inert: '' } : {})}
                >
                  <dl className="plugin-list-details-inner">
                    <div><dt>标识</dt><dd>{plugin.id}</dd></div>
                    <div>
                      <dt>贡献</dt>
                      <dd>{[
                        ...plugin.contributes.channels.map((item) => `渠道 ${item}`),
                        ...plugin.contributes.tools.map((item) => `工具 ${item}`),
                        ...plugin.contributes.skills.map((item) => `技能 ${item}`),
                      ].join('，') || '无'}</dd>
                    </div>
                    <div>
                      <dt>激活</dt>
                      <dd>{plugin.activationEvents.map(pluginActivationLabel).join('，')}</dd>
                    </div>
                    <div>
                      <dt>权限声明</dt>
                      <dd>{plugin.permissions.map((item) => PLUGIN_PERMISSION_LABELS[item] ?? item).join('，') || '无额外声明'}</dd>
                    </div>
                    {plugin.publisher && <div><dt>发布者</dt><dd>{plugin.publisher}</dd></div>}
                    {plugin.location && <div><dt>位置</dt><dd className="plugin-location">{plugin.location}</dd></div>}
                  </dl>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {!loading && status && filteredPlugins.length === 0 && (
        <div className="settings-module-empty">
          <div className="settings-module-empty-icon" aria-hidden="true"><PluginIcon /></div>
          <strong>没有匹配的插件</strong>
          <span>{query.trim() || filter !== 'all' ? '调整关键词或筛选条件后再试。' : '将插件放入用户插件目录后重新加载。'}</span>
        </div>
      )}

      {status && status.diagnostics.length > 0 && (
        <section className="plugin-diagnostics" aria-label="插件发现问题">
          <strong>未载入的插件</strong>
          {status.diagnostics.map((diagnostic, index) => (
            <div key={`${diagnostic.source}:${index}`}>
              <span>{diagnostic.source}</span>
              <small>{diagnostic.message}</small>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}


export function pluginActivationLabel(event: string): string {
  if (event === 'onStartup') return '应用启动时'
  if (event.startsWith('onChannel:')) return `启用 ${event.slice('onChannel:'.length)} 渠道时`
  return event
}
