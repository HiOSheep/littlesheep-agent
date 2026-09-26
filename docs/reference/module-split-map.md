# LittleSheep 模块拆分地图

最后更新：2026-09-25 20:27:30

本文件记录大型生产文件的当前所有权、目标边界和拆分顺序。它不替代项目状态，也不把行数当成唯一质量指标。

## 规则

- 生产文件目标不超过 300 行。
- 301-600 行是软上限：先确认单一职责，不能继续吸收新领域；确需保留时登记例外。
- 超过 600 行默认进入强制拆分队列；先冻结 facade 和特征测试，再移动实现。
- 拆分必须保持公共 API、持久化格式、URL、动画、导航、恢复和用户数据语义。
- 所有权标记为 A 文档、B Renderer、C Main/Adapter、D Memory、E Harness/Context；每个新增模块在移出队列前必须归属于其中之一。
- 两个队列的行数与"已完成拆分"的当前入口行数由仓库卫生门**逐条比对实测值**（同一口径：生产 `.ts/.tsx`、排除测试文件、去掉末尾空行）；数字由人写、门禁校验，不由脚本改写——生成器会把本表用来"让人再看一眼文件"的上限和队列静默改写成实际值。

## 强制拆分队列

下表行数是当前工作树的物理行数（本次逐文件实测），不是历史完成值。生产 `.ts/.tsx` 文件超过 600 行必须进入本表；已登记不等于要求立即做无收益拆分。仓库卫生扫描当前报告 138 个生产文件超过 300 行，其中 23 个超过 600 行并进入受控超限清单。

