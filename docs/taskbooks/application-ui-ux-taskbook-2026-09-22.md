# 应用层 UI / UX 优化与统一任务书 2026-09-22

最后更新：2026-09-24 22:52:40

## 1. 范围与结论

本轮按用户要求审查应用层并形成待办，不实施产品代码修改。基线为工作树 `8060a16` 上的 Renderer 与相关 Local App API；已有的其他文档修改不属于本任务。

优先解决误发送、误删除、控制入口消失和失败不可见，再统一设置、弹窗、反馈及视觉表现。现有实现已有主题 token、FadePresence、渐进披露、文件草稿与会话现场恢复，不需要另建一套设计系统或任务引擎。

**证据边界**：这是源码与交互契约审查，未启动 Electron、未进行鼠标/键盘实机走查、未测量截图对比度。下文“源码确认”表示实现分支已核对，并不表示在真实窗口中已复现；“体验建议”需要验证收益；“待实机验证”不得登记为已复现缺陷。所有任务仍未完成。

**进度（2026-09-23 00:02:00）**：UX-01~UX-14 实现完成，UX-16 的第三项（普通/紧凑都保留失败、权限拒绝、未验证、部分完成与待用户事项）已在源码侧修复并回归；16 项仍全部未勾选，因为统一完成标准要求真实 Electron 验收。**当前唯一阻塞条件：缺少真实窗口证据。** 需要执行的验收脚本已分别写在 UX-01~UX-16 各自的实施记录里（最小窗口与 125%/150%/200% 缩放、微软拼音、四类渠道 fixture、五种失败注入、紧凑模式五类状态、流式长回答阅读位置、双会话现场与重启恢复，以及 UX-14 的两处取值变化）。

**2026-09-24 对话区增补**：UX-19~UX-22 针对用户报告的滚动定位、流式文字外观及缺失、模型连接失败、输出可读性。以下是新增待办和源码检查结论，未实施产品代码，也未在真实 Electron 窗口复现；上段进度只描述原 UX-01~UX-16 的历史状态，不代表新增任务已完成。

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
| [ ] | UX-17 | P2 | 大仓库文件树虚拟化（先建基准，再选实现） | 对标记录 + 体验建议 | L |
| [ ] | UX-18 | P2 | 为审阅侧栏提供独立宽度 | 对标记录 + 体验建议 | S |
| [ ] | UX-19 | P1 | 修正对话区阅读位置和上下定位 | 用户反馈 + 源码风险；待实机定位 | M |
| [ ] | UX-20 | P0 | 查清流式文字变色及内容消失的路径 | 用户反馈 + 源码风险；待实机复现 | M |
| [ ] | UX-21 | P0 | 模型瞬时故障分级重试与失败反馈 | 源码确认 + 用户反馈 | M |
| [ ] | UX-22 | P2 | 收敛对话输出层级与可读性 | 用户反馈 + 体验建议；待实机验证 | M |

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

**实施记录（2026-09-25 03:30:00）｜状态：真实窗口的组词验收完成，三条验收全部通过**

- 新增真实窗口门 `pnpm run verify:composer-ime-submit`（`scripts/verify-composer-ime-submit.mjs`）：用 CDP 的 `Input.imeSetComposition` 在真实渲染器里建立**真正的 composition**（与 Windows 输入法走同一条路径），再用 `Input.dispatchKeyEvent` 发出确认键，并在页面事件捕获阶段记录渲染器实际收到的 composition/keydown 事件。
- 实测（1100×700，隔离数据根）：
  - **组词是真的**：`compositionstart: 1`、`compositionupdate: 1`，输入栏内容为"组词验收"，且确认键的 keydown 带着 **Chromium 自己的组合标记** `{ isComposing: true, keyCode: 13, shiftKey: false }`——正是 `enter-confirm.ts` 为它写下的分支（也说明本机 Electron/Windows 上 `isComposing` 分支先于 229 兼容分支命中）。
  - **确认候选不发送**：该 Enter 前后用户消息数与 Provider 请求数都**没有变化**（0 → 0）。
  - **提交与下一次 Enter**：`Input.insertText` 结束组合（`composing: false`）并保留文字；随后普通 Enter **只发送一次**（新增 1 条用户消息），请求正文里同时带着"组词验收"和粘贴的文件名，输入栏被清空。
  - **Shift+Enter**：输入栏变成 `"组词验收\n"`（保留换行、未发送、未清空）；**粘贴文件**：出现 1 个附件卡片、未发送，并随那次发送一起进入请求。
- 验收脚本同时避开了一个测量陷阱：发送与否必须按**用户消息/run** 计数，不能按 Provider 请求数——一次 run 合法地会发出多次 Provider 请求（工具轮 + 收尾轮），按后者会把"只发一次"误判成发两次。
- 仍未覆盖：本机未安装真实微软拼音，因此**候选窗交互本身**（候选选择、翻页、`229` 兼容分支在特定输入法构建上的触发）仍只在事件层验证；`preventDefault` 之外的输入法行为（候选窗定位）不在范围。复选框保持未勾选。

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

**实施记录（2026-09-25 03:50:00）｜状态：取消/Escape/连点/失败注入已在真实窗口走查，并修掉连点重复提交 DELETE 的真实缺陷；多会话项目的确认文案仍由单元测试覆盖，保持未勾选**

- 新增真实窗口门 `pnpm run verify:deletion-confirmation`（`scripts/verify-deletion-confirmation.mjs`）：把两段归档对话直接种进 `archive/index.json`（应用自己写的文件）与会话 JSONL，再在页面里装一个 `fetch` 探测器统计渲染器真正发出的 DELETE，并按需让下一次 DELETE 返回 500。
- 实测（1180×760）：确认层标题"永久删除归档对话？"、对象名"归档对话 甲"、后果两条（"删除这条归档记录，以及它保存在本地的消息记录和会话摘要"、"删除后无法恢复"）、保留项一条（"不会删除工作区里的文件"）、初始焦点在**取消**；**打开确认层时 DELETE 计数仍为 0**。Escape 关闭后计数 0、列表不变；点"取消"同样计数 0、列表不变；确认后该行消失且计数 1；注入 500 后确认层**保持打开**并显示 `Local app API error: 500`，被删除对象仍在；再点一次（此时不注入失败）计数 +1 并成功删除。
- **本次走查抓到的真实缺陷（已修）**：在确认层上**同一帧内连点两次"永久删除"会发出两次 DELETE**（探测器实测 `deletes: 2`，两条请求 URL 相同、时间戳相同）。原因是防重复用的是 React state（`deleting`），而同一 task 内的两次点击都读到 `false`。现在改为**同步的 `deletingRef`** 先占位（`if (!pending || deletingRef.current) return`，`finally` 里复位），`cancelDeletion` 也读同一个 ref；回归断言写进 `deletion-impact.test.ts`（明确断言使用的是 ref 而不是 state），修后实测连点只发出 1 次 DELETE。
- 仍未覆盖（复选框保持未勾选）：**包含多个归档对话的项目**这一条仍只有单元测试（`deletion-impact.test.ts` 覆盖"项目 + 若干对话"的文案与范围），未在真实窗口里用多会话项目走查；供应商删除的确认层同样未实机走查；`danger-confirm.tsx` 的 Tab 焦点约束仍留给 UX-07。

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

**实施记录（2026-09-25 04:15:00）｜状态：停止与补充三条验收在真实窗口通过；补充消息在本轮答案内的投递未观测到，作为待查项记录，保持未勾选**

- 新增真实窗口门 `pnpm run verify:composer-stop-append`（`scripts/verify-composer-stop-append.mjs`）：用慢速长回答（24 字符 / 120 ms）保证动作发生在 run 进行中，并在页面里装 `fetch` 探测器记录渲染器真正发出的运行事件（含 HTTP 状态与 Runtime 的 `outcome`）。
- 实测（1100×720）：
  - **两个入口并存**：有草稿（"停止后的补充草稿"）+ 1 个附件时，停止按钮仍是"停止当前任务"、补充入口是"补充当前任务"，草稿与附件都在。
  - **停止只提交一次**：同一帧内连点两次停止，运行事件只有 **1 条** `interrupt_requested`（HTTP 202、`outcome.kind = accepted`）；按钮标签变为"正在停止当前任务"并进入禁用。
  - **"正在停止"持续到 run 结束**：run 结算后停止按钮消失、发送入口回到"发送"，该 run 的状态行是"run interrupted at a safe boundary"。
  - **草稿与附件不丢**：停止前、停止中、run 结算后三次采样，输入栏内容始终是"停止后的补充草稿"、附件卡片始终是 1 个。
  - **补充发送只提交一次**：同一帧内连点两次补充，两次 POST 带**同一个 `dedupKey` 与同一个事件 id**，Runtime 的两次应答分别是 `accepted` 与 **`duplicate`**——即按身份只应用一次；输入栏在提交后被清空。
- **一处未观测到的行为（记录，不据此改代码）**：本轮补充消息**没有出现在该 run 的答案里，也没有进入任何 Provider 请求**（探测器与 Provider 请求记录都是 0）。原因是夹具的补充落在"单请求回答"进行中——这条提示只触发一次模型请求，之后没有更晚的请求可以携带它，事件以 `status: queued`（24 小时过期）留在运行队列里。要证明"补充会被消费"需要另一种时序（例如在工具轮进行中补充，或验证后续 run 会取走排队事件），本轮未做，作为待查项。
- 仍未覆盖（复选框保持未勾选）：**补充消息的实际投递时序**（如上）；窄窗口下两个入口并排的换行/挤压与键盘焦点表现留给 UX-15；"停止请求被接受但 run 长时间不结束"时的持续显示仍缺真实时长观察。

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

**实施记录（2026-09-25 03:19:01）｜状态：慢请求、列表失败、刷新失败、详情失败四条已在真实窗口验收；并补上缺失的常驻刷新入口；成功空响应仍无数据，保持未勾选**

- 新增真实窗口门 `pnpm run verify:skills-catalog-states`（`scripts/verify-skills-catalog-states.mjs`）：在页面里给 `/skills` 与 `/skills/<name>` 装 `fetch` 探针，可按住下一次列表请求（观察加载态）、让列表连续失败 N 次、让指定技能的详情读取失败一次。
- 实测（1180×780，隔离数据根）：
  - **加载中**是独立状态：按住列表请求期间只有"正在加载技能…"、没有任何条目，页头的刷新入口显示"正在加载…"（禁用）。
  - **成功有数据**：`example`、`office-files`、`skill-writer` 三个技能，无提示，刷新入口为"刷新"。
  - **刷新失败保留列表**：注入一次 500 后点刷新，列表仍是同样 3 条，出现 `warning` 级提示"未能刷新技能列表，以下仍是上次成功加载的内容：Local app API error: 500"与"重新加载"按钮，且**没有**被误报成首次加载失败（`.error` 类不出现）。
  - **重试恢复**：点"重新加载"后提示清空、列表仍在。
  - **详情失败保留列表与选择**：对 `example` 注入 500 后点击它，列表仍是 3 条、没有打开空详情，出现"读取技能详情失败：Local app API error: 500"与"重试"；点重试后打开的正是 `example`；"返回"回到列表且列表完好。
- **顺带补上的真实缺口**：技能页此前**没有任何常驻刷新入口**——"重新加载"只在失败提示里出现，所以"刷新失败保留列表并标注未刷新"这条分支在界面上**不可达**（加载成功的页面无法再刷新）。现在页头新增"刷新"按钮（复用 `ms-feedback-action` 样式，加载中禁用），上面第 3 条因此才能被走到；README 记下这条边界。
- 仍未覆盖（复选框保持未勾选）：**成功空响应**（"暂无技能"）没有数据——内置技能（`example` 等）始终存在，要造出真正空的技能目录需要一个不装载内置技能的夹具；**连续快速切换**只在单元测试里覆盖（`skill-catalog-state.test.ts` 的请求序号断言），未在真实窗口连点。

### UX-05｜静默恢复不能吞掉恢复失败

**问题**：启动调用 `refreshCheckpoints(false)`；发现失败只写 hook 的 error。恢复入口仅在 `checkpoints.length > 0` 时显示，而错误与损坏记录提示在展开后的选中记录区域内。首次发现请求失败或只有无效记录且没有有效 checkpoint 时，没有可见入口呈现该问题。

**定位**：[use-checkpoint-recovery.ts](../../packages/app/src/renderer/runtime-recovery/use-checkpoint-recovery.ts) 的启动 effect、`refreshCheckpoints`；[checkpoint-recovery.tsx](../../packages/app/src/renderer/runtime-recovery/checkpoint-recovery.tsx) 的 trigger、error 和 diagnostics 条件。

- [x] 将发现失败、有效待恢复、等待用户、损坏记录分开，提供安静的状态入口和受控重试；无有效 checkpoint 也能看到故障。
- [x] 安全可续跑任务继续静默处理，结果归原会话；不要把本任务实现为启动自动打开恢复弹窗。
- [x] 验收：发现接口失败、仅损坏记录、需要输入、自动续跑失败、正常自动续跑五类场景；失败默认可发现、聊天可用、重试不重复执行已结算操作。

**实施记录（2026-09-22 22:18:43）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：`checkpoint-recovery-state.ts` 新增 `checkpointRecoveryEntry`（把发现失败、正在恢复/正在停止、等待补充信息、待恢复任务、损坏记录、完全干净收敛成一个入口）与 `checkpointRecoveryDiagnosticText`（统一“N 份恢复记录无法读取 / N 处不完整”的说明）。`use-checkpoint-recovery.ts` 单独记录 `discoveryFailed`（发现失败不再等同于空列表）并提供只重读列表的 `retryDiscovery`。`checkpoint-recovery.tsx` 的入口按钮改为按派发结果渲染，发现失败时点击即重试；对话框在没有有效 checkpoint 时也显示诊断说明、失败原因和“重新检查”，且失败态的空文案改为“这次没有读取成功，未完成任务的当前状态未知”，不再显示“没有待处理的执行现场”。启动发现仍调用 `refreshCheckpoints(false)`，不自动打开弹窗；安全可续跑的启动静默续跑路径未改动。
- 验证方式：`packages/app/src/renderer/runtime-recovery/checkpoint-recovery-state.test.ts` 10 个用例（发现失败优先于损坏记录与已有 checkpoint、仅损坏记录可见、等待补充与普通待恢复分开、不可续跑的等待项不冒充“待补充”、恢复中/停止中文案、完全干净才静默、诊断文案组合，以及视图/钩子接线）；`pnpm exec vitest run packages/app/src/renderer/runtime-recovery/checkpoint-recovery-state.test.ts` 通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：五类场景（发现接口失败、仅损坏记录、需要输入、自动续跑失败、正常自动续跑）尚未在真实 Electron 中逐项走查；本轮只验证了状态派生与接线，“聊天保持可用”与“重试不重复执行已结算操作”在实机上的表现仍需 UX-16 的验收记录。新增 `runtime-recovery/README.md` 记录该领域边界与验证方式。

**实施记录（2026-09-25 04:44:12）｜状态：五类场景已在真实窗口逐项跑通，顺带修掉“重试一次同一份坏记录就被多算一份”的计数缺陷；三项勾选**

- 新增真实窗口门 `pnpm run verify:recovery-states`（[verify-recovery-states.mjs](../../scripts/verify-recovery-states.mjs)）：四个隔离数据根、四个真实窗口，全部走真实 Local App API、真实检查点 store 与真实 Renderer；只注入两处：`GET /run-checkpoints` 返回 500（发现失败类），以及验收 Provider 全 500（自动续跑失败类）。
- 实测（1180×780，隔离数据根）：
  - **发现失败**：注入 500 → 入口 `恢复检查失败`（class `discovery-failed`，title「未能读取未完成任务；点击重试」），不自动打开弹窗、composer 仍可输入（注入后输入的草稿保留）、0 次 run、0 次模型请求；点入口即重试（页面探针记录到第 2 次列表请求）后入口消失，仍 0 次模型请求 —— 即“失败可发现、聊天可用、重试不执行任何已结算操作”。
  - **仅损坏记录**：真实坏文件 → 入口 `恢复记录异常`（计数 1）；弹窗内为 `另有 1 份恢复记录无法读取；LS 已保留原文件并停止自动处理。`、空态「没有待处理的执行现场。」、动作「重新检查」；点「重新检查」后弹窗收起，**计数仍是 1**、重开弹窗文案一致、原文件仍在磁盘上、0 次执行。
  - **需要输入**（旧版兼容形状，见下方边界）：入口 `待补充信息`（计数 1），不会静默续跑（3 秒内 0 次模型请求）；弹窗答案框自动聚焦；不填直接点「继续执行」得到「这个任务正在等待补充信息，请填写后再继续。」且 **0 次 resume 请求、0 次模型请求**；填好后点一次 → 恰好 1 次 `POST /run-checkpoints/:id/resume/stream`（请求体含 `"continuationDirective":"answer"` 与答案原文），续跑完成、回复落在原会话、disposition 记为 `resumed/ok`、弹窗关闭、入口消失。
  - **自动续跑失败**：启动即全 500 → 12 次请求后失败；入口 `待恢复任务`（1 条）即可发现，不自动打开弹窗；4 秒后请求数与检查点文件数都不再增长（不会自行重试）；源检查点文件字节未被改写；disposition 记为 `resumed/error` 且带 `nextCheckpointId`，留下的正是续跑自己的现场（stage `ask_user`、resumable、claim 恰好 1 次）；弹窗里能读到失败原因与「可以继续」状态；随后清掉注入，普通消息正常得到回答（2 次请求、同一会话、未新增 Runtime 失败行）。
  - **正常自动续跑**：新数据根里只有该检查点与其会话 → 启动即静默续跑：入口短暂显示 `任务恢复中`，**从未打开恢复弹窗**，2 次模型请求全部来自 runtime 自己（全程没有任何用户输入），回复落在检查点原会话（`activeSessionTitle` 与会话索引一致），完成后入口消失、无待恢复记录，续跑自己那一轮 `settled` 且无 Runtime 失败。
- **顺带修掉的真实缺陷（实机发现）**：同一份坏记录的计数会随检查次数增长。`run-checkpoint-store.ts` 的 `scannedFiles/readFiles/validFiles/invalidFiles` 与诊断条目按**进程生命周期**累加，用户点一次「重新检查」后同一份坏文件就从“1 份”变成“2 份”；同时 `toCheckpointDiagnostics` 的 `warningCount` 直接取诊断条目总数，而每条坏记录自己也贡献一条，于是同一份文件被同时说成“无法读取”和“不完整”（实机原文：`另有 1 份恢复记录无法读取、1 处恢复记录不完整`）。
- 修法（同一次改动）：把检查点 schema/序列化拆到 `run-checkpoint-codec.ts`、把“一次目录报告”拆到 `run-checkpoint-scan.ts`，store 只保留文件、原子写入、容量、保留期与常驻账本（891 → 381 行，已低于 600 行，按规则从受控超限清单与强制拆分队列移除；codec 471 行登记进软上限队列）。**计数与逐记录发现改为每次扫描重新给出**；扫描看不到的发现（残留 `.tmp`、裁剪失败、定向读写失败）留在常驻账本，并作为与记录无关的 `warningFindings` 暴露；`invalidFiles` 与 `warningCount` 从此互斥，文案改为「N 处恢复目录读写异常」。回归：`run-checkpoint-store.test.ts` 新增「重复扫描同一份坏记录只算一次」「启动/裁剪发现不进记录计数」两个用例，`run-checkpoint-view.test.ts` 新增互斥计数用例。
- 仍未覆盖（复选框已勾选，但这三条边界要记住）：①`waiting_user` 形状当前运行时不产出（模型提问按普通回复发布，run 不再停在问题上），该场景用的是**真实检查点改写成旧版兼容形状 + 会话里补上它回答的那条澄清消息**；②窗口 3 只走到“失败可发现 + 聊天可用 + 续跑现场保留”，没有再点一次「继续执行」去续跑那个新现场（同一条点击路径已在窗口 4 用等待输入场景端到端走通）；③四类续跑都用验收 Provider 的确定性桩，不是真实模型，因此本门只证明恢复 UI/状态与 Runtime 续跑的接线，不衡量模型质量。

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

