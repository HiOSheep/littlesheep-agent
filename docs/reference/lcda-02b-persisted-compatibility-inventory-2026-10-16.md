# LS LCDA-02B — 存量兼容证据盘点与退役决策

日期：2026-10-16
基线：`main`，LCDA-02A `9d2d618b`，LCDA-01 归档 `5acba431`
范围：源码与测试定义审查；仅用合成 fixture 验证盘点器；未读取任何真实用户数据。

## 结论摘要

- LCDA-01 报告及其 Reference 索引改动已单独归档；`9d2d618b` 在当前 `main` 上。此时 02B 的脚本、测试、本报告和本报告索引是唯一未提交改动。
- 本批没有访问 LittleSheep 的真实数据根、Memory 正文、浏览器 profile 或 LocalStorage。因此真实记录数量、旧字段出现次数及外部 API 使用量均未知。
- 已新增一个显式指定数据根、默认 dry-run、只输出聚合结果的盘点器。合成 fixture 覆盖 checkpoint、ExecutionLog、ModelRequestSnapshot、durable event/inbox/lease、checkpoint disposition、SessionIndex 和 Memory locator/文件存在性；Renderer LocalStorage 始终报告未扫描。
- 退役分类：`replanAttempts/maxReplanAttempts` 是唯一可进入后续代码清理批次的 **Ready** 候选；本批没有删除。`WorkPolicyUpgradeRequest`、TaskBook Patch API 和旧 `evolve/capture` checkpoint 属于 **Unknown**。旧 `decide/verify` 恢复、Permission V1 授权降级、pre-lease recovery、Memory V2 与 Memory 迁移机制 **Retain**。旧 Memory 源和 Renderer layout 读取属于 **Migration Required**。

## 证据等级与真实数据状态

| 证据 | 本报告使用情况 |
|---|---|
| 生产源码 | 用于确认数据根、版本、写入/读取路径、恢复与权限行为。源码引用见各节。 |
| 合成 fixture | 仅用于验证盘点器的计数、unknown 与脱敏行为。Fixture 的旧字段/敏感标记不是真实用户数据。 |
| 真实存量 | 未检查。没有发现或不存在的数量结论均不作推断。 |
| 外部消费者 | 仓库源码没有提供调用量证明。尤其 Local App API 没有被认定为“无人使用”。 |

**数据根规则：** Runner 使用 `dataSubdirs()` 取得数据根，并由 `resolveDataDir()` 按 `LITTLESHEEP_DATA_DIR`、数据根 locator、品牌默认路径的顺序选择（`packages/branding/src/index.ts:169-174,261-291`）。盘点器不自动发现该位置；操作者必须明确给出某个目录。外部仓库路径还必须在命令中显式加 `--allow-external-root`。该开关不是本报告对任何真实路径的授权；执行真实盘点前仍需用户明确授权所选数据根。

## 持久化结构与当前读取契约

