# LS Design Language V1 — D2B 收敛报告

**范围：** 反馈语义与表单状态的小范围收敛。未重构组件体系，未改变业务反馈触发条件、内容、消失时机、交互流程或操作结果。

## 工作区基线

- D2B 开始前检查了当前工作树。已完成的 D1/D2A 改动被单独固化为基线提交 `ccf857e1 chore(ui): checkpoint design language through D2A`；其他注册 worktree 的并行工作未触碰。
- 本次 D2B 改动仍为未提交状态。结束检查时工作树只包含本报告所列的七个 D2B 源码、契约和验收脚本文件；报告文件为第八个新增文件。
- 未修改 Agent 执行、权限决策、数据模型、持久化逻辑或反馈业务流程。

## 反馈角色与消费者

| 角色 | Renderer 消费者 | 共用语义 | 有意保留的场景差异 |
| --- | --- | --- | --- |
| 字段级 | Provider editor 的 `.provider-field-error` 与输入字段 | 错误文本取 `--feedback-danger-text`；字段仍使用自己的 invalid 边框和 `aria-invalid` / `aria-describedby` 关系 | 不添加通知容器、图标或额外内边距；字段边框仍由输入控件状态负责 |
| 表单级 | Provider editor、Agent profile 压缩设置、Channel 对话框的 `FeedbackNotice` | `data-tone` 负责语义颜色与状态图标；失败 `role="alert"`，成功/信息/警告 `role="status"` | 表单错误保留在所属编辑器或对话框；保存中和重试禁用语义沿用现有实现 |
| 页面级 | 设置、归档、Channel、Memory 的 `StateView`；插件、Channel、工作区、Review 的 `FeedbackNotice`；存储、浏览器、开发环境的领域通知；MemorySkills 与 archive error | Success / Warning / Danger / Info 使用已有语义 token；失败文字使用 `--feedback-danger-text` | 容器位置、内边距、宽度和数据所有者继续由各页面决定；`StateView` 保持 loading、empty、unavailable、failure 的区别 |
| 临时 Toast | Provider、插件、Channel、设置、存储等成功路径中的 `TransientNoticeToast` | 固定玻璃浮层、状态公告、主题适配的 success 文字；错误仍为持久反馈 | Toast 保持脱离页面流，其尺寸、位置与消失时机不与页面通知统一 |
| 危险操作提示 | `DangerConfirmDialog`、可选 `.danger-confirm-inuse`；权限确认采用 D2A 已验收的专用危险操作角色 | 危险文字、底色、边框取已有主题语义；in-use 提示使用 warning 角色 | 删除确认、权限审批和警告各自保留现有布局、焦点所有权及操作路径；本阶段没有执行危险确认 |

**重复实现判断：** `.plugin-page-error`、`.archive-error`、存储通知和 MemorySkills 提示不是可互换的重复容器；它们由不同页面或领域状态拥有，保留各自几何是合理差异。`FeedbackNotice` 与 `TransientNoticeToast` 分别承载持续反馈和短暂成功，不合并。旧 `.plugin-page-notice` 没有当前 JSX 消费者，但本阶段按约束保留。

## 修改内容及原因

| 文件 | 修改 |
| --- | --- |
| `packages/app/src/renderer/styles/07-overlays-settings.css` | 统一 `FeedbackNotice` 的 info / success / warning 语义；把存储错误背景和色条接到 danger 角色；Provider key 状态徽标改用 success / warning 角色；删除确认中的 in-use 提示改用 warning 角色。保留原容器尺寸、布局、触发条件和交互。 |
| `packages/app/src/renderer/styles/09-projects-archive.css` | MemorySkills 错误边框使用 `--feedback-danger-border`；Warning 文字与边框接到现有 warning 角色。未改变对应组件状态和内容。 |
| `packages/app/src/renderer/ui-state-consistency.test.ts` | 增加对 Provider 字段错误、危险确认警告、存储错误等语义角色的契约检查，阻止源码角色退化。 |
| `packages/app/src/renderer/ui/design-language-v1.md` | 增加反馈角色映射、主题语义和有意保留的几何差异，并记录 D2B 收敛点。 |
| `scripts/verify-shared-ui-roles.mjs` | 增强真实 Electron 下深浅主题、DOM 状态、最终计算颜色/边框及截图证据检查；合成 warning/info/domain 样例明确标为 cascade-only；加入 Provider 字段错误的窄视口与 125% 字体缩放场景。 |
| `scripts/verify-async-feedback.mjs` | 修正过期 Provider 测试夹具：按准确标题定位 fixture 并打开其编辑动作，适配现有卡片/控件结构。属于验收夹具失效，不是产品交互缺陷。 |
| `scripts/verify-transient-notice-toast.mjs` | 在页面进入位移动画结束后再读取 Toast 布局基线，保留原有 ±1px 断言。此前差异来自夹具在动画开始时读取页面 top 值，不是 Toast 推动页面布局。 |