**实施记录（2026-09-25 03:44:12）｜状态：四条验收已在真实窗口跑通，并按验收要求补上"关闭前询问"，不再静默丢弃；密钥相关边界仍只有源码约束，保持未勾选**

- 新增真实窗口门 `pnpm run verify:provider-editor-draft`（`scripts/verify-provider-editor-draft.mjs`）：在页面里给 `/config/providers` 的 POST 装探针（可统计、可注入 500、可按住请求），并用真实控件驱动编辑器。
- 实测（1180×780，隔离数据根）：
  - **四态**：未改动不提示；改名后 `已修改，尚未保存。`。
  - **编辑后切页/返回**：编辑器打开时点击设置导航确实会切页（`afterSwitch: { editorOpen: false, activeNav: "界面" }`），回到"模型供应商"后**草稿仍在**（字段值仍是"草稿中的显示名称"，状态仍为"已修改，尚未保存。"——`dirty` 优先于 `restored` 标签）。顺带发现一个实现细节：返回该页时**编辑器会带着草稿自动重新打开**，因为决定它是否渲染的正是会话草稿。
  - **取消不保存**：关闭时先出现询问（见下），选择"丢弃修改"后关闭，字段回到已保存值，全程 **0 次保存请求**。
  - **保存失败**：注入 500 后编辑器保持打开、显示"保存失败，内容仍保留在编辑器里"+技术详情，**可修正内容还在**，并且通过 API 读到供应商列表**没有被改动**。
  - **保存中关闭**：按住保存请求期间，`保存中…` 状态、关闭按钮与取消按钮**都禁用**、保存按钮也禁用；请求落地后编辑器关闭，列表显示新名称（探针统计共 2 次保存尝试）。
- **按验收要求补上的真实缺口**：编辑器是模态，关闭按钮是唯一出口，而它此前**直接丢弃未保存的修改且不作提示**（任务书原文的要求是"在会话内保留普通表单草稿**或**仅在丢弃时提示"）。现在关闭时若有未保存修改会先给出 `provider-editor-discard`（`role="alertdialog"`：继续编辑 / 丢弃修改），"继续编辑"保留编辑器与草稿。实测：询问出现时编辑器仍打开、草稿仍在；"继续编辑"后草稿与脏状态都保留；"丢弃修改"后关闭且不发保存请求。回归断言加进 `provider-editor-session.test.ts`。
- 仍未覆盖（复选框保持未勾选）：**密钥草稿**仍只有源码层约束（不写 localStorage/日志、内存草稿随关闭丢弃），没有对"内存中的密钥在关闭后确实不可读"做运行时验证；删除供应商的确认层未在本门走查（UX-02 已覆盖归档侧）；`workspace.tsx` 的 `key={page}` 重挂载行为只在切页场景间接验证。

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

**实施记录（2026-09-25 04:35:00）｜状态：键盘走查与两层 Escape 已实机验收通过；审批与恢复两处 Escape 语义仍只有单元测试，保持未勾选**

- 新增真实窗口门 `pnpm run verify:keyboard-modal-focus`（`scripts/verify-keyboard-modal-focus.mjs`）：键击经 CDP 派发（**不是**直接调用 click 处理器），因此渲染器收到的是真实 `keydown` 与原生按钮激活。一处必要细节：Enter 必须用 `type: 'keyDown'` 并带 `text: '\r'` 才会触发按钮的默认激活动作（`rawKeyDown` 不会）——这与 UX-01 里 Shift+Enter 换行需要同样处理是同一条经验。
- 实测（1180×760，两层 UI = 设置 presence 层 + 其上的永久删除确认层）：**只用键盘**聚焦设置入口按 Enter 打开设置 → 聚焦"归档"导航项按 Enter 打开归档页 → 聚焦删除动作按 Enter 打开确认层；确认层打开后焦点落在**取消**（`close-btn`）。连按 7 次 Tab 的焦点序列是 `永久删除 → 取消 → 永久删除 → …`，**每一步都在对话框内**（Tab 约束生效、两个动作都可达）。
- **一次 Escape 只收一层**：第一次 Escape 关闭确认层后，归档页与设置层都还在（`archiveOpen: true`、`settingsOpen: true`），且焦点**回到触发它的删除动作**（`archive-action danger`，`aria-label` 为"永久删除对话"）。
- 记录一处观察（**未断言、未修改**）：第二次 Escape 不会收起设置层（`secondEscapeClosedSettings: false`）——设置是平铺的页面级 presence，没有注册 Escape 作用域，退出设置由"退出设置"入口负责。本项验收要求的"两层 UI 一次 Escape 只收起一层"由第一次 Escape 证明；是否给设置层加 Escape 退出属产品判断。
- 仍未覆盖（复选框保持未勾选）：**审批**与**恢复**两处的 Escape 语义（拒绝 / 稍后处理，且不得意外批准或放弃任务）仍只有 `modal-layer.test.ts` 的源码契约与单元测试，未在真实窗口注入；退出动画期间重复触发操作、以及"触发点在等待期间被卸载"的焦点归还边界未验证。

### UX-08｜未接通功能不呈现虚假可操作性

**问题**：“已安排”页的“全部/提醒/自动任务”按钮没有状态或回调；页面同时以“暂无任务”表示空数据，又写“等计划任务接入后”，混淆未实现与已实现但没有数据。

**定位**：[scheduled.tsx](../../packages/app/src/renderer/settings/scheduled.tsx)、[navigation.ts](../../packages/app/src/renderer/settings/navigation.ts)、[direct-module.tsx](../../packages/app/src/renderer/settings/direct-module.tsx)。

- [x] 当前基线移除无效筛选控件；选择隐藏入口或明确显示功能尚不可用，统一所有入口的状态。
- [x] 不为填满页面而在本清单中新增调度后端；只有真实能力接通后才引入数据空态和筛选。
- [x] 验收：每个可点击控件有可见结果；“尚不可用”与“暂无数据”不会互相替代。

**实施记录（2026-09-22 22:28:19）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：`settings/scheduled.tsx` 删除没有状态与回调的“全部/提醒/自动任务”筛选条，改为只声明“计划任务、提醒和周期执行还没有接入 Runtime，这个页面暂时不可用”和“功能尚未接入 / 当前版本不能创建或查看计划任务，因此这里没有可显示的数据，也没有筛选可用”，不再出现“暂无已安排任务”这类数据空态文案。`settings/navigation.ts` 的入口描述由“计划任务与自动执行”改为“计划任务尚未接入”，设置总览（复用同一分组表）、设置侧边栏和侧边栏直接模块页因此显示同一状态；三者渲染的都是同一个 `SettingsScheduledPage`。未新增任何调度后端。
- 验证方式：`packages/app/src/renderer/settings/scheduled.test.ts` 3 个用例（页面不含任何 `<button>`/`onClick`/toolbar/筛选类名、不含“暂无”式空态文案且明确声明未接入、三个入口的描述与页面来源一致）；`pnpm exec vitest run packages/app/src/renderer/settings/scheduled.test.ts` 通过。
- 未覆盖项：未在真实窗口中确认三个入口的跳转表现；把“已安排”入口整体隐藏仍是备选方案，本轮选择保留入口并明确不可用，等信息架构任务（UX-12）统一决定入口去留。

**实施记录（2026-09-25 07:09:54）｜状态：三个入口的真实窗口走查通过，三项勾选**

- 实机走查（`pnpm run verify:channel-entry-states` 的第一部分，1280×840，隔离数据根）：三个入口逐一点开——设置总览行「已安排」（描述实测为「计划任务尚未接入」）、设置侧边栏条目、应用侧边栏直入模块页——三处渲染的页面文本**完全相同**，标题都是「已安排」。
- 每个入口的页面实测：`interactiveCount = 0`（`button`/`a[href]`/`input`/`select`/`textarea`/`summary`/`[role=button|switch|tab]`/`contenteditable` 全为 0）、`toolbarCount = 0`（无 `.settings-module-toolbar`/`.settings-filter-pill`/`[role=toolbar]`），即页面上没有任何"点了没反应"的控件；正文同时给出「计划任务、提醒和周期执行还没有接入 Runtime，这个页面暂时不可用。」与空态标题「功能尚未接入」+「当前版本不能创建或查看计划任务，因此这里没有可显示的数据，也没有筛选可用。」。
- 「尚不可用」与「暂无数据」不互相替代：三处页面文本都不含「暂无」式数据空态措辞（`noDataPhrase = false`），同时明确写出"没有可显示的数据"的原因。
- 每个入口的点击都有可见结果：从总览进入后聊天区被设置页替换（`composerVisible = false`），侧边栏直入页渲染 `main.direct-module-workspace[aria-label="已安排"]`，页面可见且标题为「已安排」。
- 未覆盖项：只走查了这三个入口能到达的页面本身，未覆盖其它设置页；未评估"是否应该隐藏该入口"这一产品取舍（信息架构任务 UX-12 已决定保留入口并标注不可用）。

### UX-09｜异步反馈与错误恢复统一

**问题**：技能吞错；渠道用 `reloadMsg.includes('失败')` 决定样式；模型、存储、插件、聊天分别使用不同提示结构和 ARIA 语义。设置阈值保存仅有 finally，其失败需继续沿运行时更新链核对，不应假定本页一定展示。

**定位**：[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx)、[models.tsx](../../packages/app/src/renderer/settings/models.tsx)、[storage.tsx](../../packages/app/src/renderer/settings/storage.tsx)、[plugins.tsx](../../packages/app/src/renderer/settings/plugins.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)、[runtime-actions.ts](../../packages/app/src/renderer/app-shell/runtime-actions.ts)。

- [x] 建立小型反馈结构：状态、用户可读事实、可选重试/定位动作、可展开详情；tone 由结构字段决定，不解析文案。
- [x] 保存中锁定同一事务；成功轻量提示；失败留在发起操作处并保留输入，长错误有界呈现；重新加载失败不能仍只显示旧成功提示。
- [x] 验收：供应商保存、阈值保存、渠道重载、插件启停、文件保存各注入一次失败；用户在当前页面能看到失败及下一步，不必返回聊天区找错误。补充合适的 status/alert 语义。

**实施记录（2026-09-22 23:29:56）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `ui/feedback.ts`（`Feedback { tone, message, detail }`；`feedbackRole` 把色调映射为 `status`/`alert`；`boundedDetail` 把 Runtime 文本规范化并限制为 400 字符；`successFeedback`/`warningFeedback`/`failureFeedback` 由结果字段构造）与 `ui/feedback-notice.tsx`（统一渲染色调、可选重试动作与折叠的“技术详情”，`busy` 时禁用重试）。接入面：`ChannelConnections.tsx` 删除 `reloadMsg.includes('失败')` 的文案嗅探，改为结构化反馈并给出重试；读取失败会替换旧提示（不再留下旧成功行）并清空列表状态。`settings/agent-profile.tsx` 的压缩阈值保存把失败留在该页：`runtime-actions.ts` 新增 `applyRuntimePatchReporting`（与 `applyRuntimePatch` 同一事务，额外把失败文本返回），经 `overlays-view.tsx` → `settings/workspace.tsx` 传到页面，失败时显示“压缩阈值未保存，仍在使用原来的比例”+“重试保存”。`settings/plugins.tsx` 的通知与错误改由共享组件渲染（保留 `plugin-page-notice`/`plugin-page-error` 外观与 `status`/`alert` 语义、失败带重试）。`settings/models.tsx` 的读取失败/成功提示改用同一结构，读取失败会先清掉旧成功提示；`model-provider-editor.tsx` 的保存失败也改为“保存失败，内容仍保留在编辑器里 + 有界详情”。文件保存路径经源码核对已在原地显示失败（`workspace/preview-pane.tsx` 的 `workspace-editor-status error`），本轮不改动。
- 验证方式：`ui/feedback.test.ts` 11 个用例（色调为字段而非文案解析、色调到 ARIA 角色与失败判定、长文本有界与空白规范化、用户事实与技术详情分离、无详情时不留空披露，以及渠道/模型/插件/编辑器/阈值链路与阈值失败回传的接线断言）；`pnpm exec vitest run packages/app/src/renderer` 100 个文件 / 531 个用例全部通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：五类失败注入（供应商保存、阈值保存、渠道重载、插件启停、文件保存）仍未在真实窗口中逐项执行；插件页因处于 394 行冻结基线，采用内联反馈对象而非辅助工厂以保持行数不增长。`storage.tsx` 继续使用它既有的 `data-tone` 结构化通知（已是同一模式），未在本轮改写。

**实施记录（2026-09-25 06:05:12）｜状态：五类失败注入已在真实窗口逐项跑通，过程中修掉"文件保存成功提示被自己触发的刷新清掉"；三项勾选**

- 新增真实窗口门 `pnpm run verify-async-feedback`（[verify-async-feedback.mjs](../../scripts/verify-async-feedback.mjs)）：同一个窗口里按请求路径逐个注入 HTTP 500（`POST /config/providers`、`POST /runtime`、`POST /channels/reload`、`POST /plugins/<id>/enabled`、`POST /workspace/save`），每次注入后清掉并重试，全部走真实控件。
- 实测（1280×840，隔离数据根；失败注入期间 `.composer-error` 始终为空，即五类都不必回到聊天区找错误）：
  - **供应商保存**：编辑器内改名后保存失败 → 原地出现 `role="alert"` 的 `保存失败，内容仍保留在编辑器里` + 技术详情（含注入的 500），**草稿仍在**（输入框仍是新名字）、编辑器不关闭；清掉注入再点保存 → 成功提示 `已保存供应商 "acceptance-gw"。`，旧失败被替换。
  - **阈值保存**：改比例后保存失败 → 原地 `role="alert"` 的 `压缩阈值未保存，仍在使用原来的比例` + 注入详情 + 动作 `重试保存`；同时核对 Runtime 里的比例**没有被改写**；清掉注入后重试成功，Runtime 比例变为新值。
  - **渠道重载**：先成功一次（`外部渠道已重新加载`），再注入失败 → 成功行**已被替换**（旧的“已重新加载”不再显示），出现 `重新加载外部渠道失败` + `重试`。
  - **插件启停**：对第一个渠道插件注入失败 → `插件操作未完成` + 技术详情 + `重试`，并且开关**没有移动**（`aria-checked` 与点击前一致）。
  - **文件保存**：在真实 Monaco 里输入标记（Monaco 0.5x 走 `EditContext`，合成 DOM 事件无效，必须真实点击 + 带 `text` 的键盘/插入事件），Ctrl+S 触发 `允许保存工作区文件？` 审批，点“仅本次”后保存请求失败 → 编辑器状态行原地显示 `文件保存失败，请稍后重试。`（错误色调）、输入内容保留、**磁盘文件未被改写**；清掉注入重试并再次批准 → 磁盘写入新内容。
- **顺带修掉的真实缺陷（本门实机发现）**：文件保存成功后的 `已保存` 提示**看不到**——一次成功的保存会重新读取文件（`modifiedAt` 变化），而同一个重置 effect 会在同一 tick 把状态行清空。修法是 `preview-pane.tsx` 记住"这次刷新是自己的保存引起的"（`savedStatusPathRef` 只豁免紧接的那一次刷新；切换文件或外部改动仍会清空状态行）；本门新增断言：重试保存后等待 1.5 秒，状态行仍是 `已保存` 且无错误色调（修前为 `null`）。回归：`workspace/preview-save-status.test.ts`。
- 仍未覆盖：注入都在页面层按路径完成，证明的是"失败落在哪、下一步是什么"，不等价于真实后端故障的每一种形状；插件启停用发现的第一个渠道插件（不指定哪一个）；`storage.tsx` 沿用既有 `data-tone` 结构未改写，其失败路径本门未注入。

### UX-10｜渠道状态汇总准确

**问题**：总体“外部渠道运行中”和列表标题“运行中的渠道”只取决于 `channels.length`，但同一列表中单项使用 `ch.running`。列表存在不等于至少一个渠道正在运行；失败列表还单独存在。

**定位**：[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx) 的 `channel-overall`、渠道列表、failures。

- [x] 按真实运行项和失败项派生“运行中/部分异常/未运行/未配置”，保留“已配置”“已启用”“运行中”的区别。
- [x] 总体状态与逐项状态对齐，不能把配置存在或数量大于零当成连接健康。
- [x] 验收：空配置、全部停止、部分运行且部分失败、全部运行四种 fixture；标签、数量和颜色一致。若后端保证不会返回停止项，应先明确契约再简化 UI。

**实施记录（2026-09-22 22:28:19）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `renderer/channel-status.ts` 的 `summarizeChannelConnections`：按已加载渠道的真实 `running` 计数和 `failures` 计数派生 `unconfigured / stopped / partial / running` 四种总体状态，并同时给出 `运行 N/M · 已配置 K [· 失败 F]` 的计数与一句话事实（用于 title/无障碍说明）。`ChannelConnections.tsx` 的总体徽章改为该派生结果（含 partial 的警示色），列表标题由“运行中的渠道”改为“已加载渠道”，逐项新增“运行中/未运行”标签，使总体与单项使用同一批事实；`status.channels.length > 0 ? 'running' : 'stopped'` 的判断已删除。后端契约未保证 `channels` 只含运行项，因此保留逐项 `running` 判定，不简化 UI。
- 验证方式：`packages/app/src/renderer/channel-status.test.ts` 7 个用例（空配置、全部运行且无失败、已配置但全部停止（不因配置存在判健康）、部分运行且部分失败、全部未运行但有失败记录、混合运行不得把停止项算作运行，以及视图接线断言：不再出现“运行中的渠道”与旧三元判断）；`pnpm exec vitest run packages/app/src/renderer/channel-status.test.ts` 通过。
- 未覆盖项：四种 fixture 尚未在真实窗口中核对颜色与排版；`started` 字段当前未参与总体状态（它描述插件宿主是否启动过），如后续需要区分“未启动”与“未运行”，需先明确后端契约再扩展。

**实施记录（2026-09-25 07:09:54）｜状态：四种 fixture 在同一真实窗口里逐项核对通过；后端契约已写明，三项勾选**

- 实机走查（`pnpm run verify:channel-entry-states` 的第二部分，同一个窗口、同一个 外部渠道页）：每个 fixture 由脚本改写真实 `config.json`，再用页面自己的「重新加载」控件应用（实测确认按钮在重载进行中是 disabled，必须先等它可用，否则点击会被吞掉——这条时序坑已写进门内注释）。运行中的渠道是内置 webhook 插件，监听 OS 分配的 loopback 端口，不依赖任何外部服务。
- 四个 fixture 的实测（徽章类名/文案/计数/取色 + 分区标题 + 逐行标签与圆点颜色，括号内为主进程真实载荷计数）：

