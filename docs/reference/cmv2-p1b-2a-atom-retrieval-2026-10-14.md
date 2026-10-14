# CMv2 P1B-2A：Atom 检索授权实施与验收（含补充强制要求）

日期：2026-10-14。基准提交：`e8cfdfb403802431011e5198cac7916e81ce96fd`。前置：[P1A](cmv2-p1a-memory-access-2026-10-14.md)、[P1B-1](cmv2-p1b-1-memory-authority-2026-10-14.md)、[P0A](cmv2-p0a-context-audit-2026-10-13.md)、[P0B](cmv2-p0b-context-inspector-2026-10-13.md)。本阶段只实现隔离测试中的 Atom 检索授权，并按补充强制要求复核、补强与验收；不切换生产默认，不迁移用户数据，不进入 P1B-2B/P1B-2C。

## 0. 补充强制要求对照

| # | 补充要求 | 结论 | 主要证据 |
|---|---|---|---|
| 1 | propagation-only 与测试专用 enforced 区分；模式只由可信 Host/受控测试决定；模型/Renderer/工具/普通配置不能启用或绕过；生产默认不变；enforced 失败必须拒绝且不回退 legacy/global | 满足 | [memory-access-context](../../packages/memory-tree/src/memory-access-context.ts)、[atom-read-authorization](../../packages/memory-tree/src/atom-read-authorization.ts)、[memory-service](../../packages/memory-tree/src/memory-service.ts)、[composite-memory-branch](../../packages/memory-tree/src/composite-memory-branch.ts)、[run-support](../../packages/app/src/main/local-app-api/run-support.ts)；§1 |
| 2 | 真实可信所有权接口；不按 Atom 自身 scope 标签授权；无审核记录按 pending；夹具可显式构造 reviewed；entity revision 变化必须重查；v2/v3 分别验证 | 满足 | [memory-ownership-bindings](../../packages/memory-tree/src/memory-ownership-bindings.ts)；v2 指纹与 v3 revision 两套独立协议；§2 |
| 3 | 先权限过滤再排序/计数/索引展示；覆盖 9 类路径；候选取得与实体物化前后检查；越权 Atom 不影响标题/ID/数量/排序/截断/错误 | 满足 | [tree-memory-branch](../../packages/memory-tree/src/tree-memory-branch.ts)、[v3-retrieval](../../packages/memory-tree/src/memory-repository/v3-retrieval.ts)、[v3 materializer](../../packages/memory-tree/src/memory-repository/v3-retrieval-materializer.ts)、[catalog-helpers](../../packages/memory-tree/src/v3/catalog-helpers.ts)、[catalog-fts](../../packages/memory-tree/src/v3/catalog-fts.ts)、[catalog-relation-routing](../../packages/memory-tree/src/v3/catalog-relation-routing.ts)；§3 |
| 4 | 读取使用 run 绑定上下文；拒绝调用者自造策略/祖先链；授权过期即停且无旧缓存授权；识别 TOCTOU；为 P1B-2C 留接口与测试方案 | 满足（TOCTOU 本阶段只识别并给出方案，不实现全链路撤销） | sealed grant/context/gate；§4 |
| 5 | 仅做 Atom 检索隔离；不改写入默认、不迁移、不做 P2、不改 Inspector 账本口径 | 满足 | §5；六个组装 wireBytes 与 `check:repo` |
| 6 | 权限矩阵、v2/v3 真实 Runner 集成、越权候选、版本失效、传播对照；明确四类边界 | 满足 | §6、§7 |

本阶段结束时**没有**宣称完整记忆隔离，也**没有**改变任何生产默认行为。

## 1. 授权执行模式（补充要求 1）

模式只在 sealed grant 解析时确定：`MemoryAccessSnapshot.enforcement` 为 `'propagation-only' | 'enforced'`，由进程内特权 `issueMemoryAccessGrant` 的 resolver 返回，[bindMemoryAccessGrant](../../packages/memory-tree/src/memory-access-context.ts) 对枚举做校验。普通 JSON 对象没有 WeakMap 证明，无法构造 grant/context/gate。

