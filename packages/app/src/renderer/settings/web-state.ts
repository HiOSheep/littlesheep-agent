import type { RuntimeWebState } from '../../shared/runtime-api-contracts'
import type { SettingsOption } from './select'

/**
 * 读取策略四个下拉的选项。
 *
 * 页面渲染它们、字段搜索索引读取它们的当前值——同一份定义，所以“索引显示的值”和“用户在页面上
 * 看到的值”不可能各说一套（S3：搜索数据复用字段定义，不维护第二套目录）。
 */
export const WEB_READ_MODE_OPTIONS: readonly SettingsOption<RuntimeWebState['readMode']>[] = [
  { value: 'public_anonymous', label: '公开匿名读取' },
  { value: 'configured_allowlist', label: '仅允许域名' },
  { value: 'disabled', label: '关闭读取' },
]

export const WEB_DNS_RESOLVER_OPTIONS: readonly SettingsOption<RuntimeWebState['dnsResolver']>[] = [
  { value: 'system', label: '系统 DNS' },
  { value: 'cloudflare_doh', label: 'Cloudflare DoH' },
]

export const WEB_SENSITIVE_QUERY_OPTIONS: readonly SettingsOption<RuntimeWebState['sensitiveQueryPolicy']>[] = [
  { value: 'approve', label: '外发前确认' },
  { value: 'redact', label: '脱敏后发送' },
  { value: 'deny', label: '拒绝外发' },
  { value: 'allow', label: '直接发送' },
]

export const WEB_BROWSER_FALLBACK_OPTIONS: readonly SettingsOption<RuntimeWebState['browserFallback']>[] = [
  { value: 'approval_required', label: '需要批准' },
  { value: 'full_only', label: '仅完全访问' },
  { value: 'disabled', label: '禁用' },
]

export function statusLabel(web: RuntimeWebState): string {
  if (web.status === 'disabled') return '已关闭'
  if (web.status === 'unconfigured') return '搜索服务未配置'
  if (web.status === 'configured_unchecked') return `${web.providerId ?? '搜索服务'} 已配置，尚未检查`
  if (web.status === 'ready') return `${web.providerId ?? '搜索服务'} 可用`
  if (web.status === 'degraded') return '部分可用'
  return '不可用'
}

/** The five facts that make the "检查 Tavily 连接" control refuse to act. */
export interface WebProviderCheckGate {
  /** A check is already running. */
  checking: boolean
  /** The key is being written. */
  savingKey: boolean
  providerConfigured: boolean
  enabled: boolean
  readMode: RuntimeWebState['readMode']
}

/**
 * Why the connection check cannot run, or `null` when it can.
 *
 * The button used to be disabled by a five-term boolean with nothing said about
 * which term was true, so "greyed out" was the whole message (V3: 禁用原因可查).
 * The reason is derived from the same facts the button is disabled by, so the
 * two cannot disagree; `web-disabled-reason.test.ts` pins that equivalence.
 */
export function webProviderCheckBlockedReason(gate: WebProviderCheckGate): string | null {
  if (gate.checking) return '正在检查连接，完成后可以再次检查。'
  if (gate.savingKey) return '正在保存密钥，保存完成后可以检查。'
  if (!gate.providerConfigured) return '还没有配置搜索服务，先保存 Tavily 密钥再检查。'
  if (!gate.enabled) return '网络检索当前是关闭的，先在上方打开“实时资料”。'
  if (gate.readMode === 'disabled') return '公开读取模式是“关闭读取”，改成允许读取后才能检查。'
  return null
}
