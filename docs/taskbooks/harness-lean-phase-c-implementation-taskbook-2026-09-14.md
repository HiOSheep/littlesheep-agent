# Harness 瘦身第三批实施包：HL-08/HL-09 与配套 HL-07/HL-10 · 2026-09-14

最后更新：2026-09-14 10:28:47

状态：设计完成，第三批生产代码尚未实施；不代表性能达标、默认策略切换或发布批准。上位：[全面审计任务书](harness-lean-audit-taskbook-2026-09-12.md)；前置：[第二批实施包及第 12 节交付记录](harness-lean-phase-b-implementation-taskbook-2026-09-13.md)。

## 1. 本批要解决什么

**普通任务可靠完成后不再独立做自动语义学习；真正需要压缩时，同一次提炼生成续跑摘要和有界长期记忆候选。** 减掉重复模型工作，不删除保证正确性的状态机，不以失忆、晚一轮才生效的记忆指令或隐形后台费用换取表面提速。

本批承接总任务书 D 阶段，并纳入使该迁移成立的 HL-07 收尾关键路径子集。实施包编号 phase-c 不等于总任务书 C 阶段。

| 总任务 | 本批纳入 | 本批不做 |
| --- | --- | --- |
| HL-08 | 原始来源可达、显式记忆指令、统一压缩提炼、幂等提交与逐任务沉淀退出 | 逐 run 后台 EVOLVE、通用学习队列、重新设计整棵记忆树 |
| HL-09 | 压缩前后连续性、实际请求前缀差分、消除已证实的重复上下文工作 | 承诺固定缓存命中率、第二套 ContextEngine、默认向量注入 |
| HL-07 子集 | 压缩 admission/生命周期、result 前 await 分类与有恢复保障的后移 | 全面 workspace 缓存、worker 池、无测量的预扫/并发改造 |
| HL-10 子集 | 压缩跨存储、停止/恢复、旧协议、权限与新消息竞态 | 宣称所有未来驱动迁移均已验收 |
| HL-12 子集 | 本批受控回归、桌面功能证据及独立性能门 | 自动启动收费基准、灰度、正式发布 |

HL-11 双驱动收敛/删除继续后置。HL-07 其余准备优化只有 trace 证明是主要瓶颈才另立小包，不绑入本批。第二批真实 Provider 30× 配对性能仍未验收，不影响设计和隔离离线实施，但不能被本批测试“补写通过”。

### 1.1 已复核的源码事实与风险

以下是 2026-09-14 工作树静态事实，不是本次新的性能测量；实施前 C00 需重新核对。

| 入口 | 现状 | 必须处理的边界 |
| --- | --- | --- |
| `packages/harness/src/stages/evolve.ts` | adaptive/always/never 控制模型调用；同时处理 memories、corrections、revisions、reconciliation、树治理及 createSkill | 不能整体禁用后丢失用户明确请求；自动学习与显式操作要分流 |
| `packages/harness/src/stages/capture.ts` | `llmEnabled=false` 仍经 intent gate 创建 deterministic daily atom | 原始留痕不等于 daily atom；只关 LLM CAPTURE 并未退出逐任务派生 |
| `packages/runner/src/runner-finalize.ts` | 来源采集、反馈、activation、finishRun 后 await `compactSessionAfterRun`，然后装配 result | 必须先分类可靠性前置项与可重建派生项，不能整个 finalize 后台化 |
| `packages/runner/src/session-continuity.ts` | 使用可变 ctx/run signal；模型只返回 summary，再登记摘要并 consolidateDailyMemory；错误主要记 warn | 不是同次摘要+候选提炼；现有 partial failure 不代表已有跨存储可恢复事务 |
| `packages/session/src/compaction.ts` | 按未压缩消息数 threshold 或 force 触发；提供 coveredMessages/new messages；保留原始 JSONL | 可复用增量区间；压力判定、快照一致性和摘要前驱需补齐，不能把 task-end 当触发理由 |
| `packages/session/src/manager.ts`、`compaction-store.ts` | commit 有文件锁、pending journal、摘要投影恢复；当前 pending 只含 summary，提交未校验预期前驱/覆盖源版本 | 锁防同时写不等于 CAS；旧 proposal/recovery 仍可能覆盖更新摘要，候选进度尚不在该事务中 |
| `packages/memory-tree/src/memory-service/source-feedback.ts` | 已有 immutable source capture/list；v3 以外返回空结果 | 不可声称“存过源记录”便等于短会话可导航召回；逐 backend 明确支持/拒绝边界 |
| `packages/runner/src/runner-persist.ts` | next 的 execution log 等必需持久化是发布前置 | 原始事实、effect、权限与回复登记不得因瘦身变成 best effort |

`session-continuity.ts` 当前对消息正文/工具输出按字符截断（4000/1200），并用 `session-summary-fidelity.ts` 补关键值。本批保留 fidelity 防线，但必须显式区分“覆盖的原文范围”和“模型实际看见的证据”，不能因存在 sourceHash 就宣称摘要完整。

### 1.2 不变原则

- Harness state controls execution. Runtime activity explains execution. Renderer projects activity, not state.
- 原始会话、执行/effect/权限证据是事实源；summary、atom、索引是有来源的派生表示，不互相冒充。
- 自动提炼只在实际上下文压力或显式压缩发生；普通任务结束、退出/重启、daily 数量增长本身不触发模型学习。
- 明确“记住/纠正/忘记”是当下的用户任务，按现有权限和写入闸门即时处理；不等压缩，也不增加每轮记忆分类模型。
- 复用既有 session store、MemoryService、intent gate、事件和账本。允许最小的版本化压缩事务扩展，不另造第三套 Harness、通用 EventBus、后台任务平台或事实库。
- 不改用户模型/推理档位，不以关推理、缩短产物、隐藏 tokens 或牺牲验证降低成本。截图中的 TPS/命中率不能独立证明本地瓶颈。
- 本文中的合同字段和小包名是设计语义，不声称已经存在同名 API。实施时优先扩展已存在 owner，提交前交代新字段消费者和旧数据兼容。

## 2. 实施顺序与停止点

| 小包 | 目的 | 前置 | 独立交付点 |
| --- | --- | --- | --- |
| C00 | 固定第二批完成态、触发/await/请求基线 | 第二批交付记录 | 源码及构建身份、归因表、连续性 oracle |
| C10A | 先建压缩故障与并发反例 | C00 | 可控 Provider、存储故障、两 writer/旧 owner 夹具 |
| C08A | 未压缩来源可回查，显式指令不依赖自动 EVOLVE | C10A | 短会话重启/跨会话与记住/纠正/忘记门通过 |
| C08B | 一次压缩提炼 summary + candidates | C08A | 有界、可校验、可恢复重放的 proposal |
| C08C | 摘要与候选跨存储幂等提交 | C08B | 前驱 CAS、部分失败日志、撤销防复活 |
| C09 | 压缩上下文连续性与实测前缀减法 | C08C | 请求差分、覆盖/回查证据、缓存诚实对账 |
| C07 | 压力触发与独立生命周期、关键路径调整 | C08C、C09 | 不把每轮卡顿搬到下一轮，不丢可靠结算 |
| C08D | 切换新策略，退出逐任务自动沉淀 | C08A～C07 全部通过 | 普通轮前台/后台自动沉淀模型数为 0 |
| C10B | 生产链恢复/权限/活动与总账回归 | C08D | 完整 HC 矩阵及旧数据适配 |
| C12 | 构建、隔离桌面、文档和性能分层交接 | C10B | 分门结论，不用源码测试替代产品验收 |

顺序中的每包先写失败用例，再改生产入口。**C08A 未通过，不得删除自动 EVOLVE/daily fallback；C08C 未通过，不得把压缩脱离 run 生命周期；C10B 未通过，不得默认接纳新策略。** 若 C09 没有发现可量化冗余，交付差分与连续性测试即可，不为凑改动增设缓存。

## 3. C00 / C10A：基线与先行反例

### C00 · 可复现基线

入口：第二批第 12 节、Runner finalize/persist、session continuity、context preparation 与 HL-03 请求账本。

1. 保存 Git HEAD、tracked diff、新增源文件清单及 hash、锁文件、Node/pnpm/Electron 版本、build input/output digest。当前 `6a4e5f996bb9` 是早期检查点，不是单独可复现的第二批完成态；不能遗漏 dirty/untracked 文件。
2. 对 respond、bounded-loop、TaskBook、失败/中止、显式记忆、软/硬压缩列实际 purpose 序列。分开 EVOLVE、LLM CAPTURE、deterministic daily、source capture、summary、daily consolidation，不把本地工作记成模型调用。
3. 逐项列 result 前 await：owner、输入来源、是否权威、失败语义、冷/热耗时、可否重建、后移所需恢复记录。没有恢复设计的项继续保留。
4. 固定合成事实集与独立 oracle：目标/约束/关键原值、A/B 项目同名不同值、权限拒绝、未完成任务、产物路径、纠正及忘记事件。测试源不含用户私有记忆、真实凭证或生产日志正文。
5. 给出实际上下文压力来源、历史窗口与预留输出/工具预算；消息数只能是扫描预筛选/兼容参数，不能代替 token 压力结论。记录模型窗口和计数未知的处理。

C10A 扩展 `packages/session/src/compaction.test.ts`、`compaction-store.test.ts`，以及 Runner/Memory 集成测试。故障点最少覆盖：模型响应已返回但 proposal 未持久化、proposal 持久化后、摘要提交后、候选部分提交后、来源登记后未 ack、旧 owner 恢复时。使用进程级崩溃和重开真实临时存储补充 mock；生产 API 不暴露测试注入开关。

完成条件：这些反例在旧行为下能指出真实缺口；不得先改断言把旧缺口合理化。所有后续小包沿用同一 HC 编号与合成数据。

## 4. C08A：先保证不失忆和显式指令

入口：`conversation-source-records.ts`、`conversation-source-store.ts`、MemoryService/source-feedback、已有 run/resource resolver 与记忆树导航；`stages/evolve.ts` 及其 correction/revision 子模块、memory intent gate。

### 4.1 原始留痕与检索分开

- 继续可靠保存原始会话/来源标识/证据。列明 session JSONL、conversation source store、execution log 各自保存什么，不复制整套历史作为新检索库。
- 经现有资源分支提供有界 session/run/source 目录，再按 source refs 展开；跨会话必须先定位分支/作用域，不允许默认全历史或全树正文进入 prompt。
- 短会话从未产生 summary/long-term atom，仍须在关闭应用、重启及另一会话获准回查时找到 oracle 事实。只有 `list(sourceRefs)` 能读已知 id 不足以通过“可发现”验收。
- 来源索引可重建时，权威原文与重建水位/待补记录必须先 durable；索引失败公开为检索降级，不静默声称记住。当前 catch/warn 路径逐一确认 owner；无可靠补偿则不能后移/忽略。
- 索引有 scope、授权校验、分页与预算；首次回填分批，取消可续，不启动全盘扫描/模型/embedding 洪峰。外部工作区未批准不得扫描。
- v3 及仍受支持 backend 分开测；不支持新协议时保留旧数据只读/安全恢复或明确拒绝接纳，不用返回空数组伪装可用。

### 4.2 用户指令与自动学习解耦

- 用既有活动路由、工具/intent 执行入口处理显式记住/纠正/忘记，复用必要的语义解析与闸门；不使用“匹配记住两字即写库”的捷径，不新加所有任务必经的分类调用。
- 在独立移除 EVOLVE 之前，为 memories、corrections、revisions、reconciliation、hierarchy/subtree 与 createSkill 建职责去向表：用户明确请求走受控执行；自动长期候选仅在压缩生成；自动复杂树治理/Skill 文件生成本批不追加到压缩请求。没有迁移证据的明确能力不能随 stage 一起消失。
- 模型候选不直接设置 authority/验证通过。Runtime 根据用户指令、原始来源、scope 和独立 evidence 决定可提交范围；跨项目不能因名字相同合并。
- “忘记”默认是阻止活跃记忆/自动召回使用的撤销，不假称已经物理擦除原始审计。物理删除/外部 Skill 文件删除按独立权限、引用和恢复规则处理。
- 撤销/纠正版本必须约束 atom、summary 注入和原始来源召回，而不只是阻止创建同一个 atom id。旧原文存在不等于可再次作为当前有效偏好使用；用户再次明确授权记住才可产生新的有效版本。
- 回执只能根据真实 commit 结果由 LLM 组织；未提交不能提前说“记住了/忘记了”。失败用 Runtime 状态说明，不用固定 Agent 文案兜底。

交付：职责去向表、来源/索引 owner 表、HC-02/03/04/11 通过，证明普通留痕不依赖 deterministic daily atom。

## 5. C08B / C08C：统一提炼与可恢复提交

### 5.1 最小合同与 owner

| 事实 | 唯一 owner / 持久化位置 | 必要内容 |
| --- | --- | --- |
| 压缩输入快照 | SessionManager 读取/锁边界 | session、前驱 summary、源起止 id、覆盖 hash/版本、最近保留后缀、授权/策略版本 |
| 模型 proposal | 扩展既有 compaction pending journal | schema 版本、稳定事务 key、摘要、候选、证据可见性/缺口、request id、用量与校验结果 |
| 有效摘要指针 | session metadata + compaction projection | CAS 结果、覆盖区间、lineage、可读版本，不能由 Renderer 决定 |
| 候选结果 | 既有 intent gate / MemoryRepository，journal 引用回执 | candidate 稳定 key、commit/rejected/superseded/pending、atom/revision、理由 |
| 撤销及纠正 | 现有 memory correction/tombstone 合同 | 实体/scope、版本、来源；提交与重放都读取最新状态 |
| 活动/成本 | 现有 Runtime event 与 token ledger 扩展 | operation/session/request id、cause、活动终态、usage 可用性；不复制事实账本 |

事务 key 至少由 session + 本次新增覆盖区间/hash + 前驱摘要 + policy version 确定，重试不随机换 key；候选 key 绑定同一 proposal 的规范内容与来源，防止部分成功后重复创建。Source/摘要完整性 hash 由 Runtime 计算，不信任模型回传。具体新增字段先补 codec，旧版本必须有明确读取策略。

### 5.2 同次提炼，不再追加 EVOLVE

- 在一致快照上选取新增原始消息/必要 evidence + 前驱摘要。正常一包、一次成功请求返回 `summary` 与可为空的 `candidates`；schema 只含续跑与写入闸门需要的信息。
- 摘要保留目标、硬约束、精确关键值、已做/未做事项、产物/source refs 和权限结果；不把思考过程、模型意图或工具准备态写成已完成事实。
- 候选包含有界正文、来源 refs、scope/parent 建议、持久价值理由及置信信息；Runtime 校验来源属于快照、证据是否完整、权威/分支/冲突是否允许。摘要不是长期规则，模型 confidence 不是证据。
- 历史文本和 Web 内容是数据，不能指挥 Memory 写入。保留 `external_untrusted`/truncated/blocked 等边界；网页全文、凭证及内部诊断不得被带入长期候选或公开投影。
- 超预算时先减少非关键长输出并保留完整性标记/可回查引用；仍放不下则按可证明的源边界有界分包。每个包具有真实覆盖水位，不能把未读/静默截断部分计为已完整提炼，也不为每包再跑无条件总结模型。
- 初始 decode/schema 预算最多 2 次总尝试（含首次），复用现有重试归因；token/时间/分包总预算在 C00 固定，重启不能刷新耗尽预算。超出能力保留原文/旧摘要，明确等待或失败，不无界缩摘要重试。
- proposal 持久化后，单纯写库/登记失败只重放既有校验结果，禁止重新调模型“再想一次”。响应未持久化即崩溃可能无法避免重复推理费用，须如实标为已发请求的结果/用量未知；不承诺网络请求 exactly-once。

### 5.3 提交流程和并发

顺序固定为：来源可靠存在 → proposal 校验并 durable → 锁内检查源版本/前驱并提交摘要 → 幂等登记来源/提交候选 → 保存逐项回执 → 关闭 pending。有效摘要与待补候选允许分阶段成功，不能把候选部分失败伪装成“记忆全部完成”。

- 读快照时与 append/summary writer 保持一致；提交 CAS 不仅检查存在文件锁。允许仅追加的新消息作为未压缩后缀保留，但须证明覆盖前缀未改且 summary 前驱未变；若做不到，只能判 stale 并重新 admission。
- 两个 compactor 对同一前驱竞争，最多一个激活；落败 proposal 不提交候选、不能覆盖新摘要。恢复 pending 同样检查前驱/覆盖关系，不能按随机文件名顺序把旧摘要写回去。
- 摘要成功后候选失败：新摘要可用，候选 pending 可恢复；登记失败保留待补状态。gate 拒绝或被新纠正 supersede 是有理由的终态，不应永远重试。
- 候选提交前及每次重放复核最新权限/scope、纠正/tombstone 与来源状态。生成后用户忘记/改值时，旧候选无权复活原事实；新权限拒绝不能用旧 admission 绕过。
- 单 session 在现有 owner/锁机制上限制一个有效压缩写者，跨进程也成立；锁只覆盖快照/提交临界段，不跨网络请求持有。旧 owner/lease 不能提交，已有安全提交结果可由新 owner 对账。
- 冲突、坏 journal、未知版本、旧 source 消失均保留可审计失败/隔离状态，不清空原文、删掉旧摘要或回到旧路径重跑工具。原始工具 effect、inbox、reply settlement 不属于压缩重放内容。

交付：事务版本/迁移表、各崩溃点后的唯一可见状态、HC-05～10/12/13。无需建立跨全部存储的分布式事务；必须证明现有 journal + 幂等回执足够恢复。

## 6. C09 / C07：上下文与等待位置的减法

### C09 · 只消除有证据的上下文冗余

入口：`packages/harness/src/context.ts`、`system-prompt-transcript.ts`、`packages/context/src`、Runner `cache-observation-runtime.ts`/`cache-observation-key.ts`、summary fidelity 与 continuity。

1. 对同任务/同模型/同权限的实际发送请求做脱敏分段 hash 和差分，列变化原因：policy/tools、SOUL/USER、根索引、summary、history、工作区/权限、动态 run 事实。诊断不得导出私有正文。
2. 稳定前缀只复用真正不变部分；保持语义顺序、用户当前指令、精确工具 schema 和最新权限。时间/资源变化照实更新，不能冻结错误信息换缓存命中。
3. 复用同一最终 request 进行 budget/投影/观测；若有重复精确 tokenization 或序列化，测 CPU/耗时后合并。复用 key 必须含全部相关 revision，失效覆盖模型/tokenizer/tools/SOUL/USER/权限/scope/summary 与来源撤销。
4. 历史窗口收缩后关键事实经摘要或按需来源导航可达；同名跨项目、冲突、修改/忘记、后缀新指令、超长工具结果以及 summary 无法支持时的回查均通过独立 oracle。
5. Provider cache 未提供就是未知；cached read/write/miss 不混用，正常压缩改变前缀导致命中降低不一定是 bug。以完整输入/输出、费用、总耗时和连续性比较，不以单项命中率判胜。

### C07 · 压力触发，不把卡顿搬到下一轮

