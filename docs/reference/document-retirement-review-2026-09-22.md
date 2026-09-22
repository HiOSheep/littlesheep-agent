# 文档退役审查记录 2026-09-22（已执行）

最后更新：2026-09-22 23:05:46

本文件记录 2026-09-22 对 `docs/reference/**` 与 `docs/taskbooks/**` 的一次集中审查：先由实现者直接退役证据充分的文档，其余逐条列出、经用户批准后执行。每条给出**结论、执行动作与更正后的证据**；证据与本文件最初版本不一致的地方已明确标注更正。

## 〇、证据更正（重要）

本文件最初版本中的三条证据在复核时被推翻，退役结论随之改判：

1. **第 2 条**原写“P6 没有完成标记”。实际 `state-machine-redesign-taskbook-2026-09-18.md` 的 P6a–P6d 都带 ✅（整项状态为“四项全部结项”）。**改判依据变为**：即使按 ✅ 结项，其取证对象多数已被此后的实现删除或改义。
2. **第 3 条**原写“阶段 5 = 任务级内循环提速、长期暂停”。实际任务书的阶段 1 才是任务级内循环（已完成），阶段 5 是状态契约重构（5A–5P 完成，并由暂停审计判定无剩余可证明工作）。**结论不变，理由更正**。
3. **第 4 条**原写“对标记录引用的 10 个 LS 源码路径全部不存在”。实际 9 个源码文件与 1 个常量全部存在且仍在生产路径；该错误来自把 OpenCode 仓库路径与 LS 路径混为一谈并改写扩展名。**该条“依据已失效”不成立，改判为不退役**。
4. **第 5 条**原写“模块图 22 条、仓库指南 7 条失效引用”。实际是检查脚本正则的分支顺序 bug（`ts|tsx` 先匹配短分支）造成的假阳性；两份文档的路径引用事实正确，**真实失效只有 1 条**。

## 一、直接退役（证据充分，无需审批）

按 `docs/README.md` 的退役规则执行：先把仍然成立的事实汇总到拥有它的常驻文档，再 `git rm`，原文留在 git 历史（`git log --follow -- <path>`）。

| 退役文档 | 判定依据 | 事实去向 |
| --- | --- | --- |
| `lean-v2-cache-95-plan-taskbook-2026-09-20` | 缓存目标已由真实长任务任务书接续 | 验收规程（历史口径已移出正文） |
| `harness-lean-audit-taskbook-2026-09-12` | 审计完成；开放项 HL-11 双驱动收敛已于 2026-09-21 落地 | `AGENTS.md` |
| `harness-lean-phase-a/-b/-c-implementation-taskbook` | 前两批交付完成；第三批最终以极简重建落地，原文引用的 `stages/evolve.ts`、`stages/capture.ts` 已不存在 | `AGENTS.md` 核心流程 |
| `harness-rebuild-and-cache-taskbook-2026-09-02` | durable event/inbox/lease/settlement/recovery 均已实现 | 项目状态 |
| `agent-runtime-efficiency-versioning-taskbook-2026-07-17` | 自述已完成，且已注明最新状态以项目状态为准 | 项目状态 |
| `reference/harness-rollout-readiness-2026-09-11` | 原文自标“已被单一驱动取代，不再描述当前行为” | `AGENTS.md` |

## 二、经批准后执行的处置

### 1. 对话任务连续性 P0 专项 2026-08-13 — 保留 + 状态重述

- **复核结论**：不能关闭。运行时的 head/claim/disposition/资源配方/权限重验/副作用幂等机制已随状态机重设计落地并有单元与契约测试；但五层验收中的“回答连续”、真实 PDF 交付、P0-E2E-001 真实验收、发布指标门、只读迁移扫描与回滚演练都没有证据。同时任务书赖以成立的故障链（`classify` 调模型 → `ask_user` → 存 `waiting_user` → 下一条消息被当作新任务）在当前架构中已不可复现：生产代码不再产生新的 `waiting_user` 检查点。
- **执行**：在任务书头部加入 2026-09-22 复核边界（已关闭项与未关闭项逐条列出，优先于其 §15 的“全待开始”状态表）；机制层事实汇入 [Core Flow 状态契约](core-flow-state-contract.md) 的“会话续接”一节；`docs/README.md` 的索引注记同步改写。
- **后续**：关闭该专项的正确动作是按当前单主循环架构逐条重述并补发布级验收，不是重新实现旧的等待用户链路。

### 2. LS 状态机重设计任务书 2026-09-18 — 退役

- **复核结论**：P6a/P6b 已被后续决策覆盖，P6c 的审计对象（`request_task_book`、`workPolicyUpgradeProposal`、`bounded_loop_promoted`）已随第二执行体系删除，P6d 的记忆写入被压缩路径取代且派生出一个无归属缺口。
- **执行**：退役；P1–P7 的机制事实已在项目状态与 `AGENTS.md` 中，工作策略升级通道与等待头兼容路径两条事实新增到 `AGENTS.md`（本地未跟踪的维护说明，不进入版本库，不能作为可点击链接）与 [Core Flow 状态契约](core-flow-state-contract.md)；派生缺口转入新建的[持久记忆写入路径任务书](../taskbooks/memory-write-path-taskbook-2026-09-22.md)。

