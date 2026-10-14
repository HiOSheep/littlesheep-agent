// Provider editor dialog: id, name, endpoint, API key and the model list.
// Pure validation lives in model-provider-draft.ts; this file only renders it.

import type { ProviderApiProtocol } from '@littlesheep/config'
import {
  REASONING_LABELS,
  createEmptyModelRow,
  declaredModelCount,
  toggleReasoningOption,
  validateProviderDraft,
  type ModelDraftRow,
  type ProviderEditorDraft,
} from './model-provider-draft'
import { RUNTIME_REASONINGS } from '../../shared/model-capabilities'
import { PROVIDER_PROTOCOL_OPTIONS, protocolHint, protocolPath } from '../../shared/provider-protocols'
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  formatTokenBudget,
} from './model-capability-defaults'
import { FeedbackNotice } from '../ui/feedback-notice'
import { useEscapeScope } from '../ui/modal-surface'

/** What the last 获取模型 attempt produced, so the result survives the render. */
export interface ModelFetchState {
  status: 'idle' | 'loading' | 'done' | 'error'
  message: string | null
}

export const IDLE_MODEL_FETCH: ModelFetchState = { status: 'idle', message: null }

interface ModelProviderEditorProps {
  draft: ProviderEditorDraft
  existingIds: string[]
  saving: boolean
  /** Content differs from the draft this editor opened with. */
  dirty: boolean
  /** The draft came back from an earlier visit to this page. */
  restored: boolean
  /** Last save failure, kept next to the actions that can retry it. */
  saveError: string | null
  /** The close entry was used with unsaved edits and is waiting for a decision. */
  discardConfirm: boolean
  /** State of the model-catalog lookup for this draft. */
  modelFetch: ModelFetchState
  /** False while the endpoint or the address is not ready for a catalog call. */
  canFetchModels: boolean
  /** Why 获取模型 cannot run; shown next to the disabled control. */
  fetchBlockedReason: string | null
  onChange: (draft: ProviderEditorDraft) => void
  onCancel: () => void
  onKeepEditing: () => void
  onDiscard: () => void
  onSave: () => void
  onFetchModels: () => void
  /** Drops one row; the row that would leave the list empty clears instead. */
  onRemoveModel: (index: number) => void
  onClearModels: () => void
}