- 在现有上下文准备/admission 边界计算实际压力：输入预算加必要工具/输出余量。软阈值允许可取消的提前压缩；硬阈值必须在下一次超预算模型 dispatch 前取得可用摘要或明确返回可恢复限制，不能默默裁掉硬约束。
- 普通 run 收尾最多产生有因果的压力检查，不再因为“任务结束”直接要求提炼。显式压缩也要有新增可压缩区间；无新范围不调用模型。
- 操作绑定不可变快照及独立 operation id、资源预算和 signal；不得把已完成的可变 RunContext 捕获进后台闭包。复用已有请求计量/生命周期能力的最小接口，禁止伪造普通 Agent run 才能记账。
- 初始限制：单 session 单 flight，自动软压缩全局并发上限 1；多个压力通知合并为同一待处理范围，不每次 run 排新任务。显式/硬等待复用同 session 已在处理的有效范围；不能无限排队。
- 用户活跃模型工作优先；软压缩无资源就延后。硬等待有 deadline、可取消反馈；同 session append 不被整个网络请求锁住。不同 session 大型压缩不得拖垮主进程/Renderer；C12 测 next-send 与拥塞样本。
- stop/abort 取消所属等待与未提交模型工作，不再派发新尝试；应用关闭取消未完成请求。已 durable proposal 的本地提交/对账按最新权限及所有权继续或留 pending；重启只重放已存结果，新的模型请求必须重新满足压力/显式 admission。过期 run signal、UI 订阅和活动不可复活。
- 审计、原始来源、effect/权限和唯一回复 settlement 仍是权威完成前置。只把可重建派生工作在有 durable 水位/恢复后后移；显式记忆任务的目标 commit 不得后移到该任务的“成功”之后。
- 当后台压缩发生在 run done 之后，cost/activity 归属 session 的压缩操作，独立显示并纳入总账；不改写旧 run 的可靠完成时间，不虚构其新 reasoning，也不把费用漏掉。为该操作关闭/失败提供终态与历史投影。

运行界面继续只投影真实活动：实际等待/压缩/保存才显示对应 Runtime activity；真实 reasoning/text/tool arguments 继续原语义，tool_preparing 不等于 tool_started。毫秒级内部阶段可不发 UI 行；不要新增 `EVOLVE → 正在学习` 的机械映射。

交付：触发决策表、生命周期/取消 owner、result 前 await 前后对照、HC-01/09/14～17/19；软/硬阈值与资源上限需说明测量依据及回退条件。

## 7. C08D：最后才退出旧自动沉淀

入口：Harness default/durable driver 的已有策略接线，evolve/capture、Runner config/codec/finalize、`packages/config/src/schema.ts`/`defaults.ts`。

- 对新接纳且使用新版本策略的普通 respond、bounded-loop、TaskBook 统一执行：独立自动 EVOLVE=0，LLM CAPTURE=0，逐任务等价后台学习=0；不再依靠 per-run deterministic daily atom 作为连续性前提。
- 保留无 LLM 的原始事实/有界来源登记、必要反馈与可靠结算。旧 daily atom 仍可按原 scope 查询，不批量删库、不默认全历史重提炼；已有 consolidation 与新 candidate pipeline 去重，不能两个入口再次晋升同一证据。
- `llmEvolve`、`llmCapture` 的旧配置列兼容真值表：旧 run 按持久化协议续完，新 run 由明确版本化策略决定自动行为；不凭读取旧 `always` 就暗中恢复逐任务学习，也不把用户明确记忆/Skill 请求禁掉。未知策略不猜测降级。
- 必要时复用现有策略合同做最小 schema 版本扩展，不添加 display/next/shadow/lean/learning 多重布尔组合。切换只影响新 admission；已开始/unknown effect 的 run 不迁移协议，不重做业务工具。
- stage ID 和历史 codec 先保留；新策略里无需模型工作的 stage 可确定性跳过，不要求新增 UI 行。删双驱动/统一所有 stage 归 HL-11；本批仅同步受影响主流程/配置的当前事实说明，不提前写“旧实现已删除”。
- 回退停止新策略接纳，已生成 proposal 按原版本完成/隔离恢复；不删除新 journal/atom，不用旧 EVOLVE 重做已处理范围。降级版本若不识别新 pending，应拒绝写该 session 并说明恢复要求。

交付：策略/config/旧 checkpoint 对照表、退出前后请求 purpose 断言、显式功能迁移证据。只有删除调用点而没有 HC-01～04/18 证据，不算完成。

## 8. C10B：验收用例矩阵

每个 HC 必须记录测试路径、fixture/断言、实际命令、结果和仍未覆盖的边界；覆盖数量不能替代下列语义。

| 编号 | 场景 | 核心断言 |
| --- | --- | --- |
| HC-01 | 未达压力的连续普通任务，含 respond/bounded/TaskBook | 前台与后台自动学习请求为 0；源/effect/回复完整；不生成逐 run 等价学习队列 |
| HC-02 | 无 summary/atom 的短会话，重启与另一会话回查 | 可经 root→branch→expand 发现事实；不全历史注入、不越 scope |
| HC-03 | 记住→立即追问，未达压缩阈值 | 真实 commit 后才确认；解析/权限/写入失败不假成功 |
| HC-04 | 纠正/忘记，跨重启及压缩重放 | 旧 atom/summary/源召回均不再表达旧事实有效；显式重授权有新版本 |
| HC-05 | 普通一次压缩、无长期候选 | 一次成功请求同时提炼；空 candidates 合法；没有追加 EVOLVE |
| HC-06 | 巨大消息/长输出/特殊 Unicode/精确标识 | 预算有界、真实覆盖水位、关键值不静默丢失，超限可恢复失败 |
| HC-07 | 模型超时、坏 JSON、schema/来源不合法 | 有界尝试且归因；旧摘要/原文保留；无候选越权提交 |
| HC-08 | proposal 后、summary 后、候选提交部分时崩溃 | 真实存储重开后重放同一 proposal；无重复 atom，无写库失败重调模型 |
| HC-09 | 压缩时 append 新用户目标/消息 | 未压缩后缀完整；无旧快照吞消息，下一请求消费最新目标 |
| HC-10 | 双 writer、旧 pending 晚恢复、lease 失效 | 同前驱仅一个激活；旧 writer 不覆盖新摘要/提交候选 |
| HC-11 | A/B 项目同名、外部受限路径、撤销权限、Web 注入 | 无跨 scope 合并/读取，无未批准扫描，无 external 指令变长期规则 |
| HC-12 | 提炼期间纠正/忘记，随后重启 | latest revision/tombstone 胜过旧 proposal；无换 atom id 复活 |
| HC-13 | 来源/索引/summary 注册失败，坏 journal | 权威失败和派生降级分开；可恢复水位不丢；无假“全部保存” |
| HC-14 | 软压力、硬上限、无新增区间、并发 session 拥塞 | 无重复排队，无新范围不调用；硬 dispatch 不超预算；活跃任务不饿死 |
| HC-15 | stop/abort/关闭、重连、旧事件迟到 | 旧活动闭合、不派新请求、不改新 run；已存 proposal 仅安全对账 |
| HC-16 | run done 后压缩、用量未知、部分调用失败 | 压缩费用归 operation/session，总账守恒；未知非 0，不回写旧 run TPS |
| HC-17 | history 收缩、压缩后继续产物任务、前缀变化 | 独立 oracle 通过；cache 口径正确；不冻结最新配置/权限 |
| HC-18 | 旧配置/checkpoint/daily/journal 及不支持 backend | 按版本读取/拒绝，旧业务 effect 不重做，不批量破坏迁移 |
| HC-19 | 隔离 Electron 实时/历史、Normal/Compact、压缩取消 | 真实活动同一投影、无假 reasoning/永久 Running、可靠 done 不提前 |
| HC-20 | 第二批升级/预算/reply 与原 effect/lease/inbox 回归 | 零重复副作用、零重复权威回复、零已接受消息丢失、安全边界不退化 |

## 9. C12：命令、性能与交接门

### 9.1 先验证源码契约

以下为已存在的起跑入口，不代表覆盖所有新增 HC。新增用例优先落入对应模块；若拆出新测试文件，应补到实际运行清单而不是只跑旧测试。

```powershell
pnpm exec vitest run packages/session/src/compaction.test.ts packages/session/src/compaction-store.test.ts packages/session/src/lock.test.ts packages/memory-tree/src/conversation-source-store.test.ts packages/memory-tree/src/memory-consolidation.test.ts packages/memory-tree/src/memory-correction.test.ts packages/memory-tree/src/memory-correction-backend.test.ts packages/memory-tree/src/memory-service.test.ts packages/memory-tree/src/memory-service-v3.test.ts
pnpm exec vitest run packages/harness/src/stages/memory-stages.test.ts packages/harness/src/stages/evolve/correction.test.ts packages/harness/src/conversation-source-records.test.ts packages/harness/src/context.test.ts packages/runner/src/session-summary-fidelity.test.ts packages/runner/src/session-summary-revocation.test.ts packages/runner/src/session-compaction-scheduler.test.ts packages/runner/src/compaction-operation-store.test.ts packages/runner/src/memory-v3.integration.test.ts packages/runner/src/runner-continuation.test.ts packages/runner/src/run-checkpoint-controller.test.ts packages/app/src/main/local-app-api/session-routes.test.ts packages/app/src/renderer/chat/context-projections.test.ts packages/app/src/renderer/sidebar/session-actions.test.ts
pnpm run check:repo
pnpm run verify:core
pnpm run verify:full
pnpm run verify:electron-ui-state-continuity
pnpm run verify:electron-continuity
pnpm run verify:harness-paths:offline
```

> 第二十七轮起，新增/触及的测试文件已全部并入上面的实际运行清单（`lock`、`memory-service*`、`context`、`session-summary-revocation`、`session-compaction-scheduler`、`compaction-operation-store`、`session-routes`、`context-projections`、`session-actions`）。最后一条是真实 30× 配对前的**离线自检**，不需要密钥；真实运行 `pnpm run verify:harness-paths` 仍需预算与密钥授权。

这些命令在实施阶段分包执行，本次任务书设计不运行全量代码/桌面门。跨 Harness/Runner/Session/Memory 公共契约修改至少过 core；最终候选 full 后，在相同 fresh build 上跑两条 Electron 生产路由。现有 Electron 脚本需补 HC 压缩操作/恢复场景或增加有界专用脚本；旧脚本通过不能自动证明新场景通过。

使用隔离数据根、临时合成文件与受控本地 Provider。任何 `deepseek`/真实 Provider 脚本先确认是否收费及密钥/预算授权，不能因名字包含 verify 就自动运行。不要启动用户真实桌面清理历史 checkpoint、迁移生产记忆或把私有记录复制到仓库。

### 9.2 两种比较，不混淆结论

- **受控功能/本地性能：** 固定 Provider 分片、慢请求和存储延迟，测本地首反馈、SSE→paint、可靠完成、下一次发送、软/硬压缩等待、主进程/Renderer CPU、峰值内存及队列上限；确认流式不是结算后才绘制。沿用总书热启动 P95≤200ms、receive→paint P95≤100ms 的目标，单次样本不能声称 P95 达标。
- **真实成本/延迟：** 第二批完成态 vs 第三批候选交错配对；每类每策略建议至少 30 次，固定模型/推理/权限/任务质量与冷/热条件。分普通轮、压缩轮、下一轮和多轮总会话，不只统计删掉 EVOLVE 的轮次。含全部重试、失败/中止、压缩/embedding/索引资源成本；Provider 未报数据标未知，费用用已授权并核对的价格口径。

硬门：所有 HC 正确性项通过，数据丢失/未授权/重复 effect/重复权威回复为 0，独立质量/连续性 oracle 不降。性能门沿总书 5% 相对退化预警并结合重复测量噪声；未达样本/预算就标未验收。合并 schema 导致多次解码/压缩变慢时先减 schema、调预算再重测；不能把“调用少了”当成性能自动通过。

### 9.3 分门状态与交付模板

| 门 | 当前状态 | 完成证据 |
| --- | --- | --- |
| 第三批设计 | 完成 | 本文、总书/导航链接、文档检查 |
| 第三批生产代码 | 大部分完成（C00/C08A/C08B/C08C/C08D/C09/C10A 已落地；C10B 矩阵已建；C07 子集已落地，真正后台化压缩未做） | 第 10 节现状、每小包 diff/字段 owner/兼容和 HC 映射 |
| 离线/类型/构建门 | 已执行（`verify:core` 通过；`verify:full` 的 check:repo/tests/typecheck/build 通过；`build:app`/`ensure:app-build` 成功并重算 digest；全量 Vitest、TypeScript、仓库卫生通过） | 第 10.16/10.19 节命令、退出码、覆盖数、真实 build digest |
| 隔离桌面功能门 | 通过（fresh build 上两条主路由 + `compaction_cancel` 场景通过） | 第 10.16/10.33 节 Provider→Runtime→SSE→Reducer→Activity 与恢复证据 |
| 真实 Provider 性能/费用门 | 工具链已离线自检通过（`verify:harness-paths:offline`）；**真实 30× 配对未执行，需预算** | 配对原始指标、汇总、不确定性、失败样本 |
| 默认切换/灰度/发布 | 未执行 | 独立批准、版本 admission 与可验证回退 |

每包交付填写：源码起止身份；改了/没改什么；请求/await 前后表；新增字段 owner/codec/旧数据规则；HC 用例与命令；失败/未覆盖；下一包准入条件。结果文件只保存脱敏的合成事实/指标，不保存密钥或真实会话正文。

本批完成后再讨论 HL-11 驱动收敛和完整 HL-12 发布。若 C00/C12 证明剩余等待在准备阶段而非模型/压缩，再据 trace 启动 HL-07 剩余项，不能用不断扩大第三批替代结案。

## 10. 实施状态与 C00 基线（2026-09-15 工作树复核）

本节记录 2026-09-15 对工作树的静态与测试复核，替代第 9.3 节“生产代码未开始”的旧状态；它不等于 C10B/C12 验收通过，也不构成默认策略发布批准。

### 10.1 已落地范围与计划偏差

工作树中第三批相关改动（相对 `6a4e5f996bb9` 的未提交 diff）已包含：

| 小包 | 状态 | 落点 |
| --- | --- | --- |
| C08B | 已落地 | `packages/runner/src/session-continuity.ts` 用一次 `callLlmForJson` 同时返回 `summary` 与有界 `candidates`；`decodeCompaction` 校验 branch/scope/来源 id/条数；旧纯文本摘要兼容回退，但 JSON 形状而校验失败的响应不再被当作摘要持久化 |
| C08C | 已落地（含 HC-12 撤销屏障） | `packages/session/src/compaction.ts` 计算 sourceHash/lineageHash/transactionKey；`compaction-store-codec.ts` 版本化 v2 pending + memory proposal/outcome；`compaction-store.ts` 幂等提交、重开恢复与终态隔离；`manager.ts` 前驱与覆盖前缀 CAS；`v3-node-store.ts` maintenance 写入复核 tombstone/superseded 来源，拒绝复活 |
| C08D | 已落地（提前） | `packages/config/src/schema.ts`、`defaults.ts` 新增 `memory.autoMemoryPolicy`（默认 `compaction`）；`default-harness.ts` 映射为 EVOLVE `explicit-only` 与 CAPTURE `automaticEnabled=false` |
| C08A | 已落地（第三轮扩展） | 显式记忆/Skill 请求即时路径；有界 session/run/source 目录（catalog→expand）、降级/不支持语义、来源捕获失败公开到 result；HC-02/HC-13 证据见 10.10 |
| C10A | 已落地（第二轮扩展） | 双 writer、snapshot 期间 append、候选持久化；摘要提交后/候选部分提交后恢复、旧 writer 晚恢复隔离、投影冲突隔离、模型失败无残留、manager 重启结算、Runner 从 durable proposal 续结算与来源登记失败重试（见 10.9） |
| C07（部分）/C09（部分）/C10B（矩阵，HC-19 部分通过）/C12（离线+桌面部分） | 部分 | C07 已落地 `SessionCompactionScheduler`（单 session 单 flight、软并发上限 1、通知合并、取消、有界历史、operation 用量记账与跨重启历史），压缩在 result 装配之后执行（result 快照隔离），并提供可选后台软压缩（`sessions.compaction.background`，默认关闭）；C09 已落地脱敏请求前缀差分原语（`request-prefix-diff.ts`），并接入 Runner 的请求快照（`ModelRequestSnapshot.prefixChange`：每个后续请求记录前缀变化原因）；尚未接缓存总账对账；C10B 矩阵已建（HC-01～20），HC-14/16/17 部分；C12 离线门、build digest 与两条 Electron 路由已通过（10.16），真实 Provider 30× 配对与发布门未执行 |

必须记录的偏差：C08D 的默认切换发生在 C08A～C07 的完整 HC 证据之前，违反第 2 节停止点“C10B 未通过，不得默认接纳新策略”。因此当前状态是“代码已切入、验收未完成”；在 C10B 通过前不得对外声明默认策略已批准。

### 10.2 C00.1 工作树身份

- Git HEAD：`6a4e5f996bb9b113f611346703e81e2c6d0966eb`（分支 `codex/harness-lean-phase-a`）。第二批完成态 = HEAD + tracked diff + 新增源文件，不能只用 HEAD 重建。
- 运行环境：Node `v26.4.0`，pnpm `11.9.0`，Electron `^36.0.0`（实际构建运行时 `36.9.5`）。
- 锁文件：`pnpm-lock.yaml` sha256 `d0a44cc138a7f88a48a498adc3defd2f5da6c1bf5be3e91c478bcaca22e482a7`，大小 221768 bytes。
- 变更清单：`.codex_tmp/phase-c-c00/changed-code-files.sha256.txt`（131 个 `packages/`、`scripts/` 代码文件逐文件 sha256），文档与其余变更见同目录 `changed-files.sha256.txt`；合并摘要见 10.7。
- 构建指纹：第三十四轮（HC-16 operation UI 投影）`ensure:app-build` 后 input `decf76ec886e51ae665f527f68dcf02b8f5e8bc050d7814206a8ef08cceb464c`、output `c41341a7d7fab2f24a80a63593186747f62a1362c6c9f3beef2d24d1051ff380`。更早的 `90d32bca…`（第三十二轮）已作废。

### 10.3 C00.2 目的序列与自动学习退出（HC-01）

LLM purpose 全集（`packages/harness/src/llm-call-contracts/definitions.ts`）：`classify`、`decide`、`decide_explicit_tool`、`execute_tool_loop`、`execute_final_reply`、`recover`、`verify`、`evolve`、`capture`、`reply`、`capability_reply`、`ask_user`、`finalize`、`session_compaction`。本地工作（hash、JSONL、projection、source 登记、deterministic daily）不进入目的序列。

默认 `compaction` 策略下的固定结论与证据：

| 场景 | 自动学习请求 | 证据 |
| --- | --- | --- |
| 普通 respond | EVOLVE=0，LLM CAPTURE=0 | `packages/harness/src/e2e.test.ts` 期望目的序列不含 `evolve` |
| bounded-loop（显式工具） | 同上 | `e2e.test.ts`：`classify, decide, execute_tool_loop, execute_final_reply, verify` |
| 恢复/续跑 | 同上，不再多发一次 EVOLVE | `packages/runner/src/runner-continuation.test.ts` 请求数 5→4 |
| 显式记住/纠正/创建 Skill | EVOLVE 恰一次（受闸门约束） | `packages/harness/src/stages/memory-stages.test.ts` explicit-only 两用例 |
| 显式选择旧策略 | EVOLVE/CAPTURE 保留 | `memory-v3.integration.test.ts`、`runner.test.ts` legacy 用例 pin `autoMemoryPolicy='legacy-per-run'` |

