# 应用层 UI / UX 优化与统一任务书 2026-09-22

最后更新：2026-09-22 20:54:45

## 1. 范围与结论

本轮按用户要求审查应用层并形成待办，不实施产品代码修改。基线为工作树 `8060a16` 上的 Renderer 与相关 Local App API；已有的其他文档修改不属于本任务。

优先解决误发送、误删除、控制入口消失和失败不可见，再统一设置、弹窗、反馈及视觉表现。现有实现已有主题 token、FadePresence、渐进披露、文件草稿与会话现场恢复，不需要另建一套设计系统或任务引擎。

**证据边界**：这是源码与交互契约审查，未启动 Electron、未进行鼠标/键盘实机走查、未测量截图对比度。下文“源码确认”表示实现分支已核对，并不表示在真实窗口中已复现；“体验建议”需要验证收益；“待实机验证”不得登记为已复现缺陷。所有任务仍未完成。

约束沿用 [UI 交互规范](../principles/ui-interaction-guidelines.md) 和各领域 README：Agent 自然语言来自真实模型；按钮、状态和错误事实由 Runtime 提供；授权继续由 Main 决定；安全恢复保持安静，不重新引入启动强制弹窗。界面不得暗示显式记忆写入、定时执行等未接通能力已经可用。

## 2. 优先级与清单

- **P0**：可能造成误执行或不可逆数据损失，先处理。
- **P1**：高频操作受阻、状态失真、输入丢失或关键入口不清楚，随后处理。
- **P2**：信息架构、文案和视觉一致性，随对应领域改动收口。
- 规模为排期参考：S = 单一视图或状态分支；M = 跨组件交互；L = 跨领域验收。不是工期承诺。

| 完成 | ID | 优先级 | 任务 | 依据 | 规模 |
| --- | --- | --- | --- | --- | --- |
| [ ] | UX-01 | P0 | 防止输入法确认候选词时误发送 | 源码确认 | S |
| [ ] | UX-02 | 为永久删除建立明确确认与影响说明 | 源码确认 | M |
| [ ] | UX-03 | 运行中始终保留停止入口，区分补充发送 | 源码确认 | S |
| [ ] | UX-04 | 技能页区分加载、空数据与失败 | 源码确认 | S |
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

### UX-02｜永久删除和配置删除的风险语义

**问题**：归档页的永久删除按钮直接调用 API，供应商卡片删除也直接提交。归档项目的 Main DELETE 路径还会删除其归档关联会话，界面只靠图标标签不足以表达影响。

**定位**：[ArchiveManager.tsx](../../packages/app/src/renderer/ArchiveManager.tsx) 的删除回调；[sessions.ts](../../packages/app/src/renderer/api/sessions.ts)；[session-routes.ts](../../packages/app/src/main/local-app-api/session-routes.ts) 的归档 DELETE；[models.tsx](../../packages/app/src/renderer/settings/models.tsx) 的 `handleDelete`；[provider-routes.ts](../../packages/app/src/main/local-app-api/provider-routes.ts)。

- [ ] 永久删除前展示名称、对象类型、受影响会话数、不可恢复性；区分删除项目记录/会话与删除磁盘项目文件，严格以真实 API 行为说明。
- [ ] 删除供应商说明配置影响，识别当前使用的模型；不要未经核对声称密钥也被删除。
- [ ] 删除事务具有 pending 防重复与错误保留；取消不发 DELETE。可恢复的归档继续保持轻量，不一律追加确认。
- [ ] 验收：取消、Escape、请求失败、连点、包含多个会话的项目分别验证；确认前不发生删除，删除范围与文案一致，失败记录仍可定位。

### UX-03｜运行中同时支持停止与补充

**问题**：`showStop = loading && !input.trim()`。任务运行中只要输入草稿，原停止按钮就切为发送，用户需要清空草稿才能在该位置停止。

