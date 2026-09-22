# 应用层 UI / UX 优化与统一任务书 2026-09-22

最后更新：2026-09-23 00:11:00

## 1. 范围与结论

本轮按用户要求审查应用层并形成待办，不实施产品代码修改。基线为工作树 `8060a16` 上的 Renderer 与相关 Local App API；已有的其他文档修改不属于本任务。

优先解决误发送、误删除、控制入口消失和失败不可见，再统一设置、弹窗、反馈及视觉表现。现有实现已有主题 token、FadePresence、渐进披露、文件草稿与会话现场恢复，不需要另建一套设计系统或任务引擎。

**证据边界**：这是源码与交互契约审查，未启动 Electron、未进行鼠标/键盘实机走查、未测量截图对比度。下文“源码确认”表示实现分支已核对，并不表示在真实窗口中已复现；“体验建议”需要验证收益；“待实机验证”不得登记为已复现缺陷。所有任务仍未完成。

**进度（2026-09-23 00:02:00）**：UX-01~UX-14 实现完成，UX-16 的第三项（普通/紧凑都保留失败、权限拒绝、未验证、部分完成与待用户事项）已在源码侧修复并回归；16 项仍全部未勾选，因为统一完成标准要求真实 Electron 验收。**当前唯一阻塞条件：缺少真实窗口证据。** 需要执行的验收脚本已分别写在 UX-01~UX-16 各自的实施记录里（最小窗口与 125%/150%/200% 缩放、微软拼音、四类渠道 fixture、五种失败注入、紧凑模式五类状态、流式长回答阅读位置、双会话现场与重启恢复，以及 UX-14 的两处取值变化）。

约束沿用 [UI 交互规范](../principles/ui-interaction-guidelines.md) 和各领域 README：Agent 自然语言来自真实模型；按钮、状态和错误事实由 Runtime 提供；授权继续由 Main 决定；安全恢复保持安静，不重新引入启动强制弹窗。界面不得暗示显式记忆写入、定时执行等未接通能力已经可用。

## 2. 优先级与清单

- **P0**：可能造成误执行或不可逆数据损失，先处理。
- **P1**：高频操作受阻、状态失真、输入丢失或关键入口不清楚，随后处理。
- **P2**：信息架构、文案和视觉一致性，随对应领域改动收口。
- 规模为排期参考：S = 单一视图或状态分支；M = 跨组件交互；L = 跨领域验收。不是工期承诺。

| 完成 | ID | 优先级 | 任务 | 依据 | 规模 |
| --- | --- | --- | --- | --- | --- |
| [ ] | UX-01 | P0 | 防止输入法确认候选词时误发送 | 源码确认 | S |
| [ ] | UX-02 | P0 | 为永久删除建立明确确认与影响说明 | 源码确认 | M |
| [ ] | UX-03 | P0 | 运行中始终保留停止入口，区分补充发送 | 源码确认 | S |
| [ ] | UX-04 | P1 | 技能页区分加载、空数据与失败 | 源码确认 | S |
| [ ] | UX-05 | 恢复发现失败及损坏记录提供非阻断入口 | 源码确认 | M |
| [ ] | UX-06 | 保护设置草稿，明确保存与离开语义 | 源码确认 | M |
| [ ] | UX-07 | 统一模态层焦点、Escape 和关闭返回位置 | 源码确认；需实机验收 | M |
| [ ] | UX-08 | 清理未接通页面的可点击占位控件 | 源码确认 | S |
| [ ] | UX-09 | 统一异步操作反馈及失败后的下一步 | 源码确认 | M |
| [ ] | UX-10 | 渠道总状态按真实运行情况汇总 | 源码确认 | S |
| [ ] | UX-11 | 打通无模型状态到配置完成的操作路径 | 源码确认 + 体验建议 | M |
| [ ] | UX-12 | 整理设置和工作模块的入口与信息层级 | 体验建议 | M |
| [ ] | UX-13 | 统一术语，移除开发计划式产品文案 | 源码确认 | S |
| [ ] | UX-14 | 收敛反馈、按钮、表单的共享视觉与语义 | 体验建议 | M |
| [ ] | UX-15 | 验证并修复窄窗口及高 DPI 下的表单可用性 | 待实机验证 | M |
| [ ] | UX-16 | 补齐主对话与拓展工作区的场景验收 | 待实机验证 | L |

## 3. 可执行任务

### UX-01｜输入法确认与发送分离

**问题**：主输入框只检查 Enter 和 Shift，就 `preventDefault()` 并调用 `send()`，未检查 composition 状态。中文组词过程中确认候选的 Enter 可能被当成发送。

**定位**：[composer-view.tsx](../../packages/app/src/renderer/app-shell/composer-view.tsx)，textarea 的 `onKeyDown`。

- [ ] 在共享发送键处理逻辑中排除输入法组词事件，按实际 Electron/Windows 输入法事件验证必要的兼容处理。
- [ ] 保留普通 Enter 发送、Shift+Enter 换行；补充输入、首次发送使用同一规则。
- [ ] 验收：微软拼音组词并按 Enter 不发送；组词完成后的下一次普通 Enter 只发送一次；Shift+Enter、粘贴与附件发送保持有效。用事件回归测试加真实输入法验收，不能只验证英文键盘。