| 记录 | 数据根下位置与版本 | 当前生产者/消费者与状态 | 盘点器行为和边界 |
|---|---|---|---|
| Run checkpoint | `run-checkpoints/*.json`；checkpoint v1，resumeState 自有 v1（`packages/types/src/runtime-contracts.ts:18-19,795-869`） | Runner 写入并读取；Main API 展示、恢复或放弃；checkpoint body 作为不可变记录，恢复决策另存 disposition（`packages/runner/src/infra.ts:336-344`; `packages/runner/src/run-checkpoint-disposition-store.ts:1-5`）。 | 在内存解析 v1 的 stage、TaskBook、WorkPolicy、Replan、旧 Permission 和 patch 字段出现次数；未来版本、损坏 JSON、超限或不稳定文件计为 unknown。不会恢复 checkpoint。 |
| ExecutionLog | `execution-logs/*.json`；顶层没有统一 schema version | `ExecutionLogStore` 由 Runner 持续写入，历史 UI、恢复/协调、Usage 与 Context 诊断仍读取。日志可包含文本、工具结果、TaskBook、verification history 与请求快照（`packages/runner/src/execution-log.ts`; `packages/runner/src/infra.ts:325`）。 | 只在内存中读取 JSON，输出记录数和有限结构字段计数；不输出正文或字段值。无顶层版本意味着无法把日志完整性等同于某一个固定 schema。 |
| ModelRequestSnapshot | 嵌在 ExecutionLog 的 `modelRequests[]` 中；snapshot v1，旧记录可没有 `callContract`（`packages/types/src/runtime-contracts.ts:217-242`） | Context 新建 snapshot，Runner 持久化；Context/Usage 读取历史请求投影。旧 purpose/stage 不会因此重新启用旧执行器。 | 统计 v1、缺失 callContract 和历史 stage 的出现次数；不输出 messages、Provider 参数、hash 或模型内容。 |
| Durable events | `durable-events/<sha256(sessionId\0runId)>/<sequence>-<digest>.json`；事件 v1（`packages/runner/src/durable-event-store.ts`; `packages/runner/src/durable-harness-infrastructure.ts:41`） | 当前 Harness 持续追加，恢复和历史投影消费。payload 可带用户文本或工具相关数据。 | 只输出固定事件枚举计数、patch 出现次数和没有匹配 lease 的 partition 候选数。候选数**不等于** pre-lease 数：lease 可能缺失、损坏或已清理。 |
| Durable inbox | `durable-inbox/<sha256(commandId)>.json`；v1，状态 `queued/claimed/completed/failed`（`packages/types/src/durable-harness.ts:12,83-102`; `packages/runner/src/durable-harness-infrastructure.ts:42`） | 当前 Runner 持续写入、领取、结算；启动恢复只处理可行动命令，terminal 记录可能延迟读取。 | 汇总 version/status/event type；未知版本计 unknown，不执行领取或重排。 |
| Run lease / effect lease | `durable-run-leases/`、`durable-effect-leases/`，均复用 v1 lease 记录格式（`packages/runner/src/durable-harness-infrastructure.ts:43-44`; `durable-run-lease-store.ts:20-32`） | 当前跨进程运行所有权与副作用所有权机制；恢复会检查，防止重复拥有或重放。 | 读取结构所需的 lease identity 做哈希比较，不输出 ID/token；只报告状态计数。 |
| Checkpoint disposition | `run-checkpoint-dispositions/<hashed checkpoint id>.json`；v1（`packages/types/src/runtime-contracts.ts:19,869+`; `packages/runner/src/run-checkpoint-disposition-store.ts:52-60,564-569`） | 当前恢复/放弃决策的持久审计轨迹，包含状态、请求身份及有限历史。 | 只输出有限状态数，不执行恢复/放弃。损坏与不支持版本计 unknown。 |
| Permission V1 | Checkpoint 的 `resumeState.permissionPolicyId` 历史值 `full/research/restricted`；旧 SessionIndex 可带 `permissionVersion: 1` | Checkpoint 恢复会读取旧 mode 并在 Main 决定当前权限上限（`packages/app/src/main/local-app-api/run-checkpoint-routes.ts:349-374`）；SessionIndex 仅接受 V2 preset，旧行不会被当作 V2 权限（`packages/app/src/main/session-index.ts:133`）。 | 统计 checkpoint 旧值和 session 旧权限行；不输出会话标题、ID、workspace 路径。 |
| Memory locator / V2 / V3 | `memory-tree/repository-version.json` locator v1；V2 `memory-tree/index.json` 内文档 version 2（`document-store.ts:17,74,91-118`，接受旧 v1 并迁移）；V3 `memory-tree/v3/catalog.sqlite` 及多个记录目录。配置默认 V2（`packages/config/src/schema.ts:216`; `repository-locator.ts`）。 | V2 仍是默认和有效 backend；locator 选择当前 backend 并记录迁移/回滚状态；迁移过程需要 V2 源与 rollback 证据。Runner 在 legacy migration 未完成时继续注册旧 Memory branches（`packages/runner/src/infra.ts:428-451`）。 | locator 只读并投影固定 backend/phase；只看文件存在性/文件数，不打开 V2 index、V3 SQLite、atom/raw record 或 legacy Memory 正文。损坏 locator 计 unknown。 |
| 旧 Memory 文件源 | `MEMORY.md`、`memory/daily/*.md`、`experience/` | 迁移未完成或失败时仍被 legacy branches 读取；迁移代码保留旧文件来源（`packages/memory-tree/src/legacy-memory-branches.ts`; `packages/runner/src/infra.ts:428-451`）。 | 只统计文件存在性与数量；不读文件内容。 |
| Renderer LocalStorage | Chromium profile 内的新 session-scoped layout 与旧 flat panel/draft keys（`packages/app/src/renderer/app-shell/preferences.ts:237-313`; `packages/app/src/renderer/workspace/use-workspace-session-layouts.ts:397`） | 新布局缺失时读取旧 layout；draft 可能含用户未保存编辑。该存储不属于 Runner data root。 | 明确输出 `not-scanned; separate browser profile boundary`。不尝试发现 profile、读取键或统计草稿。 |
| Local App API | Shared route catalog 定义稳定路径，如 `/runs/:id/events`，没有路由级 `/vN` 前缀（`packages/app/src/shared/local-app-api-routes.ts:1-100`）。Locator 自身的 `version: 1` 是定位文件格式，不是 API 版本。 | Loopback Main server 提供带 bearer token 的本地 API。运行事件 route 接收 runtime task event；无源码调用量/遥测可证明外部消费者为零（`packages/app/src/main/local-app-api/README.md`; `run-routes.ts:189-233`）。 | 不访问 API、不发请求、不推断外部调用量。工具统计历史 durable payload 只能提供部分过去使用证据，不能证明当前客户端使用为零。 |

