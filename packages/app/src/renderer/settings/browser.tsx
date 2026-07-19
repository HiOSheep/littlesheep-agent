// Settings for the persistent embedded-browser session.

import { useEffect, useState } from 'react'
import {
  clearBrowserCache,
  clearBrowserData,
  getBrowserStorageStatus,
  type BrowserStorageStatus,
} from '../api/browser'

export function SettingsBrowserPage() {
  const [status, setStatus] = useState<BrowserStorageStatus | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function refresh() {
    setError(null)
    try {
      setStatus(await getBrowserStorageStatus())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function runAction(action: 'cache' | 'data') {
    if (busyAction) return
    setBusyAction(action)
    setError(null)
    setNotice(null)
    try {
      const result = action === 'cache' ? await clearBrowserCache() : await clearBrowserData()
      setStatus(result.status)
      setNotice(action === 'cache' ? '网页缓存已清除。' : '网站数据、登录状态和缓存已清除。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="settings-module-page storage-settings-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">扩展</div>
        <h2>内置浏览器</h2>
        <p>网页在 LS 内运行。登录状态、Cookie、本地存储、IndexedDB 和缓存由持久化浏览器分区保存，不写入源码仓库。</p>
      </header>

      <section className="storage-settings-section" aria-label="内置浏览器状态">
        <div className="storage-settings-heading">
          <strong>当前状态</strong>
          <span>{status?.persistent ? '持久化已启用' : '读取中...'}</span>
        </div>
        <div className="storage-settings-row">
          <span>
            <strong>浏览器分区</strong>
            <small>应用重启后仍使用同一站点数据空间</small>
          </span>
          <code>{status?.partition ?? '读取中...'}</code>
        </div>
        <div className="storage-settings-row">
          <span>
            <strong>已保存 Cookie</strong>
            <small>仅显示数量，不展示具体站点或值</small>
          </span>
          <code>{status ? `${status.cookieCount} 个，来自 ${status.cookieDomainCount} 个域` : '读取中...'}</code>
        </div>
      </section>

      <section className="storage-settings-section" aria-label="内置浏览器数据操作">
        <div className="storage-settings-heading">
          <strong>数据管理</strong>
          <span>操作会影响所有内置浏览器标签</span>
        </div>
        <div className="storage-settings-row">
          <span>
            <strong>清除网页缓存</strong>
            <small>保留登录状态和网站本地数据，用于处理网页加载异常</small>
          </span>
          <button type="button" onClick={() => void runAction('cache')} disabled={!!busyAction}>
            {busyAction === 'cache' ? '清除中' : '清除缓存'}
          </button>
        </div>
        <div className="storage-settings-row">
          <span>
            <strong>清除所有网站数据</strong>
            <small>会退出网站登录，并删除 Cookie、本地存储、IndexedDB、Service Worker 和缓存</small>
          </span>
          <button type="button" onClick={() => void runAction('data')} disabled={!!busyAction}>
            {busyAction === 'data' ? '清除中' : '清除网站数据'}
          </button>
        </div>
      </section>

      {notice && <div className="storage-settings-notice" role="status">{notice}</div>}
      {error && <div className="storage-settings-notice" data-tone="error" role="alert">{error}</div>}
    </div>
  )
}