| fixture | 配置 | 载荷（加载/运行/已配置/失败） | 徽章 | 计数 | 徽章取色 |
| --- | --- | --- | --- | --- | --- |
| 空配置 | `channels: []` | 0 / 0 / 0 / 0 | `unconfigured`「未配置外部渠道」 | 空 | `rgb(160, 160, 160)` |
| 全部停止 | webhook，`enabled: false` | 0 / 0 / 1 / 0 | `stopped`「外部渠道未运行」 | 运行 0/0 · 已配置 1 | `rgb(160, 160, 160)` |
| 部分运行且部分失败 | webhook（enabled）+ 未安装类型的渠道 | 1 / 1 / 2 / 1 | `partial`「部分渠道运行中」 | 运行 1/1 · 已配置 2 · 失败 1 | `rgb(216, 180, 92)` |
| 全部运行 | webhook（enabled） | 1 / 1 / 1 / 0 | `running`「外部渠道运行中」 | 运行 1/1 · 已配置 1 | `rgb(111, 208, 140)` |

- 逐项与总体一致：全部停止时「已配置渠道 (1)」的圆点是 `channel-dot disabled`（`rgb(133,133,133)`）且带「已禁用」标签、页面**不出现**任何「运行中」字样；部分失败时「已加载渠道 (1)」是 `channel-dot on`（`rgb(111,208,140)`）+「运行中」，「需要处理 (1)」的失败行圆点是 `channel-dot off`（`rgb(239,104,104)`）、失败明细是危险色 `rgb(255,210,210)`，文本是真实后端原因 `channel type "littlesheep-channel-not-installed" is not provided by an active plugin`；空配置时显示「还没有配置外部渠道…」并把 `channels.channels` 放进可展开说明，其余三个 fixture 不再显示这条空态。
- **后端契约（本项要求"先明确契约"）**：载荷里的 `channels` **只含正在运行的实例**——`PluginHost.listChannels()` 读的是 `channelManager` 的运行表，`stop()` 会把条目移出该表，启动失败的渠道进的是 `failures`。四个 fixture 实测 `loaded === running` 恒成立（门内逐项断言），契约因此写进 `shared/channel-control-contracts.ts`、`packages/plugins` 的 `host.ts`/`channel/manager.ts` 注释，并由 `manager.test.ts` 新增用例（停止后 `list()` 为空且 `running` 为 false）钉住。
- **据此做的简化**：总体状态里"已加载 N 个渠道，全部未运行"这类句子在后端契约下不可达（`loaded > 0` 且无失败即 `running`），已改成陈述真实事实的「已配置 N 个渠道（M 个启用），当前没有渠道在运行」；逐项的 `running` 判定与失败计数保留为防御路径，不用它渲染后端不会给出的停止项——因为"已配置/列表非空不等于健康"正是本项要守住的判据。`channel-status.test.ts` 由 7 个用例扩到 8 个（新增"全部配置但停用"的可达状态与其文案断言）。
- 未覆盖项：① 「全部停止」只能由"已配置但停用"构造，`loaded` 非空的停止项在当前后端不可达（这正是契约的内容）；② 未测试网速/插件崩溃等造成的运行中掉线；③ `started` 字段仍未参与总体状态，需要先明确"宿主未启动"与"没有渠道在运行"的区别；④ 失败文案里的渠道名来自 `.channel-name` 的 `strong`+`small` 拼接，未做排版核对。

### UX-11｜无模型到可用模型的配置闭环

**问题**：模型选择器无供应商时显示“无可用模型”，引导依赖 title 中的设置路径；当前组件没有直接打开模型配置的动作。用户必须自己找到设置、添加配置，再返回原输入现场。

**定位**：[runtime-picker.tsx](../../packages/app/src/renderer/composer/runtime-picker.tsx) 的无模型状态与 trigger；[models.tsx](../../packages/app/src/renderer/settings/models.tsx)。

- [x] 在无模型状态提供明确的“配置模型”动作，定位到供应商设置；返回后保留原会话、文字及附件。
- [x] 区分未配置、配置加载失败、已保存但未验证可调用；不要用“已设置密钥”暗示连接成功。
- [x] 验收：新数据根从空状态完成配置并回到原草稿；加载失败可重试；保存后选择器从 Runtime 刷新。若新增真实连接检查，单列网络调用成本和实现边界。

**实施记录（2026-09-22 23:39:50）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：新增 `composer/runtime-availability.ts` 纯状态模块，把无可用模型分成“读取中 / 读取失败（可重试）/ 还没有配置（给出配置入口）/ 已保存但不可用（缺密钥或缺模型条目）”，并用设置页同一个 `isConfiguredProvider` 判定“已配置”，使输入栏与供应商页对同一份配置给出一致结论。`composer/runtime-picker.tsx` 的空菜单不再只有一行“没有已配置的可用模型”，而是给出事实与动作（“配置模型”/“检查供应商配置”/“重试读取”）；触发按钮在配置读取失败时保持可点（否则菜单里的重试永远到不了），标题与空菜单都使用同一句事实。`app-shell/composer-view.tsx` 把 `openSettingsPage('api')` 与 `refreshRuntime` 传给选择器——打开设置只是路由切换，不清空当前文字与附件；从设置返回后由既有的 `settingsOpen` 变化 effect 重新读取 Runtime，保存过的供应商随即可见。`settings/models.tsx` 的空态改为“保存成功才会出现在选择器里”并明确写出“保存配置不代表已经验证可以调用”，不再用密钥状态暗示连接成功。本轮没有新增任何真实连接检查，因此没有新增网络调用。
- 验证方式：`composer/runtime-availability.test.ts` 7 个用例（读取失败与首次空态分开、未配置给出配置入口、自定义供应商缺密钥/缺模型为不可用、内置预设未配置与已配置的判定与设置页一致、只有可解析的已选模型才算 ready，以及选择器空菜单动作、`openSettingsPage('api')`/`refreshRuntime` 接线与“打开设置不清空草稿”的断言）；`pnpm exec vitest run packages/app/src/renderer` 101 个文件 / 538 个用例全部通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 通过。
- 未覆盖项：新数据根从空状态走完配置并回到原草稿的真实流程未走查；“已保存但不可用”只依据 Runtime 返回的 `hasKey`/模型条目，未做真实可调用性验证（任务书允许，若将来新增连接检查需单列网络成本）。空菜单在窄窗口下的排版与 UX-15 一并验收。

**实施记录（2026-09-25 05:52:30）｜状态：三条验收已在真实窗口跑通，过程中发现并修掉两处真实缺陷（"没选模型"被说成"配置不可用"、自定义供应商的模型引用被误判为未列出）；三项勾选**

- 新增真实窗口门 `pnpm run verify:no-model-config-loop`（[verify-no-model-config-loop.mjs](../../scripts/verify-no-model-config-loop.mjs)）：**空数据根**（`providers: []`、`model: ''`）跑完整首次配置闭环；读取失败一类用页面 fetch 探针注入 `GET /runtime` 500。
- 实测（1280×840，隔离数据根）：
  - **未配置**：入口显示 `还没有配置模型`（title「还没有配置任何供应商；在 设置 → 模型供应商 里添加服务、密钥和模型。」），先输入草稿并粘贴 1 个附件；菜单里给出同一事实与动作 `配置模型`。
  - **配置动作**：点 `配置模型` 直接落在「模型供应商」页，菜单自动关闭；供应商页空态原文含「保存成功后它才会出现在输入栏的模型选择器里」与「保存配置只代表写入了密钥和模型声明，不代表 LS 已经验证过它真的可以调用」；**草稿与附件都还在**（1 个附件）。
  - **已保存但不可用**：先只存一个自定义地址（无密钥、无模型）→ 卡片显示「尚未添加模型」，退出设置后探针记录到 Runtime 被重读（2 → 3 次 `/runtime`），入口改为 `已配置的供应商还不可用` + `检查供应商配置`，文案含「保存配置不等于已经验证可以调用」。
  - **保存后从 Runtime 刷新**：补上密钥与模型条目保存并返回后，探针再次记录到重读（3 → 4 次 `/runtime`），菜单里**无需刷新页面**就列出新模型 `slow-a`。
  - **选中模型**：点该模型 → `PATCH /runtime` 返回 200，配置里写入 `acceptance-gw/slow-a`，入口变为 `slow-a`，`.composer-error` 为空；整段往返后草稿原文与 1 个附件都未变。
  - **读取失败可重试**：注入 500 后入口为 `模型配置读取失败`（title「未能读取模型配置：Local app API error: 500」），菜单给出 `重试读取` 与同一原因；按住注入再点一次 → 探针确认又请求了一次且仍是失败态（不会假装就绪）；清掉注入后点 `重试读取` → 模型出现、`.composer-error` 清空。
- **顺带修掉的真实缺陷（本门实机发现，两处）**：
  1. **“还没选模型”被说成“供应商不可用”**：`runtime-availability.ts` 把 `selectableProviderCount > 0 && !hasSelectableModel` 并入 `unusable`，于是刚存好密钥和模型条目的用户被告知「可能缺少 API 密钥，或没有填写模型条目」，被送回一份本来正确的配置页。现在新增 `no-selection`（「还没有选择模型 / 供应商已经可以使用；打开这个菜单选一个模型。」），`unusable` 只在真的没有可用供应商时出现；`runtime-availability.test.ts` 新增两条断言区分二者，并断言其文案不再提“密钥”。
  2. **自定义供应商的模型引用被误判**：`runtime-routes.ts` 的 `validateModelRef` 用 `provider.models.includes(model)` 比较，而配置允许 `models` 是裸 id 或**带元数据的对象**（设置页保存的自定义供应商就是 `[{ id: 'slow-a' }]`），于是选择器能列出、能点，选中后却被 500 拒绝（`model "slow-a" is not listed for provider "acceptance-gw"`）。改为按 `resolveProviderModelIds` 解析后比较；新增 `runtime-model-ref.test.ts` 3 个用例（对象形状可选中、裸 id 形状仍生效、无模型列表不设限、未知供应商与缺密钥仍拒绝）。
- 仍未覆盖：本路径不新增真实连接检查，因此「已保存但可调用」仍按 Runtime 的 `hasKey`/模型条目判断（任务书允许；将来若加真实检查需单列网络成本）；附件用合成 paste 注入而非系统文件对话框；菜单与供应商表单在窄窗口/缩放下 的排版属于 UX-15，本门只看功能闭环。

### UX-12｜设置与工作模块的信息架构

**现状与建议**：设置总览复制全部分组；记忆树、插件、已安排又可作为独立工作页打开；“Agent 行为”内同时放行为 profile、压缩阈值、对话显示。多个入口不是必然错误，但当前位置、返回目的地和设置归属需要一致。

**定位**：[navigation.ts](../../packages/app/src/renderer/settings/navigation.ts)、[home.tsx](../../packages/app/src/renderer/settings/home.tsx)、[direct-module.tsx](../../packages/app/src/renderer/settings/direct-module.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)。

- [x] 先画出现有入口—页面—返回目标映射，确定每个模块唯一页面身份，保留有价值的快捷入口而不复制状态。
- [x] 对话显示归入界面偏好；压缩阈值作为高级上下文配置按需展开；profile 与权限继续分离。
- [x] 验收：从聊天、独立模块、设置总览进入同一功能时名称和状态一致；返回到来处；常见配置可按用户意图找到。先验证小幅重排，避免整套导航重建。

**实施记录（2026-09-22 23:52:31）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：入口 → 页面 → 返回目标映射写入 `settings/README.md`（设置总览、设置侧边栏各页、侧边栏直接模块页、embedded 归档/技能/外部渠道四类入口各自的返回目标），并明确页面身份由 `settings/types.ts` 的 `SettingsPage` 联合类型唯一声明。小幅重排：新增设置页「界面」`settings/appearance.tsx`，把「对话显示」（普通/紧凑）从「Agent 行为」移出；「Agent 行为」只保留 profile 与上下文策略，压缩阈值收进 `<details class="settings-advanced">` 的“高级上下文设置”；权限继续只由输入栏权限模式控制，页面文案重复声明该边界。新页同时登记到 `navigation.ts` 分组、`persistent-state.ts` 可恢复集合与 `workspace.tsx` 渲染分支（不登记会导致重启恢复静默丢页）。
- 验证方式：`settings/navigation.test.ts` 6 个用例——`SettingsPage` 联合类型、导航分组、可恢复集合、工作区渲染分支四者的集合必须一致（新增页面漏登记即失败）；直接模块页允许走共享分支但必须能被 `direct-module.tsx` 映射；「界面」独占显示密度、Agent 页不再持有显示偏好；阈值行必须位于折叠区内；README 必须保留映射表与各模块名称。`pnpm exec vitest run packages/app/src/renderer` 103 个文件 / 548 个用例全部通过；`tsc -b` 通过。
- 未覆盖项：未在真实窗口从聊天、直接模块页与设置总览三处进入同一功能核对名称与返回位置；本轮按“小幅重排”执行，没有重建导航或合并设置分组；`use-navigation-controller.ts` 的历史快照未改动。

**实施记录（2026-09-25 06:55:20）｜状态：三处入口的名称与返回位置已在真实窗口逐条走通，唯一“不足”（外部渠道页标题与导航条目不同名）已统一；三项勾选**

- 新增真实窗口门 `pnpm run verify:settings-navigation-terminology`（[verify-settings-navigation-terminology.mjs](../../scripts/verify-settings-navigation-terminology.mjs)），同时覆盖 UX-12 与 UX-13 的验收项。夹具是**空配置**数据根（无供应商、无渠道），因为“从聊天进入模型设置”这条入口只在无模型时才由输入栏自己给出。
- 实测（1280×840，隔离数据根）：
  - **从聊天**：先输入草稿 → 打开模型选择器 → 点“配置模型” → 落在「模型供应商」（`activeNav` 与页面标题同为「模型供应商」）；点“退出设置”回到聊天，**草稿仍在**。返回目标与 README 的映射表一致。
  - **设置总览**：总览 14 行与侧边栏 15 项逐行同名（`missingInNav: []`，唯一不出现在总览里的是“总览”自己）。
  - **总览 → 页面 → 返回来处**：从总览点「外部渠道」→ `activeNav` 与标题一致，关闭后回到聊天（进入前的那一页）。
  - **工作模块**：记忆树 / 已安排 / 插件各自“侧边栏直入页标题 = 设置页标题 = 导航条目名”，并且**从直入页打开设置再关闭，回到的是该模块页而不是聊天**（三个模块逐条实测）。
  - **重排后的页面边界**：`界面` 页有且只有两个显示密度选项（`普通`（选中）/`紧凑`，页面上不出现 `Normal`/`Compact`）；`Agent 行为` 页的压缩阈值仍**折叠**在“高级上下文设置”里（`details.open === false` 且阈值控件在其中），该页没有任何权限模式控件（权限继续只由输入栏控制）。
- **顺带修掉的真实缺陷（本门实机发现）**：外部渠道页的标题是「渠道连接」，而同一条目的导航名、空态文案、重载反馈与“活动任务来源”标签都写「外部渠道」——同一功能两个名字。已把标题统一为「外部渠道」；门内断言“页面标题 === 导航条目名”覆盖三个入入口。
- **UX-13 的渲染侧复核**（源码扫描 `terminology.test.ts` 之外的补充）：四个被访问页面拼起来的文本里没有退役说法「提供方」；`技能` 页渲染「当前版本只能查看内容，不能在界面里启用、禁用或编辑技能」；`已安排` 页渲染「还没有接入 Runtime」「功能尚未接入」；渠道空态渲染「还没有配置外部渠道，当前没有渠道可以运行。这个版本还没有渠道配置界面。」并把精确字段放进可展开的“在哪里配置”（`config.json` 的 `channels.channels`）。本轮未新增任何模板化 Agent 回复，也未改动 Runtime 文案。
- 仍未覆盖：走查覆盖聊天、设置侧边栏、设置总览与三个直入模块这四类入口，没有逐页枚举全部 14 个设置页；术语检查读的是被访问页面的渲染文本，不能替代源码扫描；`session`/`workspace` 等代码标识符仍不在文案范围内。

### UX-13｜术语和产品文案

**问题**：同一供应商功能混用“提供方/供应商”；中文设置页显示 Normal/Compact；总览和技能页描述“后续功能模块”“后续可继续接”；外部渠道无配置时直接要求编辑 `config.json` 的嵌套字段。

**定位**：[models.tsx](../../packages/app/src/renderer/settings/models.tsx)、[model-provider-editor.tsx](../../packages/app/src/renderer/settings/model-provider-editor.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)、[home.tsx](../../packages/app/src/renderer/settings/home.tsx)、[MemorySkills.tsx](../../packages/app/src/renderer/MemorySkills.tsx)、[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx)。

- [x] 建立小型术语表：供应商、模型、对话、任务、项目、工作区、应用数据目录；Normal/Compact 使用一致的中文显示名。
- [x] 功能说明只描述当前可用能力；高级配置字段放入可展开说明或帮助入口，未提供配置 UI 时如实说明限制。
- [x] 验收：相同概念在标题、按钮、提示和空态一致；路径/状态事实不被文案重写；不增加模板化 Agent 回复。

**实施记录（2026-09-22 23:46:30）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：术语表新增到 [UI 交互规范](../principles/ui-interaction-guidelines.md) 的“术语表”一节（供应商、模型、对话、任务、项目、工作区、应用数据目录，以及“普通/紧凑”），并规定面向用户文案只描述当前可用能力。代码侧统一了“提供方 → 供应商”（`settings/models.tsx`、`model-provider-editor.tsx`、`chat/assistant-turn.tsx` 的用量/模型/来源标签、样式注释与 `renderer/README.md`），对话显示密度改为“普通/紧凑”（存储仍是 `normal`/`compact`）。开发计划式文案改为当前事实：`settings/home.tsx` 的“后续功能模块”改为“工作模块的设置入口”，`MemorySkills.tsx` 的“后续可继续接启用、禁用和编辑”改为“当前版本只能查看内容，不能在界面里启用、禁用或编辑技能”，拓展工作区的侧边聊天占位改为“侧边聊天尚未接入 / 当前版本还不能在这里进行局部对话”。外部渠道空态不再把嵌套字段当作第一步：主文案说明“还没有配置外部渠道”和“这个版本还没有渠道配置界面”，精确的 `channels.channels` 与应用数据目录 `config.json` 放进可展开的“在哪里配置”。
- 验证方式：`terminology.test.ts` 4 个用例，其中术语一致性与禁用文案是对整个 `packages/app/src/renderer` 源码树的扫描（排除测试文件），因此新增文案引入旧说法会直接失败；另断言对话显示用中文名、未接通表面写明“尚未接入”、渠道空态把精确配置字段放进披露而不是主指令。`pnpm exec vitest run packages/app/src/renderer` 101 个文件 / 538 个用例全部通过；`tsc -b packages/app/tsconfig.json packages/app/tsconfig.web.json` 通过。
- 未覆盖项：术语表只覆盖本轮出现的概念，`session`/`workspace` 等代码标识符不在文案范围内；未在真实窗口逐页核对文案；未新增模板化 Agent 回复，也未改动任何 Runtime 文案。

**实施记录（2026-09-25 06:55:20）｜状态：渲染侧文案与术语一致性已在真实窗口复核（与 UX-12 同一道门），顺带统一了外部渠道页标题；三项勾选**

