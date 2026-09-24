# Runtime 状态一致性与必要记忆任务书 2026-09-22

最后更新：2026-09-23 22:59:14

状态：**文件一致性主线（RS-00～RS-04）已实现并推送**（`593107c` / `9b01619` / `91381ad` / `9b4fced` / `4e8f402`），每批含真实文件测试与 README 同步，`check:repo` 36/36；**RS-05～RS-08（含补充的 RS-06A）尚未开始**（Memory 解绑与按需写入、向量检索边界、真实验收、收口退役）。2026-09-23 的 Memory 审查补充了缺陷证据和验收条件，未实施修复。上一份缓存专项按用户确认已完成，本任务只保留其回归约束，不重新立项。

## 1. 决定与范围

三项方向属于同一条主线：**冻结执行内核，所有写入以可验证的当前事实、受限写入理由和既有权限为前提，减少隐式行为。** 它们共用现有工具执行、权限、检查点与副作用结算边界，不共建一个新的通用状态管理平台。

- Harness / Runner 作为 stable kernel。修改只因真实任务暴露 correctness bug、可删除的复杂度、或已证明缺失的硬 invariant；每次改动附复现/缺口证据及最小范围。不主动新增 stage、planner、scheduler、manager，不借本任务重构主循环。
- Runtime 下一主线是 Observed Mutation Invariant：模型基于某版本文件决定修改，写入前必须验证仍是该版本；过期或未观察则拒绝并要求重新读取。
- Memory 按用户本轮进一步修正制定方案：**用户明确要求，或确有必要时，才进入 durable write；普通聊天不默认沉淀。Context compression ≠ Memory learning。** 不恢复 CAPTURE、auto-evolution，不为记忆写入恢复消息条数压缩触发。
- 允许最小必要的 ToolContext 接线与旧写入链删除；不因 kernel 冻结而保留已证实的数据一致性缺口。

本清单合并原“持久记忆写入路径任务书”的 MW-01～05：方向选择在本轮明确，入口/写入语义由 RS-05/06 承接，缓存与验收由 RS-07/08 承接。避免两份清单重复排期。当前代码仍是压缩唯一写入方，“明确要求或必要时写入”尚未实现；现行事实文档不能提前写成已支持。

必要写入与自动沉淀的区别：现有主循环为当前发现的明确长期需求发起一次受控写入；不在每轮结束或压缩时另调模型批量找候选，不恢复演化/合并/修订体系。首版不增加专门判定必要性或提炼候选的模型请求、阶段、调度或复杂评分；按需写入作为既有主循环内的普通工具调用。

## 2. 核实结果与实施边界

核实基线：HEAD `275e473` 与当时工作树。已有项目状态、缓存验收与结构基线改动保持原样，本轮不重新执行真实 Provider 负载。

| 当前事实 | 代码入口 | 对清单的影响 |
| --- | --- | --- |
| read 读取字节、裁剪和清洗后返回，没有 observation revision | `packages/tools/src/builtin/read.ts` | 必须记录实际读取版本和模型可见范围，不能事后重新读取一份内容当作原观察 |
| edit 先 checkpoint，再读当前内容，只判断 old_string 是否唯一；write 直接覆盖 | `packages/tools/src/builtin/edit.ts`、`write.ts` | 用户改了文件其他位置时仍可能写入，唯一匹配不等于观察版本有效 |
| ToolContext 只有可选 versioning 钩子；快照对每个路径通常只保留该 run 首次 preimage | `packages/types/src/tool.ts`、`packages/snapshot/src/git-checkpoint.ts` | 复用恢复快照，但不得把它当每次写入的 revision；覆盖前缺检查点能力须拒绝 |
| 工具资源冲突按执行批次分波；不能据此证明所有会话和宿主写入串行 | `packages/tools/src/tool-execution-scheduler.ts` | 核实同路径跨 run/会话的提交互斥；只补必要临界区，不增加任务调度系统 |
| exec 有运行前 workspace checkpoint，没有文件观察失效链；document_create 也可写目标路径 | `packages/tools/src/builtin/exec.ts`、`document-create.ts` | 处理所有结果分支；文档覆盖不能成为绕行口 |
| 显式工具指令仍进入可见目录选择 | `packages/harness/src/stages/execute/runners.ts` 的 `explicitTools ?? ctx.tools` | 只收此已知目录稳定性缺口，执行权限继续收窄 |
| 压缩要求 summary 与 candidates，前后会结算 pending candidates 到 memoryService.write | `packages/runner/src/session-continuity.ts` | 必须删除压缩自动候选生成、提交和恢复重放，不能只增加按需写入工具 |