**实施记录（2026-09-22 22:00:01）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `renderer/ui/enter-confirm.ts`：`resolveEnterAction` 返回 `confirm`/`line-break`/`ignore`，`createImeCompositionState` 记录 composition 状态；组词判定同时覆盖 `isComposing`、输入法 229 键码和 composition 事件状态。`app-shell/composer-view.tsx` 的首发与补充发送共用这一条规则（同一个 `send()`），`sidebar/project-creator.tsx` 的项目名输入框也改用它，避免同类的组词确认误建文件夹。
- 验证方式：`packages/app/src/renderer/ui/enter-confirm.test.ts` 8 个事件用例（普通 Enter、Shift+Enter、`isComposing`、229、组词中状态、非 Enter 键不拦截、组词确认后的下一次 Enter 只产生一次确认、两处视图接线断言）；`pnpm exec vitest run packages/app/src/renderer/ui/enter-confirm.test.ts` 通过；`pnpm exec tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：未在真实 Electron 窗口中用微软拼音实测组词确认的 keydown 序列，也未验证 229 兼容分支是否在本机 Electron/Windows 上真的被触发；`preventDefault` 之外的输入法行为（候选窗定位等）不在本轮范围。

### UX-02｜永久删除和配置删除的风险语义

**问题**：归档页的永久删除按钮直接调用 API，供应商卡片删除也直接提交。归档项目的 Main DELETE 路径还会删除其归档关联会话，界面只靠图标标签不足以表达影响。

**定位**：[ArchiveManager.tsx](../../packages/app/src/renderer/ArchiveManager.tsx) 的删除回调；[sessions.ts](../../packages/app/src/renderer/api/sessions.ts)；[session-routes.ts](../../packages/app/src/main/local-app-api/session-routes.ts) 的归档 DELETE；[models.tsx](../../packages/app/src/renderer/settings/models.tsx) 的 `handleDelete`；[provider-routes.ts](../../packages/app/src/main/local-app-api/provider-routes.ts)。

- [ ] 永久删除前展示名称、对象类型、受影响会话数、不可恢复性；区分删除项目记录/会话与删除磁盘项目文件，严格以真实 API 行为说明。
- [ ] 删除供应商说明配置影响，识别当前使用的模型；不要未经核对声称密钥也被删除。
- [ ] 删除事务具有 pending 防重复与错误保留；取消不发 DELETE。可恢复的归档继续保持轻量，不一律追加确认。
- [ ] 验收：取消、Escape、请求失败、连点、包含多个会话的项目分别验证；确认前不发生删除，删除范围与文案一致，失败记录仍可定位。

**实施记录（2026-09-22 22:00:01）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `renderer/deletion-impact.ts`（按 `session-routes.ts` 与 `provider-routes.ts` 的真实行为生成对象类型、名称、删除范围与保留项）和 `renderer/ui/danger-confirm.tsx`（对象、影响、保留项、使用中提示；初始焦点在“取消”，Escape 取消，请求期间两个动作都禁用，关闭时把焦点还给触发点）。`ArchiveManager.tsx` 的项目/对话永久删除先经确认层，确认后才调用 DELETE，失败留在确认层内可继续定位；`settings/models.tsx` 的供应商删除同样先确认，文案只说明配置条目移除，并提示当前选中模型是否来自该供应商。归档恢复保持单次点击，不追加确认。
- 验证方式：`packages/app/src/renderer/deletion-impact.test.ts` 11 个用例（有/无归档对话的项目、磁盘文件夹保留、对话范围、密钥与对话保留、当前模型识别、确认层接线与单次提交、恢复路径无确认、对话框键盘与禁用状态）；`pnpm exec vitest run` 通过；`pnpm exec tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：取消、Escape、连点和失败注入尚未在真实窗口中走查；`danger-confirm.tsx` 的 Tab 焦点约束与完整焦点管理留给 UX-07，本轮只保证初始焦点在“取消”和关闭后回到触发点。

### UX-03｜运行中同时支持停止与补充

**问题**：`showStop = loading && !input.trim()`。任务运行中只要输入草稿，原停止按钮就切为发送，用户需要清空草稿才能在该位置停止。

**定位**：[composer-view.tsx](../../packages/app/src/renderer/app-shell/composer-view.tsx) 的 `showStop` 与 `composer-run-actions`；[run-actions.ts](../../packages/app/src/renderer/chat/run-actions.ts) 的运行中发送分支。

- [ ] 运行中保留独立、稳定、可键盘访问的停止入口；有新输入时同时提供补充发送动作。
- [ ] 补充发送的标题/提示遵循 Runtime 实际的接收或续接语义，不把已接收显示为已执行；停止期间防止重复提交停止请求。
- [ ] 验收：带草稿/附件时可直接停止且草稿不丢；补充发送只提交一次；显示“正在停止”直到运行时确认，不能点击后立即伪装已停止。

**实施记录（2026-09-22 22:00:01）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：`app-shell/composer-view.tsx` 不再用 `showStop = loading && !input.trim()` 切换同一个按钮：运行中始终渲染停止按钮，草稿或附件存在时另渲染补充发送按钮，两者都是真实 `<button>`，共享键盘可达的悬停/聚焦提示。停止按钮点击后标签变为“正在停止当前任务”并禁用，直到 `loading` 结束（run 结束即运行时确认）才复位；`chat/run-actions.ts` 的 `stop()` 对同一 run 只提交一次 `interrupt_requested`，重复点击直接返回，失败或 Runtime 拒绝时才中止本地流。补充发送仍走 `sendActiveRunUpdate`，提示沿用 Runtime 语义（“已加入当前任务，将在安全边界处理”），不声称已执行。
- 验证方式：`packages/app/src/renderer/chat/run-actions.test.ts` 13 个用例（含同一 run 只发一次中断、Runtime 拒绝时中止本地流、请求失败时中止本地流、无 run 标识不触达 Runtime）；`packages/app/src/renderer/composer/control-surface-style.test.ts` 断言两个入口的渲染条件与“正在停止”复位；`pnpm exec vitest run` 通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：未在真实窗口验证“正在停止”期间按钮禁用与键盘焦点表现，也未验证窄窗口下两个按钮并排时的换行/挤压（与 UX-15 一并验收）。停止请求被 Runtime 接受但 run 长时间不结束时，界面会一直显示“正在停止”，这是当前的既定语义，尚缺真实时长的观察。

### UX-04｜技能页的加载与错误状态

**问题**：`skills` 初始为空，加载前即满足“暂无技能”；`loadSkills()` catch 将列表清空；`openSkill()` 失败只清空选中项。加载中、真正为空、失败在用户看来容易成为同一种结果。

**定位**：[MemorySkills.tsx](../../packages/app/src/renderer/MemorySkills.tsx) 的 `loadSkills`、`openSkill` 与空态。

- [ ] 明确 loading / success-empty / success-data / error；读取详情失败保留列表和用户选择，并提供重试。
- [ ] 再次加载失败时保留已有列表，说明当前内容未刷新成功，不把旧数据误称为最新。
- [ ] 验收：慢请求、空响应、列表失败、详情失败、连续快速切换分别验证；只有成功空响应显示“暂无技能”，失败不静默消失。

**实施记录（2026-09-22 22:00:01）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `renderer/skill-catalog-state.ts`（纯 reducer：`loading`/`ready`/`error`，列表与详情各自维护请求序号，`stale` 标记刷新失败，`failedDetailName` 支持原地重试，失败文本有界）。`MemorySkills.tsx` 改为按状态渲染：加载中显示“正在加载技能…”，首次失败显示错误与“重试”，刷新失败保留旧列表并标注“未能刷新技能列表，以下仍是上次成功加载的内容”，详情读取失败保留列表和当前选择并提供重试；只有 `status === 'ready' && skills.length === 0` 才显示“暂无技能”。失败不再清空列表。
- 验证方式：`packages/app/src/renderer/skill-catalog-state.test.ts` 12 个用例（慢请求、成功空响应、首次失败、刷新失败保留列表、详情失败保留列表与选择、快速切换只发布最新详情、过期响应被忽略、列表答案不被详情请求丢弃、返回列表清除详情错误、文案有界）；`pnpm exec vitest run` 通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：未在真实窗口注入慢请求与失败；技能页的“重新加载”目前只出现在失败/过期提示里，未新增常驻刷新按钮。

### UX-05｜静默恢复不能吞掉恢复失败

**问题**：启动调用 `refreshCheckpoints(false)`；发现失败只写 hook 的 error。恢复入口仅在 `checkpoints.length > 0` 时显示，而错误与损坏记录提示在展开后的选中记录区域内。首次发现请求失败或只有无效记录且没有有效 checkpoint 时，没有可见入口呈现该问题。