**定位**：[composer-view.tsx](../../packages/app/src/renderer/app-shell/composer-view.tsx) 的 `showStop` 与 `composer-run-actions`；[run-actions.ts](../../packages/app/src/renderer/chat/run-actions.ts) 的运行中发送分支。

- [ ] 运行中保留独立、稳定、可键盘访问的停止入口；有新输入时同时提供补充发送动作。
- [ ] 补充发送的标题/提示遵循 Runtime 实际的接收或续接语义，不把已接收显示为已执行；停止期间防止重复提交停止请求。
- [ ] 验收：带草稿/附件时可直接停止且草稿不丢；补充发送只提交一次；显示“正在停止”直到运行时确认，不能点击后立即伪装已停止。

### UX-04｜技能页的加载与错误状态

**问题**：`skills` 初始为空，加载前即满足“暂无技能”；`loadSkills()` catch 将列表清空；`openSkill()` 失败只清空选中项。加载中、真正为空、失败在用户看来容易成为同一种结果。

**定位**：[MemorySkills.tsx](../../packages/app/src/renderer/MemorySkills.tsx) 的 `loadSkills`、`openSkill` 与空态。

- [ ] 明确 loading / success-empty / success-data / error；读取详情失败保留列表和用户选择，并提供重试。
- [ ] 再次加载失败时保留已有列表，说明当前内容未刷新成功，不把旧数据误称为最新。
- [ ] 验收：慢请求、空响应、列表失败、详情失败、连续快速切换分别验证；只有成功空响应显示“暂无技能”，失败不静默消失。

### UX-05｜静默恢复不能吞掉恢复失败

**问题**：启动调用 `refreshCheckpoints(false)`；发现失败只写 hook 的 error。恢复入口仅在 `checkpoints.length > 0` 时显示，而错误与损坏记录提示在展开后的选中记录区域内。首次发现请求失败或只有无效记录且没有有效 checkpoint 时，没有可见入口呈现该问题。

**定位**：[use-checkpoint-recovery.ts](../../packages/app/src/renderer/runtime-recovery/use-checkpoint-recovery.ts) 的启动 effect、`refreshCheckpoints`；[checkpoint-recovery.tsx](../../packages/app/src/renderer/runtime-recovery/checkpoint-recovery.tsx) 的 trigger、error 和 diagnostics 条件。

- [ ] 将发现失败、有效待恢复、等待用户、损坏记录分开，提供安静的状态入口和受控重试；无有效 checkpoint 也能看到故障。
- [ ] 安全可续跑任务继续静默处理，结果归原会话；不要把本任务实现为启动自动打开恢复弹窗。
- [ ] 验收：发现接口失败、仅损坏记录、需要输入、自动续跑失败、正常自动续跑五类场景；失败默认可发现、聊天可用、重试不重复执行已结算操作。

### UX-06｜设置草稿和离开保护

**问题**：供应商 `draft` 只保存在页面局部 state；设置容器按 `page` 重新挂载，切换设置页会卸载编辑器。编辑器关闭/取消直接丢弃 draft，保存中关闭入口也未禁用。现有文件编辑器有专门草稿逻辑，设置表单的行为没有同样清楚。

**定位**：[models.tsx](../../packages/app/src/renderer/settings/models.tsx)、[model-provider-editor.tsx](../../packages/app/src/renderer/settings/model-provider-editor.tsx)、[workspace.tsx](../../packages/app/src/renderer/settings/workspace.tsx) 的 `key={page}`；参照 [file-close.ts](../../packages/app/src/renderer/workspace/file-close.ts) 的事务边界，勿照搬文件自动保存策略。

- [ ] 区分未改动、已修改、保存中、保存失败；在会话内保留普通表单草稿或仅在丢弃时提示，避免每次导航都打断。
- [ ] 密钥不写 localStorage、不输出日志；离开时如何处理密钥草稿必须明确，保存中离开不得造成结果归错页面。
- [ ] 验收：编辑后切页/返回、取消、保存失败、保存中关闭逐项验证；普通字段不无声丢失，取消不保存，错误时保留可修正内容。

