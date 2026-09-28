# LittleSheep 文档决策入口

最后更新：2026-09-29 00:21:45

本页是正式文档的唯一首要入口。它与[仓库指南](reference/repository-guide.md)的「开发约定（coding agent 的唯一短规则）」共同构成开发本仓库时的规则边界：本页只做导航，短规则与验证分档由仓库指南拥有，不要在这里维护第二份启动读序。

## 现在先做什么

**当前阶段**：活动路由只产出两条路径——所有常规会话与任务回合都进入单一主循环 `execute`，只有能力/状态询问走最小 Runtime 事实契约的 `reply`；`respond` 在路由边界归一为 `execute`，`clarify` 不是可路由活动（缺少信息时由回复本身追问，或由主循环的 `request_user_input` 与恢复升级到达 `ASK_USER`）。DECIDE、VERIFY 模型调用、RECOVER 模型调用和 CAPTURE 已删除：已持久化的 TaskBook 只作为可读历史，步骤在主循环内串行推进；本回合无权使用的工具在执行时被拒绝，而广告给模型的工具目录在整个会话区间内保持固定；`memory_tree` 只读（`root_index` / `branch_index` / `expand` / `deep_search` / `release`）；持久记忆由受控工具 `memory_write`/`memory_manage` 写入，会话压缩只产生摘要——当前事实、理由与验收入口统一由[项目状态](decision/project-status.md)的「会话压缩与记忆写入」维护，本页不复述。

**推荐下一步**：按[项目状态](decision/project-status.md)的「推荐后续顺序」推进。原 Runtime 状态一致性与必要记忆任务书（2026-09-22）已于 2026-09-27 退役——文件一致性、受控记忆写入、向量边界、真实模型与旧数据根验收全部完成，仍然成立的事实归入项目状态的「文件一致性与受控记忆（2026-09-27）」，原文见 git 历史。

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

- [Runtime 自主执行与沙箱边界验证任务书 2026-09-27](taskbooks/runtime-autonomy-sandbox-evaluation-taskbook-2026-09-27.md)：首轮 12 项实验已交付，独立审阅发现 Runtime 候选、沙箱验收器和证据口径仍需补正；第 10 节新增 RA-01～RA-10 执行清单，按证据修正、Runtime 候选、沙箱边界、真实入口验收和再次审阅推进。原始结果保留，尚未批准候选正式采用或沙箱默认启用。
- [LS 前端简洁高效化改造任务书 2026-09-27](decision/project-status.md)：保留磨砂玻璃与连续圆角，按输出展示、设置页、图标与视觉、交互与动画划分 O1～O6、S1～S6、V1～V5、I1～I5 共 22 项任务；新增字号、深浅／系统主题、自定义配色及参考本地 DSH 插件的 Token 用量热力图，含数据口径、依赖、验收与执行台账。阶段 0 已开始；本次新增五项仅完成规划，尚未实施。
- 仓库开发 Agent 约束瘦身（2026-09-28，任务书已退役）：GA-00～GA-03、GA-05 已落地——短规则与验证分档归入[仓库指南](reference/repository-guide.md)的「开发约定（coding agent 的唯一短规则）」，秒级时间戳与 README chronology 门已删除、行数类结构阈值改为提示而结构完整性仍是硬门，结论与样本边界见[项目状态](decision/project-status.md)的「仓库开发 Agent 约束瘦身」。**原文尚未进入 Git 历史**：退役删除还没有提交，文本目前是可被 gc 回收的悬挂 blob 与一份机器本地副本，取回方式见该节。
- 整仓瘦身与冗余收口（2026-09-27，任务书已退役）：结果、实测数字、修正过的依赖边判断与仍开放项见[项目状态](decision/project-status.md)中的同名小节；改动前基线见[基线账本](reference/repository-slimming-baseline-2026-09-27.md)。任务书全文留在 Git 历史。
- [整仓瘦身基线账本（SL-00）2026-09-27](reference/repository-slimming-baseline-2026-09-27.md)：把改动前基线绑定到 HEAD `ec527a7e` 与工作区差异摘要——`git ls-files` 1,930 项 / HEAD blob 18,351,219 字节、package TS/TSX 非测试 153,887 行与测试 96,273 行、`scripts/` 67,377 行、111 个误入库生成物（271,959 字节，测量时已由 SL-01 从工作树删除）、只读现算的 App 构建 input/output 指纹、本地目录字节与 win32/x64 平台；同时记录 SL-03 的改动前后与 taskbook Skill 取证输出。未重建、未运行，因此不含提速结论。
- [单层子 Agent 与执行效率任务书 2026-09-24](taskbooks/single-level-subagent-taskbook-2026-09-24.md)：SA-00～SA-09 规划主 Agent 工具调用、禁止递归委派、只读并行、共享权限/预算、停止恢复、结果证据及真实效率验收；对照 Gemini CLI、Claude Code、OpenCode 与 OpenAI 官方设计后补入任务角色、模型选型、上下文收益及小样本边界。SA-11 与 SA-10 分别在测量后评估异步和受控写入。当前为方案，尚未实现或证明提速。

### 当前主线