两个不能省略的限制：

1. **校验不是文件系统原子 CAS。** 在授权后、checkpoint 前校验，并在 checkpoint 后紧邻提交再验；宿主内同路径提交互斥，避免覆盖 LS 自己的并发写。外部编辑器或任意进程仍可能在最后校验后写入；原子替换只能防半文件，不能单独证明没有竞争。首版明确支持范围与剩余竞态，不声称实现任意外部进程的绝对串行化；不支持的路径/提交条件拒绝或收缩能力。
2. **exec 失效保护后续修改，不保护 exec 本身。** Shell、插件及用户交互终端不是天然受 revision 校验控制。首版对可识别的直接文件覆盖导向受控工具或拒绝，不新增通用 Shell 解释器；构建/格式化等已授权命令保留并保守失效。不将“exec 后失效”宣传成任意 Shell 写入均受保护。

### 2.1 Memory 审查补充（2026-09-23）

以下是本次源码审查与隔离临时数据复现结果，补入现有任务，不另建 Memory 专项。上表仍是原始立项基线，文件侧当前完成情况以 RS-00～04 为准。

| 已复现问题 | 代码入口与复现事实 | 承接任务 |
| --- | --- | --- |
| 相似写入吞掉事实变更 | `packages/memory-tree/src/memory-repository/v3-node-store.ts` 的 `writeInternal` / `merge`：同一数据库描述仅端口从 5432 改成 6432，相似度 0.9167，返回 `merged`，可检索正文仍只有 5432，却追加了新来源 | RS-06 在实际 Repository 写入边界阻断相似度自动合并；RS-07 回归 |
| 无关截断拒绝整批候选 | `packages/runner/src/session-continuity.ts` 的 `renderMessageForCompaction` / `commitCompactionCandidate`：完整用户偏好与无关的 1,500 字符工具输出一起压缩，摘要提交成功，但偏好未写入，候选结算为拒绝且没有 pending 重试 | RS-05 删除旧链；RS-06/07 保证新入口只校验本次写入实际引用的来源，不修建旧候选机制 |
| 工具来源错记为最终回复 | 同文件 `commitCompactionCandidate` 把工具结果消息映射为 `conversation-source:<run>:assistant-reply`，工具声明者随之降为 Agent；实际工具来源格式见 `packages/harness/src/conversation-source-records.ts` | RS-05 删除旧映射；RS-06/07 验证新入口的来源类型、ID、存在性和认识状态 |
| 普通展开提前准备向量查询 | `packages/memory-tree/src/tree-memory-branch.ts` → `memory-repository/v3-retrieval.ts`：`branch_index` 为零次，首次 `expand(query)` 即调用一次 `prepareVectorQuery`，尚未执行 `deep_search` | RS-06A 最小修复；RS-07 验收 |

已有的“明确要求记住却没有直接写入通路”由 RS-06 完整承接。不得为了补这个缺口重新开启消息条数压缩或增加候选提炼模型调用。

证据边界：审查时现有相关测试 7 个文件、49 项通过；4 个临时探针均确认上述缺陷，探针已清理。它们证明缺陷可复现，不证明修复完成；实现时须将相应场景转为常驻回归测试。尚未进行本次变更的真实模型、Electron 或跨会话端到端验收。

## 3. 待执行任务

### RS-00｜冻结 kernel 与收掉已知目录缺口（P0）