## 受限只读盘点器

文件：`scripts/audit-compatibility-data.mjs`。它仅提供 dry-run，没有写入/迁移模式。

```powershell
node scripts/audit-compatibility-data.mjs --data-root="<用户明确选定的数据根>" --dry-run --allow-external-root
```

调用前须由用户明确授权对命令中**该个**数据根进行只读扫描。若使用仓库内合成样本目录，可省略 `--allow-external-root`；真实用户数据根通常在仓库外。盘点器不会自动搜索、猜测、连接 LS、恢复运行或重放副作用。

输出限于记录数、版本桶、兼容字段出现次数、固定枚举状态和 unknown 数量；不输出原始绝对路径、记录 ID、正文、prompt、草稿、凭据或用户数据。单个 JSON 在内存解析后即只保留统计结果；单文件大小与目录记录数有上限；路径越界、符号链接、损坏/超限文件、不支持版本，以及单个 JSON 读取前后被发现的变化会计为 unknown/partial。目录列表不构成原子快照。Memory 正文与 LocalStorage 不扫描。正式盘点应在数据根静止时进行；否则计数只代表扫描时观察到的状态。

合成 fixture：`scripts/audit-compatibility-data.test.mjs`。覆盖旧 checkpoint 的 `verify`、TaskBook、WorkPolicy、Replan、Permission V1、patch、未知 stage、ExecutionLog 与缺失 callContract 的 ModelRequestSnapshot、损坏/未来版本、durable event/inbox/lease/disposition 和未知事件类型、Memory locator/文件存在性。测试断言输出不含 fixture 私密标记，unknown 不作不存在推断，且扫描前后 fixture 文件及目录集合相同。fixture 中观察到的任何数量都不能代表真实用户存量。

## 退役决策矩阵

### 重点候选