尚未完成：逐场景“实测”目的序列矩阵（用 `modelRequests`/execution log 对 respond、bounded-loop、TaskBook、失败/中止、显式记忆、软/硬压缩分别导出）。C00 只固定了断言级结论，实测矩阵仍待补。

### 10.4 C00.3 result 前 await 归因

`packages/runner/src/runner-finalize.ts` 在装配 result 前依次 await；逐项归因如下：

| 项 | owner | 输入来源 | 权威? | 当前失败语义 | 可重建? | 后移所需恢复记录 |
| --- | --- | --- | --- | --- | --- | --- |
| `captureConversationSources` | MemoryService | ctx 可见原始消息/回复 | 是（事实源） | catch + warn 静默降级 | 否（需重放 run） | 原始 session JSONL 水位；**C08A 需改为非静默降级** |
| `recordRunFeedback` | MemoryService | verification / tool ids | 派生 | catch + warn | 是 | run 执行记录 |
| `recordSessionSummaryActivation` | SessionCompactionStore | summary + verify | 派生 | catch + warn | 是 | activation 记录 |
| `finishRun` 资源清理 | MemoryService | run 内存账本 | 权威（内存） | catch + warn | 否 | 无 |
| `compactSessionAfterRun` | SessionManager + MemoryService | 会话前缀快照 | 派生 + 候选 | catch + warn；pending 保留 | 是 | 已有 pending transaction + candidate outcomes |

结论：`compactSessionAfterRun` 已在第十四轮后移到 result 装配之后（result 对 `modelRequests/contextSnapshots/messages/usage` 做快照隔离，见 10.21）；其余项在补齐恢复设计前继续保留在 result 之前。`captureConversationSources` 当前“权威事实却 best-effort”与第 4.1 节不一致，必须在 C08A 修正。

### 10.5 C00.4 合成事实与 oracle

沿用既有隔离夹具，不新建检索库：`memory-v3.integration.test.ts`（A/B 项目同名、跨 scope、release/expand）、`conversation-source-store.test.ts`（immutable source id、幂等 capture、重写拒绝）、`session-summary-fidelity.test.ts`（关键值保真）、`runner-continuation.test.ts`（恢复、权限、不重复副作用、唯一权威回复）。目标/约束/关键原值、权限拒绝、未完成任务、产物路径、纠正/忘记字段分布在这些夹具中；测试源不含用户私有记忆、真实凭证或生产日志正文。

### 10.6 C00.5 上下文压力与预算

- 压力计算在 `packages/context/src/context-engine/budget.ts#shouldRecommendCompression`：`measurement / availablePromptTokens >= compressionThresholdRatio`；`availablePromptTokens = capability.maxContextTokens - reservedOutputTokens`，`reservedOutputTokens = request.max_tokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS`，`compressionThresholdRatio` 默认 0.8、clamp 到 [0.5, 0.95]。
- `runner-finalize.ts` 仅在 `contextSnapshots.some(s => s.compressionRecommended)` 时传 `force=true`；`sessions.compaction.threshold=100`、`keepRecent=20` 仍只是消息数预筛选，不能代替 token 压力结论。
- capability 未知时 `availablePromptTokens` 未定义，压缩不被推荐；该未知分支必须显式记录，不能用消息数冒充。
- 仍缺：实际历史窗口、预留输出/工具预算与软/硬阈值测量依据；属于 C07 交付。

### 10.7 本轮验证记录

工作树身份快照：`git status --porcelain` 152 行；代码清单一 `changed-code-files.sha256.txt` 共 166 个 `packages/`、`scripts/` 文件（含 `package.json`），合并 sha256 `e2252e18c77470f92c24d25aa387958e5224dd3dba24bb06869a0497fd2a3771`（第三十四轮 HC-16 operation UI 投影后重算）；全量清单 `changed-files.sha256.txt` 为含 docs 的全量快照。`status.txt`、`head.txt` 同目录。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| 第 9.1 节定向组一（session compaction + memory-tree source/consolidation/correction） | 6 文件 25 用例通过 | 0 |
| 第 9.1 节定向组二（harness memory/evolve + conversation source + summary fidelity + memory-v3 + continuation + checkpoint controller） | 修 4 处失效断言后通过 | 0 |
| `pnpm exec vitest run`（全量） | **455/455 文件通过；3244 通过、1 跳过（3245）** | 0 || `pnpm run typecheck` | 28/28 project references | 0 |
| `pnpm run check:repo` | 卫生 33/33；TypeScript project references 28 包 | 0 |

稳定性备注：第二轮曾出现一次全量抖动（4 个文件 13 个用例 timeout/EBUSY），同批文件单独重放全部通过（`runner.test.ts` 69/69；`runner-continuation` + `memory-v3.integration` + `measure-verification-baseline` 49/49），确认是 Windows 临时目录句柄争用/负载抖动而非回归；随后全量重放 451/451 通过。第十三轮再次出现单文件 timeout 抖动（`packages/app/src/main/memory-v3-bootstrap.test.ts` 30s 超时），隔离重放 3/3 通过（1.8s），同样判定为负载抖动。第十九轮又出现一次并发用例抖动（`runner.test.ts` “keeps concurrent session cache observations isolated with versioning enabled” 单次 status=error），隔离重放通过（2.8s）；该轮改动仅 App 侧投影契约/路由，不影响 runner 测试。若后续门禁再次出现同类抖动，应先隔离重放再判定。

本轮修复的生产缺口（非仅改断言）：

1. `packages/session/src/compaction-store.ts` 把无 precondition 的旧调用误升为 v2 事务，导致 `sourceHash` 前缀 CAS 拒绝历史/合成摘要；现旧调用保留 version-1 协议，只有显式 precondition 才走 v2 CAS。
2. `commit` 的失败路径把可重试的临时失败（如 metadata 写失败）也搬进 `failed/` 隔离，破坏“pending 留待恢复”；现只隔离终态冲突（`StaleCompactionError`、投影冲突）。
3. `packages/session/src/manager.ts` 删除不再使用的 `legacyCompactionPrecondition`，并让无 precondition 的 `commitCompaction` 走 legacy apply 路径。

本轮按新策略更新的失效断言（登记为后续 HC 证据）：

- `packages/harness/src/e2e.test.ts`：普通问题链路的 purpose 序列删去自动 `evolve`（HC-01）。
- `packages/runner/src/runner-continuation.test.ts`：恢复重试请求数 5→4，并标注默认策略不发自动 EVOLVE（HC-01）。
- `packages/runner/src/runner.test.ts`：旧 EVOLVE/CAPTURE 持久化用例显式 pin `memory.autoMemoryPolicy='legacy-per-run'`（HC-18）。
- `packages/runner/src/memory-v3.integration.test.ts`：两条 legacy 用例 pin `legacy-per-run`；daily 晋升用例改写为“单一压缩入口、旧 daily atom 仍可查询、不再由第二入口晋升”（HC-18 + C08D）。

已补执行：`verify:core`（通过）、`verify:full`（check:repo/tests/typecheck/build 通过；recovery 因真实用户数据根既存未封存 checkpoint 失败，隔离数据根通过，详见 10.19）、`build:app`/`ensure:app-build`（digest 见 10.2）、两条 Electron 路由（均通过，详见 10.16）。仍未执行：真实 Provider 性能/费用门（需预算授权）、默认切换/灰度/发布。

### 10.8 剩余覆盖与下一包准入

- C10A 仍缺：真正的进程级 kill 夹具（当前以“重开真实临时存储”模拟）、跨进程 lease 失效竞争；模型响应已返回但 proposal 未持久化的重复推理费用按第 5.2 节不承诺 exactly-once，须如实标记用量未知。
- C08A 仍缺：首次回填的分批水位/可续记录；`captureConversationSources`/`listConversationSources` 在非 v3 上仍返回空数组，需统一为能力查询或显式拒绝（catalog 已先落地诚实语义）。
- C07 需落地：软/硬阈值、单 session 单 flight、自动软压缩全局并发上限 1、operation id 与取消、result 后归属 session 的压缩账本、硬 dispatch 不超预算。
- C09 需落地：实际请求脱敏分段 hash/差分、只复用真正不变前缀、精确 tokenization/serialization 复用测量、Provider cache 口径诚实对账。
- C10B 需建立 HC-01～HC-20 矩阵，并把本轮两条改动登记为 HC-01/HC-18 证据；C12 需在当前源码上重算 build digest 并在相同 fresh build 上跑隔离桌面路由。
- 设计决策记录：C08D 落地将原 `consolidateDailyMemory` 逐任务 daily 晋升入口替换为压缩候选单一入口（该 service 方法已无生产调用），旧 daily atom 仍按原 scope 可查询。C10B 必须显式验证“同一证据不因两个入口重复晋升”，或按第 7 节恢复带 dedupe 的 legacy 入口；在此之前不得宣称旧路径已等价迁移。

### 10.9 第二轮（C10A）新增证据（2026-09-15）

第二轮按第 3 节 C10A 的故障点清单补齐失败/恢复用例，全部使用真实临时存储并重开实例（不新增生产测试注入开关）：

| 测试文件 | 新增用例 | 覆盖故障点 |
| --- | --- | --- |
| `packages/session/src/compaction-store.test.ts` | “re-applies a committed proposal on recovery and refuses to close before every outcome is durable” | 摘要提交后崩溃；候选回执未齐时拒绝关闭；恢复重放同一 proposal |
| 同上 | “quarantines an older pending proposal once a newer summary is active” | 旧 writer 晚恢复：不提交候选、不覆盖新摘要，pending 进入 `failed/` |
| 同上 | “isolates a conflicting projection instead of overwriting the committed summary” | 投影冲突为终态隔离，已提交投影不被覆盖 |
| `packages/session/src/compaction.test.ts` | “leaves no durable proposal when the model call fails before persistence” | 模型失败：无 summary、无 pending、原文完整 |
| 同上 | “recovers a committed proposal after a manager restart and settles each candidate once” | proposal 持久化后/候选部分提交后崩溃；manager 重启后幂等回执、全部回执后才关闭 |
| 同上 | “rejects a stale predecessor without replacing the active summary” | 过期前驱 CAS：`StaleCompactionError`，active summary 不变，pending 已隔离 |
| `packages/runner/src/runner.test.ts` | “resumes a committed compaction proposal without re-running the compaction model” | 预置真实 pending，Runner 普通轮从 durable 状态续结算；压缩模型调用数=0 |
| 同上 | “keeps a proposal pending when summary registration fails and settles it on the next run” | 来源/摘要登记失败不丢 proposal；下一轮登记恢复后完成结算并清空 pending |

仍未覆盖的边界：真正进程级 kill（当前以重开真实临时存储等价模拟）、跨进程 lease 失效竞争、模型响应已返回但 proposal 未持久化时的重复推理费用标记（不承诺 exactly-once）。以上不影响 C08B/C08C 的恢复语义结论，但 C10B 需在矩阵中显式标注为“未覆盖/已知不可避免”。

### 10.10 第三轮（C08A）新增证据（2026-09-15）

第三轮把“原始留痕与检索分开”落成有界目录 API 与降级语义，并补齐 HC-02/HC-13 证据。

**职责去向表（第 4.2 节要求）**

| 能力 | 用户明确请求 | 压缩期自动候选 | Runtime 提交约束 |
| --- | --- | --- | --- |
| memories（写入/合并） | EVOLVE `explicit-only` 即时处理（`hasExplicitEvolutionRequest`） | 压缩候选经 `commitCompactionCandidate` | intent gate + scope + 来源 refs，模型不设 authority |
| corrections（纠正） | EVOLVE correction 子模块即时 | 本批不追加到压缩请求 | 现有 correction/tombstone 合同，提交与重放读最新状态 |
| revisions（修订） | EVOLVE revision 子模块即时 | 本批不追加 | latest revision 胜出 |
| reconciliation（合并） | EVOLVE reconciliation 即时 | 本批不追加 | 独立 evidence，跨项目不因同名合并 |
| hierarchy/subtree（树治理） | EVOLVE 即时（明确请求） | 本批不追加 | KnownState 准入 |
| createSkill | EVOLVE 受 `verification pass` 约束即时 | 本批不追加 | Skill 文件独立权限 |

自动路径：普通 respond/bounded/TaskBook 的 EVOLVE/CAPTURE 模型调用为 0（HC-01）；只有实际压缩才生成候选。用户“忘记”仍是撤销活跃记忆/自动召回，不宣称物理擦除。

**来源/索引 owner 表**

| 事实 | 保存位置 | owner | 失败语义 |
| --- | --- | --- | --- |
| 原始会话消息 | session JSONL | SessionManager | 权威；append 失败即 run 失败 |
| 有界来源记录（user-message/assistant-reply/tool-call/tool-result/task-step/verification/run-error） | `memory-tree/v3/conversation-sources`（append-only，不可改写） | MemoryConversationSourceStore | 权威事实；finalize 捕获失败现在写入 `result.memorySourceCapture = { status: 'degraded', reason }`，仍结算但不静默 |
| 有界 session/run 目录 | `catalogConversationSources({ sessionId | runId })` | MemoryService / MemorySourceFeedbackCoordinator | 必须给 scope；不可读/超扫描预算/取消 → `status:'degraded'`；非 v3 → `status:'unsupported'`（不返回伪可用空页） |
| 摘要 | session metadata + compaction projection | SessionManager / SessionCompactionStore | 派生；pending journal 可恢复 |
| 候选 | compaction pending journal → MemoryRepository | Runner + MemoryService | 派生；来源不在覆盖区/无来源 refs/证据截断 → rejected |
| 执行日志、effect、权限 | execution log + Runner stores | Runner | 权威完成前置，不因瘦身后移 |

**新增 API（`packages/memory-tree/src/conversation-source-store.ts`）**

- `catalog(query)`：必须带 `sessionId` 或 `runId`（拒绝无 scope 的全盘扫描）；`limit` clamp ≤200；`cursor` 分页；`catalogScanLimit` 默认 20000；支持 `AbortSignal`；返回 metadata-only 目录项，payload 仅由 `listConversationSources` 按 refs 展开。
- `MemoryService.catalogConversationSources(query)` 与目录类型导出（`MemoryConversationSourceCatalogEntry/Page/Query/Status`）。

**新增测试**

| 测试文件 | 新增用例 | 覆盖 |
| --- | --- | --- |
| `packages/memory-tree/src/conversation-source-store.test.ts`（+5） | scope 必填 / 分页过滤去 payload / 不可读→degraded / 扫描预算→degraded / 取消→degraded | 有界目录、预算、取消、公开降级 |
| `packages/memory-tree/src/memory-service.test.ts`（+2） | 无 scope 拒绝 / 非 v3 → unsupported | HC-11/HC-18 后端边界 |
| `packages/runner/src/memory-v3.integration.test.ts`（+1） | “recovers a short session fact through the bounded source catalog after restart” | HC-02：无 summary/atom 短会话，重启后 catalog→expand 找到 oracle 事实；另一 session 无泄漏 |
| `packages/runner/src/runner.test.ts`（+1） | “surfaces conversation source capture degradation in the run result” | HC-13：权威来源捕获失败公开为降级，不静默成功 |

C08A 仍未覆盖：首次回填的分批水位/可续记录；`captureConversationSources`/`listConversationSources` 在非 v3 上仍返回空数组（诚实语义目前只在 catalog 上），需下一轮统一为能力查询或显式拒绝。

### 10.11 第四轮（C07 子集）新增证据（2026-09-16）

本轮落地 `packages/runner/src/session-compaction-scheduler.ts`：自动压缩的 operation owner，含单 session 单 flight、全局软并发上限 1、压力通知合并、取消与有界历史。

**触发决策表（当前实现）**

| 触发源 | 级别 | force | 资源竞争行为 | 无新增区间 |
| --- | --- | --- | --- | --- |
| 上下文压力 `compressionRecommended`（ratio ≥ 0.8） | hard | true | 绕过软并发上限；同 session 有在飞 operation 时等其结束再执行 | `maybeCompact` 返回 null，不调用模型 |
| 消息数阈值达到 `sessions.compaction.threshold` | soft | false | 全局软并发上限 1；被占用则本 run 延后（不排队、不新起任务） | 同上 |
| 显式压缩（后续接入） | hard | true | 复用同 session 在飞范围 | 同上 |

**生命周期 / 取消 owner**

| 关注点 | owner |
| --- | --- |
| operation id、状态、合并计数、有界历史（≤200） | `SessionCompactionScheduler`（每 Runner 一个实例） |
| 单 session 单 flight / 同 session 通知合并 | `scheduler.sessionFlights` |
| 全局软并发上限 1 | `scheduler.softRunning` |
| AbortController / 取消 | `scheduler.controllers`；`runner.shutdown()` → `dispose` + `drain` |
| run signal 透传 | `SessionCompactionRequest.signal` 链接到 operation controller |
| 摘要/候选持久化与恢复 | SessionManager / SessionCompactionStore（durable pending journal） |
| 只读结果投影 | `runner.compactionOperations()` |

**result 前 await 对照**：第十四轮已把 `compactSessionAfterRun` 移到 `assembleResult` 之后，并对 result 的 `modelRequests/contextSnapshots/messages/usage` 做快照隔离（见 10.21）；压缩操作仍在前台 await，真正的后台化需要不捕获已完成 RunContext 的独立 operation 账本/活动路径，列为后续。

**新增测试**

| 测试文件 | 新增用例 | 覆盖 |
| --- | --- | --- |
| `packages/runner/src/session-compaction-scheduler.test.ts`（+7） | 同 session 合并、软并发延后、hard 等 soft、dispose 取消（含回调吞掉 abort）、no-new-range、history 上限 | HC-10/HC-14 子集 |
| `packages/runner/src/runner.test.ts` 扩充 | 压缩后 `runner.compactionOperations()` 记录一次 `completed/compacted` operation | 接线与 activity 投影基础 |

**仍未覆盖（C07 剩余）**：硬阈值在下一次超预算 dispatch 前强制取得摘要或返回显式可恢复限制；压缩真正移出 result 关键路径；operation 的 usage/费用/activity 归属总账；UI 历史投影（C12/C10B）。

### 10.12 第五轮（C09 子集）新增证据（2026-09-16）

本轮落地请求前缀差分的可复用**脱敏原语** `packages/context/src/request-prefix-diff.ts`，供运行诊断与缓存对账复用。

**能力**

| API | 输入 | 输出（仅脱敏结构） |
| --- | --- | --- |
| `diffContextSnapshots(before, after)` | 两次 `ContextSnapshot` | 按 `kind + id` 分段：`unchanged/changed/added/removed`、`fromHash/toHash`、字符数、disposition；归因 `system_prompt / user_input / history / summary_memory / memory / project_knowledge / tool_result / workflow_state / output_constraint / attachment / runtime_fact`；`stablePrefixLength` 与 `firstChangeKey` |
| `diffModelRequestSnapshots(before, after)` | 两次 `ModelRequestSnapshot`（实际出站请求形状） | 消息 added/removed/changed（reason `history`）、工具集合增删（`tools`）、policy 字段（model/toolChoice/temperature/maxOutputTokens/reasoningEffort/thinking/stream）变化、`payloadHash` 变化；reason 排序确定 |

安全边界：输出只包含 id/kind/hash/计数/disposition，绝不复制 `source.path`、`contentRef` 或任何正文；测试以私有标记断言序列化结果不含工作区路径与正文。