### UX-07｜模态层与键盘行为统一

**问题**：审批声明 `aria-modal` 并自动聚焦“仅本次”，但没有聚焦约束/关闭后焦点恢复；恢复层有外部点击关闭却未处理 Escape。`FadePresence` 和 `useDismissOnOutside` 负责显示/收起，不提供完整模态管理。技能/渠道页面还在 embedded 模式注册全局 Escape 返回设置总览，存在层级处理不一致。

**定位**：[approval/prompt.tsx](../../packages/app/src/renderer/approval/prompt.tsx)、[checkpoint-recovery.tsx](../../packages/app/src/renderer/runtime-recovery/checkpoint-recovery.tsx)、[ui/presence.tsx](../../packages/app/src/renderer/ui/presence.tsx)、[MemorySkills.tsx](../../packages/app/src/renderer/MemorySkills.tsx)、[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx)。

- [ ] 为真正模态对话框统一进入焦点、Tab 范围、背景不可操作、关闭后返回触发点；将“平铺编辑页”与模态 dialog 分开定义。
- [ ] Escape 只交给最上层处理；审批中的 Escape 保持拒绝语义，恢复中的关闭保持稍后处理语义；单纯关闭不能意外批准或放弃任务。
- [ ] 评估审批初始焦点改为说明或非授权动作，避免打开时连续 Enter 意外授予权限；保留完全访问红色确认。
- [ ] 验收：只用键盘打开、阅读、循环 Tab、取消、返回原位置；两层 UI 时一次 Escape 只收起一层；退出动画期间不会重复触发操作。

### UX-08｜未接通功能不呈现虚假可操作性

**问题**：“已安排”页的“全部/提醒/自动任务”按钮没有状态或回调；页面同时以“暂无任务”表示空数据，又写“等计划任务接入后”，混淆未实现与已实现但没有数据。

**定位**：[scheduled.tsx](../../packages/app/src/renderer/settings/scheduled.tsx)、[navigation.ts](../../packages/app/src/renderer/settings/navigation.ts)、[direct-module.tsx](../../packages/app/src/renderer/settings/direct-module.tsx)。

- [ ] 当前基线移除无效筛选控件；选择隐藏入口或明确显示功能尚不可用，统一所有入口的状态。
- [ ] 不为填满页面而在本清单中新增调度后端；只有真实能力接通后才引入数据空态和筛选。
- [ ] 验收：每个可点击控件有可见结果；“尚不可用”与“暂无数据”不会互相替代。

### UX-09｜异步反馈与错误恢复统一

**问题**：技能吞错；渠道用 `reloadMsg.includes('失败')` 决定样式；模型、存储、插件、聊天分别使用不同提示结构和 ARIA 语义。设置阈值保存仅有 finally，其失败需继续沿运行时更新链核对，不应假定本页一定展示。

**定位**：[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx)、[models.tsx](../../packages/app/src/renderer/settings/models.tsx)、[storage.tsx](../../packages/app/src/renderer/settings/storage.tsx)、[plugins.tsx](../../packages/app/src/renderer/settings/plugins.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)、[runtime-actions.ts](../../packages/app/src/renderer/app-shell/runtime-actions.ts)。

- [ ] 建立小型反馈结构：状态、用户可读事实、可选重试/定位动作、可展开详情；tone 由结构字段决定，不解析文案。
- [ ] 保存中锁定同一事务；成功轻量提示；失败留在发起操作处并保留输入，长错误有界呈现；重新加载失败不能仍只显示旧成功提示。
- [ ] 验收：供应商保存、阈值保存、渠道重载、插件启停、文件保存各注入一次失败；用户在当前页面能看到失败及下一步，不必返回聊天区找错误。补充合适的 status/alert 语义。

### UX-10｜渠道状态汇总准确