| 候选 / 分类 | 当前生产者与消费者；已确认的数据使用 | 外部使用 / 删除影响 / 迁移要求 | 建议条件、维护收益与并行性 |
|---|---|---|---|
| **B1 `WorkPolicyUpgradeRequest` — Unknown** | **存在条件性生产写入路径：** checkpoint writer 会在 `ctx.workPolicyUpgradeRequest` 有值时持久化；Runner restore 再投影回 RunContext（`run-checkpoint.ts:149`; `runner.ts:2279`）。类型和 state allowlist 仍保留该字段，但全仓未找到当前生产者赋值或策略消费者；codec 仍验证并投影（`run-checkpoint-codec.ts:182-184,221`; `packages/types/src/agent.ts:183`; `run-task-state.ts:17,26`）。真实 checkpoint 是否带此对象未查。 | 字段包含未完成目标、已/待执行 tool IDs、已完成副作用引用和模型/循环预算。当前 RCD 的 checkpoint `loopBudget`、`sideEffects` 与 durable leases/events 有独立契约；没有发现当前 RCD 直接读取此对象，但不能把历史 payload 视为可丢弃。移除 validator 后旧 JSON 可被忽略并继续读取；读取后再写会省略该字段，属于投影丢失。 | **不直接删除。** 先在授权数据根汇总此字段计数；计数为零并确认公开类型不承诺该字段后，可 code-only 移除；若非零，先导出/备份其预算及副作用引用，或明确判定这些值已有等价的 checkpoint ledger，再删除读写投影。维护收益中等。与 RCD checkpoint/恢复代码高冲突；不并行触碰。 |
| **B2 TaskBook Patch API — Unknown** | Main Local App API `POST /runs/:id/events` 接受 `taskBookPatch` / `patch`；Harness 在安全边界克隆并修订已有 TaskBook，带 revision/idempotency，事件走 durable queue（`runtime-event-request.ts:40-43`; `runtime-control-boundary.ts:123-200,314-318`; `run-routes.ts:189-233`）。内部没有 Renderer/model 生产者；新 TaskBook 的旧逐步 executor 已删除，patch 不会恢复该 executor。synthetic fixture 只证明计数器识别字段，非真实调用量。 | API 路径没有版本号，loopback + bearer token 不能排除脚本或其他本地客户端。没有 request telemetry/外部兼容承诺资料。移除会拒绝现有客户的运行中 task 修改，并让历史 deferred patch 失去应用能力。没有用户数据迁移可替代外部 API 退役。 | **暂缓删除。** 先为 route/event 做版本与弃用策略，并补充受控调用观测/用户沟通；确认旧 TaskBook 编辑不是产品需求后，才删公开 parser、Main route、Harness validator 和相关幂等状态。维护收益中等，外部回归风险未知。可独立于 CMv2；若 RCD 依赖 TaskBook 做持续任务交接则需先协调，不能仅凭内部零调用并行删除。 |
| **B3-a `replanAttempts/maxReplanAttempts` — Ready** | 当前 checkpoint v1 decoder 只校验并复制字段（`run-checkpoint-codec.ts:194-199,226-227`）；新 checkpoint writer 不写。没有生产逻辑消费；只在 types/codec/checkpoint 相关 fixture 中出现。测试夹具和合成盘点 fixture 是已确认的代码级使用，不是用户数据证据。 | 删除 typed projection 后，JSON parser 仍可接受这些额外属性；旧 checkpoint 不会因字段本身无法解析。后续 checkpoint 重写会自然省略旧值。无安全授权或副作用读取者。`@littlesheep/types` package 标记为 private，且 Main checkpoint projection 不暴露这两个字段，未发现外部 wire contract。 | 可在 **LCDA-02C** 单独移除类型、校验与复制；无需改写磁盘数据，也不应主动重写历史文件。收益低到中等（少量 schema/fixture 维护），回归风险低。与当前 RCD checkpoint 实现重叠，需等其文件冻结后做；不与 CMv2/Permission V2 核心逻辑冲突。此处仅推荐，不执行。 |
| **B3-b 旧 `decide/verify` stage — Retain** | codec 和 `HistoricalStageName` 保留读取。旧 `decide` 被 Harness 恢复入口映射到 `execute`，旧 `verify` 被 Runner/Harness 映射到 `recover`（`packages/harness/src/checkpoint-resume.ts:14-17`; `packages/runner/src/continuation-stage.ts:4-16`）。RECOVER 重新结算旧 evidence；历史 trace/log 仍可展示。 | 是真实 checkpoint recovery 与证据结算契约。忽略或误映射可能跳过 RECOVER 或把旧 verification 当当前任务成功。没有用户数据计数。 | 保留至所有支持数据根已显式迁移/过期，且旧证据与副作用仍经当前路径结算。复杂度较低，恢复/安全影响高；和 RCD/VRS 恢复工作冲突，不并行删。 |
| **B3-c 旧 `evolve/capture` checkpoint stage — Unknown** | 类型、checkpoint codec 接受旧名字；但当前 registry 仅注册七个 current stages（`packages/types/src/stage-transitions.ts:7-22,67-77`; `packages/harness/src/default-harness.ts:42-67`）。Harness 的恢复映射只特判 `decide` 和 `verify`，旧 `evolve/capture` 仍可能到达无注册 stage 的失败分支。 | 源码可证明名字能解码，不足以证明这些 checkpoint 可恢复；未查真实 checkpoint 存量。直接删除 reader 名称会令这类数据更早失败。把它们映射到 `execute/recover` 需要确定是否有未结副作用/evidence 的产品决策。 | 先用授权盘点确认数量并建立无法恢复时的导出/人工恢复规则；之后决定显式迁移还是退役。维护收益低，恢复风险未知。与 RCD checkpoint 路径冲突，不并行。 |
| **B3-d Permission V1 checkpoint mode — Retain** | 旧 mode 仍在 checkpoint schema；Main 恢复时把它作为当前 V2 权限的上限/降级依据（`run-checkpoint-routes.ts:349-374`）。session index 则拒绝将 V1 mode 当成有效 V2 preset（`session-index.ts:133`）。 | checkpoint 值直接关联授权安全，不能当普通历史枚举删除；旧 session index 行若被转换，必须为旧 `full/research/restricted` 选定经验证的 V2 映射。真实行数未查。 | 继续保留 checkpoint fail-closed 映射。SessionIndex V1 行若存在，应在迁移/恢复策略中处理后再移除 enum；不能扩大权限。与 Permission V2 核心开发冲突，不并行。 |
| **B3-e pre-lease event-only recovery — Retain** | `RunRecovery` 仍会扫描 event-only runs；发现的现代 event run 会重新检查 lease，避免与 queue/lease 路径重复恢复（`packages/app/src/main/run-recovery.ts:134-136,179-210`）。新 queue/inbox/lease 是主路径，旧 events 仍是兼容来源。 | durable events 和副作用记录是真实持久化状态。盘点器只能报告无匹配 lease 的 event partition 候选；不能可靠认定其属于 pre-lease，也不恢复或重放。 | 仅在所有支持根中旧流已迁移/过期、无未结副作用并有恢复演练证据后评估关闭。收益低，副作用重放风险高。与 RCD 运行恢复高度冲突，不并行删。 |

