# CMv2 P1A：记忆权限模型与作用域基础

日期：2026-10-14。审计起点：`37a36c78`。本报告在 [P0A](cmv2-p0a-context-audit-2026-10-13.md) 与 [P0B](cmv2-p0b-context-inspector-2026-10-13.md) 基础上重新核对当前源码。仓库 Coding Agent 指令仅规范开发，不是 LS Runtime Prompt。

## 1. 阶段结论与证据边界

**已验证事实**：当前没有统一的用户长期记忆读取/写入策略。路径作用域、工具审批、证据校验、索引预算各自存在，但不能替代用户授权。普通会话可以进入 global 候选；项目目录可列出其他注册项目；根资源索引无会话过滤。写入工具默认 global，旧长期分支校验还强制 global。以下各条均关联实现位置。

**已实现且单元验证**：公共 `MemoryAccessPolicy`、目标所有权投影、纯读写判定、默认私有写入目标、祖先决定交集。**未接入生产**，没有设置开关、迁移、生产默认切换、UI 修改或新的诊断持久化。它们不是已完成的安全隔离。

**推断**：项目索引/Resource 的目录祖先规则与新产品目标冲突；应在读取元数据之前统一授权，而不是只过滤最终注入正文。本文没有通过真实用户数据或攻击运行验证生产泄漏。旧数据实际归属必须逐项清点，不能从存储标签证明用户同意共享。

## 2. 现有访问路径和边界