- [x] 记录允许改动的三类依据和本批入口；维持现有主循环、阶段图、恢复与副作用结算，禁止顺手加第二执行器或永久新旧模式。**本批只改可见目录、拒绝文案与对应测试/README**：没有新增 stage、planner、scheduler 或 manager，`versioning`（检查点）、恢复、副作用结算与 `admittedTools` 的强制点全部保持原样。
- [x] 收敛显式工具请求的可见目录与 admittedTools：目录按会话区间固定，显式约束在执行边界拒绝；覆盖普通→显式→普通及恢复路径。确需变更注册目录只发生在明确的新区间。**已收口**：`catalogTools = ctx.tools`（会话区间固定），显式指令只与 Runtime 检索范围**取交集**后收窄 `admittedTools`（不再替换检索范围，避免"点名的 web 工具被放宽进 local_workspace 轮"）；拒绝文案按成因选择（`renderExplicitToolScopeContract` / `renderRetrievalIntentContract`），`packages/tools` 的过期文案（"current TaskBook step"）一并订正。测试覆盖普通/显式/普通目录字节相同、误调未具名工具在执行边界被拒且文案点名显式约束、点名 web 工具不放宽检索范围、跨 run 续接（恢复的 classification 不改变目录）。

验收：无新增控制流层；无越权调用；相邻回合目录稳定。此小洞独立收口，不阻塞后续文件一致性工作。**已满足**（`tool-catalog-stability.test.ts` 13 例、`stages/execute.test.ts` 41 例、`cross-run-continuation.test.ts` 3 例、`tool-execution-service.test.ts` 26 例全绿；`check:repo` 36/36）。

### RS-01｜定义并接入最小文件 observation（P0）

- [x] 在现有工具宿主边界保存有界 observation：会话/工作区、规范目标身份、原始字节 revision、实际可见范围、产生该观察的工具调用。模型不能自行传一个 hash 就声称读过。**已实现**：`packages/tools/src/file-observation.ts` 提供 sha256 revision、规范路径键与有界表；`packages/runner/src/session-file-observations.ts` 按 `sessionId` 取表（默认 16 张、每表 512 条、LRU 整表淘汰）并经 `runner.ts` 注入 `ToolContext.observation`（`context.ts` 透传）。观察只能由宿主端口写入，工具参数里没有 hash 入口。
- [x] revision 基于实际读取的同一份原始字节及必要文件身份；mtime/size 仅可作快筛，不能作唯一判据。覆盖同大小改写、删除重建、路径大小写/别名及符号链接重指向；首版不能可靠处理的链接/特殊文件明确拒绝写入。**已实现**：`read.ts` 用单个文件句柄同时取字节、size 和 mtime（同一版本），revision 是这些字节的 sha256；键来自 `realpathSync.native` 并在 Windows 折叠大小写，`lstatSync` 判定符号链接与非普通文件即返回 `observation_unsupported`（RS-02 会据此拒绝写入）。同大小改写由 sha256 而非 size 判定。
- [x] 只在读取成功且结果交付可追溯后登记；失败、权限拒绝、被截断/清洗内容不算完整观察。部分 read 可支持已看到范围的精确 edit；整文件 write 必须有完整有效观察。grep/glob 命中、摘要和二进制预览不等于读过全文。**已实现**：只有 `!sanitized && !truncated && 可见行非空` 才登记；无 `offset`/`limit` 记 `coverage: 'full'`，带窗口记 `partial` 并写入 1-based 可见行区间；二进制预览、读取失败、审批拒绝、截断与清洗一律不登记（`read.test.ts` 逐项断言）。`grep`/`glob`/`document_read` 不登记。
- [x] observation 使用现有 ToolContext 的最小宿主能力，不写长期记忆、不注入全量 system。条目有数量/寿命边界，淘汰后需要重读；重启默认失效，不新增 observation 持久化系统。**已实现**：只新增一个可选 `ToolContext.observation` 端口，无持久化、无提示词注入、不触碰记忆；表有每会话条数上限与会话表上限，淘汰/`dispose()` 后模型必须重读；端口冻结期间既不登记新观察也不得授权写入（供 RS-04 的 `exec` 使用）。淘汰与释放只约束内存：已交给在飞 run 的端口仍持有自己的有界表。

