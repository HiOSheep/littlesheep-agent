# CMv2 P1B-1：可信记忆身份与运行时权限传递

日期：2026-10-14。基于 main `37a36c78` 与保留的 P1A/界面工作区改动。前置资料：[P0A](cmv2-p0a-context-audit-2026-10-13.md)、[P0B](cmv2-p0b-context-inspector-2026-10-13.md)、[P1A](cmv2-p1a-memory-access-2026-10-14.md)。本阶段不进入读取隔离、写入改造、迁移或设置 UI。

本报告包含首次实施及同日阶段复核。P0B 报告描述的是当时的全应用页面；目前工作区标签页、紧凑会话总览与请求轨迹是用户另行授权的 UI 修改，不属于 P1B-1 权限工作。本文的请求口径和隐私边界仍以当前实现为准。

## 1. 已实现与阶段边界

**已实现**：Main 签发进程内授权句柄；Runner 绑定最终 session/run/cwd；MemoryService 持有授权上下文；版本/当前绑定复核端口；必须携带父上下文的子任务接口；无正式身份调用的受限适配；所有权映射的有界内存 CAS 基础。

**未实现**：全体读取入口执法、USER/legacy/resource 隔离、持久 sidecar、用户设置及授权审核、实体迁移、写入目的改造、完整撤销/缓存失效。所有授权快照明确为 `enforcement: propagation-only`。现有 global 检索与 memory_write 默认仍沿旧链路工作，不能将新快照的 none/disabled 解读为生产读取/写入已经关闭。

## 2. 实际调用链

```text
Renderer JSON（只可提交会话/项目/工作区意图）
 → Main Run Ownership / SessionIndex / ProjectIndex
 → createHostMemoryAccessGrant（注册身份 + 执行位置 + 版本复核闭包）
 → RunInput.memoryAccessGrant（不可 JSON 复制的一次性句柄）
 → Runner executeRun（最终 SessionManager sessionId + runId + cwd）
 → MemoryService.createRunAccessContext（数据根、句柄和绑定校验）
 → MemoryService.beginRun(input, opaqueContext)
 → 私有 run→context Map
 → getMemoryAccessContext / isMemoryAccessCurrent / createChildRunAccessGrant
```

实现证据：[Main host](../../packages/app/src/main/memory-access-host.ts)、[run routes](../../packages/app/src/main/local-app-api/run-routes.ts)、[ownership guard](../../packages/app/src/main/local-app-api/run-support.ts)、[checkpoint routes](../../packages/app/src/main/local-app-api/run-checkpoint-routes.ts)、[Runner](../../packages/runner/src/runner.ts)、[MemoryService](../../packages/memory-tree/src/memory-service.ts)、[授权模块](../../packages/memory-tree/src/memory-access-context.ts)。

Main 拒绝请求体中的 memoryAccessPolicy/memoryAccessGrant/memoryAccessContext/memoryPolicy 字段，恢复入口也拒绝；已有 standalone session 不能通过附加 projectId 改变归属。Main 对最终运行自行生成 ID，保留既有 requestKey 幂等身份。新会话先由 Runner 创建权威 SessionManager 记录，句柄只允许绑定本次 run 的最终会话；指定已存在会话的句柄严格匹配 sessionId。

grant/context 用模块私有 WeakMap 持有证明，外部只得到冻结空对象。JSON 序列化/复制、结构相似对象、错误根/运行/会话/工作区均不能替代证明。一次性消费在异步复核之前置位，避免并发双消费；验证失败需 Host 签发新句柄。策略与祖先投影 clone，不返回内部可变引用。授权不放入 RunContext/ToolContext/Prompt、日志、检查点或 Context Inspector。

同日复核补强：异步 policy resolver 完成后再次调用 Host current，避免绑定期间版本变化仍返回授权；MemoryService.beginRun 接收既有 opaque context 时同步核对 input.workspace，禁止将同 run/session 的有效上下文用于另一个执行位置。这不是实际文件读取时的完整 TOCTOU 防护。

可信边界是 Host 的 Node 代码和现有本地 API 入口，不是 JavaScript 类型本身。导出的 root grant 构造器是特权 Host API；恶意的同进程原生扩展不在此能力句柄的防护范围内，模型/JSON 请求没有该能力。没有新增授权 HTTP 路由。

## 3. 身份来源与受限兼容

