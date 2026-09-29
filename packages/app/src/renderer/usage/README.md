# Renderer Token 用量

设置 → 「Token 用量」（`SettingsPage` 的 `usage` 页）的所有权说明。这一层只**读**已持久化的
Provider 用量投影，不自己统计、不自己归日、不新增任何服务端能力。

## 职责

- 把 `GET /runtime/usage/daily`（O5 契约，`packages/app/src/main/local-app-api/usage-routes.ts`）
  返回的有界日序列画成按日历周排布的年度热力图：年份与指标（总量／输入／输出）切换、
  有证据的供应商／模型筛选、图例、每日精确详情、总量／活跃天数／单日峰值、刷新、
  统计时区与覆盖说明。
- 保持 O5 契约里两个不同事实的区别：**没有记录到调用的一天**（`state: 'empty'`）不等于
  **有调用但实报为 0 的一天**（`state: 'recorded'`, `total: 0`），也不等于**有调用但没报 usage**
  （`state: 'partial'`）与**未来日期**（`state: 'future'`）。投影没有返回的日期画成
  `missing`，同样不当作 0。
- 响应自己的边界随数字一起发布：`identitiesTruncated` 在界面上说明筛选只列出用量最高的
  64 个已记录身份；覆盖不完整、陈旧投影、未建立投影都写在页面上，不由界面自行推断。

## 入口

- `settings-usage-page.tsx`：页面容器。决定请求哪一年（按 API 的 400 天上限收窄）、持有
  年份／指标／筛选状态、调用 `use-usage-heatmap.ts`、把响应转成视图模型。
- `usage-heatmap-page.tsx`：页面渲染。标题与导航条目同名；四态一律走共享
  `../ui/state-view.tsx`（`loading` / `empty` / `unavailable` 带必填原因 / `failure`）。
- `settings-usage-entry.ts`：设置导航条目与搜索别名的唯一声明，由
  `../settings/navigation.ts` 引用。
- `api/usage.ts`：Local App API 客户端（`localApiFetch` + 共享路由常量）。

## 边界

- **服务端只读**：这里不写 `packages/runner/**`、`packages/types/**`、
  `packages/app/src/main/**`，也不修改路由与契约。契约不足时应先报告，而不是在渲染层补算。
- **不重新求和**：总量、活跃天数与峰值都取响应里的 `totals`；界面只做显示格式化。
- **不猜时区**：请求不带 `timezone`，由接口默认系统时区，界面显示响应里的 `timezone` 与
  `coverage.statement`。客户端不把本地日期当成统计日期。
- **不当作零**：`missing` / `empty` / `future` 三种"没有数字"各自有独立的非颜色标记（斜线、
  空心、低透明度）与措辞，色阶只覆盖真正有记录的日期。
- 依赖方向：`../settings`（`SettingsSelect`、`SettingsNavItem` 类型）、`../ui`（状态视图）、
  `../chat/turn-usage-card`（`formatTokenCount`）、`@littlesheep/types`（O5 契约类型与上限常量）。

## 验证

- `usage-heatmap.test.ts`：日历布局（周一对齐、闰年、区间天数）、色阶阈值与图例、
  四种状态不合并、截断与会话级不匹配的拒绝、刷新失败保留旧结果，以及用
  `renderToStaticMarkup` 断言渲染出来的 `data-state` / `data-level` / `aria-label` 与
  图例、详情、roving tabindex。
- `settings-usage-entry.test.ts`：设置侧栏分组与标题、设置搜索能按用户词找到该页、
  页面标题与条目同名、网格自己横向滚动（`overflow-x: auto`，无 `!important`）。
- `packages/app/src/main/local-app-api/usage-daily-facet-bound.test.ts`（消费方新增的
  线上证据）：70 个已记录供应商的真实数据根 + 真实 loopback HTTP 请求，断言 facet 列表
  恰好被截断在 `PROVIDER_USAGE_DAILY_MAX_IDENTITIES`、`identitiesTruncated` 如实为真，
  而总量仍按 70 次尝试计——上限约束的是 facet 列表，不是用量。