验收：观察绑定模型实际所见版本，失败或部分证据不能升级为完整观察；同会话跨 run 可受控使用，其他会话不能借用。**已满足**：`file-observation.test.ts`（12 例，1 例符号链接在无权限环境跳过）、`builtin/read.test.ts`（13 例）、`session-file-observations.test.ts`（5 例）、`runner.test.ts` 的 file observation wiring（2 例，真实 Runner 断言端口按会话注入且互不共享）全绿。

### RS-02｜既有文件修改前校验与提交（P0，依赖 RS-01）

- [x] 执行顺序固定为授权与路径复核 → observation/revision 校验 → durable checkpoint → 紧邻提交复核 → mutate → 结果结算。缺失/过期 observation 返回结构化 missing/stale，原文件不变，模型重读后重新决策；不得静默重放原修改。**已实现**：`write.ts` / `edit.ts` 都按此序列重写；校验与复核共用 `readVerifiedFile()`（按内容哈希判定）。失败一律 `ok: false` + `meta.errorKind`（`observation_missing` / `observation_stale` / `observation_unsupported` / `target_exists`），不抛异常——抛异常会被 `tool-execution-service` 记成 `tool_error` 并让副作用结算成 `unknown`。拒绝时文件逐字节不变，观测到的新版本不会被覆盖。
- [x] 校验覆盖整个被观察文件版本，而不只是 old_string；保持精确匹配与唯一性检查。checkpoint 前已知 stale 时不生成文件快照，checkpoint 失败或后二次检查失配时不写。**已实现**：预检在任何快照之前（stale 直接返回、不产生 preimage）；锁定内复核后仍在**同一份字节**上做 `old_string` 精确匹配与唯一性判定，再写入；`partial` 观察只允许编辑落在 `visibleLineRange` 内的行，范围外返回 `observation_missing` 并提示重读该范围。
- [x] 核实同目标跨会话、跨工具宿主入口的提交互斥，复用已有路径/资源边界，必要时只补同路径临界区。记录外部并发竞态的保证边界；避免把普通 writeFile 换成 rename 就宣称无丢失更新。**已实现并记录边界**：复用 RS-01 的 `withPathLock`（同一 Runner 内所有会话共享一张互斥表），"复核 + 写入"在同一临界区；同批次内的资源冲突仍由既有 scheduler 负责，未新增调度系统。边界如实记录：这是**同进程**互斥，不是文件系统 CAS——两个应用实例或外部编辑器仍可能在最后一次复核之后写入；首版不宣称任意外部进程的绝对串行化，也没有为此把 `writeFile` 换成 `rename` 冒充无丢失更新。
- [x] 成功写入后旧 observation 失效；首版后续修改要求重新 read，不根据模型自述或未读回的写入结果自动续期。失败但副作用结果不明也失效，并走现有结算而非重复写入。**已实现**：成功、失败与结局不明都在结算前 `invalidate()`；测试断言"写入成功后第二次写必须重读"（write 与 edit 各一例）。

验收：读后用户修改任意位置、审批等待期间修改、checkpoint 期间修改、两个会话基于同版本提交，均不能静默覆盖已被检测到的新版本；拒绝零写入、检查点失败零写入。**已满足**：`write.test.ts` 20 例、`edit.test.ts` 15 例覆盖"未读即写被拒""同大小改写判 stale""部分观察不得整文件覆盖""并发创建只得一个成功""checkpoint 失败零写入"；两个会话基于同版本提交由 `session-file-observations.test.ts` 的同路径互斥用例与 `withPathLock` 临界区保证；`failure-policy.test.ts` 钉住拒绝分类不会被误判成权限问题。

### RS-03｜新建与其他文件写入口收口（P0，依赖 RS-02）

