// Provider editor dialog: id, name, endpoint, API key and the model list.
// Pure validation lives in model-provider-draft.ts; this file only renders it.

import {
  REASONING_LABELS,
  createEmptyModelRow,
  toggleReasoningOption,
  validateProviderDraft,
  type ModelDraftRow,
  type ProviderEditorDraft,
} from './model-provider-draft'
import { RUNTIME_REASONINGS } from '../../shared/model-capabilities'
import { FeedbackNotice } from '../ui/feedback-notice'

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
  onChange: (draft: ProviderEditorDraft) => void
  onCancel: () => void
  onKeepEditing: () => void
  onDiscard: () => void
  onSave: () => void
}

export function ModelProviderEditor({
  draft,
  existingIds,
  saving,
  dirty,
  restored,
  saveError,
  discardConfirm,
  onChange,
  onCancel,
  onKeepEditing,
  onDiscard,
  onSave,
}: ModelProviderEditorProps) {
  const validation = validateProviderDraft(draft, existingIds)
  const isNew = draft.originalId === null
  const stateText = saving
    ? '保存中…'
    : dirty ? '已修改，尚未保存。' : restored ? '已恢复上次离开时未保存的草稿。' : null

  function patch(next: Partial<ProviderEditorDraft>) {
    onChange({ ...draft, ...next })
  }

  function patchModel(index: number, next: Partial<ModelDraftRow>) {
    patch({
      models: draft.models.map((row, position) => (position === index ? { ...row, ...next } : row)),
    })
  }

  return (
    <div className="dialog provider-editor" role="dialog" aria-label={isNew ? '添加自定义供应商' : `编辑 ${draft.originalId}`}>
      <div className="dialog-header">
        <h2>{isNew ? '添加自定义供应商' : `编辑供应商 · ${draft.originalId}`}</h2>
        <button className="dialog-close" onClick={onCancel} disabled={saving} aria-label="关闭">×</button>
      </div>

      <div className="provider-editor-body">
        <label className="settings-inline-field">
          <span>供应商 ID</span>
          <input
            value={draft.id}
            disabled={!isNew}
            placeholder="例如 openrouter、my-gw"
            onChange={(event) => patch({ id: event.target.value })}
          />
        </label>

        <label className="settings-inline-field">
          <span>显示名称</span>
          <input
            value={draft.name}
            placeholder="留空则使用供应商 ID"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>

        <label className="settings-inline-field">
          <span>API 地址</span>
          <input
            value={draft.baseURL}
            placeholder="https://example.com/v1"
            onChange={(event) => patch({ baseURL: event.target.value })}
          />
        </label>

        <label className="settings-inline-field">
          <span>API 密钥</span>
          <input
            type="password"
            value={draft.apiKey}
            placeholder={isNew ? '粘贴密钥，或留空稍后填写' : '留空表示保持已保存的密钥'}
            onChange={(event) => patch({ apiKey: event.target.value })}
          />
          <small>密钥保存到系统密钥库，配置文件只保留引用；留空不会清除已有密钥。</small>
        </label>

        <div className="provider-model-list">
          <div className="provider-model-header">
            <strong>模型</strong>
            <button type="button" className="provider-chip" onClick={() => patch({ models: [...draft.models, createEmptyModelRow()] })}>
              ＋ 添加模型
            </button>
          </div>
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
                  aria-label="显示名称"
                  onChange={(event) => patchModel(index, { name: event.target.value })}
                />
              </div>
              <div className="provider-model-field">
                <span className="provider-model-field-label">上下文窗口</span>
                <input
                  value={row.contextWindow}
                  inputMode="numeric"
                  placeholder="上下文窗口"
                  aria-label="上下文窗口"
                  onChange={(event) => patchModel(index, { contextWindow: event.target.value })}
                />
              </div>
              <div className="provider-model-field">
                <span className="provider-model-field-label">最大输出</span>
                <input
                  value={row.maxOutputTokens}
                  inputMode="numeric"
                  placeholder="最大输出"
                  aria-label="最大输出"
                  onChange={(event) => patchModel(index, { maxOutputTokens: event.target.value })}
                />
              </div>
              <button
                type="button"
                className="provider-model-remove"
                aria-label="删除模型"
                onClick={() => patch({ models: draft.models.filter((_, position) => position !== index) })}
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
          <small>
            上下文窗口、最大输出和推理档位是可选声明。留空的项保持未知，LS 不会替模型猜数值，
            也不会显示本地精确 token 计数。
          </small>
        </div>

        {validation.error && <div className="dialog-error">{validation.error}</div>}
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
          密钥只会以内存草稿的形式随本页暂时保留，保存或取消后立即丢弃；它不会写入浏览器存储或日志。
        </p>
      </div>

      <div className="dialog-footer">
        <button className="close-btn" onClick={onCancel} disabled={saving}>取消</button>
        <button
          className="save-btn"
          onClick={onSave}
          disabled={saving || validation.error !== null}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