- Runtime 状态一致性与必要记忆任务书（2026-09-22）：**已于 2026-09-27 退役**，事实归入[项目状态](decision/project-status.md)的「文件一致性与受控记忆（2026-09-27）」。
- [Harness 开源底座评估 2026-09-02](reference/harness-open-source-evaluation-2026-09-02.md)：固定 DeepSeek Harness、Pi 与 nanoDeepSeekHarness 版本、许可证、供应链证据和 LS adapter 边界；当前决定保留自有 kernel、只吸收 durable event/session/stream 设计。
- Harness 当前语义与历史复杂度收口任务书（2026-09-25）：**已于 2026-09-27 退役**（HC-00～HC-06 全部落地），事实归入[项目状态](decision/project-status.md)的「Harness 当前语义（2026-09-27）」。
- 对话任务连续性 P0 专项任务书（2026-08-13）：**已于 2026-09-27 退役**，事实归入[项目状态](decision/project-status.md)的「对话连续性（2026-09-27）」。
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

任务书保存阶段设计和验收记录，不代表全局最新状态；不要通过比较任务书日期判断下一步。一份任务书完成后不再留在仓库里：先把仍然成立的事实汇总到拥有它的常驻文档，再取消追踪，原文保留在 git 历史中。规则细节、任务书数量预算，以及"判定依据不足的文档不得由实现者直接删除、有争议先记录待裁定项由用户裁定"由[仓库指南](reference/repository-guide.md)拥有，本页不复述。

已退役文档与事实去向（逐份的阶段结论、验收数字与逐条证据只在 git 历史，用 `git log --follow -- <path>` 取回）：

| 退役日期 | 文档 | 仍成立事实的当前所有者 |
| --- | --- | --- |
| 2026-09-22 | 第一批已完成/失效文档（7 份任务书 + 1 份参考） | `AGENTS.md`、[项目状态](decision/project-status.md)；逐条去向与证据更正曾记录在《文档退役审查记录 2026-09-22》（其后于 2026-09-24 退役，原文见 git 历史 `docs/reference/document-retirement-review-2026-09-22.md`） |
| 2026-09-24 | 对话执行可靠性修复任务清单 2026-09-23（CE-01～CE-13，65 条验收项完成） | [项目状态](decision/project-status.md)（核心流程与状态边语义、尾部账本与运行时简报、工作区事实与配置保存事务、交付门与探针）、[核心 Agent 流程规范](principles/core-agent-flow-guidelines.md)（验证分界、不可重试的恢复、交付优先、越权调用与提问轮边界）、[Core Flow 状态契约](reference/core-flow-state-contract.md)；两条未闭环（受限模式的批准对话框、强杀重启后的并发恢复租约）在项目状态的"未完成方向" |
| 2026-09-24 | 桌面冷启动体验与加载策略优化任务书 2026-09-23（CS-01～CS-10，59 条验收项完成） | [桌面冷启动基线](reference/cold-start-baseline/README.md)（全部指标、逐次账本、边界与复现命令，含 2026-09-24 人工确认范围与仍未闭环项）、[项目状态](decision/project-status.md)（选中会话与全局工作区的分离、恢复期路由隔离） |
| 2026-09-24 | Agent Runtime 连续性任务书 2026-07-14 | 机制已被后续架构取代（DECIDE 与工具提议路径、TaskBook 步骤执行器、逐请求时钟注入、记忆管理页均已删除）；五项未完成方向归入[项目状态](decision/project-status.md) 的"未完成方向"，其中原先无所有者的任务效率基线进入"P1：效率基线" |
| 2026-09-24 | 真实长任务缓存红线任务书 2026-09-22（LT-00～LT-08） | [缓存 95% 验收规程](reference/cache-95-acceptance.md)（指标定义、验收规程、实测边界、未汇总项）、[项目状态](decision/project-status.md)（使前缀可复用的架构事实、休眠但未修复的前缀稳定性问题）、[缓存基线](reference/cache-baseline/README.md)（逐次原始数字）与各 package README |
| 2026-09-24 | 网络检索发布清单 2026-08-29 / 网络检索供应链审查 2026-08-29 | [网络检索安全合并验收](reference/web-retrieval-security-acceptance-2026-08-29.md)（环境限制、发布当天复核清单、发布阻断条件、已知限制、Web 包依赖边界、许可证缺口、Tavily 公开条款快照、发布扫描规则）、[生产依赖安全记录](reference/production-dependency-security.md)（组合/替代许可证清单） |
| 2026-09-24 | OpenCode VS Code 对标记录 2026-08-13 | 文件树虚拟化的结论归[项目状态](decision/project-status.md)（决定不做虚拟化）；当时吸收的 5 项改动由 `packages/app/src/renderer/` 各领域 README 拥有；**审阅侧栏独立宽度、行级评论持久性与真正的 VS Code 扩展目前没有所有者**，属产品面/数据模型决定且不排期，细节（上游 commit、许可证、扩展体积与关键源码链接）只在 git 历史 `docs/reference/opencode-vscode-comparison-2026-08-13.md` |
| 2026-09-24 | 缓存基线 5 份被取代或只是账本渲染的文档 | [缓存基线](reference/cache-baseline/README.md) 的批次历史表；机器可读账本 `.json` 全部保留（gate 输入，且冷启动/重建/尾部三类分解的唯一副本） |
| 2026-09-26 | 应用层 UI / UX 优化与统一任务书 2026-09-22（UX-32～UX-39） | [项目状态](decision/project-status.md) 的"应用层 UI 与工作区（2026-09-26）"（含"同一批验收记录的开放边界"）与各 package / 领域 README、`scripts/README.md`；本轮修掉的四个真实窗口缺陷（终端面板空面板、切回标签键盘失效、每会话一条流耗尽连接、重放污染下一条命令）记录在同文件的终端会话条目 |
| 2026-09-27 | Runtime 状态一致性与必要记忆任务书 2026-09-22、Harness 当前语义与历史复杂度收口任务书 2026-09-25、对话任务连续性 P0 专项任务书 2026-08-13 | [项目状态](decision/project-status.md) 的三个对应小节（"文件一致性与受控记忆（2026-09-27）"、"Harness 当前语义（2026-09-27）"、"对话连续性（2026-09-27）"） |
| 2026-09-29 | 仓库开发 Agent 约束瘦身任务书 2026-09-28（GA-00～GA-03、GA-05 落地；GA-04 只完成试点） | [仓库指南](reference/repository-guide.md)（开发约定短规则、README 同步口径与评审三问、L1～L4 验证分档）、[项目状态](decision/project-status.md) 的"仓库开发 Agent 约束瘦身（2026-09-29）"（批次结果、GA-04 试点读数与样本边界、退役原文的取回方式）与"P1：效率基线"（配对试验未完成） |