- **子任务继承**：`issueChildMemoryAccessGrant` 传递父模式，绑定阶段使用 `parent?.snapshot.enforcement ?? resolved.enforcement ?? 'propagation-only'`，子任务既不能升级也不能降级。该继承在 grant 层有独立测试；`MemoryService.createChildRunAccessGrant` 当前没有任何 Runner 调用方，因此“子运行装配”本身本阶段未验证，只有其授权继承语义已验证。
- **不可由模型/Renderer/工具/配置启用**：`CreateRunnerOptions.memoryOwnershipBindings` 与 `RunInput` 无 enforcement 字段；Main 的 [assertClientMemoryAuthorizationAbsent](../../packages/app/src/main/local-app-api/run-support.ts) 额外拒绝 `memoryAccessEnforcement`、`memoryOwnershipBindings` 等客户端字段；[createHostMemoryAccessGrant](../../packages/app/src/main/memory-access-host.ts) 的生产 resolver 从不返回 enforced。`memory_tree` 工具按字段显式构造请求，Zod 丢弃未知键（新增回归测试，见 §6）。
- **生产默认保持原行为**：Main 签发器与无句柄 standalone adapter 均为 propagation-only；`atomReadAuthorization` 在非 enforced 时返回 `undefined`，分支仍走原有 Composite 合并与 legacy 路径。
- **enforced 失败拒绝、不回退**：缺 ownership store、授权过期、底层受保护读取失败统一抛 `MemoryAccessAuthorizationError('Memory authorization unavailable')`；enforced Composite 只执行存储 Atom 分支，不调用 legacy/project 外部来源；`MemoryTree` 与 Runner 初始记忆路径不吞掉该异常。

## 2. 所有权证据（补充要求 2）

权限来源是 Host 注入的 [MemoryOwnershipBindingStore](../../packages/memory-tree/src/memory-ownership-bindings.ts) 中的 reviewed target 与 sealed policy，**不读取** `Atom.scope/scopeKey/authorityScope`。

| 后端 | 实体证据 | 说明 |
|---|---|---|
| v2 | `v2:<完整 MemoryNode JSON 的 SHA-256>` | v2 没有 v3 的单调 revision；Host 审核时记录节点指纹。节点或层级变化后旧指纹失效。顺序为：查绑定 → 读既有节点 → 复核指纹 → 再读核对。底层整份 index.json 解析不可避免，但未授权节点不会进入排序、计数或投影 |
| v3 | `v3:<Atom.revision>` | Catalog revision、Atom 文件 revision 与绑定一致才提名；物化后再读文件并复核。派生 Catalog 或旧 revision 不能作为授权证明 |

没有绑定、binding 非 `reviewed`、跨所有者/数据根/项目/会话、disabled、manual 未选中、revision 不符一律不允许；**没有审核记录的旧 Atom 按 pending 处理**。隔离夹具通过特权测试显式 `compareAndSet` 构造 reviewed 绑定并显式重新审核，生产没有任何自动审核或按 scope 自动授权的路径。实体内容变化后旧绑定失效并保留数据；重新审核是显式 Host 动作。v2/v3 的所有权语义分别实现、分别测试，不互相假定。

## 3. 检索边界（补充要求 3）

所有路径先过滤再排序/限额/投影。v3 在 SQL `WHERE` 内应用 `authorizedAtomIds`（`listAtoms`/`listChildren`/`searchFts`/`searchPreparedVector`/relation routing 的递归子树与候选），v2 先按绑定提名节点再评分。

