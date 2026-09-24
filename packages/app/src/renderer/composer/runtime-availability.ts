// Why the composer's model picker has nothing to select.
//
// Four different facts must not collapse into one "no model" label:
//   - the Runtime configuration never loaded (a failure, with a retry);
//   - nothing is configured yet (a first-run state, with a configuration path);
//   - providers are configured but none of them is usable (a saved key is not a
//     verified callable model), which needs the provider page, not a retry;
//   - providers are usable but no model has been selected yet, which needs the
//     picker's own model list and nothing else.
// `isConfiguredProvider` is the settings page's own predicate, so the composer
// and the provider list cannot disagree about what "configured" means.
import type { RuntimeState } from '../../shared/runtime-api-contracts'
import { isConfiguredProvider } from '../settings/model-provider-draft'

export type RuntimeAvailabilityKind = 'loading' | 'ready' | 'load-failed' | 'unconfigured' | 'unusable' | 'no-selection'

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

  if (input.selectableProviderCount === 0) {
    return {
      kind: 'unusable',
      label: '已配置的供应商还不可用',
      detail: '供应商已保存，但还没有可选择的模型：可能缺少 API 密钥，或没有填写模型条目。保存配置不等于已经验证可以调用。',
      action: 'configure',
      actionLabel: '检查供应商配置',
    }
  }

  // Providers are ready and their models are offered, but nothing is selected yet.
  // This is not the "unusable" state: telling a user who just saved a key and a
  // model entry that one of them may be missing sends them back to the settings
  // page for no reason. Measured in the UX-11 walkthrough, this is exactly the
  // state after saving a usable provider for the first time.
  if (!input.hasSelectableModel) {
    return {
      kind: 'no-selection',
      label: '还没有选择模型',
      detail: '供应商已经可以使用；打开这个菜单选一个模型。',
      action: 'none',
      actionLabel: '',
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