- [x] 新建与覆盖明确分开。目标不存在可走 create-only，并由提交方式保证存在即拒绝；不能“检查不存在→普通覆盖写”产生竞态覆盖。新建仍按权限与既有恢复契约执行。**已实现**：`write.ts` 目标不存在时用 `flag: 'wx'` 独占创建，`EEXIST` 返回 `target_exists`（RS-02 一并落地）；权限与 `beforeFileMutation` 恢复契约不变。测试用"校验后、创建前被别的写入者抢先创建"的钩子证明原内容不被覆盖。
- [x] `document_create` 首版收缩为只创建新文件，目标已存在即拒绝；不为了覆盖二进制文档扩展复杂观察协议。其他已知宿主文件覆盖入口统一复核或明确拒绝，不能只保护 edit。**已实现**：`@littlesheep/documents` 的 `createDocument` 新增 `createOnly`（独占创建，冲突抛 `DocumentTargetExistsError`），`document_create` 固定传入该模式并在冲突时返回 `target_exists`；路径复核从 `resolve` 改为 `resolveToolPath`。绕行口用注册表守卫测试钉住：生产注册表包含 `write`/`edit`/`document_create`/`exec`，且**不含**未接观察的遗留写工具 `write_memory` 与 `record_experience`（二者仍未注册，`permissions` 名单里的死条目保持不启用）。
- [x] 用户直接编辑/保存文件仍是用户操作，不增加 Agent 审批；其修改使旧 observation 失效，并始终由修改前 revision 检查兜底。插件未知写入按不透明副作用处理，不擅自声称第三方已遵守 invariant。**已实现并如实记录**：用户/外部改动不改审批路径，靠内容哈希在写前判 `observation_stale`（测试用"同大小改写"证明 size/mtime 不足以判定）；插件写入仍是不透明副作用——本批不声称插件已遵守该 invariant，`exec` 之外的插件写路径只能靠同一 revision 检查兜底或被拒绝。边界写进 `packages/tools/README.md`。

验收：并发创建仅一个成功，既有文件/产物不被意外覆盖；合法新建正常，核心源码保护和三档权限不退化。**已满足**：`write.test.ts`（并发创建只得一个成功）、`document-tools.test.ts` 7 例（已存在即拒绝且逐字节不变、新路径正常创建）、`runner.test.ts` 的写入口守卫；核心源码只读与三档权限的既有用例全部保持通过。

### RS-04｜exec 与不透明修改后的保守失效（P0，依赖 RS-01/02）

- [x] 复用现有命令边界与副作用生命周期，在可能写入的进程启动前使相关 observation 失效，在最终结算时再次失效；运行期间不能签发可用于覆盖的观察，或必须在完成后重新读。**已实现**：审批之后、spawn 之前 `observation.suspend()`（挂起期间 `recordRead` 不登记、`lookup` 直接返回 `observation_suspended`），结算时 `invalidateAll()`；命令未启动（审批拒绝、spawn 失败）则只解冻、不清空。
- [x] 已证明的精确修改路径可局部失效；无法证明影响范围时清空该作用域的观察，跨工作区/范围未知则扩大到宿主保存的全部相关观察。不能只按 cwd 推定任意脚本只改该目录。**已实现（保守版）**：v1 不做命令解析，一律清空该**会话**的全部观察（覆盖所有工作区），因为按 cwd 推断"脚本只改了这里"是不可靠的。局部失效留作后续可选优化；本批不声称支持它。
- [x] 非零退出、部分修改后失败、超时、取消、进程未完全停止均按可能已改动处理；未停止的写入方使相关观察保持不可用。不凭退出码 0、命令名或旧只读启发式证明没有写入。**已实现**：任何真正启动过的命令都在结算时清空观察（含退出码 0）；只有确认进程已关闭才解除冻结，否则保持冻结直到 `close`。`isLikelyReadOnlyCommand` 只继续用于是否拍照回滚点，**不参与**失效决策。
- [x] 不新增递归 watcher/全仓扫描/后台管理器；外部编辑以写前检查兜底。可确证未启动的权限拒绝无需无故清空观察；用户交互终端维持自己的来源边界。**已实现**：没有新增 watcher/扫描/管理器；外部编辑仍由写前内容哈希兜底；黑名单/审批拒绝不清空观察（有测试）；用户交互终端不经 Agent 工具路径，来源边界不变。