| 路径 | v2 | v3 |
|---|---|---|
| branch index | 仅从授权绑定提名，排除 inactive/root，`summary`/`truncated`/计数均只统计授权项 | 候选 SQL 过滤后再排名、限额、投影 |
| exact-node | 未绑定/版本不符与未知 ID 同样返回空，不调用 legacy 精确读取 | `readAuthorized` 先查授权集合与 Catalog revision，再读文件复核 |
| initial prime/refine | 初始 index 与 expand 均经 gate；refine 在跳过重复查询前也检查授权 | 同左 |
| FTS | v2 无原生 FTS；原词匹配只在授权节点集合运行 | 授权过滤在排序/limit 之前；enforced 下不使用全库 BM25 分数，改用授权实体 task relevance，避免文档频率影响排序 |
| vector deep-search | v2 无原生 vector，不伪装为已验证路径 | 向量 SQL 候选过滤在余弦排序/限额之前；只有 deep-search 才准备查询向量 |
| activation/hierarchy fallback | 只对授权节点按重要性排序 | hot/recent 查询过滤后再合并与截断 |
| relation routing | v2 无原生路由，不降级为 legacy 跨源查找 | 授权 seed 与 destination，路由 SQL limit 前过滤，读取 destination 前后各核对一次 |
| subtree/children | 仅在授权节点集合内追踪祖先，拒绝未授权 subtree root，`childIds` 过滤 | 未授权 root 直接清空集合；SQL 子项过滤并在返回前核对 |

enforced v2 在投影授权节点时保留**固定分支根 ID**（`<branch>:root`，`metadata.rootNodeId` 中本就模型可见）作为导航父节点，使 `expand(branchRoot)` 仍能返回授权顶层子项，而不是清空 `childIndex`；未授权的真实父节点仍被抹除。

**物化与元数据**：v3 materializer 在评分前再次过滤候选，评分与限额只针对授权集合；从全库 relation aggregate 的加权在 enforced 下被禁用；`parentId`/`mergedFromAtomIds`/`childIds` 只保留授权 ID；`entityRefs`/`relationRefs` 清空；`neighborhood` 与 D3 `history` 在 enforced 下不返回（D3 仍返回当前已审核 Atom 正文及其证据封套，但不因此获得历史修订或其他实体的许可）。错误信息统一为固定文本，不携带 ID 或内容。

越权候选测试：在 240 个越权候选加入前后，授权 index 投影**完全相同**，`read` 从未以 `PRIVATE_` 前缀 ID 调用；新增的 v2/v3 反例覆盖 exact/children/subtree/expand/deep-search/relation 与数量、排序、截断。

## 4. 运行时有效性（补充要求 4）

### 4.1 run 绑定与密封策略

`atomReadAuthorization(runId)` 只能从 `MemoryService` 的私有 run→context Map 取上下文；gate 由模块私有 WeakSet 证明，`assertAtomReadAuthorization` 拒绝结构相似的自造 gate 与 JSON 拷贝。[evaluateMemoryAccessContext](../../packages/memory-tree/src/memory-access-context.ts) 每次使用 sealed context 的完整祖先交集，**不接受调用者传入的 policy 或 ancestor list**；`MemoryRepositoryIndexRequest.authorizedAtomIds` 在存在 gate 时由内部 `authorizedRequest` 覆盖重算（新增回归测试）。

### 4.2 过期与缓存

gate 不缓存 allow 决定：每次 `allows` 前后都执行 `assertCurrent()`，并复核绑定 revision；`references()` 亦先 `assertCurrent()`。上下文关闭/底层 `current()` 返回 false 时受保护读取抛出固定错误。memory-tree 不缓存分支索引或“已允许”结论，`branchIndex`/`prime`/`refine`/`expand`/`release` 每次都重新走授权回调。`pruneAtomReadState` 在新读取前清除 KnownState、activeFragments 与 dedup 工作集中的失效 Atom，并在清理时写 `ledger.knownState.updatedAt`、以 `authorization-prune` 阶段与“不再被授权读取”原因记账，避免把授权清理误记为模型主动释放。

### 4.3 TOCTOU（本阶段只识别）

