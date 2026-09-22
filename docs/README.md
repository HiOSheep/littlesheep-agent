# LittleSheep 文档决策入口

最后更新：2026-09-22 12:26:09

本页是正式文档的唯一首要入口。日常决策先看本页，不要从任务书、仓库指南或架构长文开始阅读。

## 现在先做什么

**当前阶段**：活动路由只产出两条路径——所有常规会话与任务回合都进入单一主循环 `execute`，只有能力/状态询问走最小 Runtime 事实契约的 `reply`；`respond` 在路由边界归一为 `execute`，`clarify` 不是可路由活动（缺少信息时由回复本身追问，或由主循环的 `request_user_input` 与恢复升级到达 `ASK_USER`）。DECIDE、VERIFY 模型调用、RECOVER 模型调用和 CAPTURE 已删除：已持久化的 TaskBook 只作为可读历史，步骤在主循环内串行推进；本回合无权使用的工具在执行时被拒绝，而广告给模型的工具目录在整个会话区间内保持固定；`memory_tree` 只读（`root_index` / `branch_index` / `expand` / `deep_search` / `release`），模型没有记忆写入工具，持久记忆的唯一写入方是会话压缩路径。

**推荐下一步**：执行[真实长任务缓存红线任务书](taskbooks/real-long-task-cache-taskbook-2026-09-22.md)。上一批提示词与 run 内追加修复作为基线；本轮转向真实任务样本、跨 run 续接、新增输入、压缩和恢复成本，允许能力收缩。用户最新明确对齐 DeepSeek Harness 前端的会话累计指标：真实长任务验收节点以 95% 为红线、95%～99.5% 为目标工作范围；允许初始冷启动低值，首请求仍计入累计，完整辅助成本另列；具体口径以[现行验收条款](reference/cache-95-acceptance.md#真实长任务现行红线2026-09-22)为准。当前状态与既有实测见[项目状态](decision/project-status.md#缓存命中率现状)，新真实长任务验收尚未完成。[对话任务连续性 P0 专项](taskbooks/conversation-task-continuity-taskbook-2026-08-13.md)另行跟踪，仍未完成。

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

- [真实长任务缓存红线任务书 2026-09-22](taskbooks/real-long-task-cache-taskbook-2026-09-22.md)：对齐 DeepSeek Harness 会话累计值的长任务 >=95% 红线，LT-00～LT-08 的真实样本、损失归因、跨 run 续接、输入精简、压缩、能力收缩与逐任务验收。
- [极简执行与缓存 95% 实施方案任务书 2026-09-20](taskbooks/lean-v2-cache-95-plan-taskbook-2026-09-20.md)：上一阶段能力裁剪与旧负载的执行记录；未完成的缓存目标由新的真实长任务专项接续，历史口径不作为新红线。

### 当前主线

- [Harness 全面瘦身审计与实施任务书 2026-09-12](taskbooks/harness-lean-audit-taskbook-2026-09-12.md)：全链路审计、等待分解、分批实施与质量/连续性/延迟验收门。- [Harness 瘦身第一批实施包：HL-00～HL-04](taskbooks/harness-lean-phase-a-implementation-taskbook-2026-09-12.md)：路由/验证、计时/用量与真实活动投影。
- [Harness 瘦身第二批实施包：HL-05/HL-06 与配套 HL-10](taskbooks/harness-lean-phase-b-implementation-taskbook-2026-09-13.md)：工作策略解耦、有界循环、TaskBook 升级、规划/候选/工具轮次减法及恢复门。
- [Harness 瘦身第三批实施包：HL-08/HL-09 与配套 HL-07/HL-10](taskbooks/harness-lean-phase-c-implementation-taskbook-2026-09-14.md)：压缩时统一沉淀、短会话回查、显式记忆、幂等恢复与上下文/等待减法。
- [LS 状态机重设计任务书 2026-09-18](taskbooks/state-machine-redesign-taskbook-2026-09-18.md)：把"判断类决策交还模型、安全类留运行时"落成逐项清单，覆盖延续歧义、重复发布、澄清停放、恢复、验证、工具循环、压缩、检查点、策略和记忆。
- [Harness 开源底座评估 2026-09-02](reference/harness-open-source-evaluation-2026-09-02.md)：固定 DeepSeek Harness、Pi 与 nanoDeepSeekHarness 版本、许可证、供应链证据和 LS adapter 边界；当前决定保留自有 kernel、只吸收 durable event/session/stream 设计。
- [OpenCode VS Code 对标记录 2026-08-13](reference/opencode-vscode-comparison-2026-08-13.md)：记录官方源码、许可证、LS 差异、已直接吸收的缓存/模型/审阅交互，以及待产品选择的虚拟化、评论和真正 VS Code 扩展路线。
- [对话任务连续性 P0 专项任务书 2026-08-13](taskbooks/conversation-task-continuity-taskbook-2026-08-13.md)：修复普通聊天未绑定 waiting-user Checkpoint、执行现场与附件/临时工具无法自然恢复、权限未按当前状态重验及最终回答断档。
- [新 Harness 重建与 Prompt Cache 收敛任务书 2026-09-02](taskbooks/harness-rebuild-and-cache-taskbook-2026-09-02.md)：以冻结提交/tag 为回滚锚点，评估开源 Agent runtime，重建 durable event/inbox/replay、effect intent/settlement 和 authoritative final settlement，并以 `CACHE-01` 至 `CACHE-10` 观测和修复上下文注入造成的 Provider prompt-cache 低命中率。
- [Harness 发布就绪与双路径对比记录 2026-09-11](reference/harness-rollout-readiness-2026-09-11.md)：汇总当前质量门、双路径成本/延迟/质量对比能力、发布门 reason 集合、灰度/回滚契约，以及仍阻断发布决定的真实 Provider、外部服务对账和真实渠道条目。
- [缓存 95% 冻结负载验收规程](reference/cache-95-acceptance.md)：把极简执行与缓存 95% 方案的实测步骤写成可重复规程——冻结任务集/模型/配置/轮数与会话组织、旧新两组对比流程、`hit = sum(cached)/sum(input)` 测量规则、未知 usage 处理、禁止做法与完成条件；当前实测记录见 §7。
- [缓存请求形状基线](reference/cache-baseline/README.md)：同一探针在改前/改后两个 checkout 上跑同一冻结负载的逐请求字符数、共享前缀与工具目录摘要对比；[最新一次运行](reference/cache-baseline/latest.md)由 harness 测试自动重写，[改前冻结副本](reference/cache-baseline/pre-fix-cd6cabc.md)与[改后冻结副本](reference/cache-baseline/baseline-git-0af62a7.md)保留为对比依据（不含提示词正文、会话内容或密钥）。
- [真实长任务缓存基线 2026-09-22](reference/cache-baseline/real-long-task-baseline-2026-09-22.md)：六个冻结真实任务各跑两次（12 次运行，真实 Provider）的会话累计 H_ui、逐节点值、未缓存三类分解与派生上界；改动前 0/12 达标、4/12 功能失败，[原始机器可读账本](reference/cache-baseline/real-long-task-baseline-2026-09-22.json)同步提交。
- [改动后基线（任务区间回放）2026-09-22](reference/cache-baseline/real-long-task-baseline-post-lt02-2026-09-22.md)：同一冻结清单在跨 run 回放修复后的复测——平均 H_ui 73.4%→84.2%，功能失败 4/12→1/12，9/12 次运行的回合边界逐消息一致；仍 0/12 达标，[机器可读账本](reference/cache-baseline/real-long-task-baseline-post-lt02-2026-09-22.json)同步提交。
- [改动后基线（任务区间回放）2026-09-22](reference/cache-baseline/real-long-task-baseline-post-lt02-2026-09-22.md)：跨 run 回放修复后的复测——平均 H_ui 73.4%→84.2%，功能失败 4/12→1/12，9/12 次运行的回合边界逐消息一致；仍 0/12 达标，[机器可读账本](reference/cache-baseline/real-long-task-baseline-post-lt02-2026-09-22.json)同步提交。
- [回放与压缩修复后基线 2026-09-22](reference/cache-baseline/real-long-task-baseline-after-replay-fixes-2026-09-22.md)：平均 H_ui 85.96%（敏感性视图 87.2%），功能失败 1/12，仍 0/12 达标；该批随后被查出 `tool_choice` 收尾改写的真实损失，[机器可读账本](reference/cache-baseline/real-long-task-baseline-after-replay-fixes-2026-09-22.json)同步提交。
- [当前基线（强制收尾修复后）2026-09-22](reference/cache-baseline/real-long-task-baseline-forced-final-fix-2026-09-22.md)：再复测同一冻结清单——平均 H_ui **88.14%**，**产物验收 12/12 全通过**、usage 完整 12/12，仍 0/12 达标；`provider 上报矛盾` 警告在 12 次里全部消失（修复前 10/20 会话样本命中），[机器可读账本](reference/cache-baseline/real-long-task-baseline-forced-final-fix-2026-09-22.json)同步提交。
- [长区间任务 L1 基线 2026-09-22](reference/cache-baseline/long-interval-task-L1-2026-09-22.md)：28 回合长任务在"任务区间不可淘汰"修复后的实测——**整会话 H_ui 99.13%**（179 请求、usage 完整、0 失败尝试、0 provider 矛盾），第 4 回合越过 95%、第 16/22/25/28 回合冻结节点分别为 **97.00 / 98.30 / 98.81 / 98.94%**，6/6 产物验收通过；早期节点（第 1–3、7–8 回合）仍低于 95%，是冷启动尚未摊薄所致，[机器可读账本](reference/cache-baseline/long-interval-task-L1-2026-09-22.json)同步提交。
- [实时网络检索与安全读取任务书 2026-08-28](taskbooks/web-search-and-safe-retrieval-taskbook-2026-08-28.md)：实施 `web_search`、`web_fetch`、Provider、受控本地抓取、safe read、证据引用、记忆协同、UI 与发布验收。
- [网络检索冻结契约与威胁模型](reference/web-retrieval-security-contract.md)：固定 safe read、网络配置、Tavily 首个 Provider、SSRF/DNS/注入/外发威胁、引用和日志语义。
- [网络检索安全合并验收 2026-08-29](reference/web-retrieval-security-acceptance-2026-08-29.md)：记录离线安全矩阵、迁移/回退、构建产物扫描和仍阻断 ready 的实际 Provider/正式渠道门。
- [网络检索供应链审查 2026-08-29](reference/web-retrieval-supply-chain-review-2026-08-29.md)：记录 Web 包依赖、许可证、漏洞快照、发布扫描边界与复核条件。
- [网络检索发布清单 2026-08-29](reference/web-retrieval-release-checklist-2026-08-29.md)：列出离线门、发布当天实际 Provider/渠道/release 包验证和明确的禁止发布条件。
- [生产依赖安全记录](reference/production-dependency-security.md)：记录临时间接依赖 override 的固定版本、来源、许可证、移除条件与复查日期，避免安全修复变成无所有者的永久配置。
- [开发反馈环提速任务书 2026-08-09](taskbooks/development-feedback-loop-taskbook-2026-08-09.md)：任务级内循环、affected 选择器、重复构建消除和后续状态契约收敛；用于决定下一阶段开发效率工作。
- [原子记忆与内置向量目录任务书 2026-07-17](taskbooks/memory-atom-vector-catalog-taskbook-2026-07-17.md)：Memory v3 原子文件、层级、本地向量目录、三层视图边界、动态注入、压缩连续性、迁移与验收。
- [Agent Runtime 连续性任务书 2026-07-14](taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md)：Provider 校准、Context、附件、运行中重入、检查点、后台执行和有界并行。
- [Agent Runtime 效率与版本化连续性任务书 2026-07-17](taskbooks/agent-runtime-efficiency-versioning-taskbook-2026-07-17.md)：工具调用并行、shadow Git、检查点、退出冻结、LLM 调用预算和前台 `SOUL` 表达边界。

### 任务书生命周期

任务书保存阶段设计和验收记录，不代表全局最新状态。不要通过比较任务书日期判断下一步。

**任务书完成后不再留在仓库里**：先把仍然成立的事实汇总到拥有它的常驻文档（项目状态、架构决策报告、架构原则、`reference/` 对应参考），再用 `git rm` 取消追踪并删除本节条目；原文保留在 git 历史中（`git log --follow -- <path>` 可取回）。仓库自检对 `docs/taskbooks/` 下的任务书数量设有预算，超预算时先退役已完成的任务书再新增。规则细节见[仓库指南](reference/repository-guide.md)。

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
