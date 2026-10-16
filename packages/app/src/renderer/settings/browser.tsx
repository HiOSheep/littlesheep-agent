// Settings for the persistent embedded-browser session.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DangerConfirmDialog } from '../ui/danger-confirm'
import { useTransientNotice } from '../ui/use-transient-notice'
import { TransientNoticeToast } from '../ui/transient-notice-toast'
import {
  clearBrowserCache,
  clearBrowserData,
  getBrowserStorageStatus,
  type BrowserStorageStatus,
} from '../api/browser'

export function SettingsBrowserPage() {
  const [confirmData, setConfirmData] = useState(false)
  const actionPendingRef = useRef(false)
  const [status, setStatus] = useState<BrowserStorageStatus | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A success confirmation floats and clears itself; a failure stays on the page.
  const { notice, show: showNotice, clear: clearNotice } = useTransientNotice()

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
    if (actionPendingRef.current) return
    actionPendingRef.current = true
    setBusyAction(action)
    setError(null)
    clearNotice()
    try {
      const result = action === 'cache' ? await clearBrowserCache() : await clearBrowserData()
      setStatus(result.status)
      if (action === 'data') setConfirmData(false)
      showNotice(action === 'cache' ? '网页缓存已清除。' : '网站数据、登录状态和缓存已清除。')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      actionPendingRef.current = false
      setBusyAction(null)
    }
  }

  return (
    <div className="settings-module-page storage-settings-page">
      <header className="settings-module-heading">
        <div className="settings-module-kicker">扩展</div>
        <h2>内置浏览器</h2>
        <p>管理内置网页的登录状态和缓存。网站登录会在重启应用后保留。</p>
      </header>

      <section className="storage-settings-section" aria-label="内置浏览器状态">
        <div className="storage-settings-heading">
          <strong>当前状态</strong>
          <span>{status?.persistent ? '持久化已启用' : '读取中...'}</span>
        </div>
        <div className="settings-card">
        <div className="storage-settings-row" data-settings-field="browser.partition">
          <span>
            <strong>登录状态</strong>
            <small>应用重启后仍使用同一站点数据空间</small>
          </span>
          <details className="browser-diagnostics"><summary>查看存储标识</summary><code>{status?.partition ?? '读取中...'}</code></details>
        </div>
        <div className="storage-settings-row" data-settings-field="browser.cookie-count">
          <span>
            <strong>已保存 Cookie</strong>
            <small>仅显示数量，不展示具体站点或值</small>
          </span>
          <code>{status ? `${status.cookieCount} 个，来自 ${status.cookieDomainCount} 个域` : '读取中...'}</code>
        </div>
        </div>
      </section>

      <section className="storage-settings-section" aria-label="内置浏览器数据操作">
        <div className="storage-settings-heading">
          <strong>数据管理</strong>
          <span>操作会影响所有内置浏览器标签</span>
        </div>
        <div className="settings-card">
        <div className="storage-settings-row" data-settings-field="browser.clear-cache">
          <span>
            <strong>清除网页缓存</strong>
            <small>保留登录状态和网站本地数据，用于处理网页加载异常</small>
          </span>
          <button type="button" onClick={() => void runAction('cache')} disabled={!!busyAction}>
            {busyAction === 'cache' ? '清除中' : '清除缓存'}
          </button>
        </div>
        <div className="storage-settings-row" data-settings-field="browser.clear-data">
          <span>
            <strong>清除所有网站数据</strong>
            <small>会退出网站登录，并删除 Cookie、本地存储、IndexedDB、Service Worker 和缓存</small>
          </span>
          <button className="danger-action" type="button" onClick={() => { setError(null); setConfirmData(true) }} disabled={!!busyAction}>
            {busyAction === 'data' ? '清除中' : '清除网站数据'}
          </button>
        </div>
        </div>
      </section>

      {confirmData && createPortal(<DangerConfirmDialog
        impact={{ objectType: '内置浏览器网站数据', name: '所有内置浏览器标签共享的网站数据', removes: ['退出所有网站的登录状态', '删除 Cookie、网站本地存储和网页缓存，操作无法撤销'], preserved: ['LS 的对话、项目文件与模型配置不受影响'], inUse: '操作会影响所有已打开的内置浏览器标签。' }}
        busy={busyAction === 'data'} error={error} onCancel={() => { if (!actionPendingRef.current) setConfirmData(false) }} onConfirm={() => void runAction('data')}
      />, document.body)}
      <TransientNoticeToast notice={notice} onDismiss={clearNotice} />
      {error && <div className="storage-settings-notice" data-tone="error" role="alert">{error}</div>}
    </div>
  )
}