已返回的片段可能在授权撤销前被 Harness 装配；Session History、runtime tail、上下文复用、已落盘 checkpoint/日志或历史 Provider 请求不由 Atom gate 回溯删除。因此当前接口**最后复核到真正 Provider send 之间仍存在撤销窗口**，本阶段不提供完整撤销安全保证。

### 4.4 留给 P1B-2C 的接口与测试方案

**接口**：由 Runtime 在受保护读取成功时记录 Atom read manifest（run/session、context identity、policy revision、project binding revision、ownership binding revision、entity revision、实际进入 Context 的 fragment/atom 范围）。manifest 只能由 Runtime 在 gate 成功返回路径上写入，不接受模型/Renderer 自报。复用 `isMemoryAccessCurrent` 与 sealed gate，在 Context working set、复用缓存、checkpoint 恢复、发送前四处共同 revalidation；失效后丢弃受影响片段或拒绝发送；扩大授权必须取得新的 Host 快照。entity ID 列表与实体版本校验必须来自可信 Context 装配记录，不能只检查 `policy.version`。

**测试方案**：在 branch 返回→Context 注入、注入→cache hit、checkpoint restore→prepare、prepare→Provider send 四处设置确定性 barrier；分别撤销设置、项目绑定、ownership binding 与实体 revision；断言被拒绝的正文/ID 不再进入 outbound 请求、拒绝时无 LLM 调用、不能恢复旧 allow 缓存；保留会话历史与合法工具对，并覆盖取消与并发发送。该全链路测试本阶段**未执行**。

## 5. 工程范围（补充要求 5）

本阶段只实现 Atom 检索隔离。未修改：记忆写入生产默认值、真实用户记忆、P2 Token 优化、Context Inspector 账本口径与圆环选数实现、Renderer、Prompt、工具目录、日志持久化格式。`pruneAtomReadState` 只在 enforced 路径清理 run 内工作集/KnownState，不改变 propagation-only 的 ledger 记账与持久格式。

## 6. 验收证据（补充要求 6）

### 6.1 权限矩阵（隔离环境）

[atom-read-authorization.test.ts](../../packages/memory-tree/src/atom-read-authorization.test.ts)：自造 gate/JSON 拷贝被拒；same project→allow、readMode none→deny、cross project→deny、global 未选中→deny、显式 global→allow、manual selected→allow、manual 跨项目→deny、disabled→deny、pending→deny、不同 owner/root→deny、revision 不符→deny、未知 ID→deny；子任务继承 enforced；绑定撤销后立即 deny；运行期授权失效后 `references()` 抛错。

### 6.2 v2/v3 真实 Runner 集成与传播对照

[atom-access.integration.test.ts](../../packages/runner/src/atom-access.integration.test.ts)：`it.each(['v2','v3'])` 使用临时数据根、虚构记忆、合成 LLM 与真实 `createRunner`。断言：越权 Atom 不出现在 index、expand、childIndex 或 outbound 请求中；授权 Atom 正常进入；实体 revision 变化后 index 为空且 KnownState 不再引用；上下文失效后 `branchIndex`/`deepSearch`/`release` 抛固定错误；**同一数据根上 propagation-only run 仍能读到 `PRIVATE_ATOM`**（兼容对照）。第二个用例断言缺 ownership store 的 enforced 启动被拒且无 LLM 调用，普通 Config 字段与 run 参数都不能启用 enforced。

### 6.3 越权候选与版本失效

[atom-retrieval-authorization.test.ts](../../packages/memory-tree/src/memory-repository/atom-retrieval-authorization.test.ts)：240 个越权候选前后投影等价、无越权正文读取；FTS/vector/fallback/children/subtree/exact 均只返回授权项；relation routing 在 limit 前过滤；候选取得与物化两处版本复核（含故意陈旧的派生 Catalog 与读取竞态注入）；调用者自造 `authorizedAtomIds` 被覆盖。[atom-v2-authorization.test.ts](../../packages/memory-tree/src/atom-v2-authorization.test.ts)：v2 exact/children/subtree/索引过滤、父实体重审后 `hasChildren` 收窄、底层错误不泄露为模型可见信息。