- 验证方式与实测结果见上一条 UX-12 的实施记录：`pnpm run verify:settings-navigation-terminology` 在真实窗口读取被访问页面的**渲染文本**，断言（1）四个页面拼接文本中不出现退役说法「提供方」；（2）`界面` 页的两个显示密度选项为「普通/紧凑」且页面不出现 `Normal`/`Compact`；（3）`技能` 页写「当前版本只能查看内容，不能在界面里启用、禁用或编辑技能」；（4）`已安排` 页写「还没有接入 Runtime」「功能尚未接入」；（5）渠道空态写「还没有配置外部渠道……这个版本还没有渠道配置界面。」并把 `config.json` 的 `channels.channels` 放进可展开的“在哪里配置”；（6）外部渠道页标题与导航条目同名（修前是「渠道连接」，见 UX-12 记录的缺陷条目）。
- 与源码扫描的分工：`terminology.test.ts` 保证整个 `packages/app/src/renderer` 不再出现旧说法与新文案被改回；本门保证**这些文案真的渲染到屏幕上**、并且同一个概念在不同入口显示同一个名字。两者互补，都不涉及 Runtime 文案。
- 仍未覆盖：同上一条（未逐页枚举、代码标识符不在范围内）；本轮没有新增模板化 Agent 回复，也没有改动任何 Runtime 生成的文案。

### UX-14｜共享 UI 的增量收敛

**现状与建议**：颜色、圆角、动效已有 token；反馈和操作按钮仍有 `dialog-*`、`storage-settings-*`、`plugin-page-*`、`archive-*` 多套表面。类名不同本身不等于视觉缺陷，应先按截图与行为确认重复，再抽取。

**定位**：[ui/README.md](../../packages/app/src/renderer/ui/README.md)、[03-shell-sidebar.css](../../packages/app/src/renderer/styles/03-shell-sidebar.css)、[07-overlays-settings.css](../../packages/app/src/renderer/styles/07-overlays-settings.css)、[09-projects-archive.css](../../packages/app/src/renderer/styles/09-projects-archive.css)。

- [x] 建立小范围状态样本：主/次/危险按钮、输入、空态、错误、pending、只读；复用现有 token，补必要的字号/间距角色。
- [x] 优先随 UX-04/07/09 抽取 AsyncFeedback、Dialog 等确有复用收益的基元，不全仓机械替换样式。
- [x] 验收：同类控件的高度、文字层级、聚焦、禁用、等待和危险样式一致；保留既有黑灰主题、紧凑布局、reduced-motion 与圆角例外。

**实施记录（2026-09-25 06:51:16）｜状态：实机验收通过，三项勾选**

- 实机走查：新增 `pnpm run verify:shared-ui-roles`（[scripts/verify-shared-ui-roles.mjs](../../scripts/verify-shared-ui-roles.mjs)）。1280×840 真实窗口 + 确定性 Provider 桩，**47 项断言全部通过（failures 为空）**，24 个观测步骤，12 张截图（`%TEMP%\littlesheep-shared-ui-roles\screenshots\`，含设置页、插件通知/失败、渠道失败与忙态、存储错误、归档错误、对话框保存中、键盘聚焦、策略行）。
- **① 五处浅红统一（真实渲染面测量）**：`dialog-error`（清空 API 地址触发真实校验错误「API 地址必须是 http(s) URL。」）、`plugin-page-error`、`storage-settings-notice[data-tone=error]`、`web-settings-notice.error`、渠道失败明细（配置里放一个类型没有插件提供的渠道 `littlesheep-channel-role-fixture`，页面真实渲染 `channel type "…" is not provided by an active plugin`）全部测到 `color: rgb(255, 210, 210)`。本轮夹具到不了的 `web-source-errors`、`plugin-list-error`、`plugin-runtime-state.failed`、`runtime-event-notice.error`、`composer-error`、`activity-tool-error`、`tool-live-err`、`agent-transcript-attention`、`project-creator-error` 用**在活动设置页里挂真实类名**的样本读级联，同样是 `rgb(255, 210, 210)`；同批的中性样本 `dialog-hint` 仍是 `rgb(160, 160, 160)`，所以“到处都是危险色”不会让这条断言通过。
- **② 插件通知几何**：真实成功通知「插件已重新发现并加载」与真实失败通知「插件操作未完成」都测得 `padding 8px / 10px`、`font-size 12px`（原 `7px 9px` / `11px`）；失败通知的重试动作 `.feedback-action` 26px / 12px / 圆角 10px。
- **尺寸角色（本轮新增收敛，均为实机测量）**：页头动作统一 32px（`.plugin-reload-button` 原 30px、`.development-environments-refresh` 原 30px、`.archive-refresh` 32px 改为同一 token），段内紧凑动作统一 30px（`.settings-policy-row button` 原 29px，`.storage-settings-row button`、`.storage-settings-actions button`、`.web-cache-clear`、`.ms-feedback-action`、`.memory-file-save`、`.provider-remove` 由 30px 字面值改为 `--control-height-row`），行内通知动作 26px，提交控件 32px/13px，常规控件 32px/12px；对话框关闭 30px 与 `archive-action` 26px、`approval-action` 34px、48px 大块选择仍按角色保留。
- **禁用与等待**：新增 `--control-disabled-opacity: 0.42`（大块选择保留 `--choice-disabled-opacity: 0.58`），补齐此前**完全没有禁用样式**的 `close-btn`、`toggle-btn`、`refresh-btn`、`danger-btn`、`dialog-close`（供应商编辑器的取消/关闭在保存中确实带 `disabled`，此前看不出区别）。实测进行中的控件全部 `disabled=true` 且 `opacity: 0.42`：保存中的保存/取消/关闭（保存按钮文案变为“保存中…”，编辑器状态行同步）、插件重载（“加载中”）、插件开关与通知重试按钮、渠道刷新与重载（“重新加载中...”）、存储动作（“清除中”）、归档刷新；未在忙碌但确实禁用的策略行保存按钮同样是 0.42。
- **聚焦**：键盘 Tab 在真实对话框里测到两种可见聚焦——设置字段 1px solid `rgb(226, 226, 226)`（offset 2px），模型胶囊按钮 2px solid `rgba(226, 226, 226, 0.32)`（offset 2px，全局规则）；`settings-sidebar-exit` 这类页面级控件用背景/边框/文字同时变化的表面反馈。没有测到“聚焦但看不出”的样本。
- **保留项（逐条测量）**：黑灰主题 token 全为灰阶（`#141414`/`#1c1c1c`/`#202020`/`#252525`/`#2a2a2a`/`#e8e8e8`/`#343434`/`#474747` 等 r=g=b）；紧凑布局保持 32/30/26px 家族；`--radius-ui: 10px` 与 `--radius-icon: 3px` 未被破坏；`prefers-reduced-motion: reduce` 下 0.14s 过渡与 0.18s `content-fade-in` 全部塌到 0.001s。
- 源侧契约：`ui-state-consistency.test.ts` 从 5 个用例扩到 7 个（新增“一种动作角色一个高度”“一种角色一个禁用色调”，后者要求样式里不得再出现 `opacity: 0.42` 字面值、`--choice-disabled-opacity` 必须成对声明）。`pnpm exec vitest run packages/app/src/renderer` 114 文件 / 625 用例全部通过。
- 未覆盖项：① 密集行/工具条/选择器角色（侧栏导航与树行、工作区文件树与浏览器工具条、聊天历史“加载更早”、输入栏选择器）仍各自使用 0.3–0.72 的禁用透明度，本轮**没有**收敛，取值与理由记在 `ui/README.md`——任务书明确要求不做全仓机械替换，收敛它们需要各自的实机对照；② 输入、空态、只读三类只做清点与记录，未改取值；③ 上文的合成样本只能证明样式级联，不替代这些表面的真实交互走查；④ 失败/等待/禁用态由页面内注入的传输故障（hold/fail 一次请求）驱动，视图、标记与样式是真实的，注入本身不是产品行为。

**实施记录（2026-09-22 23:57:19）｜状态：实现完成，实机验收未做，保持未勾选**

- 实现范围：先测量再抽取——逐条比对了错误面（`dialog-error`/`archive-error`/`project-creator-error`/`storage-settings-notice[data-tone=error]`/`plugin-page-error`/`plugin-list-error`/`web-source-errors`/`activity-tool-error` 等）与控件角色（`save-btn`/`reload-btn`/`danger-btn`/`close-btn`/`toggle-btn`/`refresh-btn`/`feedback-action`）的实际声明，确认了真实重复：同一“危险文本”角色出现四种浅红（`#ffd2d2`、`#e8c5bd`、`#f2b6b6`、`#f0a9a9`、`#e5a6a6`），行内通知内边距/字号有 7-9px/11px 与 8-10px/12px 两套。随后新增角色 token（`--feedback-danger-text`、`--feedback-danger-border`、`--danger-control-text`、`--notice-padding-block/inline`、`--notice-font-size`、`--control-height-md/sm`、`--control-font-size`、`--control-font-size-strong`）并把上述角色改为引用 token。状态样本与例外清单写入 `ui/README.md`。**没有**全仓机械替换：大块选择（`provider-add`/`profile-choice` 48px）、对话框主操作（`approval-action` 34px）、紧凑行操作（`archive-action` 26px）、胶囊（`provider-remove` 30px）和圆角例外（`--radius-icon: 3px`）都按角色保留。
- 验证方式：`ui-state-consistency.test.ts` 5 个用例直接测量样式源——角色 token 必须存在；错误面全部引用 `--feedback-danger-text` 且样式里不得再出现任何浅红字面值（防止漂移回流）；行内通知几何统一；同类控件高度/字号一致且例外仍在；`--radius-ui: 10px`、`--radius-icon: 3px`、`--motion-base: 180ms`、`prefers-reduced-motion` 块未被破坏。`pnpm exec vitest run packages/app/src/renderer` 104 个文件 / 553 个用例全部通过；`tsc -b` 通过。
- 未覆盖项：**本轮没有任何真实窗口或截图证据**。其中零计算变化的 token 化不改视觉；但有两处是真实取值变化，必须在实机确认：① 五处浅红统一为 `#ffd2d2`（`storage-settings-notice` 错误色、`web-source-errors`、`web-settings-notice.error`、`plugin-runtime-state.failed`、渠道失败明细），② `plugin-page-notice/.plugin-page-error` 的内边距 7px 9px → 8px 10px、字号 11px → 12px。此外“输入、空态、pending、只读”四类只做了清点与记录，未改动取值（避免无证据的视觉变更）。

### UX-15｜窄窗口与高 DPI 验证

**风险线索**：模型编辑器使用两列弹性字段加 `150px 150px 26px` 固定列；多个设置辅助标签为 10/11px。源码可确认尺寸，不能据此断言真实窗口已经裁切或对比度不合格。

**定位**：[07-overlays-settings.css](../../packages/app/src/renderer/styles/07-overlays-settings.css) 的 `provider-model-row`、`provider-model-columns` 与辅助文字；[model-provider-editor.tsx](../../packages/app/src/renderer/settings/model-provider-editor.tsx)。

- [x] 在应用允许的最小窗口、常用窗口、125%/150%/200% 系统缩放下验证模型表单、设置侧栏、审批长路径、运行时选择器。
- [x] 出现不足时按可用宽度切换模型字段为堆叠布局，确保字段仍有独立标签；只调整实测难读文字，测量前不宣称符合或违反对比度标准。
- [x] 验收：关键按钮始终可达；字段不会压缩到无法输入；页面无非必要横向滚动；长路径可完整查看/复制；记录窗口逻辑尺寸、系统缩放和截图。

**实施记录（2026-09-22 23:59:00）｜状态：源码侧风险已定位，修复取决于实测；保持未勾选**

- 已完成（无窗口可做的部分）：把源码中可确认的尺寸风险逐条定位——模型编辑器 `provider-model-columns` 为固定 `150px 150px 26px` 列（`model-provider-editor.tsx` 的四个模型字段加删除按钮），窄宽度下会被挤压；设置辅助文字存在 10/11px；审批详情是 `pre` 长路径；运行时选择器主面板 + 两级子菜单有固定宽度。这些只是**源码事实**，按任务书要求不能据此断言真实窗口已经裁切或对比度不合格。
- 未实施的修改及原因：堆叠布局的触发条件是“出现不足”，必须先用真实窗口测量；在没有实测前改结构属于无证据的视觉变更，本轮不做。UX-14 的两处取值变化也并入同一次实测。
- 待执行脚本（每项记录窗口逻辑尺寸、系统缩放、截图路径，结论按“通过/不足/需修改”三选一）：
  1. 最小窗口（应用允许的最小尺寸）+ 常用窗口各一次，逐个检查：模型编辑器四个字段能否输入、标签是否仍可读、删除按钮是否可达；设置侧栏是否出现非必要横向滚动；审批对话框的长路径 `pre` 是否可完整查看与复制；运行时选择器主面板与两级子菜单是否溢出。
  2. 系统缩放 125% / 150% / 200% 各重复第 1 步。
  3. 对每个“不足”记录：控件名、当前可用宽度、被裁切或压缩的表现、截图；只有出现不足才按可用宽度切换堆叠布局并给每个字段补独立标签。

**实施记录（2026-09-25 06:29:40）｜状态：五组窗口×缩放组合实测完成，唯一"不足"（模型行字段被压到 44px）已按第 2 条改为堆叠布局并复测通过；三项勾选**

- 新增真实窗口门 `pnpm run verify:narrow-high-dpi-forms`（[verify-narrow-high-dpi-forms.mjs](../../scripts/verify-narrow-high-dpi-forms.mjs)）：五组组合逐一测量 **模型供应商表单 / 设置侧栏 / 运行时选择器（含模型子菜单）/ 审批长路径**，每组记录逻辑视口、`devicePixelRatio`、真实几何与截图。缩放按系统缩放的真实含义模拟：物理窗口不变，渲染器看到的是对应的 CSS 视口与 `devicePixelRatio`（`Emulation.setDeviceMetricsOverride`）。
- 五组组合（`verify:narrow-high-dpi-forms` 实测）：
  | 组合 | 逻辑视口 | DPR | 设置内容宽 | 模型行 | 最小字段 | 表单保存/删除按钮 | 页面横向溢出 | 选择器菜单 | 审批框 |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 最小窗口 100% | 800×600 | 1 | 474 | 堆叠（`425px 26px`） | 425px | 可达 / 可达 | 0 | 在视口内、模型项可达 | 420×480 在视口内、三个动作可达 |
  | 常用窗口 100% | 1280×840 | 1 | 760 | 一行（`229/164/150/150/26`） | 150px | 可达 / 可达 | 0 | 同上 | 同上 |
  | 常用窗口 125% | 1280×840 | 1.25 | 760 | 一行 | 150px | 可达 / 可达 | 0 | 同上 | 同上 |
  | 常用窗口 150% | 1280×840 | 1.5 | 760 | 一行 | 150px | 可达 / 可达 | 0 | 同上 | 同上 |
  | 最小逻辑窗口 200% | 800×600 | 2 | 474 | 堆叠 | 425px | 可达 / 可达 | 0 | 同上 | 同上 |
- **实测到的唯一“不足”与修复**：`provider-model-row` 原为 `minmax(0,1.4fr) minmax(0,1fr) 150px 150px 26px` 固定两列 150px，在 800×600（设置内容宽 474px）下两个弹性字段被压到 **62px 与 44px** —— 44px 无法输入模型 ID（修复前该行的 `aria-valuenow` 数字证据：`columns: 62.2188px 44.4375px 150px 150px 26px`）。按第 2 条改为**容器查询**（`.provider-editor` 为容器，≤560px 时）：模型行变 `minmax(0,1fr) 26px`、字段各占一行、共享列名表头隐藏、每个字段显示自己的标签（新增 `provider-model-field-label`，宽布局下 `display:none`，字段包裹层宽布局下 `display:contents` 以保持原网格）；每个输入另加 `aria-label`，两种布局都有可访问名称。复测：堆叠后四字段各 425px、四个标签可见、列名表头隐藏、删除/保存/关闭可达、无横向溢出；宽布局行为与数值不变。
- **关键按钮可达性**：供应商编辑器的保存/关闭按钮在最小窗口下位于首屏之下，门内按"滚动后可达"判定（`scrollIntoView` 后再命中测试），实测选中后可达；审批框（含长路径 `pre`）在五组组合中都完整位于视口内，三个动作均可达。
- **长路径**：审批详情的 `pre` 在五组组合中都输出完整路径（含 `very-long-project-name-for-ux15` 等深层目录段）、`overflow-x: auto`（更长的路径可横向滚动而不是被裁掉）、`user-select: auto`（可选中复制）；门内断言路径文本完整、可选中、可滚动。
- **未调整的项（按"只有出现不足才改"）**：辅助文字实测 `provider-model-field-label` / `provider-model-columns` / `provider-editor-key-note` 均为 11px（源码风险线索提到的 10/11px 属实），在 100% 缩放下与既有密度约定一致，本次**未**改动；本轮没有做对比度测量，因此不宣称符合或违反任何对比度标准（对比度与层级属于 UX-22，已在那里按实测记录）。
- 仍未覆盖：缩放用 `Emulation.setDeviceMetricsOverride` 模拟，没有真机 125%/150%/200% 显示器；200% 组合用的是应用允许的最小逻辑窗口（800×600），因为窗口无法再小；截图存放在临时数据根（不提交）。

### UX-16｜对话与拓展工作区的完整场景验收

**现状与建议**：已有滚动锚点、上下文详情、Normal/Compact、会话工作区恢复及分栏测试，不应重复登记为缺失功能。本轮没有真实窗口证据，需验证组合场景后只修复实际失败项。

**定位**：[chat-view.tsx](../../packages/app/src/renderer/app-shell/chat-view.tsx)、[assistant-turn.tsx](../../packages/app/src/renderer/chat/assistant-turn.tsx)、[chat-scroll-anchor.ts](../../packages/app/src/renderer/chat/chat-scroll-anchor.ts)、[workspace/README.md](../../packages/app/src/renderer/workspace/README.md)、[workspace-persistence.ts](../../packages/app/src/renderer/workspace-persistence.ts)。

- [ ] 覆盖流式长回答时向上阅读、返回底部、添加多附件、展开长工具结果、输入多行草稿、双栏拖动/折叠/全屏及返回。
- [ ] 覆盖两个对话切换后的文件标签、未保存草稿、浏览器和目录现场，再覆盖重启恢复；沿用现有连续性专项的 Runtime 验收，不另建重复执行器。
- [ ] 核对普通/紧凑显示均保留失败、权限拒绝、未验证、部分完成和待用户事项；默认可找到最终成果，不为减少噪声隐藏重要状态。
- [ ] 验收：阅读位置不被流式内容抢回，输入与底部成果不被遮挡；现场不串会话；真实失败逐项附复现步骤、截图和修复记录，正常场景只记通过，不追加“重设计”任务。

**实施记录（2026-09-25 08:57:00）｜状态：第 2 条的双会话走查尝试过但未得出结论（记录三处夹具阻塞）；保持未勾选**

- 本轮把双会话现场隔离加进同一道门（同一会话里开文件标签 + 留未保存草稿 + 展开目录 + 浏览器地址 → 新建第二个对话确认不继承 → 切回确认恢复）。**没有完成**，三处阻塞如实记录，均为**夹具观察**而非已确认的产品缺陷：
  1. 会话 A 的"打开文件标签"没成功：从 `.workspace-tree` 的行名派发点击后 `dirtyTabs` 仍为空、编辑器里的文本仍是审阅表面的内容（20 字符），因此"未保存草稿"没有被建立。下一轮先确认文件树行的真实点击目标（行按钮、双击，还是必须先切到"文件"标签）再测草稿。
  2. 点侧边栏的"新建对话"（`.sidebar-new-action`）后 `localStorage` 的 `littlesheep.ui.activeSession` 没有变化，因此第二个会话没有建立。下一轮先确认新建对话是先进入草稿会话、还是必须先发出第一条消息才落库，再判断"切换后不继承"这条断言怎么写。
  3. `.workspace-browser-address` 的输入框在夹具里没有挂载（`browserAddress: null`），"浏览器现场"这一步同样未成立；目录现场只测到一半（展开 `notes/` 后 alpha/beta/gamma 行确实出现）。
