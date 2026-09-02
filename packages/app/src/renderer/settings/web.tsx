import { useEffect, useState } from 'react'
import type { RuntimeWebPatch, RuntimeWebState } from '../../shared/runtime-api-contracts'
import { checkWebProvider, clearWebCache, getRuntime, saveWebProvider, updateRuntime } from '../api/runtime'
import { statusLabel } from './web-state'

export function SettingsWebPage() {
  const [web, setWeb] = useState<RuntimeWebState | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [providerKey, setProviderKey] = useState('')
  const [savingProvider, setSavingProvider] = useState(false)
  const [checkingProvider, setCheckingProvider] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void getRuntime().then((runtime) => { if (active) setWeb(runtime.web) })
      .catch((reason) => { if (active) setError((reason as Error).message) })
    return () => { active = false }
  }, [])

  async function patch(value: RuntimeWebPatch) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const runtime = await updateRuntime({ web: value })
      setWeb(runtime.web)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function clearCache() {
    setBusy(true)
    setError('')
    try {
      await clearWebCache()
      setNotice('网络资料缓存已清理。')
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function configureProvider() {
    if (!providerKey.trim()) return
    setSavingProvider(true)
    setError('')
    setNotice('')
    try {
      const runtime = await saveWebProvider(providerKey)
      setWeb(runtime.web)
      setProviderKey('')
      setNotice('Tavily 已保存，网络检索仍需单独启用。')
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSavingProvider(false)
    }
  }

  async function checkProvider() {
    setCheckingProvider(true)
    setError('')
    setNotice('')
    try {
      const runtime = await checkWebProvider()
      setWeb(runtime.web)
      setNotice(runtime.web.status === 'ready' ? 'Tavily 检查通过。' : 'Tavily 检查未通过，请查看当前状态。')
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setCheckingProvider(false)
    }
  }

  if (!web) return <div className="settings-module-page"><div className="web-settings-status">正在读取网络策略...</div></div>

  return (
    <div className="settings-module-page web-settings-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">通用</div>
        <h2>网络检索</h2>
        <p>公开资料读取与来源状态</p>
      </header>

      <section className="web-settings-section" aria-label="网络检索状态">
        <div className="web-settings-row">
          <span><strong>实时资料</strong><small>{statusLabel(web)}</small></span>
          <button
            type="button"
            className={`plugin-switch ${web.enabled ? 'checked' : ''}`}
            role="switch"
            aria-checked={web.enabled}
            aria-label="启用网络检索"
            disabled={busy}
            onClick={() => web.enabled ? void patch({ enabled: false }) : setConfirming(true)}
          ><span /></button>
        </div>
        {confirming && !web.enabled && (
          <div className="web-egress-confirmation" role="alertdialog" aria-label="确认启用网络检索">
            <strong>启用后会发生三类外发</strong>
            <ul>
              <li>最小查询发送给搜索服务</li>
              <li>公开网址发送给目标网站</li>
              <li>有界证据发送给当前模型服务</li>
            </ul>
            <div>
              <button type="button" onClick={() => setConfirming(false)}>取消</button>
              <button type="button" className="primary" onClick={() => { setConfirming(false); void patch({ enabled: true }) }}>启用</button>
            </div>
          </div>
        )}
      </section>

      <section className="web-settings-section" aria-label="搜索服务配置">
        <div className="web-settings-row">
          <span><strong>搜索服务</strong><small>{web.providerConfigured ? `${web.providerId ?? 'Tavily'} 已配置` : '尚未配置 Tavily'}</small></span>
        </div>
        <div className="web-provider-key-form">
          <input
            type="password"
            value={providerKey}
            onChange={(event) => setProviderKey(event.target.value)}
            placeholder="Tavily API key"
            aria-label="Tavily API key"
            disabled={savingProvider}
          />
        <button type="button" disabled={savingProvider || !providerKey.trim()} onClick={() => void configureProvider()}>
          {savingProvider ? '保存中…' : '保存 Tavily'}
        </button>
      </div>
      <button
        type="button"
        className="web-provider-check"
        disabled={checkingProvider || savingProvider || !web.providerConfigured || !web.enabled || web.readMode === 'disabled'}
        onClick={() => void checkProvider()}
      >
        {checkingProvider ? '检查中…' : '检查 Tavily 连接'}
      </button>
      <small className="web-provider-note">密钥由本机加密存储；网络开关、查询外发和网页读取仍由上方策略控制。</small>
      </section>

      <section className="web-settings-section" aria-label="读取策略">
        <div className="web-settings-heading"><strong>读取策略</strong></div>
        <label className="web-settings-field">
          <span>公开读取模式</span>
          <select value={web.readMode} disabled={busy} onChange={(event) => void patch({ readMode: event.target.value as RuntimeWebPatch['readMode'] })}>
            <option value="public_anonymous">公开匿名读取</option>
            <option value="configured_allowlist">仅允许域名</option>
            <option value="disabled">关闭读取</option>
          </select>
        </label>
        <label className="web-settings-field">
          <span>域名解析</span>
          <select value={web.dnsResolver} disabled={busy} onChange={(event) => void patch({ dnsResolver: event.target.value as RuntimeWebPatch['dnsResolver'] })}>
            <option value="system">系统 DNS</option>
            <option value="cloudflare_doh">Cloudflare DoH</option>
          </select>
          <small>{web.dnsResolver === 'cloudflare_doh' ? '域名会发送给 Cloudflare 解析；目标地址仍会经过 SSRF 检查。' : '目标地址会经过 SSRF 检查。'}</small>
        </label>
        <label className="web-settings-row">
          <span><strong>严格读取审批</strong><small>所有 safe read 仍逐次确认</small></span>
          <input type="checkbox" checked={web.strictReadApproval} disabled={busy} onChange={(event) => void patch({ strictReadApproval: event.target.checked })} />
        </label>
        <label className="web-settings-field">
          <span>敏感查询</span>
          <select value={web.sensitiveQueryPolicy} disabled={busy} onChange={(event) => void patch({ sensitiveQueryPolicy: event.target.value as RuntimeWebPatch['sensitiveQueryPolicy'] })}>
            <option value="approve">外发前确认</option>
            <option value="redact">脱敏后发送</option>
            <option value="deny">拒绝外发</option>
            <option value="allow">直接发送</option>
          </select>
        </label>
        <label className="web-settings-field">
          <span>浏览器后备</span>
          <select value={web.browserFallback} disabled={busy} onChange={(event) => void patch({ browserFallback: event.target.value as RuntimeWebPatch['browserFallback'] })}>
            <option value="approval_required">需要批准</option>
            <option value="full_only">仅完全访问</option>
            <option value="disabled">禁用</option>
          </select>
        </label>
      </section>

      <section className="web-settings-section" aria-label="网络资料缓存">
        <div className="web-settings-row">
          <span><strong>资料缓存</strong><small>{web.cacheEnabled ? `${web.cacheTtlSeconds} 秒保留` : '已关闭'}</small></span>
          <input type="checkbox" checked={web.cacheEnabled} disabled={busy} onChange={(event) => void patch({ cacheEnabled: event.target.checked })} />
        </div>
        <button className="web-cache-clear" type="button" disabled={busy} onClick={() => void clearCache()}>清理网络缓存</button>
      </section>

      {notice && <div className="web-settings-notice" role="status">{notice}</div>}
      {error && <div className="web-settings-notice error" role="alert">{error}</div>}
    </div>
  )
}