| 当前文件 | 当前行数 | 当前责任 | 目标边界 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/runner/src/runner.ts` | 2462 | run 生命周期、输入装配、Memory 反馈、日志、检查点持久化/续跑、活动任务注册、后台维护准入透传、C07 压缩 operation owner、durable final-reply publication 和资源收尾 | 保持应用服务 facade；run/effect ownership、durable recovery、effect 对账查询（`durable-effect-query.ts`）、run 模式读取（`durable-run-mode.ts`）、Runtime 失败发布（`run-failure-result.ts`）、压缩 scheduler（`session-compaction-scheduler.ts`）与续接证据装配（`continuation-evidence.ts`）已下沉，继续下沉日志、检查点、finalize publication 和收尾协调；checkpoint 预算 reconcile 保持在 `run-checkpoint.ts` 边界 | E |
| `packages/harness/src/durable-kernel.ts` | 930 | durable event command validation、capability evidence、stage transition audit、effect owner/settlement lifecycle、crash recovery、projection rebuild 和 final settlement reducer | inbox claim/materialize 已拆到独立 processor；先冻结恢复、并发和 reducer 特征测试，后续再拆 event reducer、recovery policy 与 settlement policy | E |
| `packages/harness/src/stages/execute/tool-loop.ts` | 652 | 单一模型工具循环、审批、失败记录、消息续接和运行中用户补充投递 | 用户补充消费由 `runtime-control-boundary.ts` 持有结算，主循环只在请求前后纳入消息；后续如继续增长，分离补充消息的请求桥接与现有 invocation adapter，保持单一主循环 | E |
| `packages/types/src/runtime-contracts.ts` | 872 | Context、事件、检查点、活动任务控制、执行证据、请求前缀变化原因和版本化运行时契约 | Token 账本已迁入 `token-ledger.ts`，effect ownership port 已迁入 `effect-lease.ts`，会话续接证据已迁入 `conversation-continuation.ts`；继续按 context、event、checkpoint、active-run、execution 分组并保持 barrel | E |
| `packages/channels/qqbot/src/plugin.ts` | 799 | QQ 协议、连接、消息、发送和生命周期 | transport、protocol、message-mapper、sender、lifecycle | C |
| `packages/memory-tree/src/project-memory-projection.ts` | 780 | 投影生成、同步、冲突、恢复和删除 | projection facade + render、sync、conflict、lifecycle | D |
| `packages/runner/src/runtime-event-queue.ts` | 729 | run/session 隔离、有界事件、幂等、租约、结算和快照恢复 | `RunContext` 顶层 runtime state 已由 Harness `runtime-state.ts` 统一批次写入；本文件继续独占 queue codec、lease/settle、registry 和快照恢复内部状态，保持 facade 稳定 | E |
| `packages/runner/src/run-checkpoint-disposition-store.ts` | 683 | waiting-user disposition、claim、恢复租约与有界审计持久化 | 分离 disposition codec、query 与 retention；保持原子 claim facade | E |
| `packages/harness/src/model-observability.ts` | 690 | 模型请求快照、Context 关联、Provider usage、缓存观测绑定与 C09 前缀变化原因；真实模型活动投影（含传输重试进度）已下沉到 `model-activity.ts` | 保持请求观测 facade；后续将 provider reconciliation 与 request snapshot projection 下沉 | E |
| `packages/app/src/renderer/app-shell/use-app-controller.ts` | 656 | Renderer 跨领域兼容协调、启动恢复、Runtime 设置和视图快照 | 保持装配 facade；启动恢复、持久化和领域投影继续下沉，冻结期间不得继续吸收新职责 | B |
| `packages/memory-tree/src/memory-tree.ts` | 654 | 根索引、导航、展开和搜索；working set 预算/去重/释放已拆出 | tree facade + index、navigation、expansion、branch-search | D |
| `packages/tools/src/tool-execution-service.ts` | 660 | 工具查找、校验、审批、执行生命周期、事件与结构化记录 facade | 调度、中断、记录摘要和结果处理已拆分；facade 不吸收 Harness 编排或副作用状态所有权。**已到受控上限 660**：结果收尾逻辑已移入 `tool-execution-result.ts`，下一次改动必须先完成 invocation lifecycle 拆分，不能再往上加行 | E |
| `packages/session/src/manager.ts` | 640 | 会话 JSONL、metadata、回复指纹、压缩投影/事务提交与摘要 activation facade | 保持 facade；压缩事务与 activation 投影继续下沉到 `compaction-store.ts` 边界 | E |
| `packages/memory-tree/src/v3/catalog.ts` | 637 | Memory v3 Catalog facade、Atom/FTS/账本/due/激活投影 | ledger/due 管理与 management projection 继续下沉 | D |
| `packages/runner/src/execution-log.ts` | 635 | 执行日志 schema、写入、查询、final-reply settlement promotion 与按会话原子摘要 sidecar | 分离 codec、store、query、settlement promotion 与 latest-summary store；先冻结 settlement/replay 特征测试 | E |
| `packages/channels/feishu/src/plugin.ts` | 635 | 飞书验签、事件、消息、发送和生命周期 | verification、transport、message-mapper、sender、lifecycle | C |
| `packages/app/src/main/data-root-migration.ts` | 628 | locator、清单、复制、重绑定、提交、恢复和回滚 | migration facade + plan、manifest、copy、rebind、commit、recovery | C |
| `packages/memory-tree/src/memory-repository/v3-node-store.ts` | 618 | v3 节点查询、写入编排、层级和实体关联，含 HC-12 撤销屏障 | 已进入受控超限清单；后续分离 query projection、revocation query 与 write coordinator | D |
| `packages/safety/src/permission-boundary.ts` | 614 | 三档权限矩阵、网络 safe-read descriptor、路径边界、SSRF 前置语法和 hard-deny 统一判定 | 先冻结三档权限矩阵和网络 contract，再拆 network descriptor adapter | C |
| `packages/harness/src/cache-observability.ts` | 610 | Provider、Context、Memory/Embedding 三套缓存账本、脱敏指纹和失效原因；可缓存头的切分与消息规范化已迁至 `cache-prefix-split.ts` | 保持观测适配器边界；实际 Provider 对账与 durable event log 接入后按 ledger、fingerprint、report 拆分 | E |
| `packages/app/src/main/index.ts` | 659 | Electron 启动和组合；窗口、托盘、关闭策略、活动任务聚合、Memory v3、桌面验收采样与内置浏览器宿主已下沉；启动文件模板下沉到 `bootstrap-templates.ts` | 继续抽取 bootstrap 服务，入口只保留装配顺序；按规则（超过 600 行必须进入本表）从软上限队列移入 | C |
| `packages/llm/src/client.ts` | E / Runtime | 请求生命周期、错误分类、流式解析与重试接线共享同一状态机；先冻结协议解码与观察者接线的特征测试，再拆 request builder、stream parser、response mapper 与 retry observer 接线 | 660 | 同上 |
| `packages/app/src/main/desktop-shell.ts` | 617 | Electron 窗口、托盘、关闭策略、窗口状态和退出前刷新 | 保持 DesktopShell 生命周期边界；状态 codec 留在 `desktop-window-state.ts`，隔离验收动作（缩放、最大化/还原、启动页、启动失败页、验收期是否显示窗口）留在 `desktop-acceptance-actions.ts` + `desktop-visual-acceptance.ts`；按规则从软上限队列移入 | C |
| `packages/llm/src/client.ts` | 624 | 请求构造、流式解析、reasoning/usage 归属、`Retry-After` 解析、重试接线、完成信号判定与 DSML/native 工具冲突适配 | 分离 request builder、stream parser、response mapper 与 retry observer 接线；请求 deadline 与"超时 ≠ 取消"的判定已下沉到 `request-deadline.ts`；协议解码不向 Harness/Renderer 扩散 | E |

## 软上限审查队列

301-600 行文件登记在本表；超过 600 行的文件在上方强制拆分队列和受控超限清单中管理。

| 当前文件 | 当前行数 | 主要责任 | 处理方向 | 所有权 |
| --- | ---: | --- | --- | --- |
| `packages/runner/src/run-checkpoint-codec.ts` | 471 | 检查点 schema 校验、有界 codec、序列化与文件名哈希（含 64 条写入窗口与 128 条历史兼容读取窗口） | 从 `run-checkpoint-store.ts` 拆出的 codec 边界；若继续增长，按 checkpoint 主体、resumeState、附件/工具 recipe 分组 | E |
| `packages/runner/src/run-checkpoint-store.ts` | 381 | 检查点目录的文件与原子写入、容量/保留期、诊断账本，以及"最近一次扫描"报告的组合 | codec 与目录扫描已分别下沉到 `run-checkpoint-codec.ts` 与 `run-checkpoint-scan.ts`；store 只保留文件所有权与容量策略，计数不得再回到进程生命周期累加 | E |
| `packages/tools/src/builtin/exec.ts` | 375 | 受控命令执行：黑名单与审批、工作区回滚点、进程树终止、有界流捕获，以及不透明修改前后的观察冻结/失效 | 保持"命令执行 + 结算"边界；若继续增长，先拆出进程终止与流捕获（`exec-process.ts`），再考虑观察冻结策略 | E |
| `packages/tools/src/file-observation.ts` | 323 | 文件观察的宿主半边：sha256 revision、规范路径键、同路径互斥表与有界观察表，以及写工具的 `readVerifiedFile()` 校验入口 | 保持"只登记与校验、不读写用户文件、不做策略决定"的边界；若继续增长，拆出路径键/互斥表（`observation-key.ts`）与校验入口（`observation-guard.ts`） | E |
| `packages/memory-tree/src/types.ts` | 584 | 记忆树内部和持久化类型 | 按 node、resource、audit、projection 分组 | D |
| `packages/harness/src/tests/helpers.ts` | 324 | Harness 测试夹具与 RunContext 构造 | 按夹具领域拆分；测试 helper 不进入生产 Harness 依赖 | E |
| `packages/harness/src/cache-quality-report.ts` | 378 | CACHE-09/10 三套 ledger、Provider token/outcome、latency 和保守 release gate 汇总 | 保持纯报告边界；若继续增长，拆分 token/outcome summarizer 与 gate policy | E |
| `packages/types/src/agent.ts` | 566 | 状态机、活动路由兼容、RunContext、stage 与 Hook 契约 | TaskBook、activity event 与 work policy 已分别迁入 `task.ts`、`activity.ts`、`work-policy.ts`；继续保持状态机与运行上下文边界，不再吸收领域协议 | E |
| `packages/harness/src/stages/_shared.ts` | 366 | 多 stage 共用的 JSON 模型调用、单一 session transcript 投影、附件与文本解码 helper | 保持共享 helper 边界；重试归因已收敛于同一有界调用器，若继续增长则拆 JSON retry policy 与 Context 投影 | E |
| `packages/types/src/run-context-contract.ts` | 485 | 八组高频 RunContext 字段的 owner、读写阶段、生命周期和写入查询 | 保持 machine-readable manifest；继续由 `replan-state.ts`、`reply-state.ts`、`runtime-state.ts`、`memory-state.ts`、`usage-state.ts`、`decision-state.ts`、`failure-state.ts`、`execution-evidence-state.ts`、`model-observability-state.ts` 等领域边界消费，不把具体状态写入逻辑吸回 types | E |
| `packages/web/src/fetch/dns-resolver.ts` | 397 | 系统/固定 Cloudflare DoH 解析、DNS wire 校验、TTL 缓存和取消边界 | 保持 DNS resolver 单一职责；若继续增长，拆分 wire codec、transport 与 cache，同时保持 URL policy 只接收已验证地址 | C |
| `packages/app/src/renderer/sidebar/session-actions.ts` | 396 | 对话切换、历史分页、归档/删除及会话视图令牌失效 | 保持会话生命周期 facade；历史加载和视图令牌继续共享同一会话代次边界 | B |
| `packages/app/src/shared/history-activity.ts` | 349 | Runtime 执行日志到实时/历史对话活动的共享投影、用量与 transcript 兼容形状 | 保持无 UI 依赖的纯投影边界；流式水位和交互状态只留在 Renderer | B |
| `packages/app/src/main/local-app-api/run-checkpoint-routes.ts` | 317 | checkpoint 发现、详情、补充信息、续跑、停止和放弃路由 | 保持路由 facade；将恢复准入和响应投影继续下沉到独立 adapter | C |
| `packages/memory-tree/src/memory-repository/v3-resource-store.ts` | 573 | v3 资源元数据、生命周期事务、实体投影和恢复 | 分离 resource registry、transaction recovery 与 graph projection | D |
| `packages/app/src/renderer/workspace/terminal.tsx` | 558 | 用户交互 PTY 生命周期、SSE、尺寸、命令历史和输入队列 | 保持终端事务边界，禁止吸收工作区导航或 Agent 审批职责；来源与 Agent 权限语义由 Main 明确拥有 | B |
| `packages/memory-tree/src/v3/contracts.ts` | 547 | Memory v3 atom、认识状态、事件、实体、证据与 Embedding 契约 | 按 atom、event、graph、evidence 分组并保持 barrel | D |
| `packages/harness/src/context-candidates.ts` | 464 | 把一次出站 stage 请求映射为带来源、种类、优先级和淘汰分组的 Context 候选；边界以下段落与运行中用户补充保留来源 | 保持"一次装配只描述来源与可改动程度"的单一职责；若继续增长，拆出消息分类（history/inserted/primary/tool）与尾部段落装配两个模块 | E |
| `packages/harness/src/memory-known-state.ts` | 347 | 把 Runtime 的 KeyedState 引用按允许清单投影为模型可见文本，并维护尾部稳定槽位 | 保持白名单投影边界；若继续增长，拆出规则/条目渲染与摄入校验 | E |
| `packages/harness/src/stages/ask_user.ts` | 316 | 发布模型自撰写的提问、Runtime 恢复升级说明与澄清结算 | 提问文案只能来自模型或 Runtime 事实，该边界不得放宽；若继续增长，把澄清发布与恢复升级拆成两个模块 | E |
| `packages/snapshot/src/git-checkpoint.ts` | 546 | 数据与工作区两阶段 checkpoint、同步回退和退出冻结协调 | 保持事务 facade；文件筛选、manifest codec 与 Git plumbing 已独立 | E |
| `packages/memory-tree/src/memory-repository/v3-migration.ts` | 538 | v2->v3 请求登记、启动执行、恢复、受约束回滚和 locator 状态机 | 保持事务 facade；若继续增长，分离 request/recovery 与 rollback coordinator | D |
| `packages/plugins/src/host.ts` | 543 | 插件发现、加载、启停、贡献迁移 | 分离 discovery、activation、contribution、reconcile | C |
| `packages/memory-tree/src/legacy-memory-branches.ts` | 509 | 旧记忆分支兼容 | 保持隔离，迁移结束后缩减或退役 | D |
| `packages/memory-tree/src/memory-repository/v3-ledger.ts` | 502 | v3 分片审计、恢复队列、scope alias、schema migration 兼容和事务账本 | 一次性 v2 导入已放入独立迁移模块；后续分离 audit shards、recovery queue 与 transaction ledger | D |
| `packages/app/src/main/attachment-cache.ts` | 557 | 附件索引、配额、清理和校验 | 分离 index、quota、cleanup、validation | C |
| `packages/memory-tree/src/memory-repository/v3-backend.ts` | 495 | v3 后端组合、检索 facade、management adapter 和写后维护协调 | 保持组合层；若继续增长，拆出生命周期与 maintenance adapter | D |
| `packages/app/src/shared/memory-control-contracts.ts` | 486 | 记忆文件、资源、投影、迁移和治理控制面公共契约 | 按普通文件视图与内部治理契约分组，保持 shared 无运行逻辑 | C |
| `packages/app/src/main/local-app-api/run-routes.ts` | 564 | run 流式入口、durable inbox/run lease 启动发现与到期恢复、运行时事件 ingress 和收尾路由 | 保持 HTTP 路由组合；检查点恢复与应用生命周期控制面使用独立 adapter | C |
| `packages/app/src/main/local-app-api/terminal-process.ts` | 365 |
| `packages/app/src/main/workspace-shell-discovery.ts` | 318 | 本机 Shell 探测（Windows PowerShell / PowerShell 7 / Git Bash / cmd / WSL 发行版）、可用性与配置提示、WSL 路径映射 | 保持探测与映射边界；启动参数按 Shell 分支留在 `terminal-process.ts` | C | PTY、ConPTY 与 spawn fallback 的终端进程适配、关闭状态和输入错误收敛 | 保持进程适配器边界；继续将平台差异和 write-after-close 保护留在此层 | C |
| `packages/app/src/main/provider-calibration.ts` | 318 | 运行中 Provider 的 chat、continuity、tool、abort 有界校准 | 保持纯校准编排与脱敏结果；Provider 客户端和凭证仍由 Runner/Main 负责，不继续吸收通用运行逻辑 | C |
| `packages/app/src/renderer/workspace/preview-pane.tsx` | 434 | 编辑草稿、Monaco/Markdown/媒体预览和预览状态栏 | 文件加载与保存事务已下沉到 `file-view.tsx`，HTML 运行状态与提示下沉到 `use-html-run.ts`/`html-run-notice.tsx`，静态预览帧与资源失败提示下沉到 `html-preview-surface.tsx`，Office 正文下沉到 `office-preview-panel.tsx`；继续保持编辑与展示边界 | B |
| `packages/app/src/main/local-app-api/workspace-preview-server.ts` | 336 | 工作区根作用域的有界 loopback 静态服务：token、真实路径与符号链接校验、内容类型、空闲回收与资源失败记录 | 保持"每个根一个监听 + 每次请求都重新校验路径"的边界；若继续增长，把 MIME/路径解析与监听生命周期拆开，但不得引入目录列举、CORS 头或写方法 | C |
| `packages/app/src/main/local-app-api/workspace-git-review.ts` | 472 | Git 审阅快照与单文件差异的分层读取、项目范围校验、有界一致性重读（HEAD/index/status 指纹） | 保持"读取一次 + 有界重读"的组合层；指纹规则在 `workspace-git-review-consistency.ts`，失败分类在 `workspace-git-failure.ts`，解析在 `workspace-git-review-parsers.ts`，不新增调度层 | C |
| `packages/app/src/main/local-app-api/workspace-git-review-cache.ts` | 323 | Main Git 审阅快照缓存、revision、并发、取消、TTL 和容量预算 | 保持缓存策略与 Git 解析、路由分离 | C |
| `packages/app/src/renderer/Markdown.tsx` | 387 | 聊天与预览中的 Markdown、流式分段、安全链接、代码块和 Mermaid 图表渲染 | 保持纯展示与链接导航边界；若继续增长，拆出 Mermaid/代码块渲染 adapter | B |
| `packages/app/src/renderer/workspace/review.tsx` | 383 | 审阅可见生命周期、single-flight 刷新、共享导航装配和树/差异选择 | 陈旧提示的派生与重试接线已下沉 `review-refresh-notice.ts`，本文件不再持有提示文案；保持 policy、model 与 view helper 分离，单双列偏好留在 Renderer UI 层 | B |
| `packages/app/src/main/memory-tree-control.ts` | 474 | 记忆控制面查询、v3 D0-D3 详情适配和既有管理命令 | 分离 query/detail、resource、projection command | C |
| `packages/harness/src/runtime-control-boundary.ts` | 375 | Runtime 控制事件、任务变更和运行中用户补充的队列结算与有界暂存 | 保持事件结算为单一职责；后续增长时把控制事件判定和补充暂存拆为各自的纯 helper | E |
| `packages/harness/src/durable-projection-codec.ts` | 518 | durable payload 解析、effect owner/lease 成对校验和 cache projection allowlist | Provider usage 与本地 token calibration 已下沉 `durable-provider-usage-codec.ts`；继续保持不受信 payload codec 边界 | E |
| `packages/app/src/renderer/chat/run-event-handlers.ts` | 323 | SSE 活动事件到单个对话轮次的实时归并 | 保持 reducer 适配层；若继续增长，按 transcript 与 tool/task activity 拆分 | B |
| `packages/harness/src/stages/reply.ts` | 355 | 能力/状态问答的最小 Runtime 事实契约、DSML 协议拒绝、回复 provenance 与预览闭合（常规会话已并入主循环；跨回合文案改写已删除） | 保持 REPLY facade；协议判定留在 LLM adapter，常规会话分支删除后应下沉为 capability-reply 专用 stage | E |
| `packages/harness/src/stages/execute/model-transcript.ts` | 305 | 主循环的有序 transcript 与流式增量转发（无 transcript 时直接转发文本增量） | 保持 transcript 与 assistant 预览通道的单一所有权；继续分离 reasoning 行与 tool-preparing 行 | E |
| `packages/types/src/durable-harness.ts` | 389 | durable Harness event、projection、recovery、final settlement 和 capability protocol 公共契约 | 保持版本化公共 barrel；按 event、projection、recovery 分组时维持序列化兼容 | E |
| `packages/memory-tree/src/memory-repository/resource-store.ts` | 454 | 资源注册、生命周期、重绑定和审计 | 分离 registry、lifecycle、rebind、audit | D |
| `packages/memory-tree/src/v3/event-journal.ts` | 446 | Memory v3 event 与 operation journal 的同构恢复语义 | 契约稳定后拆为两个 store，共享 bounded journal codec | D |
| `packages/memory-tree/src/workspace-resource-index.ts` | 448 | 工作区资源索引、游标和更新 | 分离 store、scanner state、change-set | D |
| `packages/app/src/renderer/workspace/file-navigator.tsx` | 337 | 目录缓存、筛选、展开路径、文件树和可见性取消 | 与 `navigator-frame.tsx` 共享壳；建立树状态特征测试后再拆 controller/view；目录请求取消与缓存恢复保持在独立 loader 边界 | B |
| `packages/harness/src/taskbook-patch.ts` | 528 | TaskBook 局部修订契约、校验和合并 | 保持纯任务书补丁边界；若继续增长，分离 schema、merge 和 validation | E |
| `packages/memory-tree/src/memory-repository/v3-atom-management.ts` | 443 | Atom move/merge/revise/invalidate/reactivate 原子 mutation 与审计 | 保持持久化 mutation 边界；语义准入留在独立 service | D |
| `packages/session/src/reply-fingerprint-store.ts` | 334 | 已发布文本指纹账本、final settlement reservation/settle sidecar、会话重启恢复与原子锁 | 保持会话级幂等存储边界；继续增长时分离 legacy fingerprint 与 settlement registry codec | E |
| `packages/memory-tree/src/v3/atom-store.ts` | 425 | atom 原子读写、轻量索引、扫描、层级和隔离 | 保持 store facade；规模验收稳定后分离 scanner/quarantine | D |
| `packages/runner/src/infra.ts` | 592 | 默认基础设施创建、Provider/Web、Memory v3 与后台维护准入装配 | durable store 组装已下沉到 `durable-harness-infrastructure.ts`；继续保持组合根并下沉 Memory 服务组装 | E |
| `packages/app/src/renderer/workspace/tab-strip.tsx` | 441 | 工作区标签渲染、关闭、重排、拖拽和溢出标签 | 将拖拽 controller 与标签视图继续保持独立，禁止吸收面板状态 | B |
| `packages/app/src/renderer/workspace/panel.tsx` | 399 | 拓展工作区页面、评论状态和工作面装配 | 保持纯组合；标签条、浏览器和文件预览事务已分别下沉 | B |
| `packages/app/src/main/development-environments.ts` | 421 | LS 工具链管理 facade、版本偏好、导入/移除事务和终端环境派生 | 保持 facade；下载器不得回填此文件 | C |
| `packages/app/src/renderer/workspace/browser.tsx` | 435 | 内置浏览器标签、导航、加载状态和网页内跳转 | 保持视图组合；历史算法和导航资格留在独立模块 | B |
| `packages/app/src/renderer/workspace/code-editor.tsx` | 428 | Monaco 编辑器唯一懒加载、模型/视图生命周期和代码查看/编辑适配 | 保持编辑器运行时单一所有者；继续将语言支持与视图状态留在独立边界，不在普通文件/审阅组件重复初始化 | B |
| `packages/app/src/renderer/workspace-persistence.ts` | 582 | 会话工作区布局 schema、draft 迁移、路径重绑定、快照恢复与规范化 | 保持纯数据转换边界；继续增长时分离 schema/codec 与路径转换 | B |
| `packages/app/src/renderer/workspace/use-workspace-session-layouts.ts` | 429 | 会话工作区桶、draft 接管、本地持久化、Main 镜像恢复与关闭事务所有权 | 保持会话状态 Hook；文件保存行为继续留在布局 controller/file-close 边界 | B |
| `packages/app/src/renderer/app-shell/preferences.ts` | 378 | Renderer 本地偏好键、基础 codec、旧工作区布局迁移与镜像应用判定 | 保持兼容偏好入口；后续将旧布局迁移下沉到 workspace persistence adapter | B |
| `packages/prompt/src/builder.ts` | 499 | Prompt 分段、缓存边界之上的稳定装配（`stableText`/`stableSegments`）与边界之下尾段的渲染 | 保留 builder facade；缓存边界常量与判定见 `prompt/src/cache-boundary.ts`，复杂 section 继续移入 `sections` | E |
| `packages/app/src/renderer/settings/plugins.tsx` | 394 | 插件发现、筛选、启停、来源确认和代码授权 | 新能力进入插件宿主或独立设置组件 | B |
| `packages/app/src/renderer/settings/models.tsx` | 373 | 供应商卡片、编辑/删除事务、会话草稿与"丢弃未保存修改"确认 | 表单状态规则已下沉到 `model-provider-draft.ts` 与 `provider-editor-session.ts`；卡片与编辑视图后续拆出独立组件，不要在页面里继续堆领域逻辑 | B |
| `packages/app/src/renderer/workspace/use-workspace-layout-controller.ts` | 600 | 布局尺寸交互、标签命令、草稿编辑与关闭前保存编排 | 会话布局持久化已下沉到 `use-workspace-session-layouts.ts`；保持交互 controller，冻结期间不得继续吸收新职责 | B |
| `packages/types/src/activation.ts` | 390 | 持久 Atom 与语义缓存共用的连续 activation 契约和纯计算 | 按 evidence、scoring、projection 分组并保持 barrel | E |
| `packages/app/src/renderer/chat/assistant-turn.tsx` | 592 | 思考摘要、执行过程、验证与最终产物的渐进式披露 | 持续拆出纯展示段；禁止吸收状态决策；紧凑显示只折叠无需关注的行，失败与权限拒绝不得隐藏 | B |
| `packages/app/src/renderer/ArchiveManager.tsx` | 464 | 归档加载、树和操作，以及永久删除确认 | controller + project/session 视图；删除影响文案、确认层与同步防重复（`deletingRef`）已分别下沉到 `deletion-impact.ts`、`ui/danger-confirm.tsx` 与 ref 守卫 | B |
| `packages/plugins/src/channel/manager.ts` | 388 | 渠道调度、会话和发送 | 分离 dispatch、session、delivery | C |
| `packages/app/src/main/local-app-api/memory-routes.ts` | 353 | 记忆文件、旧控制面兼容、资源、项目投影及迁移子路由组合 | 保持纯路由组合；新增治理进入独立子路由 | C |
| `packages/memory-tree/src/task-query.ts` | 345 | 当前请求、有限近期历史、版本化摘要、排除和任务转向语义 | 按 reference、negative/contrast、summary continuity 拆分 | D |
| `packages/app/src/main/attachments.ts` | 563 | run 附件解析和所有权分类 | 分离 ownership、metadata、content resolver | C |
| `packages/app/src/renderer/api/run.ts` | 365 | Renderer 普通 run、SSE、稳定 request key 与 continuation failure 映射 | 保持传输 facade；继续将响应 codec 和重连观察下沉 | B |
| `packages/app/src/renderer/workspace/review-diff.tsx` | 467 | Git diff 模型、单双列 Monaco 装配、陈旧提示条和行评论层组合 | 无需文本 hunk 的变更（重命名/权限）由 `review-diff-metadata.ts` 命名，提示的文案与色调由 `review-refresh-notice.ts` 决定，diff 映射、评论附件和删除行适配继续独立 | B |
| `packages/app/src/renderer/workspace/review-inline-deleted-comments.tsx` | 410 | 单列删除行评论手势、view zone 编辑器和附件发布 | 与通用行评论共享纯 helper；后续下沉删除行 view-zone controller | B |
| `packages/app/src/renderer/workspace/review-inline-deleted-line-numbers.ts` | 326 | 单列删除区域的源行号投影和交互目标同步 | 保持 Monaco view-zone adapter，不吸收评论编辑状态 | B |
| `packages/app/src/renderer/chat/activity-model.ts` | 323 | Agent 活动、公开推理、工具步骤和完成态投影 | 保持纯活动模型；展示组件不得回填状态归并逻辑 | B |
| `packages/app/src/renderer/chat/run-actions.ts` | 337 | 聊天发送、流式事件所有权和输入/附件重试保留 | turn fingerprint 与完成态消息归并已下沉；保持发送 facade，停止请求去重留在本模块 | B |
| `packages/app/src/renderer/sidebar/project-section.tsx` | 480 | 项目树、折叠状态、项目菜单和持久化刷新 | 保持项目区视图边界；项目事务继续由 sidebar actions 拥有 | B |
| `packages/app/src/main/workspace-layout-index.ts` | 393 | Main 多会话工作区镜像、旧单快照兼容、边界规范化与项目路径重绑定 | 保持持久化索引边界；继续增长时分离 store codec 与路径重绑定 | C |
| `packages/app/src/renderer/runtime-recovery/use-checkpoint-recovery.ts` | 355 | Checkpoint 发现、续跑请求、恢复入口状态与资源/权限状态展示 | 状态选择与展示 helper 已下沉到 `checkpoint-recovery-state.ts`（含发现失败与损坏记录的入口派生）；保持恢复控制器，不要再吸收展示逻辑 | B |
| `packages/runner/src/run-checkpoint-controller.ts` | 318 | Checkpoint inspect、唯一 head、claim 和 durable resume identity 查询 | 保持控制面 facade；后续分离 query/claim policy | E |
| `packages/app/src/renderer/ui/icons.tsx` | 359 | 无状态声明式图标集合 | 浏览器图标家族已拆出；其余继续按家族拆分，冻结期间不得继续增长 | B |
| `packages/memory-tree/src/memory-service.ts` | 343 | Memory Service facade 与运行协调器组合 | 保持 facade；新增能力进入领域协调器 | D |
| `packages/channels/telegram/src/plugin.ts` | 342 | Telegram 协议和生命周期 | 分离 transport、mapper、sender | C |
| `packages/memory-tree/src/memory-repository/v3-retrieval-materializer.ts` | 331 | 候选优先级、证据封套和治理读取投影 | 保持候选投影单一来源 | D |
| `packages/cli/src/commands/import-repo.ts` | 323 | 导入流程、Git、LLM 和进度 | 分离 source、distill、progress adapter | C |
| `packages/memory-tree/src/index.ts` | 325 | Memory Tree 公共 barrel 与稳定导出 | 保持无逻辑导出层 | D |
| `packages/channels/webhook/src/plugin.ts` | 319 | Webhook server、鉴权和消息 | 分离 server、auth、mapper、sender | C |
| `packages/app/src/renderer/composer/runtime-picker.tsx` | 459 | 输入栏模型、供应商和推理程度选择器及二级菜单定位 | 保持选择器视图编排；继续增长时分离菜单定位与选项渲染 | B |
| `packages/context/src/tokenizers/deepseek-v4-encoding.ts` | 483 | DeepSeek V4/V4.1 消息、thinking、DSML 工具调用与 numeric reasoning budget 的官方请求 framing | 保持纯编码职责；继续增长时分离 DSML 工具序列化与 framing 变体表 | E |
| `packages/context/src/tokenizers/deepseek-v4-counter.ts` | 497 | DeepSeek V4 官方 tokenizer 资源校验、下载、加载与有界精确计数缓存 | 继续增长时分离通用不可变资源下载器 | E |
| `packages/context/src/context-engine/snapshots.ts` | 342 | Context/模型请求快照、哈希和有界裁剪 | 分离 builders 与 hash/shape codec | E |
| `packages/experience/src/experience-store.ts` | 309 | 经验索引、备份、并发和衰减 | 分离 index、backup、mutation、decay | D |
| `packages/memory-tree/src/memory-repository/v3-retrieval.ts` | 307 | 分支/作用域约束检索与精确治理读取路由 | 保持检索编排 | D |
| `packages/harness/src/response-continuity-text.ts` | 581 | 回答连续性所需的有界文本、Atom 标记、显式标签值、Runtime 摘要保真字段和否定语义解析 | 保持纯文本解析边界；若继续增长，分离标签值解析与通用连续性术语处理 | E |
| `packages/app/src/main/local-app-api/runtime-routes.ts` | 425 | Runtime 配置、Web policy projection、data-root/应用生命周期与 Web cache 路由 | Runtime payload 投影已下沉到 `runtime-payload.ts`、模型供应商路由已下沉到 `provider-routes.ts`；继续保持路由 facade，不再吸收 provider 或 payload 组装 | C |
| `packages/app/src/main/local-app-api/session-routes.ts` | 469 | 会话查询、权限模式更新、显式会话目录切换和历史 projection 路由 | 保持 session API facade；继续将 session mutation 与 response projection 分离 | C |
| `packages/app/src/renderer/workspace/line-comment-surface.tsx` | 340 | Monaco 行评论交互、附件和 Web/文件来源关联的共享 surface | 保持交互 adapter；继续将 attachment lifecycle 与 view-zone rendering 下沉 | B |
| `packages/config/src/schema.ts` | 406 | 全局配置 schema、Web policy 和 provider/模型配置校验 | 保持版本化 schema facade；provider 模型条目规范化与用户声明能力分别位于 `provider-models.ts`、`configured-models.ts` | E |
| `packages/config/src/model-capabilities.ts` | 357 | 内置 provider/model 能力注册表：上下文窗口、输出上限、推理档位、Provider reasoning 映射和精确/不可用 tokenizer 状态 | 保持只读内置事实表；用户声明能力进入 `configured-models.ts`，不在此文件累计 | E |
| `packages/harness/src/stages/execute/side-effect-ledger.ts` | 376 | 可恢复工具执行的 Runtime 效果外壳：效果描述、幂等键、租约、durable intent 与有界 reconciliation key 投影 | 保持效果登记边界；用户声明模型能力等无关职责不得进入；继续增长时分离 lease 与 intent payload 组装 | E |
| `packages/harness/src/context.ts` | 386 | RunContext 构造、Web evidence sink 和工具上下文装配 | 保持 Context 入口；继续将 Web evidence 与基础 Context builder 分离 | E |
| `packages/types/src/web-retrieval.ts` | 440 | Web policy、provider、fetch、citation 和 evidence projection 公共契约 | 保持公共 barrel；按 policy/provider/evidence 分组并维持向后兼容 | E |
| `packages/web/src/runtime.ts` | 570 | 每轮 Web retrieval quota、取消、citation、cache 和 evidence projection | 保持 per-run runtime facade；继续将 quota/citation/evidence adapter 分离 | E |
| `packages/memory-tree/src/conversation-source-store.ts` | 487 | append-only 会话来源存储、幂等 capture、manifest 与有界 session/run 目录（catalog 分页/降级/取消） | 保持不可变来源边界；后续分离 catalog 查询与存储 codec，catalog 不返回 payload | D |
| `packages/runner/src/session-continuity.ts` | 483 | post-run 压缩编排、单次受控 Provider 摘要+候选提炼、pending proposal 结算与恢复 | 保持压缩操作编排边界；后续按 snapshot 读取、proposal 校验、candidate settlement 拆分 | E |
| `packages/session/src/compaction-store.ts` | 358 | 压缩 pending journal、摘要投影、activation 证据与候选 outcome 存储 | 保持原子持久化边界；后续分离 pending codec、projection 与 activation store | E |
| `packages/runner/src/durable-event-store.ts` | 538 | 哈希分区、append-only event 文件、cursor/idempotency 校验和 fail-closed replay | 保持文件 store facade；后续按 codec、partition IO、replay query 拆分 | E |
| `packages/runner/src/durable-inbox-store.ts` | 581 | 持久 command inbox、按 run/command 领取、claim owner fencing、有界重启发现/lease wake-up、complete/fail 和幂等校验 | 保持 inbox facade；后续按 codec、lease policy、query 拆分 | E |
| `packages/runner/src/durable-run-lease-store.ts` | 353 | next run 的跨进程 acquire/reclaim/renew/release、活动/过期枚举、最早到期点与持久格式校验 | 保持 run lease store 单一职责；heartbeat 与 recovery policy 留在独立 adapter | E |
| `packages/harness/src/cache-observation-store.ts` | 353 | scope-authorized cache observation 存储、查询与时间窗质量报告 | 保持脱敏存储与 scope 边界；后续按 codec、查询和报告拆分 | E |
| `packages/app/src/renderer/workspace/line-comments.tsx` | 619 | 普通文件与双列 diff 的行号映射、手势、装饰、共享评论 surface 装配和附件发布 | 保留 Monaco 映射与交互 adapter；draft、表单、卡片、几何和通用 view-zone 生命周期由共享模块维护 | B |
| `packages/skills/src/loader.ts` | 320 | skill 索引与正文装载；新增 per-run 生成的动态正文注册（如 taskbook）后越过 300 行 | 后续按索引构建、正文装载、动态注册分离 | D |
| `packages/app/src/renderer/chat/use-chat-scroll-controller.ts` | 367 | 对话区滚动位置的唯一所有者：底部吸附、阅读锚点、resize burst 修复队列与"回到最新"状态 | 保持"位置状态只有这一个所有者"的边界，`app-shell/chat-view.tsx` 只渲染；若继续增长，把 resize burst（观测器 + 事件 + 逐帧收敛）拆成独立模块，锚点算术必须留在 `chat-scroll-anchor.ts` 的纯函数里 | B |

## 已完成拆分

下表记录已经完成的模块拆分与其历史基线；"当前入口"列给出今天仍在使用的入口及其当前行数。

| 原始文件 | 原基线行数 | 当前入口 | 已形成边界 | 完成日期 |
| --- | ---: | --- | --- | --- |
| `packages/app/src/renderer/api.ts` | 1088 | 22 行兼容 barrel | `run`、`sessions`、`runtime`、`attachments`、`workspace-files`、`terminal`、`extensions`、`browser`、`development-environments`、`memory` 与 `common` | 2026-07-14 |
| `packages/app/src/main/local-app-api-server.ts` | 288 | 319 行 server 组合入口 | HTTP 基元、run、projects、sessions/archive、runtime、memory、workspace、browser、development-environments、terminal、workspace preview servers、extensions、公共 contracts；HTTP server 的优雅关闭（`closeHttpServer`，含 750ms 强制断连）由 `http-server-shutdown.ts` 承担 | 2026-08-05 |
| `packages/app/src/renderer/App.tsx` | 9935 | 16 行兼容入口 | `app-shell`、`approval`、`chat`、`composer`、`runtime`、`settings`、`sidebar`、`ui` 与 `workspace` 领域视图和 controller | 2026-07-14 |
| `packages/memory-tree/src/memory-repository.ts` | 1279 | 171 行 repository facade | 版本化后端选择、证据定位、稳定 Repository 公共契约和后台维护/关闭兼容入口；management 使用独立 facade，v2/v3 实现均已下沉 | 2026-08-05 |
| `packages/memory-tree/src/memory-service.ts` | 1120 | 343 行 service facade | run、摘要、daily consolidation、附件、事件、Bootstrap、Skills、工作区资源、项目投影和资源管理协调器；Atom reconciliation 保持为 Runner 独立组合端口 | 2026-07-15 |
| `packages/context/src/engine.ts` | 139 | 152 行 engine facade | candidates、budget、eviction、assembly、counting、snapshots，以及迁出的 append-only 记账（`context-engine/append-only.ts`）与预算适配（`context-engine/fit.ts`） | 2026-07-15 |
| `packages/harness/src/stages/execute.ts` | 867 | 21 行 stage facade | guidance、prompt 与单一主循环入口；TaskBook 步骤执行器已随第二执行体系删除 | 2026-09-21 |
| `packages/harness/src/stages/execute/runners.ts` | 330 | 172 行主循环执行入口 | TaskBook 编排、步骤调度与分支执行已随第二执行体系删除；只保留循环、发布与失败记录 | 2026-09-21 |
| `packages/harness/src/stages/verify.ts` | 90 | 103 行 VERIFY facade | 只做 Runtime 可证事实的判定：结构通道 `pass`、其余记 `unverified`、失败走有界恢复；已删除验证模型调用，模型裁决、证据装配和裁决契约随请求一起移除，不得重新引入第二套判定入口 | 2026-09-20 |
| `packages/harness/src/stages/verify/routing.ts` | 322 | 329 行路由与证据模块 | VERIFY 结构证据记录、已验证回复发布和恢复/重规划路由；失败状态通过 `failure-state.ts` 写入，步骤状态继续由 `task-state.ts` 拥有；不再装配模型请求 | 2026-09-20 |
| `packages/harness/src/stages/recover.ts` | 150 | 161 行恢复入口 | Runtime 自有恢复路由：有界重试、显式停止、升级到 ASK_USER（不再请求恢复模型）；恢复策略留在 `stages/recover/policy.ts`，入口只做状态编排；不得重新引入模型裁决或第二套恢复入口 | 2026-09-20 |
| `packages/app/src/renderer/MemoryTreeView.tsx` | 1007 | 205 行用户记忆文件视图 | GUI 只展示六份记忆文件并仅允许编辑 `SOUL.md`；Atom、关系、向量、迁移和审计退回 Runtime 与内部治理 API | 2026-07-16 |
| `packages/app/src/main/workspace-office-preview.ts` | 339 | 27 行路径适配器 | 有界 Office/OpenDocument 只读解析器已迁入 `@littlesheep/documents/office-preview`，Main 只保留路径感知与预览预算适配 | 2026-09-22 |

以下文件已回落到 300 行以下，退出软上限队列；再次越过 300 行时重新登记：`packages/harness/src/runtime-awareness.ts`（285）、`packages/app/src/main/local-app-api/terminal-routes.ts`（290）、`packages/memory-tree/src/v3/maintenance-worker.ts`（293）、`packages/memory-tree/src/v3/storage-coordinator.ts`（299）、`packages/app/src/renderer/api/workspace-files.ts`（212）。`packages/harness/src/stages/memory-intent-gate.ts` 已随 CAPTURE 删除，登记行已移除。

`packages/harness/src/default-harness.ts` 现在是 91 行的状态机 facade：Checkpoint 证据归一与恢复入口位于 `checkpoint-resume.ts`，回答连续性保持在 `response-continuity*.ts` 领域模块；Runtime 摘要精确字段的文本封套与重建逻辑分别位于 `session-summary-fidelity-text.ts` 与 `runner/src/session-summary-fidelity.ts`。这些文件均未越过各自登记上限，后续新增验收维度应继续进入独立采样器或领域服务。

模型观测与执行日志的截断窗口责任保持在现有模块：`packages/runner/src/run-checkpoint.ts` 负责 checkpoint snapshot ID 的最近 64 条引用窗口，`packages/runner/src/execution-log.ts` 负责 execution log 持久化边界的最近 64 条 request/context snapshot 窗口，`packages/runner/src/run-checkpoint-codec.ts` 负责 64 条写入窗口与 128 条历史兼容读取窗口；两者共享 `@littlesheep/context` 的上限常量，不新增 facade 或 ownership group。检查点目录的"当前状态"由 `run-checkpoint-scan.ts` 每次扫描重新给出，`run-checkpoint-store.ts` 只保留扫描看不到的常驻发现（残留 `.tmp`、裁剪失败、定向读写失败），因此计数不随进程存活时间增长。

## 拆分顺序

1. 先冻结共享契约、兼容 facade 和特征测试。
2. C 与 D 优先拆 Main/API 和 Memory，减少 B/E 的跨层依赖。
3. B 已在 API barrel 稳定后完成 Renderer 组合壳拆分；后续 Renderer 细分继续按真实窗口验收。
4. D/E 所有权下的 Memory、Harness/Context 已完成 facade 化与内部领域拆分，LLM Call Contract 和记忆意图校验已在稳定边界上接入；`packages/harness/src/memory-state.ts` 负责 Memory 顶层 RunContext 批次校验与写入，`packages/harness/src/usage-state.ts` 负责顶层 provider usage 快照，`packages/harness/src/decision-state.ts` 负责活动路由、需求评估和澄清状态，`packages/harness/src/failure-state.ts` 负责 `lastError` 与 `recoveryAttempts`，`packages/harness/src/execution-evidence-state.ts` 负责顶层工具结果、调用记录和副作用账本写入，Repository/Service 持久化事务、请求级 context snapshot 观测和 TaskBook 内部执行证据仍留在各自领域。
5. Memory v3 已完成独立 snapshot、mapping、build、validation、commit 和 filesystem 模块；检索、证据封套与 KnownState、conversation source store、projection mutation record/commit store（内部兼容名仍为 `raw-record*`）、feedback manager、management facade、working set、atom API router、迁移协调器和可复用 live validation state 均已拆出；Atom reconciliation、leaf hierarchy reparent、same-claim revision 与 evidence-backed correction 均分为公共契约、纯校验、Runtime 编排和 Harness 提案适配边界。旧 Renderer Atom 管理原型已退役，普通 GUI 收敛为记忆文件视图；内部治理 API 继续服务诊断、迁移与审计。后续拆分只在能改善不失忆、任务执行效率或真实维护成本时进行，避免无需求的结构搬迁。

## 当前共享契约与 facade

这些契约先于实现搬迁冻结，旧模块继续 re-export 或组合它们，避免一次性修改所有调用方：

| 契约/Facade | 唯一来源 | 当前兼容入口 | 下一步移动边界 |
| --- | --- | --- | --- |
| 会话、项目、归档 | `packages/app/src/shared/session-project-contracts.ts` | `main/session-index.ts`、`main/project-index.ts`、`main/archive-index.ts`、`renderer/api.ts` | sessions/projects/archive API client 与 main routers |
| 工作区产物、布局、终端活动 | `packages/app/src/shared/workspace-contracts.ts` | 三个 main index 与 `renderer/api.ts` | workspace/terminal domain clients and routers |
| Runtime、Provider、数据根 | `packages/app/src/shared/runtime-api-contracts.ts` | `local-app-api-server.ts`、`renderer/api.ts`、`data-root-migration.ts` | runtime/data-root services |
| 记忆与文件视图 | `packages/app/src/shared/memory-control-contracts.ts` | `memory-tree-control.ts`、`renderer/api.ts` | 内部治理路由保持独立；普通 Renderer 只消费记忆文件契约 |
| 附件元数据 | `packages/app/src/shared/attachment-contracts.ts` | `attachments.ts`、`renderer/api.ts` | attachment API/import service |
| Local App API 路由 | `packages/app/src/shared/local-app-api-routes.ts` | `local-app-api-server.ts`、`renderer/api.ts` | 分域 router modules; static and dynamic path encoding remains centralized |
| Agent 状态机、模型请求、运行时事件与检查点 | `packages/types/` | `runner`、`harness` public barrels | Tool Execution Service 已归 `packages/tools/`；事件生产与恢复控制面留在 App adapter，Runtime 契约继续由 types/runner 维护 |
| Prompt 分段与缓存边界 | `packages/prompt/src/cache-boundary.ts` 与 `packages/prompt/src/builder.ts` 的 `stableText`/`stableSegments` | `harness/src/stages/reply.ts`、`harness/src/stages/execute/runners.ts` | 边界之上的段落就是 system message；边界之下的 bootstrap、运行时事实、检索契约与压缩摘要各自作为追加消息发出，其只追加记账与 `appended-only` 淘汰范围位于 `packages/context/src/context-engine/append-only.ts` 与 `packages/harness/src/context-candidates.ts` |

当前 facade 输入输出：`startLocalAppApiServer(initialRunner, options) → LocalAppApiServer`、`createRunner(options) → AgentRunner`、`MemoryService`、`ContextEngine`、`ToolExecutionService`、各 Harness stage function 和 renderer `api.ts` 导出函数。Call Contract 与统一工具执行已通过稳定入口接入；后续实时事件职责同样不得重新塞回 facade。

## 受控超限清单

以下不是永久例外，而是有界拆分队列。301-600 行文件继续由上方软上限队列管理；超过 600 行文件只能接受修复、特征测试或完成拆分所需的兼容修改，且不得超过登记上限。到期时必须复查、下调上限或完成拆分。

**本轮复查到期：2026-10-24**（下表所有条目共用这一日期，表格里一律写"同上"——续期只改这一处）。到期前必须逐条复查（路径仍存在、仍超过 600 行、未越过上限）；仓库卫生门在到期日已过时直接失败，日期不会自动续期。2026-09-24 已按此口径完成一次逐条复查。

| 文件 | 所有者 | 暂缓原因 | 行数上限 | 复查日期 |
| --- | --- | --- | ---: | --- |
| `packages/app/src/renderer/app-shell/use-app-controller.ts` | B / Renderer | 启动恢复、Runtime 设置与会话投影仍共享跨领域不变量；先冻结兼容 facade 和状态快照特征测试，再下沉持久化与恢复编排 | 700 | 同上 |
| `packages/channels/qqbot/src/plugin.ts` | C / Channel Plugins | 等待渠道 transport 与协议适配端口稳定后拆分；本轮只补充连续性 request identity 透传 | 820 | 同上 |
| `packages/memory-tree/src/project-memory-projection.ts` | D / Memory | 投影事务、冲突与恢复必须在特征测试覆盖后迁移 | 780 | 同上 |
| `packages/app/src/renderer/workspace/line-comments.tsx` | B / Renderer | 行评论手势、Monaco view zone、草稿编排与附件发布仍共享同一份映射与生命周期；评论锚点比较（`anchorText`、"代码行已变化"）本轮加入。先冻结交互与附件发布的特征测试，再把手势判定、锚点比较与草稿归约移入 `line-comment-model.ts`，view zone 高度计算移入 `line-comment-view-zones.ts` | 680 | 同上 |
| `packages/runner/src/runner.ts` | E / Runtime | run 生命周期、输入装配、检查点续跑、后台维护准入透传、C07 压缩 operation owner 接线、durable final-reply publication 和资源收尾仍共享跨阶段不变量；effect 对账查询、run 模式读取、Runtime 失败发布、压缩 scheduler 与续接证据装配（`continuation-evidence.ts`）已下沉，先冻结恢复、幂等和单一发布特征测试，再拆分协调职责 | 2595 | 同上 |
| `packages/runner/src/execution-log.ts` | E / Runtime | execution log 现在还负责 final-reply settlement promotion；必须先保持审计、transcript 和 settlement identity 一致，再拆分 codec/store/query | 680 | 同上 |
| `packages/types/src/runtime-contracts.ts` | E / Runtime | Context、事件、检查点、执行证据、请求前缀变化原因仍共享版本边界；会话续接证据已迁入 `conversation-continuation.ts`，其余拆分时必须保持现有 barrel 与持久化兼容 | 925 | 同上 |
| `packages/runner/src/runtime-event-queue.ts` | E / Runtime | 安全边界接入已经完成；租约、结算、快照恢复与 ActiveRunRegistry 契约刚稳定，补齐拆分特征测试后再下沉 codec/registry | 760 | 同上 |
| `packages/memory-tree/src/memory-tree.ts` | D / Memory | 根索引、导航和预算状态共享不变量，先冻结 facade | 660 | 同上 |
| `packages/channels/feishu/src/plugin.ts` | C / Channel Plugins | 等待渠道 transport 与事件验签端口稳定后拆分；本轮只补充连续性 request identity 透传 | 640 | 同上 |
| `packages/runner/src/run-checkpoint-disposition-store.ts` | E / Runtime | disposition claim、跨进程锁、有界历史和续跑 identity 查询共享原子写入不变量；先冻结 P0 连续性矩阵再拆 codec/query/retention | 740 | 同上 |
| `packages/app/src/main/data-root-migration.ts` | C / App Main | 数据迁移事务需保持恢复与回滚原子性，先补齐阶段检查点 | 637 | 同上 |
| `packages/memory-tree/src/v3/catalog.ts` | D / Memory | activation schema 与检索投影刚稳定，先保持 Catalog facade 和恢复契约；本轮新增激活与关系投影后复查 | 640 | 同上 |
| `packages/safety/src/permission-boundary.ts` | C / Safety | 网络 safe-read descriptor、路径边界、SSRF 前置语法和 hard-deny 统一判定刚接入；先冻结三档权限矩阵和网络 contract，再拆 network descriptor adapter | 660 | 同上 |
| `packages/tools/src/tool-execution-service.ts` | E / Tools | Web 工具接线需要保持统一校验、审批、事件、取消和持久化投影不变量；先完成 WB-09 发布矩阵，再拆 invocation lifecycle 与 Web result projection | 660 | 同上 |
| `packages/harness/src/durable-kernel.ts` | E / Harness | 恢复、并发 cursor、effect lifecycle 和 authoritative settlement 刚接入；并发恢复 action 去重后上限调整，先冻结跨实例并发与重启恢复特征测试，再拆 event reducer、recovery policy 和 settlement policy | 940 | 同上 |
| `packages/harness/src/stages/execute/tool-loop.ts` | E / Harness | UX-03 运行中用户补充必须在同一模型循环的请求前后接入，并阻止旧工具提议执行；已有针对性回归和真实窗口门，后续先分离补充桥接而不扩张主循环 | 660 | 同上 |
| `packages/harness/src/cache-observability.ts` | E / Harness | Provider、Context、Memory/Embedding 三套账本刚接入 request-bound 脱敏观测；先冻结 CACHE-03/04/05 确定性矩阵，再按 ledger、fingerprint、report 拆分 | 680 | 同上 |
| `packages/harness/src/model-observability.ts` | E / Harness | 模型请求、Context、Provider usage、缓存证据与 C09 前缀变化原因（`prefixChange`）统一关联；先完成真实 usage 和 durable replay 证据，再拆 provider reconciliation 与 request snapshot projection | 705 | 同上 |
| `packages/session/src/manager.ts` | E / Runtime | C08C 压缩事务在前驱 CAS、候选回执与 activation 投影之间共享持久化不变量；先冻结崩溃/并发恢复特征测试，再把 compaction transaction 与 activation adapter 移出 facade | 660 | 同上 |
| `packages/memory-tree/src/memory-repository/v3-node-store.ts` | D / Memory | HC-12 撤销屏障把 tombstone/superseded 来源复核放进索引写入路径；先冻结撤销、纠正、合并与重放特征测试，再拆 revocation query 与 write coordinator | 630 | 同上 |
| `packages/app/src/main/index.ts` | C / App Main | 冷启动专项把 bootstrap 拆成三段（数据前置 / UI 索引与监听 / Runner 与就绪发布），阶段编排本身仍在组合根；先把 Local App API 选项对象与 Runner 构建下沉到独立模块，再下调上限 | 660 | 同上 |
| `packages/app/src/main/desktop-shell.ts` | C / App Main | 冷启动专项的隔离验收需要窗口状态与文档切换（启动页、失败页、最大化/还原、渲染器是否已接管），这些都必须触达私有窗口状态；先把窗口状态 codec 与验收快照保持在既有下沉模块，再把这两组辅助方法移出 | 620 | 同上 |