- 这三条是**下一轮的入口条件**，不是产品结论：本轮没有把它们写成缺陷，也没有据此改动任何产品代码。未验证的新增段落已从门里回退，门的源码仍是上一轮通过的状态（30 项断言）；这一行继续保持未勾选。

**实施记录（2026-09-25 07:56:30）｜状态：第 1 条已在真实窗口通过；第 2 条只做了单会话，第 3 条未测；保持未勾选**

- 新增真实窗口门 `pnpm run verify:conversation-workspace-scenarios`（[verify-conversation-workspace-scenarios.mjs](../../scripts/verify-conversation-workspace-scenarios.mjs)）：1100×700，**30 项断言全部通过（failures 为空）**，15 个观测步骤、12 张截图（`%TEMP%`）；回答由确定性 Provider 流式产生（每 40 ms / 6 字符），工具结果来自真实 `glob`（夹具工作区 64 个文件）。
- **第 1 条逐项实测**（"阅读位置不被流式内容抢回，输入与底部成果不被遮挡"）：
  - 流式阅读：答案到达 637 字符时把读者移到距底 325 px（锚点是那条用户消息，视口内偏移 24 px），继续到 849 字符（+212）后**锚点位移 0 px**；"回到最新"入口在离开底部的整段时间可见（`data-new-content=true`），点按后底边距离 0 px、提示消失；答案结算后底边距离 1 px。
  - 多行草稿：流式进行中用**真实 Shift+Enter** 键入三行（`第一行草稿\n第二行草稿\n第三行草稿`），离开底部、返回底部、答案结算后都仍是三行且未被发送（用户消息数不变）。门内踩到的坑记在这里：主输入框只拦截普通 Enter，Shift+Enter 必须作为**能产生文本的按键**派发（`keyDown` + `text:'\r'`），否则"三行草稿"会静默变成一行。
  - 输入与底部成果不被遮挡：每一步都测到 `composerVisible=true`、工作区面板与输入框矩形**不相交**；结算前最后一条消息的底边 500.26 px 仍在输入框顶边之内。
  - 多附件：一次粘贴三个文件 → 3 张附件卡片；发送后用户消息里三个名字齐全，三个附件（含内容）都进了 Provider 请求（第 2 个请求正文 11,451 字符，按名字或内容标记逐项核对）。
  - 长工具结果：该回合真实调用了 `glob`，工具行 `搜索，**/*`（`pass`）展开后 `panelOpen=true`、面板高 255 px、**不与输入框相交**；Input 段是 `{"pattern":"**/*","max_results":100}`，Output 段是运行时记录下来的 **400 字符 / 4 行**清单（工具有界化之后才进转录）。
  - 双栏：打开面板后 面板 310 / 对话 528；向左拖 160 px → 面板 410 / 对话 428（**两侧各变化 100 px**，方向相反）；折叠后输入框仍可见；重新展开恢复 410（不是默认值）且标签仍在；全屏 → 面板 610 / 对话 238；退出全屏恢复 410 / 对话 427，标签与输入框都在。
- 门本身的两个诚实说明：① 需要审批的操作门会像用户一样点同意（本轮 `approvals=0`，即默认权限模式下这些操作没有被拦）；② 只覆盖一个会话、一个窗口。
- **仍未做（保持未勾选）**：① 第 2 条要的"两个对话各自的文件标签、未保存草稿、浏览器与目录现场来回切换不串会话"只做了单会话；重启恢复那一半按本项要求沿用现有连续性专项（`pnpm run verify:electron-ui-state-continuity` 已记录草稿、设置路由与工作区宽度跨重启恢复），本轮**没有重跑**它；② 第 3 条（普通/紧凑显示保留失败、权限拒绝、未验证、部分完成、待用户事项）仍只有 `chat/activity-visibility.test.ts` 的单元证据与上一轮的修复记录，真实窗口里的五类状态矩阵未走查。

**实施记录（2026-09-23 00:02:00）｜状态：第三项已修复并回归，其余待实机；保持未勾选**

- 已完成（无窗口可做的部分）：核对“普通/紧凑显示均保留失败、权限拒绝、未验证、部分完成和待用户事项”时发现真实缺口——紧凑模式此前把已完成轮次的**整段 transcript 行与 `ActiveActivityStatus` 一起折叠**，只剩一行固定的“已思考 · N 次工具调用 · N 条消息”，因此工具失败与权限拒绝（Runtime 以 `ok === false` 加原因返回）、失败或中止的准备行、失败的思考行、未通过的验证和失败步骤在紧凑模式下都会消失。现已修复：`chat/activity-visibility.ts` 新增 `transcriptEntryNeedsAttention` / `compactTranscriptEntries`（紧凑模式只折叠无需关注的行）与 `activityAttentionLine`（把未完成、已停止、等待用户、已暂停、失败步骤数、未通过的验证结论合成一行 `role="status"` 提示），`assistant-turn.tsx` 在紧凑模式下渲染这两者，样式使用 UX-14 的 `--feedback-danger-text` 角色。普通模式行为未改动。
- 验证方式：`chat/activity-visibility.test.ts` 4 个用例（未成功的工具行保留、失败/中止的准备与思考行保留、活动级未完成/停止/等待/暂停各自成句、未验证与失败步骤进入提示而通过的验证不算关注项）；`pnpm exec vitest run packages/app/src/renderer` 105 个文件 / 557 个用例全部通过；`tsc -b` 通过。
- 待执行脚本（其余三项与验收，需要真实窗口与真实会话）：
  1. 流式长回答：向上滚动阅读 → 确认阅读位置不被流式内容抢回；回到最底部；添加多附件；展开长工具结果；输入多行草稿；双栏拖动 / 折叠 / 全屏及返回。
  2. 两个对话各打开文件标签、留下未保存草稿、各自访问浏览器与目录 → 来回切换确认现场不串会话 → 重启应用确认恢复。
  3. 紧凑模式下分别构造一次失败、一次权限拒绝、一次未验证、一次部分完成与一次等待用户，确认五类状态都仍可读；切回普通模式重复确认。
  4. 每个真实失败附复现步骤、截图与修复记录；正常场景只记“通过”，不新增“重设计”任务。

### UX-17｜大仓库文件树虚拟化（先建基准，再选实现）

**问题**：文件树展开后**递归挂载全部行**（`workspace-tree-rows.tsx` 是递归实现，仓库内没有任何 virtualizer 引用，也没有 `overscan`/`useVirtualizer` 之类代码）。大目录下的滚动、筛选与切换成本随行数线性增长。OpenCode 的做法是目录按需 list + TanStack virtual 只挂可视行（稳定 28px 行高、overscan 10），这是它在大仓库上最重要的结构性优势。

**定位**：[workspace-tree-rows.tsx](../../packages/app/src/renderer/workspace/workspace-tree-rows.tsx)、[file-navigator.tsx](../../packages/app/src/renderer/workspace/file-navigator.tsx)、`workspace/directory-cache.ts`（现有 128 条 / 5 秒 stale-while-revalidate 缓存）。对标依据与上游 commit 见本文第 7 节。

- [ ] 先建立展开基准：1,000 行与 10,000 行目录下的首帧、滚动流畅度、展开/折叠与筛选耗时，作为改动前证据（没有基准不改实现）。
- [ ] 再选实现：自实现固定行高虚拟化，或在体积与许可证可接受时引入轻量库；**不得**为一个列表引入完整 Solid 运行时、第二套目录扫描或新的活动页。
- [ ] 保持键盘导航、展开状态、筛选时保留目录祖先、可访问性与现有持久化语义不变。
- [ ] 验收：改前/改后成对基准对比；大目录滚动不丢帧、不跳动；键盘与筛选行为逐项不变；小目录不因虚拟化变慢。

**实施记录（2026-09-24 21:52:00）｜状态：未开始（2026-09-24 从对标记录折入）**

- 折入来源：2026-08-13 的 OpenCode 对标记录把"大规模文件树虚拟化"列为待办，但当时既未进任务书也未排期；按用户 2026-09-24 的要求折入本任务书，成为可独立排期的 UX 项。
- 与冷启动专项的边界：[桌面冷启动基线](../reference/cold-start-baseline/README.md) 的 CS-08 证明的是"右侧进入即可预览/操作"（目录行与预览可见时间），**不是**大目录下的行级渲染成本；两者不互相替代，也不重复排期。

**实施记录（2026-09-25 02:20:00）｜状态：1,000/10,000 行基准已完成，并据数据判定"现在不做虚拟化"；把瓶颈改判为 320 条上限的"可达性"**

- 新增真实窗口基准 `pnpm run verify:workspace-large-directory`（`scripts/verify-workspace-large-directory.mjs`，`--rows=1000,10000`，1280×760，隔离数据根；每个目录造 N 个文件 + 一个排最前的 `aaa-first.txt` 与一个排最后的 `zzz-beyond-cap.txt`）。
- **先说清产品当前的行为**（它不是假设，而是这次基准测出来的前提）：Main 的 `listWorkspaceDirectory` 读整个目录、排序后只保留 `MAX_WORKSPACE_DIR_ENTRIES = 320` 条再返回（`truncated: true`，界面显示"列表已截断"）。因此"10,000 行目录的渲染成本"在当前架构里被上限封顶。
- 实测数字：

| 项 | 1,000 个条目 | 10,000 个条目 |
| --- | ---: | ---: |
| Main 列表往返（3 次） | 24 / 48 / 37 ms | 65 / 75 / 78 ms |
| 返回给 Renderer 的条目 | 320（truncated） | 320（truncated） |
| 首个目录行 | 48 ms | 88 ms |
| 行渲染稳定 | 76 ms（+320 行） | 115 ms（+320 行） |
| 文档 DOM 节点数 | 2,761 | 5,002（两个大目录同时展开） |
| 滚动帧间隔（`.workspace-tree`，30 帧） | 平均 5.80 ms，p95 6.2，最差 6.3，**0 个长帧** | 平均 5.71 ms，p95 6.1，最差 6.2，**0 个长帧** |
| 筛选"排最前的名字" | 命中，34 ms | 命中，32 ms |
| 筛选"被上限挡掉的名字" | **未命中**（33 ms） | **未命中**（33 ms） |

- 另做了一次**合成**测量（明确标注为探测器、不是产品路径）：把真实行节点克隆进同 class 的离屏容器并强制布局，得到"若取消上限"的 DOM/布局下界——320 行 2 ms 创建 + 7 ms 布局；2,000 行 12 + 37.1 ms；10,000 行 70 + 209.7 ms（不含 React 自身工作量）。
- **决策（本项要求"先出基准、再决定自实现或引库"）**：**现在不做虚拟化，也不引库**。理由是产品已经用 320 条上限把渲染成本封顶：首行 ≤ 96 ms、稳定 ≤ 131 ms、滚动零长帧，而合成下界显示即使取消上限、10,000 行的纯布局也只有约 280 ms——为当前不存在的路径引入依赖或自实现窗口化，成本高于收益。
- **瓶颈重判与后续选项（记录，不在本轮实施）**：真正暴露的问题是 **320 条上限的可达性**，不是绘制成本——排在前 320 之外的条目既不出现在树里，**也无法被筛选找到**（实测 `zzz-beyond-cap.txt` 在两个目录里都搜不到，因为筛选是在已被 Main 截断的列表上做的）。可选后续：(a) 让筛选成为服务端查询（把过滤条件下推到 Main、再切片），保住上限；(b) 提高上限并同时引入窗口化——合成数据显示阈值大约在 2,000 行（纯布局 49 ms），超过它才值得为窗口化付出复杂度。两者都属产品取舍，需另行评审。
- 仍未覆盖：真实用户规模下的**筛选逐键延迟**（本项只测了单次输入后的稳定时间）、键盘导航在 320 行上的走查、以及上限被调整后的回归；这些随 (a)/(b) 的取舍一起排期。

### UX-18｜审阅侧栏独立宽度

**问题**：审阅导航已接入工作区导航的共享折叠状态，Diff 标题行提供单列/双列切换（`WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY`，默认双列），但**审阅侧栏宽度仍沿用工作区导航状态**：用户无法为大 Diff 单独加宽审阅面板，加宽审阅必然同时改掉文件导航宽度。

**定位**：[review.tsx](../../packages/app/src/renderer/workspace/review.tsx)、[app-shell/preferences.ts](../../packages/app/src/renderer/app-shell/preferences.ts) 的 `WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY`、[workspace/README.md](../../packages/app/src/renderer/workspace/README.md)、[ui-interaction-guidelines.md](../principles/ui-interaction-guidelines.md)（窗口级偏好与对话级现场的边界）。

- [x] 为审阅侧栏增加独立宽度偏好：持久化、有上下限、与文件导航宽度互不覆盖。
- [x] 保持单列/双列持久化与共享折叠状态不变；不重新引入第二套目录扫描或活动页面。
- [x] 验收：拖宽审阅侧栏后文件导航宽度不变；重开应用后宽度恢复；窄窗口下不出现横向滚动或不可达按钮；`WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY` 行为不变。

**实施记录（2026-09-24 21:52:00）｜状态：未开始（2026-09-24 从对标记录折入）**

- 折入来源：同 UX-17；对标记录原写"仍可后续补审阅侧栏独立宽度"。
- 现状锚点：`WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY` 存在于 `app-shell/preferences.ts`，`review.tsx` 默认双列（`true`）。

**实施记录（2026-09-24 22:52:40）｜状态：实现完成，持久化与接线有回归；真实窗口验收未做，保持未勾选**

- 实现范围：会话现场新增 `reviewNavigatorWidth`，与 `fileNavigatorWidth` **共用同一组上下限**（`WORKSPACE_FILE_NAVIGATOR_WIDTH_MIN/MAX` = 160/520，默认都是 214）但**不共用取值**。`workspace-persistence.ts` 负责 hydrate/serialize，旧快照缺该字段时回落到默认值而不是继承文件导航宽度；`use-workspace-session-layouts.ts` 暴露 `workspaceReviewNavigatorWidth` 与 setter；`panel.tsx` 把审阅标签接到审阅宽度与审阅写回回调（`fileNavigatorWidth={reviewNavigatorWidth}` / `onFileNavigatorWidthChange={onReviewNavigatorWidthChange}`），侧边共享的文件导航继续用 `fileNavigatorWidth`；Main 侧 `workspace-layout-index.ts` 在恢复镜像里同样 clamp 并接受该字段，旧镜像缺字段时回落默认值。审阅折叠状态按第 2 条要求继续与文件导航共用（本轮只分离宽度）。
- 验证方式：`workspace-persistence.test.ts` 新增"审阅列独立于文件导航"用例（旧快照给 214、`900→520`、`40→160`），并把双会话往返断言扩成两组宽度各自保留（`246/302`、`318/178`）；`workspace-layout-index.test.ts` 断言 `331.2 → 331` 且跨 `WorkspaceLayoutIndex` 重建后读回；`review-layout-unification.test.ts` 新增接线用例（审阅拿审阅宽度与审阅写回、共享导航仍用文件宽度、两处不交叉）。相关 4 个测试文件 35 例通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 退出 0。
- 未覆盖项：真实窗口里的拖拽手感、窄窗口下不出现横向滚动、`WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY` 行为不变，这三条仍需实机验收（第 3 条复选框保持未勾选）。

**实施记录（2026-09-25 05:36:40）｜状态：三条验收已在真实窗口跑通，并在过程中发现并修掉“审阅导航盖住 Diff 表面与其标题按钮”的真实布局缺陷；三项勾选**

- 新增真实窗口门 `pnpm run verify:review-navigator-width`（[verify-review-navigator-width.mjs](../../scripts/verify-review-navigator-width.mjs)）：真实 Git 工作区（1 个已改文件 + 1 个未跟踪文件）、真实指针拖动与键盘、真实重启（走应用自己的 quit 路径，避免 SIGKILL 丢掉未落盘的偏好）。
- 实测（1280×840 全屏面板、800×600 应用最小窗口）：
  - **宽度互不覆盖**：先在文件标签把文件导航拖到 250，再切到审阅把审阅导航拖宽 120（214 → 334）；切回文件标签，文件导航仍是 250（`aria-valuenow` 与渲染宽度都未变）；会话现场里 `fileNavigatorWidth: 250`、`reviewNavigatorWidth: 334` 各存各的。
  - **重启恢复**：退出应用重开后，审阅标签渲染 334、文件标签渲染 250，两者仍互不覆盖；`workspaceReviewSideBySide` 偏好也按设置值恢复。
  - **共享折叠不变**：在审阅折叠后切到文件标签，普通目录树同样是折叠态（同一状态）；重新展开后审阅导航回到 334、文件导航仍是 250（折叠与重开不改写宽度）。
  - **单列/双列偏好不变**：默认双列；切换后 `littlesheep.ui.workspaceReviewSideBySide` 立即写为 `false`，切回写回 `true`，两次切换都不动任何宽度。
  - **无第二套目录扫描**：审阅标签空闲 2.5 秒期间页面探针记录到 0 次 `/workspace/list`（只有 `/workspace/review` 读取），折叠/切换也没有触发目录扫描。
  - **窄窗口（800×600，面板 296）**：文档与面板的横向溢出都是 0；审阅导航由现场值 334 被夹到 183（`aria-valuemin/max` 同为 183 一侧），Diff 表面仍保留 ≥96px；审阅导航拖拽条、Diff 标题行的单列/双列按钮、刷新与筛选都在视口内且 `elementFromPoint` 命中自身（可达）；把窗口放大回 1280 并恢复全屏面板后，审阅导航重新渲染 334 —— 窄窗口的夹取没有写回偏好。
- **顺带修掉的真实缺陷（本门实机发现）**：审阅标签的导航此前是 `.workspace-review` 的直接子元素，而 `.workspace-files-navigator` 只有 `position: absolute`（这是给 `.workspace-shared-file-navigator` 这个 flex 占位项内部的普通目录导航准备的），于是它被画出 flex 行、盖在整个 Diff 表面上：实测 Diff 标题行的“切换为单列/双列差异”和“在文件工作台中打开”两个按钮，与审阅导航自己的“刷新 Git 更改”落在**同一个矩形**（1280 宽下面板 359 时同为 `x=1211,y=88,25×25`），指针点不到（只有键盘/程序化点击有效）；Diff 代码区右侧也被更改树压住。修法：`04-workspace.css` 让 `.workspace-files > .workspace-files-navigator` 回到行内（`position: relative` + `flex: 0 0 var(--workspace-files-navigator-width)`），Diff 表面因此按导航宽度让位；折叠时按共享外壳的既有规则收缩到折叠轨宽度（`flex-basis: var(--workspace-files-control-rail-width)` + 负 `margin-left`），复用 `.workspace-files:has(...)` 的既有 leading-row 预留规则。回归由本门的“Diff 表面在导航左侧结束”“Diff 标题按钮可达”两条断言守住（修前两条均为假）。
- 仍未覆盖：真实拖动只覆盖指针路径（键盘方向键/Home/End 已有单元覆盖，未在本门逐键走查）；窄窗口只测应用最小尺寸 800×600，125%/150%/200% 系统缩放属于 UX-15；本门不衡量 Diff 代码在窄窗口下的可读行宽（只保证 ≥96px 与不横向滚动），可读性属于 UX-22。

### UX-19｜对话区阅读位置和上下定位