**定位**：[use-checkpoint-recovery.ts](../../packages/app/src/renderer/runtime-recovery/use-checkpoint-recovery.ts) 的启动 effect、`refreshCheckpoints`；[checkpoint-recovery.tsx](../../packages/app/src/renderer/runtime-recovery/checkpoint-recovery.tsx) 的 trigger、error 和 diagnostics 条件。

- [ ] 将发现失败、有效待恢复、等待用户、损坏记录分开，提供安静的状态入口和受控重试；无有效 checkpoint 也能看到故障。
- [ ] 安全可续跑任务继续静默处理，结果归原会话；不要把本任务实现为启动自动打开恢复弹窗。
- [ ] 验收：发现接口失败、仅损坏记录、需要输入、自动续跑失败、正常自动续跑五类场景；失败默认可发现、聊天可用、重试不重复执行已结算操作。

**实施记录（2026-09-22 22:18:43）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：`checkpoint-recovery-state.ts` 新增 `checkpointRecoveryEntry`（把发现失败、正在恢复/正在停止、等待补充信息、待恢复任务、损坏记录、完全干净收敛成一个入口）与 `checkpointRecoveryDiagnosticText`（统一“N 份恢复记录无法读取 / N 处不完整”的说明）。`use-checkpoint-recovery.ts` 单独记录 `discoveryFailed`（发现失败不再等同于空列表）并提供只重读列表的 `retryDiscovery`。`checkpoint-recovery.tsx` 的入口按钮改为按派发结果渲染，发现失败时点击即重试；对话框在没有有效 checkpoint 时也显示诊断说明、失败原因和“重新检查”，且失败态的空文案改为“这次没有读取成功，未完成任务的当前状态未知”，不再显示“没有待处理的执行现场”。启动发现仍调用 `refreshCheckpoints(false)`，不自动打开弹窗；安全可续跑的启动静默续跑路径未改动。
- 验证方式：`packages/app/src/renderer/runtime-recovery/checkpoint-recovery-state.test.ts` 10 个用例（发现失败优先于损坏记录与已有 checkpoint、仅损坏记录可见、等待补充与普通待恢复分开、不可续跑的等待项不冒充“待补充”、恢复中/停止中文案、完全干净才静默、诊断文案组合，以及视图/钩子接线）；`pnpm exec vitest run packages/app/src/renderer/runtime-recovery/checkpoint-recovery-state.test.ts` 通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：五类场景（发现接口失败、仅损坏记录、需要输入、自动续跑失败、正常自动续跑）尚未在真实 Electron 中逐项走查；本轮只验证了状态派生与接线，“聊天保持可用”与“重试不重复执行已结算操作”在实机上的表现仍需 UX-16 的验收记录。新增 `runtime-recovery/README.md` 记录该领域边界与验证方式。

### UX-06｜设置草稿和离开保护

**问题**：供应商 `draft` 只保存在页面局部 state；设置容器按 `page` 重新挂载，切换设置页会卸载编辑器。编辑器关闭/取消直接丢弃 draft，保存中关闭入口也未禁用。现有文件编辑器有专门草稿逻辑，设置表单的行为没有同样清楚。

**定位**：[models.tsx](../../packages/app/src/renderer/settings/models.tsx)、[model-provider-editor.tsx](../../packages/app/src/renderer/settings/model-provider-editor.tsx)、[workspace.tsx](../../packages/app/src/renderer/settings/workspace.tsx) 的 `key={page}`；参照 [file-close.ts](../../packages/app/src/renderer/workspace/file-close.ts) 的事务边界，勿照搬文件自动保存策略。

- [ ] 区分未改动、已修改、保存中、保存失败；在会话内保留普通表单草稿或仅在丢弃时提示，避免每次导航都打断。
- [ ] 密钥不写 localStorage、不输出日志；离开时如何处理密钥草稿必须明确，保存中离开不得造成结果归错页面。
- [ ] 验收：编辑后切页/返回、取消、保存失败、保存中关闭逐项验证；普通字段不无声丢失，取消不保存，错误时保留可修正内容。

**实施记录（2026-09-22 22:46:14）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `settings/provider-editor-session.ts`——模块内存中的单一编辑会话（draft + baseline），不写 localStorage/sessionStorage、不落盘、不写日志；这是 `workspace.tsx` 用 `key={page}` 重新挂载页面后草稿不丢失的依据。`model-provider-draft.ts` 新增 `providerDraftIsDirty`（逐字段比较，含模型行与明文密钥）。`models.tsx` 的草稿流改为：挂载时恢复会话草稿、编辑时同步写入、提交前清空会话副本（保存中的内容不会在别的页面变成待保存草稿）、成功后关闭、失败时把可修正内容写回并就地显示失败、取消/保存中禁止关闭。`model-provider-editor.tsx` 显示四种状态（未改动不提示、`已修改，尚未保存。`、`保存中…`、`保存失败：…` 的 `role="alert"` 块），头部关闭按钮改为 `disabled={saving}`，并明确写出密钥草稿的生命周期（内存草稿，保存或取消后丢弃，不写浏览器存储或日志）。
- 验证方式：`settings/provider-editor-session.test.ts` 4 个用例（草稿与 baseline 的读写清除、不落盘/不写日志的源码约束、`models.tsx` 的恢复/提交清空/失败回写/保存中禁止关闭接线、编辑器的四态与关闭禁用）；`settings/model-provider-draft.test.ts` 新增 2 个用例（未改动为干净、每个可编辑字段与会话密钥都算修改、模型行比较不依赖数组引用）；`pnpm exec vitest run packages/app/src/renderer/settings/` 26 个用例通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：切页返回、取消、保存失败注入与保存中关闭仍未在真实窗口中逐项走查；本轮只把“按键与生命周期”做成可回归的纯规则与接线断言。`models.tsx` 因本次改动超过 300 行，已按仓库规则登记到 `module-split-map.md`。

### UX-07｜模态层与键盘行为统一

**问题**：审批声明 `aria-modal` 并自动聚焦“仅本次”，但没有聚焦约束/关闭后焦点恢复；恢复层有外部点击关闭却未处理 Escape。`FadePresence` 和 `useDismissOnOutside` 负责显示/收起，不提供完整模态管理。技能/渠道页面还在 embedded 模式注册全局 Escape 返回设置总览，存在层级处理不一致。

**定位**：[approval/prompt.tsx](../../packages/app/src/renderer/approval/prompt.tsx)、[checkpoint-recovery.tsx](../../packages/app/src/renderer/runtime-recovery/checkpoint-recovery.tsx)、[ui/presence.tsx](../../packages/app/src/renderer/ui/presence.tsx)、[MemorySkills.tsx](../../packages/app/src/renderer/MemorySkills.tsx)、[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx)。