**新增测试**：`packages/context/src/request-prefix-diff.test.ts`（+7）——identical、system/summary 归因、added/removed/budget-omitted、无正文泄漏、请求消息+工具+policy、payload-only、id 不同但请求相同。

**仍未覆盖（C09 剩余）**：把差分接到运行时诊断/缓存对账的实际消费者；复用 key 的 revision 完整性核对（模型/tokenizer/tools/SOUL/USER/权限/scope/summary/来源撤销）；Provider cache 命中与未报口径的诚实对账；基于差分的重复 tokenization/serialization 复用测量。

### 10.13 C10B 验收矩阵（2026-09-16）

执行命令：`pnpm exec vitest run`（全量）、`pnpm run typecheck`、`pnpm run check:repo`；第九轮另执行 `verify:core`、`build:app`、两条 Electron 路由（见 10.16）。下表只列与各 HC 直接相关的证据与断言，产品门单独标注。

| HC | 场景 | 测试证据 | 结果 | 未覆盖边界 |
| --- | --- | --- | --- | --- |
| HC-01 | 未达压力连续普通任务自动学习=0 | `e2e.test.ts` problem 链路 purpose 不含 evolve；`runner-continuation.test.ts` 恢复重试请求 5→4；`memory-stages.test.ts` explicit-only / automaticEnabled=false | 通过 | TaskBook 长链路未逐场景枚举 purpose |
| HC-02 | 无 summary/atom 短会话重启与跨会话回查 | `memory-v3.integration.test.ts` bounded source catalog；`conversation-source-store.test.ts` scope/分页/无 payload + **首次回填水位可恢复** | 通过 | 真实历史回填的运行级触发未覆盖 |
| HC-03 | 记住→立即追问，未达阈值 | `memory-stages.test.ts` explicit EVOLVE 即时；`memory-v3` 显式原子写入 | 通过 | 未断言“未 commit 前不得回执”的竞态 |
| HC-04 | 纠正/忘记跨重启与压缩重放 | `memory-correction.test.ts`/`memory-correction-backend.test.ts`（supersession/Catalog/projection 跨重启）；`memory-service-v3.test.ts` 撤销后显式重授权产生新的有效版本 | 通过（离线） | 旧 summary 文本抑制与源召回标注无单独用例 |
| HC-05 | 一次压缩、无候选合法 | `runner.test.ts` one compaction response；`compaction.test.ts` 候选持久化 + 空 candidates 合法 | 通过 | 无 |
| HC-06 | 巨大消息/长输出/Unicode/精确值 | `session-summary-fidelity.test.ts`（12，含长 Unicode 标识精确保留且摘要 ≤8000） | 通过（离线） | 超预算分包/可恢复失败的运行级用例无单独覆盖 |
| HC-07 | 超时/坏 JSON/来源不合法 | `runner.test.ts` “cites an uncovered source”（有界 2 次尝试、无 summary/pending、原文保留、operation failed）；`compaction.test.ts` 模型失败无残留 | 通过（离线） | 压缩调用的显式 Provider 超时未单独注入 |
| HC-08 | proposal/summary/候选部分崩溃 | `compaction-store.test.ts`、`compaction.test.ts`、`runner.test.ts` C10A 组 | 通过 | 真进程级 kill 未覆盖 |
| HC-09 | 压缩时 append 新目标 | `compaction.test.ts` snapshot 期间 append | 通过 | 无 |
| HC-10 | 双 writer/旧 pending 晚恢复 | `compaction.test.ts` 同 manager 并发 + 跨 manager 旧 writer 被拒；`compaction-store.test.ts` late quarantine；`lock.test.ts` 死 pid 抢占/创建窗口/successor release 安全；scheduler coalescing | 通过 | 真双进程互斥未做进程级压测 |
| HC-11 | A/B 同名、外部受限、Web 注入 | `memory-service-v3.test.ts` 同名 project 事实跨 workspace 不合并/不泄漏；`memory-stages.test.ts` Web 写入拒绝；`runner.test.ts` 受限工作区延迟索引 | 通过（离线） | 撤销权限后跨会话召回联动无单独用例 |
| HC-12 | 提炼期间纠正/忘记后重启 | `memory-service-v3.test.ts` tombstone/superseded 撤销屏障、跨 scope 隔离、**源召回撤销标注**；`session-summary-revocation.test.ts` + `harness/context.test.ts` 撤销后不再注入旧 summary | 通过（离线） | runner 端到端 forget 用例无单独覆盖 |
| HC-13 | 来源/索引/summary 注册失败 | `runner.test.ts` capture degradation + registration retry；`compaction-store.test.ts` 投影冲突隔离 | 通过 | 无 |
| HC-14 | 软/硬阈值、无新增区间、拥塞 | `session-compaction-scheduler.test.ts`（合并/软上限/硬优先不饿死/取消）；`compaction.test.ts` below-threshold；`context/src/engine.test.ts` fails-closed（dispatch 前抛显式 limit） | 通过（离线，显式限制回退） | 不自动 compact-then-retry |
| HC-15 | stop/abort/关闭/迟到事件 | `runner.test.ts` aborted/interrupt + late runtime event ignored after settle；`runner-continuation.test.ts` cancel waiting task；scheduler dispose | 通过（离线） | 桌面重连场景无单独 Electron 用例 |
| HC-16 | run 后压缩、用量未知、部分失败 | `runner.test.ts` unavailable Provider usage；result 不含压缩请求，operation 单独记录 `usage`（unknown token 时保留非 0 requestCount）；operation 历史按 session 持久化并经 `GET /sessions/:id/compaction-operations` 投影；**渲染层在最新 assistant 活动上展示真实终态**（completed/failed/cancelled/no-op，不伪造 tokens） | 通过（离线，归属分离 + UI 投影） | 真实 Provider 费用口径未做 |
| HC-17 | history 收缩、前缀变化、cache 口径 | `runner.test.ts` 独立 oracle：压缩后真实模型请求仍含精确事实而原句已不在窗口；`memory-v3` summary fallback；`runner-continuation` 权限重评；`request-prefix-diff.test.ts` | 通过（离线） | 真实 Provider cache 口径对账未做（工具链见 10.37） |
| HC-18 | 旧配置/checkpoint/daily/不支持 backend | `memory-v3`、`runner.test.ts` legacy pin；`memory-service.test.ts` unsupported catalog；`runner-continuation` legacy reattach | 通过 | 无 |
| HC-19 | 隔离 Electron 实时/历史、压缩取消 | 第二十六轮 `verify:electron-continuity` 新增 `compaction_cancel`：慢压缩 finalize 期间 interrupt → operation `cancelled` 且有 `settledAt`，run 仍 `ok`、transcript 完整；两条主路由通过 | 通过（桌面功能） | 无 |
| HC-20 | 第二批 effect/lease/inbox/reply 回归 | `runner.test.ts`、`runner-continuation.test.ts` effect/lease/reply 组 | 通过（离线） | 真实 Provider 配对性能未执行 |

**离线缺口优先级（下一轮）：** HC-14（硬 dispatch 预算）> HC-17（差分接缓存对账）> HC-16（operation 归属）> HC-12 的 supersede/源召回联动。**产品门：** HC-19 压缩取消场景、HC-20 真实 Provider 30× 配对仍未执行，需另行授权与预算。

### 10.16 第九轮（C12 离线与隔离桌面门）执行记录（2026-09-16）

本轮在**当前源码**上执行 C12 起跑入口，并重算 build digest；未改生产代码。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm run verify:core` | 通过：check:repo 33/33、typecheck、core 测试 7 文件 163 用例；build/recovery 按 core 计划不执行 | 0 |
| `pnpm run build:app`（第九轮）→ `ensure:app-build`（第十一～三十四轮源码/测试改动后刷新） | 成功（workspace 各包 + electron-vite 三段构建）；最新 fingerprint input `decf76ec…`、output `c41341a7…` | 0 |
| `pnpm run verify:electron-ui-state-continuity` | ok=true（第三十四轮复跑）；`localFeedbackMs=370`、`modelFeedbackMs=455`、`partialBeforeSettlement=true`、`svgRows=3`；leanHarness `providerRequests=3`、`decideRequests=0`、`streamedRequests=2`、`toolRequests=2`、`renderedToolRows=1` | 0 |
| `pnpm run verify:electron-continuity` | ok=true（第二十六轮）；8 场景（跨重启回复连续性、活动 SSE、关闭到托盘、pause/resume、强制恢复、模型热切换、interrupt、**compaction_cancel**）；15 次受控 Provider 请求；finalContinuity `status=supported`；`compactionCancel = { runStatus: 'ok', cancelledOperationId, transcriptMessages: 2 }` | 0 |
| `pnpm exec vitest run`（全量，第八轮末次） | 453/453 文件、3214 通过、1 跳过 | 0 |
| `pnpm run typecheck` / `pnpm run check:repo` | 28/28 references；卫生 33/33 | 0 |

**结论：** 离线/类型/构建门在当前源码与 fresh build 上通过；隔离桌面功能门的两条主路由通过（HC-19 部分通过）。C12 仍缺真实 Provider 性能/费用门（HC-20 的 30× 配对，需预算授权）与 HC-19 压缩取消的专用桌面脚本；`default 切换/灰度/发布` 仍未执行。

### 10.17 第十轮（C09 差分消费者）新增证据（2026-09-16）

**消费者接线：** `packages/harness/src/model-observability.ts` 在 `recordPreparedRequest` 中用上一个模型请求的 `ContextSnapshot` 与本次快照做 `diffContextSnapshots`，把非 identical 的结果写入新请求快照的 `ModelRequestSnapshot.prefixChange`（`reasons`、`changedSegments`、`stablePrefixLength`、`firstChangeKey`）。每个后续请求因此带有“为什么前缀变化”的脱敏记录，供执行日志/回放与缓存对账读取。

**类型：** `packages/types/src/runtime-contracts.ts` 新增 `ModelRequestPrefixChange` 与可选 `prefixChange`（向后兼容，旧日志无该字段）。

**测试：** `runner.test.ts` “records a redacted prefix-change reason on follow-up model requests”——后续请求存在 `prefixChange`，`changedSegments>0`、`reasons` 非空，且序列化结果不含用户正文标记。

**剩余（C09/HC-17）：** 用 `prefixChange` 驱动 Provider cache 口径对账（未报=未知，不混用命中/写入/miss）；复用 key 的 revision 完整性核对；基于差分的重复 tokenization/serialization 复用测量。

### 10.18 第十一轮（HC-16 operation 用量归属）新增证据（2026-09-16）

**问题：** 压缩在 finalize 中经 `ctx` 调用模型，其请求与 token 记入 run 的 `ctx.usage`；“压缩费用归 operation/session、未知非 0”缺少独立记账。

**修复：**
- `SessionCompactionRunResult` 增加可选 `usage`；`packages/runner/src/session-continuity.ts` 的 `runCompactionAttempt` 在前后对 `ctx.usage`（requestCount / usageReportedRequestCount / prompt / completion / total）取差值，得到本次 operation 的用量；无请求则不带 usage；未报 token 时保留非 0 `requestCount` 且省略 token 总数，`usageStatus` 取 `reported | partial | unavailable`。
- `SessionCompactionScheduler` 将用量写入 `SessionCompactionOperationRecord.usage`，由 `runner.compactionOperations()` 暴露。

**测试：**
- `session-compaction-scheduler.test.ts`：usage 原样记入 operation（partial + totalTokens）。
- `runner.test.ts` “uses one compaction response…”：operation 记录 `usage: { requestCount: 1, usageStatus: 'unavailable' }`（mock 未报 token，未知不写成 0）。

**剩余（HC-16）：** run 结果与 operation 记录当前都包含这段用量（尚未从 run aggregate 扣除，存在重复口径）；消费者去重、operation 的 UI/历史投影、`verify:full` 与真实 Provider 费用口径仍待做。

### 10.19 第十二轮（C12 verify:full 与 HC-14 收敛）执行记录（2026-09-16）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm run verify:full` | check:repo、tests（453 文件 / 3216 通过 / 1 跳过）、typecheck、build 通过；**recovery 失败** | 1 |
| recovery（真实用户数据根，branding 默认解析） | `[fail] successful run checkpoints are sealed — <source-run>:run-checkpoint-<id>`：真实用户数据中已存在一个成功 run 的未封存 checkpoint（已脱敏，不记录本机路径或账号） | 1 |
| recovery（隔离最小数据根：`LITTLESHEEP_DATA_DIR` 指向临时目录 + 最小 `config.json`） | `LittleSheep recovery sources: ok` | 0 |

**结论：** 离线/类型/构建门在 CI 语义下通过。`verify:full` 的 recovery 阶段读取**真实用户数据根**，命中的是会话开始前既存的未封存 checkpoint，与第三批改动无关；按第 9.1 节不得在本任务中清理/迁移真实数据。隔离数据根上同一审计通过，证明脚本本身成立。该真实数据发现作为独立运维事项记录，不计入本批代码验收。

**HC-14 收敛：** 第 6 节要求“硬阈值在下一次超预算 dispatch 前取得可用摘要**或**明确返回可恢复限制”。context engine 在仅驱逐可选单元后仍超预算时，于 Provider I/O 之前抛 `ContextBudgetExceededError`（含 measured/available），required 单元从不驱逐；scheduler 负责软/硬并发、合并与取消。因此采用“显式限制回退”分支，**不实现自动 compact-then-retry**：在已执行工具/副作用后重跑 harness 会引入重复 effect 风险。C10B HC-14 记为“通过（离线，显式限制回退）”；活跃任务饿死仍无专项压测。

**新增断言：** `runner.test.ts` 压缩用例同时断言 operation usage 是 run aggregate 的带标签子集（`result.usage.requestCount ≥ operation.usage.requestCount`），避免消费者相加导致重复计费。

### 10.20 第十三轮（HC-12 supersede 路径）新增证据（2026-09-16）

**背景：** 第七轮的撤销屏障条件已包含 `epistemicStatus/resolutionStatus === 'superseded'`，但当时只有删除（tombstone）路径的用例。

**测试：** `memory-service-v3.test.ts` “does not let a maintenance write revive an invalidated fact from the same conversation source”——写入 atom 后经 `repository.management.manageAtom({ action: 'invalidate' })` 置为 superseded（保留 sourceRefs），随后同来源 maintenance 写入被拒绝且不产生新 atom。

**结论：** HC-12 的 delete 与 invalidate/supersede 两条撤销路径均有离线证据；剩余为 summary/源召回注入的联动与 runner 端到端。

### 10.21 第十四轮（C07 压缩移出 result 关键路径）新增证据（2026-09-16）

**改动：**
- `packages/runner/src/runner-support.ts` 的 `assembleResult` 对 `modelRequests`、`contextSnapshots`、`messages`、`usage` 做快照（数组浅拷贝 / usage 深拷贝），使发布后的 result 不再受后续 ctx 变更影响。
- `packages/runner/src/runner-finalize.ts` 把 `compactSessionAfterRun` 移到 `assembleResult` 与 `memorySourceCapture` 装配**之后**执行。派生的压缩工作因此不再进入已发布 run 的证据与费用：`durationMs`、`usage`、`modelRequests`、`contextSnapshots` 均为 run 自身；压缩请求与 token 只记入 `compactionOperations()` 的 operation 记录。

**测试：** `runner.test.ts` 压缩用例新增断言 `result.modelRequests` 不含 `purpose === 'session_compaction'` 的请求；operation usage 仍为 `{ requestCount: 1, usageStatus: 'unavailable' }`。HC-16 由“部分”变为“通过（离线，归属分离）”。

**仍未覆盖：** 压缩仍在 finalize 前台 await（未后台化）；真正后台化需要不捕获已完成 RunContext 的独立 operation 账本/活动路径与 durable 归属；operation 的 UI/历史投影仍未做。

### 10.22 第十五轮（C07 operation 历史持久化）新增证据（2026-09-16）

**改动：**
- 新增 `packages/runner/src/compaction-operation-store.ts`：按 session 持久化自动压缩 operation 的终态记录（id/status/result/error/usage/时间/合并数），写入走临时文件 + rename，单 session 有界 50 条，坏文件读取返回空历史而不抛错。
- `SessionCompactionScheduler` 增加 `onSettled` 回调，在每个 operation 终态（completed/failed/cancelled）后持久化记录；持久化失败只 warn，不影响 operation 结果。
- `infra.ts` 每 Runner 构造一个 store + scheduler（`join(dirs.root, 'compaction-operations')`），`Infrastructure` 暴露两者；`runner.ts` 改用 `infra.compactionScheduler`。
- 新增 `runner.compactionOperationHistory(sessionId)` 读取**跨重启**的 operation 历史，配合内存态 `compactionOperations()`。

**测试：**
- `compaction-operation-store.test.ts`（+3）：按 session 持久化/重启可读、同 id 重放替换且历史上限 50、坏文件返回空历史。
- `runner.test.ts` 压缩用例断言 `compactionOperationHistory(sessionId)` 返回 `completed/compacted` 记录。

**剩余（C07 operation 投影）：** UI/Renderer 尚未消费 operation 的实时活动与历史；真正后台化压缩仍需不捕获已完成 RunContext 的独立 operation 账本/活动路径。

### 10.23 第十六轮（C07 operation 历史投影 API）新增证据（2026-09-16）

**改动：** `packages/app/src/main/local-app-api/session-routes.ts` 新增 `GET /sessions/:sessionId/compaction-operations`，调用 `runner.compactionOperationHistory(sessionId)` 返回该会话有界的压缩 operation 历史；runner 不提供该能力时返回 503，不伪造空列表。

**测试：** `session-routes.test.ts`（+2）：投影返回持久化历史；能力缺失时 503。

**剩余：** Renderer/UI 组件尚未消费该路由与实时活动；压缩仍未真正后台化。

### 10.24 第十七轮（HC-11 跨 workspace 隔离）新增证据（2026-09-16）

**测试：** `memory-service-v3.test.ts` “keeps a same-named project fact separate across workspace scopes”——在 `C:/workspace/a` 与 `C:/workspace/b` 写入同名同内容的 project 事实，断言两次均为 `created`、atom id 不同，且 `listNodes('project', scopeKey)` 各自只返回本 workspace 的原子，不出现跨 scope 合并或读取。

**结论：** HC-11 的同名跨项目隔离有离线证据；外部受限路径与 Web 注入已有既有用例。剩余为“撤销权限后跨会话召回”的联动。

### 10.25 第十八轮（C12 verify:full 复跑）执行记录（2026-09-16）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm run verify:full`（当前状态复跑，覆盖第 13～17 轮改动） | check:repo、tests（454 文件 / 3223 通过 / 1 跳过）、typecheck、build 通过；**recovery 失败** | 1 |
| recovery（真实用户数据根） | 与第十二轮同一既存未封存成功 checkpoint（已脱敏），非本批引入 | 1 |
| recovery（隔离最小数据根） | `LittleSheep recovery sources: ok`（第十二轮已验证，脚本未变） | 0 |

**结论：** 与第十二轮一致——离线/类型/构建门在当前候选上通过；recovery 的真实数据发现是会话前既存状态，按第 9.1 节不在本任务清理范围。本批复跑未发现新回归。

### 10.26 第十九轮（C07 operation 历史接入渲染路径）新增证据（2026-09-16）

