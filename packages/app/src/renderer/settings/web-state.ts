import type { RuntimeWebState } from '../../shared/runtime-api-contracts'

export function statusLabel(web: RuntimeWebState): string {
  if (web.status === 'disabled') return '已关闭'
  if (web.status === 'unconfigured') return '搜索服务未配置'
  if (web.status === 'configured_unchecked') return `${web.providerId ?? '搜索服务'} 已配置，尚未检查`
  if (web.status === 'ready') return `${web.providerId ?? '搜索服务'} 可用`
  if (web.status === 'degraded') return '部分可用'
  return '不可用'
}