### 相关保留项与迁移项

| 项目 / 分类 | 删除影响、条件与建议 |
|---|---|
| TaskBook / taskExecution / verification history — **Retain** | checkpoint/log/history 有真实读写与 UI 消费；TaskBook patch 可修改恢复出来的 TaskBook；EXECUTE/RECOVER 仍写当前 `VerificationRecord`。不可把旧 `pass/needs_replan` 与当前 `unverified/fail` 等同。旧 executor 已删，无需再清一套执行器。 |
| ExecutionLog 与 ModelRequestSnapshot — **Retain** | 当前日志仍被历史呈现、Context/Usage/恢复相关投影消费。缺少 `callContract` 是旧 snapshot 兼容字段，不代表整个快照无效。数据清理需独立 retention/export 策略。 |
| Memory V2 backend — **Retain** | V2 是当前 config 默认，V3 不是全局无条件替代；直接移除会使未迁移根/默认配置无法读写。与 CMv2/Mem migration 冲突。 |
| Memory V2→V3 locator、migration、rollback — **Retain** | locator、snapshot、ledger、rollback 与源内容是当前迁移恢复契约；不属于本批可删除兼容层。 |
| Legacy Memory branches — **Migration Required** | 只有指定 data root 的旧 long-term/daily/experience 内容已导入、migration ledger 成功、队列为空、V3/V2 读回验证通过且备份/回滚期限结束后，才可停止读取；全局删除需所有支持根满足条件。 |
| Renderer 旧 workspace layout/draft key — **Migration Required** | 旧读取在新 session-scoped layout 缺失时导入。需证明 tabs/panel/draft 已保存到新 layout，且可恢复或备份；当前 LocalStorage 未扫描。可能影响未保存草稿，不能从 app data root 盘点推出已迁移。 |
| Local App API route 版本/TaskBook patch 外部消费者 — **Unknown** | API 没有路由级版本契约，也没有可用的调用计数；Local App API locator v1 不提供 route 兼容证据。移除前要有 API 版本/弃用周期和外部客户端证据。 |
| SessionIndex 中 V1 permission rows — **Migration Required** | Main 现有读入 fail closed，不把旧值当 V2 授权；`normalizeSessionMeta()` 返回 null，`list()` 在行数/规范化结果不一致时可能把过滤后的 V2 rows 写回 `sessions.json`（`session-index.ts:33-44,126-134,166-178`）。`sessions.json` 是 sidebar metadata cache，权威聊天内容在 SessionManager JSONL。若要删除兼容枚举或保留旧会话 UI 元数据，需先备份/映射索引；当前数量未知，对话正文不在本工具扫描范围内。 |