- [ ] 为真正模态对话框统一进入焦点、Tab 范围、背景不可操作、关闭后返回触发点；将“平铺编辑页”与模态 dialog 分开定义。
- [ ] Escape 只交给最上层处理；审批中的 Escape 保持拒绝语义，恢复中的关闭保持稍后处理语义；单纯关闭不能意外批准或放弃任务。
- [ ] 评估审批初始焦点改为说明或非授权动作，避免打开时连续 Enter 意外授予权限；保留完全访问红色确认。
- [ ] 验收：只用键盘打开、阅读、循环 Tab、取消、返回原位置；两层 UI 时一次 Escape 只收起一层；退出动画期间不会重复触发操作。

**实施记录（2026-09-22 23:12:16）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `ui/modal-layer.ts`（纯规则：Escape 归属最上层的注册表，按 id 幂等登记；Tab 循环索引 `nextFocusIndex`；可聚焦元素选择器）与 `ui/modal-surface.ts`（DOM 胶水：`useEscapeScope` 页面级作用域、`useModalSurface` 模态对话框的进入焦点/Tab 约束/关闭后焦点归还，`active=false` 时在退出动画期间交还按键）。接入面：审批 `approval/prompt.tsx`（Escape 仍为拒绝、进入焦点改到说明标题、去掉“仅本次”的 `autoFocus`、`active=Boolean(prompt)`）、`runtime-recovery/checkpoint-recovery.tsx`（Escape 等同“稍后处理”而不是放弃，进入焦点在关闭按钮）、`ui/danger-confirm.tsx`（改用共享层，行为不变）、`composer/mode-picker.tsx` 的完全访问警告（红色确认与初始焦点保留，Escape 只收起警告、不再连带收起选择器）、`MemorySkills.tsx` 与 `ChannelConnections.tsx` 的页面级 Escape、`ui/presence.tsx` 的 `useDismissOnOutside`（弹层参与同一仲裁，不再各自监听全局 Escape）。平铺编辑页（供应商编辑器、内嵌渠道/技能页）明确只用页面级作用域、不捕获 Tab。
- 验证方式：`ui/modal-layer.test.ts` 13 个用例（注册表顶层判定、幂等登记、空栈；Tab 前后环绕、越界进入、空作用域；以及六个接入面的源码契约：Escape 语义、进入焦点、`active` 交还按键、不再出现裸 `window` Escape 监听）；`pnpm exec vitest run packages/app/src/renderer` 99 个文件 / 520 个用例全部通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：键盘走查（打开、循环 Tab、取消、返回原位置）与“两层 UI 一次 Escape 只收起一层”的实机表现未验证；焦点归还依赖触发点仍挂载，触发元素在等待期间被卸载时会跳过归还。背景不可操作目前由全屏遮罩层与 Tab 约束保证，没有把应用根节点标成 `inert`。

### UX-08｜未接通功能不呈现虚假可操作性

**问题**：“已安排”页的“全部/提醒/自动任务”按钮没有状态或回调；页面同时以“暂无任务”表示空数据，又写“等计划任务接入后”，混淆未实现与已实现但没有数据。

**定位**：[scheduled.tsx](../../packages/app/src/renderer/settings/scheduled.tsx)、[navigation.ts](../../packages/app/src/renderer/settings/navigation.ts)、[direct-module.tsx](../../packages/app/src/renderer/settings/direct-module.tsx)。

- [ ] 当前基线移除无效筛选控件；选择隐藏入口或明确显示功能尚不可用，统一所有入口的状态。
- [ ] 不为填满页面而在本清单中新增调度后端；只有真实能力接通后才引入数据空态和筛选。
- [ ] 验收：每个可点击控件有可见结果；“尚不可用”与“暂无数据”不会互相替代。

**实施记录（2026-09-22 22:28:19）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：`settings/scheduled.tsx` 删除没有状态与回调的“全部/提醒/自动任务”筛选条，改为只声明“计划任务、提醒和周期执行还没有接入 Runtime，这个页面暂时不可用”和“功能尚未接入 / 当前版本不能创建或查看计划任务，因此这里没有可显示的数据，也没有筛选可用”，不再出现“暂无已安排任务”这类数据空态文案。`settings/navigation.ts` 的入口描述由“计划任务与自动执行”改为“计划任务尚未接入”，设置总览（复用同一分组表）、设置侧边栏和侧边栏直接模块页因此显示同一状态；三者渲染的都是同一个 `SettingsScheduledPage`。未新增任何调度后端。
- 验证方式：`packages/app/src/renderer/settings/scheduled.test.ts` 3 个用例（页面不含任何 `<button>`/`onClick`/toolbar/筛选类名、不含“暂无”式空态文案且明确声明未接入、三个入口的描述与页面来源一致）；`pnpm exec vitest run packages/app/src/renderer/settings/scheduled.test.ts` 通过。
- 未覆盖项：未在真实窗口中确认三个入口的跳转表现；把“已安排”入口整体隐藏仍是备选方案，本轮选择保留入口并明确不可用，等信息架构任务（UX-12）统一决定入口去留。

### UX-09｜异步反馈与错误恢复统一

**问题**：技能吞错；渠道用 `reloadMsg.includes('失败')` 决定样式；模型、存储、插件、聊天分别使用不同提示结构和 ARIA 语义。设置阈值保存仅有 finally，其失败需继续沿运行时更新链核对，不应假定本页一定展示。

**定位**：[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx)、[models.tsx](../../packages/app/src/renderer/settings/models.tsx)、[storage.tsx](../../packages/app/src/renderer/settings/storage.tsx)、[plugins.tsx](../../packages/app/src/renderer/settings/plugins.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)、[runtime-actions.ts](../../packages/app/src/renderer/app-shell/runtime-actions.ts)。

- [ ] 建立小型反馈结构：状态、用户可读事实、可选重试/定位动作、可展开详情；tone 由结构字段决定，不解析文案。
- [ ] 保存中锁定同一事务；成功轻量提示；失败留在发起操作处并保留输入，长错误有界呈现；重新加载失败不能仍只显示旧成功提示。
- [ ] 验收：供应商保存、阈值保存、渠道重载、插件启停、文件保存各注入一次失败；用户在当前页面能看到失败及下一步，不必返回聊天区找错误。补充合适的 status/alert 语义。

