// Why the composer's model picker has nothing to select.
//
// Three different facts must not collapse into one "no model" label:
//   - the Runtime configuration never loaded (a failure, with a retry);
//   - nothing is configured yet (a first-run state, with a configuration path);
//   - providers are configured but none of them is usable (a saved key is not a
//     verified callable model), which needs the provider page, not a retry.
// `isConfiguredProvider` is the settings page's own predicate, so the composer
// and the provider list cannot disagree about what "configured" means.
import type { RuntimeState } from '../../shared/runtime-api-contracts'
import { isConfiguredProvider } from '../settings/model-provider-draft'

export type RuntimeAvailabilityKind = 'loading' | 'ready' | 'load-failed' | 'unconfigured' | 'unusable'

export interface RuntimeAvailability {
  kind: RuntimeAvailabilityKind
  /** Trigger label when there is no selectable model. */
  label: string
  /** One-sentence fact used for the trigger title and the empty menu. */
  detail: string
  /** What the user can do from here. */
  action: 'none' | 'configure' | 'retry'
  actionLabel: string
}

export interface RuntimeAvailabilityInput {
  runtime: RuntimeState | null
  /** The composer-level runtime error; with `runtime === null` it means the
   *  configuration could not be read rather than a later patch failing. */
  runtimeError: string | null
  selectableProviderCount: number
  hasSelectableModel: boolean
}

export function describeRuntimeAvailability(input: RuntimeAvailabilityInput): RuntimeAvailability {
  if (!input.runtime) {
    if (input.runtimeError) {
      return {
        kind: 'load-failed',
        label: '模型配置读取失败',
        detail: `未能读取模型配置：${input.runtimeError}`,
        action: 'retry',
        actionLabel: '重试读取',
      }
    }
    return {
      kind: 'loading',
      label: '正在读取模型配置',
      detail: '正在读取模型配置，完成后这里会显示可用模型。',
      action: 'none',
      actionLabel: '',
    }
  }

  if (!input.runtime.providers.some(isConfiguredProvider)) {
    return {
      kind: 'unconfigured',
      label: '还没有配置模型',
      detail: '还没有配置任何供应商；在 设置 → 模型供应商 里添加服务、密钥和模型。',
      action: 'configure',
      actionLabel: '配置模型',
    }
  }

  if (input.selectableProviderCount === 0 || !input.hasSelectableModel) {
    return {
      kind: 'unusable',
      label: '已配置的供应商还不可用',
      detail: '供应商已保存，但还没有可选择的模型：可能缺少 API 密钥，或没有填写模型条目。保存配置不等于已经验证可以调用。',
      action: 'configure',
      actionLabel: '检查供应商配置',
    }
  }

  return {
    kind: 'ready',
    label: '',
    detail: '',
    action: 'none',
    actionLabel: '',
  }
}