| 路径 | 当前行为与证据 | P1B 必须覆盖的边界 |
|---|---|---|
| Main 会话/项目身份 | [run-support](../../packages/app/src/main/local-app-api/run-support.ts) 的 `resolveRunSessionOwnership` 核对 SessionIndex，拒绝改变已存在会话所属项目；新项目会话验证 ProjectIndex。`resolveOwnedRunWorkspace` 另解析项目/会话路径 | 在此生成策略，重新核对项目存在及成员工作区；不能直接接受请求体中的策略或把任意 cwd 当项目归属 |
| Runner 注册和初始记忆 | [runner](../../packages/runner/src/runner.ts) 注册当前 summary/attachments，调用 `beginRun` 时传 session/query/history/workspace，未传用户记忆策略；[run-coordinator](../../packages/memory-tree/src/memory-service/run-coordinator.ts) 先生成 root，再默认 prime 两项、预算 600 | 根、prime、refine 共用同一权限快照；资源注册与记忆读取分开 |
| 根索引 | [MemoryService.rootIndex](../../packages/memory-tree/src/memory-service.ts) 列出 active T0 Resource 前 12 项，不带会话过滤；[MemoryTree.rootIndex](../../packages/memory-tree/src/memory-tree.ts) 输出注册分支描述 | 标题、ID、存在性、计数也是披露；先过滤再排序/计数/截断。公共静态工具说明可保留，私人目录项不可保留 |
| Atom scope | [retrievalScopes](../../packages/memory-tree/src/tree-memory-v3-presentation.ts) 无条件加入 global、workspace(cwd)、project(cwd)、session(sessionId) | 从可信策略和审核绑定生成查询 scope；global 必须显式启用 |
| exact-node | [v3-retrieval](../../packages/memory-tree/src/memory-repository/v3-retrieval.ts) 核对 branch、解析后的 scope/key、subtree | 扩展前增加用户授权；成功 materialization 后再次核对目标。错误信息不能泄露未授权 revision/存在性 |
| FTS / vector / fallback | 同文件按 scope/key 查询 catalog；vector 只在 deep-search；`mergeSearchResult` 读 Atom 后没有第二次用户授权校验；索引 fallback 也信赖 catalog 过滤 | 在数据库提名之前限制，再在 Atom 实体读出后检查。测试 catalog/正文所有权不一致、缓存污染与撤销 |
| relation | [relation routing SQL](../../packages/memory-tree/src/v3/catalog-relation-routing.ts) 限制 relation 与 seed、candidate 的 scope/key、branch/status、证据/时间；[候选扩展](../../packages/memory-tree/src/memory-repository/v3-retrieval-relations.ts) 有界一跳 | 现有同 scope 限制应保留；增加候选授权与禁用/manual 过滤，避免同 scope 中未被选中的项绕过 |
| v2 / legacy | [TreeMemoryBranch](../../packages/memory-tree/src/tree-memory-branch.ts) 的 legacy 路径只对 project 列表传 cwd，exact 展开主要按分支校验；[legacy sources](../../packages/memory-tree/src/legacy-memory-branches.ts) 由 [infra](../../packages/runner/src/infra.ts) 作为 Composite 来源注册 | 每个来源都必须有权限投影，不得仅给 v3 接入。未知归属保持 pending |
| Resource Directory | [MemoryResourceBranch](../../packages/memory-tree/src/memory-resource-branch.ts) global 可见，session/run 精确匹配，workspace/project 用路径相等或祖先包含关系；index/expand/search 先用这一可见列表。`privacy`/`authority` 是描述，不是统一用户授权 | 将可见性替换为身份授权+资源分类；路径权限仍需独立保留，不能只换一处过滤 |
| Resource 正文 | 同文件 `toFragment` 可直接读已注册文件；[resolver](../../packages/memory-tree/src/memory-service/resource-resolver.ts) 委托 summary/events/workspaceIndex/attachment，接收 run/query，没有统一策略 | 文件注册不能授予读取权；读取前检查目标绑定、来源身份、文件边界及注册版本，防止陈旧路径/文件替换 |
| Project Memory Branch | [project-memory-branch](../../packages/memory-tree/src/project-memory-branch.ts) 列出全部注册项目的 ID/path；显式 ID 能选择任意注册项目并取 git log；查询候选还能由活动分数进入 | 先过滤项目目录，explicit/query/search 都仅使用授权项目；git 是运行资源，但不允许借此跨项目获取信息 |
| 项目投影 | [project-memory-projection](../../packages/memory-tree/src/project-memory-projection.ts) 用稳定 project.id 管注册组/状态，但选 Atom 仍按 scopeKey 与 project.path 相等；Resource 又注册 project/path | 投影正文是长期记忆派生物，继承源授权与禁用状态，不能改名为文件/任务资料绕开。export 是另一个显式用户动作 |
| memory_write | [tool](../../packages/memory-tree/src/memory-write-tool.ts) 有共享工具审批、用户指令/必要性来源校验、完整来源、每 run 四条；默认 long-term/global，scope 来自工具请求 | Runtime 选择目的所有权；模型建议只能收窄；读授权不授予写权限；批准工具不等于批准全局共享 |
| 内部写入 | [MemoryService.write/writeMany](../../packages/memory-tree/src/memory-service.ts) 委托 [write-service](../../packages/memory-tree/src/memory-repository/write-service.ts)；[write-policy](../../packages/memory-tree/src/memory-repository/write-policy.ts) 做内容/来源/置信度/分支约束，没有用户共享策略 | 服务入口及最终提交都检查，覆盖批量、consolidation、experience、纠正、重试队列；不能只改工具 |
| memory_manage | [manage tool](../../packages/memory-tree/src/memory-manage-tool.ts) 先 inspect，再判断本 run 是否见过/revision；[infra](../../packages/runner/src/infra.ts) 装配 inspect、替代写入、关系、supersede/invalidate | inspect 之前授权；纠正保持原所有权并覆盖三步部分失败；历史 seen 不应覆盖后来撤销。只读关闭仍允许用户经管理入口删除自己的数据，须独立管理授权 |
| 会话/压缩/恢复 | [Harness context](../../packages/harness/src/context.ts) 装配当前历史和 summary；[session-continuity](../../packages/runner/src/session-continuity.ts) 注册 session summary；[checkpoint codec](../../packages/runner/src/run-checkpoint-codec.ts) 保存恢复状态；[finalize](../../packages/runner/src/runner-finalize.ts) 捕获对话来源/反馈/结束 ledger | 历史是当前会话事实，关闭长期记忆不应清空；恢复重新取得策略，不能凭旧 working set/审批/ledger 恢复授权；被撤销记忆的摘要派生关系须检查 |
| 日志与来源档案 | [execution-log](../../packages/runner/src/execution-log.ts) 持久化工具调用配对、memoryAccess 等；[conversation-source-store](../../packages/memory-tree/src/conversation-source-store.ts) 保存用于 durable 证据的会话来源 | 来源档案不是任意历史检索许可证。日志可能保存敏感工具参数/输出及记忆片段，不得作为关闭记忆后的检索后门；本阶段不修改存储语义 |