### 3. LS 开发反馈环提速任务书 2026-08-09 — 退役

- **复核结论**（理由已更正）：阶段 0–4（计时基线、任务级内循环、affected 选择器、消除重复入口、接入日常流程）与阶段 5A–5P（`allowedTransitions` 唯一 manifest、RunContext ownership、Runner coordinator 抽取）全部落地且仍被生产代码引用，并由 `repository-guide.md`、项目状态与 Core Flow 状态契约常驻收录；阶段 5 的暂停审计已判定无剩余可证明工作，唯一残留的 full gate 资源竞争由 `maxWorkers: 3` 与后续全量门通过证据关闭。
- **执行**：退役，未新增事实（常驻文档已完整覆盖）。

### 4. OpenCode VS Code 对标记录 2026-08-13 — 不退役（改判）

- **复核结论**（证据已更正）：它引用的 9 个 LS 源码文件与 `WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY` 常量全部存在且仍在生产路径；记录本身是外部对标与许可证归属的常驻参考，不是过期任务书。
- **执行**：保留。其中仍然成立的设计原则（单一 Monaco、文件树唯一入口、缓存字节预算、审阅数据流、临时态/持久态分类、行内键盘导航、评论能力边界、体积纪律）暂未转写进应用层 UI/UX 任务书——用户明确要求本轮不动该清单，因此**待办**：需要时再落入 UI/UX 任务书，之后再决定是否按“事实已转移”退役。

### 5. `module-split-map.md` 与 `repository-guide.md` — 更新（已执行）

- **复核结论**（数量已更正）：不存在 22/7 条失效引用；真实失效只有 1 条。
- **执行**：`module-split-map.md` 的 `local-app-api-server-shutdown.ts` 更正为现名 `packages/app/src/main/http-server-shutdown.ts`，并把该行语义从“实例级资源清理”改写为“HTTP server 优雅关闭（`closeHttpServer`，含 750ms 强制断连）”；同表 `runtime-contracts.ts` 行数按实测更正为 922。`repository-guide.md` 无需改动（其“需求类型 → package”入口无一改名）。

### 6. 实时网络检索与安全读取任务书 2026-08-28 — 退役

- **复核结论**：WB-01～WB-08 的完成门全部有代码与定向测试证据；WB-09 未闭合的部分全部是外部前置条件（无测试 key、本机 Fake-IP DNS、正式渠道凭证、代码签名证书），继续挂“实施中”不会推进任何实现。
- **执行**：退役。[网络检索冻结契约](web-retrieval-security-contract.md) 的状态行与执行入口改指验收报告与发布清单；[网络检索安全合并验收](web-retrieval-security-acceptance-2026-08-29.md) 新增“已接受缺口”一节，如实记录两项只有清单、没有实现的建议项（检索运行事件未映射、检索质量指标未实现），避免退役后失忆。

### 7. 两份被门禁固定为常驻的任务书 — 解除一份固定

- **复核结论**：`agent-runtime-continuity-taskbook-2026-07-14` 确有未完成项（外部系统副作用与真实网络故障、非字段事实连续性、Pro/其它 Provider 模型专用校准、数据根迁移真实场景、阶段 7 效率评测），保留；`memory-atom-vector-catalog-taskbook-2026-07-17` 的设计事实已全部落在架构原则、Core Flow 指南、`packages/memory-tree/README.md` 与项目状态中，仍开放的只是长期真实负载/Provider 质量门（已由项目状态与架构决策报告跟踪）。
- **执行**：从 `scripts/check-repository-hygiene.mjs` 的 `required` 列表移除并退役该任务书。**注意**：它的“已完成首版工程闭环”措辞与当前实现不符——模型提案类合并/重组/修订/纠正与非叶子子树移动、daily 提升目前只有契约、校验与边界测试，runtime 没有调用方；该事实已在 [memory-tree README](../../packages/memory-tree/README.md) 中记录，并由新建的[持久记忆写入路径任务书](../taskbooks/memory-write-path-taskbook-2026-09-22.md)承接后续裁定。

## 三、本轮退役清单汇总

任务书 4 份：`state-machine-redesign-taskbook-2026-09-18`、`development-feedback-loop-taskbook-2026-08-09`、`web-search-and-safe-retrieval-taskbook-2026-08-28`、`memory-atom-vector-catalog-taskbook-2026-07-17`。连同上一批（任务书 7 份 + 参考 1 份），两批合计退役 12 份。

保留并更新的：对话任务连续性 P0 专项（头部复核边界）、OpenCode 对标记录（不退役）、模块拆分地图与仓库指南（1 条真实修正）。新建：持久记忆写入路径任务书。门禁变更：`required` 列表减少 1 项（`memory-atom-vector-catalog`）。
