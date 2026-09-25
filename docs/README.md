# LittleSheep 文档决策入口

最后更新：2026-09-25 16:18:19

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：活动路由只产出两条路径——所有常规会话与任务回合都进入单一主循环 `execute`，只有能力/状态询问走最小 Runtime 事实契约的 `reply`；`respond` 在路由边界归一为 `execute`，`clarify` 不是可路由活动（缺少信息时由回复本身追问，或由主循环的 `request_user_input` 与恢复升级到达 `ASK_USER`）。DECIDE、VERIFY 模型调用、RECOVER 模型调用和 CAPTURE 已删除：已持久化的 TaskBook 只作为可读历史，步骤在主循环内串行推进；本回合无权使用的工具在执行时被拒绝，而广告给模型的工具目录在整个会话区间内保持固定；`memory_tree` 只读（`root_index` / `branch_index` / `expand` / `deep_search` / `release`），模型没有记忆写入工具，持久记忆的唯一写入方是会话压缩路径。

**推荐下一步**：执行[Runtime 状态一致性与必要记忆任务书](taskbooks/runtime-state-consistency-taskbook-2026-09-22.md)。Harness / Runner 冻结为 stable kernel，仅因真实 correctness bug、删除复杂度或已证明缺失的硬 invariant 做最小修改；Runtime 优先补齐 read observation → 写前 revision 校验 → checkpoint → mutate 及 exec 后失效。Memory 采用用户最新方向“明确要求或必要时写入”，与上下文压缩解耦；这仍是待实现方向，当前写入事实见上段。上一份缓存专项按用户确认已完成，其任务书已于 2026-09-24 退役，后续只保留[现行缓存验收约束](reference/cache-95-acceptance.md#真实长任务现行红线2026-09-22)，不重复安排原清单。[对话连续性 P0](taskbooks/conversation-task-continuity-taskbook-2026-08-13.md)与 UI 专项的未完成验收仍独立保留。

**此刻需要你决定或知晓的事项**：

- 权限模式固定为完全访问 / 研究 / 受限三档，只改变授权：产品语义上 LS 是 Agent 的容器，活动完整应用数据根（默认 `.littlesheep`）是容器边界，`workplace/` 是容器内的默认工作区；当前桌面实现是 Main 的逻辑边界，不是实际 Docker/OS 进程沙箱。切换到完全访问需先做一次红色危险确认，核心源码只读与危险命令硬拒绝不受模式影响。
- 暂不需要决定：更多插件类型、MCP 和发布打包。设置页后台任务控制已作为连续性能力收口接入，不是新产品范围。

当前实现事实与验证数字统一由[项目状态](decision/project-status.md)维护，本页不再复述。

## 需要确认依据时

只按下面顺序展开：

1. [项目状态](decision/project-status.md)：当前真正实现了什么、验证结果和仍未完成的边界。
2. [架构决策报告](decision/architecture-decision-report.md)：为什么推荐 Memory v3 → Provider 对话校准 → Tool Execution Service → Runtime 连续性 → Mode/MCP/插件。

当前事实与测试数字只以项目状态为准，演进顺序只以架构决策报告为准。

## 需要修改长期方向时

- [架构原则](principles/architecture-principles.md)：产品使命、LLM 与 Agent 分工、Context、Memory、Tools、Workflow、插件和数据边界。
- [核心 Agent 流程规范](principles/core-agent-flow-guidelines.md)：TaskBook、执行、验证、恢复、记忆介入和连续性约束。
- [UI 交互规范](principles/ui-interaction-guidelines.md)：渐进式披露、动画、层级、浮层、导航和交互一致性。

这些文档是稳定约束，不用于查看最新测试数字。

## 已决定方向后再看任务书

- [单层子 Agent 与执行效率任务书 2026-09-24](taskbooks/single-level-subagent-taskbook-2026-09-24.md)：SA-00～SA-09 规划主 Agent 工具调用、禁止递归委派、只读并行、共享权限/预算、停止恢复、结果证据及真实效率验收；对照 Gemini CLI、Claude Code、OpenCode 与 OpenAI 官方设计后补入任务角色、模型选型、上下文收益及小样本边界。SA-11 与 SA-10 分别在测量后评估异步和受控写入。当前为方案，尚未实现或证明提速。
- [应用层 UI / UX 优化与统一任务书 2026-09-22](taskbooks/application-ui-ux-taskbook-2026-09-22.md)：31 项应用层待办，覆盖输入、删除、停止、恢复、设置、键盘、异步反馈、工作区、对话滚动与阅读、重试、可读性及共享代码折行控制；新增 UX-24～UX-31 规划 HTML 小游戏隔离运行、静态资源兼容、Git 刷新与差异可靠性、PowerShell / Bash 选择、多终端会话和组合实机验收。新增项尚未实现；区分源码、自动化与真实窗口证据，保留未完成现场验收。

### 当前主线

- [Runtime 状态一致性与必要记忆任务书 2026-09-22](taskbooks/runtime-state-consistency-taskbook-2026-09-22.md)：合并原记忆写入专项；RS-00～08 覆盖内核冻结、文件观察与写前校验、exec 失效、压缩解绑、明确要求或必要时写入，以及真实流程/缓存回归。Memory 审查的相似合并、截断与来源绑定复现已并入 RS-05/06/07；新增 RS-06A 修复普通展开提前调用向量检索的边界。Memory 部分仍待实施与真实验收。
- [Harness 开源底座评估 2026-09-02](reference/harness-open-source-evaluation-2026-09-02.md)：固定 DeepSeek Harness、Pi 与 nanoDeepSeekHarness 版本、许可证、供应链证据和 LS adapter 边界；当前决定保留自有 kernel、只吸收 durable event/session/stream 设计。
- [对话任务连续性 P0 专项任务书 2026-08-13](taskbooks/conversation-task-continuity-taskbook-2026-08-13.md)：修复普通聊天未绑定 waiting-user Checkpoint、执行现场与附件/临时工具无法自然恢复、权限未按当前状态重验及最终回答断档。
- [缓存 95% 冻结负载验收规程](reference/cache-95-acceptance.md)：现行红线口径（会话累计、真实长任务节点、`pnpm run check:cache-acceptance`）、当前实测、冻结输入、测量规则、禁止做法、完成条件与仍未汇总项；仍然承重的历史结论集中在附录 A，逐轮测量日志已移出、只留在 git 历史。
- [缓存请求形状基线](reference/cache-baseline/README.md)：同一探针在改前 checkout 上跑冻结负载的逐请求字符数、共享前缀与工具目录摘要对比，并维护**长任务批次历史表**（每一批的唯一事实与机器可读账本链接；逐批叙述已于 2026-09-24 退役）；[最新一次运行](reference/cache-baseline/latest.md)由 harness 测试自动重写，[改前冻结副本](reference/cache-baseline/pre-fix-cd6cabc.md)保留为对比依据（不含提示词正文、会话内容或密钥）。
- [桌面冷启动基线 2026-09-23](reference/cold-start-baseline/README.md)：CS-01 的五时间点基线（进程启动、真实首帧、输入可用、当前会话可读、首次可执行）× 空/普通/大历史/待恢复四档隔离数据，含逐次原始机器可读账本、CS-04 执行准备预算拆解（Runner 构建 121 ms / RunRouter 50 ms / 插件宿主 2.8 ms）与两项已被实测证伪的"提速"改动记录；[原始账本](reference/cold-start-baseline/desktop-cold-start-baseline-2026-09-23.json)。
- [长区间任务 L1 基线 2026-09-22](reference/cache-baseline/long-interval-task-L1-2026-09-22.md)：28 回合长任务在"任务区间不可淘汰"修复后的**两次**实测——整会话 H_ui **99.13% / 99.21%**（179 / 222 请求，usage 均完整、0 失败尝试、0 provider 矛盾），两次的第 16/22/25/28 回合冻结节点分别为 97.00/98.30/98.81/98.94% 与 96.66/98.43/98.66/98.79%，产物验收均 6/6；早期节点仍低于 95%，是冷启动尚未摊薄所致，[机器可读账本](reference/cache-baseline/long-interval-task-L1-2026-09-22.json)同步提交。
- [冻结清单复跑（任务区间不可淘汰后）2026-09-22](reference/cache-baseline/real-long-task-baseline-pinned-interval-2026-09-22.md)：12 次运行全部 usage 完整、产物验收 12/12、0 provider 矛盾，平均 H_ui 87.07%（3 回合形状的冷启动上限），重建未缓存降至 0（仅 A2 两次与 B1#1 少量），[机器可读账本](reference/cache-baseline/real-long-task-baseline-pinned-interval-2026-09-22.json)同步提交。
- [长区间任务 L1 重启连续性 2026-09-22](reference/cache-baseline/long-interval-task-L1-restart-2026-09-22.md)：同一 28 回合任务在第 14 回合**重启应用进程**后继续——H_ui **98.99%**（169 请求、usage 完整、0 失败尝试），后段节点 96.81/97.67/98.19/98.42%，产物验收 6/6；重启本身不损失前缀（缓存属服务端），[机器可读账本](reference/cache-baseline/long-interval-task-L1-restart-2026-09-22.json)同步提交。
- [长区间任务 L1 空闲停顿连续性 2026-09-22](reference/cache-baseline/long-interval-task-L1-idle-pause-2026-09-22.md)：第 14 回合前**空闲 45 分钟**再继续——暂停后首个请求 `in=56,372 / cached=56,192`（99.7% 命中），整会话 H_ui **99.05%**，后段节点 97.34/97.91/98.44/98.80%，产物验收 6/6；结论为**有界**陈述（至少 45 分钟内缓存有效），[机器可读账本](reference/cache-baseline/long-interval-task-L1-idle-pause-2026-09-22.json)同步提交。
- [网络检索冻结契约与威胁模型](reference/web-retrieval-security-contract.md)：固定 safe read、网络配置、Tavily 首个 Provider、SSRF/DNS/注入/外发威胁、引用和日志语义；原实施任务书已于 2026-09-22 退役，实现状态与发布门改由验收报告维护。
- [网络检索安全合并验收 2026-08-29](reference/web-retrieval-security-acceptance-2026-08-29.md)：记录离线安全矩阵、迁移/回退、构建产物扫描、仍阻断 ready 的实际 Provider/正式渠道门，以及发布日复核清单、阻断条件、已知限制与供应链/许可证边界（后三块由同日退役的发布清单与供应链审查并入）。
- [生产依赖安全记录](reference/production-dependency-security.md)：记录临时间接依赖 override 的固定版本、来源、许可证、移除条件与复查日期，以及需要持续保留的组合/替代许可证清单，避免安全修复变成无所有者的永久配置。

### 任务书生命周期

任务书保存阶段设计和验收记录，不代表全局最新状态。不要通过比较任务书日期判断下一步。

**任务书完成后不再留在仓库里**：先把仍然成立的事实汇总到拥有它的常驻文档（项目状态、架构决策报告、架构原则、`reference/` 对应参考），再用 `git rm` 取消追踪并删除本节条目；原文保留在 git 历史中（`git log --follow -- <path>` 可取回）。仓库自检对 `docs/taskbooks/` 下的任务书数量设有预算，超预算时先退役已完成的任务书再新增。规则细节见[仓库指南](reference/repository-guide.md)。

2026-09-22 已按此规则退役第一批已完成/已失效文档（7 份任务书 + 1 份参考），其中事实已分别归入 `AGENTS.md`、项目状态与遗留参考；那一轮的逐条结论、逐份去向与证据更正记录在《文档退役审查记录 2026-09-22》里，该记录随后于 2026-09-24 退役（原文可取回：`git log --follow -- docs/reference/document-retirement-review-2026-09-22.md`）。**判定依据不足的文档不得由实现者直接删除**：对是否应退役有争议时，先在项目状态或本页记录待裁定项与理由，由用户裁定后再执行。

2026-09-24 按同一规则退役《对话执行可靠性修复任务清单 2026-09-23》（CE-01～CE-13）：65 条验收项全部完成，含真实模型 + 真实 Electron 窗口的交付门与 5 局人工试玩。仍然成立的事实已归入[项目状态](decision/project-status.md)（核心流程与状态边语义、尾部账本与运行时简报、工作区事实与配置保存事务、交付门与探针、未完成方向）、[核心 Agent 流程规范](principles/core-agent-flow-guidelines.md)（验证分界、不可重试的恢复、交付优先、越权调用与提问轮的边界）与 [Core Flow 状态契约](reference/core-flow-state-contract.md)（提问轮与升级后的终态），实现细节落在各 package/领域 README。仍未闭环的两条写在项目状态的"未完成方向"里：受限模式的批准对话框未在真实窗口走过；`verify:electron-deepseek-parallel-load` 在强杀重启后并发恢复检查点时报 `active resume lease`（属运行状态一致性方向）。

2026-09-24 同日退役《桌面冷启动体验与加载策略优化任务书 2026-09-23》（CS-01～CS-10，59 条验收项全部完成）。退役依据是自动化实机证据与用户人工验收都已齐备：真实窗口账本覆盖五时间点基线、三种窗口宽度的像素、未就绪期间的输入/切换/发送门禁、失败态与有界重试、恢复归属、右侧工作区的三指标与切换/竞争/窗口隐藏健壮性、CS-09 三档启动的摆放实拍，以及 CS-10 的大历史数据根（400/1200 分区下执行就绪 1191/1233 ms、缓存首次 1 次请求/重访 0 次/0 取消、打包版 1497 ms 同样 0 失败）；缩放与壁纸、交接瞬间、失焦与最小化、系统重启后冷启动、安装包实机、改选目录与真实续接由用户 2026-09-24 人工确认无问题。仍然成立的事实已归入[桌面冷启动基线](reference/cold-start-baseline/README.md)（全部指标、账本、边界与复现命令）、[项目状态](decision/project-status.md)（选中会话与全局工作区的分离、恢复期路由隔离）与各 package / 领域 README；未消失的边界（合成数据根只证明机制、缓存夹具无消息、DPR 代理不等于真实缩放、后台扫描无完成信号、安装包未签名）都写在基线的对应小节，原文保留在 git 历史（`git log --follow -- docs/taskbooks/desktop-cold-start-taskbook-2026-09-23.md`）。

2026-09-24 同日退役《Agent Runtime 连续性任务书 2026-07-14》。它的退役理由不是"阶段全部完成"，而是**机制已被后续架构取代**：DECIDE 与工具提议路径、TaskBook 步骤执行器与步骤级并行、逐请求时钟注入、记忆管理页都已删除或改义，旧阶段计划无法再执行，其阶段号也不再对应任何运行路径。退役前逐条复核了 2026-09-22 审查列为"保留"理由的五项未完成方向，全部由常驻文档承接：Pro/其它 Provider 模型专用校准、非字段事实普遍连续性、外部系统副作用与真实网络中断、长期真实用户负载见[项目状态](decision/project-status.md) 的"未完成方向"P0，数据根迁移真实场景见同文件"桌面应用与数据版本"，原先唯一没有所有者的**任务效率基线**新写入项目状态的"P1：效率基线"（四档任务集、十项指标、与裸模型及成熟 Agent 对比）。其余仍然成立的事实分别由[架构原则](principles/architecture-principles.md)、[核心 Agent 流程规范](principles/core-agent-flow-guidelines.md)、[UI 交互规范](principles/ui-interaction-guidelines.md)、[仓库指南](reference/repository-guide.md) 与各 package README 拥有，历史验收数字只保留在 git 历史（`git log --follow -- docs/taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md`）。同日从 `check:repo` 的 `required` 列表移除该文件，`required` 不再固定任何任务书。

2026-09-24 同日退役《真实长任务缓存红线任务书 2026-09-22》（LT-00～LT-08）。退役依据是交付物已达成且有机器可判定的入口：`pnpm run check:cache-acceptance` 当前结论 **met**（长任务 2/2、冻结清单 12 次运行通过回归口径），用户此前已确认该缓存专项完成。退役前把仍然成立的事实分别归入常驻文档：[缓存 95% 验收规程](reference/cache-95-acceptance.md)（指标定义、验收规程、实测边界，以及可核对费用与两类 usage 缺口的未汇总项）、[项目状态](decision/project-status.md)（使前缀可复用的架构事实、压缩不触发导致记忆不写入、休眠但未修复的前缀稳定性问题）与 harness README（`tool_choice` 必须保留目录与 `auto`）；逐次原始数字留在[缓存基线](reference/cache-baseline/README.md)，历史验收数字只保留在 git 历史（`git log --follow -- docs/taskbooks/real-long-task-cache-taskbook-2026-09-22.md`）。原任务书列为退役前置的两份文档（项目状态、缓存验收规程）已提交定稿，不再构成阻塞。

2026-09-24 同日退役两份网络检索参考文档：《网络检索发布清单 2026-08-29》与《网络检索供应链审查 2026-08-29》。两者是同一专项下与验收报告重叠的派生记录，且各自的头部结论已被后续事实推翻（漏洞读数已被 2026-09-22 修复取代、依赖数与 DNS 机制已变、发布门与验收报告重复）。退役前把仍然成立的独有事实并入[网络检索安全合并验收](reference/web-retrieval-security-acceptance-2026-08-29.md)（环境限制、发布当天复核清单、发布阻断条件、已知限制、Web 包依赖边界、许可证缺口、Tavily 公开条款快照、发布扫描规则）与[生产依赖安全记录](reference/production-dependency-security.md)（组合/替代许可证清单），实现状态与发布门仍由契约 + 验收报告维护；原文保留在 git 历史（`git log --follow -- docs/reference/web-retrieval-release-checklist-2026-08-29.md`、`git log --follow -- docs/reference/web-retrieval-supply-chain-review-2026-08-29.md`）。

2026-09-24 同日退役《OpenCode VS Code 对标记录 2026-08-13》（连同它的待办归属一起收口）：其结论按性质全部有主——大仓库文件树虚拟化 → [UI/UX 任务书](taskbooks/application-ui-ux-taskbook-2026-09-22.md) 的 UX-17（基准先行）、审阅侧栏独立宽度 → UX-18，行级评论持久性与真正的 VS Code 扩展 → 同一任务书第 7 节（标明属产品面/数据模型决定、当前不排期）；上游 commit、许可证、扩展体积与关键源码链接也留存在第 7 节，当时已吸收的 5 项改动由 `packages/app/src/renderer/` 各领域 README 拥有。同日退役《文档退役审查记录 2026-09-22》：它是一次性审查的过程记录，其中的裁定此后已全部执行完毕（被列为"保留"的 agent-runtime 任务书、对标记录与本次一并处置，对话连续性 P0 仍在跟踪且头部已按后续复核更新，模块图与仓库指南的修正已落地），原文只保留在 git 历史（`git log --follow -- docs/reference/document-retirement-review-2026-09-22.md`）。

2026-09-24 同日退役缓存基线里 5 份被取代或只是账本渲染的文档：《改动前基线》《任务区间回放后》《回放与压缩修复后》《强制收尾修复后》四份逐批快照的机器可读账本（`.json`）与仍然成立的结论改由[缓存基线](reference/cache-baseline/README.md) 的批次历史表承接，`baseline-git-0af62a7.md`（其共享前缀读数被同目录 README 判定为误测）直接删除；当前红线证据（L1 长任务、重启、空闲）与验收门读取的两个账本全部保留，原文见 git 历史。

任务书中出现的 `CLASSIFY`、`chat / problem / unclear`、旧测试数量和旧 Catalog 版本属于对应阶段的历史验收语境。当前活动路由只产出 `execute` 与能力/状态 `reply` 两条路径：`respond` 在路由边界归一为 `execute`，`clarify` 不是可路由活动；`decide`、`evolve`、`capture` 只作为历史 stage 名保留在旧检查点、LLM Call Contract 和兼容字段里，不得再作为新的产品概念使用。

## 需要定位代码或维护仓库时

- [仓库指南](reference/repository-guide.md)：需求类型对应的 package、入口、测试、依赖和维护流程。
- [模块拆分地图](reference/module-split-map.md)：大型生产文件的所有权、上限和拆分边界。
- [Core Flow 状态契约](reference/core-flow-state-contract.md)：唯一 Stage 转移 manifest、非法边拒绝和 RunContext ownership/lifecycle 边界。
- [插件开发说明](reference/plugin-development.md)：插件贡献、权限、生命周期和兼容规则。
- [自定义模型供应商](reference/custom-model-providers.md)：Provider/模型配置字段、密钥存放、未声明能力的未知语义，以及只支持 OpenAI 兼容接口的边界。
- 论文材料：论文正文、图表和复核材料的范围及提交前边界见 `docs/paper/README.md`，正文源稿为 `docs/paper/littlesheep-thesis.md`。**这两份是本机材料、未纳入版本库**（`git ls-files docs/paper` 为空），因此这里只给路径而不做文档链接——链接会让仓库门禁依赖不存在于版本库中的文件。

## 文档冲突规则

1. 长期使命与硬约束：以架构原则为准。
2. 当前实现与验证数字：以项目状态和源码测试为准。
3. 下一阶段顺序：以架构决策报告为准。
4. 具体阶段验收：以对应任务书为准。
5. 目录和模块归属：以仓库指南为准。

发现冲突时先修正文档责任边界，不通过复制一份新的总结来规避冲突。