**实施记录（2026-09-22 23:29:56）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `ui/feedback.ts`（`Feedback { tone, message, detail }`；`feedbackRole` 把色调映射为 `status`/`alert`；`boundedDetail` 把 Runtime 文本规范化并限制为 400 字符；`successFeedback`/`warningFeedback`/`failureFeedback` 由结果字段构造）与 `ui/feedback-notice.tsx`（统一渲染色调、可选重试动作与折叠的“技术详情”，`busy` 时禁用重试）。接入面：`ChannelConnections.tsx` 删除 `reloadMsg.includes('失败')` 的文案嗅探，改为结构化反馈并给出重试；读取失败会替换旧提示（不再留下旧成功行）并清空列表状态。`settings/agent-profile.tsx` 的压缩阈值保存把失败留在该页：`runtime-actions.ts` 新增 `applyRuntimePatchReporting`（与 `applyRuntimePatch` 同一事务，额外把失败文本返回），经 `overlays-view.tsx` → `settings/workspace.tsx` 传到页面，失败时显示“压缩阈值未保存，仍在使用原来的比例”+“重试保存”。`settings/plugins.tsx` 的通知与错误改由共享组件渲染（保留 `plugin-page-notice`/`plugin-page-error` 外观与 `status`/`alert` 语义、失败带重试）。`settings/models.tsx` 的读取失败/成功提示改用同一结构，读取失败会先清掉旧成功提示；`model-provider-editor.tsx` 的保存失败也改为“保存失败，内容仍保留在编辑器里 + 有界详情”。文件保存路径经源码核对已在原地显示失败（`workspace/preview-pane.tsx` 的 `workspace-editor-status error`），本轮不改动。
- 验证方式：`ui/feedback.test.ts` 11 个用例（色调为字段而非文案解析、色调到 ARIA 角色与失败判定、长文本有界与空白规范化、用户事实与技术详情分离、无详情时不留空披露，以及渠道/模型/插件/编辑器/阈值链路与阈值失败回传的接线断言）；`pnpm exec vitest run packages/app/src/renderer` 100 个文件 / 531 个用例全部通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：五类失败注入（供应商保存、阈值保存、渠道重载、插件启停、文件保存）仍未在真实窗口中逐项执行；插件页因处于 394 行冻结基线，采用内联反馈对象而非辅助工厂以保持行数不增长。`storage.tsx` 继续使用它既有的 `data-tone` 结构化通知（已是同一模式），未在本轮改写。

### UX-10｜渠道状态汇总准确

**问题**：总体“外部渠道运行中”和列表标题“运行中的渠道”只取决于 `channels.length`，但同一列表中单项使用 `ch.running`。列表存在不等于至少一个渠道正在运行；失败列表还单独存在。

**定位**：[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx) 的 `channel-overall`、渠道列表、failures。

- [ ] 按真实运行项和失败项派生“运行中/部分异常/未运行/未配置”，保留“已配置”“已启用”“运行中”的区别。
- [ ] 总体状态与逐项状态对齐，不能把配置存在或数量大于零当成连接健康。
- [ ] 验收：空配置、全部停止、部分运行且部分失败、全部运行四种 fixture；标签、数量和颜色一致。若后端保证不会返回停止项，应先明确契约再简化 UI。

**实施记录（2026-09-22 22:28:19）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `renderer/channel-status.ts` 的 `summarizeChannelConnections`：按已加载渠道的真实 `running` 计数和 `failures` 计数派生 `unconfigured / stopped / partial / running` 四种总体状态，并同时给出 `运行 N/M · 已配置 K [· 失败 F]` 的计数与一句话事实（用于 title/无障碍说明）。`ChannelConnections.tsx` 的总体徽章改为该派生结果（含 partial 的警示色），列表标题由“运行中的渠道”改为“已加载渠道”，逐项新增“运行中/未运行”标签，使总体与单项使用同一批事实；`status.channels.length > 0 ? 'running' : 'stopped'` 的判断已删除。后端契约未保证 `channels` 只含运行项，因此保留逐项 `running` 判定，不简化 UI。
- 验证方式：`packages/app/src/renderer/channel-status.test.ts` 7 个用例（空配置、全部运行且无失败、已配置但全部停止（不因配置存在判健康）、部分运行且部分失败、全部未运行但有失败记录、混合运行不得把停止项算作运行，以及视图接线断言：不再出现“运行中的渠道”与旧三元判断）；`pnpm exec vitest run packages/app/src/renderer/channel-status.test.ts` 通过。
- 未覆盖项：四种 fixture 尚未在真实窗口中核对颜色与排版；`started` 字段当前未参与总体状态（它描述插件宿主是否启动过），如后续需要区分“未启动”与“未运行”，需先明确后端契约再扩展。

### UX-11｜无模型到可用模型的配置闭环

**问题**：模型选择器无供应商时显示“无可用模型”，引导依赖 title 中的设置路径；当前组件没有直接打开模型配置的动作。用户必须自己找到设置、添加配置，再返回原输入现场。

**定位**：[runtime-picker.tsx](../../packages/app/src/renderer/composer/runtime-picker.tsx) 的无模型状态与 trigger；[models.tsx](../../packages/app/src/renderer/settings/models.tsx)。

- [ ] 在无模型状态提供明确的“配置模型”动作，定位到供应商设置；返回后保留原会话、文字及附件。
- [ ] 区分未配置、配置加载失败、已保存但未验证可调用；不要用“已设置密钥”暗示连接成功。
- [ ] 验收：新数据根从空状态完成配置并回到原草稿；加载失败可重试；保存后选择器从 Runtime 刷新。若新增真实连接检查，单列网络调用成本和实现边界。

**实施记录（2026-09-22 23:39:50）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `composer/runtime-availability.ts` 纯状态模块，把无可用模型分成“读取中 / 读取失败（可重试）/ 还没有配置（给出配置入口）/ 已保存但不可用（缺密钥或缺模型条目）”，并用设置页同一个 `isConfiguredProvider` 判定“已配置”，使输入栏与供应商页对同一份配置给出一致结论。`composer/runtime-picker.tsx` 的空菜单不再只有一行“没有已配置的可用模型”，而是给出事实与动作（“配置模型”/“检查供应商配置”/“重试读取”）；触发按钮在配置读取失败时保持可点（否则菜单里的重试永远到不了），标题与空菜单都使用同一句事实。`app-shell/composer-view.tsx` 把 `openSettingsPage('api')` 与 `refreshRuntime` 传给选择器——打开设置只是路由切换，不清空当前文字与附件；从设置返回后由既有的 `settingsOpen` 变化 effect 重新读取 Runtime，保存过的供应商随即可见。`settings/models.tsx` 的空态改为“保存成功才会出现在选择器里”并明确写出“保存配置不代表已经验证可以调用”，不再用密钥状态暗示连接成功。本轮没有新增任何真实连接检查，因此没有新增网络调用。
- 验证方式：`composer/runtime-availability.test.ts` 7 个用例（读取失败与首次空态分开、未配置给出配置入口、自定义供应商缺密钥/缺模型为不可用、内置预设未配置与已配置的判定与设置页一致、只有可解析的已选模型才算 ready，以及选择器空菜单动作、`openSettingsPage('api')`/`refreshRuntime` 接线与“打开设置不清空草稿”的断言）；`pnpm exec vitest run packages/app/src/renderer` 101 个文件 / 538 个用例全部通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：新数据根从空状态走完配置并回到原草稿的真实流程未走查；“已保存但不可用”只依据 Runtime 返回的 `hasKey`/模型条目，未做真实可调用性验证（任务书允许，若将来新增连接检查需单列网络成本）。空菜单在窄窗口下的排版与 UX-15 一并验收。

### UX-12｜设置与工作模块的信息架构

**现状与建议**：设置总览复制全部分组；记忆树、插件、已安排又可作为独立工作页打开；“Agent 行为”内同时放行为 profile、压缩阈值、对话显示。多个入口不是必然错误，但当前位置、返回目的地和设置归属需要一致。