| 入口/状态 | 新授权上下文 | 兼容与限制 |
|---|---|---|
| Main 新普通会话 | Runner 新建 session，Host root，none/ask，无项目/全局 grant | 仅传递；既有检索/写入不变 |
| Main 已索引项目会话，cwd 等于当前注册位置 | 稳定 projectId、projectIdentityVersion、binding fingerprint、project/ask | 必须同时核对会话归属、ProjectIndex 和规范化实际路径 |
| 已验证项目的新会话（尚无 sessionId） | 绑定 Runner 新建 session 后传递项目身份 | 结算前 SessionIndex 可尚无行；结算后的行若出现须与授权归属一致 |
| 指定 sessionId，但 UI 索引缺失 | standalone-adapter，none/disabled，无 projectId | 不假设缓存缺失意味着 global/project consent；保留旧恢复/执行路径。后续索引验证后才可签发项目授权 |
| 项目会话明确切换到注册位置之外，且 SessionIndex 已保存该执行位置 | standalone-adapter，none/disabled，无 projectId | 运行位置可沿现有用户操作切换，但不会自动成为项目成员；不授予原项目记忆权限 |
| 不可信 cwd/项目名/目录后代、缺失注册项目 | 不获得项目授权；未受 Host 会话执行位置支持的项目请求拒绝 | 不用父目录、名称、git remote 或相似度推断归属 |
| CLI / channel / background / 直接 Runner，没有 Host 句柄 | standalone-adapter，none/disabled，无项目/全局 grant | origin、workspaceContext.projectId 或 cwd 不升级授权；后台由可信 Main 正常入口发起时可带 Host 句柄 |
| 直接 MemoryService.beginRun，无上下文 | 同一受限适配 | 不阻断旧导航测试/SDK，但不生成项目/global 授权证明 |
| checkpoint/普通等待任务续跑 | Main 新句柄；Runner 所有执行分支继续传递 | 旧 checkpoint 的字段不能恢复可信句柄；CLI 恢复仍受限适配 |

SessionIndex 是现有 UI 归属缓存，SessionManager JSONL 才是会话正文权威；本阶段复用两者，没有另建会话身份系统。缺索引适配不是正式历史所有权审核。`local:<rootId>` 表示本地数据根所有者命名空间，不是新增登录账号或 OS 用户认证。

rootId 为活动根 realpath 的 SHA-256 标识，Windows 按既有路径语义忽略大小写；不输出根路径。对根的移动/重新绑定需要新授权，**没有持久稳定 UUID sidecar**。同一规范化根对应同一命名空间；不同根的句柄不能互用。跨根迁移保持身份的规则留待 P1B-4，不把路径 hash 当迁移证明。

## 4. 项目身份、版本与撤销

复用 [ProjectIndex](../../packages/app/src/main/project-index.ts) 的稳定 ID、identityVersion、pathUpdatedAt/createdAt 和 rebind；项目成员位置本阶段仅支持现有注册 path，不增加第二套项目注册表。`realpath` 后的路径相等是绑定验证，不是路径前缀成员关系。显式 Session workspacePath 可以证明执行位置，但不能证明属于项目。

| 版本 | 含义 | 当前处理 |
|---|---|---|
| policy.version | 策略协议 | 只接受 1，非法版本拒绝 |
| policy.revision | 用户授权配置修订 | 本阶段无设置存储，固定 0；检查合法整数。未来 Host revision provider 接入 current 闭包，不宣称设置撤销已实现 |
| projectIdentityVersion | 项目索引身份格式版本 | 保留现有 2；旧记录显式映射为 1，不是成员修订号 |
| projectBindingRevision | 本次注册成员绑定指纹 | hash(projectId, realpath, identityVersion, pathUpdatedAt/createdAt)，与界面活动时间分开 |
| ownership binding revision | 元数据映射 CAS 版本 | 独立递增，见内存映射基础 |
| entityRevision | Atom/Resource 实体版本 | sidecar 前置契约保留，实际实体读取核对未接入 |

Host current 闭包复核当前根、执行位置、会话 scope/project/workspace、项目存在性与绑定指纹。rebind、删除项目、已见索引行消失、归属/执行位置变化会使旧上下文过期；touch 的 lastActiveAt 不扩大权限。新绑定必须重新签发。beginRun 前复核；显式 `isMemoryAccessCurrent`/`memoryAccessContextIsCurrent` 和上下文读写判定再次复核。**目前每次旧 Branch 检索没有调用这些接口**，P1B-2 必须接入。

结束/异常退出撤销并移除 run context；关闭父运行使子上下文失效。`createChildRunAccessGrant(parentRunId, runId, workspace)` 必须找到活动父运行，使用相同 session/project/root/workspace，接口没有可省略父链或提升策略的参数。全链决定取交集，任一 deny/ask 不能被子级 allow 覆盖；JSON parent 不可用。未接入新的任务框架或自动委派机制。