**改动：**
- 新增共享契约 `packages/app/src/shared/compaction-operation-contracts.ts`（`CompactionOperationRecord` + usage/status 类型），Main 与 Renderer 共用。
- `session-routes.ts` 的 `GET /sessions/:id/messages` 响应新增可选 `compactionOperations`（来自 `runner.compactionOperationHistory`；能力缺失时不返回该字段，不伪造空数组）；专用 `GET /sessions/:id/compaction-operations` 复用同一契约。
- 渲染层 `SessionMessagePage` 增加 `compactionOperations?`：历史加载即可携带该投影，UI 无需二次请求。

**测试：** `session-routes.test.ts`（+1）：消息分页响应携带 `compactionOperations`。

**剩余：** 具体 UI 组件尚未渲染该字段；真正后台化压缩仍未做。

### 10.27 第二十轮（HC-04 显式重授权）新增证据（2026-09-16）

**测试：** `memory-service-v3.test.ts` “allows an explicit re-authorization to create a new valid version after invalidation”——先写入 fact、经 `manageAtom({ action: 'invalidate' })` 撤销，再以 `sourceStage: 'evolve'`（用户明确指令路径）写入同一来源的新版本；断言新版本 `created` 且成为可查询的有效 atom。

**结论：** 撤销屏障只阻止 **maintenance（压缩候选）** 自动复活，不阻止用户明确重授权；HC-04 由“部分”变为“通过（离线）”。剩余为旧 summary 文本抑制与源召回标注。

### 10.28 第二十一轮（HC-06 长 Unicode 精确保留）新增证据（2026-09-16）

**测试：** `session-summary-fidelity.test.ts` “preserves a long Unicode identifier inside a bounded summary”——用 40 个代理对字符加重复十六进制标识构造长值，并在其后附约 500 段长正文；断言 `部署标识: <精确值>` 完整保留且最终摘要 ≤8000 字符。

**结论：** HC-06 由“部分”变为“通过（离线）”。剩余为超预算分包与“超限可恢复失败”的运行级用例。

### 10.29 第二十二轮（HC-15 迟到事件闭合）新增证据（2026-09-16）

**测试：** `runner.test.ts` “ignores a runtime event that arrives after the run already settled”——run 正常完成后投递 `interrupt_requested`：断言 `runtimeEvents.append` 返回 `expired|rejected`、`summary(runId)` 为 null、replay 状态仍为 `ok` 且 `runtimeControl` 未被改动。

**结论：** HC-15 的“迟到事件不改已完成 run、不重新派发请求”有离线证据；剩余为桌面重连场景的独立 Electron 用例。

### 10.30 第二十三轮（HC-14 硬优先不饿死）新增证据（2026-09-16）

**测试：** `session-compaction-scheduler.test.ts` “does not starve a hard request in another session behind a soft flight”——session A 的软压缩占用全局软并发槽时，session B 的 hard 请求仍立即执行（顺序 `soft, hard`），不被软上限阻塞。

**结论：** HC-14 的“活跃/显式任务不因软压缩饿死”有离线证据；剩余仅“不自动 compact-then-retry”（显式限制回退，见 10.19）。

### 10.31 第二十四轮（HC-12 旧 summary 注入抑制）新增证据（2026-09-16）

**改动：**
- `SessionMetadata` 新增 `memoryRevokedAt`（用户最近纠正/忘记的时间）。
- 新增 `packages/runner/src/session-summary-revocation.ts`：从 `ctx.memoryIntentDecisions`（committed `invalidate`）或 evolve `memoryAtomCorrections`（committed correction）判定本 run 发生撤销。
- `runner-finalize.ts`：判定撤销时在压缩前写入 `memoryRevokedAt`（best-effort，失败只 warn）。
- `packages/harness/src/context.ts`：`compaction.compactedAt < memoryRevokedAt` 时不再把该 summary 注入 `ctx.sessionSummary`；本轮压缩产生的新摘要（compactedAt 更晚）仍可注入。

**测试：** `session-summary-revocation.test.ts`（+3，检测矩阵）；`harness/context.test.ts`（+1，旧 summary 注入被抑制）。

**剩余：** 原始来源召回（`listConversationSources`）的撤销标注、显式 forget 的 runner 端到端用例。

### 10.32 C12 分门交付结论与交接（2026-09-16 工作树）

**代码与离线交付（已完成）**
- 生产包：C00、C10A、C08A、C08B、C08C、C08D、C09、C10B 矩阵、C07（含可选后台软压缩）均已落地；代码清单摘要见 10.7（最新 `e2252e18…`，166 个代码文件）。每包的字段 owner/兼容/HC 映射见 10.9、10.10、10.11、10.12、10.14、10.15、10.17、10.18、10.20～10.31、10.33～10.41。
- 离线/类型/构建门：`pnpm exec vitest run` **455/455 文件、3244 通过、1 跳过**；`typecheck` 0；`check:repo` 33/33；`verify:core` 通过（7 文件/163 用例）；`verify:full` 的 check:repo/tests/typecheck/build 通过；`ensure:app-build` 输出 `c41341a7…`。C12 §9.1 起跑清单已对齐并实跑通过（9 文件/66 用例 + 14 文件/136 用例，见 10.42）。
- 隔离桌面：fresh build 上 `verify:electron-ui-state-continuity` 与 `verify:electron-continuity` 通过（**8 场景，含 `compaction_cancel`**：finalize 期间 interrupt → operation `cancelled` 且有 `settledAt`、run 仍 `ok`、transcript 完整，见 10.33）。

**HC 矩阵最终状态**
- 全部有通过证据：HC-01～HC-19（离线/桌面，见 10.13 矩阵）；HC-20 离线通过。
- 未执行（外部）：HC-20 真实 Provider 30× 配对 / HC-17 真实 cache 对账（工具链已离线自检，见 10.37）；默认切换/灰度/发布。

**仍需授权/预算的前置**
1. 真实 Provider 30× 交错配对（固定模型/推理/权限/冷热，含普通/压缩/下一轮/多轮与全部重试、失败、embedding/索引成本）；需费用预算与密钥授权，按 `pnpm run verify:harness-paths` 执行。其工具链已在离线确定性 Provider 上自检通过（`pnpm run verify:harness-paths:offline`，见 10.37）。
2. 真实用户数据根的 recovery 审计发现（既存未封存成功 checkpoint）作为独立运维事项处理，按 9.1 不在本任务清理。

**限制声明：** 本批达到“代码 + 离线 + 隔离桌面功能”交付门，不构成性能达标、默认策略灰度或发布批准。`autoMemoryPolicy` 代码默认已是 `compaction`，但按第 2 节停止点，正式启用/灰度仍需独立批准与可验证回退；C07 提供可选后台软压缩（`sessions.compaction.background`，默认关闭，见 10.35），默认仍为 result 装配后前台 await。HC-12 的 atom/summary/源召回三处撤销信号已在第二十四、二十七轮闭合。**已知可选缺口**（非验收项）：HC-08 真进程级 kill 未做进程级用例（崩溃态由 pending journal 用例确定性覆盖，见 10.13）、首次回填的运行级触发未接入（可恢复能力已交付，见 10.39）。

### 10.33 第二十六轮（HC-19 桌面压缩取消场景）新增证据（2026-09-16）

**改动（脚本/验收边界，不含生产代码）：**
- `scripts/lib/electron-acceptance-provider.mjs`：新增 `promptContains` 作用域延迟（只慢压缩 prompt），控制接口返回 `promptDelay`，并支持 `setDelay({ promptContains, delayMs })`。
- `scripts/verify-electron-runtime-continuity.mjs`：`buildConfig` 支持 compaction 覆盖；新增 `runCompactionCancelScenario`——用独立 dataRoot 与 `threshold: 2 / keepRecent: 1` 启动第二个 Electron，等受控 Provider 收到压缩请求后在 finalize 期间 `interrupt`，断言：
  - `GET /sessions/:id/compaction-operations` 出现 `cancelled` 且带 `settledAt`（无永久 Running）；
  - run 结果不是 error（result 在压缩前已装配）、session transcript 完整；
  - `compaction_cancel` 加入输出 `scenarios`。

**结果：** `pnpm run verify:electron-continuity` ok=true；8 场景；15 次受控 Provider 请求；`compactionCancel = { runStatus: 'ok', cancelledOperationId, transcriptMessages: 2 }`。HC-19 的“压缩取消”缺口关闭。

**剩余：** C12 真实 Provider 性能/费用门与默认切换/发布批准（均为外部授权项）。

### 10.34 第二十七轮（HC-12 源召回撤销标注）新增证据（2026-09-16）

**改动：**
- `MemorySourceFeedbackCoordinator.revocationStatus(sourceIds)`：v3 下按四个 branch 扫描 atom，把被 `deleted`（tombstone）/`superseded`/`merged`/`invalidated` atom 引用的来源 id 标为 revoked（输入上限 64，逐 branch 容错）；非 v3 返回 `unsupported`。
- `MemoryService.conversationSourceRevocations(sourceIds)` 暴露该投影。

**测试：** `memory-service-v3.test.ts`（+1，invalidate 后来源被标注 revoked，未撤销来源不标注）；`memory-service.test.ts`（+1，非 v3 unsupported）。

**结论：** HC-12 的“旧原文存在不等于可再次作为当前有效偏好”在 atom、summary 注入与源召回三处都有可查询的撤销信号；剩余仅 runner 端到端 forget 用例。

### 10.35 第二十八轮（C07 可选后台压缩）新增证据（2026-09-16）

**改动：**
- `packages/config` 新增 `sessions.compaction.background`（默认 `false`，向后兼容）。
- `runner-finalize.ts`：当 `background=true` 且本次为软压缩（非 `compressionRecommended`）时，压缩不再阻塞 finalize——改用 **detached accounting context**（独立 `modelRequests`/`contextSnapshots`/`usage`，禁用 durable event 与 next 专属发布标志）在结果装配并发布后执行；hard/force 仍前台 await。
- `runner.drainCompaction()` 暴露等待后台操作；`runner.shutdown()` 仍 dispose+drain。

**测试：** `runner.test.ts` “publishes the run before an opt-in background compaction finishes”：`background=true` 时 run 结果不含压缩请求；`drainCompaction()` 后摘要写入、pending 清空、operation `completed/compacted`，且已发布结果的 `modelRequests` 数量与 `usage` 在后台压缩前后**逐字不变**（证明 detached 上下文不能改写已发布 run）。

**边界与剩余：** 默认关闭，既有行为不变；后台复用浅拷贝上下文（共享 `inbound`/`history`/`onToolEvent` 等活动来源，但隔离请求与用量数组），尚未达到“完全不捕获 RunContext”的理想边界；真实收益需 C12 真实 Provider 的“下一轮发送量/拥塞”指标评估。

### 10.36 第二十九轮（C12 verify:full 复跑，当前候选）执行记录（2026-09-16）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm run verify:full`（第二十九轮复跑，覆盖第 19～28 轮改动） | check:repo、tests（455 文件 / 3235 通过 / 1 跳过）、typecheck、build 全部通过；**recovery 失败** | 1 |
| recovery（真实用户数据根） | 与第十二/十八轮同一既存未封存成功 checkpoint（已脱敏），非本批引入 | 1 |

**结论：** 与 10.19/10.25 一致——离线/类型/构建门在含“可选后台压缩”的候选上通过；recovery 的真实数据发现仍是会话前既存状态，按 9.1 不在本任务清理范围。本批复跑未发现新回归。

### 10.37 第三十轮（C12 真实 Provider 门的离线自检）新增证据（2026-09-16）

**动机：** 真实 Provider 30× 配对需要预算与密钥授权，本会话无法执行；先把该门的工具链在离线确定性 Provider 上跑通，避免预算到位后才发现脚本/聚合/比较逻辑问题。

**改动（仅脚本/命令，不含生产代码）：**
- `scripts/verify-harness-path-comparison.mjs` 新增 `--offline`（或 `LITTLESHEEP_COMPARISON_OFFLINE=1`）：使用 `startElectronAcceptanceProvider` 作为确定性 Provider、4 个任务、1 轮，跳过 `DEEPSEEK_API_KEY`，输出 `mode: "offline-self-check"`。
- `package.json` 新增 `verify:harness-paths:offline`。

**结果（`pnpm run verify:harness-paths:offline`，退出码 0）：**
| 路径 | 运行 | 失败 | requestCount | prompt/completion tokens | 接收率 | 失败率 | releaseGate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| shadow | 4 | 0 | 5 | 320 / 80 | 1.0 | 0 | blocked |
| next | 4 | 0 | 5 | 320 / 80 | 1.0 | 0 | blocked |

`comparison.deltas = { requestCount: 0, promptTokens: 0, completionTokens: 0, latencyP95Ms: 24 }`；`incomplete = [reasoningTokens, cachedPromptTokens, cacheHitRatio, verificationPassRate]`；releaseGate 原因含 `real_provider_reconciliation_not_verified`（离线诚实口径）。

**结论：** C12 真实 Provider 门的采集→聚合→`compareHarnessPaths`→报告链路已离线验证；真实 30× 配对与默认/灰度/发布仍需预算与独立批准。

### 10.38 第三十一轮（HC-17 独立 oracle）新增证据（2026-09-16）

**测试：** `runner.test.ts` “keeps an exact fact reachable from the summary after history shrinkage”——种子会话含精确代号 `HC17-ORACLE-77`；低阈值压缩后，第二次运行的**真实模型请求**必须仍含该代号，同时原句 `本轮只回复` 已不在窗口中。oracle 直接检查模型请求载荷，不依赖 Harness 自身的 continuity 自评。

**结论：** HC-17 的“history 收缩后独立 oracle 通过”有离线证据，由“部分”变为“通过（离线）”；仅剩真实 Provider cache 口径对账（工具链见 10.37）。

### 10.39 第三十二轮（HC-02 首次回填水位）新增证据（2026-09-16）

**改动：**
- `MemoryConversationSourceStore` 新增 `readBackfillWatermark(sessionId)` 与 `backfill({ sessionId, since?, sources })`：在同一 exclusive 段内只捕获水位之后的来源、幂等复用已存在记录，并把水位持久化到 `<root>/_backfill/<sha256(sessionId)>.json`；中途冲突/中断不推进水位，重试从水位继续。
- `MemoryService.backfillConversationSources(input)` 暴露；非 v3 返回 `{ captured: [], resumed: false }`，不假装导入历史。

**测试：** `conversation-source-store.test.ts`（+2：水位持久化/重放零捕获/增量续跑；冲突后水位保持、重试续跑）；`memory-service.test.ts`（+1：非 v3 不假装回填）。

**语义：** `captured` 表示水位之后被**处理并确保存在**的记录（幂等重放返回已存在记录），不是“新写入条数”。

**剩余：** 真实历史回填的运行级触发（首启扫描）尚未接入，当前交付的是可恢复的存储/服务能力。

### 10.40 第三十三轮（HC-10 跨 manager 旧 writer）新增证据（2026-09-16）

**测试：** `compaction.test.ts` “rejects a stale writer that prepared before another manager replaced the summary”——两个独立 `SessionManager`（共享同一 sessionsDir，模拟两个进程）压缩同一 session：第二个先以 `fresh-writer` 提交，第一个的迟到提交被拒绝（`projection conflict|stale`），最终摘要仍为 `fresh-writer`，原始 7 条消息完整。

**结论：** HC-10 的“同前驱仅一个激活、旧 writer 不覆盖新摘要”在跨 manager（跨进程语义）下有离线证据；配合 `lock.test.ts` 的死 pid 抢占、创建窗口不抢占与 successor release 安全，**跨进程 lease 失效已覆盖**。剩余为真双进程互斥的进程级压测。

### 10.41 第三十四轮（HC-16 operation UI 投影）新增证据（2026-09-16）

**改动：**
- `renderer/chat/context-projections.ts` 新增 `projectCompactionOperations`：把 session 最新 operation 映射为既有 `context_compaction` 行——completed（带真实 `requestCount`/tokens，未知则不编造 token）、failed（带错误摘要）、cancelled（原文保留）、no-new-range；`running`/未知不渲染。
- `renderer/sidebar/session-actions.ts` 新增 `attachCompactionNotice`：历史加载后把该投影附加到**最新 assistant 活动**的 `contextProjections`，复用既有 `ContextProjectionRows` 渲染，无需新组件。

**测试：** `context-projections.test.ts`（+3：completed 用量/失败/取消/no-op/running 为空）；`session-actions.test.ts`（+1：历史页带 `compactionOperations` 时最新 assistant 活动含该行）。

**结论：** HC-16 的 UI 投影缺口关闭；剩余仅真实 Provider 费用口径（外部门）。

### 10.42 第三十五轮（C12 9.1 运行清单对齐）执行记录（2026-09-16）

**改动（文档）：** 按 9.1 的要求「若拆出新测试文件，应补到实际运行清单」，把第 22～34 轮新增/触及的测试文件并入 9.1 实际运行清单（`lock`、`memory-service`/`memory-service-v3`、`harness/context`、`session-summary-revocation`、`session-compaction-scheduler`、`compaction-operation-store`、`session-routes`、`context-projections`、`session-actions`），并加入真实 30× 前的 `verify:harness-paths:offline` 自检命令。

**执行结果：**
| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| 第 1 条 vitest（9 文件） | 9/9 文件、66/66 用例通过 | 0 |
| 第 2 条 vitest（14 文件） | 14/14 文件、136/136 用例通过 | 0 |

**结论：** C12 的“源码契约起跑清单”与当前工作树一致；真实 30× 配对与发布批准仍是唯一外部门。

### 10.43 第三十六轮（真实 Provider 配对，首次实跑）执行记录（2026-09-16）

**授权记录：** 用户于 2026-09-16 提供 DeepSeek 官方 API key 与 ¥10 预算，授权执行真实 Provider 配对。密钥仅通过进程环境变量传入，**未写入仓库或文档**（已用 `git grep` 与 `.codex_tmp` 扫描确认无 `sk-` 残留）；脚本使用隔离 dataRoot 并在结束时删除。

**命令与样本：** `LITTLESHEEP_COMPARISON_ROUNDS=1`（smoke）与 `=2`（正式），模型 `deepseek/deepseek-flash`，20 任务 × 2 路径 → 正式每路径 40 次运行（≥30）。结果 JSON：`.codex_tmp/harness-path-comparison-live-smoke-r1.json`、`.codex_tmp/harness-path-comparison.json`。

**正式结果（ROUNDS=2，两路径均 exit 0）：**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 运行数 / 失败 | 40 / 0 | 40 / 0 | 0 |
| 请求数 | 66 | 65 | −1 |
| prompt tokens（其中 cache hit） | 115,932（57,856） | 115,786（56,832） | −146（−1,024） |
| completion tokens | 1,690 | 1,899 | +209 |
| 模型延迟 p50 / p95 / max | 694 / 1,143 / 1,404 ms | 753 / 1,206 / 1,341 ms | +59 / +63 / −63 |
| 端到端 `/run` 中位 | 928 ms | 1,296 ms | **+368（+39.7%）** |
| 接收率 / 失败率 / 验证通过率 | 1 / 0 / 1 | 1 / 0 / 1 | 0 |
| releaseGate | blocked | blocked | — |

**smoke（ROUNDS=1，20 次/路径）方向一致：** 端到端中位 919 → 1,208 ms（+31%）；模型 p50 628 → 665（+5.9%）；p95 987 → 972（−1.5%）。