**问题与边界**：用户反馈上下滚动定位不顺手。源码已有底部吸附阈值、历史加载后的高度修复和 ResizeObserver，不能描述为“没有滚动锚点”。但当前切换会话会直接跳到底部；视口高度变化时，`resolveChatResizeScrollTop` 即使阅读者已离开底部，仍按旧底部距离移动 `scrollTop`；也没有明确的“回到底部”控件。哪一种对应用户体验，需要实机定位。

**定位**：[chat-view.tsx](../../packages/app/src/renderer/app-shell/chat-view.tsx)、[chat-scroll-anchor.ts](../../packages/app/src/renderer/chat/chat-scroll-anchor.ts)、[05-chat-messages.css](../../packages/app/src/renderer/styles/05-chat-messages.css)、[composer-view.tsx](../../packages/app/src/renderer/app-shell/composer-view.tsx)。与 UX-16 共用长回答验收，不重复搭建滚动系统。

- [ ] 隔离数据根下录制：短/长会话从顶部、中部、底部开始，流式增量、加载更早消息、展开工具详情、输入框增高、导航栏拖动/折叠、窗口缩放、切换会话及返回；标记每次非用户触发的视口位移。
- [ ] 对已离开底部的阅读者采用可见消息锚点或等效稳定策略；仅在读者仍贴近底部时跟随新输出。会话返回位置符合会话现场预期，并提供可达的回到底部入口及新消息提示。
- [ ] 验收：上述场景中文字不跳离当前阅读段；历史插入、底部跟随与返回底部各自稳定；普通/紧凑模式、窄窗口与高 DPI 均可用。修复前后记录 `scrollTop`、可见消息键及截图/视频。

**状态**：未开始；源码可确认当前控制分支，实际误定位仍待 Electron 复现。

**实施记录（2026-09-25 00:26:40）｜状态：已离开底部的锚点策略与回到底部入口实现完成并有单元/接线证据；真实窗口位移测量未做，保持未勾选**

- 修掉的分支（本轮唯一改动的判定逻辑）：`resolveChatResizeScrollTop` 此前只要"宽度变了、或高度变了"就对**任何**读者调用 `resolveBottomAnchoredScrollTop`。对已离开底部的读者，那等于把 `scrollTop` 移动 `Δ(scrollHeight - clientHeight)`——视口每变多少像素，读者就被推走多少像素，正是"文字跳离当前阅读段"的算术来源（输入框增高、窗口缩放、分栏拖动都命中）。现在该函数**只回答贴底情形**（底边确实是它的锚点）；离开底部的修正改由消息锚点给出。
- 新增的锚点策略（第 2 条要求）：`chat-scroll-anchor.ts` 新增纯函数 `selectChatVisibleAnchor`（视口内第一条仍可见的 `data-message-key` 及其视口内位置）与 `resolveAnchoredScrollTop`（按该消息的新位置回推 `scrollTop`，锚点已不在时返回 `null` 表示"不猜、不改动"），DOM 读取隔离在 `readChatAnchorProbes`。`chat/use-chat-scroll-controller.ts` 在 resize burst 的第一个通知里同时记录几何与锚点：贴底按底边修复，否则把正在读的消息放回原处。
- 滚动状态下沉：滚动位置、底部吸附、锚点与提示状态从 `app-shell/chat-view.tsx` 移到 `chat/use-chat-scroll-controller.ts`——视图从 **299 行降到 112 行**，不再接近 300 行软上限；`chat-scroll-anchor.ts` 158 行、新 hook 312 行（已登记进模块拆分地图的软上限审查队列）。
- 回到底部入口与新消息提示（第 2 条后半）：`readingAway` 由实测位置得出（`onScroll` 与每次消息更新后重算），新输出到达而读者不在底部时只置 `hasNewContent` 并保持阅读位置不动；此时渲染 `.chat-jump-to-latest`（文案"回到最新"／"有新内容 · 回到最新"），点击后重新贴底并清空提示。按钮浮在**实测的** `--composer-overlay-height` 之上，不遮挡输入栏，也不占用消息流的高度。"有新内容"用**内容签名**（消息数 + 末条 id + 末条正文长度）判定而非消息条数：流式输出只增长当前回合而不新增消息，那种增长正是离开底部的读者需要知道的。
- 一处容易写错并已用测试钉住的接线：会话切换的 layout effect 只能依赖 `sessionKey`。把消息列表（或它的长度）加进依赖，会让**每一条新消息**都重新贴底并清空提示，锚点策略随即失效——`chat-scroll-controller-wiring.test.ts` 专门断言该依赖里没有 `messageCount`。
- 验证方式：`chat-scroll-anchor.test.ts` 扩到 14 例——离开底部时高度变化不再产生位移（原断言 460 改为 `null`，并把旧行为写成注释说明它为什么是缺陷）、贴底读者仍按底边修复、锚点选择/漂移修正/锚点消失拒绝猜测/不产生负偏移；新增 `chat-scroll-controller-wiring.test.ts` 5 例，从源码层固定"滚动所有权在 hook 而非视图""锚点分支与贴底分支并存""按钮只在 `readingAway` 时渲染且带新内容标记""只有读者自己的位置能清除两个提示标志""会话切换不因新消息重新贴底"，并断言 CSS 定位契约。`chat-layout-stability.test.ts` 的两条接线断言同步改指 hook（原意图不变）。`vitest run packages/app/src/renderer`：113 个文件 619 例通过；`tsc --noEmit -p packages/app/tsconfig.web.json` 退出 0。
- 未覆盖项：**第 1、3 条复选框保持未勾选**——真实窗口里的位移测量（短/长会话的顶部/中部/底部起点，流式增量、加载更早消息、展开工具详情、输入框增高、分栏拖动、窗口缩放、切换会话与返回）尚未录制，因此"修复前后 `scrollTop`、可见消息键与截图/视频"没有数据；切换会话仍直接跳到底部（会话现场是否应恢复上次阅读位置属产品判断，未在无实机证据时改动）；普通/紧凑模式、窄窗口与高 DPI 下的按钮可达性同样待实机确认。

**实施记录（2026-09-25 00:42:54）｜状态：真实 Electron 窗口已测到"修复后"的数字；修复前基线与其余场景仍未录制，保持未勾选**

- 真实窗口证据（`scripts/verify-electron-ui-state-continuity.mjs` 的 `verifyChatReadingPosition`，隔离数据根 + 确定性验收 Provider，窗口逻辑尺寸 1100×700）：在 `.messages-content` 注入一个 2400 px、带 `data-message-key` 的探针，把读者移到"视口顶部正好落在探针上 520.25 px 处"，然后分别改变视口高度与宽度。**测得的数字**：视口高度变化后锚点在屏幕上的位置 `-520.25 → -520.25`（位移 **0.00 px**）；宽度重排（对话区 620 px 固定宽）后 `-520.25 → -519.96`（位移 **0.29 px**）；同一过程中"离底部的距离"从 **1547.67 变成 1667.67（+120 = 视口收缩量）**——即旧实现用来"保持"的那个量确实变了，而读者真正在读的那条消息没有动。点按"回到最新"后 `gapAfterReturn = -0.33`（浮点残差）且按钮消失；同样的视口变化下，贴底读者的底边距离始终为 `-0.33`。修复前基线与对照见下一条记录。
- 这组数字修正了本项最初的分层结论：只看底边距离的旧验收脚本（原 `verifyChatBottomAnchor`，断言 `beforeGap ≈ afterGap`）**在修复后必然失败、在缺陷上必然通过**，已改为上述双读者契约（锚点位移 + 底边距离必须改变 + 返回底部 + 贴底保持），失败信息直接带出全部测量值。
- 实现上被真实窗口推翻过一次并已修正：宽度重排在 ResizeObserver 通知之后仍在继续（容器尺寸不再变化、内容高度还在变），只测一次的锚点修复会留下约 40 px 的尾部跳动（实测 `-479.96`）。改为复用既有的有界 display-settle 逐帧收敛后降到 0.29 px。另一处只有真机才暴露的缺陷：逐帧修复会在"回到最新"之后继续套用旧锚点，把读者拉回去（实测 `gapAfterReturn = 1667.67`、按钮不消失）；现在 hook 记住自己写过的 `scrollTop`，`onScroll` 一旦发现滚动不是自己写的就立刻取消修复帧，点按返回底部同样先取消。
- 顺带修掉的两个验收夹具缺陷（都不是产品行为，但会挡住这段验收）：`verifyLeanBoundedExecution` 复用了上一个夹具的会话，而验收 Provider 只有在转写里还没有工具结果时才会回工具调用，于是它什么工具活动都观察不到——现在先点"新对话"再发提示；文件导航宽度夹具不再假设被拖动的一定是文件导航宽度，而是记录拖动实际命中的那一侧（UX-18 之后审阅列有自己的持久化宽度，实测 `{width: 286, kind: 'review'}`），恢复断言读同一个字段。
- 仍未覆盖（第 1、3 条保持未勾选）：场景只覆盖了视口高度变化与宽度重排两种，短/长会话的顶部/中部/底部起点、流式增量、加载更早消息、展开工具详情、切换会话与返回、截图/视频仍未采集；普通/紧凑模式、窄窗口与高 DPI 下的按钮可达性未测。

**实施记录（2026-09-25 00:47:00）｜状态：修复前后对照已在同一夹具上录得；其余场景仍未录制，复选框保持未勾选**

- 修复前基线（把 `packages/app/src/renderer` 回到 `16aa098` 后用**同一**验收脚本与同一夹具重跑一次；脚本失败信息自带全部测量值）：视口高度变化后锚点位置 `-520.25 → -640.25`，位移 **-120.00 px**——正好等于视口收缩量，读者被推走的距离与视口变化量逐像素相等，这就是"文字跳离当前阅读段"的直接来源；同一过程中的底边距离 `1547.67 → 1547.67`（**被完整保持**，即旧实现优先保护的量）；宽度重排 `-520.25 → -599.96`（**-79.71 px**）。修复前的运行界面没有"回到最新"入口（`jumpButtonRendered: false`），贴底读者的底边距离为 `-0.33`。
- 修复后（`2afcd5e`，同一夹具）：视口高度变化 `-520.25 → -520.25`（**0.00 px**），宽度重排 `-519.96`（**0.29 px**），底边距离 `1547.67 → 1667.67`（+120，按要求改变），"回到最新"点按后 `gapAfterReturn = -0.33` 且按钮消失，贴底读者仍为 `-0.33`。
- 对照结论：本次改动交换的正是"保护哪个量"——旧实现保护离底部的距离（读者位移 = 视口变化量），新实现保护读者正在读的那条消息（位移 0.00–0.29 px）。两张数字都来自真实 Electron 窗口，可直接复核：`git checkout 16aa098 -- packages/app/src/renderer` 后运行 `pnpm run verify:electron-ui-state-continuity`，脚本会在失败信息里打印上表第一行。
- 仍未覆盖（第 1、3 条保持未勾选）：场景只覆盖了视口高度变化与宽度重排两种，短/长会话的顶部/中部/底部起点、流式增量、加载更早消息、展开工具详情、切换会话与返回、截图/视频仍未采集；普通/紧凑模式、窄窗口与高 DPI 下的按钮可达性未测。

**实施记录（2026-09-25 01:01:08）｜状态：流式场景与"新内容提示"已实机验收，并抓到一处真实缺陷；其余场景仍未录制，保持未勾选**