## 5. 所有权映射基础与 P1B-4 前置

[memory-ownership-bindings](../../packages/memory-tree/src/memory-ownership-bindings.ts) 提供 `MemoryOwnershipBindingStore` 和默认 1024 项的 InMemoryOwnershipBindings：version=1、revision、entityRevision、最小化 target。CAS 校验前序版本，完全相同的更新可幂等重试，冲突不改变旧值；返回 clone；拒绝正文/额外元数据字段及跨根/所有者覆盖。Atom/Resource 用 kind+ID 区分。

初次创建（revision=0、expectedRevision=undefined）及后续更新均支持完全相同的幂等重试；不能把冲突或不同正文元数据当作重试。单测验证跨根覆盖失败后旧映射保留。

此 store **没有被读取权限或生产迁移使用，也没有落盘**。未知旧数据的 lookup 为 undefined，必须按未确认处理；夹具中的旧 global 项保持 pending，没有自动变成 reviewed。没有复制 Atom/Resource 正文，没有操作真实用户数据。

P1B-4 必须实现 durable adapter、原子写与失败恢复、实体版本核对、用户审核证据、迁移 locator/alias 的一致性与回滚。现有 [v3 ledger/alias](../../packages/memory-tree/src/memory-repository/v3-ledger.ts) 和 [project coordinator](../../packages/memory-tree/src/memory-service/project-coordinator.ts) 可复用；本阶段没有将旧 alias/cwd/global 标签认定为授权。内存 CAS 单测不能作为断电恢复或 sidecar 已存在的证据。

## 6. 兼容性证据与 P1B-2 接入清单

v2/v3 真实 Runner 集成使用隔离根和合成 LLM，验证 Host 项目身份进入 MemoryService、直接调用不接受自声明项目、JSON grant 拒绝、历史保留及 Context Inspector 投影可读。v2 原有 Composite/legacy 来源、v3 的候选 scope 与 Write/Manage 不改。六类请求基线的序列化大小保持 22663/23058/22930/23794/23326/24674 bytes；本次未重新校准 Token，不能宣称 token/performance 优化。

P1B-2 具体接入点：

1. MemoryService 根/branch/prime/refine/expand/deep_search：先 `isMemoryAccessCurrent`，用受控上下文决定，而不是调用方携带 snapshot；过滤后再计数、截断、返回错误。
2. MemoryTree/Composite/legacy 与 ProjectMemoryBranch：统一元数据和正文授权，不允许候选来源绕过；所有项目索引/Git 只在授权身份中导航。
3. v2/v3 exact/children/FTS/vector/fallback/relation：查询前限制 + materialization 后目标核对，manual/disabled 同样作用于关系候选。
4. Resource Directory/Resolver、USER Bootstrap、项目投影/附件/summary：明确长期 vs runtime 分类，派生资料继承来源授权，防止借文件/附件名称回流。
5. 缓存、工作集与 checkpoint：消费版本/失效接口；恢复重新授权，撤销旧授权片段。历史/压缩本身保持当前会话连续性。
6. Main 管理 API、conversation source、日志与工具 HTTP 回流：检查调用者和所有权，不从 Inspector 元数据推导许可。

写入目的与 memory_write 默认改造仍属于后续写入阶段；本任务不借读取接入修改其语义。

## 7. 验证、改动范围与剩余风险

实际验证记录：

同日阶段复核的当前结果（与下面首次实施记录有重叠，不累计为独立覆盖）：

- 定向联跑 **16 文件、153 项通过**：P1A 策略、13 项句柄/祖先/CAS 测试、5 项 Host 测试、v2/v3 两类真实 Runner 调用链、MemoryService、Write/Manage、Main stream/checkpoint/ownership、SessionIndex/ProjectIndex、CLI、Inspector API/适配/页面。
- v2/v3 集成追加证明：MemoryService 拒绝执行位置不符的 supplied context，未安装 run 授权；授权过期不会调用 LLM；正常索引故障仍可降级并最终释放上下文。Host 追加验证活动时间更新不改变绑定授权、项目删除撤销、指定缺索引会话使用受限快照、索引归属变化使旧授权失效。
- 基线与兼容联跑 **4 文件、30 项通过**：六场景真实组装、ContextInspection、圆环旧口径、v3 backend。六类 wireBytes 仍为 22663/23058/22930/23794/23326/24674；tokenizer 本次 unavailable，没有重新计数或宣称性能优化。
- 当前 `verify:core` 通过：5 文件、73 项，仓库卫生 35 passed/3 advisory/0 failed，27 包 TypeScript project references 及 workspace typecheck 通过；gate executed=3/skipped=3。App Main/Renderer 单独 TypeScript 与差异空白检查也通过。未执行的 build/recovery gate 不标为通过。
- 本次没有重新运行真实 Electron；此前用户授权的会话总览 UI 已有真实 Electron 21 项验收，属于该 UI 版本的证据，不能冒充本次授权补强后的 Electron 验证。当前授权版本的跨层运行证据是隔离 v2/v3 Runner 集成。