**问题**：总体“外部渠道运行中”和列表标题“运行中的渠道”只取决于 `channels.length`，但同一列表中单项使用 `ch.running`。列表存在不等于至少一个渠道正在运行；失败列表还单独存在。

**定位**：[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx) 的 `channel-overall`、渠道列表、failures。

- [ ] 按真实运行项和失败项派生“运行中/部分异常/未运行/未配置”，保留“已配置”“已启用”“运行中”的区别。
- [ ] 总体状态与逐项状态对齐，不能把配置存在或数量大于零当成连接健康。
- [ ] 验收：空配置、全部停止、部分运行且部分失败、全部运行四种 fixture；标签、数量和颜色一致。若后端保证不会返回停止项，应先明确契约再简化 UI。

### UX-11｜无模型到可用模型的配置闭环

**问题**：模型选择器无供应商时显示“无可用模型”，引导依赖 title 中的设置路径；当前组件没有直接打开模型配置的动作。用户必须自己找到设置、添加配置，再返回原输入现场。

**定位**：[runtime-picker.tsx](../../packages/app/src/renderer/composer/runtime-picker.tsx) 的无模型状态与 trigger；[models.tsx](../../packages/app/src/renderer/settings/models.tsx)。

- [ ] 在无模型状态提供明确的“配置模型”动作，定位到供应商设置；返回后保留原会话、文字及附件。
- [ ] 区分未配置、配置加载失败、已保存但未验证可调用；不要用“已设置密钥”暗示连接成功。
- [ ] 验收：新数据根从空状态完成配置并回到原草稿；加载失败可重试；保存后选择器从 Runtime 刷新。若新增真实连接检查，单列网络调用成本和实现边界。

### UX-12｜设置与工作模块的信息架构

**现状与建议**：设置总览复制全部分组；记忆树、插件、已安排又可作为独立工作页打开；“Agent 行为”内同时放行为 profile、压缩阈值、对话显示。多个入口不是必然错误，但当前位置、返回目的地和设置归属需要一致。

**定位**：[navigation.ts](../../packages/app/src/renderer/settings/navigation.ts)、[home.tsx](../../packages/app/src/renderer/settings/home.tsx)、[direct-module.tsx](../../packages/app/src/renderer/settings/direct-module.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)。

- [ ] 先画出现有入口—页面—返回目标映射，确定每个模块唯一页面身份，保留有价值的快捷入口而不复制状态。
- [ ] 对话显示归入界面偏好；压缩阈值作为高级上下文配置按需展开；profile 与权限继续分离。
- [ ] 验收：从聊天、独立模块、设置总览进入同一功能时名称和状态一致；返回到来处；常见配置可按用户意图找到。先验证小幅重排，避免整套导航重建。

### UX-13｜术语和产品文案

**问题**：同一供应商功能混用“提供方/供应商”；中文设置页显示 Normal/Compact；总览和技能页描述“后续功能模块”“后续可继续接”；外部渠道无配置时直接要求编辑 `config.json` 的嵌套字段。

**定位**：[models.tsx](../../packages/app/src/renderer/settings/models.tsx)、[model-provider-editor.tsx](../../packages/app/src/renderer/settings/model-provider-editor.tsx)、[agent-profile.tsx](../../packages/app/src/renderer/settings/agent-profile.tsx)、[home.tsx](../../packages/app/src/renderer/settings/home.tsx)、[MemorySkills.tsx](../../packages/app/src/renderer/MemorySkills.tsx)、[ChannelConnections.tsx](../../packages/app/src/renderer/ChannelConnections.tsx)。

- [ ] 建立小型术语表：供应商、模型、对话、任务、项目、工作区、应用数据目录；Normal/Compact 使用一致的中文显示名。
- [ ] 功能说明只描述当前可用能力；高级配置字段放入可展开说明或帮助入口，未提供配置 UI 时如实说明限制。
- [ ] 验收：相同概念在标题、按钮、提示和空态一致；路径/状态事实不被文案重写；不增加模板化 Agent 回复。