验收：read→exec 改文件→edit、exec 改文件后非零退出/超时/取消均要求重读；绕行入口、路径未知与残留进程有明确结果。**已满足**：`exec.test.ts` 21 例中的 5 例覆盖"命令改写文件后观察被清""命令未触碰文件也清""非零退出清""超时清""审批拒绝前不清"；`file-observation.test.ts` 覆盖挂起语义（挂起中登记被忽略、既有观察不可用）。

### RS-05｜Memory：删除压缩自动学习（P0，文件主线之后）

范围：`packages/runner/src/session-continuity.ts`、`packages/session/src/compaction.ts` 与 compaction store 的候选兼容/结算边界。此次发现的整批截断拒绝和非用户消息统一映射为回复，随旧写入链删除；不为即将退役的链增加逐候选调度或另一套来源管理。

- [ ] 压缩仅维护会话工作摘要、未完成目标及恢复信息；删除候选提炼提示、候选解码与自动 `memoryService.write` 调用。摘要/原始对话持久化继续保留，但不当作新的长期事实写入或借摘要登记旁路自动晋升。
- [ ] 处理升级前 pending compaction memory proposal：未提交候选按现有事务状态显式终止并保留审计，不在启动/续接时自动写入；已提交记忆、来源和摘要不删除，不回滚用户数据。
- [ ] 清理无调用方的该写入链与配置，保留必要旧格式读取兼容；不恢复 CAPTURE、自动演化或以消息数量触发压缩来“找机会学习”。

验收：没有明确或必要写入请求时，普通聊天、真实压力压缩及重启恢复均不新增长期事实；会话连续性仍通过；升级前 pending 候选不会复活自动学习。此步骤与 RS-06 在同一发布批次交付，避免只删除唯一入口后宣称 Memory 已可用。

### RS-06｜Memory：明确要求或必要时 durable write（P0，依赖 RS-05）

范围：现有工具注册与执行边界、`packages/memory-tree/src/memory-service.ts`、`memory-repository/v3-node-store.ts`、`write-policy.ts`，以及 `packages/harness/src/conversation-source-records.ts` / `stages/memory-epistemic-policy.ts` 的来源和认识状态规则。复用服务不等于无条件继承其相似合并行为。

- [ ] 增加一个最小受控 `memory_write` 入口，继续保持 `memory_tree` 五个只读动作；复用现有 Memory Service、索引导航、事务、权限与日志，不新增 Memory planner/manager。无单独提炼模型调用，直接在现有主循环完成。
- [ ] 写入分两种有记录的理由：用户明确要求，或模型在当前主循环中判断确有必要。前者绑定真实用户指令及具体指代；后者复用现有 reason/source 字段说明后续用途与不保存会丢失什么，不只填“有用”。必要性是有界语义判断，Runtime 校验可验证的来源、范围和证据，不伪称能机械证明未来价值。
- [ ] 必要写入首版限于影响后续工作的稳定用户约束/偏好、已确认项目决定/约定、经验证且难以重新获得的重要事实。仅本轮临时进度、常规工具日志、已有文件可直接回读的正文、重复内容、模型猜测不写；已有会话摘要足以恢复的任务进度不再复制成长期记忆。收益不清或指代含糊时保留会话上下文，必要时澄清，不默认学习。
- [ ] 两类写入都绑定具体内容、scope 与有效来源；模型传入 `explicit=true`、外部网页/工具文本中的命令或引用/否定语句都不能生成用户授权。外部不可信正文默认不持久化，不因“必要”扩大现有网络与记忆边界；需要保留结论时按既有证据规则处理，不能将模型推测升级成事实。
- [ ] 明确要求与必要性都只是写入理由，不替代三档权限审批；研究/受限模式遵循既有写入批准，完全访问遵循现有授权。批准后也重验写入理由、对象和权限，不以持久化旧批准扩大新写入范围。
- [ ] 沿已有索引确定 parent/scope/tier，保留不可变来源、写入理由及认识状态；复用 `resolveMemoryWriteEpistemic` 的规则，必要时用最小中性入口消除其历史 stage 耦合。用户陈述不自动变成客观已验证事实，不自动合并、改写或纠正已有记忆。
- [ ] 将“不自动合并”落实到新入口实际调用的 Repository 写入路径：文本相似度只能发现候选，不得把不同数值、否定条件或实体的内容判为已成功合并，更不能把新来源作为旧正文的支持证据。仅同一操作的重试按下述幂等规则复用提交；纠正/冲突超出首版能力时明确拒绝或报告不支持，保留旧记录，不静默写入矛盾事实，不扩建自动纠正系统。
- [ ] Runtime 按实际来源类型解析并验证具体记录 ID、存在性、授权范围与模型可见证据完整性；工具结果关联对应 callId 的 `tool-result`，不可用同 run 的最终回复代替。用户来源、回复来源、工具结果与验证结论分别保留，工具成功不自动证明候选事实已验证。仅校验本次写入实际引用的来源，无关消息截断不连带拒绝完整来源；所引证据缺失/截断时拒绝或明确降级，不伪造完整依据。
- [ ] 以稳定来源/操作身份、作用域及规范化内容实现重试/重启幂等；用户指令与必要写入均适用；同一操作身份绑定不同内容拒绝，响应丢失后核对已有提交。事务提交成功才允许模型据真实工具结果表达“已记住”，失败/拒绝不伪装成功。
- [ ] 保持 HC-12 撤销、冲突/替代及来源边界；现有撤销机制必须能约束新记录。未实现的自然语言删除/纠正不得假称支持，不能把用户纠正请求静默存成一条矛盾事实。