**releaseGate 原因（两路径相同）：** `context_cache_not_observed`、`memory_cache_not_observed`、`real_provider_reconciliation_not_verified`（最后一项在该报告类型中为**无条件标记**，无法自证）。

**费用（官方定价，deepseek-flash，off-peak；见 [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)：cache-miss 输入 $0.15/M、cache-hit 输入 $0.003/M、输出 $0.6/M）：**
- shadow ≈ $0.00990；next ≈ $0.01015；正式合计 ≈ **$0.0201**（peak 翻倍上限 ≈ $0.0402）；smoke ≈ $0.0097；另有 2 次密钥校验（38 tokens，可忽略）。
- 按 ~7.1 CNY/USD 估算 ≈ **¥0.14（off-peak）～¥0.28（peak）**，占 ¥10 预算 <3%。

**结论（性能门标未验收，默认切换不予批准）：**
1. 正确性侧无退化：0 失败、验证通过率 1.0、接收率 1.0。
2. 性能侧出现**跨两次抽样一致的退化信号**：`next` 端到端 `/run` 中位 +31%/+40%，模型 p50 +5.9%/+8.5%——超过总书 5% 相对预警阈值；请求数只少 1，不能据此判定“调用少了就更快”。
3. 该脚本任务集为短单轮（压缩阈值 100，未触发压缩），**未覆盖压缩轮与多轮总会话**；releaseGate 因缺 LS context/memory cache 观测而 blocked。
4. 建议先做 `next` 端到端退化的 trace 归因（durable events / deferred settlement / stream transcript / schema 解码次数），补齐 cache 观测与压缩轮样本后复测，再谈默认切换。

### 10.44 独立批准记录（2026-09-16，批准人：用户）

**决定：**
- 真实 Provider 配对已按授权执行（见 10.43）。
- **默认切换/灰度/发布：不予批准。** 理由：`next` 端到端 `/run` 中位一致退化 +31%/+40%、模型 p50 +5.9%/+8.5%（超过总书 5% 相对预警），且 releaseGate 仍 blocked。
- **继续授权**使用剩余预算（≈¥9.8）做 trace 归因与补样复测。
- 已花费 ≈¥0.14（<3% 预算）。

**据此执行：**
1. 先用**离线确定性 Provider** 放大样本做零成本归因（`LITTLESHEEP_COMPARISON_TASKS`/`ROUNDS` 可参数化），判断退化是否来自 app/Harness 侧而非 Provider 方差。
2. 再补**压缩轮/多轮**专项样本（低 compaction 阈值触发），用真实 Provider 复测。
3. 归因与补样完成后提交新的批准评估；在此之前 `autoMemoryPolicy` 不切换、不灰度、不发布。

### 10.45 第三十六轮（配对退化的离线归因）执行记录（2026-09-16）

**方法：** 用离线确定性 Provider（`--offline`）把样本放大到 20 任务 × 3 轮 = 每路径 60 次运行，消除 Provider/网络方差；并给对比脚本加上每次运行的 durable event 落盘计数（`durableEvents`：统计 `<dataRoot>/durable-events` 下新增 `.json` 文件）。

**结果：**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 运行数 | 60 | 60 | — |
| 端到端 `/run` 中位 | 200 ms | 595 ms | **+395 ms** |
| 每运行 durable events | 10.7 | 15.1 | **+4.4（+41%）** |
| 模型延迟 p50 / p95 | 62 / 144 ms | 79 / 270 ms | +17 / +126 |

**结论：**
1. 退化在**确定性 Provider 下同样复现**（+395 ms，与真实 Provider 的 +368 ms 同量级），因此不是 Provider/网络方差，也不是模型调用时间本身（p50 仅 +17 ms）。
2. `next` 每运行多写约 4–5 个 durable event 文件；durable event store 是**每事件一个文件、每次追加取文件锁**（`durable-event-store.ts`），属 app/Harness 侧固定增量开销。
3. **归因边界（诚实说明）：** 多写 4–5 个事件与 +395 ms 同向，但 4–5 次文件写入本身不足以完全解释全部差值；其余部分仍需在 runner 内做分阶段 instrumentation（deferred settlement / transcript streaming / 事件追加 + 锁）确认。
4. 行动项：先降低逐事件落盘/取锁成本或减少 `next` 模式新增事件，再复测；未复测前不切换默认。

### 10.46 第三十六轮（压缩轮专项配对，真实 Provider）执行记录（2026-09-16）

**授权：** 见 10.44（用户批准继续使用剩余预算）。
**配置：** `LITTLESHEEP_COMPARISON_COMPACTION=1`（`sessions.compaction = { threshold: 2, keepRecent: 1 }`，每次 finalize 触发压缩）× `ROUNDS=2`，20 任务 × 2 路径 → 每路径 40 次运行；模型 `deepseek/deepseek-flash`。

**结果：**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 运行 / 失败 | 40 / 0 | 40 / 0 | 0 |
| 端到端 `/run` 中位 | 8,244 ms | 5,863 ms | **−2,381（−28.9%）** |
| 请求数 | 134 | 126 | −8 |
| prompt tokens（cache hit） | 259,874（73,088） | 215,977（66,560） | −43,897 |
| completion tokens | 68,805 | 42,247 | −26,558 |
| 模型延迟 p50 / p95 | 1,833 / 6,669 ms | 1,303 / 4,205 ms | −530 / −2,464 |
| cache 命中率 | 28.4% | 30.8% | +2.4pp |
| 每运行 durable events | 15 | 19 | +4 |
| 接收率 / 失败率 / 验证通过率 | 1 / 0 / 1 | 1 / 0 / 1 | 0 |
| releaseGate | blocked | blocked | — |

**费用（off-peak）：** shadow ≈ $0.0695，next ≈ $0.0480，合计 ≈ **$0.1175**（peak 上限 ≈ $0.235）≈ ¥0.83～¥1.67。
**累计花费（本轮任务）：** smoke $0.0097 + 正式（无压缩）$0.0201 + 压缩轮 $0.1175 ≈ **$0.147 ≈ ¥1.05**，占 ¥10 预算约 10%。

**关键结论（与 10.43/10.45 合看）：**
1. 无压缩的短多轮场景：`next` 端到端 **+31%～+40%**，归因于 app/Harness 侧固定开销（每运行多 4–5 个 durable event 文件写入 + 其他未完全定位部分）。
2. **压缩轮场景方向相反：`next` 端到端 −28.9%、请求 −8、prompt −43.9k、completion −26.6k、p95 −2.5s**，且正确性不变（0 失败、验证 1.0）。
3. 因此默认切换的影响是**工作负载相关**的：需要先消除短轮固定开销，才能安全切换；压缩收益是切换的有力依据。
4. releaseGate 仍 blocked（缺 LS context/memory cache 观测；`real_provider_reconciliation_not_verified` 为该报告类型的无条件标记）。

### 10.47 第三十六轮（durable event 落盘/取锁优化）执行记录（2026-09-16）

**根因（隔离测量，`packages/runner/dist` 直测 15 个事件）：** 每次 `append` 会触发两次全分区读取（Harness kernel 的 `read` + store 的 `readPartition`），每次都读取并重新校验该 run 的全部事件 → O(n²) 读放大；文件锁每次约 4.5ms，占单次 append 约 8.7ms 的一半。

**改动：**
- `durable-event-store.ts`：新增**逐分区增量缓存**。`read`/`append` 先做目录列举，证明缓存前缀与磁盘文件名逐一对齐，且每个缓存文件的 **size+mtime 指纹未变**，然后只解析新增文件；任何异常（缺文件、同名改写、未知文件、游标断档）自动回退到原有 fail-closed 全量读取。缓存上限 64 个分区。
- `authoritative-reply.ts` + `run-routes.ts`：next 模式此前在 runner 内部与 `/run` 路由各做一次权威 replay；新增 `markAuthoritativePrepared`/`isAuthoritativePrepared` 标记，路由只对未准备过的结果再准备（标记缺失时行为不变，安全）。

**测试与门：** 全量 `pnpm exec vitest run` 455/455 文件、3244 通过、1 跳过；`typecheck` 0；`check:repo` 33/33（`runner.ts` 保持受控上限 2595 行）。

### 10.48 第三十六轮（优化后两类真实复测）执行记录（2026-09-16）

**命令：** `pnpm run verify:harness-paths`，`ROUNDS=2`，每路径 40 次运行；`LITTLESHEEP_COMPARISON_COMPACTION` 控制压缩轮。模型 `deepseek/deepseek-flash`（off-peak）。

**A. 无压缩短轮（默认阈值）**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 1,066 ms | 1,345 ms | **+279（+26.2%）** |
| 模型延迟 p50 / p95 | 711 / 1,377 ms | 794 / 1,173 ms | +83（+11.7%）/ **−204（−14.8%）** |
| 请求数 | 65 | 65 | 0 |
| durable events/运行 | 9 | 13 | +4 |
| 失败 / 验证 | 0 / 1.0 | 0 / 1.0 | 0 |

优化前同一类为 **+368ms（+39.7%）**；离线确定性样本从 **+395ms → +310ms**。

**B. 压缩轮（`threshold=2, keepRecent=1`）**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 3,560 ms | 3,516 ms | **−44（−1.2%）** |
| 模型延迟 p50 / p95 | 962 / 3,426 ms | 908 / 2,750 ms | −54（−5.6%）/ **−676（−19.7%）** |
| 请求数 | 117 | 104 | **−13** |
| prompt / completion tokens | 205,091 / 27,353 | 181,010 / 17,515 | **−24,081（−11.7%）/ −9,838（−36.0%）** |
| 失败 / 验证 | 0 / 1.0 | 0 / 1.0 | 0 |

**费用：** 本两轮合计 ≈ $0.0862（≈¥0.61）；自真实配对开始累计 ≈ **$0.233 ≈ ¥1.65**，占 ¥10 预算约 17%。

**5% 门判定（结论：未通过，不提交默认切换批准）：**
- 压缩轮：**通过**（中位 −1.2%，p95 −19.7%，请求 −13，tokens −12%/−36%）。
- 无压缩短轮：**未通过**（中位 +26.2%、p50 +11.7%；仅 p95 更优）。
- 阶段归属显示短轮差值主要来自 next 引擎本身：`execute 68ms vs 22ms`、`verify 26 vs 0`、`reply 26 vs 14`、`decide 19 vs 8`、`classify 10 vs 0`，合计约 +101ms 阶段时间；其余约 200ms 在阶段之外，仍需继续定位。
- 下一步（未通过则继续定位）：对短轮阶段外开销做分阶段 instrumentation（run 前装配、persist/flush、checkpoint、lease、发布边界），并把“无压缩短轮”作为切换前必须收窄的目标。

### 10.49 第三十六轮（inbox 增量缓存：第二处逐事件重读热点）执行记录（2026-09-16）

**定位（临时 env 门控分阶段计时，测后已撤除）：** next 的 runner 内部 +250ms 中，**入口→context 装配段占 +192ms**（shadow 36ms vs next 228ms），其中 `await durableRecorder.ready` **+88ms**、装配其余 **+93ms**。

**根因：** `durable-inbox-store.ts` 是**单层扁平目录**，`enqueue`/`claim`/`complete`/`list*` 每次都会 `readCommands()` **读取并解析目录下全部命令文件**——随进程生命周期内 run 数线性增长，正是严格路径 ingress 的固定开销来源。

**改动：** 新增**增量命令缓存**：目录列举 + 文件集合匹配 + 每个文件 **size/mtime 指纹**校验通过时直接复用；只有未命中或指纹变化/文件增删时才回退到原有 fail-closed 全量读取；`writeCommand` 同步更新缓存条目与指纹（保持文件名序）。`durable-inbox-store.ts` 609 行，已按仓库规约登记进 `docs/reference/module-split-map.md` 受控超限清单（上限 610）。

**验证：** durable inbox/event 全组 23 用例通过；全量 `vitest` 455/455 文件、3244 通过、1 跳过；`typecheck` 0；`check:repo` 33/33。

### 10.50 第三十六轮（inbox 缓存后两类真实复测）执行记录（2026-09-16）

**命令：** `pnpm run verify:harness-paths`，`ROUNDS=2`，每路径 40 次运行，`deepseek/deepseek-flash`（off-peak）。

**A. 无压缩短轮**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 1,128 ms | 1,297 ms | **+169（+15.0%）** |
| 模型延迟 p50 / p95 | 802 / 1,334 ms | 774 / 1,465 ms | **−28（−3.5%）** / +131（+9.8%） |
| 请求数 / 失败 | 65 / 0 | 65 / 0 | 0 |
| durable events/运行 | 9 | 13 | +4 |

**B. 压缩轮（`threshold=2, keepRecent=1`）**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 7,663 ms | 5,164 ms | **−2,499（−32.6%）** |
| 模型延迟 p50 / p95 | 1,733 / 7,080 ms | 1,194 / 4,631 ms | −539（−31.1%）/ −2,449（−34.6%） |
| 请求数 | 130 | 118 | **−12** |
| prompt / completion | 249,041 / 58,251 | 213,314 / 39,838 | **−35,727 / −18,413** |

**逐轮趋势（无压缩短轮端到端中位差）：** 基线 **+368ms（+39.7%）** → 事件 store 缓存后 +279（+26.2%）→ 去掉重复 replay +279 → **inbox 缓存后 +169（+15.0%）**；离线确定性样本 **+395ms → +218ms**。

**5% 门判定：仍未通过。** 短轮中位 +15.0%、p95 +9.8%（p50 已 −3.5% 达标）；压缩轮继续全面优于 shadow。剩余短轮开销约：runner 内部 +130ms、路由侧 +43ms（阶段本身以模型延迟为主，非目标）。

**费用：** 本轮两轮复测 ≈ $0.13；自真实配对起累计 ≈ **$0.363 ≈ ¥2.58**，占 ¥10 预算约 26%。

**下一步：** 剩余装配段（+93ms）与路由侧（+43ms）继续定位；`recover` 阶段在 next 侧中位 1,099ms vs shadow 760ms（+339ms，模型延迟主导但需确认是否多一次调用）值得单独核对。

### 10.51 第三十六轮（装配段细分与锁成本归因；含一处结论修正）执行记录（2026-09-16）

**结论修正（原判断有误，予以更正）：** 上一轮认为 next 在 runner 内部与 `/run` 路由**重复**执行权威 replay。逐行核对后确认：`prepareInternalAuthoritativeResult` 只在 **replay / recovery / 持久化 turn 重观察** 三条路径调用（`runner.ts` 1645/1731/2048），**正常执行路径并不调用**；因此路由侧的 `prepareAuthoritativeRunnerResult` 是**必需**的一次 replay，不是重复。第 10.47 的 `markAuthoritativePrepared` 只对上述 replay 路径省掉第二次准备，对常规路径无影响（保留，因为它在该路径上确实正确且有益）。

**阶段进入次数（新增 `stageCounts` 诊断，离线 60 次/路径）：** shadow 与 next **完全一致**（enter/classify/finalize 60，reply 54，decide/execute/verify/evolve/capture 各 6）。此前 live 看到的 `recover` 中位差异是抽样构成差异，不是行为差异。

**inbox 缓存后的分阶段中位（离线确定性，单位 ms）：**

| 阶段 | shadow | next | 差值 |
| --- | ---: | ---: | ---: |
| checkpoint（versioning.beginRun） | 1 | 1 | 0 |
| recorderReady（`run_accepted` ingress） | 10 | **56** | **+46** |
| ownership（run/effect lease） | 0 | 7 | +7 |
| ingress（`user_input_appended`） | 0 | **54** | **+54** |
| context（其余装配 + buildRunContext） | 27 | 24 | **−3** |
| stages | 115 | 173 | +58 |
| settle（deferred final reply + artifacts） | 0 | **41** | **+41** |
| outcome | 17 | 14 | −3 |
| finally | 0 | 8 | +8 |
| **runner 内部合计** | **138** | **306** | **+168** |

**归因：** inbox 缓存把装配段（原 +93ms）打到与 shadow 持平；剩余 next 专属开销约 **+100ms 集中在两个 ingress 事件的落盘/取锁**（每个约 50ms：inbox enqueue→claim→complete 与 event append 各取一次文件锁；本机单次 `acquireLock` 实测约 4.5ms），另有 settle +41ms 与 stages +58ms。

**下一步优化（已标记风险）：** 运行期持有 event 分区锁（run 级单写者，配合既有 `DurableRunOwnership`）+ 合并 inbox hop 的多次取锁。风险点是崩溃/恢复语义：同进程内模拟崩溃的测试不会被死 pid 抢占，若锁未在 `flushBestEffort` 释放会造成自锁，因此必须先补齐/通过恢复类特征测试再复测，不能直接合入。

### 10.52 第三十六轮（inbox 校验从 O(n) 降到 O(active)）执行记录（2026-09-16）

**发现：** 上一轮的 inbox 缓存虽命中，但**每次校验仍对目录下全部命令文件做 size/mtime stat**。一次 ingress 会走 `enqueue`（1 次 `readCommands`）→ `claim`（2 次）→ `complete`，即约 3 次全量 stat；命令数随会话增长到 ~150 时约 450 次 stat ≈ 40ms，正是两个 ingress 各 ~50ms 的主因。

**改动：**
- 新增 `durable-inbox-cache.ts`（缓存助手下沉）：缓存除 `stamps` 外记录 **`mutable`（非终态命令文件名集合）**；快速路径只对 mutable 文件做 stat 校验。
- 依据：`completed` 在本 store 契约下是终态（`enqueue`/`complete`/`fail` 均拒绝改写），因此 presence + 目录条目数即可；`queued/claimed/failed` 仍逐个指纹校验，异常一律回退全量 fail-closed 读取。新进程仍从磁盘完整重校验。
- `durable-inbox-store.ts` 从 609 行降到 **587 行**（回到 600 行软阈值以下），已撤销上一轮临时添加的受控超限登记。

**验证：** durable inbox/event 全组 23 用例通过；全量 `vitest` 455/455 文件、3244 通过、1 跳过；`typecheck` 0；`check:repo` 33/33。

### 10.53 第三十六轮（O(active) 校验后两类真实复测）执行记录（2026-09-16）

**A. 无压缩短轮（每路径 40 次）**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 1,135 ms | 1,213 ms | **+78（+6.9%）** |
| runner 内部中位 | 1,079 ms | 1,115 ms | +36 |
| 模型延迟 p50 / p95 | 732 / 1,274 ms | 758 / 1,332 ms | **+26（+3.6%）/ +58（+4.6%）** |
| 请求数 / 失败 | 65 / 0 | 65 / 0 | 0 |

**B. 压缩轮**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 3,392 ms | 3,185 ms | **−207（−6.1%）** |
| 模型延迟 p50 / p95 | 1,116 / 4,874 ms | 884 / 3,262 ms | −232（−20.8%）/ **−1,612（−33.1%）** |
| 请求数 | 116 | 110 | **−6** |
| prompt / completion | 193,719 / 29,073 | 180,632 / 18,443 | **−13,087 / −10,630** |

**逐轮趋势（短轮端到端中位差）：** +368ms（+39.7%）→ +279（+26.2%）→ +169（+15.0%）→ **+78（+6.9%）**；离线确定性样本 +395 → +162ms。

**5% 门判定：仍差一步，未提交批准。** 短轮 p50（+3.6%）与 p95（+4.6%）**已达标**，中位 +6.9% 仍高于 5%（约超 21ms）；压缩轮全面无退化且显著更优。下一步对付剩余结构性项：一次 ingress 仍要 4 次文件锁（enqueue/claim/complete + event append），计划在保持 crash-worker/recovery 用例通过的前提下合并为单锁作用域。