### 6.4 本次验收的独立复验

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm run typecheck` | exit 0（修复后复跑） |
| 定向授权/集成/Main 测试 | `pnpm exec vitest run <8 个相关文件>` | 8 文件 / 71 项通过 |
| 广泛记忆 + Runner 回归 | `pnpm exec vitest run packages/memory-tree packages/runner/src/{memory-v3.integration,runner,context-baseline}.test.ts packages/app/src/main/memory-{files,files-api,access-host}.test.ts packages/harness/src/stages/memory-epistemic-policy.test.ts` | 67 文件 / 545 项通过 |
| 传播默认对照 | `pnpm exec vitest run packages/runner/src/context-baseline.test.ts` | 六个组装 wireBytes 复现为 22663/23058/22930/23794/23326/24674，与 P1B-1 基线一致（tokenizer 本次 unavailable，不重新校准 Token） |
| 仓库卫生 | `pnpm run check:repo` | ok（35 通过 / 3 提示 / 0 失败） |

说明：六个 wireBytes 由 `context-baseline.test.ts` 计算并 `console.log`，**没有断言**，本次是人工比对；因此“字节不变”是实测证据而非 CI 守卫，后续应补断言。仓库卫生的三条提示为模块拆分地图计数漂移与 `memory-tree.ts` 因本阶段新增（`pruneAtomReadState` + 授权异常直通）实测 681 超过 600+ 受控上限 660；均为非硬门提示，不影响 `check:repo` 通过。已在 [module-split-map](../../docs/reference/module-split-map.md) 登记该超额与下一步拆分方向（先下沉 `pruneAtomReadState` 与授权异常直通），供 P1B-2B 处理。

本次共新增 4 条与本阶段要求直接对应的回归断言：`memory_tree` 工具参数不能夹带 `authorization`/`authorizedAtomIds`/`enforcement`（工具传给服务的 options 键集合被逐一断言）；v3 请求上自造的 `authorizedAtomIds` 被 sealed gate 覆盖；enforced v2 的 `expand(branchRoot)` 仍返回授权顶层子项且不含越权 ID；撤销后 `release` 同样拒绝。

### 6.5 独立对抗性审计与本轮修复

本阶段验收时对未提交改动做了两次独立的只读对抗性审计（一次针对绕过/泄露，一次针对 propagation-only 兼容性），结论与处置：

| 审计发现 | 判断 | 处置 |
|---|---|---|
| 已物化片段在撤销后仍随 `ctx.initialMemoryContext`/`memoryKnownState` 与 ExecutionLog 反复发给 Provider | 属补充要求 4 明确要求“识别”的 TOCTOU，全链路撤销归 P1B-2C | 不实现，写入 §4.3/§7.4 |
| 无 Host 句柄的入口（channel/CLI/standalone adapter）静默使用未加 gate 的 legacy 检索，缺少 fail-closed 总开关 | 生产默认必须保持原行为；总开关属迁移/发布门禁 | 不实现，写入 §7.2 |
| `memory_manage` 的 `inspect` 与 Renderer/loopback 管理路由可无 gate 读取任意 Atom（含 D3 正文、历史、导出） | 属 P1B-2B（管理面与其他旁路） | 不实现，写入 §7.2/§7.3 |
| `MemoryResourceBranch`（`resources` 分支）不消费 sealed policy | 属 P1B-2B（Resource 旁路） | 不实现，写入 §7.2 |
| enforced v2 清除顶层节点的 `parentNodeId`，导致 `expand(branchRoot)` 返回空 `childIndex` | 新 enforced 路径的导航缺陷（fail-closed 但不等价） | **已修复**：保留固定分支根 ID 作为导航父节点；新增 v2 回归断言 |
| `pruneAtomReadState` 把授权清理记为“模型主动释放”，且补删 KnownState 引用时只增 `revision` 不更新 `updatedAt` | 新 enforced 路径的账本口径缺陷 | **已修复**：`releaseWorkingSetAtoms` 支持阶段/原因注入，授权清理记 `authorization-prune`；补 `updatedAt` |
| `MemoryService.release` 未走授权检查，撤销后仍可返回未清理的 KnownState | 与其余受保护读取不一致 | **已修复**：`release` 前后各检查一次授权；Runner 集成断言撤销后 `release` 拒绝 |
| SQL 占位符/参数顺序（FTS/vector/list/children/relation routing，含与不含 `authorizedAtomIds` 两种分支） | 无错位 | 无需修复 |
| propagation-only 默认路径行为、写入默认、磁盘格式、Inspector 记账 | 无回归（gate 为 `undefined`，`pruneAtomReadState` 在默认路径不可达） | 无需修复 |

审计同时确认：不存在让模型/Renderer/工具/配置伪造 grant、gate、`authorizedAtomIds` 或执行模式的路径。

## 7. 明确结论（补充要求 6 的四项）

1. **已 enforce 的 Atom 路径**：v2 与 v3 的 branch index、exact-node、initial prime/refine、FTS（v3 原生；v2 仅授权集合内原词匹配）、vector deep-search（v3）、activation/hierarchy fallback、relation routing（v3）、subtree/children，以及 v3 最终物化投影与 v2 索引投影。
2. **仍不受新策略保护**：生产 propagation-only；无 Host 句柄的入口（channel/plugin、CLI、standalone adapter）仍以无 gate 的 legacy 检索读取同一数据根，本阶段没有 fail-closed 总开关；直接 repository/管理低层 SDK；`MemoryService.getNode`、管理 API 与 `memory_manage` 的独立读取授权；Renderer/loopback 管理路由（`memory-routes`/`memory-atom-routes`）可无 gate 读取任意 Atom 的 D3 正文、元数据、历史与导出；`resources` 分支（`MemoryResourceBranch`，含 USER.md/AGENTS.md/Skills 等注册资源）不消费 sealed policy；Bootstrap、Project Memory Branch、项目投影、来源档案与既有原文日志同样未接入。enforced Composite 只排除外部来源作为 Atom fallback，不代表这些模块已有所有权策略。
3. **是否存在未经授权的元数据披露**：在已覆盖的 Atom 检索入口，越权 Atom 不进入标题/ID/摘要/`hasChildren`/计数/排序/`truncated`/`nextCursor`/KnownState/错误投影；`neighborhood`、D3 历史与全库 relation 加权在 enforced 下关闭。真实存在的披露面：根索引中的固定分支/root 标识（导航结构，不属 Atom 正文）、T0 Resource 标题/目录（P1B-2B）、以及 `memory_manage` 对点名 atomId 给出的存在性/状态/revision 回执（需用户指令 + 审批，不返回正文，属管理面；`inspect` 本身无 gate）。
4. **留待 P1B-2C 的缓存与发送边界**：已装配的 `ctx.initialMemoryContext`、`memoryKnownState`、Session History 与 runtime tail、Context 复用缓存、checkpoint 恢复、已落盘 ExecutionLog，以及最终 Provider 发送前的撤销复核与 Atom read manifest 落地；方案见 §4.4，本阶段未实现，因此**不提供完整撤销保证**。

## 8. 变更范围与停止条件

改动集中在 Memory grant mode/ownership list、Atom gate 与授权测试、Tree/Composite/Service、v3 retrieval 与 Catalog SQL/物化、Runner 的可信依赖装配、Main 拒绝客户端授权字段、README/模块登记/阶段报告。

本阶段停止于 P1B-2A，等待验收。不自行切换生产默认模式，不进入 P1B-2B/P1B-2C。
