# LS Design Language V1 — D3 整体视觉验收与阶段收官

日期：2026-10-17。唯一设计契约基线：[`design-language-v1.md`](./design-language-v1.md)。本批不启动 V2，不引入 UI 框架，不改 Agent 执行、权限决策、记忆、数据模型或持久化逻辑。

## 阶段检查点

D3 开始时 HEAD 为 `038dd97c chore(ui): close design language D2B`，其父提交是 `ccf857e1 chore(ui): checkpoint design language through D2A`。D2B 的七个源码/脚本文件与新增报告已由 `038dd97c` 单独提交；提交前后均未推送或合并其他工作。

D2B 检查点包含：

1. `packages/app/src/renderer/styles/07-overlays-settings.css`
2. `packages/app/src/renderer/styles/09-projects-archive.css`
3. `packages/app/src/renderer/ui-state-consistency.test.ts`
4. `packages/app/src/renderer/ui/design-language-v1.md`
5. `scripts/verify-shared-ui-roles.mjs`
6. `scripts/verify-async-feedback.mjs`
7. `scripts/verify-transient-notice-toast.mjs`
8. 新增报告 `packages/app/src/renderer/ui/design-language-v1-d2b-report.md`

D3 修改只涉及设置页危险确认框样式、键盘弹窗验收夹具、共享 UI 验收夹具及本报告。D3 改动尚未提交；没有其他工作流改动混入。

## D0–D3 完成情况

| 阶段 | 状态 | 交付与结论 |
| --- | --- | --- |
| D0 现状审计 | 已完成 | 基于 Renderer、共享组件、样式来源及可运行界面建立现状基线；D1 契约保留来源事实、运行时事实和例外的区分。 |
| D1 契约与验收基线 | 已完成 | `design-language-v1.md` 固化颜色、字体、尺寸、形状、材质、组件状态及主题角色；相关运行时断言按最终计算样式修复。 |
| D2A 操作控件 | 已完成 | 普通、主要、危险操作分别复用既有角色；设置页紧凑操作、Permission V2 与场景特定密度保留。验收证据归档于 D2A 报告与目录，阶段代码由 `ccf857e1` 固化。 |
| D2B 反馈与表单状态 | 已完成 | 反馈角色复用现有语义色 token；字段错误、页面反馈、Toast 与危险提示保持各自容器职责；阶段代码和报告由 `038dd97c` 固化。 |
| D3 整体验收 | 已完成 | 当前 Electron 覆盖菜单、Context Inspector、Provider/设置反馈、MemorySkills 与安全打开并取消的危险确认；修复设置页危险确认框被错误压平成行内内容的问题。聊天第二轮未收束作为独立执行阻断保留。 |

## 当前 V1 设计角色与有意例外

| 角色 | 当前基线 | D3 结论 |
| --- | --- | --- |
| 全局基础色与主题 | `--bg`、`--surface`、`--text`、`--border`、`--accent`、`--danger`、`--success`、`--warning` 等全局角色；深浅/自定义主题在现有主题变量层映射 | 代表性的深浅主题截图与运行时计算样式通过。 |
| 通用控件 | 常用操作高度 `--control-height-md` = 34px；常规与强调字号通过 `--control-font-size` / `--control-font-size-strong` 缩放 | 当前 Provider、设置及操作状态验收通过。 |
| 紧凑操作 | 通知小操作 26px、设置行内操作 30px；图标、行、选择器仍按各自密度设计 | 保留为明确场景例外，不强制套用 34px。 |
| 反馈语义 | 成功、警告、危险、信息复用现有语义 token；字段错误使用 `--feedback-danger-text` | StateView failure、MemorySkills warning、Provider 字段错误、设置/插件/渠道/存储/归档反馈均有运行时证据。 |
| Context Inspector | 紧凑诊断文字和 5px 内角使用诊断角色；外层工作区保留原有圆角和边界 | 空态、总览、详情、部分数据及运行中场景均有深浅主题截图与 21 项断言。 |
| 材质与层级 | Composer、侧边栏、聊天阅读区、设置页和诊断面板保留各自材质、密度及层级 | 未发现需要全站统一材质或几何的证据；不建议为追求统一而启动广泛 D2C。 |