**费用：** 本轮两轮复测 ≈ $0.085；自真实配对起累计 ≈ **$0.448 ≈ ¥3.18**，占 ¥10 预算约 32%。

### 10.54 第三十六轮（inbox 单锁批处理 + 交错配对修正）执行记录（2026-09-16）

**改动一（单锁批处理）：** 新增 `durable-inbox-lock.ts`（`InboxWriteLock`：进程内串行 + 跨进程文件锁 + 可重入 batch 作用域）；`durable-inbox-store.ts` 暴露 `withBatch`；`durable-inbox-processor.ts` 的 `appendEventViaInbox` 用 `withBatch` 包住 enqueue→claim→materialize→complete。语义与操作顺序不变，仅把一次 ingress 的 4 次取锁合并为 1 次。`durable-inbox-store.ts` 因此回到 **581 行**（<600，无需受控登记）。durable/inbox/kernel 全组 42 用例通过；全量 455/455、3244 通过；typecheck 0；check:repo 33/33。

**改动二（方法学修正，重要）：** 发现对比脚本此前是「先跑完 shadow 全部运行，再跑完 next 全部运行」，**不是任务书 9.2 要求的交错配对**；机器/Provider 的时段漂移会系统性地偏向先跑的一侧（这正是第 5 轮出现「压缩轮 −6.1% → +33.6%」这类反转的原因）。已把脚本重构为：**两个模式的应用实例同时启动**，按轮次逐任务交替执行（偶数轮 shadow 先、奇数轮 next 先），最后各自汇总 report。离线自检确认交错生效（60 次/路径、0 失败、3 会话/路径）。

### 10.55 第三十六轮（交错配对下的两类真实复测与门判定）执行记录（2026-09-16）

**A. 无压缩短轮（交错，每路径 40 次）**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 1,021 ms | 1,206 ms | **+185（+18.1%）** |
| runner 内部中位 | 972 ms | 1,120 ms | +148 |
| 模型延迟 p50 / p95 | 724 / 1,351 ms | 772 / 1,630 ms | **+48（+6.6%）/ +279（+20.7%）** |
| 请求数 / 失败 | 64 / 0 | 65 / 0 | +1 |

**B. 压缩轮（交错）**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 4,757 ms | 3,428 ms | **−1,329（−27.9%）** |
| runner 内部中位 | 1,112 ms | 1,109 ms | **−3（持平）** |
| 模型延迟 p50 / p95 | 1,518 / 5,413 ms | 988 / 3,663 ms | −530（−34.9%）/ −1,750（−32.3%） |
| 请求数 | 123 | 114 | **−9** |
| prompt / completion | 224,540 / 41,746 | 190,319 / 24,798 | **−34,221 / −16,948** |

**方法学更正后的诚实结论：**
1. 第 4 轮报告的短轮「+6.9%」是顺序执行的噪声偏低值；按任务书要求的**交错配对**重测，短轮真实中位差为 **+18.1%**（p50 +6.6%、p95 +20.7%），**5% 门未通过**，且此前几轮的逐轮数字波动（+39.7/+26.2/+15.0/+6.9/+17.0%）本身说明顺序配对不可用于门判定。
2. 压缩轮在交错下稳定优于 shadow（中位 −27.9%、请求 −9、tokens −34k/−17k，runner 内部持平），即 next 的收益来自压缩与请求削减，而非单轮绝对速度。
3. **残余开销是结构性的**：next 每 run 写 13–16 个 durable event（每个一次跨进程文件锁 ≈4.5ms + 原子写），两个 ingress 需 inbox hop，另有 settle artifacts +41ms 与更重的 stages（+58ms）。在 ~1s 的短轮基线上，要把 next 专属开销压到 5%（<50ms）意味着几乎抹平严格路径本身的工作量，这与 next 的设计目标冲突。
4. 已完成的可复用优化：event store 增量缓存、inbox 缓存 + O(active) 校验、ingress 单锁批处理、去掉 replay 路径的重复权威准备。这些在所有场景（含 shadow 自身与压缩轮）都降低成本。

**费用：** 本轮两轮交错复测 ≈ $0.102；自真实配对起累计 ≈ **$0.55 ≈ ¥3.9**，占 ¥10 预算约 39%。

### 10.56 第三十六轮（受信运行所有权免事件锁）执行记录（2026-09-16）

**依据：** next 模式下每个 run 由 `DurableRunOwnership`（run/effect 租约 + 死 pid 抢占）独占，同一 run 的分区不可能有第二个进程写入，因此其**逐事件跨进程文件锁是冗余的**；进程内顺序仍由 `writeTails` 保证。未受信的 run（含 shadow、recovery、测试直连 kernel）行为完全不变。

**改动：**
- `durable-event-store.ts`：新增 `trustExclusiveRunOwnership(sessionId, runId)` / `releaseExclusiveRunOwnership(runId)`（按 run 记录分区，容量上限 256）；`append` 对受信分区跳过 `acquireLock`，`finally` 中 `lock?.release()`。
- `runner.ts`：`DurableRunOwnership.acquire` 成功后受信，`finally` 中与租约释放一起撤销受信（仍保持 2595 行受控上限）。
- 测试：新增“受信 run 并发 append 仍严格串行、且不产生 `.events.lock`；撤销受信后恢复加锁”用例。全量 `vitest` **455/455 文件、3245 通过、1 跳过**；`typecheck` 0；`check:repo` 33/33。

**离线交错效果：** 短轮 delta **+138ms → +97ms**（runner 内部 +98 → +56ms），模型 p50 变为 next 更优（−4ms）。

### 10.57 第三十六轮（受信所有权后的交错真实复测）执行记录（2026-09-16）

**A. 无压缩短轮（交错，每路径 40 次）**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端 `/run` 中位 | 1,147 ms | 1,286 ms | **+139（+12.1%）** |
| runner 内部中位 | 1,095 ms | 1,194 ms | +99 |
| 模型延迟 p50 / p95 | 772 / 1,404 ms | 808 / 1,259 ms | **+36（+4.7%）/ −145（−10.3%）** |
| 请求数 / 失败 | 65 / 0 | 65 / 0 | 0 |

短轮中位差轨迹（交错口径）：+18.1% → **+12.1%**；p50 已达标（+4.7%），p95 反超（−10.3%），仅中位仍高于 5%（约 +80ms）。

**B. 压缩轮（交错）——本次出现大幅反转，需按方差处理**

| 指标 | shadow | next | 差值 |
| --- | --- | --- | --- |
| 端到端中位 | 2,779 ms | 4,648 ms | **+1,869（+67%）** |
| runner 内部中位 | 1,097 ms | 1,187 ms | +90 |
| 请求数 | 104 | **123** | **+19** |
| prompt / completion | 172,712 / 13,732 | 211,038 / 40,393 | +38,326 / +26,661 |

**结论（方差问题已定性）：** 压缩轮历次交错/顺序样本为 −27.9%、+67%、−6.1%、−32.6%、+33.6%，且**请求数随样本在 −9 与 +19 之间摆动**——在 `threshold=2` 下每个 run 都触发压缩，模型在“摘要+候选”上的产出差异直接改变调用次数。runner 内部两路径始终接近（~±90ms），说明**差异来自模型侧调用次数，不是本地开销**。因此压缩轮需要更大的每类样本（或固定候选产出）才能作为门依据，单次 40 run 不足以判定。

**费用：** 本轮 ≈ $0.092；自真实配对起累计 ≈ **$0.642 ≈ ¥4.56**，占 ¥10 预算约 46%。

### 10.58 第三十六轮（会话来源捕获缓存 + 交错复测综合）执行记录（2026-09-16）

**改动：** `conversation-source-store.ts` 的 `captureLocked` 增加**进程内 known-id 缓存**（记录 + size/mtime 指纹，上限 512）。同一 source 重复捕获时只需一次 `stat`（不再 `existsSync` + 读文件 + 解析 + 内容哈希）；指纹不符则回退到原有 fail-closed 路径，因此**外部同名改写仍被检出**（新增用例：后台把来源文件改成非法 JSON 后，捕获必须报错而不是返回缓存）。全量 `vitest` **455/455、3246 通过**；`typecheck` 0；`check:repo` 33/33。离线交错短轮 delta **+97 → +84ms**。

**交错真实复测：**

| 类别 | shadow 中位 | next 中位 | 中位差 | p50 | p95 | runner 内部差 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 无压缩短轮（40 次/路径） | 1,289 ms | 1,467 ms | **+178（+13.8%）** | **852 / 853（+0.1%）** | **2,196 / 1,585（−27.8%）** | +120 ms |
| 压缩轮（60 次/路径，3 轮） | 3,948 ms | 4,116 ms | +168（+4.3%） | **1,291 / 1,291（0%）** | 3,587 / 6,802（+89%） | +106 ms |

**跨轮综合（自交错配对启用以来的 4 次真实样本）：**
1. **runner 内部差稳定在 +100～+120ms**（已从最初的约 +250ms 降下来）；这是本地严格路径开销，也是我们所有优化作用的量级。
2. **模型延迟 p50 已完全持平**（短轮 +0.1%、压缩轮 0%）；短轮 p95 在最近两次样本中 next 分别 **−10.3% / −27.8%**（更优）。
3. **中位差波动 +4.3%～+18.1%**，其波动主要由模型侧（p95 与压缩轮请求数 −9～+19）主导，而非本地开销。
4. 因此 **5% 中位门仍未通过**，但已从 p50/p95 两个维度达标；中位残留（短轮约 +178ms 含模型时间、本地约 +120ms）属于「严格路径每 run 固定簿记」+「引擎差异」，继续优化的单项收益已进入 10ms 量级。

**本轮优化累计（可复用）：** 事件 store 增量缓存、replay 路径去重、inbox 增量缓存、inbox O(active) 校验、ingress 单锁批处理、**受信运行所有权免事件锁**、来源捕获 known-id 缓存。全部保持恢复/幂等特征测试通过。

**费用：** 本轮 ≈ $0.135（压缩轮加大到 3 轮/60 次）；自真实配对起累计 ≈ **$0.777 ≈ ¥5.5**，占 ¥10 预算约 55%。

### 10.59 第三十六轮（并行指纹校验 + 交错样本收敛判断）执行记录（2026-09-16）

**改动：** `durable-event-store.ts` 的 `cachedStampsMatch` 与 `durable-inbox-cache.ts` 的 `mutableStampsUnchanged` 从**串行 stat** 改为 `Promise.all` 并行（每次 append 前的 read 都要校验缓存前缀，串行时约 200 次 stat/run）。行为与 fail-closed 语义不变。全量 `vitest` **455/455、3246 通过**；`typecheck` 0；`check:repo` 33/33。离线交错 delta **+84 → +80ms**（在噪声内，说明本地优化已接近收益下限）。

**交错短轮样本序列（同一口径，四次独立复测）：**

| 样本 | shadow 中位 | next 中位 | 中位差 | p50 差 | p95 差 | runner 内部差 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| #1（第 5 轮） | 1,021 | 1,206 | +18.1% | +6.6% | +20.7% | +148 |
| #2（第 6 轮） | 1,147 | 1,286 | +12.1% | +4.7% | −10.3% | +99 |
| #3（第 7 轮） | 1,289 | 1,467 | +13.8% | +0.1% | −27.8% | +120 |
| #4（第 8 轮） | 1,504 | 1,754 | +16.6% | +5.3% | −12.4% | +148 |

**结论（据此定案）：**
- **中位差稳定在 +12%～+18%**，四次均未低于 5%；`p50` 在 0%～+6.6% 之间（贴近或达到 5%），`p95` 四次中有三次 **next 更优**。
- `runner` 内部差稳定在 **+100～+150ms**（起点约 +250ms），本地已无 10ms 以上的安全优化项；继续压缩需要**语义级改动**（跳过 execution-log settlement 提升、或减少 next 新增 durable 事件数），会触及恢复/幂等契约。
- 因此按当前门定义（shadow legacy 引擎 vs next 引擎、中位 5%）**无法通过**；已把三种处置选项提交用户决策（重定义基线 / 接受现状 / 授权语义级改动）。

**费用：** 本轮短轮复测 ≈ $0.02；自真实配对起累计 ≈ **$0.80 ≈ ¥5.7**，占 ¥10 预算约 57%。

### 10.60 第三十六轮（门基线重定义，用户决定）执行记录（2026-09-16）

**用户决定：** 重定义门基线（拒绝「按现状直接提交」与「授权语义级改动」两个选项）。

**理由（写入脚本注释与本节）：** 任务书 9.2 的 5% 相对门本意是「第二批完成态 vs 第三批候选」；本脚本必然比较 **legacy(shadow) 引擎 vs next 引擎**，两者每 run 的严格路径簿记是**结构性差异**（已实测：runner 内部差稳定 +100～150ms，起点约 +250ms），在中位 ~1s 的短轮上 5% 中位不可达。

**新门定义（`evaluateGate`）：** 保留 5% 相对阈值，但应用到能隔离候选改动的指标：
- **短轮类**：正确性守卫（`failedRuns=0`、接收率=1、验证通过率差不降）+ **模型延迟 p50 差 ≤5%** + **p95 差 ≤5%**；端到端中位仅作信息项。
- **压缩轮类**：正确性守卫 + **中位差 ≤5%** + **p95 差 ≤5%** + **请求数差 ≤0**。
脚本输出新增 `gate: { class, passed, informational, criteria }`，逐条可审计。

### 10.61 第三十六轮（重定义门下的真实评估与批准包）执行记录（2026-09-16）

**四次真实交错复测（短轮 2 次×40、压缩轮 2 次×40）：**

| 样本 | 门类 | passed | 关键判据 |
| --- | --- | --- | --- |
| short #1 | short-turn | **False** | p50 +4.6%✓、p95 −5.6%✓、接收率 1✓、验证差 0✓，但 **failedRuns=1** ✗ |
| short #2 | short-turn | **True** | p50 +1.3%✓、p95 −15.2%✓、failedRuns 0✓；信息项：中位 +7.5%、内部差 +66ms |
| comp #1 | compaction | **True** | 中位 **−29.6%**、p95 **−6.1%**、请求 **−18**、failedRuns 0 |
| comp #2 | compaction | **True** | 中位 **−42.3%**、p95 **−28%**、请求 **−16**、failedRuns 0 |

**失败归因（必须计入批准评估）：** short #1 的失败是 next 侧一次 500：
`waiting task response is ambiguous and was not claimed: model returned an invalid continuation disposition`（`continuation-disposition.ts` 在 `waiting_user` 后请模型给出 `kind`，2 次尝试仍非法则判 `ambiguous`；`runner.ts:1194` 选择**不认领**并显式失败）。同批 shadow 无失败。即：
- 这是**有意的 fail-closed**（不猜续跑、不伪造成功），符合 HC-04/HC-13 的「显式失败优于假成功」；
- 但它意味着在真实模型非确定性下，**next 会把一次歧义续跑变成用户可见的 500（本样本 1/40）**，而 legacy 路径不会。默认切换前需要明确接受或补一个有界重试/回退。

**批准评估包（提交，未擅自批准）：**
1. **性能（重定义门）**：压缩轮 2/2 通过且大幅更优；短轮性能判据（p50/p95）2/2 通过。
2. **正确性**：接收率 1.0、验证通过率差不降、0 重复权威回复；唯一失败为上述显式 fail-closed。
3. **已知代价**：短轮端到端中位 +7.5%～+8.9%（信息项，来自严格路径固定簿记 ~+66ms）。
4. **回退/准入要求**：切换需可验证回退（`autoMemoryPolicy` 单配置项回 `legacy-per-run`）；建议同时明确歧义续跑的处置（接受 500，或加有界重试）。
5. **仍未闭合项**：LS context/memory cache 观测缺失导致 `releaseGate` 仍 blocked（与该性能门相互独立）。

**费用：** 本轮 4 次真实复测 ≈ $0.18；自真实配对起累计 ≈ **$0.98 ≈ ¥7.0**，占 ¥10 预算约 70%。

### 10.62 第三十六轮（歧义续跑有界重试，用户有条件批准的前提）执行记录（2026-09-17）

**背景：** 10.61 的 short #1 出现 next 侧 1/40 的 500：模型对续跑 `kind` 返回**可解析但不在枚举内**的值时，`resolveContinuationDisposition` 直接判 `ambiguous`，`runner.ts` 随即 fail-closed 抛出，而 legacy 路径不经过该流程。

**改动（`continuation-disposition.ts`）：**
- 抽出 `askDisposition()`（`maxAttempts: 1`，单次询问 + 校验）。
- 流程改为：首次询问若得到枚举内 `kind`（含模型**显式**返回 `ambiguous`）即采用；只有**枚举外**结果才追加一次**纠正性重问**（附上"上一回复不合法、只允许这六种"的 assistant/user 轮次）；两次都非法才回落 `runtime_fallback → ambiguous`（仍然 fail-closed，不猜续跑）。
- 语义不变的部分：显式 `directive` 仍优先；`ambiguous` 仍不可被认领；失败证据/可恢复标记不变。

**测试：** `continuation-disposition.test.ts`（+3，共 5）：枚举外 → 纠正重问后采用合法值且 `chat` 调 2 次；模型显式 `ambiguous` 只调 1 次（不重问）；两次都非法仍返回 `runtime_fallback` 且总计 2 次调用。全量 `vitest` **455/455、3249 通过、1 跳过**；`typecheck` 0；`check:repo` 33/33。

### 10.63 第三十六轮（修复后真实复测：门全通过 → 批准条件达成）执行记录（2026-09-17）

| 样本 | 门类 | passed | 判据 |
| --- | --- | --- | --- |
| short #1 | 短轮 | **True** | failedRuns 0；p50 **−1.2%**；p95 **−16.2%**；信息项中位 +8.4%、内部 +68ms |
| short #2 | 短轮 | **True** | failedRuns 0；p50 **+3.9%**；p95 **−24.6%**；信息项中位 +14.4%、内部 +102ms |
| comp #1 | 压缩轮 | **True** | failedRuns 0；中位 **−51.7%**；p95 **−32.8%**；请求 **−18**；内部 **−52ms** |

**结果：** 修复后 3/3 样本通过重定义门；**120 次 next 运行零失败**，未再出现 `ambiguous_disposition` 500（单元测试另行验证纠正重问路径）。

**批准记录（条件达成）：** 用户于本轮选择「有条件批准：先补歧义续跑重试」；条件已实现并有单测+真实样本证据。据此 **默认切换（`memory.autoMemoryPolicy = 'compaction'`）按重定义门获批**，回退为单配置项改回 `legacy-per-run`。需要如实并列的边界：
1. 端到端**中位**仍比 shadow 高（信息项 +8.4%～+14.4%，本地固定簿记 +68～+102ms）——重定义门不以中位判定。
2. 若纠正重问后模型**再次**返回枚举外值，仍会 fail-closed（残余风险，已由"两次都非法"用例固定）。
3. `releaseGate` 因缺 LS context/memory cache 观测仍为 blocked，与本性能门相互独立，未因本次批准而改变。

**费用：** 本轮 3 次真实复测 ≈ $0.11；自真实配对起累计 ≈ **$1.09 ≈ ¥7.8**，占 ¥10 预算约 78%。

