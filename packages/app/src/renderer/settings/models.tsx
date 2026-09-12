// 设置 → 模型供应商：供应商卡片、密钥状态、编辑/删除和自定义提供方入口。
// 页面只通过 Local App API 读写 Main 的配置与密钥库，不自行保存任何配置。

import { useEffect, useRef, useState } from 'react'
import { deleteProvider, getRuntime, saveProvider } from '../api'
import type { RuntimeProvider, RuntimeState } from '../../shared/runtime-api-contracts'
import { ModelProviderEditor } from './model-provider-editor'
import {
  PROVIDER_TEMPLATES,
  createEmptyProviderDraft,
  createProviderDraftFromTemplate,
  draftFromRuntimeProvider,
  formatTokenCount,
  isConfiguredProvider,
  toProviderDraft,
  type ProviderEditorDraft,
  type ProviderTemplate,
} from './model-provider-draft'

export function SettingsModelsPage() {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderEditorDraft | null>(null)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
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
    void load()
  }, [])

  async function load() {
    const requestId = ++requestRef.current
    setLoading(true)
    try {
      const state = await getRuntime()
      if (!mountedRef.current || requestId !== requestRef.current) return
      setRuntime(state)
      setError(null)
    } catch (e) {
      if (!mountedRef.current || requestId !== requestRef.current) return
      setError((e as Error).message)
    } finally {
      if (mountedRef.current && requestId === requestRef.current) setLoading(false)
    }
  }

  const providers = runtime?.providers ?? []
  const configuredProviders = providers.filter(isConfiguredProvider)
  const unconfiguredPresets = providers.filter(
    (provider) => provider.builtin && !isConfiguredProvider(provider),
  )

  function openEditor(next: ProviderEditorDraft) {
    setNotice(null)
    setError(null)
    setTemplateOpen(false)
    setDraft(next)
  }

  async function handleSave() {
    if (!draft) return
    setSaving(true)
    setError(null)
    try {
      const state = await saveProvider(toProviderDraft(draft))
      if (!mountedRef.current) return
      setRuntime(state)
      setDraft(null)
      setNotice(`已保存供应商 "${toProviderDraft(draft).id}"。`)
    } catch (e) {
      if (!mountedRef.current) return
      setError((e as Error).message)
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  async function handleDelete(provider: RuntimeProvider) {
    setError(null)
    try {
      const state = await deleteProvider(provider.id)
      if (!mountedRef.current) return
      setRuntime(state)
      setNotice(`已删除供应商 "${provider.id}"。`)
    } catch (e) {
      if (!mountedRef.current) return
      setError((e as Error).message)
    }
  }

  return (
    <div className="settings-module-page provider-page">
      {loading && <div className="dialog-hint">加载中…</div>}
      {error && <div className="dialog-error">{error}</div>}
      {notice && <div className="dialog-hint">{notice}</div>}

      {draft ? (
        // Settings keeps one panel per page: the editor replaces the list and
        // uses the workspace's flat dialog convention instead of floating over
        // the cards.
        <div className="overlay">
          <ModelProviderEditor
            draft={draft}
            existingIds={providers.map((provider) => provider.id)}
            saving={saving}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onSave={() => void handleSave()}
          />
        </div>
      ) : templateOpen ? (
        <TemplatePicker
          presets={unconfiguredPresets}
          onPick={(template) => openEditor(createProviderDraftFromTemplate(template))}
          onPickPreset={(provider) => openEditor(draftFromRuntimeProvider(provider))}
          onClose={() => setTemplateOpen(false)}
        />
      ) : (
        <>
          <div className="settings-module-heading">
            <h2>模型供应商</h2>
            <p>这里只列出已配置的供应商。添加新的服务或补填密钥请用下面的按钮；自定义提供方使用 OpenAI 兼容接口。</p>
          </div>

          {configuredProviders.length === 0 && (
            <div className="provider-empty">
              <strong>还没有配置任何供应商</strong>
              <p>点下面任一按钮选择服务并填入 API 密钥，之后就能在输入栏的模型选择器里看到它的模型。</p>
            </div>
          )}

          <div className="provider-cards">
            {configuredProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                onEdit={() => openEditor(draftFromRuntimeProvider(provider))}
                onDelete={() => void handleDelete(provider)}
              />
            ))}
          </div>

          <div className="provider-actions">
            <button className="provider-add" type="button" onClick={() => setTemplateOpen(true)}>
              ＋ 添加提供方
            </button>
            <button className="provider-add" type="button" onClick={() => openEditor(createEmptyProviderDraft())}>
              ＋ 添加自定义提供方
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function ProviderCard({
  provider,
  onEdit,
  onDelete,
}: {
  provider: RuntimeProvider
  onEdit: () => void
  onDelete: () => void
}) {
  const keyState = !provider.requiresKey ? '无需密钥' : provider.hasKey ? '已设置' : '未设置'
  return (
    <div className="provider-card">
      <div className="provider-card-main">
        <div className="provider-card-title">
          <strong>{provider.name}</strong>
          {!provider.builtin && <span className="provider-badge">自定义</span>}
          <span className={`key-badge ${provider.hasKey || !provider.requiresKey ? 'set' : 'unset'}`}>{keyState}</span>
        </div>
        <div className="provider-url">{provider.baseURL}</div>
        <div className="provider-meta">
          {provider.models.length === 0
            ? '尚未添加模型'
            : provider.models.map((model) => (
              <span key={model.id} className="provider-model-chip" title={model.id}>
                {model.name}
                <em>{formatTokenCount(model.contextWindow)}</em>
              </span>
            ))}
        </div>
      </div>
      <div className="provider-card-actions">
        <button type="button" className="save-btn" onClick={onEdit}>编辑</button>
        {!provider.builtin && (
          <button type="button" className="provider-remove" onClick={onDelete}>删除</button>
        )}
      </div>
    </div>
  )
}

function TemplatePicker({
  presets,
  onPick,
  onPickPreset,
  onClose,
}: {
  presets: RuntimeProvider[]
  onPick: (template: ProviderTemplate) => void
  onPickPreset: (provider: RuntimeProvider) => void
  onClose: () => void
}) {
  return (
    <div className="overlay">
      <div className="dialog provider-template-picker" role="dialog" aria-label="添加提供方">
        <div className="dialog-header">
          <h2>添加提供方</h2>
          <button className="dialog-close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="dialog-hint">模板只预填接口地址；模型 ID 由你按账号实际可用的名字填写。</div>
        {presets.length > 0 && (
          <>
            <div className="provider-template-group">未配置的内置供应商</div>
            <div className="provider-template-list">
              {presets.map((provider) => (
                <button key={provider.id} type="button" className="provider-template" onClick={() => onPickPreset(provider)}>
                  <strong>{provider.name}</strong>
                  <small>{provider.baseURL}</small>
                  <em>{`${provider.models.length} 个内置模型`}</em>
                </button>
              ))}
            </div>
            <div className="provider-template-group">其他 OpenAI 兼容服务</div>
          </>
        )}
        <div className="provider-template-list">
          {PROVIDER_TEMPLATES.map((template) => (
            <button key={template.id} type="button" className="provider-template" onClick={() => onPick(template)}>
              <strong>{template.name}</strong>
              <small>{template.baseURL}</small>
              <em>{template.note}</em>
            </button>
          ))}
        </div>
        <div className="dialog-footer">
          <button className="close-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