Memory v3 **不是可假定的全体生产后端**：[config schema](../../packages/config/src/schema.ts) 的 `repositoryBackend` 默认 v2；[backend factory](../../packages/memory-tree/src/memory-repository/factory.ts) 要求 v3 有活动迁移 locator 或有效隔离根标记。P1B 必须同时覆盖实际启用后端与 legacy fallback。

另有用户管理面：[memory-routes](../../packages/app/src/main/local-app-api/memory-routes.ts)、[atom routes](../../packages/app/src/main/local-app-api/memory-atom-routes.ts)、[tree control](../../packages/app/src/main/memory-tree-control.ts) 可查询详情、管理节点/资源、导出、操作项目投影；旧 `/memory` 接口还能返回部分长期正文。[Renderer client](../../packages/app/src/renderer/api/memory.ts) 使用既有 Local App API。名为 memoryPolicy 的当前路由只修改 experienceWriteThreshold，不是共享授权设置。这些是用户管理接口，不能直接当 Agent 的授权检索端口；P1B 要保留用户管理权，同时禁止模型、子任务及工具 HTTP 请求通过这些接口回流未授权记忆。需独立验证本地 API 的调用者边界，不能因为有 readMode 就宣称接口全部安全。

## 3. 最小公共策略与判定语义

契约：[types/memory-access-policy](../../packages/types/src/memory-access-policy.ts)。实现：[memory-tree/memory-access-policy](../../packages/memory-tree/src/memory-access-policy.ts)。不读取磁盘、不加载模型、不新增服务，公开入口导出。

字段为 version=1、revision、principalId/dataRootId、sessionId/runId、可选稳定 projectId，独立 readMode/writeMode，显式 selected/disabled 的 `{kind,id}` 引用，以及独立 globalWriteGranted。Atom/Resource 相同文本 ID 不互授权限。principalId 是本地所有者命名空间，不要求新增账号系统；dataRootId 是不暴露路径的根身份。**这些身份的可信生成仍是 P1B 未实现事项，类型与 shape validator 不能证明对象可信。**

目标由 Host 根据审核过的所有权映射投影：reviewed/pending、global/project/session，匹配所有者与根；不能使用模型、Resource 文件自声明或字符串相似度提供的所有权。workspace 旧 scope 必须先经审核映射，纯函数拒绝直接解释。

读取规则：none 关闭所有长期记忆；project 允许当前已验证项目以及当前会话已审核的私有长期项；global 是用户显式启用，允许已审核 global、当前项目、当前 session，**不授予其他项目或其他 session 私有数据**；manual 只允许明确选中且本已符合所有权/当前项目/当前会话边界的项，可明确选取已审核 global。跨项目手动授权不在这一最小版本内，需要未来 Host 授权契约后才能支持。disabled 优先于所有允许。

写入规则与 readMode 无关。disabled 拒绝；ask 返回需要确认；automatic 仅表示记忆写入策略允许，原 Safety、来源完整性、作用域、证据与副作用校验仍必须通过。默认目的为当前验证项目，否则当前 session；即使 global reads 开启也不默认 global writes，需独立明确 grant。该默认函数返回逻辑 scopeKey，**目前不能直接交给旧仓库写入**：旧 long-term 只允许 global，project 存储还基于 cwd。P1B 必须修订分支/所有权与存储键适配，不冒充当前兼容。

子任务不按 none/project/global/manual 简单排序。Host 保留祖先授权，针对同一目标逐层求交；任一 deny 则 deny，任一 ask 则 ask。纯交集 helper 已实现，但保留祖先链、校验父子 session/project/run 绑定和防止省略祖先是 P1B Runtime 工作，不能由模型传入决定。