### UX-14｜共享 UI 的增量收敛

**现状与建议**：颜色、圆角、动效已有 token；反馈和操作按钮仍有 `dialog-*`、`storage-settings-*`、`plugin-page-*`、`archive-*` 多套表面。类名不同本身不等于视觉缺陷，应先按截图与行为确认重复，再抽取。

**定位**：[ui/README.md](../../packages/app/src/renderer/ui/README.md)、[03-shell-sidebar.css](../../packages/app/src/renderer/styles/03-shell-sidebar.css)、[07-overlays-settings.css](../../packages/app/src/renderer/styles/07-overlays-settings.css)、[09-projects-archive.css](../../packages/app/src/renderer/styles/09-projects-archive.css)。

- [ ] 建立小范围状态样本：主/次/危险按钮、输入、空态、错误、pending、只读；复用现有 token，补必要的字号/间距角色。
- [ ] 优先随 UX-04/07/09 抽取 AsyncFeedback、Dialog 等确有复用收益的基元，不全仓机械替换样式。
- [ ] 验收：同类控件的高度、文字层级、聚焦、禁用、等待和危险样式一致；保留既有黑灰主题、紧凑布局、reduced-motion 与圆角例外。

### UX-15｜窄窗口与高 DPI 验证

**风险线索**：模型编辑器使用两列弹性字段加 `150px 150px 26px` 固定列；多个设置辅助标签为 10/11px。源码可确认尺寸，不能据此断言真实窗口已经裁切或对比度不合格。

**定位**：[07-overlays-settings.css](../../packages/app/src/renderer/styles/07-overlays-settings.css) 的 `provider-model-row`、`provider-model-columns` 与辅助文字；[model-provider-editor.tsx](../../packages/app/src/renderer/settings/model-provider-editor.tsx)。

- [ ] 在应用允许的最小窗口、常用窗口、125%/150%/200% 系统缩放下验证模型表单、设置侧栏、审批长路径、运行时选择器。
- [ ] 出现不足时按可用宽度切换模型字段为堆叠布局，确保字段仍有独立标签；只调整实测难读文字，测量前不宣称符合或违反对比度标准。
- [ ] 验收：关键按钮始终可达；字段不会压缩到无法输入；页面无非必要横向滚动；长路径可完整查看/复制；记录窗口逻辑尺寸、系统缩放和截图。

### UX-16｜对话与拓展工作区的完整场景验收

**现状与建议**：已有滚动锚点、上下文详情、Normal/Compact、会话工作区恢复及分栏测试，不应重复登记为缺失功能。本轮没有真实窗口证据，需验证组合场景后只修复实际失败项。

**定位**：[chat-view.tsx](../../packages/app/src/renderer/app-shell/chat-view.tsx)、[assistant-turn.tsx](../../packages/app/src/renderer/chat/assistant-turn.tsx)、[chat-scroll-anchor.ts](../../packages/app/src/renderer/chat/chat-scroll-anchor.ts)、[workspace/README.md](../../packages/app/src/renderer/workspace/README.md)、[workspace-persistence.ts](../../packages/app/src/renderer/workspace-persistence.ts)。

- [ ] 覆盖流式长回答时向上阅读、返回底部、添加多附件、展开长工具结果、输入多行草稿、双栏拖动/折叠/全屏及返回。
- [ ] 覆盖两个对话切换后的文件标签、未保存草稿、浏览器和目录现场，再覆盖重启恢复；沿用现有连续性专项的 Runtime 验收，不另建重复执行器。
- [ ] 核对普通/紧凑显示均保留失败、权限拒绝、未验证、部分完成和待用户事项；默认可找到最终成果，不为减少噪声隐藏重要状态。
- [ ] 验收：阅读位置不被流式内容抢回，输入与底部成果不被遮挡；现场不串会话；真实失败逐项附复现步骤、截图和修复记录，正常场景只记通过，不追加“重设计”任务。

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