**定位**：[navigation.ts](../../packages/app/src/renderer/settings/navigation.ts)、[home.tsx](../../packages/app/src/renderer/settings/home.tsx)、[direct-module.tsx](../../packages/app/src/renderer/settings/direct-module.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)。

- [ ] 先画出现有入口—页面—返回目标映射，确定每个模块唯一页面身份，保留有价值的快捷入口而不复制状态。
- [ ] 对话显示归入界面偏好；压缩阈值作为高级上下文配置按需展开；profile 与权限继续分离。
- [ ] 验收：从聊天、独立模块、设置总览进入同一功能时名称和状态一致；返回到来处；常见配置可按用户意图找到。先验证小幅重排，避免整套导航重建。

**实施记录（2026-09-22 23:52:31）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：入口 → 页面 → 返回目标映射写入 `settings/README.md`（设置总览、设置侧边栏各页、侧边栏直接模块页、embedded 归档/技能/外部渠道四类入口各自的返回目标），并明确页面身份由 `settings/types.ts` 的 `SettingsPage` 联合类型唯一声明。小幅重排：新增设置页「界面」`settings/appearance.tsx`，把「对话显示」（普通/紧凑）从「Agent 行为」移出；「Agent 行为」只保留 profile 与上下文策略，压缩阈值收进 `<details class="settings-advanced">` 的“高级上下文设置”；权限继续只由输入栏权限模式控制，页面文案重复声明该边界。新页同时登记到 `navigation.ts` 分组、`persistent-state.ts` 可恢复集合与 `workspace.tsx` 渲染分支（不登记会导致重启恢复静默丢页）。
- 验证方式：`settings/navigation.test.ts` 6 个用例——`SettingsPage` 联合类型、导航分组、可恢复集合、工作区渲染分支四者的集合必须一致（新增页面漏登记即失败）；直接模块页允许走共享分支但必须能被 `direct-module.tsx` 映射；「界面」独占显示密度、Agent 页不再持有显示偏好；阈值行必须位于折叠区内；README 必须保留映射表与各模块名称。`pnpm exec vitest run packages/app/src/renderer` 103 个文件 / 548 个用例全部通过；`tsc -b` 通过。
- 未覆盖项：未在真实窗口从聊天、直接模块页与设置总览三处进入同一功能核对名称与返回位置；本轮按“小幅重排”执行，没有重建导航或合并设置分组；`use-navigation-controller.ts` 的历史快照未改动。

### UX-13｜术语和产品文案

**问题**：同一供应商功能混用“提供方/供应商”；中文设置页显示 Normal/Compact；总览和技能页描述“后续功能模块”“后续可继续接”；外部渠道无配置时直接要求编辑 `config.json` 的嵌套字段。

**定位**：[models.tsx](../../packages/app/src/renderer/settings/models.tsx)、[model-provider-editor.tsx](../../packages/app/src/renderer/settings/model-provider-editor.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)、[home.tsx](../../packages/app/src/renderer/settings/home.tsx)、[MemorySkills.tsx](../../packages/app/src/renderer/MemorySkills.tsx)、[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx)。

- [ ] 建立小型术语表：供应商、模型、对话、任务、项目、工作区、应用数据目录；Normal/Compact 使用一致的中文显示名。
- [ ] 功能说明只描述当前可用能力；高级配置字段放入可展开说明或帮助入口，未提供配置 UI 时如实说明限制。
- [ ] 验收：相同概念在标题、按钮、提示和空态一致；路径/状态事实不被文案重写；不增加模板化 Agent 回复。

**实施记录（2026-09-22 23:46:30）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：术语表新增到 [UI 交互规范](../principles/ui-interaction-guidelines.md) 的“术语表”一节（供应商、模型、对话、任务、项目、工作区、应用数据目录，以及“普通/紧凑”），并规定面向用户文案只描述当前可用能力。代码侧统一了“提供方 → 供应商”（`settings/models.tsx`、`model-provider-editor.tsx`、`chat/assistant-turn.tsx` 的用量/模型/来源标签、样式注释与 `renderer/README.md`），对话显示密度改为“普通/紧凑”（存储仍是 `normal`/`compact`）。开发计划式文案改为当前事实：`settings/home.tsx` 的“后续功能模块”改为“工作模块的设置入口”，`MemorySkills.tsx` 的“后续可继续接启用、禁用和编辑”改为“当前版本只能查看内容，不能在界面里启用、禁用或编辑技能”，拓展工作区的侧边聊天占位改为“侧边聊天尚未接入 / 当前版本还不能在这里进行局部对话”。外部渠道空态不再把嵌套字段当作第一步：主文案说明“还没有配置外部渠道”和“这个版本还没有渠道配置界面”，精确的 `channels.channels` 与应用数据目录 `config.json` 放进可展开的“在哪里配置”。
- 验证方式：`terminology.test.ts` 4 个用例，其中术语一致性与禁用文案是对整个 `packages/app/src/renderer` 源码树的扫描（排除测试文件），因此新增文案引入旧说法会直接失败；另断言对话显示用中文名、未接通表面写明“尚未接入”、渠道空态把精确配置字段放进披露而不是主指令。`pnpm exec vitest run packages/app/src/renderer` 101 个文件 / 538 个用例全部通过；`tsc -b packages/app/tsconfig.json packages/app/tsconfig.web.json` 通过。
- 未覆盖项：术语表只覆盖本轮出现的概念，`session`/`workspace` 等代码标识符不在文案范围内；未在真实窗口逐页核对文案；未新增模板化 Agent 回复，也未改动任何 Runtime 文案。

### UX-14｜共享 UI 的增量收敛

**现状与建议**：颜色、圆角、动效已有 token；反馈和操作按钮仍有 `dialog-*`、`storage-settings-*`、`plugin-page-*`、`archive-*` 多套表面。类名不同本身不等于视觉缺陷，应先按截图与行为确认重复，再抽取。

**定位**：[ui/README.md](../../packages/app/src/renderer/ui/README.md)、[03-shell-sidebar.css](../../packages/app/src/renderer/styles/03-shell-sidebar.css)、[07-overlays-settings.css](../../packages/app/src/renderer/styles/07-overlays-settings.css)、[09-projects-archive.css](../../packages/app/src/renderer/styles/09-projects-archive.css)。

- [ ] 建立小范围状态样本：主/次/危险按钮、输入、空态、错误、pending、只读；复用现有 token，补必要的字号/间距角色。
- [ ] 优先随 UX-04/07/09 抽取 AsyncFeedback、Dialog 等确有复用收益的基元，不全仓机械替换样式。
- [ ] 验收：同类控件的高度、文字层级、聚焦、禁用、等待和危险样式一致；保留既有黑灰主题、紧凑布局、reduced-motion 与圆角例外。