policy revision 用于设置/所有权变更后失效缓存与撤销；它不是项目 schema identityVersion。本阶段 helper 不提供 freshness 检查，Host 接入时必须将当前 revision 与 run snapshot 比较。policy 不保存 Prompt/正文/路径/用户名/凭据。未知版本/空身份/非法字段失败关闭，未知旧授权不转换为全球许可。

## 4. 项目身份与迁移兼容

[ProjectIndex](../../packages/app/src/main/project-index.ts) 新项目使用 UUID 型稳定 ID、identityVersion=2、previousPaths；rebind 保留 ID、更新路径历史，拒绝另一个项目占据相同路径。[project-coordinator](../../packages/memory-tree/src/memory-service/project-coordinator.ts) 已有 rebindProjectPath 与资源/投影刷新；[v3-ledger](../../packages/memory-tree/src/memory-repository/v3-ledger.ts) 有 scope alias 和可恢复事务。这些可复用，但不是所有权审核记录。现有 registry 的单 path 字段没有正式多工作区成员授权集合。

建议：projectId 是共享身份，workspace path 是 Host 绑定的执行位置；未来在现有项目索引增加显式成员工作区、成员版本和可撤销绑定。用户明确绑定的同项目多工作区共享同 projectId；git remote、仓库名称、父目录或内容相似性均不授予成员资格。移动/重命名保留 ID，Host 验证新位置并提高绑定 revision；历史路径只用于审计/迁移提名，不保留旧路径授权。项目丢失/未知身份时 project 读取拒绝，私有写入降级 session 或提示确认，绝不降级 global。嵌套/重叠路径必须分别绑定项目，无祖先继承；同目录冲突仍拒绝。

迁移分五步，**本阶段仅设计，没有执行**：

1. 在隔离副本清点 Atom、Resource、投影、legacy、alias、来源及文件版本，保存校验清单与可恢复备份；不扫真实正文用于诊断展示。
2. 新增小型所有权 sidecar（复用现有原子写/ledger 设施），记录 kind+ID、原存储定位/版本、候选所有权、reviewed/pending、审核来源和迁移版本。原 Atom 格式保持；sidecar 不复制正文。实际落盘格式、冲突及回滚测试由 P1B 完成。
3. sessionKey 只能在可信会话索引/来源证据一致时绑定原 session；project/workspace cwd 只能在明确项目成员关系和来源一致时提名；重叠、已删除、旧路径多重使用、来源不明一律 pending。global 标签只是旧存储范围，不证明用户同意全球共享；旧 USER/MEMORY/experience 也不例外。
4. 用户审核后原子记录绑定/共享选择。默认读取 pending 被拒绝，数据仍保留；显式 global mode 也不能把 pending 自动授权。复用 v3 alias 适配旧 storage key，但 alias 不能自行成为授权证明。
5. 验证幂等、断电恢复、旧副本回滚、索引重建、错误绑定撤销、删除项目、projection/资源一致性。新策略激活必须有版本化 gate；回滚恢复软件/sidecar 备份，不把旧广泛读取包装成新隔离模式。跨版本旧客户端忽略 sidecar 的风险须禁止共用活动根或清楚阻止启动，不能宣称仅加 sidecar 就安全。

## 5. 长期记忆与运行资源分类

| 资源 | 长期策略控制 | 另需保留的边界 |
|---|---|---|
| Atom（含经验/daily 稳定事实）、用户偏好 USER.md、项目长期记忆/私有投影、旧 MEMORY.md | 是 | 来源与所有权；不能因分支/tier/authority 标签绕过 |
| 当前 Session History | 否 | 当前 session 所有权、既有过滤；不是其他 session 检索许可 |
| Compaction Summary | 不因长期关闭整体删除 | 当前 session + summary version/覆盖游标；旧记忆衍生事实的撤销追踪，禁止恢复已撤销 working set |
| 当前附件、任务文件、工具执行结果 | 否 | 当前 run/session、文件权限、来源信任；长期记忆投影文件不能伪装附件 |
| Skills、AGENTS.md、工具指令、Runtime Events | 不按长期事实关闭 | 受启用状态、注册所有权、当前运行、项目授权和工具权限约束；用户偏好混在文档时必须显式分类 |
| 项目索引/git/workspace index | 不全等同长期记忆 | 只能当前授权项目；目录元数据及跨项目 git 也需访问控制 |
| 日志与 conversation evidence | 不是默认任务资源 | 宿主单独授权；禁止作为 memory none 的回流路径 |