以下细项补齐其生产/消费、数据、风险、迁移条件、收益和并行性；它们不因“相关项”身份而降低证据要求。

| 项目 / 分类 | 当前源码生产者与消费者；已确认数据使用 | 外部风险；移除影响 | 迁移/备份与退役条件 | 预计删除模块 / 收益 | 与专项并行 |
|---|---|---|---|---|---|
| TaskBook、taskExecution、VerificationRecord — **Retain** | 旧版本可写 checkpoint/log；Runner 恢复，Renderer 展示；Harness runtime-boundary 可修改已有 TaskBook；当前 EXECUTE/RECOVER 也写 evidence VerificationRecord。源码存在多条活动读写，不是只读结构。真实存量未扫描。 | Local App API TaskBook patch 的外部使用未知；删除 TaskBook 投影会隐藏进度/结果并影响续接；删除 VerificationRecord 会丢当前证据结算。 | 若未来清理历史数据，需定义日志留存/导出和 checkpoint 过期；旧 verdict 只可作为历史事实，不可转换成当前验收通过。 | checkpoint/log codecs、Renderer history/activity、Harness event patch；潜在收益中等，但维护成本小于语义/恢复风险。 | 与 RCD/VRS checkpoint、验收证据强冲突；不并行。 |
| ExecutionLog / ModelRequestSnapshot — **Retain** | Runner 每次运行写 ExecutionLog；Session/Renderer、Context/Usage 与恢复协调读取。snapshot v1 新写，旧 snapshot 允许缺少 callContract。合成 fixture 仅证明盘点逻辑。真实日志数未知。 | 外部客户端对磁盘日志格式没有已确认调用证据；日志可能含对话和工具材料。移除 reader 会影响历史 UI、Context/Usage 投影和诊断，移除 writer 会终止现行观察证据。 | 先制定数据留存、导出和备份策略，再按日志版本迁移；不能把缺 callContract 当作损坏或不存在。 | `execution-log.ts`、历史消费方和 snapshots 投影；收益中等，属于现行数据合同，不是可直接清理项。 | RCD/CMv2 会消费日志/Context 证据，不并行删除。 |
| Memory V2 backend — **Retain** | config 默认 `v2`；factory 仍提供 V2 读写；V3 migration 也读取 V2。locator 不存在的默认根仍依赖 V2。真实 V2 内容未打开，数量未知。 | 不见 Local API route version 可推出外部 backend 无用；移除会令默认/未迁移 data root 无法读写。 | 全部支持根完成 V2→V3 并验证读回、回滚窗口结束、默认和新建根政策切换之后才评估；保留可恢复备份。 | `v2-backend.ts`、factory/config/default、migration source reader；收益较高但当前生产用途明确。 | 与 CMv2/Memory migration 高冲突，不并行。 |
| Memory locator / V2→V3 migration / rollback — **Retain** | Main/Runner 读取 locator、状态并启动迁移/回滚；存储 locator、snapshot、ledger、rollback 等持久状态。实际状态未知。 | 删除会丢失 active backend 判定和事务恢复信息，可能造成数据选择错乱或回滚失效。 | 必须逐根证明 migration committed、队列清空、回滚保留期完成并可恢复；不以某一根结果代表全部用户。 | locator、migration manager、snapshot/rollback/ledger；维护复杂度不小，但负责防止持久数据损坏。 | 与 CMv2/Permission V2 数据访问边界冲突，不并行。 |
| Legacy Memory branches / `MEMORY.md`、daily、experience — **Migration Required** | Legacy stores 可被 CLI 写入；migration 读取旧数据；Runner 在 migration 失败/未完成时注册 branches 继续检索。真实内容和迁移进度未检查。 | 移除会令未迁移记忆从检索上下文消失；删除源文件可能造成不可逆损失。 | 逐根检查 ledger 完成、待迁移队列为零、目标 repository 可读回并具备备份/回滚；之后才停 readers，最终删除源文件另需授权。 | `legacy-memory-branches.ts`、infra 注册、legacy stores；收益中等。 | 与 CMv2/Memory migration 强冲突，不并行。 |
| Renderer 旧 workspace layout/draft — **Migration Required** | 旧 flat LocalStorage keys 由旧 Renderer 版本写；当前 Renderer 在新 session-scoped layout 缺失时读取并导入。真实 LocalStorage 未扫描。 | 外部 Renderer 插件消费者未见；移除会丢 panel/layout 和未保存 draft，可能造成用户编辑丢失。 | 需对各受支持 browser profile 独立执行授权后的只读聚合检查，并证明新 key 已保存可用，另有草稿备份/恢复策略。 | `preferences.ts` 旧读函数、`use-workspace-session-layouts.ts` fallback；收益中等。 | 与当前 Permission/CMv2 无核心交叉，可独立排期；需 Renderer 数据迁移验收。 |
| Local App API route version / 外部消费者 — **Unknown** | 当前 Main server 与 shared route catalog 生产/消费 unversioned routes；Renderer 和仓库验收脚本为已知客户端。没有调用计数/访问日志来源可确认外部客户端数量。 | 本地 loopback + token 仍可被用户脚本/其他本机程序使用。删路由可能破坏运行中的客户端；API locator v1 不是替代 API 版本。 | 先决定 API 兼容承诺、加弃用观测或发布周期；确认无使用后才删除 route/event。没有数据迁移可替代接口 deprecation。 | shared routes、Main handler/parser、文档和客户端；潜在收益低到中等。 | 独立于 CMv2/Permission V2 核心；TaskBook patch 与 RCD 的 runtime event 协议需协商后再做。 |