- 新增真实窗口夹具 `scripts/verify-chat-streaming-rendering.mjs`（`pnpm run verify:chat-streaming-rendering`，隔离数据根 + 确定性验收 Provider 按 24 字符 / 35 ms 分块流式输出一份固定 Markdown 文档，窗口 1024×620）：读者在**输出中途**向上滚动 420 px，然后在答案剩余部分到达期间连续采样。测得的数字：锚点位移 **0 px**（同一 `data-message-key` 全程在视口内同一位置）、离底部距离稳定在 420 px、`.chat-jump-to-latest` 出现且 `data-new-content="true"`（新内容提示在真实窗口里生效）、点按后底边距离回到 **1 px** 且按钮消失。截图落在 `%TEMP%\littlesheep-chat-rendering\screenshots\`（`streaming-code.png`、`settled.png`、`reading-away.png`）。
- **该夹具抓到一处此前未记录的缺陷并已修复**：新会话的第一次 run 里，草稿会话取得持久 id 时 `currentSession` 从空变成真实 id，滚动 hook 的"切换会话就贴底"逻辑因此误判为切换，把已经向上滚动的读者拽回底部（实测结算时 `scrollTop` 780、`gap` 1、提示消失）。现在只有"会话键变化且不是草稿转正"才重新贴底；加载更早消息虽然会改变首条消息 id，但会话未变，同样不再触发贴底。回归断言写在 `chat-scroll-controller-wiring.test.ts`。
- 仍未覆盖（第 1、3 条保持未勾选）：场景只覆盖了视口高度变化、宽度重排与"输出中途向上滚动"；短/长会话的顶部/中部/底部起点、加载更早消息、展开工具详情、切换会话与返回、录屏仍未采集；普通/紧凑模式、窄窗口与高 DPI 下的按钮可达性未测。

**实施记录（2026-09-25 01:55:00）｜状态：读者自己触发的三个场景（输入框增高、展开工具详情、切换会话返回）已实机测量；加载更早消息与录屏仍未做，保持未勾选**

- 新增真实窗口门 `pnpm run verify:chat-reading-scenarios`（`scripts/verify-chat-reading-scenarios.mjs`，窗口 1024×640，隔离数据根 + 确定性 Provider，会话里先跑出两段长回答与一次工具执行）。实测数字（"锚点"= 视口内第一条 `data-message-key` 的屏幕位置）：
  - **输入框增高**：把输入栏从 1 行写成 6 行后 `--composer-overlay-height` 从 **116 → 225 px**。`scrollTop` 保持 1919.33、锚点 key 不变、锚点位移 **0.00 px**（-258.86 → -258.86），离底距离 399.67 → 508.67（正好等于视口被压缩的量）——即读者没有被拉下去，被压缩的只是可视区。
  - **展开工具详情**：把一条可见的工具行（实测 `aria-label="搜索，**/*"`，`aria-expanded` 由 false 变 true）在阅读位置展开后，`scrollTop` 保持 1196.67、锚点 key 不变、锚点位移 **0.00 px**（-1094.87 → -1094.87），离底距离 1122.33 → 1287.33（新增高度全部在读者下方）。
  - **切换会话与返回（记录，不作断言）**：在长会话里停在离底 400 px 处 → 切到另一会话：`scrollTop 14 / gap 0`（进入即最新消息）→ 切回原会话：`scrollTop 2418 / gap 0`，即**返回会话落在最新消息而不是上次阅读位置**。这是当前的产品行为，与"会话返回位置符合会话现场预期"一致（预期=最新）；是否改为恢复上次位置属产品判断，本轮不改。
- 仍未覆盖（第 1、3 条保持未勾选）：**加载更早消息**仍未实测——会话历史页大小是 120 条，要出现"加载更早内容"需要先造出超过一页的会话（本轮的夹具只造了 6 条），因此没有数据；顶部/中部/底部三种起始位置的系统走查、录屏与普通/紧凑模式、窄窗口、高 DPI 仍未做。

**实施记录（2026-09-25 02:35:00）｜状态：加载更早消息已实机测量，读者所读的那条消息在整页前插后仍在原位；顶部/中部/底部系统走查与录屏仍未做，保持未勾选**

- 新增真实窗口门 `pnpm run verify:chat-history-paging`（`scripts/verify-chat-history-paging.mjs`）。历史页大小是 120 条，所以夹具把 150 条消息**直接种进会话存储**（`<data-root>/sessions/<id>.jsonl` 的 metadata 头 + 每行一条消息，与应用自身追加的格式相同）并写好 `sessions.json`，而不是驱动 61 轮真实 run 去凑页数。另一个必须注意的点：应用启动时要解析 model ref，`providers: []` 会让 readiness 变成 `failed`，而历史加载会等执行就绪——所以夹具仍配一个（不会用到的）验收 Provider。
- 实测（1024×640，150 条种子消息）：首屏只加载**一页 120 条**，`GET /sessions/…/messages?limit=120` 用时 **6 ms**，出现"加载更早内容"；把读者移到最顶部（`scrollTop 0`、离底 9876 px），此时视口内第一条是 `history-message-0030`、位于视口顶下 **68.00 px**。
- 点按"加载更早内容"：请求带上游标 `?limit=120&before=history-message-0030`（**3 ms**），渲染消息数 120 → **150**，按钮消失，`scrollTop` 0 → 2526（= 前插的高度），离底距离 **9876 → 9876（分毫未变）**；而**读者所读的那条 `history-message-0030` 仍在 68.63 px（位移 0.63 px）**，横向溢出为 0。
- 一处测量方法的更正（写进夹具注释）：最初用"视口内第一条可见消息的 key"做锚点，前插后它从 `0030` 变成 `0029`（新页末尾那条在该位置刚好露出一部分），于是报出 69 px 的"位移"——读者实际什么都没感觉到。改为**按 key 跟踪同一条消息的位置**后为 0.63 px。这条也说明：验收锚点必须按身份追踪，不能用"当前第一条可见"这种会随内容插入而合法变化的量。
- 仍未覆盖（第 1、3 条保持未勾选）：顶部/中部/底部三种起始位置的**系统**走查（本项只测了顶部的强场景）、录屏、普通/紧凑模式、窄窗口与高 DPI 下的分页表现未做。

### UX-20｜流式文字外观变化与内容缺失

**问题与边界**：用户报告部分字色突然变化、部分文字像被吞掉。`Markdown.tsx` 对正在输出的尾部反复解析，完成后切换成整篇渲染；CSS 对标题、链接、引用、行内代码设有不同颜色，代码块还会从纯文本 fallback 切到按需加载的高亮组件。这些能解释潜在的视觉变化，**尚未证明就是用户看到的那一处**。另一个已确认的状态分支是 `run-result-reducer.ts` 在 `status !== 'ok'` 时清空流式回答预览；底层 SSE 解析对无效 JSON 数据行直接跳过，且 `parseStream` 目前以流结束作为完成条件，需核对异常截断是否被识别。不得把未校验的预览直接当作 Agent 最终回复保留下来。

**定位**：[Markdown.tsx](../../packages/app/src/renderer/Markdown.tsx)、[streaming-markdown.ts](../../packages/app/src/renderer/streaming-markdown.ts)、[05-chat-messages.css](../../packages/app/src/renderer/styles/05-chat-messages.css)、[assistant-delta-buffer.ts](../../packages/app/src/renderer/chat/assistant-delta-buffer.ts)、[run-result-reducer.ts](../../packages/app/src/renderer/chat/run-result-reducer.ts)、[client.ts](../../packages/llm/src/client.ts)、[api/run.ts](../../packages/app/src/renderer/api/run.ts)。

- [ ] 用含标题、列表、链接、引用、代码围栏、中文标点与长段落的确定性分块输入，逐步比对 Provider 接收文本、SSE delta/reset/replace、前端缓冲、最终 settlement 与 DOM `textContent`；覆盖断流、畸形帧、无最终结果和非成功 run，先确定文字在哪一层消失。
- [ ] 修复实际丢失层；在流式与完成态之间保持文字完整及语义样式稳定。必要的链接/代码差异应有一致的视觉规范，避免仅因组件切换闪烁。未授权工具标记、无效模型回复和未结算文案继续按 Runtime 规则撤回，以明确状态说明原因。
- [ ] 验收：成功 run 的最终 DOM/复制文本与持久化 settlement 一致；瞬时断线恢复无重复或缺字；失败 run 不伪装成成功回答，且已完成步骤、失败原因、是否可重试清楚可见；普通/紧凑模式及重开会话一致。真实窗口录屏确认变色场景，自动测试覆盖定位到的具体丢字边界。

**状态**：未开始；上述实现分支是源码事实，用户观察到的具体根因待复现。

**实施记录（2026-09-24 23:13:05）｜状态：分层定位完成并修掉一条已确认的整段丢失路径；DOM 取证与真实窗口录屏未做，保持未勾选**

- 逐层结论（同一份确定性样本，含标题、列表、链接、引用、代码围栏、中文标点与长段落）：
  - **SSE 解析层（`renderer/api/common.ts` 的 `parseSseFrame`）是本次唯一确认的"整段丢失"路径**。该函数此前对 `data:` 行直接 `JSON.parse`，解析失败会抛出并中断整条流的读取——一个畸形帧不只丢自己，还会带走它之后的全部 delta **和 `result` 帧**，于是"文字被吞掉"与"run 没有结算"同时出现。现已改为返回 `null` 跳过该帧（与 Provider 侧解析同构），失败关闭的责任仍留在 `consumeRunStream`：整条流始终没有可解析的 `result` 时照旧拒绝。**注意**：这条只解释了"只要有坏帧，损失被放大到整条流"，不等于已复现用户看到的那一次，触发帧的来源仍需真实窗口取证。
  - 缓冲层（`assistant-delta-buffer.ts`）按显示帧合并增量，`clear()` 只丢弃**尚未提交显示**的尾部；已显示的正文不会因合并被回车覆盖。
  - 结算层（`run-result-reducer.ts`）在 `status !== 'ok'` 时把该回合正文置空——撤回未验证预览是既有的 Runtime 规则，不是丢字；成功 run 用 settlement 文案覆盖预览（见 `run-result-reducer.ts` 第 57 行的 `text: result.status === 'ok' ? settledReply : ''`）。
  - **外观层（变色）仍未取证**：`Markdown.tsx` 对正在输出的尾部反复解析、完成后切整篇渲染，代码块从纯文本 fallback 切到按需加载的高亮组件；这三处都能产生视觉变化，但必须用真实窗口录屏确认是哪一处，本轮不做样式改动。
- 验证方式：新增 [stream-text-integrity.test.ts](../../packages/app/src/renderer/chat/stream-text-integrity.test.ts) 9 例，驱动**真实**的 `consumeRunStream` + `createAssistantDeltaBuffer` + `reduceCompletedRunMessages`，覆盖：正常流逐字节一致（delta 拼接 = 显示文本 = settlement）；帧被切成三次读取仍能重组；畸形帧被跳过后邻居正文与结算完好；**"结果帧本身解析不了"时仍然 fail closed**（拒绝并以 `ended without result` 结束，不把坏帧当成静默成功）；传输重试的 `replace ''` 语义（不重复，但读者会看到已显示文字先消失再重来）；无 result 的断流同样拒绝；`aborted`/`failed` 撤回预览；settlement 覆盖预览；buffer 只在 replace 时丢弃待显示尾部。`vitest run` 相关 3 个文件 20 例通过。
- 未覆盖项：DOM `textContent` 比对、复制文本一致性与变色场景录屏都需要真实 Electron 窗口；`parseStream` 仍以"流结束"作为完成条件，**异常截断本身不被识别**（目前只能通过"没有 result"间接发现）；传输重试清空可见回答时仍未说明原因，应与 UX-21 的"第 n 次重试 / 最多 5 次"进度一起呈现。第 1~3 条复选框因此保持未勾选。

**实施记录（2026-09-25 01:01:08）｜状态：真实窗口的 DOM 与结算一致、取色两次采样稳定；变色仍未被复现，保持未勾选**

- 真实窗口夹具（`scripts/verify-chat-streaming-rendering.mjs`）：验收 Provider 按 24 字符 / 35 ms 分块输出一份固定 Markdown（标题、列表、链接、引用、行内代码、`ts` 代码围栏、中文标点与长段落，含 `FIXTURE-START-4c1d` / `FIXTURE-END-7f3a` 两个哨兵），窗口 1024×620。测得：**18 次采样、0 次文字回退**（阈值 16 字符，用于容忍 `` `x` `` → `x` 这类语法收敛）；结算后 DOM 文本 1014 字符，与夹具的纯文本投影（1145 字符 Markdown → 投影 1004 字符）在空白归一后**完全相等**，与持久化结算文本的投影同样完全相等；两个哨兵在 DOM 与持久化文本中都在；持久化文本与夹具**逐字节相同**。这回答了第 1 条要的"最终 DOM/复制文本与持久化 settlement 一致"。
- **变色取证（第 2 条的"组件切换闪烁"）**：在代码围栏刚出现时（流式开始 2323 ms）与结算后各取一次计算样式，标题/链接/行内代码/引用/代码块/代码 token 六项**全部 stable**：标题 `rgb(255,255,255)`/700、链接 `rgb(93,161,247)`、行内代码 `rgb(238,242,247)` 底 `rgb(42,42,42)`、引用 `rgb(160,160,160)`、代码块与 token 都是 `rgb(232,232,232)`。代码块的 class 两次都是 `code-block-source`、子元素数都是 1——与 `Markdown.tsx` 的既有设计一致（高亮 chunk 到达前的纯文本回退**复用同一 class 与内联样式**，正是为了不产生视觉跳变）。因此本次固定样本**没有复现**用户报告的变色；仍未被排除的候选是流式尾部反复重解析造成的瞬时样式变化，需要录屏或更细的采样才能定位，本轮不据此改样式。截图：`%TEMP%\littlesheep-chat-rendering\screenshots\`（`streaming-code.png`、`settled.png`）。
- 顺带修掉的两处夹具缺陷（不是产品行为，但会伪装成通过）：提交提示早于 Runtime 就绪时，回答会流式输出"Runtime 仍在启动"的拒绝文案并且**不产生任何 Provider 请求**，看起来与正常流式一模一样——现在先等 `/runtime/readiness` 为 `ready`；比较 DOM 与 Markdown 源码前先做纯文本投影（`projectMarkdownToText`，与夹具同处一个模块，避免两处漂移），否则差值是标题、列表、引用、反引号等语法字符。
- 未覆盖项：**变色场景仍未被复现或录屏**（见上），所以第 2 条保持未勾选；复制文本（剪贴板）与普通/紧凑模式、重开会话的一致性未测。

**实施记录（2026-09-25 02:00:00）｜状态：把"变色"追到显示帧分辨率仍未复现；第 2 条继续保持未勾选（缺的是能复现的场景，不是采样密度）**

- 在同一夹具里加了一个**逐帧样式记录器**：流式期间在每一个 `requestAnimationFrame` 上读标题、段落、链接、行内代码、代码块的计算样式（`color|fontSize|fontWeight|backgroundColor`），只保留"签名变化"的时间点与当时的正文字符数。这比之前的两次采样密了两个数量级（60 fps × 全程约 4 s），因此"变化发生在两帧之间"这类解释被排除。
- 实测：**每一类块在整个流式过程中只有一个样式签名**（heading/paragraph/link/inlineCode/codeBlock 各 1 条），首次出现的时间与当时的字符数如下——也就是这些元素从出现在 DOM 里到结算，颜色、字号、字重、底色一次都没变：

| 块 | 首次出现 | 当时字符数 | 签名（色 / 字号 / 字重 / 底色） |
| --- | ---: | ---: | --- |
| 标题 | 1436 ms | 21 | `rgb(255,255,255)` / 18px / 700 / 透明 |
| 段落 | 1445 ms | 66 | `rgb(232,232,232)` / 14px / 400 / 透明 |
| 链接 | 1446 ms | 66 | `rgb(93,161,247)` / 14px / 400 / 透明 |
| 行内代码 | 1446 ms | 66 | `rgb(238,242,247)` / 12.88px / 400 / `rgb(42,42,42)` |
| 代码块 | 3121 ms | 827 | `rgb(232,232,232)` / 14px / 400 / 透明 |

- 结论与边界：本夹具能证明的是"**这套固定输入下，流式期间的样式是稳定的**"，因此用户报告的变色**不是**由这段 Markdown 的流式渲染路径造成的；它仍未复现，剩下的可能场景是——真实 Provider 的推理/工具混合输出（`reasoning_delta`、`tool_call_delta`、DSML 撤回路径）、代码高亮 chunk 在**更长**代码块上的到达时机、以及主题/缩放切换瞬间。要继续追需要这些场景的输入，而不是更密的采样。第 2 条复选框因此保持未勾选，本轮也不据猜测改样式。

**实施记录（2026-09-25 01:18:46）｜状态：断流截断的盲区已修（改由 UX-21 的错误注入发现）；变色仍未复现，保持未勾选**

- 本项此前记录的未覆盖项之一——"`parseStream` 以流结束为完成条件，异常截断本身不被识别"——已由 `pnpm run verify:retry-feedback` 的断流注入证实并修复：Provider 在答案中途断开时，客户端此前把截断文本当作完整结算发布（实测那次运行没有重试、答案缺尾），现在缺少完成信号即抛可重放的 `LlmError(502)`，重试后交付完整答案且只出现一次。契约与回归写进 `packages/llm/README.md` 与 `packages/llm/src/client.test.ts`，真实验收写在本任务书 UX-21 的实施记录里。
- 仍未覆盖：**变色场景仍未复现或录屏**（第 2 条保持未勾选）；复制文本（剪贴板）、普通/紧凑模式与重开会话下的一致性未测。

### UX-21｜模型瞬时故障分级重试与失败反馈

**问题与边界**：用户期望模型连接失败后自动恢复，连续失败五次才停止。当前 `packages/llm/src/retry.ts` 默认 `maxAttempts: 3`，仅 `retryable` 错误及 `TypeError` 重试，429/500/502/503/504 被标为可重试；`AbortError` 等未被认作可重试，最终失败会沿 run 状态进入恢复/失败呈现。`maxAttempts` 是**总请求次数**，用户说的“重连 5 次”应明确为首次请求后最多 **5 次重试**，而不是总共 5 次。底层已具备指数退避，不能描述为完全没有重试。

**定位**：[retry.ts](../../packages/llm/src/retry.ts)、[client.ts](../../packages/llm/src/client.ts)、[stages/_shared.ts](../../packages/harness/src/stages/_shared.ts)、[run-actions.ts](../../packages/app/src/renderer/chat/run-actions.ts)、[run-result-reducer.ts](../../packages/app/src/renderer/chat/run-result-reducer.ts)。区分 HTTP 超时、用户取消、认证失败、额度/速率限制、参数错误、网络中断、流开始前/后的断开以及结果已被持久化但 UI 连接断开。

- [ ] 先用错误注入表核对每类失败的实际分类、当前尝试数和 run 结局；保留请求、失败、重试次数及耗时的真实用量账本，不把重试隐藏在“单次调用”统计里。
- [ ] 对可安全重放的瞬时连接/服务故障，采用首次请求后最多 5 次有界重试，指数退避与抖动，尊重取消、超时和 Provider 的限流提示；进度明确显示“第 n 次重试 / 最多 5 次”。认证、配置、参数、权限、用户取消及已经产生不确定副作用的调用不盲重试。流中断前后的重发要以请求/片段身份去重，并在结果不明时走恢复，不重复执行已完成工具。
- [ ] 验收：前 1~5 次可重试故障后恢复则继续当前 run；第 5 次重试仍失败才给出可理解的失败状态和用户可操作的续接方式；不可重试故障立即明确失败；取消后不再等待或重试；重连不重复文本、工具副作用和最终回复。测试至少含 429、503、超时、断流、401/400、用户取消与本地 SSE 断线。

**状态**：未开始；重试次数和类别为源码确认，用户遇到的具体错误尚需日志/错误注入定位。

**实施记录（2026-09-24 22:32:00）｜状态：策略层实现完成且有单元证据；进度显示与真实窗口验收未做，保持未勾选**

- 实现范围（`packages/llm`）：`retry.ts` 改为分级重试——`maxAttempts` 是**总请求数**，默认 `DEFAULT_MAX_RETRIES + 1` = **首次请求 + 最多 5 次重试**（`maxRetries` 是等价写法，只在未传 `maxAttempts` 时生效）；`classifyFailure` 把失败分为 `transient`（网络失败、5xx、408、空 choices）、`rate_limited`（429）、`auth`（401/403）、`request`（其余 4xx）、`cancelled` 与 `unknown`，**只有前两类会被重放**，其余第一次就抛给上层。等待为指数退避 + 抖动；`Retry-After`（秒数或 HTTP 日期，来自 429/503）作为**下限**抬高本次等待，单次等待受 `maxDelayMs`（默认 30 s）封顶；退避期间监听 `AbortSignal`，取消后立即抛 `AbortError` 而不再等待或发起下一次请求。每次重试前调用 `onRetry({ retry, maxRetries, delayMs, failureClass, status })`；`LlmError` 新增 `retryAfterMs`，`ChatRequest.onTransportRetry` 让调用方拿到**本次请求**的重试进度。（本条"问题与边界"里"默认 `maxAttempts: 3`、用户说的重连 5 次应明确为 5 次重试"是改动前的事实，现已按后者实现。）
- 验证方式：新增 `packages/llm/src/retry.test.ts` 10 例——默认首次 + 5 次重试（6 次总尝试、`retry` 依次为 1..5）、 `maxRetries` 写法、六类失败的分类与"不可重放者只调用一次"、`Retry-After` 下限与 `maxDelayMs` 封顶、已取消的 signal 不发起请求、退避期间取消在 20 ms 内返回（计划等待 5 s）；`client.test.ts` 新增 2 例——重试进度透传到请求级观察者、`retry-after: 2` 被解析为 2000 ms 且实际等待被上限压到 5 ms。`pnpm exec vitest run packages/llm/src`：4 个文件 58 例通过。
- 顺带修掉的测试漂移：`client.test.ts` 的固定装置此前不声明重试参数，失败路径会睡满生产退避（默认 3 次尝试时整文件 106.5 s）；现在固定装置显式传 `retry: { maxAttempts: 3, baseDelayMs: 1, jitter: false }`，同一文件降到 0.21 s。回归上限不依赖生产默认值的这一条应继续保持。
- 未覆盖项：**运行界面尚未显示"第 n 次重试 / 最多 5 次"**（hook、`retryAfterMs` 与 usage 账本已就绪，消费端未接）；流中断前后的重发去重目前只有客户端的 `reset` 语义，未针对真实断流取证；本地 SSE 断线、真实 Provider 的前 1~5 次恢复与最终失败文案仍需错误注入与真实窗口验收。第 1、3 条复选框因此保持未勾选。

**实施记录（2026-09-25 00:16:31）｜状态：重试进度已接进运行界面数据流并有单元证据；真实 Provider 注入与窗口录屏未做，保持未勾选**

- 实现范围（`packages/harness`）：`model-activity.ts` 新增 `emitModelRequestRetryActivity`，`callModelChat` / `callModelChatStream` 把 `onTransportRetry` 观察者挂到请求的**副本**上——调用方自带的回调被链式保留，原请求对象不被写入（它同时被持久快照引用，不该承载 per-run 观察者状态）。进度写进**这次逻辑请求自己的活动行**（`phaseId = model-request:<id>`、`model_activity` + `running`），文案为"第 n 次重试 / 最多 m 次：<原因>（HTTP …），x 秒后重发"（限流与瞬时两类可重放原因，中文与英文入站各一套）；正常结算的已完成/失败摘要随后就地替换回来，所以一行仍只对应一次逻辑请求，不会留下永久 running 的行。
- 这条同时回答了 UX-20 里"重试清空可见回答却没有说明"的那一项：客户端流式重试会发 `{ type: 'reset' }`（`packages/llm/src/client.ts` 的 `retryRound > 1` 分支），Harness 把它变成 `replace ''`，此前读者只看到文字消失又重来；现在同一活动行会先说明正在第 n 次重试及原因。**Renderer 未新增代码**：`chat/run-event-handlers.ts` 既有的 `model_activity` 渲染路径直接消费该摘要。
- 验证方式：`packages/harness/src/model-observability.test.ts` 新增 2 例——中文入站时三条摘要依次为"模型正在生成回复 → 第 2 次重试 / 最多 5 次：Provider 限流（HTTP 429），2.0 秒后重发 → 模型已完成：生成回复"，三条共用同一 `phaseId`，且调用方自带的观察者仍被调用、原请求对象未被改写；流式路径断言重试活动在 `reset` **之前**发出、chunk 序列为 `['reset', 'delta']` 且请求副本不修改原对象。`pnpm exec vitest run packages/harness`：80 个文件 686 例通过。
- 用量账本：重试次数经响应的 `transportAttempt` / `observedAttemptCount` 进入会话账本（`packages/harness/src/usage-state.ts` 及其测试已断言），不隐藏在"单次调用"统计里；本轮未改动该层。
- 未覆盖项：错误注入表所需的真实 Provider 故障（429/503/超时/断流/401/400/取消/本地 SSE 断线各一次）与运行界面录屏仍未做；摘要文字在普通/紧凑模式活动行里的实际可见性（长文案截断、刷新后是否保留）需要实机确认。第 1、3 条复选框保持未勾选。

**实施记录（2026-09-25 01:18:46）｜状态：错误注入表已在真实窗口跑通（503/429/401/预算耗尽/流中断），并修掉一处真实的截断隐患；取消、超时与本地 SSE 断线仍未注入，保持未勾选**

- 新增真实窗口门 `pnpm run verify:retry-feedback`（`scripts/verify-transport-retry-feedback.mjs`）：验收 Provider 支持按请求注入故障（`{kind:'status',status,times,retryAfterSeconds}`、`{kind:'stream_break',afterChunks}`、`{kind:'hang',ms}`，每次消费都记在请求上），验收构建里由 `LITTLESHEEP_ACCEPTANCE_RETRY_BASE_DELAY_MS` 只缩短退避等待（预算与状态码策略仍是生产默认，回归在 `packages/runner/src/infra-acceptance-retry.test.ts`）。重试文案写在这条请求自己的活动行上、结算时会被就地替换，所以夹具在故障窗口内每 30 ms 采样一次 DOM。
- 五个用例的实测结果（窗口 1024×640，隔离数据根）：
  - **503×2 后成功**：首个逻辑请求 3 次尝试（1 次请求 + 2 次重试），文案依次出现"第 1 次重试 / 最多 5 次：Provider 暂时不可用（HTTP 503），60 毫秒后重发"与"第 2 次重试…120 毫秒后重发"，run 继续并给出回答。
  - **429 + `Retry-After: 1`**：重试 1 次，文案点名 `HTTP 429` 与 1.0 秒等待（Provider 提示被尊重为下限），run 继续。
  - **401**：**没有任何重试文案**，run 以可见的 Runtime 错误行结束（"user-facing clarification generation failed: acceptance fault: injected HTTP 401"），没有伪造回答。
  - **预算耗尽（503 连续）**：18 次尝试 = 3 个逻辑请求 ×（1 次请求 + 5 次重试），文案序列每次都是 1→5 且**从未出现"第 6 次重试"**，run 以可见失败结束。
  - **答案中途断流**：Provider 写 5 个分片后直接断开连接，客户端重试 1 次，最终答案两个哨兵都在且只出现一次（无重复文本）。
- **本次注入抓到的真实缺陷（已修）**：`parseStream` 原先只以"读取器结束"判定流完成，因此**传输在答案中途断开会被当成正常结束**，截断的答案直接成为已结算回复（注入一次即可复现：没有重试、答案缺尾）。现在只有 `[DONE]` 或带 `finish_reason` 的分片才算完成信号；已收到内容却从未收到信号时抛 `LlmError(502, …, true)`，落回可重放的传输类由有界重试重发，重放时 `chatStream` 先发 `reset` 分片，上层清空已显示预览，因此重连既不重复文本也不丢字。单元回归在 `packages/llm/src/client.test.ts`（三条：有内容无信号 → 重试后成功且带 `reset`；`[DONE]` 或 `finish_reason` 任一存在即接受；空流不改行为）。
- 未覆盖项：**超时（`hang`）与用户取消**未注入（取消需要在窗口里点停止按钮并断言不再等待/不再重试），**本地 SSE 断线**（Renderer 与 Local App API 之间）也未注入；400/参数错误类只由单元测试覆盖；运行界面录屏、普通/紧凑模式下的活动行可见性仍未做。第 1、3 条复选框保持未勾选。

**实施记录（2026-09-25 01:28:40）｜状态：错误注入表补齐到八类（新增超时、400、用户取消），并修掉"自家超时被当成用户取消"；仅剩本地 SSE 断线未注入**

- 继续扩展 `pnpm run verify:retry-feedback`，新增三个用例后共八类，实测结果（窗口 1024×640）：
  - **Provider 超时**（`hang` 8 s、客户端 deadline 5 s）：第 1 次尝试挂起 → 重放 1 次成功，文案为"第 1 次重试 / 最多 5 次：Provider 暂时不可用，60 毫秒后重发"（**不谎报 HTTP 状态**），run 继续并给出回答。
  - **400**：没有任何重试文案，run 以可见错误结束且没有伪造回答。（该用例的尝试次数不是判据：流式路径对 400/422 有一次**有意的兼容回退**——去掉 `stream_options` 重发一次，这是另一套机制。）
  - **用户取消**（Provider 一直不响应，700 ms 时点停止）：只发出 **1 次**请求、**没有任何重试文案**、没有产出回答，确认取消不会等完重试预算。
- **本轮的第二个真实缺陷（已修）**：`callApi` / `embed` 的自家 deadline 与调用方取消都表现为同一个 `AbortError`，于是"Provider 挂起超过超时"被归为 `cancelled` 而**永不重试**——与"重试传输故障、尊重取消"正好相反，超时在界面上只会得到一次失败。现在只有自家 deadline 触发且调用方未取消时才翻译成可重放的 `LlmError(408, 'Request timed out after <ms>ms', true)`；调用方的 `AbortSignal` 中止仍是 `AbortError`。契约写进 `packages/llm/README.md`，单元回归两条（挂起→重放成功；取消→只发一次请求）。
- 仍未覆盖：**本地 SSE 断线**（Renderer 与 Local App API 之间的观察流断开，需要在窗口里断开本地连接并断言不重复文本、工具副作用不重放）；运行界面录屏与普通/紧凑模式下的活动行可见性。第 1、3 条复选框保持未勾选。

**实施记录（2026-09-25 02:55:00）｜状态：错误注入表最后一类（本地 SSE 断线）已实机跑通，八类加这一类共九类齐了；仅剩录屏与紧凑模式可见性，保持未勾选**

- 新增真实窗口门 `pnpm run verify:local-stream-disconnect`（`scripts/verify-local-stream-disconnect.mjs`）：在页面里包一层 `fetch`，让 `/run/stream` 的响应体在 1.2 s 后**报错**（这正是 `consumeRunStream` 眼里"本地连接断了"的样子），其余请求原样透传，并记录注入时刻以便证明它确实触发过。
- 实测（1024×640，长 Markdown 夹具，Provider 分块 24 字符 / 60 ms）：
  - **界面**：断线后该回合以 `failed` 结束，错误行原文就是注入的失败原因（"local app API stream disconnected (acceptance fixture)"），停止入口消失（`stopping: false`，输入栏回到空闲），**用户输入被还回输入栏**（草稿恢复为原提示）。
  - **Main 继续跑**：断线后 **2.29 s** 会话里出现了完整结算（1145 字符，与夹具逐字节相同，两个哨兵各一次），而 Provider **总共只收到 1 次请求**——断线既没有取消 Main 的任务，也没有触发重跑。
  - **重连不重复**：重载渲染器后从侧边栏打开这段被中断的会话，答案**只出现一次**（哨兵各一次），DOM 文本与夹具的纯文本投影完全一致（1014 字符）。
- 顺带记录一处观察（**未断言、未修改**）：被本地断线打断的 run 不会写下 `localStorage['littlesheep.ui.activeSession']`，因此重载后应用停在草稿视图（两处读到的值都是 `null`），被中断的会话在侧边栏里、一次点击可达。是否应改为自动回到被中断的会话属产品判断，本轮不改；夹具因此按用户的做法从侧边栏打开它。
- 至此 UX-21 的错误注入表覆盖：503、429（含 `Retry-After`）、401、400、预算耗尽、Provider 挂起超时、用户取消、答案中途断流、本地 SSE 断线，共九类。仍未覆盖：运行界面录屏、普通/紧凑模式下的重试文案可见性（长文案截断、刷新后是否保留）。第 1、3 条复选框保持未勾选。

### UX-22｜对话输出层级与可读性

**问题与边界**：在 UX-19~UX-21 的正确性问题定位后，再实机审查活动行、模型正文、失败提示、来源、工具结果及消息操作。现有普通/紧凑模式与 UX-16 的失败可见性修复是基础，不新增一套输出信息架构。

**定位**：[assistant-turn.tsx](../../packages/app/src/renderer/chat/assistant-turn.tsx)、[agent-tool-row.tsx](../../packages/app/src/renderer/chat/agent-tool-row.tsx)、[message-meta.tsx](../../packages/app/src/renderer/chat/message-meta.tsx)、[05-chat-messages.css](../../packages/app/src/renderer/styles/05-chat-messages.css)。

- [ ] 在真实窗口检查长正文与工具输出的层级、默认展开量、行宽、段落间距、可复制性、键盘焦点、状态对比度及窄窗口换行；按“读完结果、找到失败、继续任务”三个操作记录卡点。
- [ ] 仅对有证据的卡点做局部调整：最终结果优先可读，过程可按需展开，失败/权限/未验证保持显眼；沿用主题 token、现有 Markdown 与普通/紧凑模式，不用 opacity 隐去有用文字。
- [ ] 验收：长回答首屏能辨认当前结论与状态，代码/链接/来源可读可复制，失败与下一步可找到；键盘、125%/150%/200% 缩放和两种显示模式通过录屏/截图复核。

**状态**：未开始；属于体验建议，不能在实机走查前声称具体对比度或层级不合格。

**实施记录（2026-09-25 01:45:00）｜状态：长正文 / 工具输出 / 失败三种状态的实机测量完成，未发现低于 AA 的层级或对比度，因此本轮不改样式；紧凑模式、缩放与三操作走查仍未做，保持未勾选**

- 新增真实窗口门 `pnpm run verify:chat-readability`（`scripts/verify-chat-output-readability.mjs`）：一次启动跑三种状态——（A）确定性长 Markdown 回答，（B）常规有界执行（含工具活动行与折叠），（C）注入 401 的失败状态；随后把 C 在**窗口最小宽度 800×660** 上重测。取色按"元素计算色 + 第一个不透明祖先背景"计算 WCAG 2.1 相对亮度对比度，正文/状态行按 AA 4.5，大字号（≥24px，或 ≥18.66px 且 ≥700）按 3.0。
- 实测（1280×720，内容宽 740 px，纵向与横向溢出均为 0，长回答可选中 1011 字符，行高比 1.7，段间距 10 px）：

| 元素 | 对比度 | 字号/字重 |
| --- | ---: | --- |
| 正文段落 | 15.53 | 14 px / 400 |
| 章节标题 | 19.03 | 18 px / 700 |
| 链接 | 7.16 | 14 px / 400 |
| 引用（弱化文字） | 7.28 | 14 px / 400 |
| 行内代码 | 12.77 | 12.88 px / 400 |
| 代码块 | 13.30 | 14 px / 400 |
| 工具活动行 | 7.28 | 13 px / 400 |
| 失败提示（Runtime 错误行） | 15.53 | 14 px / 400 |

- 结论与**未做的改动**：上述状态里没有任何一项低于 AA，也没有横向裁切、不可选中或不可聚焦的控件；工具活动行本身就是带 `aria-label` 的可聚焦 `BUTTON`（实测标签"搜索，**/*"）。按本任务书"仅对有证据的卡点做局部调整、不能在实机走查前声称层级或对比度不合格"的要求，本轮**不改样式**，把这张表作为基线与回归门槛：以后任何改动让上表任一项跌破阈值，门会失败。
- 仍未覆盖（第 1~3 条复选框保持未勾选）：**紧凑显示模式**、**125%/150%/200% 系统缩放**与键盘全流程走查（Tab 顺序、Escape、焦点返回）未测；"读完结果、找到失败、继续任务"三段式操作记录与录屏尚未采集；工具输出的长文本折叠默认展开量、来源与引用的可读性也未单独测量。截图落在 `%TEMP%\littlesheep-chat-readability\screenshots\`（`long-answer.png`、`tool-run.png`、`failure.png`、`failure-narrow.png`）。

**实施记录（2026-09-25 03:10:00）｜状态：紧凑模式与高 DPI 已并入同一门并全部通过；键盘全流程与录屏仍未做，保持未勾选**

- 把两个阶段并入 `pnpm run verify:chat-readability`（同一次启动，六个夹具）：**紧凑显示**（运行中切换 `littlesheep.ui.conversationDisplayMode`，长回答保持在同一段转写上重测）与**高设备像素比**（`Emulation.setDeviceMetricsOverride` 设 `deviceScaleFactor: 2`，在失败状态上重测）。
- 紧凑模式实测：正文 `14px/400`、对比度 **15.53**（与普通模式逐项相同：标题 19.03、链接 7.16、引用 7.28、行内代码 12.77、代码块 13.30、列表项 15.53），内容宽 740、横向溢出 0、可选中 1011 字符——即折叠只改变密度（已完成活动收成需关注的行），没有改变正文可读性与可复制性。
- 高 DPI 实测（DPR 2，与 800px 最小窗口阶段区分开）：文档与转写横向溢出均为 0，失败提示仍是 `14px`、对比度 15.53，与 DPR 1 逐项一致——CSS 布局契约不随缩放变化。说明：这一项模拟的是**光栅化**那一半（DPR）；会缩小 CSS 视口的那一半由 800px 最小窗口阶段覆盖，因为窗口管理器不会把窗口压到比 `MINIMUM_WINDOW` 更窄。
- 仍未覆盖（第 1~3 条复选框保持未勾选）：**键盘全流程**（Tab 顺序、Escape 分层收起、焦点返回）与"读完结果、找到失败、继续任务"三段式操作记录、录屏未做；工具输出长文本的默认折叠量与来源/引用可读性未单独测量。截图新增 `long-answer-compact.png`、`failure-high-dpi.png`。

## 4. 实施顺序与依赖

1. **第一批：可靠性**。UX-01、UX-02、UX-03、UX-04、UX-05；UX-02 需要的最小确认层可与 UX-07 共用，不等整套 UI 抽象完成再修复。
2. **第二批：一致性**。UX-06、UX-07、UX-08、UX-09、UX-10、UX-11。草稿离开、模态焦点和异步反馈应共同验收；无模型引导依赖草稿保留和错误表达。
3. **第三批：收口**。UX-12、UX-13、UX-14；UX-15/16 从第一批就开始记录基线，最终跨批回归。视觉修改必须以真实窗口证据收尾。
4. **按需排期（2026-09-24 折入）**。UX-17 必须先出 1,000/10,000 行基准、再决定自实现或引库，不与本轮收口绑定；UX-18 很小，可与 UX-07 的导航/模态冻结一起做，避免两次改同一片布局状态。
5. **对话区专项**。先并行记录 UX-19/UX-20 的真实窗口与分层证据，以及 UX-21 的错误注入表；先修真正的丢字/错误分类与安全重试，再处理滚动定位，最后以 UX-22 收口视觉层级。与 UX-16 共用长回答和失败验收记录。

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
| 1 | UX-01 | 本任务实施记录 + `pnpm run verify:composer-ime-submit` | 微软拼音组词确认候选 → 下一次普通 Enter 只发一次；Shift+Enter、粘贴、附件仍有效 | |
| 2 | UX-02 | 本任务实施记录 + `pnpm run verify:deletion-confirmation` | 取消 / Escape / 请求失败 / 连点各一次；确认前不发生删除、失败留在确认层 | |
| 3 | UX-03 | 本任务实施记录 + `pnpm run verify:composer-stop-append` | 带草稿与附件时直接停止且草稿不丢；补充发送只提交一次；“正在停止”持续到 run 结束 | |
| 4 | UX-04 | 本任务实施记录 + `pnpm run verify:skills-catalog-states` | 慢请求、空响应、列表失败、详情失败、快速切换各一次 | |
| 5 | UX-05 | 本任务实施记录 + `pnpm run verify:recovery-states` | 发现失败、仅损坏记录、需要输入、自动续跑失败、正常自动续跑五类 | |
| 6 | UX-06 | 本任务实施记录 + `pnpm run verify:provider-editor-draft` | 编辑后切页返回、取消、保存失败注入、保存中关闭 | |
| 7 | UX-07 | 本任务实施记录 + `pnpm run verify:keyboard-modal-focus` | 仅键盘打开/循环 Tab/取消/返回原位；两层 UI 一次 Escape 只收一层 | |
| 8 | UX-08 / UX-10 | 本任务实施记录 + `pnpm run verify:channel-entry-states` | 三个入口状态一致；“每个可点击控件有可见结果”；空配置/全部停止/部分运行且部分失败/全部运行四种渠道 fixture 的标签、数量与颜色 | |
| 9 | UX-09 | 本任务实施记录 + `pnpm run verify:async-feedback` | 供应商保存、阈值保存、渠道重载、插件启停、文件保存各注入一次失败 | |
| 10 | UX-11 | 本任务实施记录 + `pnpm run verify:no-model-config-loop` | 新数据根从空状态配置完成并回到原草稿；加载失败重试；保存后选择器从 Runtime 刷新 | |
| 11 | UX-12 / UX-13 | 本任务实施记录 + `pnpm run verify:settings-navigation-terminology` | 从聊天、独立模块、设置总览进入同一功能名称与返回位置一致；逐页核对文案 | |
| 12 | UX-14 | 本任务实施记录 + `pnpm run verify:shared-ui-roles` | 确认两处取值变化（五处错误浅红统一、插件通知 7px9px→8px10px），并实测同类控件的高度/文字层级/聚焦/禁用/等待/危险一致与主题、紧凑布局、reduced-motion、圆角例外 | |
| 13 | UX-15 | 本任务实施记录 + `pnpm run verify:narrow-high-dpi-forms` | 最小窗口与常用窗口 + 125%/150%/200% 缩放下的模型表单、设置侧栏、审批长路径、运行时选择器 | |
| 14 | UX-16 | 本任务实施记录 + `pnpm run verify:conversation-workspace-scenarios` | 流式长回答阅读位置；双会话现场与重启恢复；紧凑模式五类状态 | |
| 15 | UX-18 | 本任务实施记录 + `pnpm run verify:review-navigator-width` | 拖宽审阅侧栏后文件导航宽度不变；重开应用恢复；窄窗口无横向滚动与不可达按钮 | |
| 16 | UX-17 | 本任务实施记录 + `pnpm run verify:workspace-large-directory` | 1,000 / 10,000 行目录的成对基准 + 滚动帧间隔与筛选可达性 | |
| 17 | UX-20 | 本任务实施记录 + `pnpm run verify:chat-streaming-rendering` | 分块流式文本逐层比对 + 断流/畸形帧/最终结算 + 真实窗口 DOM/结算比对与取色 | |
| 18 | UX-21 | 本任务实施记录 + `pnpm run verify:retry-feedback` / `verify:local-stream-disconnect` | 429/503/超时/断流/401/400/取消/本地 SSE 断线共九类，安全重试最多 5 次 | |
| 19 | UX-19 | 本任务实施记录 + `verify:electron-ui-state-continuity` / `verify:chat-streaming-rendering` / `verify:chat-reading-scenarios` / `verify:chat-history-paging` | 顶部/中部/底部阅读 + 流式增量 + 输入增高/展开工具详情/加载更早消息/切换会话返回定位 | |
| 20 | UX-22 | 本任务实施记录 + `pnpm run verify:chat-readability` | 长正文/工具输出/失败/来源的可读性、键盘与高 DPI 实机复核 | |

**自动门快照（记录于 2026-09-23 00:11，会随每次运行变化，不作为常驻结论）**：`check:repo` 当时 36/36 通过（2026-09-24 增补两条检查后为 38/38）；全量测试 **476 个文件 / 3358 通过、2 失败、1 跳过**，两个失败均不在本任务改动面内——`packages/runner/src/runner.test.ts` 的压缩范围断言与 `scripts/verify-web-live-llm-evidence.test.mjs` 解析被管道捕获的子进程 stdout（本沙箱不允许管道捕获，属环境边界）；全 workspace typecheck、App 构建与 `verify:app-recovery` 当时均通过。**测试数量与耗时以命令输出为准**，本任务书不复述为当前结果。

## 7. 对标折入项与上游证据

2026-08-13 的《OpenCode VS Code 对标记录》已于 2026-09-24 退役（原文可取回：`git log --follow -- docs/reference/opencode-vscode-comparison-2026-08-13.md`），其内容按性质分三处承接：**大仓库文件树虚拟化 → UX-17**、**审阅侧栏独立宽度 → UX-18**、**以下两项不排期**。上游证据留在本节，供将来重新核对时使用：

- 上游：`anomalyco/opencode`，对标 commit `cc4b45612974f735ddec46009ede07729511fba4`（MIT）；其 VS Code 扩展 `sst-dev.opencode-0.0.13` 约 10.8 KB，只做终端/HTTP 桥，没有 Webview、Monaco 或自己的文件树。关键源码：[sdks/vscode/src/extension.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/sdks/vscode/src/extension.ts)、[file-tree-v2-model.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/src/components/file-tree-v2-model.ts)。
- 当时**已直接吸收**的 5 项（文件预览 byte-LRU、Git Diff 字节预算、Monaco 模型缓存与面板切换稳定、审阅过滤与键盘导航、Main 审阅快照与 Diff 请求边界）实现细节在 `packages/app/src/renderer/workspace/README.md`、`renderer/README.md` 与 `ui/README.md`，本任务书不重复。
- **未排期两项**（产品面或数据模型决定，不是界面修正）：
  - **行级评论的持久性**：LS 已有行/范围手势、view zone 与附件式发布（`workspace/line-comments.tsx`、`review-line-comments.ts`、`line-comment-attachments.ts`），但**没有独立评论存储或 Runtime 评论合约**——评论只作为本轮附件进入对话；OpenCode 是持久评论模型。是否引入持久评论、以及它与会话/行范围的绑定协议，需单独立项并按 Runtime 合约评审。
  - **真正的 LS VS Code 扩展**：OpenCode 的扩展复用 VS Code 原生终端、文件树、编辑器，把当前文件/选区转成 `@relative/path#Lstart-end` 注入 TUI；LS 的"内置 VS Code 模块"其实是自有 Monaco 工作台，两者是两个产品面。若要做，应新建 VS Code SDK 项目并保持 MIT/自有许可边界清晰，不能通过嵌入 OpenCode Desktop 替代。当前为"记录在案、不排期"的待产品选择项。
