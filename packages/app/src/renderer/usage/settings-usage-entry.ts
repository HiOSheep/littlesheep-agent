// 设置 → Token 用量：这一页在设置导航里的身份（O6）。
//
// 标题与说明留在用法领域，导航只决定它出现在哪一组；页面标题、侧栏条目和设置搜索
// 因此读的是同一份文本，`usage-heatmap-model.ts` 的统计口径说明也能引用它。
import type { SettingsNavItem } from '../settings/types'

/** The sidebar / search / overview entry for the heatmap page. */
export const USAGE_SETTINGS_NAV_ITEM: SettingsNavItem = {
  page: 'usage',
  title: 'Token 用量',
  desc: '跨日用量热力图、日详情与统计口径',
  searchAliases: ['热力图', '用量', 'token', '日历', '趋势', '每日用量', '输入', '输出'],
}
