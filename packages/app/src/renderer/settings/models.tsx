// 设置 → 模型供应商：供应商卡片、密钥状态、编辑/删除和自定义供应商入口。
// 页面只通过 Local App API 读写 Main 的配置与密钥库，不自行保存任何配置。

import { useEffect, useRef, useState } from 'react'
import { deleteProvider, getRuntime, saveProvider } from '../api'
import type { RuntimeProvider, RuntimeState } from '../../shared/runtime-api-contracts'
import { providerDeletionImpact, type DeletionImpact } from '../deletion-impact'
import { DangerConfirmDialog } from '../ui/danger-confirm'
import { FeedbackNotice } from '../ui/feedback-notice'
import { IDLE_MODEL_FETCH, ModelProviderEditor, type ModelFetchState } from './model-provider-editor'
import {
  PROVIDER_TEMPLATES,
  createEmptyModelRow,
  createEmptyProviderDraft,
  createProviderDraftFromTemplate,
  declaredModelCount,
  draftFromRuntimeProvider,
  formatTokenCount,
  isConfiguredProvider,
  mergeFetchedModels,
  providerDraftIsDirty,
  toProviderDraft,
  withoutEmptyModelRow,
  type ProviderEditorDraft,
  type ProviderTemplate,
} from './model-provider-draft'
import { fetchProviderModels } from './provider-model-list-client'
import { modelFetchBlockedReason } from './provider-model-fetch-gate'
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './model-capability-defaults'
import {
  readProviderEditorSession,
  writeProviderEditorSession,
  type ProviderEditorSession,
} from './provider-editor-session'

/**
 * How many model chips a card shows before the list folds.
 *
 * Cards sit in a vertical column, so this is about keeping one provider readable
 * next to its neighbours rather than about the grid's own wrapping.
 */
const COLLAPSED_MODEL_COUNT = 12