**实施记录（2026-09-22 23:57:19）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：先测量再抽取——逐条比对了错误面（`dialog-error`/`archive-error`/`project-creator-error`/`storage-settings-notice[data-tone=error]`/`plugin-page-error`/`plugin-list-error`/`web-source-errors`/`activity-tool-error` 等）与控件角色（`save-btn`/`reload-btn`/`danger-btn`/`close-btn`/`toggle-btn`/`refresh-btn`/`feedback-action`）的实际声明，确认了真实重复：同一“危险文本”角色出现四种浅红（`#ffd2d2`、`#e8c5bd`、`#f2b6b6`、`#f0a9a9`、`#e5a6a6`），行内通知内边距/字号有 7-9px/11px 与 8-10px/12px 两套。随后新增角色 token（`--feedback-danger-text`、`--feedback-danger-border`、`--danger-control-text`、`--notice-padding-block/inline`、`--notice-font-size`、`--control-height-md/sm`、`--control-font-size`、`--control-font-size-strong`）并把上述角色改为引用 token。状态样本与例外清单写入 `ui/README.md`。**没有**全仓机械替换：大块选择（`provider-add`/`profile-choice` 48px）、对话框主操作（`approval-action` 34px）、紧凑行操作（`archive-action` 26px）、胶囊（`provider-remove` 30px）和圆角例外（`--radius-icon: 3px`）都按角色保留。
- 验证方式：`ui-state-consistency.test.ts` 5 个用例直接测量样式源——角色 token 必须存在；错误面全部引用 `--feedback-danger-text` 且样式里不得再出现任何浅红字面值（防止漂移回流）；行内通知几何统一；同类控件高度/字号一致且例外仍在；`--radius-ui: 10px`、`--radius-icon: 3px`、`--motion-base: 180ms`、`prefers-reduced-motion` 块未被破坏。`pnpm exec vitest run packages/app/src/renderer` 104 个文件 / 553 个用例全部通过；`tsc -b` 通过。
- 未覆盖项：**本轮没有任何真实窗口或截图证据**。其中零计算变化的 token 化不改视觉；但有两处是真实取值变化，必须在实机确认：① 五处浅红统一为 `#ffd2d2`（`storage-settings-notice` 错误色、`web-source-errors`、`web-settings-notice.error`、`plugin-runtime-state.failed`、渠道失败明细），② `plugin-page-notice/.plugin-page-error` 的内边距 7px 9px → 8px 10px、字号 11px → 12px。此外“输入、空态、pending、只读”四类只做了清点与记录，未改动取值（避免无证据的视觉变更）。

### UX-15｜窄窗口与高 DPI 验证

**风险线索**：模型编辑器使用两列弹性字段加 `150px 150px 26px` 固定列；多个设置辅助标签为 10/11px。源码可确认尺寸，不能据此断言真实窗口已经裁切或对比度不合格。

**定位**：[07-overlays-settings.css](../../packages/app/src/renderer/styles/07-overlays-settings.css) 的 `provider-model-row`、`provider-model-columns` 与辅助文字；[model-provider-editor.tsx](../../packages/app/src/renderer/settings/model-provider-editor.tsx)。

- [ ] 在应用允许的最小窗口、常用窗口、125%/150%/200% 系统缩放下验证模型表单、设置侧栏、审批长路径、运行时选择器。
- [ ] 出现不足时按可用宽度切换模型字段为堆叠布局，确保字段仍有独立标签；只调整实测难读文字，测量前不宣称符合或违反对比度标准。
- [ ] 验收：关键按钮始终可达；字段不会压缩到无法输入；页面无非必要横向滚动；长路径可完整查看/复制；记录窗口逻辑尺寸、系统缩放和截图。

**实施记录（2026-09-22 23:59:00）｜状态：源码侧风险已定位，修复取决于实测；保持未勾选**

- 已完成（无窗口可做的部分）：把源码中可确认的尺寸风险逐条定位——模型编辑器 `provider-model-columns` 为固定 `150px 150px 26px` 列（`model-provider-editor.tsx` 的四个模型字段加删除按钮），窄宽度下会被挤压；设置辅助文字存在 10/11px；审批详情是 `pre` 长路径；运行时选择器主面板 + 两级子菜单有固定宽度。这些只是**源码事实**，按任务书要求不能据此断言真实窗口已经裁切或对比度不合格。
- 未实施的修改及原因：堆叠布局的触发条件是“出现不足”，必须先用真实窗口测量；在没有实测前改结构属于无证据的视觉变更，本轮不做。UX-14 的两处取值变化也并入同一次实测。
- 待执行脚本（每项记录窗口逻辑尺寸、系统缩放、截图路径，结论按“通过/不足/需修改”三选一）：
  1. 最小窗口（应用允许的最小尺寸）+ 常用窗口各一次，逐个检查：模型编辑器四个字段能否输入、标签是否仍可读、删除按钮是否可达；设置侧栏是否出现非必要横向滚动；审批对话框的长路径 `pre` 是否可完整查看与复制；运行时选择器主面板与两级子菜单是否溢出。
  2. 系统缩放 125% / 150% / 200% 各重复第 1 步。
  3. 对每个“不足”记录：控件名、当前可用宽度、被裁切或压缩的表现、截图；只有出现不足才按可用宽度切换堆叠布局并给每个字段补独立标签。

### UX-16｜对话与拓展工作区的完整场景验收

**现状与建议**：已有滚动锚点、上下文详情、Normal/Compact、会话工作区恢复及分栏测试，不应重复登记为缺失功能。本轮没有真实窗口证据，需验证组合场景后只修复实际失败项。

**定位**：[chat-view.tsx](../../packages/app/src/renderer/app-shell/chat-view.tsx)、[assistant-turn.tsx](../../packages/app/src/renderer/chat/assistant-turn.tsx)、[chat-scroll-anchor.ts](../../packages/app/src/renderer/chat/chat-scroll-anchor.ts)、[workspace/README.md](../../packages/app/src/renderer/workspace/README.md)、[workspace-persistence.ts](../../packages/app/src/renderer/workspace-persistence.ts)。

- [ ] 覆盖流式长回答时向上阅读、返回底部、添加多附件、展开长工具结果、输入多行草稿、双栏拖动/折叠/全屏及返回。
- [ ] 覆盖两个对话切换后的文件标签、未保存草稿、浏览器和目录现场，再覆盖重启恢复；沿用现有连续性专项的 Runtime 验收，不另建重复执行器。
- [ ] 核对普通/紧凑显示均保留失败、权限拒绝、未验证、部分完成和待用户事项；默认可找到最终成果，不为减少噪声隐藏重要状态。
- [ ] 验收：阅读位置不被流式内容抢回，输入与底部成果不被遮挡；现场不串会话；真实失败逐项附复现步骤、截图和修复记录，正常场景只记通过，不追加“重设计”任务。

**实施记录（2026-09-23 00:02:00）｜状态：第三项已修复并回归，其余待实机；保持未勾选**