验收：明确指令和符合必要条件但未说“记住”的重要项目决定，分别完成审批/写入→重启→新会话召回；普通闲聊/临时信息不默认写，收益不明不写；注入/含糊指代/跨 scope 拒绝；重复提交不重复记忆；撤销后不召回、不因重试恢复。

### RS-06A｜Memory：向量查询只在深搜边界启用（P2，独立小修复）

范围：`packages/memory-tree/src/memory-repository/v3-retrieval.ts`、`tree-memory-branch.ts` 与对应导航/服务测试。无 RS-05/06 实现依赖，可独立修复；并入 RS-07 验收。只修既有 mode 分支，不新增检索阶段、planner 或 manager。

- [ ] 按请求 mode 分开普通展开与深搜：D1 索引、按 nodeId 展开和 `expand(query)` 均不准备查询向量、不调用向量搜索；保留现有 scope、FTS、层级、预算与证据约束。
- [ ] 只有通过同 run 分支索引和展开前置检查的 `deep_search` 才允许使用分支内向量兜底；每次深搜最多准备一次查询向量并复用于已授权 scopes。未索引/未展开的深搜拒绝，跨 scope 不泄漏，本地模型不可用时保留既有 FTS/层级降级结果。
- [ ] 分别观测查询向量准备、实际 embedding 与向量搜索调用，排除写入建索引的 embedding 次数；覆盖 `expand(query)`，不能只测按 nodeId 展开而遗漏此次绕行路径。

验收：有可用 embedding 引擎时，`branch_index → expand(query)` 的查询 embedding/向量搜索均为 0；合法 `deep_search` 每次最多一次查询 embedding，违规导航在调用向量前拒绝；引擎不可用时普通展开仍返回可用 FTS 证据，深搜如实保留降级边界。真实模型/性能结果另行记录，不用调用计数宣称速度提升。

### RS-07｜定向故障与真实流程验收（P0，依赖 RS-00～06 及 RS-06A）