[Harness context](../../packages/harness/src/context.ts) 当前 prompt-resident bootstrap 列表包括 USER.md，和 Resource Directory 是两条注入路径。P1B 必须同时控制 USER 的偏好注入及对应 resource；不能只拦 memory_tree。必要的 AGENTS/Skills 不应因 none 整体消失，但含长期事实的派生资源须保留 provenance。策略只识别经过 Host 分类的长期目标；本阶段未新增可由模型使用的“runtime exemption”。

## 6. 权限测试矩阵与已实现基础

[新测试](../../packages/memory-tree/src/memory-access-policy.test.ts) 使用纯虚构身份，无真实用户记忆。**以下“策略已测”不代表生产入口已受控。**

| 验收场景 | P1A 证据 | P1B 集成测试要求 |
|---|---|---|
| 普通新会话隔离 | none 拒绝长期目标 | Main 默认、root/prime/USER/legacy 不披露 |
| 同项目/跨项目 | Atom/Resource 相同矩阵，跨 session 同项目允许，其他项目/私有 session 拒绝 | Runner 当前项目身份映射 + 两项目隔离 fixture |
| 显式全局/手动/禁用 | global 需显式 mode；manual kind+ID、disabled、所有者/根/待审优先级 | 从 settings 到 immutable run，伪造请求体/工具参数拒绝 |
| 项目身份变化 | 稳定 ID 相等，前缀式 ID 拒绝，缺项目拒绝 | relocation/嵌套目录/reparse/成员撤销/旧 cwd 多重映射 |
| 根索引/exact/FTS/vector/relation | 统一目标判定可复用；这些入口未接入，不能称绕过测试通过 | denied 元数据零披露；每条入口越权提名与 materialization 二次校验；禁用后缓存失效 |
| memory_write 默认 | 独立 read/write、session/project 默认、无隐式 global、ask/disabled 已测 | 旧分支兼容、Main 确认 grant、commit/retry/纠正/学习同策略 |
| 子任务 | 祖先交集拒绝/ask、空链拒绝已测 | Runtime 保留可信父链，跨绑定/省略父链/重试升级拒绝 |
| 历史压缩/恢复 | 本阶段纯 helper 不操作历史；恢复未接入 | 当前历史保留；撤销后恢复旧记忆/summary/working set 不复活 |
| 旧数据/非法策略 | pending 不因 global 放行；形状异常失败关闭 | v2/v3/legacy/alias/projection 的清点、幂等、失败恢复、版本回滚 |

## 7. P1B 修改清单与发布 gate

1. Main `run-support` / run & checkpoint routes：从 SessionIndex/ProjectIndex/config 生成并校验不可由模型扩大的 policy；每次恢复刷新；主/子/后台运行都覆盖。沿用 Permission V2 宿主模式，记忆访问与工具执行权限独立。
2. 类型、Runner 初始化/ctx/恢复：携带策略和祖先限制；projectId 不再在 memory beginRun 时丢失；revision 变化清空受影响的索引/fragment/cache，保留历史。检查 direct Runner 调用，缺策略明确失败关闭而不是偷偷 global。
3. MemoryService/Tree/Composite/legacy：根索引、branch、prime/refine/expand/deep_search 的查询前+物化后判定；sourceCount/truncation/error 不泄露被拒绝资源。
4. Repository v2/v3/catalog/relation：复用 predicate 与绑定解析，所有入口包括 exact-node、FTS、vector、fallback、关系、父子目录、管理 inspect；不改变现有证据/预算规则。
5. Resource/coordinators/Bootstrap/ProjectMemoryBranch/projection：明确长期或任务资源分类，传可信身份，去掉路径祖先授权；派生资源继承源权限；跨项目索引/git 禁止。
6. writeService/tool/manage/consolidation/finalize feedback/学习/恢复队列：独立写策略，目的与所有权由 Host 决定，长期分支支持 session/project 私有逻辑，拒绝语义合并造成共享扩大，修订 intent 幂等键包括目的所有权；兼容旧 intent，不静默重复创建。用户管理 API 与 Agent 读取授权分开，检查本地 API 是否可被工具借道调用。
7. sidecar/alias/项目迁移：隔离夹具验证并提供审核、回滚、重建 gate；未通过前不切换生产默认。

