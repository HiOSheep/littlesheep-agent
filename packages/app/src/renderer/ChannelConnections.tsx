import { useEffect, useState } from 'react'
import { getChannelConnectionsStatus, reloadChannelConnections, type ChannelConnectionsStatus } from './api'

interface ChannelConnectionsProps {
  onClose: () => void
  embedded?: boolean
}

export function ChannelConnections({ onClose, embedded = false }: ChannelConnectionsProps) {
  const [status, setStatus] = useState<ChannelConnectionsStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [reloadMsg, setReloadMsg] = useState<string | null>(null)

  useEffect(() => {
    void loadStatus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function loadStatus() {
    setLoading(true)
    try {
      setStatus(await getChannelConnectionsStatus())
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function handleReload() {
    setReloading(true)
    setReloadMsg(null)
    try {
      await reloadChannelConnections()
      setReloadMsg('外部渠道已重新加载')
      await loadStatus()
    } catch (e) {
      setReloadMsg(`重新加载失败: ${(e as Error).message}`)
    } finally {
      setReloading(false)
    }
  }

  return (
    <div className="overlay" onClick={embedded ? undefined : onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>渠道连接</h2>
          {!embedded && <button className="dialog-close" onClick={onClose}>×</button>}
        </div>

        {loading && <div className="dialog-hint">正在加载...</div>}
        {error && <div className="dialog-error">{error}</div>}
        {reloadMsg && (
          <div className={reloadMsg.includes('失败') ? 'dialog-error' : 'dialog-hint'}>
            {reloadMsg}
          </div>
        )}

        {!loading && status && (
          <>
            <div className="channel-overall">
              <span className={`channel-badge ${status.channels.length > 0 ? 'running' : 'stopped'}`}>
                {status.channels.length > 0 ? '外部渠道运行中' : '未启用外部渠道'}
              </span>
              <button className="refresh-btn" onClick={() => void loadStatus()} disabled={reloading}>
                刷新
              </button>
              <button className="reload-btn" onClick={() => void handleReload()} disabled={reloading}>
                {reloading ? '重新加载中...' : '重新加载'}
              </button>
            </div>

            {status.channels.length > 0 && (
              <div className="channel-section">
                <h3>运行中的渠道 ({status.channels.length})</h3>
                {status.channels.map((ch, i) => (
                  <div key={i} className="channel-row">
                    <span className={`channel-dot ${ch.running ? 'on' : 'off'}`} />
                    <span className="channel-name">{ch.displayName}</span>
                    <span className="channel-type">{ch.type}</span>
                  </div>
                ))}
              </div>
            )}

            {status.configured.length > 0 && (
              <div className="channel-section">
                <h3>已配置渠道 ({status.configured.length})</h3>
                {status.configured.map((c) => (
                  <div key={c.id} className="channel-row config">
                    <span className={`channel-dot ${c.enabled ? 'enabled' : 'disabled'}`} />
                    <span className="channel-name">{c.name ?? c.id}</span>
                    <span className="channel-type">{c.type}</span>
                    {!c.enabled && <span className="channel-tag">已禁用</span>}
                  </div>
                ))}
              </div>
            )}

            {status.configured.length === 0 && (
              <div className="dialog-hint">
                暂未配置外部渠道。可在 config.json 的 channels.channels 中添加。
              </div>
            )}
          </>
        )}

        {!embedded && (
          <div className="dialog-footer">
            <button className="close-btn" onClick={onClose}>关闭</button>
          </div>
        )}
      </div>
    </div>
  )
}