本页保留的机器事实：`check:repo` 的 `required` 列表不固定任何任务书（见 `scripts/check-repository-hygiene.mjs` 的 `checkCanonicalFiles`），任务书数量受[仓库指南](reference/repository-guide.md)所述预算约束，且该预算现在是提示而非硬门。

任务书中出现的 `CLASSIFY`、`chat / problem / unclear`、旧测试数量和旧 Catalog 版本属于对应阶段的历史验收语境。当前活动路由只产出 `execute` 与能力/状态 `reply` 两条路径；`decide`、`evolve`、`capture` 只作为历史 stage 名保留在旧检查点与兼容字段里，不得再作为新的产品概念使用——路由与兼容边界由[项目状态](decision/project-status.md)的"核心流程（当前）"与 [Core Flow 状态契约](reference/core-flow-state-contract.md)拥有。

## 需要定位代码或维护仓库时

- [仓库指南](reference/repository-guide.md)：需求类型对应的 package、入口、测试、依赖和维护流程；开发本仓库的短规则、README 同步口径与 L1～L4 验证分档都在这里，不再另立一份入口。
- [模块拆分地图](reference/module-split-map.md)：大型生产文件的所有权、上限和拆分边界。
- [Core Flow 状态契约](reference/core-flow-state-contract.md)：唯一 Stage 转移 manifest、非法边拒绝和 RunContext ownership/lifecycle 边界。
- [插件开发说明](reference/plugin-development.md)：插件贡献、权限、生命周期和兼容规则。
- [自定义模型供应商](reference/custom-model-providers.md)：Provider/模型配置字段、密钥存放、未声明能力的未知语义，以及只支持 OpenAI 兼容接口的边界。
- [前端界面检查点 2026-09-27](reference/frontend-ui-checkpoint-2026-09-27.md)：大规模前端重构前的回滚锚点（标签 `ui-baseline-2026-09-27` → `e601ca7e`）、三档回滚方式、当前界面契约门禁，以及"视觉基线 PNG 早于锚点三天、建议重构前先刷新"的诚实说明。
- [产品级 UI/UX 差距审计 2026-09-27](reference/ui-ux-gap-audit-2026-09-27.md)：按用户可感知程度排序的 P0/P1/P2 清单、证据种类标注、以及"已解决的基础交互默认不创新"这一硬约束；每条修复必须用真实 Electron 或对应门禁证明。
- [UI/UX 架构变更候选清单 2026-09-28](decision/ui-ux-architecture-candidates-2026-09-28.md)：只在用户授权下才考虑改/新增架构；每条的形态是"证据 → 为什么现有架构补不上 → 最小变更 → 成本与风险 → 否决后的替代"，全部为提案、未实施。
- 论文材料：论文正文、图表和复核材料的范围及提交前边界见 `docs/paper/README.md`，正文源稿为 `docs/paper/littlesheep-thesis.md`。**这两份是本机材料、未纳入版本库**（`git ls-files docs/paper` 为空），因此这里只给路径而不做文档链接——链接会让仓库门禁依赖不存在于版本库中的文件。

## 文档冲突规则

1. 长期使命与硬约束：以架构原则为准。
2. 当前实现与验证数字：以项目状态和源码测试为准。
3. 下一阶段顺序：以架构决策报告为准。
4. 具体阶段验收：以对应任务书为准。
5. 目录和模块归属：以仓库指南为准。

发现冲突时先修正文档责任边界，不通过复制一份新的总结来规避冲突。