没有新建设计 token，也没有修改 D1/D2B 设计契约。D3 修复落实的是现有 `DangerConfirmDialog` 的模态语义，不新增控件角色。

## 本批确认并修复的问题

**设置页危险确认框在实际界面中被显示成页面内联内容。** `.settings-workspace .overlay` 会把设置页内所有 `.overlay` 改为 `position: relative`、透明背景和普通块布局。共享 `DangerConfirmDialog` 同时声明 `role="alertdialog"`、`aria-modal="true"` 并启用焦点陷阱，因此这种级联让实际可见遮罩与模态语义不一致。修改前截图显示确认框位于供应商卡片下方，背景仍清晰可交互。

本批只给该确认层增加 `danger-confirm-overlay` 标记，并在设置页局部恢复既有遮罩层和确认框尺寸：固定覆盖视口、背景遮罩/模糊、居中、最大宽度 460px。没有更改删除回调、权限或确认路径。深浅主题真实 Electron 结果均检查到视口覆盖误差不超过 1px、背景 `rgba(0, 0, 0, 0.45)`、`blur(8px)`、对话框居中；warning 文本、底色、边框、圆角分别解析为当前主题的 `--warning`、`--warning-soft`、warning 混合边框与 `--radius-ui`。两个主题均通过后，夹具只点击“取消”，Provider 仍存在。

## Electron 验收矩阵

状态含义：**passed** 表示场景到达并通过断言；**failed** 表示该项脚本没有完整完成；**unverified** 表示本批未到达或未执行；**intentionally excluded** 表示为遵守安全边界而明确不触发。

| 区域 / 场景 | 状态 | 证据与边界 |
| --- | --- | --- |
| 侧边栏、聊天阅读、Composer 断点和滚动 | **failed（独立执行阻断）** | D3 当前 Electron 的 `chat-reading/report.json` 有 5 项先行通过，包括 Composer 700/560/390px 布局断点、正在运行标签、底部滚动动画、发送后定位及半透明输入层滚动裁切；随后第二条合成对话请求等待 settled response 超时。`failure.png`、Assistant running 截图及 DOM/计算样式保留。它与既有 Agent/Runner 第二轮执行未收束一致；本批不改执行链路，也不将其记为样式回归。 |
| Context Inspector | **passed** | 当前 D3 Electron 21 项检查通过；空态、总览、详情、部分数据、活动态均有深浅主题截图，并检查窗口边界、草稿/滚动保留、ARIA/隐私及数据源隔离。 |
| Context menus | **passed** | 当前 D3 Electron 64 项检查通过；覆盖输入、会话、项目、消息、文件树、工作区标签和终端菜单，含深浅主题、窄菜单、焦点、复制/粘贴、失败删除及取消确认；剪贴板恢复为真。失败删除路径使用隔离 fixture 的注入 503 响应，没有删除会话。 |
| Provider 与设置页操作控件 | **passed** | 当前 D3 共享角色 Electron 共 98 项通过、0 失败；包括 Provider 字段错误、正常/悬停/按下/键盘焦点、保存中禁用、设置/插件/渠道/存储/归档反馈、Toast 与 800×700 Renderer 视口及 125% 仅视觉字号覆盖。该字号场景是 CDP 视口模拟，不等同于系统级显示缩放。 |
| Provider 删除 warning | **passed** | 当前 D3 真实 Provider 页面确认框；深浅主题均检查 DOM、`aria-modal`、遮罩覆盖、居中与计算 warning 样式；只取消，Provider 保留。 |
| StateView failure | **passed** | 当前 D3 隔离 Electron 真实 MemorySkills 页面，通过一次性 GET `/skills` 传输故障到达共享 `StateView` failure；深浅主题检查 `role="alert"`、重试、图标/文本最终 danger 颜色，并成功重试恢复。 |
| MemorySkills stale warning | **passed** | 当前 D3 隔离 fixture 先加载临时只读技能，再对刷新 GET 注入一次故障；深浅主题检查 `role="status"`、warning 文本/底色/边框，原列表仍在，并通过既有重载恢复。 |
| Archive 删除弹窗与键盘焦点 | **passed（modal-only）** | 当前 D3 `verify-keyboard-modal-focus.mjs --modal-only` 8 项通过：从当前设置“管理归档”入口进入真实归档页、有效 `workspace-write` / `permissionVersion: 2` 合成会话、初始焦点为取消、Tab 循环、Escape 只关闭最上层并恢复焦点。未确认删除。 |
| 键盘全流程（含后续 Agent approval 与聊天漫游） | **unverified** | 仅执行上述安全 modal-only 分支；不把部分执行报告为完整脚本通过。 |
| Permission V2 提示 | **passed（复用）** | D2B 提交 `038dd97c` 同树证据：30 项断言、深浅主题 normal/hover/focus-visible；危险审批未确认。D3 的 CSS 特例只匹配 `DangerConfirmDialog`，没有修改 Permission V2 prompt。 |
| 网站数据危险操作执行 / busy 状态 | **intentionally excluded** | 当前 D3 真实打开 browser clear-data 确认框并取消，确认拦截到的清除请求数为 0；删除结果与 busy 状态不声称通过。D2B 已归档的隔离 fixture 证据单独保留，不被本批冒充成重新执行。 |
| 其他 D1/D2A/D2B 主题和反馈场景 | **passed（复用）** | 仅复用 Renderer 代码未被 D3 改动的历史验收，并分别引用 `ccf857e1` / `038dd97c` 的阶段记录与截图；D3 的新增 modal 特例之外没有主题/组件样式改变。 |