没有新增语义 token；复用 `--success`、`--success-soft`、`--warning`、`--warning-soft`、`--danger`、`--danger-soft`、`--feedback-danger-text` 与 `--feedback-danger-border`。字体、图标、提示时序、焦点与 aria 状态没有生产代码变更。

## 验收结果

### 已通过

| 验收 | 结果与证据 |
| --- | --- |
| Renderer 契约与反馈组件测试 | `pnpm exec vitest run packages/app/src/renderer/ui-state-consistency.test.ts packages/app/src/renderer/ui/feedback.test.ts packages/app/src/renderer/ui-state-matrix.test.ts`：28 tests passed。 |
| 设置字号回归 | `pnpm exec vitest run packages/app/src/renderer/settings-typography.test.ts`：7 tests passed。 |
| 真实异步反馈路径 | `pnpm run verify:async-feedback` passed：覆盖 Provider 失败/重试、设置阈值错误/成功、Channel 成功/失败、插件切换失败、工作区文件保存失败/重试。 |
| Toast 页面流与消失 | `pnpm run verify:transient-notice-toast` passed：Toast 显示期间内容顶边保持 68px，`role=status`，Toast 可见后按原时限消失；未放宽几何阈值。 |
| 深浅主题共享反馈样式 | `pnpm run verify:shared-ui-roles -- --out=...shared-ui-roles-final4`：84 checks passed，0 failures。真实场景检查 Provider 字段错误、保存/等待状态、设置和存储错误、归档错误、插件/Channel notice、Toast、双主题颜色；附 DOM、计算样式与截图。 |
| D2A 权限界面回归 | `pnpm run verify:desktop-permission-v2 -- --visual-out=...permission-v2`：30 assertions passed。深浅主题包含 full-access 危险提示的 normal / hover / focus-visible；夹具在执行确认操作前取消。 |
| 构建基线 | 最终 `pnpm run assert:app-build` passed，状态为 `fresh`；Electron 44.4.5。 |
| 补充校验 | `node --check scripts/verify-shared-ui-roles.mjs` 与 `git diff --check` passed。 |

### 计算样式与截图证据

真实 Electron 证据保存在：

`C:\Users\28971\.codex\visualizations\2026\10\17\01a147fc-30e5-7370-9ff7-a40109ab0b81\ls-design-language-v1-d2b`

- 最终共享角色验收：`after/shared-ui-roles-final4/evidence.json`，同状态截图位于 `after/shared-ui-roles-final4/screenshots/`。
- 权限危险提示：`after/permission-v2/evidence.json`、`after/permission-v2/computed/` 和 `after/permission-v2/screenshots/`。
- Toast 独立页面流证据：`after/transient-notice-toast/toast-visible.png`；其 DOM / 计算样式也记录在共享角色 `evidence.json` 中。
- 相同深色设置页错误场景的视觉对比：
  - 修改前：`before/shared-ui-roles/screenshots/storage-error.png`
  - 修改后：`after/shared-ui-roles-final4/screenshots/storage-error-dark.png`

这组前后图中，错误通知从几乎透明的面板回到 danger-soft 暗色底，并保持 danger 色条；文字、通知位置和容器尺寸不变。运行时确认 Toast 文本为 `role=status` 且使用当前主题 `--success`：深色 computed text 为 `rgb(111, 208, 140)`，浅色为 `rgb(31, 122, 67)`。Storage error 的背景与色条在两主题中分别解析为对应 danger 色；色条 computed 宽度为 1.6px，修改前亦为 1.6px，几何没有变化。

在真实 Electron Renderer 中使用 CDP 视口 800×700 和 125% 界面字号检查 Provider 字段错误，未发现水平溢出；该场景是 Renderer 视口仿真，不代表原生窗口被实际拖拽缩放。

### `unverified` 与独立阻断

以下没有真实安全的产品路径或可达夹具，未把合成 cascade 检查冒充产品验收：

- 危险删除对话框中的 live `.danger-confirm-inuse` warning：仅验证实际 CSS cascade；未触发危险确认。
- MemorySkills warning/error 与 `FeedbackNotice` info 的 live 消费场景：本轮仅验证 cascade；info 没有找到当前可用的实际消费者。
- `StateView` failure variant 的 live 强制失败展示：loading、empty/unavailable 的静态和现有场景保持检查，但 failure 未被真实产品流程强制到达。
- 未执行已知独立脚本阻断：`verify-keyboard-modal-focus.mjs` 的旧归档导航夹具，以及 `verify-chat-reading-layout.mjs` 第二轮执行未收束。这两项不计为 D2B 回归，也不标为通过；本轮 CSS 未改其场景依赖的焦点/聊天布局角色。

## D2C 判断

目前没有证据支持继续做广泛反馈容器统一，建议**暂缓 D2C 的样式收敛**。若继续，适合做小批次可达性工作：先为 warning、info、MemorySkills 与 `StateView` failure 建立不触发真实危险操作的安全 Electron fixture，测量 live computed style 和截图；只有发现实际主题、对比度或可读性不一致后再提出局部样式变更。