- 已完成（无窗口可做的部分）：核对“普通/紧凑显示均保留失败、权限拒绝、未验证、部分完成和待用户事项”时发现真实缺口——紧凑模式此前把已完成轮次的**整段 transcript 行与 `ActiveActivityStatus` 一起折叠**，只剩一行固定的“已思考 · N 次工具调用 · N 条消息”，因此工具失败与权限拒绝（Runtime 以 `ok === false` 加原因返回）、失败或中止的准备行、失败的思考行、未通过的验证和失败步骤在紧凑模式下都会消失。现已修复：`chat/activity-visibility.ts` 新增 `transcriptEntryNeedsAttention` / `compactTranscriptEntries`（紧凑模式只折叠无需关注的行）与 `activityAttentionLine`（把未完成、已停止、等待用户、已暂停、失败步骤数、未通过的验证结论合成一行 `role="status"` 提示），`assistant-turn.tsx` 在紧凑模式下渲染这两者，样式使用 UX-14 的 `--feedback-danger-text` 角色。普通模式行为未改动。
- 验证方式：`chat/activity-visibility.test.ts` 4 个用例（未成功的工具行保留、失败/中止的准备与思考行保留、活动级未完成/停止/等待/暂停各自成句、未验证与失败步骤进入提示而通过的验证不算关注项）；`pnpm exec vitest run packages/app/src/renderer` 105 个文件 / 557 个用例全部通过；`tsc -b` 通过。
- 待执行脚本（其余三项与验收，需要真实窗口与真实会话）：
  1. 流式长回答：向上滚动阅读 → 确认阅读位置不被流式内容抢回；回到最底部；添加多附件；展开长工具结果；输入多行草稿；双栏拖动 / 折叠 / 全屏及返回。
  2. 两个对话各打开文件标签、留下未保存草稿、各自访问浏览器与目录 → 来回切换确认现场不串会话 → 重启应用确认恢复。
  3. 紧凑模式下分别构造一次失败、一次权限拒绝、一次未验证、一次部分完成与一次等待用户，确认五类状态都仍可读；切回普通模式重复确认。
  4. 每个真实失败附复现步骤、截图与修复记录；正常场景只记“通过”，不新增“重设计”任务。

## 4. 实施顺序与依赖

1. **第一批：可靠性**。UX-01、UX-02、UX-03、UX-04、UX-05；UX-02 需要的最小确认层可与 UX-07 共用，不等整套 UI 抽象完成再修复。
2. **第二批：一致性**。UX-06、UX-07、UX-08、UX-09、UX-10、UX-11。草稿离开、模态焦点和异步反馈应共同验收；无模型引导依赖草稿保留和错误表达。
3. **第三批：收口**。UX-12、UX-13、UX-14；UX-15/16 从第一批就开始记录基线，最终跨批回归。视觉修改必须以真实窗口证据收尾。

不以“重做前端”为一个大任务，不为清单新增调度、记忆写入或另一个权限体系。不自动改变既定开发主线；本任务书是可独立排期的应用层 backlog。

## 5. 统一完成标准

- 每个任务填写实际实现范围、验证方式、通过结果及未覆盖项，完成前保持未勾选。
- 状态分支、误发送、删除和跨页草稿使用有意义的行为测试；颜色/间距调整不添加只复述实现的测试。
- 真实 Electron 验收覆盖：正常、慢请求、失败、取消、重复操作、键盘、最小窗口和系统缩放。交互验收必须使用隔离测试数据，不操作真实归档或真实密钥。
- 同一改动同步更新所属领域 README 的边界与系统时钟时间；运行适用的仓库检查、相关测试和应用构建，并按 Renderer 约定刷新桌面入口后验收。
- 本轮交付仅为此任务清单及文档索引；没有宣称以上缺陷已修复，也没有宣称完成 Electron 端到端或视觉验收。

## 6. 实机验收脚本索引

自动门已跑到全仓范围（见下），**唯一未完成的是真实窗口证据**。逐项步骤写在每个任务自己的“实施记录 → 待执行脚本 / 验收”里，这里只给执行顺序、环境要求与结果记录位；不要在完成前勾选上表。

**环境要求**（统一遵守第 5 节最后一条）：使用隔离测试数据根，不操作真实归档、真实项目目录或真实密钥；每个场景记录窗口逻辑尺寸、Windows 系统缩放与截图路径；结论只写“通过 / 不足 / 需修改”，正常场景不追加“重设计”任务。

| 顺序 | 任务 | 脚本位置 | 关键步骤摘要 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | UX-01 | 本任务实施记录 | 微软拼音组词确认候选 → 下一次普通 Enter 只发一次；Shift+Enter、粘贴、附件仍有效 | |
| 2 | UX-02 | 本任务实施记录 | 取消 / Escape / 请求失败 / 连点 / 多会话项目各一次；确认前不发生删除、失败留在确认层 | |
| 3 | UX-03 | 本任务实施记录 | 带草稿与附件时直接停止且草稿不丢；补充发送只提交一次；“正在停止”持续到 run 结束 | |
| 4 | UX-04 | 本任务实施记录 | 慢请求、空响应、列表失败、详情失败、快速切换各一次 | |
| 5 | UX-05 | 本任务实施记录 | 发现失败、仅损坏记录、需要输入、自动续跑失败、正常自动续跑五类 | |
| 6 | UX-06 | 本任务实施记录 | 编辑后切页返回、取消、保存失败注入、保存中关闭 | |
| 7 | UX-07 | 本任务实施记录 | 仅键盘打开/循环 Tab/取消/返回原位；两层 UI 一次 Escape 只收一层 | |
| 8 | UX-08 / UX-10 | 本任务实施记录 | 三个入口状态一致；“每个可点击控件有可见结果”；四种渠道 fixture 的标签与颜色 | |
| 9 | UX-09 | 本任务实施记录 | 供应商保存、阈值保存、渠道重载、插件启停、文件保存各注入一次失败 | |
| 10 | UX-11 | 本任务实施记录 | 新数据根从空状态配置完成并回到原草稿；加载失败重试；保存后选择器刷新 | |
| 11 | UX-12 / UX-13 | 本任务实施记录 | 从聊天、独立模块、设置总览进入同一功能名称与返回位置一致；逐页核对文案 | |
| 12 | UX-14 | 本任务实施记录 | 确认两处取值变化（五处错误浅红统一、插件通知 7px9px→8px10px） | |
| 13 | UX-15 | 本任务实施记录 | 最小窗口与常用窗口 + 125%/150%/200% 缩放下的模型表单、设置侧栏、审批长路径、运行时选择器 | |
| 14 | UX-16 | 本任务实施记录 | 流式长回答阅读位置；双会话现场与重启恢复；紧凑模式五类状态 | |

**自动门当前结果（2026-09-23 00:11）**：`check:repo` 36/36 通过（含 TypeScript project references）；全量测试 **476 个文件 / 3358 通过、2 失败、1 跳过**，两个失败均不在本任务改动面内——`packages/runner/src/runner.test.ts` 的压缩范围断言（该文件最后一次修改来自更早的提交）与 `scripts/verify-web-live-llm-evidence.test.mjs` 解析被管道捕获的子进程 stdout（本沙箱不允许管道捕获，属环境边界）；全 workspace typecheck 通过；App 构建通过；`verify:app-recovery` 只读检查通过（另有 2 条关于真实数据根的信息性 warning）。