- [ ] 文件侧先跑真实临时文件集成与故障注入：同大小/保留时间改写、其他区域变化、部分 read、清洗/截断、路径重定向、删除重建、并发创建、跨会话提交、checkpoint 失败、审批等待、exec 部分失败、进程重启。mock 只定位控制点，不能代替真实文件结果。
- [ ] 实际桌面流程：LS 读文件→用户编辑保存→LS 修改被拒→重读后成功；再验证 exec 变更、文档同名创建拒绝与权限拒绝。版本差异、检查点与最终文件逐项对账，不把“有备份”当“没有误覆盖”。
- [ ] Memory 用隔离数据根和真实模型验证明确记住、必要决定按需写入、普通闲聊不默认写、正常压力压缩不学习、升级 pending 候选、重启幂等、跨会话召回及撤销；失败、权限拒绝和不支持情形单独保留。
- [ ] 将 §2.1 的复现转为常驻回归，使用真实 V3 Repository/Session 存储核对结果；来源与调用计数可用受控模型/embedding 替身定位边界，另由上一项完成真实模型验收。逐项验收见下表，不把“测试通过”与“支持自动纠正”混为一谈。
- [ ] 缓存保持已确定的 DeepSeek Harness 式会话累计口径及冻结长任务节点 >=95%（目标 95%～99.5%）。运行 `pnpm run check:cache-acceptance`，并对本次变更后的构建完成适用真实长任务复测；旧账本过门不等于新代码实测。不得填充、预热、隐去重读/拒绝/辅助用量，同时对账任务结果和实际消耗。

| 定向场景 | 必须证明的结果 |
| --- | --- |
| 5432 → 6432、肯定 → 否定、同句不同实体 | 不返回保留旧正文的成功合并；新来源不被挂为旧事实证据。首版不支持纠正时返回明确失败/不支持且旧记录不变；同操作重试仍保持幂等 |
| 完整用户偏好 + 无关 1,500 字符工具输出 | 压缩仅产生会话摘要、不生成或结算长期候选；独立授权的 `memory_write` 可依据完整用户来源提交。引用被截断工具正文的写入仍受完整性约束，不用无关截断阻断合法写入 |
| 用户消息、最终回复、工具结果与缺失来源 | 类型/具体 ID 正确对应持久记录，工具结果定位到 callId；不存在的记录不能提交成功；未验证证据不得提升为已验证。重启读取后来源关联不变 |
| 首次 `expand(query)` 与合法/非法深搜 | 普通展开零查询向量；非法深搜在向量调用前拒绝；合法深搜最多一次查询 embedding、无跨 scope 泄漏；不可用引擎保留既有降级行为 |

验收：有支持范围、真实证据与未覆盖项；任何零写入/不学习/不重复承诺失败均不得发布。冷启动低值不误判，未完成真实验收不得标记全部完成。

### RS-08｜最小文档、迁移与收口（P1，随实现同步）

- [ ] 每批只更新实际变更 package/领域 README，系统时钟时间行与源码同次提交；稳定契约汇入项目状态、架构原则、工具/Memory 文档和运行时指令，不把计划写成已实现。
- [ ] 迁移只为旧 pending 候选和已存在记录兼容所需，不改造 Memory 存储架构。回滚版本不得悄悄重新启用自动写入；保留升级标识/受控启动拒绝等最小兼容措施及恢复证据。
- [ ] 执行适用单元/集成检查、`verify:changed` 与 `check:repo`；改动桌面接线时验证 App 构建及实际入口。删除本批无用分支/配置与重复说明，不开展无关清理。
- [ ] 全部验收结束后把有效事实写入常驻文档并按仓库规则退役本任务书。实现完成、真实验收完成、缓存回归完成分别记录。

## 4. 执行顺序与能力代价

顺序：**RS-00 小范围收口；RS-01→02→03/04 文件一致性；RS-05/06 作为同一发布批次交付最小按需记忆；RS-06A 可独立修复并在 RS-07 前完成；RS-07 真实验收，RS-08 随各批同步。** 文件一致性优先于绝大多数新功能，不与 UI 扩展、MCP 或新规划体系绑定。

接受的代价：过期/未完整观察需重读；exec 后可能多读一次；首版不覆盖不受支持的链接/特殊文件；文档同名覆盖收缩为新建；普通聊天不默认学习，压缩不再触发长期事实写入。既有记忆与对话仍保留；明确要求和必要写入均不依赖会话长度或压缩时机。

不扩大为：通用文件数据库、OS 沙箱、分布式锁平台、持续 watcher、自动记忆治理、新的阶段/规划/调度体系。优先删除和复用；若保证需要超出本范围的机制，先记录具体无法满足的条件并收缩支持范围，不以更多抽象掩盖缺口。