以下为首次实施记录：

- 定向联跑 11 文件、110 项通过：Host/调用链/句柄/CAS、Main 流式与 checkpoint、P1A 策略、MemoryService、Write/Manage、CLI、Inspector。其后新增授权过期与普通索引故障注入，使用 v2/v3 调用链补测；次数重叠，不重复累计成独立覆盖数量。
- 完整 Runner 回归 78 项通过，覆盖 durable 结算/恢复、渠道来源、既有受控写入与管理；这是确定性模拟 LLM 的运行证据，不是外部 Provider 质量验收。
- SessionIndex/ProjectIndex/Run Support 3 文件、34 项通过。六类隔离基线通过，包含真实文件工具与压缩，不重新测 Token；请求序列化字节数保持不变。
- `verify:core` 通过：5 文件、73 项核心测试；仓库卫生 35 项通过、3 advisory、0 失败，TS project references 27 包通过。gate executed=3/skipped=3，跳过项不冒充构建/恢复通过。
- 全 workspace TypeScript 与 app Main/Renderer TypeScript 通过。报告本地链接、本阶段差异检查通过。
- 已运行真实 Electron 44.4.5 + 隔离本地 HTTP Provider 的 Inspector 脚本，15 项检查通过：工作区内显示、草稿/滚动/焦点、Agent 运行、双账本、缺失状态、隐私与会话关联。截图/result 位于本机临时验收目录，没有进入源码提交；不代表外部 Provider 计费验收。

新增测试：[Host 单元](../../packages/app/src/main/memory-access-host.test.ts)、[真实调用链](../../packages/app/src/main/memory-access-host.integration.test.ts)、[句柄/祖先/CAS](../../packages/memory-tree/src/memory-access-context.test.ts)。未运行真实用户数据迁移、断电 sidecar 恢复、完整安装包或全读取隔离验收。

调试中发现并修复：UI 索引缺失/显式非项目执行位置被误当作整个运行失败，改为无项目授权的受限适配；异步身份解析后 SSE 测试需要等待 Runner 接受，不以 start frame 代替就绪；授权过期被原记忆降级 catch 捕获，改为 `MemoryAccessAuthorizationError` 必须停止。普通索引加载故障仍可降级，但保留有效授权上下文直到运行结束。上述故障注入确认过期时不会调用 LLM，普通故障可以继续。

本阶段实际新增：Main host 与两类测试；memory-access-context、内存 ownership store 与测试；本报告。实际修改：Main run/run-support/checkpoint routes 及流式测试的异步等待；Runner run/恢复传递与清理；MemoryService/context exports；P1A target validator 的公开导出及类型说明注释；Memory/Runner README、文档索引。

开始时存在的 P1A 契约、策略/测试、P1A 报告及 README/index 变更均保留。本阶段在共享 index/README 上追加内容，没有还原它们。开始时已有的 Renderer app-shell/workspace/styles 改动与 `scripts/verify-context-inspector.mjs` 是此前 UI 请求结果；本阶段不修改或纳入提交。没有提交 Git commit 或推送远端。

同日复核新增修改范围：`memory-access-context.ts/.test.ts`、`memory-ownership-bindings.ts`、`memory-service.ts`、`memory-access-host.test.ts`、`memory-access-host.integration.test.ts`、本报告及 Memory README。此前 UI 还改动了 Main `context-inspector-routes.ts/.test.ts`、shared `context-inspector-contracts.ts` 和 Renderer `context-inspector/*`；它们同样是开始前已有修改，不属于本阶段。未操作 Git 暂存区或创建混合提交。

剩余风险：授权传播不等于检索执法；旧数据归属、USER 双入口与目录元数据仍需 P1B-2/P1B-4；用户配置 revision 尚无持久化生产者；root hash 不提供可移动持久身份；同进程特权代码可以签发 root grant；既有日志敏感原文风险未改变。Main fresh check 与未来实际文件读取间仍需处理 TOCTOU/缓存失效，本阶段没有提供全路径撤销完成保证。

P1B-1 完成后停止，等待验收，不进入读取隔离、写入改造、正式迁移或设置 UI。