### 10.64 第三十六轮（缓存命中口径：DSH 互斥三计数 + LS 完整性守卫）执行记录（2026-09-17）

**背景（用户提问）：** LS 前端"缓存命中"显示很低，需判断是 harness 问题、算法问题还是其他。核对结论：
- **算法/字段映射不是系统性低估**：真实探测一次暖前缀调用得到 `prompt_cache_hit_tokens = prompt_tokens_details.cached_tokens = 1664`、`prompt_tokens = 1807`（92% 命中），两字段一致；LS 的 `cached/prompt` ≡ DeepSeek 的 `hit/(hit+miss)`。
- 前端显示的是**每轮（per-run）所有模型调用的 token 加权聚合**，且只在全部请求都上报 cache 字段时才给百分比（`run-usage.ts` + `assistant-turn.tsx`）；低值主要来自 harness 侧的**前缀稳定性与调用构成**（冷启动、各阶段小 prompt 各异、前缀中部动态内容、历史增长、DeepSeek 磁盘缓存 best-effort 过期）。
- 与 DSH 的口径差异在：DSH `TokenUsage` 是**互斥三计数**（`inputTokens`=未缓存、`cacheReadTokens`、`cacheWriteTokens`，billed=三者之和），LS 是"含 cached 的 prompt 总量 + 单列 cached"。

**用户决定：两者结合。本轮改动（采用 DSH 互斥模型 + 保留 LS 缺失不给数的守卫）：**
1. **适配器原生字段优先**：`packages/llm/src/client.ts` 改为 `prompt_cache_hit_tokens ?? prompt_tokens_details.cached_tokens`，并读取原生 `prompt_cache_miss_tokens`。
2. **未缓存输入成为一等字段（互斥）**：新增 `uncachedPromptTokens`，贯通 `llm/types` → `types/agent`(RunUsage) → `types/token-ledger`(ProviderTokenLedger) → `harness/cache-observability`(ValidProviderUsage + ledger `uncachedTokenCount`) → `harness/usage-state`（同样 all-or-nothing 求和 + 指纹）→ `harness/model-observability`（快照与事件）→ `app/run-usage`（全部上报才求和）→ 前端 footer。
3. **前端**：`未缓存输入` 优先显示提供方自报的 miss 数（此前是 `prompt − cached` 的减法），且在"命中数不完整"时也能显示真实未缓存量。
4. **不一致即拒绝**：新增 `cache_split_exceeds_prompt` 校验（`cached + uncached > prompt` 视为无效），durable ledger codec 同步白名单与校验。
5. **保留 LS 守卫**：任一请求缺 cache 数据时仍不编造百分比（显示"部分提供/未提供"）。

**验证：** 新增/更新 6 个用例（适配器原生优先与派生回退、聚合 all-or-nothing、footer 部分命中时显示真实未缓存量、ledger 互斥与非法拆分拒绝、报告 uncached 求和与缺失置空）。全量 `vitest` **455/455 文件、3254 通过、1 跳过**；`typecheck` 0；`check:repo` 33/33。

**未做（可继续）：** ① 前端/面板的**逐调用命中率**展开（现在只给一个混合数，冷的小调用会拉低观感）；② 在 footer/面板显示 top `invalidationReasons`，让低值自解释；③ 真实 Provider 侧的 LS context/memory cache 观测（`releaseGate` 仍 blocked 的那一项）。

### 10.65 第三十六轮（逐调用命中率 + 失效原因投影）执行记录（2026-09-17）

**用户要求（按优先级）：** 1) 逐调用命中率展开；2) footer/面板显示 top `invalidationReasons`；3) LS 侧 context/memory cache 观测。

**第 1+2 项已完成（数据本就在执行日志里，无需新增持久化）：**
- 新增 `packages/app/src/shared/cache-call-observations.ts`：把 `ExecutionLog.modelRequests[].cacheObservation` 投影为有界的逐调用记录（`requestIndex/stage/status/tokenCount/cachedTokenCount/uncachedTokenCount/hitRatio/reasons`），并汇总 top 失效原因（按次数排序、上限 5）；调用条数上限 12 且标记 `callsTruncated`。
- `history-activity.ts` 把这组投影挂到**拥有该 run 的 assistant 消息**（`cacheCalls`/`cacheReasons`/`cacheCallsTruncated`）；`renderer/chat/types.ts` 的 `ChatMessage` 同步字段；`assistant-turn.tsx` 的用量 footer 新增可展开明细：
  - 每行 `#序号 阶段 · 命中/部分命中/未命中/未观测 N%`，并给出 `输入/缓存读取/未缓存` 计数与**该调用的原因**（中文标签映射 18 个 `CacheInvalidationReason`）；
  - 展开尾部显示 `主要原因：<原因>×<次数>`。
- 投影只带计数与运行期分类原因，**不含任何提示词文本**（有单测锁定字段集合）。

**验证：** 新增 3 个测试文件/用例（投影有界与 top 原因排序、history 挂载与字段白名单、footer 展开渲染与 61% 混合值对照）；全量 `vitest` **456/456 文件、3258 通过、1 跳过**；`typecheck` 0；`check:repo` 33/33；因渲染层改动重建（build output `9a1a5753…`）并复跑两条 Electron 路由，均 ok（ui-state localFeedback 142ms、decideRequests=0）。

**第 3 项侦察结论（需要用户决策）：**
- **memory embedding 有真实可观测的复用**：`v3/catalog.ts:521-539` 在 upsert 时比较 `embedding_hash`，未变化时保留 `ready` 向量、不重嵌入（`v3-backend.test.ts:481` 以 `engine.embed` 调用次数证实）。要把它变成 ledger 需要跨层贯通：catalog upsert 返回复用标记 → v3 backend → `MemoryWriteResult` → 运行期累计 → `createCacheObservation`（约 5–6 个文件，触及写入热路径）。
- **`lsContext` 目前没有任何上下文缓存可观测**：`cache-observability.ts:223-230` 明确硬编码 `unavailable`（注释："Context assembly is not a cache lookup. Keep the local ledger unavailable until Context Engine reports a real reuse event."），Context Engine 只有 tokenizer 计数记忆化，没有前缀/条目复用缓存。
- 因此 `context_cache_not_observed` **无法靠"接现有信号"消除**，只有两条路：**A) 在 Context Engine 里真的做一层以指纹为键的装配前缀/条目复用缓存**（新功能，能同时减少我们自己的可避免前缀抖动）；**B) 承认 LS 侧不存在该缓存，把 `context_cache_not_observed` 从 blocked 原因改为 not-applicable**（改门语义）。这属于产品/范围决策，需用户裁定后再动。

**用户裁定：选 A（真的做一层上下文复用缓存）。** 第 3 项据此拆成两半，本轮完成 context 一半：

### 10.66 第三十六轮（Context Engine 真实复用缓存 + lsContext ledger）执行记录（2026-09-17）

**改动（context 半）：**
1. 新增 `packages/context/src/context-engine/reuse-cache.ts`：以**装配输入指纹**为键（stage / callContract / provider / model / 预算上界 / 完整 base request / 候选的 id、order、required、priority、evictionGroup、message、segments）做 content-addressed 复用缓存（LRU 上限 32），并提供 `resolveContextReuse()`（判 hit/miss 并算 reused/rebuilt 条目数）与 `storeContextReuse()`。
2. `ContextEngine.prepare()`：指纹命中时**直接复用上次的驱逐决策、精确 token 计数与安全估计**，跳过 tokenizer 重算；未命中才走原有计数/驱逐路径并落缓存。命中与未命中的快照对同一指纹完全一致（含 `safetyEstimate`/`localTokenLedger`）。
3. `ContextSnapshot` 新增内容为空的 `contextReuse: { status, reuseKey, reusedItems, rebuiltItems }`（types + snapshots 构建）。
4. `cache-observability`：`lsContext` 不再硬编码 unavailable，改为 `contextReuseLedger()`——有事件时上报 `hit`/`miss`（原因 `context_assembly_reused` / `context_assembly_rebuilt`），无事件时保持 `unavailable`（**绝不估算**）；`model-observability` 把快照的 `contextReuse` 作为运行期事实传入。

**验证：** 新增/更新 3 处用例：引擎同输入两次 → 第一次 `miss`、第二次 `hit` 且 **tokenizer 只被调用 1 次**、两次装配结果与 ledger 一致；observation 有/无复用事件分别上报 hit/miss 与 unavailable；报告在 `lsContext` 被观测后 **不再** 出现 `context_cache_not_observed`（`memory_cache_not_observed` 仍在，因为 embedding 半未做）。全量 `vitest` **456/456、3261 通过、1 跳过**；`typecheck` 0；`check:repo` 33/33。

**卫生：** 本次改动一度触发两条棘轮——`packages/context/src/engine.ts` 216 > 180（核心热点未继续增长）、`cache-observability.ts` 689 > 680（受控上限）。按仓库规约**拆分而非涨上限**：快照装配下沉为 `buildPreparedSnapshots()`、安全估计构造下沉为 `counting.buildSafetyEstimate()`、复用判定/落盘下沉为 reuse-cache 的两个函数，engine.ts 回到 **177 行**；ledger 助手压缩后 cache-observability 回到 **≤680**。

**仍待完成（第 3 项 embedding 半）：** 把 memory v3 已存在的 embedding 复用（`v3/catalog.ts:521-539`）排水为运行期事实，接到 `memoryEmbedding` ledger（同样只上报真实 reused/queued 计数），以清掉 `memory_cache_not_observed`。

### 10.67 第三十六轮（memory embedding 复用 ledger：releaseGate 两个本地原因全部可观测）执行记录（2026-09-17）

**改动（embedding 半，全部只上报真实事件）：**
1. 新增 `packages/memory-tree/src/v3/embedding-reuse-tally.ts`：`embeddingReuseOutcome()`（eligible/changed/previousStatus → `reused`/`queued`/`disabled`，即"未变化且已有 ready/stale 向量"判为复用）、`EmbeddingReuseTally`（按次计数 + drain 重置）、以及求和/是否观测到的小工具。
2. `v3/catalog.ts`：`upsertAtomInTransaction` 在算出 `embeddingChanged`/`embeddingEligible`/旧状态后 `record()` 一次；新增 `drainEmbeddingReuse()`。
3. `memory-repository/v3-backend.ts`：`write(intent)` 先在写入前清空旧噪声，写入完成（维护之前）drain 本次的真实结果，仅在观测到时挂到 `MemoryWriteResult.embeddingReuse`。
4. `types.ts`：`MemoryWriteResult.embeddingReuse?: { reused; queued; disabled }`。
5. harness：`MemoryIntentDecisionRecord.embeddingReuse`（既有记忆决策记录，无需新增 RunContext 字段），`memory-intent-gate.decisionRecord()` 从写入结果带上；`memory-state.sumMemoryReuse(ctx)` 做运行期累计；`model-observability` 把它作为运行期事实传给 `buildCacheObservation`。
6. `cache-observability`：`memoryEmbedding` 不再硬编码 unavailable，改为 `memoryReuseLedger()`——`queued=0` 记 `hit`（`embedding_reused`）、`reused=0` 记 `miss`（`embedding_rebuilt`）、两者都有记 `partial`（`embedding_partially_reused`），并给出 `tokenCount/cachedTokenCount/uncachedTokenCount/hitRatio`；无事件时保持 `unavailable`（**绝不估算**）。

**验证：**
- **端到端集成**（`memory-service-v3.test.ts`）：带 embedding 引擎的 v3 仓储，同一载荷写两次 → 首次 `queued > 0`，未改写的重写返回 **`{ reused: 1, queued: 0 }`**，证明信号真实贯通（catalog → backend → `MemoryWriteResult`）。
- 单元：tally 分类/drain/求和；ledger 四种状态（unavailable/hit/partial/miss 与 hitRatio）；报告在 `memoryEmbedding` 被观测后**不再**出现 `memory_cache_not_observed`，且与 `context_cache_not_observed` 一并消失。
- 全量 `vitest` **457/457 文件、3267+ 通过**；`typecheck` 0；`check:repo` 33/33。

**卫生（同样以拆分消化，未涨上限）：** 一度触发三条受控上限（`cache-observability` 703>680、`model-observability` 714>705、`runtime-contracts` 937>925）。拆分：本地 ledger 助手移入新 `packages/harness/src/cache-local-ledgers.ts`；`sumMemoryReuse` 移入 `memory-state.ts`；`ContextReuseEvent`/`MemoryReuseCounts` 移入 `types/src/cache-observability.ts`（由类型包 index 重新导出，外部引用不受影响）。`catalog.ts` 追加后 637 ≤ 640。

**结论：** `releaseGate` 的两个本地 blocked 原因（`context_cache_not_observed`、`memory_cache_not_observed`）现在都能被**真实运行事件**观测并解除；embedding 未启用时仍如实记为未观测。余下与该门无关的既有项（如 `real_provider_reconciliation_not_verified`）不受影响。

### 10.68 第三十六轮（"DSH 99% vs LS 50%"口径核查：长会话实测）执行记录（2026-09-17）

**用户疑问：** DSH 缓存命中率可达 99%+，LS 连 50% 都不到。

**核查 1（DSH 口径，外部资料）：** DSH 的 97–99% 是**单会话、长会话**数字，成立条件是"**system prompt 整个会话不变 + 历史纯追加**"（社区文章明确：该数字为 Reddit 自报、并未经审计，且模式切换/换模型/动态内容注入都会破坏它；DSH Web UI 显示的是**每会话**命中率）。参考：[How DeepSeek Harness Hits 99% Cache Hit Rates](https://dev.to/justin3go/how-deepseek-harness-hits-99-cache-hit-rates-explained-1bgf)、[DeepSeek Context Caching 文档](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)。

**核查 2（我们自己的口径问题）：** 对比脚本此前**每轮新建 session**（`verify-path-{mode}-r{round}-s{n}`），40–60 次运行被切成 2–3 段**冷启动短会话**——结构上最不利于缓存，与 DSH 的长会话不可比。为此新增 `LITTLESHEEP_COMPARISON_SHARED_SESSION=1`：同一会话跑满全部轮次，并逐轮记录累计命中率（`paths[].cacheTrend`）。

**核查 3（长会话实测，真实 Provider，4 轮 × 20 次/路径 = 80 次/路径）：**

| 轮次 | shadow 累计命中率 | next 累计命中率 |
| --- | --- | --- |
| 0 | 50.2% | 46.8% |
| 1 | 52.6% | 50.0% |
| 2 | 45.8% | 49.2% |
| 3 | 46.6% | 52.2% |

**关键结论（重要，且与预期相反）：** 会话变长**并没有**把 LS 推到 DSH 量级——两类路径都**稳定在 ~50% 平台**，不随前缀增长而收敛到 90%+。因此：
1. "每轮新建 session"确实是**测量偏差**（必须修，已修）；
2. 但 LS 的低命中率**不只是测量偏差**，而是**真实的结构性前缀问题**：每次请求的提示词前缀里存在会话内会变化的内容（记忆/任务书/权限/工作区/摘要等），或不同阶段使用不同 system prompt，导致"从变化点之后（含整段历史）全部 miss"。
3. 该实验还暴露一个工作负载副作用：同一会话重复跑同一批任务时失败率上升（shadow 17/80、next 2/80），门判定 False——这说明重复同一批任务不是自然负载，长会话结论应只看命中率趋势，不看该次门判定。

**下一步（待用户定）：** 用本轮已落地的**逐调用命中率 + top 失效原因**前端/报告能力定位"变化点在提示词哪个位置"（免费方案：读本地 `cache-quality` 报告与逐调用证据；或追加少量真实预算做定向诊断），再决定是"把动态内容移到尾部"还是"阶段提示词收敛"。

**预算：** 本次长会话实验按 token 估算约 ¥1；自真实配对起累计 ≈ **¥10 上限已用尽**。后续真实 Provider 复核需追加预算。

### 10.14 第七轮（HC-12 撤销屏障）新增证据（2026-09-16）

**问题（先写失败用例）：** v3 写入路径的等值/相似候选只按 branch/scope/`status='active'` 选取；被纠正（`epistemicStatus`/`resolutionStatus = superseded`）或删除（`status = tombstone`）的 atom 仍可能是 active 记录。后续 maintenance（压缩候选）证据即使引用同一 `conversation-source:`，也会创建新 atom 或强化旧 atom，从而复活已被用户忘记/纠正的事实。`memory-service-v3.test.ts` 的新用例在修复前返回 `created`。

**修复：** `packages/memory-tree/src/memory-repository/v3-node-store.ts` 在 `writeInternal` 对 `sourceStage === 'maintenance'` 的写入增加 `revocationBarrier`：
- 列出同 branch/scope 的全部 atom（含 tombstone/superseded）；
- 若其 `sourceRefs` 与本次 intent 的 `sourceRefs` 有交集，且该 atom 处于 tombstone 或 superseded，则拒绝写入（`decision: 'rejected'`，reason 指出重叠的 revoked memory），并写入审计；
- 普通 EVOLVE/CAPTURE 写入不受影响；用户重新明确授权会产生新的有效版本（新来源/新原子），不被旧来源封锁。

**测试：** `memory-service-v3.test.ts` “does not let a maintenance write revive a tombstoned fact from the same conversation source”——删除后同来源 maintenance 写入被拒绝且不产生新 atom。C10B 矩阵 HC-12 由「未覆盖」变为「通过（离线）」。

**剩余：** supersede（纠正）而非 delete 的 runner 端到端、以及 tombstone 对 summary/源召回注入的联动仍需补测；压缩候选结算把 barrier 拒绝记录为 candidate outcome `rejected` 由既有恢复测试覆盖。

### 10.15 第八轮（HC-07 压缩提案校验与失败归因）新增证据（2026-09-16）

**问题（失败先行）：** `callLlmForJson` 在 schema/来源校验连续失败时返回 `{ parsed: null, lastResponse }` 而不是抛错；`compactSessionAfterRun` 随后用 `legacyCompactionResponse(response.lastResponse.content)` 回退，把**未通过校验的 JSON 提案原文当成纯文本摘要**写入 session metadata。新用例证明：来源越权的候选会导致写入一份伪造摘要。

**修复：**
1. `packages/runner/src/session-continuity.ts` 的 `legacyCompactionResponse` 只接受非 JSON 形状的纯文本（以 `{`/`[` 开头的一律不当作摘要），使校验失败走 `throw` → 有界失败、旧摘要/原文保留。
2. `SessionCompactionScheduler` 的 `run` 回调改为返回 `SessionCompactionRunResult`（`compacted` / `no-new-range` / `failed`），失败在 operation 记录上标记 `status: 'failed'` 与 `error`，但不让 run 失败；`runCompactionAttempt` 相应返回结构化结果（仍兼容旧 `boolean`）。

**新增测试：**
- `runner.test.ts` “keeps the previous transcript when a compaction proposal cites an uncovered source”：2 次有界尝试、无 summary、无 pending、原文前缀逐 id 不变、`compactionOperations()` 记录 `failed`。
- `runner.test.ts` “keeps plain-text compaction summaries working for legacy callers”：JSON 守卫不破坏旧纯文本协议（HC-18）。
- `session-compaction-scheduler.test.ts`：`failed` attempt 映射为 operation failure。

C10B 矩阵 HC-07 由「部分」变为「通过（离线）」。

**剩余：** 压缩调用的显式 Provider 超时注入；operation `failed` 的 UI/历史投影（C12/C10B）。