上线 gate：矩阵所有入口集成覆盖；v2/v3 兼容副本断点恢复；真实 Electron 设置→请求→恢复验证；旧数据审核/回滚可复核；确认无新的原文日志；Context Inspector 原本 local/Provider 两本账与 unavailable/partial 不变。P1A 没有执行这些 gate。

## 8. P1C 最小用户设置与持久化设计

沿用 [config schema](../../packages/config/src/schema.ts)、[Main saveConfig](../../packages/app/src/main/index.ts)、[SessionIndex](../../packages/app/src/main/session-index.ts)、ProjectIndex 和既有设置布局，不增加路由框架或数据库。新设置应版本化，分“读取范围”和“保存策略”；普通新会话默认 none，已验证项目新会话默认 project，写入默认 ask、目的私有；全局读取与全局写入各有明确用户动作。

config 只保存默认用户选择（不要由 global 默认覆盖普通新会话的 none 产品默认）；会话/项目记录保存显式 override 与 revision；manual/disabled 保存 kind+ID，不保存标题、路径或正文。Host 解析审核 ownership sidecar 后生成 run policy，Renderer 仅提交设置意图并展示生效范围，不能直接提交 principal/dataRoot/可信目标或授权快照。无效项目/不存在选择用 unavailable/pending 提示，禁止自动扩大。

最小 UI：四种读模式、三种写模式、当前项目说明、手动选择入口和禁用项入口（可分阶段），未知旧记忆待审核提示；read none 下仍可进入独立管理页面查看/删除用户自己的数据，不能借管理 API 向 Agent 回注。主设置、项目默认、会话 override 的 precedence 明确为会话显式 > 项目显式 > 按会话类型产品默认；已有会话没有字段不自动视作 global consent。改设置后当前 run 至少能即时收窄，扩大等下一可信快照且显式授权；扩展方案需生命周期测试。

P0B 未来可显示“本次请求授权策略版本/模式”和 denied source 数，复用 sanitized projection，不读原执行日志、不新增完整 Prompt 采样；本文没有改变其用量口径或实现。

## 9. 验证记录与剩余风险

实际执行结果：

- 新策略单测 21 项通过；随后连同 write/manage/project branch、v3 backend/ledger、Context Trace 回归运行，共 7 文件 80 项通过（其中包含这 21 项，不重复累加）。
- `pnpm run typecheck` 通过；`verify:core` 再执行公共类型检查及 5 文件 73 项核心测试，通过，gate 的 build/recovery 等 3 项按其选择器跳过，不能称全量构建/恢复验收。
- 仓库卫生首次因新报告未加入分类索引失败，补齐索引后通过：35 项通过、3 项 advisory、0 失败；TypeScript project references 27 包通过。既有热点/拆分地图 advisory 未进行无关整理。
- 本次作用范围的 `git diff --check` 通过，报告本地链接检查通过。

未执行真实 Electron、真实 Provider、生产权限隔离测试或用户数据迁移；纯判定没有 IO，也没有进入请求组装，因此不产生新 tokenization 或默认持久化。生产仍保留旧行为，这是 P1A 范围要求，不代表安全缺口已修复。

开始时已有 `chat-layout-stability.test.ts` 与 `22-context-inspector.css` 两处 Renderer 改动；本阶段未修改、还原或纳入它们。P1A 文件留在工作区供阶段验收，没有提交 Git commit 或推送远端；本阶段到此停止，不进入 P1B。

风险：注册资源的 privacy/authority 与授权容易混淆；USER/bootstrap 与资源双入口；项目目录/投影、legacy fallback、管理 inspect 与来源档案容易遗漏；旧数据所有权不确定；并发撤销/陈旧缓存/恢复摘要污染；旧客户端不识别新授权 sidecar；现有敏感原文日志仍存在，需独立阶段处理。P1B 必须以权限测试证明修复，不能仅改 Prompt。