## LCDA-02C 最小清理建议

1. **先做边界确认，不清数据：** 只有在用户逐个授权的目标数据根上运行只读盘点；Memory 正文、LocalStorage 仍不纳入。保存脱敏聚合报告，不保留原始记录。
2. **首个代码候选：** 在 RCD checkpoint 修改冻结后，移除 `replanAttempts/maxReplanAttempts` 的 TypeScript 字段、codec 校验/投影和专属测试夹具；保持 checkpoint v1 外层 JSON 未知属性可忽略，不重写历史 checkpoint。运行 checkpoint codec/recovery 定向回归。
3. **WorkPolicy：** 若所有支持根计数为零，且公开类型/API 责任方确认没有外部字段契约，可移除冗余投影；若非零，先确认 budget/effect refs 是否在 checkpoint `loopBudget/sideEffects` 有等价证据，必要时归档/迁移后再删。不得在 RCD 恢复仍改动时并行。
4. **TaskBook Patch API：** 独立设计带版本的退役期与调用观测；确认仍无产品需求及外部兼容窗口完成后，再从 route、request parser、Harness patch 应用与测试中整体移除。
5. **继续保留：** 旧 `decide/verify` 恢复结算、Permission V1 fail-closed、pre-lease 恢复、TaskBook 历史读者、Memory V2/V3 migration/rollback。对 `evolve/capture` checkpoint 先查数量并决定显式恢复/导出策略。
6. **迁移后再删：** Memory legacy branches、Renderer LocalStorage 旧 layout 读取与有存量的 SessionIndex V1 行。不得以“盘点结果为 0”代替备份策略、外部 API 检查或产品留存决策。

## 本批范围边界

本批没有改动生产 Runtime、权限逻辑、Memory backend、checkpoint 字段或用户数据；没有触发 checkpoint recovery、副作用重放或真实 Provider。盘点器是只读脚本，唯一测试数据为临时目录中的合成 fixture。本报告是决策依据，**不构成对真实数据根的扫描授权**，也不启动 LCDA-02C。

## 本批验证记录

- `pnpm exec vitest run scripts/audit-compatibility-data.test.mjs`：通过，1 个文件、3 个确定性测试。
- `node --check scripts/audit-compatibility-data.mjs`：通过。
- `pnpm run check:repo`：通过，35 pass、0 fail；输出 3 组 advisory（仓库现有热点/文件行数与拆分地图计数提示，本批未改动相关生产文件）。TypeScript project references 检查通过；未运行完整 `pnpm run typecheck`，本批未修改 TypeScript。
- `git diff --check`：通过。
- 真实 Provider 验收、真实 Electron、真实用户 data root：未运行/未扫描；没有将合成 fixture 结果当作真实数据证据。
