import { useEffect, useRef, useState } from 'react'
import { getProviders, saveApiKey, type ProviderInfo } from './api'

interface SettingsProps {
  onClose: () => void
  embedded?: boolean
}

export function Settings({ onClose, embedded = false }: SettingsProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
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
    void loadProviders()
  }, [])

  // ESC key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  async function loadProviders() {
    const requestId = ++requestRef.current
    setLoading(true)
    try {
      const list = await getProviders()
      if (!mountedRef.current || requestId !== requestRef.current) return
      setProviders(list)
    } catch (e) {
      if (!mountedRef.current || requestId !== requestRef.current) return
      setError((e as Error).message)
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false)
    }
  }

  async function handleSave(envVar: string) {
    const key = keys[envVar]?.trim()
    if (!key) return
    setSaving(envVar)
    setError(null)
    try {
      await saveApiKey(envVar, key)
      if (!mountedRef.current) return
      setKeys((k) => ({ ...k, [envVar]: '' }))
      await loadProviders()
    } catch (e) {
      if (!mountedRef.current) return
      setError((e as Error).message)
    } finally {
      if (mountedRef.current) setSaving(null)
    }
  }

  return (
    <div className="overlay" onClick={embedded ? undefined : onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2>API 密钥配置</h2>
          {!embedded && <button className="dialog-close" onClick={onClose}>×</button>}
        </div>

        {loading && <div className="dialog-hint">加载中…</div>}
        {error && <div className="dialog-error">{error}</div>}

        {!loading && providers.length === 0 && (
          <div className="dialog-hint">未配置任何 Provider。请编辑 config.json 添加 Provider。</div>
        )}

        {providers.map((p) => {
          const envVar = p.envVar
          const canEdit = envVar !== null
          const isSaving = saving === envVar
          const inputValue = envVar ? (keys[envVar] ?? '') : ''
          const isShown = envVar ? (showKey[envVar] ?? false) : false

          return (
            <div key={p.id} className="provider-row">
              <div className="provider-info">
                <div className="provider-name">{p.name ?? p.id}</div>
                <div className="provider-url">{p.baseURL}</div>
              </div>
              <div className="provider-status">
                {p.source === 'env' && (
                  <span className={`key-badge ${p.hasKey ? 'set' : 'unset'}`}>
                    {p.hasKey ? '已设置' : '未设置'}
                  </span>
                )}
                {p.source === 'literal' && (
                  <span className="key-badge literal">硬编码</span>
                )}
                {p.source === 'none' && (
                  <span className="key-badge literal">未配置</span>
                )}
              </div>
              <div className="provider-input">
                {canEdit ? (
                  <>
                    <input
                      type={isShown ? 'text' : 'password'}
                      value={inputValue}
                      onChange={(e) =>
                        setKeys((k) => ({ ...k, [envVar!]: e.target.value }))
                      }
                      placeholder={`${envVar}`}
                      disabled={isSaving}
                    />
                    <button
                      className="toggle-btn"
                      onClick={() =>
                        setShowKey((s) => ({ ...s, [envVar!]: !s[envVar!] }))
                      }
                      type="button"
                    >
                      {isShown ? '隐藏' : '显示'}
                    </button>
                    <button
                      className="save-btn"
                      onClick={() => void handleSave(envVar!)}
                      disabled={isSaving || !inputValue.trim()}
                    >
                      {isSaving ? '保存中…' : '保存'}
                    </button>
                  </>
                ) : (
                  <span className="provider-noedit">
                    {p.source === 'literal'
                      ? '密钥已硬编码于配置文件'
                      : '配置文件未声明 apiKey 字段'}
                  </span>
                )}
              </div>
            </div>
          )
        })}

        {!embedded && (
          <div className="dialog-footer">
            <button className="close-btn" onClick={onClose}>关闭</button>
          </div>
        )}
      </div>
    </div>
  )
}