export function SettingsModelsPage() {
  const [runtime, setRuntime] = useState<RuntimeState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProviderEditorDraft | null>(() => readProviderEditorSession()?.draft ?? null)
  const [baseline, setBaseline] = useState<ProviderEditorDraft | null>(() => readProviderEditorSession()?.baseline ?? null)
  const [draftRestored, setDraftRestored] = useState(() => readProviderEditorSession() !== null)
  /** True while the close entry asks whether unsaved edits may be discarded. */
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<{ providerId: string; impact: DeletionImpact } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [modelFetch, setModelFetch] = useState<ModelFetchState>(IDLE_MODEL_FETCH)
  const mountedRef = useRef(true)
  const requestRef = useRef(0)
  // A synchronous guard is needed because React state can be stale for two
  // confirmation clicks dispatched in the same task.
  const deletingRef = useRef(false)
  // One catalog request at a time, cancelled when the editor closes: a late answer
  // must not land in a draft the user has already left.
  const modelFetchRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    modelFetchRef.current?.abort()
    modelFetchRef.current = null
  }, [])

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
      // A failed reload must not leave an older success line next to it.
      setNotice(null)
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
  const draftDirty = draft !== null && baseline !== null && providerDraftIsDirty(draft, baseline)
  // The saved provider the draft is editing, if it exists yet: it is what tells a
  // "keep the stored key" draft apart from a key that is simply still empty.
  const savedProvider = draft?.originalId
    ? providers.find((provider) => provider.id === draft.originalId) ?? null
    : null
  const modelFetchBlockedReason = modelFetchBlocked(draft, modelFetch, savedProvider)

  function openEditor(next: ProviderEditorDraft) {
    setNotice(null)
    setError(null)
    setSaveError(null)
    setTemplateOpen(false)
    setDraftRestored(false)
    // A saved provider with no models opens an empty list; the editing row has to be
    // there for the panel to be usable, so the invariant applies on this way in too.
    const opened = next.models.length === 0 ? { ...next, models: [createEmptyModelRow()] } : next
    applyEditorSession({ draft: opened, baseline: opened })
    resetModelFetch()
  }

  /** A catalog result belongs to one draft: a new session never inherits the last one. */
  function resetModelFetch() {
    modelFetchRef.current?.abort()
    modelFetchRef.current = null
    setModelFetch(IDLE_MODEL_FETCH)
  }

  // The session store is the only copy that survives a page switch; the React
  // state below keeps the editor visible while a save is in flight.
  function applyEditorSession(next: ProviderEditorSession | null) {
    writeProviderEditorSession(next)
    setDraft(next?.draft ?? null)
    setBaseline(next?.baseline ?? null)
  }

  function changeDraft(next: ProviderEditorDraft) {
    // A draft must always keep one row to type into: `withoutEmptyModelRow` also
    // stands behind the editor's own controls, but the invariant belongs on the
    // way in, where no renderer path can get around it.
    const safe = next.models.length === 0 ? { ...next, models: [createEmptyModelRow()] } : next
    applyEditorSession({ draft: safe, baseline: baseline ?? safe })
  }

  function closeEditor() {
    // Leaving mid-save would strand the result on an unmounted page.
    if (saving) return
    // Closing with unsaved edits discards them, and that must be the user's decision rather than
    // a silent loss: the editor is a modal, so the page switch and the settings exit are both
    // unreachable while it is open (measured in the real window by `verify:provider-editor-draft`),
    // which leaves the close entry as the only way out.
    if (draftDirty) {
      setDiscardConfirm(true)
      return
    }
    resetModelFetch()
    applyEditorSession(null)
    setDraftRestored(false)
    setSaveError(null)
  }

  function keepEditing() {
    setDiscardConfirm(false)
  }

  function discardDraft() {
    setDiscardConfirm(false)
    resetModelFetch()
    applyEditorSession(null)
    setDraftRestored(false)
    setSaveError(null)
  }

  /**
   * Read the endpoint's model catalog into the draft.
   *
   * The unsaved key is what the user just typed, so it is the one this call sends.
   * A saved provider whose key lives in the keychain is deliberately not resolved
   * here — the Renderer never reads the keychain back — and `modelFetchBlocked`
   * says so on the control instead of letting an unauthenticated request fail.
   */
  async function handleFetchModels() {
    if (!draft || modelFetchRef.current) return
    const baseURL = draft.baseURL.trim()
    const apiKey = draft.apiKey.trim()
    const controller = new AbortController()
    modelFetchRef.current = controller
    setModelFetch({ status: 'loading', message: null })
    try {
      const result = await fetchProviderModels({
        baseURL,
        apiKey,
        api: draft.api,
        signal: controller.signal,
      })
      if (!mountedRef.current || modelFetchRef.current !== controller) return
      const current = readProviderEditorSession()?.draft ?? null
      if (!current || current.baseURL.trim() !== baseURL) {
        setModelFetch({ status: 'error', message: '草稿已经改变，这次结果已丢弃。请重新获取。' })
        return
      }
      if (!result.ok) {
        setModelFetch({ status: 'error', message: `获取模型失败：${result.detail}` })
        return
      }
      const merged = mergeFetchedModels(current.models, result.models)
      changeDraft({ ...current, models: merged.models })
      setModelFetch({
        status: 'done',
        message: merged.added.length > 0
          ? `已添加 ${merged.added.length} 个模型（接口共返回 ${result.models.length} 个）${keptNote(merged.kept)}`
          : `接口返回的 ${result.models.length} 个模型都已在列表中${keptNote(merged.kept)}`,
      })
    } finally {
      if (modelFetchRef.current === controller) modelFetchRef.current = null
    }
  }

  /** One row's "×": the last row clears instead of leaving the list empty. */
  function removeModelRow(index: number) {
    // Read the live draft rather than the render closure: two clicks dispatched in
    // the same task must not both filter the array they were rendered with.
    const current = readProviderEditorSession()?.draft ?? draft
    if (!current || !current.models[index]) return
    if (current.models.length <= 1) {
      changeDraft({ ...current, models: [createEmptyModelRow()] })
      return
    }
    changeDraft({ ...current, models: current.models.filter((_, position) => position !== index) })
  }

  function clearModelRows() {
    const current = readProviderEditorSession()?.draft ?? draft
    if (!current || declaredModelCount(current.models) === 0) return
    changeDraft({ ...current, models: withoutEmptyModelRow([]) })
  }

  async function handleSave() {
    if (!draft || saving) return
    const submitted = draft
    const submittedBaseline = baseline ?? submitted
    const request = toProviderDraft(submitted)
    setSaving(true)
    setError(null)
    setSaveError(null)
    // Submitting clears the session copy: an in-flight save must not come back
    // as a pending draft on a later visit, and the typed key is dropped from
    // memory once Main owns it. The visible draft stays until the result lands.
    writeProviderEditorSession(null)
    try {
      const state = await saveProvider(request)
      if (!mountedRef.current) return
      setRuntime(state)
      setDraft(null)
      setBaseline(null)
      setNotice(`已保存供应商 "${request.id}"。`)
    } catch (e) {
      if (!mountedRef.current) return
      // Keep the correctable content, both on screen and for a later visit.
      writeProviderEditorSession({ draft: submitted, baseline: submittedBaseline })
      setSaveError((e as Error).message)
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }

  async function handleDelete(provider: RuntimeProvider) {
    setError(null)
    setNotice(null)
    setDeleteError(null)
    setPendingDelete({ providerId: provider.id, impact: providerDeletionImpact(provider, runtime?.model ?? '') })
  }

  async function confirmDelete() {
    const pending = pendingDelete
    // One delete per confirmation: the dialog disables both actions in flight.
    if (!pending || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setDeleteError(null)
    try {
      const state = await deleteProvider(pending.providerId)
      if (!mountedRef.current) return
      setRuntime(state)
      setPendingDelete(null)
      setNotice(`已删除供应商 "${pending.providerId}"。`)
    } catch (e) {
      if (!mountedRef.current) return
      // Keep the dialog open with the failure so the target stays locatable.
      setDeleteError((e as Error).message)
    } finally {
      deletingRef.current = false
      if (mountedRef.current) setDeleting(false)
    }
  }

  function cancelDelete() {
    if (deletingRef.current) return
    setPendingDelete(null)
    setDeleteError(null)
  }

  return (
    <div className="settings-module-page provider-page">
      {loading && <div className="dialog-hint">加载中…</div>}
      <FeedbackNotice className="dialog-error" feedback={error ? { tone: 'error', message: '读取模型配置失败', detail: error } : null} onRetry={error ? () => void load() : undefined} />
      <FeedbackNotice feedback={notice ? { tone: 'success', message: notice, detail: null } : null} />

      {draft ? (
        // Settings keeps one panel per page: the editor replaces the list and
        // uses the workspace's flat dialog convention instead of floating over
        // the cards.
        <div className="overlay">
          <ModelProviderEditor
            draft={draft}
            existingIds={providers.map((provider) => provider.id)}
            saving={saving}
            dirty={draftDirty}
            restored={draftRestored}
            saveError={saveError}
            discardConfirm={discardConfirm}
            modelFetch={modelFetch}
            canFetchModels={modelFetchBlockedReason === null}
            fetchBlockedReason={modelFetchBlockedReason}
            onChange={changeDraft}
            onCancel={closeEditor}
            onKeepEditing={keepEditing}
            onDiscard={discardDraft}
            onSave={() => void handleSave()}
            onFetchModels={() => void handleFetchModels()}
            onRemoveModel={removeModelRow}
            onClearModels={clearModelRows}
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
            <p>这里只列出已配置的供应商。添加新的服务或补填密钥请用下面的按钮；自定义供应商使用 OpenAI 兼容接口。</p>
          </div>

          {configuredProviders.length === 0 && (
            <div className="provider-empty">
              <strong>还没有配置任何供应商</strong>
              <p>点下面任一按钮选择服务并填入 API 密钥、补上模型条目；保存成功后它才会出现在输入栏的模型选择器里。</p>
              <p>保存配置只代表写入了密钥和模型声明，不代表 LS 已经验证过它真的可以调用。</p>
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
              ＋ 添加供应商
            </button>
            <button className="provider-add" type="button" onClick={() => openEditor(createEmptyProviderDraft())}>
              ＋ 添加自定义供应商
            </button>
          </div>
        </>
      )}

      {pendingDelete && (
        <DangerConfirmDialog
          impact={pendingDelete.impact}
          busy={deleting}
          error={deleteError}
          onCancel={cancelDelete}
          onConfirm={() => void confirmDelete()}
        />
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
  const [modelsExpanded, setModelsExpanded] = useState(false)
  const keyState = !provider.requiresKey ? '无需密钥' : provider.hasKey ? '已设置' : '未设置'
  const modelCount = provider.models.length
  // A provider can list dozens of models, and every chip looked the same, so the card
  // read as "some models" without saying what was configured. The count is stated in
  // words, the preview is bounded, and the rest is one click away.
  const collapsedCount = provider.models.length > 12 ? 8 : COLLAPSED_MODEL_COUNT
  const hiddenCount = Math.max(0, modelCount - collapsedCount)
  const visibleModels = modelsExpanded ? provider.models : provider.models.slice(0, collapsedCount)
  // Models whose numbers came from LS's defaults rather than from a declaration.
  const assumedCount = provider.models.filter((model) => model.assumedDefaults).length

  return (
    <div className="provider-card">
      <div className="provider-card-main">
        <div className="provider-card-title">
          <strong>{provider.name}</strong>
          {!provider.builtin && <span className="provider-badge">自定义</span>}
          <span className={`key-badge ${provider.hasKey || !provider.requiresKey ? 'set' : 'unset'}`}>{keyState}</span>
          <span className="provider-model-count">
            {modelCount === 0 ? '未配置模型' : `${modelCount} 个模型`}
          </span>
        </div>
        <div className="provider-url">{provider.baseURL}</div>
        <div className="provider-meta">
          {provider.models.length === 0
            ? '尚未添加模型。没有模型的供应商不会出现在模型选择器里。'
            : visibleModels.map((model) => (
              <span key={model.id} className="provider-model-chip" title={model.id}>
                {model.name}
                {/* An assumed window is labelled as one. Showing "256K" flat would
                    read as a vendor fact, and the user may still want to replace it. */}
                <em className={model.assumedDefaults ? 'provider-model-chip-assumed' : undefined}>
                  {model.assumedDefaults
                    ? `约 ${formatTokenCount(model.contextWindow)}`
                    : formatTokenCount(model.contextWindow)}
                </em>
              </span>
            ))}
        </div>
        {/* The collapsed preview stops mid-grid, and the count is repeated here because
            "还有 32 个" is what tells the user how much is behind the fold. */}
        {(hiddenCount > 0 || assumedCount > 0) && (
          <div className="provider-card-notes">
            {hiddenCount > 0 && (
              <button
                type="button"
                className="provider-models-toggle"
                aria-expanded={modelsExpanded}
                onClick={() => setModelsExpanded((current) => !current)}
              >
                {modelsExpanded ? '收起模型列表' : `还有 ${hiddenCount} 个模型，展开全部`}
              </button>
            )}
            {assumedCount > 0 && (
              // The numbers exist so the model is usable, but they are LS's defaults,
              // not this model's measured window. Saying so is what keeps an
              // assumption from being read as a vendor fact.
              <small className="provider-card-note">
                {assumedCount} 个模型未填写上下文窗口，按默认 {formatTokenCount(DEFAULT_CONTEXT_WINDOW_TOKENS)} 估算（标为“约”）；
                知道准确数值时建议在编辑里填写。这些模型不显示本地精确 token 计数。
              </small>
            )}
          </div>
        )}
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
      <div className="dialog provider-template-picker" role="dialog" aria-label="添加供应商">
        <div className="dialog-header">
          <h2>添加供应商</h2>
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

/**
 * Why 获取模型 cannot run right now, or null when it can. See
 * `provider-model-fetch-gate.ts` for the rule and the states it separates.
 */
function modelFetchBlocked(
  draft: ProviderEditorDraft | null,
  modelFetch: ModelFetchState,
  savedProvider: RuntimeProvider | null,
): string | null {
  return modelFetchBlockedReason({ draft, fetching: modelFetch.status === 'loading', savedProvider })
}

/** Names the existing rows a catalog did not mention, so "kept" is never silent. */
function keptNote(kept: readonly string[]): string {
  return kept.length > 0 ? `；接口未列出的 ${kept.length} 个模型已保留` : ''
}
