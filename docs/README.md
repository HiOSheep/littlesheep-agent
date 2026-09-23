# LittleSheep 文档决策入口

最后更新：2026-09-23 22:50:00

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：活动路由只产出两条路径——所有常规会话与任务回合都进入单一主循环 `execute`，只有能力/状态询问走最小 Runtime 事实契约的 `reply`；`respond` 在路由边界归一为 `execute`，`clarify` 不是可路由活动（缺少信息时由回复本身追问，或由主循环的 `request_user_input` 与恢复升级到达 `ASK_USER`）。DECIDE、VERIFY 模型调用、RECOVER 模型调用和 CAPTURE 已删除：已持久化的 TaskBook 只作为可读历史，步骤在主循环内串行推进；本回合无权使用的工具在执行时被拒绝，而广告给模型的工具目录在整个会话区间内保持固定；`memory_tree` 只读（`root_index` / `branch_index` / `expand` / `deep_search` / `release`），模型没有记忆写入工具，持久记忆的唯一写入方是会话压缩路径。

**推荐下一步**：执行[Runtime 状态一致性与必要记忆任务书](taskbooks/runtime-state-consistency-taskbook-2026-09-22.md)。Harness / Runner 冻结为 stable kernel，仅因真实 correctness bug、删除复杂度或已证明缺失的硬 invariant 做最小修改；Runtime 优先补齐 read observation → 写前 revision 校验 → checkpoint → mutate 及 exec 后失效。Memory 采用用户最新方向“明确要求或必要时写入”，与上下文压缩解耦；这仍是待实现方向，当前写入事实见上段。上一份缓存专项按用户确认已完成，后续只保留[现行缓存验收约束](reference/cache-95-acceptance.md#真实长任务现行红线2026-09-22)，不重复安排原清单。[对话连续性 P0](taskbooks/conversation-task-continuity-taskbook-2026-08-13.md)与 UI 专项的未完成验收仍独立保留。

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

- [对话执行可靠性修复任务清单 2026-09-23](taskbooks/conversation-execution-reliability-taskbook-2026-09-23.md)：CE-01～CE-13 覆盖最新对话测试的 P1～P9 及用户追加的运行时变更简报；优先处理工作区事实、shell 披露、单次失败即停手，并将模型/工作区/权限等已生效变化以简短上下文告知模型，再核验只读防重放、恢复循环与失败可见性。区分源码确认、报告复现、历史已修和待取证，包含依赖、验收标准及真实小游戏交付门。CE-01～CE-09 与 CE-11 已实施并有定向自动化证据，CE-10 完成合同侧（记录在该文档的五段"实施记录"；CE-07 给出"恢复投影缺陷已修＋原报告无法证实"，CE-09 给出"原 P8 从源码不可复现、按回归保护关闭"），**尚未做真实模型 / Electron 实机验收**；CE-10 的行为面与 CE-12 全矩阵仍是唯一交付门。
- [桌面冷启动体验与加载策略优化任务书 2026-09-23](taskbooks/desktop-cold-start-taskbook-2026-09-23.md)：CS-01～CS-07 覆盖启动计时、视觉统一、界面提前可用、执行准备提速、按需加载、续接保护和真实 Electron 验收。CS-01～CS-06 的实现与自动化验收已完成，事实汇总在[桌面冷启动基线](reference/cold-start-baseline/README.md)：五时间点基线与冷/稳态回归护栏、三种窗口宽度的真实像素证据（含启动失败页）、未就绪期间的真实交互证据、按需加载的**唯一**一项成对实测提速（语法高亮，首次可执行 1750.7 → 1517.0 ms），以及 durable 存储并行初始化的阶段级收益（Runner 构建净约 14 ms，**未**在首次可执行上测出稳定改善）。未完成的复选框都需要人工或实机条件：缩放/壁纸/失焦等视觉状态、需真实模型配置的恢复归属验证、安装包实机。
- [应用层 UI / UX 优化与统一任务书 2026-09-22](taskbooks/application-ui-ux-taskbook-2026-09-22.md)：16 项应用层待办，覆盖输入、删除、停止、恢复反馈、设置草稿、键盘、能力空态及视觉一致性；区分源码确认与待实机验证，作为独立排期清单。
- [真实长任务缓存红线任务书 2026-09-22](taskbooks/real-long-task-cache-taskbook-2026-09-22.md)：对齐 DeepSeek Harness 会话累计值的长任务 >=95% 红线，LT-00～LT-08 的真实样本、损失归因、跨 run 续接、输入精简、压缩、能力收缩与逐任务验收。

### 当前主线

- [文档退役审查记录 2026-09-22](reference/document-retirement-review-2026-09-22.md)：本轮集中审查的逐条结论与执行动作（保留并重述对话连续性 P0、退役状态机重设计/开发反馈环/网络检索/原子记忆四份任务书、对标记录改判为保留、模块图 1 条真实修正、解除一份门禁固定），并记录三处原始证据的更正。
- [Runtime 状态一致性与必要记忆任务书 2026-09-22](taskbooks/runtime-state-consistency-taskbook-2026-09-22.md)：合并原记忆写入专项；RS-00～08 覆盖内核冻结、文件观察与写前校验、exec 失效、压缩解绑、明确要求或必要时写入，以及真实流程/缓存回归。
- [Harness 开源底座评估 2026-09-02](reference/harness-open-source-evaluation-2026-09-02.md)：固定 DeepSeek Harness、Pi 与 nanoDeepSeekHarness 版本、许可证、供应链证据和 LS adapter 边界；当前决定保留自有 kernel、只吸收 durable event/session/stream 设计。
- [OpenCode VS Code 对标记录 2026-08-13](reference/opencode-vscode-comparison-2026-08-13.md)：记录官方源码、许可证、LS 差异、已直接吸收的缓存/模型/审阅交互，以及待产品选择的虚拟化、评论和真正 VS Code 扩展路线。
- [对话任务连续性 P0 专项任务书 2026-08-13](taskbooks/conversation-task-continuity-taskbook-2026-08-13.md)：修复普通聊天未绑定 waiting-user Checkpoint、执行现场与附件/临时工具无法自然恢复、权限未按当前状态重验及最终回答断档。
- [缓存 95% 冻结负载验收规程](reference/cache-95-acceptance.md)：把极简执行与缓存 95% 方案的实测步骤写成可重复规程——冻结任务集/模型/配置/轮数与会话组织、旧新两组对比流程、`hit = sum(cached)/sum(input)` 测量规则、未知 usage 处理、禁止做法与完成条件；当前实测记录见 §7。
- [缓存请求形状基线](reference/cache-baseline/README.md)：同一探针在改前/改后两个 checkout 上跑同一冻结负载的逐请求字符数、共享前缀与工具目录摘要对比；[最新一次运行](reference/cache-baseline/latest.md)由 harness 测试自动重写，[改前冻结副本](reference/cache-baseline/pre-fix-cd6cabc.md)与[改后冻结副本](reference/cache-baseline/baseline-git-0af62a7.md)保留为对比依据（不含提示词正文、会话内容或密钥）。
- [桌面冷启动基线 2026-09-23](reference/cold-start-baseline/README.md)：CS-01 的五时间点基线（进程启动、真实首帧、输入可用、当前会话可读、首次可执行）× 空/普通/大历史/待恢复四档隔离数据，含逐次原始机器可读账本、CS-04 执行准备预算拆解（Runner 构建 121 ms / RunRouter 50 ms / 插件宿主 2.8 ms）与两项已被实测证伪的"提速"改动记录；[原始账本](reference/cold-start-baseline/desktop-cold-start-baseline-2026-09-23.json)。
- [真实长任务缓存基线 2026-09-22](reference/cache-baseline/real-long-task-baseline-2026-09-22.md)：六个冻结真实任务各跑两次（12 次运行，真实 Provider）的会话累计 H_ui、逐节点值、未缓存三类分解与派生上界；改动前 0/12 达标、4/12 功能失败，[原始机器可读账本](reference/cache-baseline/real-long-task-baseline-2026-09-22.json)同步提交。
- [改动后基线（任务区间回放）2026-09-22](reference/cache-baseline/real-long-task-baseline-post-lt02-2026-09-22.md)：跨 run 回放修复后的复测——平均 H_ui 73.4%→84.2%，功能失败 4/12→1/12，9/12 次运行的回合边界逐消息一致；仍 0/12 达标，[机器可读账本](reference/cache-baseline/real-long-task-baseline-post-lt02-2026-09-22.json)同步提交。
- [回放与压缩修复后基线 2026-09-22](reference/cache-baseline/real-long-task-baseline-after-replay-fixes-2026-09-22.md)：平均 H_ui 85.96%（敏感性视图 87.2%），功能失败 1/12，仍 0/12 达标；该批随后被查出 `tool_choice` 收尾改写的真实损失，[机器可读账本](reference/cache-baseline/real-long-task-baseline-after-replay-fixes-2026-09-22.json)同步提交。
- [当前基线（强制收尾修复后）2026-09-22](reference/cache-baseline/real-long-task-baseline-forced-final-fix-2026-09-22.md)：再复测同一冻结清单——平均 H_ui **88.14%**，**产物验收 12/12 全通过**、usage 完整 12/12，仍 0/12 达标；`provider 上报矛盾` 警告在 12 次里全部消失（修复前 10/20 会话样本命中），[机器可读账本](reference/cache-baseline/real-long-task-baseline-forced-final-fix-2026-09-22.json)同步提交。
- [长区间任务 L1 基线 2026-09-22](reference/cache-baseline/long-interval-task-L1-2026-09-22.md)：28 回合长任务在"任务区间不可淘汰"修复后的**两次**实测——整会话 H_ui **99.13% / 99.21%**（179 / 222 请求，usage 均完整、0 失败尝试、0 provider 矛盾），两次的第 16/22/25/28 回合冻结节点分别为 97.00/98.30/98.81/98.94% 与 96.66/98.43/98.66/98.79%，产物验收均 6/6；早期节点仍低于 95%，是冷启动尚未摊薄所致，[机器可读账本](reference/cache-baseline/long-interval-task-L1-2026-09-22.json)同步提交。
- [冻结清单复跑（任务区间不可淘汰后）2026-09-22](reference/cache-baseline/real-long-task-baseline-pinned-interval-2026-09-22.md)：12 次运行全部 usage 完整、产物验收 12/12、0 provider 矛盾，平均 H_ui 87.07%（3 回合形状的冷启动上限），重建未缓存降至 0（仅 A2 两次与 B1#1 少量），[机器可读账本](reference/cache-baseline/real-long-task-baseline-pinned-interval-2026-09-22.json)同步提交。
- [长区间任务 L1 重启连续性 2026-09-22](reference/cache-baseline/long-interval-task-L1-restart-2026-09-22.md)：同一 28 回合任务在第 14 回合**重启应用进程**后继续——H_ui **98.99%**（169 请求、usage 完整、0 失败尝试），后段节点 96.81/97.67/98.19/98.42%，产物验收 6/6；重启本身不损失前缀（缓存属服务端），[机器可读账本](reference/cache-baseline/long-interval-task-L1-restart-2026-09-22.json)同步提交。
- [长区间任务 L1 空闲停顿连续性 2026-09-22](reference/cache-baseline/long-interval-task-L1-idle-pause-2026-09-22.md)：第 14 回合前**空闲 45 分钟**再继续——暂停后首个请求 `in=56,372 / cached=56,192`（99.7% 命中），整会话 H_ui **99.05%**，后段节点 97.34/97.91/98.44/98.80%，产物验收 6/6；结论为**有界**陈述（至少 45 分钟内缓存有效），[机器可读账本](reference/cache-baseline/long-interval-task-L1-idle-pause-2026-09-22.json)同步提交。
- [网络检索冻结契约与威胁模型](reference/web-retrieval-security-contract.md)：固定 safe read、网络配置、Tavily 首个 Provider、SSRF/DNS/注入/外发威胁、引用和日志语义；原实施任务书已于 2026-09-22 退役，实现状态与发布门改由验收报告维护。
- [网络检索安全合并验收 2026-08-29](reference/web-retrieval-security-acceptance-2026-08-29.md)：记录离线安全矩阵、迁移/回退、构建产物扫描和仍阻断 ready 的实际 Provider/正式渠道门。
- [网络检索供应链审查 2026-08-29](reference/web-retrieval-supply-chain-review-2026-08-29.md)：记录 Web 包依赖、许可证、漏洞快照、发布扫描边界与复核条件。
- [网络检索发布清单 2026-08-29](reference/web-retrieval-release-checklist-2026-08-29.md)：列出离线门、发布当天实际 Provider/渠道/release 包验证和明确的禁止发布条件。
- [生产依赖安全记录](reference/production-dependency-security.md)：记录临时间接依赖 override 的固定版本、来源、许可证、移除条件与复查日期，避免安全修复变成无所有者的永久配置。
- [Agent Runtime 连续性任务书 2026-07-14](taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md)：Provider 校准、Context、附件、运行中重入、检查点、后台执行和有界并行。

### 任务书生命周期

任务书保存阶段设计和验收记录，不代表全局最新状态。不要通过比较任务书日期判断下一步。

**任务书完成后不再留在仓库里**：先把仍然成立的事实汇总到拥有它的常驻文档（项目状态、架构决策报告、架构原则、`reference/` 对应参考），再用 `git rm` 取消追踪并删除本节条目；原文保留在 git 历史中（`git log --follow -- <path>` 可取回）。仓库自检对 `docs/taskbooks/` 下的任务书数量设有预算，超预算时先退役已完成的任务书再新增。规则细节见[仓库指南](reference/repository-guide.md)。

2026-09-22 已按此规则退役第一批已完成/已失效文档（7 份任务书 + 1 份参考），其中事实已分别归入 `AGENTS.md`、项目状态与遗留参考；退役理由、逐份去向和仍待用户裁定的处置见[文档退役待审清单 2026-09-22](reference/document-retirement-review-2026-09-22.md)。因判定依据不足而**未**退役的文档一律在该清单中列出，不得由实现者直接删除。

任务书中出现的 `CLASSIFY`、`chat / problem / unclear`、旧测试数量和旧 Catalog 版本属于对应阶段的历史验收语境。当前活动路由只产出 `execute` 与能力/状态 `reply` 两条路径：`respond` 在路由边界归一为 `execute`，`clarify` 不是可路由活动；`decide`、`evolve`、`capture` 只作为历史 stage 名保留在旧检查点、LLM Call Contract 和兼容字段里，不得再作为新的产品概念使用。

## 需要定位代码或维护仓库时

- [仓库指南](reference/repository-guide.md)：需求类型对应的 package、入口、测试、依赖和维护流程。
- [模块拆分地图](reference/module-split-map.md)：大型生产文件的所有权、上限和拆分边界。
- [Core Flow 状态契约](reference/core-flow-state-contract.md)：唯一 Stage 转移 manifest、非法边拒绝和 RunContext ownership/lifecycle 边界。
- [插件开发说明](reference/plugin-development.md)：插件贡献、权限、生命周期和兼容规则。
- [自定义模型供应商](reference/custom-model-providers.md)：Provider/模型配置字段、密钥存放、未声明能力的未知语义，以及只支持 OpenAI 兼容接口的边界。
- [论文材料入口](paper/README.md)：论文正文、图表和复核材料的范围及提交前边界；正文源稿见 [LittleSheep 论文初稿](paper/littlesheep-thesis.md)。

## 文档冲突规则

1. 长期使命与硬约束：以架构原则为准。
2. 当前实现与验证数字：以项目状态和源码测试为准。
3. 下一阶段顺序：以架构决策报告为准。
4. 具体阶段验收：以对应任务书为准。
5. 目录和模块归属：以仓库指南为准。

发现冲突时先修正文档责任边界，不通过复制一份新的总结来规避冲突。