## 测试、构建与证据路径

- 设计/反馈契约测试：6 个文件，42 项通过：`ui-radius-consistency`、`ui-state-consistency`、`ui-state-matrix`、`ui/feedback`、`settings-typography`、`ui/state-view-adoption`。
- 模态与删除影响回归：`ui/modal-layer.test.ts` 13 项、`deletion-impact.test.ts` 11 项通过；合计 8 个测试文件、66 项通过。
- 最终 `pnpm run assert:app-build`：`fresh`，Electron 44.4.5。摘要随 app 源目录报告内容变化，不在报告正文自引用。
- 语法与空白校验：两条 Electron 脚本 `node --check`、`git diff --check` 通过。

当前 D3 Electron 证据根目录：

`C:\Users\28971\.codex\visualizations\2026\10\17\01a147fc-30e5-7370-9ff7-a40109ab0b81\ls-design-language-v1-d3`

- `shared-ui-feedback/evidence.json` 与 `shared-ui-feedback/screenshots/`：98 项最终证据；各条 observation 在同一场景记录截图路径、DOM/ARIA、最终计算样式。`storage-clear-data-intentionally-excluded` 明确记载请求数 0。
- `shared-ui-feedback/before-inline-warning/screenshots/provider-delete-warning-dark.png` / `...light.png`：修复前真实截图；`shared-ui-feedback/screenshots/provider-delete-warning-dark.png` / `...light.png`：修复后真实截图。
- `shared-ui-feedback/screenshots/memory-skills-stateview-failure-*`、`memory-skills-stale-warning-*`、`storage-data-confirm-*`：两主题状态截图；DOM 和计算样式对应 `evidence.json`。
- `context-inspector-final/result.json` 与主题/状态截图：当前构建 21 项通过；`context-menus-final/report.json` 与菜单截图：当前构建 64 项通过。
- `chat-reading/report.json`、`failure.png`、DOM 与 computed-style 诊断；此项整体 failed，不作通过截图使用。
- `keyboard-modal-focus/result.json` 与 `screenshots/`：隔离归档确认弹窗键盘路径。
- D2B 复用证据：`C:\Users\28971\.codex\visualizations\2026\10\17\01a147fc-30e5-7370-9ff7-a40109ab0b81\ls-design-language-v1-d2b\after\permission-v2\` 与 `after\shared-ui-roles-final4\`。D2A 对比和权限证据位于相邻 `ls-design-language-v1-d2a` 目录，阶段说明见该目录 `D2A-report.md`。

**安全说明：** 一次早期 D3 诊断调用沿用了 D2B 共享角色脚本原有的浏览器清除数据 busy 场景，确认请求只在 harness 创建的临时 Electron/Chromium fixture 中执行，没有触及系统浏览器配置或真实用户数据。发现这一点后，我改为打开并取消确认框，并在最终 98 项验收中核实请求数为 0；本报告将清除效果和 busy 状态明确列为 intentionally excluded。危险 Provider 删除、归档删除和 Permission V2 授权均没有确认。

## 结论与 D2C 判断

当前有充分证据证明共享操作、反馈语义、主题映射、诊断密度和大部分代表性页面符合 V1；设置页危险确认框是本批唯一证实并修复的整体视觉缺陷。除聊天第二轮独立阻断、键盘全流程未执行、危险清除动作被安全排除外，没有证据支持启动广泛局部 D2C，更没有依据启动大型 UI/UX V2。

后续新增 Renderer UI 应直接遵循 `design-language-v1.md`：复用已有全局与语义 token；按真实消费者选择普通/主要/危险及紧凑操作角色；保留明确诊断/聊天/Composer/侧栏/设置密度差异；保证主题、键盘焦点、ARIA 与模态层一致；状态同时用文字/形状表达；在真实 Electron 中验证最终计算样式。不得只凭源码 token 出现就宣称视觉通过，也不得用跳过/放宽断言掩盖未验证状态。

## 2026-10-18 干净提交复验

复验从独立干净工作树的提交 `91f9cbffe59630e1e78ffe958fe1a02ab74daabc` 开始；Electron 44.4.5 的 App 由该提交源码新构建，构建指纹状态为 `built`。此后未改产品样式或组件，只补齐材质角色登记与本说明。

| 验证 | 结果 |
| --- | --- |
| 完整键盘走查 | **passed**；125 个可达停点，设置返回 composer、inline approval、回到最新及完全访问层检查通过；危险操作未确认。 |
| 设置↔聊天转场 | **passed**；草稿保留、键盘焦点返回、动画中断及 reduced-motion 检查通过。 |
| 模态焦点专项 | **passed**；8/8 检查，Escape 只关闭最上层并恢复触发器焦点。 |
| 共享 UI 角色 Electron | **passed**；98 项、0 失败；危险确认框深浅主题与取消路径通过；网站数据清除请求数为 0。 |
| TypeScript / 仓库检查 | **passed**；全工作区 TypeScript exit 0；仓库检查 35 项通过、3 条 advisory、0 失败。 |
| 材质角色登记 | 全量测试先发现 D3 modal scrim selector 未登记；补入 `scrim` 角色和 UI 角色说明后，`ui-material-roles.test.ts` **7/7 passed**。 |
| `verify:full` | **failed at tests**；689 个测试文件中 677 passed、7 failed、5 skipped；4,981 个测试中 4,943 passed、7 failed、31 skipped。全量门禁因此未执行后续 typecheck、build、recovery 阶段。失败包含与本批无关的 run-stream API 断言和 Provider usage 去重期望；全量门禁不记为通过。 |

材质角色修正只更新测试登记和说明，不改变 D3 的产品样式。全量测试记录由 `C:\Users\28971\AppData\Local\Temp\littlesheep-run-artifacts\verification-reports\latest.json` 保存；Electron 共享角色证据位于 `C:\Users\28971\AppData\Local\Temp\littlesheep-shared-ui-roles\evidence.json`。全量门禁失败不影响上述独立 Electron、TypeScript、仓库及 D3 定向断言的实际结果，但应作为当前主线更广回归风险披露。