export function ModelProviderEditor({
  draft,
  existingIds,
  saving,
  dirty,
  restored,
  saveError,
  discardConfirm,
  modelFetch,
  canFetchModels,
  fetchBlockedReason,
  onChange,
  onCancel,
  onKeepEditing,
  onDiscard,
  onSave,
  onFetchModels,
  onRemoveModel,
  onClearModels,
}: ModelProviderEditorProps) {
  const validation = validateProviderDraft(draft, existingIds)
  const isNew = draft.originalId === null
  const stateText = saving
    ? '保存中…'
    : dirty ? '已修改，尚未保存。' : restored ? '已恢复上次离开时未保存的草稿。' : null
  const modelCount = declaredModelCount(draft.models)
  const fetching = modelFetch.status === 'loading'

  // This panel is a page-level surface, not a modal dialog, so it takes Escape through
  // `useEscapeScope` and leaves Tab alone (`ui/modal-surface.ts`). Escape means the same thing the
  // close entry means: it follows one exit path, which decides for itself whether there is
  // anything to ask about. Two states have to stay out of its way, and both are expressed by not
  // registering rather than by ignoring the key once it arrives:
  //   - a save in flight (leaving would strand the result on an unmounted page);
  //   - the discard question below, which is stacked on top and owns Escape while it is open.
  useEscapeScope(onCancel, !saving && !discardConfirm)
  // Escape answers the question the way 继续编辑 does: the editor and the draft stay, and the
  // layer below is reachable again. Registering it second is what makes it the topmost layer.
  useEscapeScope(onKeepEditing, discardConfirm)

  function patch(next: Partial<ProviderEditorDraft>) {
    onChange({ ...draft, ...next })
  }

  function patchModel(index: number, next: Partial<ModelDraftRow>) {
    patch({
      models: draft.models.map((row, position) => (position === index ? { ...row, ...next } : row)),
    })
  }

  // A field the user has already touched and that is still wrong is an error; a
  // field nobody has filled in yet is guidance. Both are published on the field
  // itself (`aria-invalid` + the message under it) instead of only in a summary
  // at the bottom, which is what made a rejected save hard to act on.
  const idError = validation.field === 'id' && (dirty || restored) ? validation.error : null
  const addressError = validation.field === 'baseURL' && (dirty || restored) ? validation.error : null
  const modelsError = validation.field === 'models' && (dirty || restored) ? validation.error : null

  return (
    <div className="dialog provider-editor" role="dialog" aria-label={isNew ? '添加自定义供应商' : `编辑 ${draft.originalId}`}>
      <div className="dialog-header">
        <h2>{isNew ? '添加自定义供应商' : `编辑供应商 · ${draft.originalId}`}</h2>
        <button className="dialog-close" onClick={onCancel} disabled={saving} aria-label="关闭">×</button>
      </div>

      <div className="provider-editor-body">
        <section className="provider-editor-section" aria-label="接口">
          <div className="provider-editor-section-heading">
            <strong>接口</strong>
          </div>

          {/* Help is kept to what the control cannot say for itself. An explanation
              under every field turned this panel into a wall of grey text, which is
              what made it hard to scan: the ID rules live in the placeholder, the
              protocol's own description in its option, and the rest is dropped. */}
          <label className="settings-inline-field">
            <span>供应商 ID</span>
            <input
              value={draft.id}
              disabled={!isNew}
              placeholder="小写字母、数字、- _ .，例如 my-gw"
              aria-invalid={idError !== null}
              aria-describedby={idError ? 'provider-id-error' : undefined}
              onChange={(event) => patch({ id: event.target.value })}
            />
            {idError && (
              <small className="dialog-error provider-field-error" id="provider-id-error" role="alert">{idError}</small>
            )}
          </label>

          <label className="settings-inline-field">
            <span>显示名称</span>
            <input
              value={draft.name}
              placeholder="留空则使用供应商 ID"
              onChange={(event) => patch({ name: event.target.value })}
            />
          </label>

          <label className="settings-inline-field" data-settings-field="api.protocol">
            <span>API 协议</span>
            <select
              value={draft.api}
              title={protocolHint(draft.api)}
              aria-describedby="provider-protocol-hint"
              onChange={(event) => patch({ api: event.target.value as ProviderApiProtocol })}
            >
              {PROVIDER_PROTOCOL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            {/* Kept visible, not merely a tooltip: it is what tells the user which
                endpoint the address will be appended to. */}
            <small id="provider-protocol-hint">{protocolPath(draft.api)}</small>
          </label>

          <label className="settings-inline-field">
            <span>API 地址</span>
            <input
              value={draft.baseURL}
              placeholder="https://example.com/v1"
              aria-invalid={addressError !== null}
              aria-describedby={addressError ? 'provider-address-error' : undefined}
              onChange={(event) => patch({ baseURL: event.target.value })}
            />
            {addressError && (
              <small className="dialog-error provider-field-error" id="provider-address-error" role="alert">{addressError}</small>
            )}
          </label>

          <label className="settings-inline-field" data-settings-field="api.provider-key">
            <span>API 密钥</span>
            <input
              type="password"
              value={draft.apiKey}
              placeholder={isNew ? '粘贴密钥，或留空稍后填写' : '留空表示保持已保存的密钥'}
              onChange={(event) => patch({ apiKey: event.target.value })}
            />
            <small>留空不会清除已保存的密钥。</small>
          </label>
        </section>

        <section className="provider-model-list" aria-label="模型">
          <div className="provider-model-header">
            <div className="provider-model-title">
              <strong>模型</strong>
              {/* The count is the one number worth keeping here; the "another N blank
                  rows are not counted" caveat said more than it was worth. */}
              <small>{modelCount === 0 ? '还没有模型' : `${modelCount} 个`}</small>
            </div>
            <div className="provider-model-header-actions">
              <button
                type="button"
                className="provider-chip provider-fetch-models"
                disabled={!canFetchModels || fetching || saving}
                aria-busy={fetching}
                aria-describedby={fetchBlockedReason ? 'provider-fetch-blocked' : undefined}
                title={fetchBlockedReason ?? '请求 {API 地址}/models 并补齐下面的模型 ID'}
                onClick={onFetchModels}
              >
                {fetching ? '获取中…' : '获取模型'}
              </button>
              <button
                type="button"
                className="provider-chip"
                onClick={() => patch({ models: [...draft.models, createEmptyModelRow()] })}
              >
                ＋ 添加模型
              </button>
              {modelCount > 0 && (
                <button type="button" className="provider-chip provider-chip-quiet" onClick={onClearModels}>
                  清空
                </button>
              )}
            </div>
          </div>

          {fetchBlockedReason && (
            // A disabled control says why, in the same words as its tooltip and its
            // accessible description (settings/README.md: 禁用原因可查).
            <small className="provider-fetch-note" id="provider-fetch-blocked" role="status">{fetchBlockedReason}</small>
          )}
          {modelFetch.message && (
            <FeedbackNotice
              className="provider-fetch-result"
              feedback={{
                tone: modelFetch.status === 'error' ? 'error' : 'success',
                message: modelFetch.message,
                detail: null,
              }}
            />
          )}
          {modelsError && (
            <div className="dialog-error provider-field-error" role="alert">{modelsError}</div>
          )}

          <div className="provider-model-columns" aria-hidden="true">
            <span>模型 ID</span>
            <span>显示名称</span>
            <span>上下文窗口</span>
            <span>最大输出</span>
            <span />
          </div>
          {draft.models.length === 0 && (
            <div className="dialog-hint">还没有模型。没有模型的供应商不会出现在模型选择器里。</div>
          )}
          {draft.models.map((row, index) => (
            <div key={index} className="provider-model-row">
              {/* Each field owns its label. The wide layout shows one column header
                  instead (and hides these), the stacked layout shows them. */}
              <div className="provider-model-field">
                <span className="provider-model-field-label">模型 ID</span>
                <input
                  className="provider-model-id"
                  value={row.id}
                  placeholder="模型 ID（发送给该接口的名字）"
                  aria-label="模型 ID"
                  onChange={(event) => patchModel(index, { id: event.target.value })}
                />
              </div>
              <div className="provider-model-field">
                <span className="provider-model-field-label">显示名称</span>
                <input
                  value={row.name}
                  placeholder="显示名称"
                  aria-label={`模型 ${row.id || index + 1} 显示名称`}
                  onChange={(event) => patchModel(index, { name: event.target.value })}
                />
              </div>
              <div className="provider-model-field">
                <span className="provider-model-field-label">上下文窗口</span>
                <input
                  value={row.contextWindow}
                  inputMode="numeric"
                  placeholder={`默认 ${formatTokenBudget(DEFAULT_CONTEXT_WINDOW_TOKENS)}`}
                  aria-label={`模型 ${row.id || index + 1} 上下文窗口`}
                  onChange={(event) => patchModel(index, { contextWindow: event.target.value })}
                />
              </div>
              <div className="provider-model-field">
                <span className="provider-model-field-label">最大输出</span>
                <input
                  value={row.maxOutputTokens}
                  inputMode="numeric"
                  placeholder={`默认 ${formatTokenBudget(DEFAULT_MAX_OUTPUT_TOKENS)}`}
                  aria-label={`模型 ${row.id || index + 1} 最大输出`}
                  onChange={(event) => patchModel(index, { maxOutputTokens: event.target.value })}
                />
              </div>
              <button
                type="button"
                className="provider-model-remove"
                aria-label={row.id ? `删除模型 ${row.id}` : '删除这行模型'}
                title={draft.models.length === 1 ? '清空最后一个模型行，而不是留下一个空列表' : '删除这一行'}
                onClick={() => onRemoveModel(index)}
              >
                ×
              </button>
              <div className="provider-model-reasoning">
                <span>推理档位</span>
                {RUNTIME_REASONINGS.map((reasoning) => (
                  <button
                    key={reasoning}
                    type="button"
                    className={`provider-chip ${row.reasoningOptions.includes(reasoning) ? 'active' : ''}`}
                    aria-pressed={row.reasoningOptions.includes(reasoning)}
                    aria-label={`模型 ${row.id || index + 1} 推理档位 ${REASONING_LABELS[reasoning]}`}
                    onClick={() => patchModel(index, {
                      reasoningOptions: toggleReasoningOption(row.reasoningOptions, reasoning),
                    })}
                  >
                    {REASONING_LABELS[reasoning]}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {/* One line instead of a paragraph. The defaults are already visible as the
              field placeholders, so repeating them here only added text to skip. */}
          <small>
            留空即用默认值（{formatTokenBudget(DEFAULT_CONTEXT_WINDOW_TOKENS)}／
            {formatTokenBudget(DEFAULT_MAX_OUTPUT_TOKENS)}／全部推理档位），可直接使用。
          </small>
        </section>

        {validation.error && (
          <div className={dirty || restored ? 'dialog-error' : 'dialog-hint'}>{validation.error}</div>
        )}
        <FeedbackNotice
          className="dialog-error"
          feedback={saveError
            ? { tone: 'error', message: '保存失败，内容仍保留在编辑器里', detail: saveError }
            : null}
        />
        {stateText && <p className="provider-editor-status" role="status">{stateText}</p>}
        {discardConfirm && (
          // The close entry cannot silently drop edits: the editor is a modal, so this is the
          // only way out and the decision belongs to the user.
          <div className="provider-editor-discard" role="alertdialog" aria-label="有未保存的修改">
            <span>有未保存的修改，关闭后会丢弃。</span>
            <button type="button" className="close-btn" onClick={onKeepEditing}>继续编辑</button>
            <button type="button" className="danger-btn" onClick={onDiscard}>丢弃修改</button>
          </div>
        )}
        <p className="provider-editor-key-note">
          密钥只以内存草稿暂存，保存或取消后立即丢弃，不写入浏览器存储或日志。
        </p>
      </div>

      <div className="dialog-footer">
        <button className="close-btn" onClick={onCancel} disabled={saving}>取消</button>
        <button
          className="save-btn"
          onClick={onSave}
          disabled={saving || validation.error !== null}
          title={validation.error ?? undefined}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
