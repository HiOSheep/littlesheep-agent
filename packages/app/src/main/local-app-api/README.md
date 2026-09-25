# Local App API

最后更新：2026-09-26 05:34:55

本目录承载 Electron Main 与 Renderer 之间的 loopback HTTP/SSE 桥。它是本地应用内部接口，不是外部渠道网关；外部渠道由插件宿主提供。

会话上下文用量记录额外携带 `sessionCache`：本会话累计的输入/缓存读取/未缓存与精确命中率，供 composer 指示器展示；它是 provider 用量的汇总，不引入第二套真相来源。
## 结构

| 模块 | 职责 |
| --- | --- |
| `contracts.ts` | Server 构造参数和生命周期公共契约；`getRunner()` 返回 `AgentRunner \| undefined`，`getExecutionReadiness()` / `respondReadiness()` 提供 `/runtime/readiness`。 |
| `http.ts` | JSON、SSE、请求体上限和 HTTP 错误基元；`openSse()` 统一发送响应头与 15 秒注释心跳，单连接待写数据达到 512 KiB 前主动断开慢观察者，并幂等释放 timer/listener。`RuntimeNotReadyError`（503 `runtime-not-ready`）与 `resolveRunner()` 是"执行未就绪"的唯一失败语义。 |
| `bearer-auth.ts` | 验收与校准类接口的 bearer token 校验。 |
| `run-routes.ts` / `run-support.ts` | Agent run、流式事件、审批、中断、会话归属和产物；内部再接入 `run-checkpoint-routes.ts` 与 `runtime-event-request.ts`。`resolveRunWorkspace` 是每次 run 的**唯一工作区事实**：请求目录优先于 `agents.defaults.workspace`，再回落到 workplace，并在此归一化成绝对路径交给 Runner，因此提示、工具 cwd、权限分类和产物归属读的是同一个值。归一化保留非 ASCII 目录名与其中的空格（`run-support.test.ts` 断言中文路径既不转写也不转义），只统一分隔符与相对段。**项目会话只看自己的目录**：`resolveOwnedRunWorkspace` 先解析归属，项目会话用会话记录的目录（没有记录时用项目目录），渲染器随每次请求下发的 `runtime.workspace` 只是"没有自身绑定的会话"的默认值——否则保存一次默认目录、或在另一个窗口切换会话，就会把项目会话搬走，而收尾时的会话索引又会把这个搬迁写成永久事实（先失败后通过的回归在 `run-stream-api.test.ts`）。 |
| `run-checkpoint-routes.ts` / `run-checkpoint-view.ts` | 启动检查点发现、详情、续跑流和放弃；只把内部状态投影成有界诊断。`toCheckpointDiagnostics` 把 store **最近一次扫描**的结果映射成两个互斥计数：`invalidFiles` 是读不出来的记录数（每份文件算一次），`warningCount` 只统计不属于这些记录的发现（残留临时文件、目录 I/O）。此前 `warningCount` 直接取诊断条目总数，而每条不可读记录本身也贡献一条，于是同一份坏文件被同时说成"无法读取"和"不完整"。 |
| `run-lifecycle-routes.ts` / `application-lifecycle-routes.ts` | 活动任务快照、`active_runs` SSE、暂停/继续/中断控制和 `/application/acceptance` 验收入口；监听器生命周期归 Main 的 `RunActivityMonitor`。 |
| `project-routes.ts` | 项目注册、重绑定、归档转换和目录创建。 |
| `session-routes.ts` | 会话列表、独立/项目会话重命名、归档、删除、执行日志重放和上下文用量记录；重命名同时更新会话 metadata 与 UI 索引，索引失败时回滚 metadata。`PATCH /sessions/:id` 另接受 `workspacePath`，作为**项目会话显式换目录**的唯一入口（必须是已存在的绝对目录；独立会话没有自己的目录，请求该字段会被拒绝，因为它跟随请求与默认目录）。 |
| `runtime-routes.ts` / `provider-routes.ts` / `provider-calibration-route.ts` / `runtime-payload.ts` | Runtime、Provider key、数据根、应用重启、Provider 校准和 RuntimeState 投影。模型引用校验（`validateModelRef`）必须按**解析后的模型 id** 比较：供应商的 `models` 既可能是裸 id 数组，也可能是带元数据的对象数组（设置页保存的自定义供应商就是后者），直接 `models.includes(model)` 会让自定义供应商的模型在选择器里可选、选中后却被 500 拒绝（UX-11 实机验收发现并修掉）。 |
| `web-provider-check.ts` | 用户主动触发、进程内保存结果的 SearchProvider 检查协调器；Web 配置变化或 Runner 重建即失效。 |
| `memory-routes.ts` / `memory-atom-routes.ts` | Skills、记忆树、记忆策略、项目记忆投影和 Atom 证据导出。 |
| `memory-migration-routes.ts` | Memory v3 迁移、回滚和固定本地向量模型准备。 |
| `workspace-routes.ts` | 附件导入、文件、布局、产物、Git 审阅入口，以及 HTML 运行服务（`/workspace/preview-server` 的 `POST`/`DELETE`/`GET`）。 |
| `workspace-file-service.ts` | 安全目录列表、预览和文本保存。 |
| `workspace-preview-server.ts` | 运行工作区 HTML 页面的**有界 loopback 静态服务**（UX-26）：每个工作区根一个监听，绑定 `127.0.0.1` 的临时端口，URL 形如 `http://127.0.0.1:<port>/<32 位 token>/<相对路径>`。只答 `GET`/`HEAD`；`Host` 必须是 loopback；请求必须带 token，解码后拒绝 `..`/`.`/NUL；解析结果再经 `realpath` 校验仍在根内（符号链接逃逸拒绝）；目录只在存在 `index.html` 时按其回应，**从不列目录**；单文件上限 32 MiB，带 `nosniff`/`no-store`，**不发 CORS 头**；最多 4 个服务（超出淘汰最久未用）、30 分钟空闲回收、显式 `stop`/`stopAll`。它不代理进程、不执行项目脚本、不安装依赖。 |
| `workspace-git-*.ts` | 仓库/分支定位、只读命令、过滤器安全策略、porcelain/numstat/diff 解析、未跟踪扫描、分层 staged/unstaged/untracked 审阅快照和按 revision 绑定的 Diff；状态扫描按工作区有界缓存并合并 in-flight 请求，Diff 并发受限，调用方取消不会取消其他观察者。 |
| `workspace-support.ts` | 工作区边界、scope 和资源索引同步。 |
| `terminal-*.ts` | PTY/进程、终端会话、命令捕获、一次性命令和终端路由；`terminal-permission.ts` 区分用户自控终端与 Agent 发起的命令。 |
| `browser-routes.ts` | 内置浏览器分区状态与缓存/数据清理，以及 `/browser/diagnostics`（运行页面报告过的脚本报错/资源失败，来自 `../embedded-browser-diagnostics.ts` 的有界记录）。 |
| `development-environment-routes.ts` | 开发环境状态、版本偏好、导入和移除接口。 |
| `extension-routes.ts` | 插件与外部渠道控制面。 |
| `vscode-launcher.ts` | VS Code 命令发现与启动。 |

## 路由领域

- Run：`/run`、`/run/stream`、`/approvals/:id`、`/run-checkpoints`（`/:id` 详情、`/:id/resume/stream` 续跑、`/:id/abandon` 放弃）。
- 会话：`/sessions`、`/projects`、`/archive`、`/runs/:id`。
- Runtime：`/state`、`/runtime`、`/runtime/readiness`、`/runtime/web/*`、`/runtime/cache-quality`、`/runtime/provider-calibration`、`/config/*`、`/data-root/*`、`/application/restart`、`/application/acceptance`、`/application/active-runs`（含 `/stream` 与 `/:id/control`）。
- 工作区：`/workspace/*`（含 `/workspace/review/*`、`/workspace/terminal/*`）、`/attachments/*`、`/external/open`。
- 记忆：`/skills/*`、`/memory/*`。
- 扩展与其余控制面：`/plugins/*`、`/channels/*`、`/browser/*`、`/development-environments/*`。

静态路由、动态前缀和 ID 编解码只以 `../../shared/local-app-api-routes.ts` 为准。

## 执行未就绪时的行为

监听在 Runner 之前建立（窗口要早于执行能力可用），因此路由分成三类：

- **未就绪也照常应答**：`/runtime/readiness`（由 `respondReadiness` 短路）、`/sessions`、`/projects`、`/archive`、`/runtime`，以及整个应用生命周期域（`/application/acceptance`、`/application/active-runs`，后者的控制与 SSE 在无 Runner 时失败关闭）。`/application/acceptance` 另提供仅隔离验收使用的 `resize`、`maximize`、`minimize`、`startup-page` 与 `startup-error` 动作（`resize` / `maximize` 供 CS-02 在多个窗口宽度与最大化/还原两种状态下核对原生覆盖区；`minimize` 供启动期间的窗口生命周期检查，最小化后窗口不参与截图、检查的是 DOM 状态；`startup-page` / `startup-error` 把生产同一份启动文档、真实失败文案交回窗口，以便对这两个靠等待无法到达的页面捕获像素），无对应能力时返回 501。
- **失败关闭为 503 `runtime-not-ready`**：所有真正需要 Runner 的分支。它们必须用 `resolveRunner(context.getRunner)` **在用到该 Runner 的分支内**惰性解析——不得把 `getRunner()` 提到函数开头，否则 `/sessions` 这类元数据路由会在 Runner 未发布时一起失败（这正是实测中发现的缺陷：Runner 构建失败时侧栏会空白）。
- **Runner 发布后启用**：`setRunner()` 同时构建 RunRouter 并初始化附件缓存，调用方在它 settle 之前不发布执行就绪，因此没有请求会看到半成品 router。
- **恢复期间的路由隔离**：`local-app-api-server.ts` 不得在请求入口等待 `RunRouter.create()`；否则旧任务恢复会让 `/sessions`、`/runtime` 和工作区预览一起无响应。只在 RunRouter 完成后原子发布实例；此之前 Run/Checkpoint/审批入口返回 503，已有元数据路由继续服务。
- **旧事件异步补扫**：RunRouter 先等待现代租约与收件箱中可恢复任务的检查，再开放执行；遍历所有历史事件分区的旧版兼容恢复在后台继续，已有租约的 run 不重复恢复。后台扫描在 router 停止后不得继续发起新的恢复。

`getRunner()` 返回 `undefined` 表示"执行不可用"，由组合根持有该状态（`packages/app/src/main/index.ts` 的 `runner` 引用只在 `startExecution()` 中赋值）。

## 维护规则

- `../local-app-api-server.ts` 只负责组合和生命周期，不新增领域实现。
- 路由返回 `true` 表示已处理；未匹配必须返回 `false`，由总入口统一生成 404。
- 长生命周期资源必须归属一个 router/server 实例，并在 `stop()` 中释放 controller、timer、listener 和子进程。
- SSE 路由统一调用 `openSse()`，不能复制响应头、心跳或缓冲策略；必须同时处理请求中止、响应关闭和订阅建立期间的竞态，任何退出路径只能释放一次 timer、listener 和订阅。
- 普通 Agent run、Checkpoint 续跑和活动任务订阅的 SSE 只是观察连接；观察者断开不会取消 Main 持有的任务。显式中断必须走活动任务控制入口。终端主动命令保持独立语义，观察连接断开时仍取消对应命令；用户自己输入的交互终端不读取 Agent 权限模式，只有 Agent 发起的命令才经过 `terminal-permission.ts` 的边界判定。
- `writeSse()` 在响应已关闭时安全返回；Node 的普通背压不会立即断流，只有累计待写数据越过 512 KiB 上限才关闭该观察连接。不得通过无界排队补偿慢客户端。
- Git 审阅必须复用同一份仓库快照：普通仓库使用一次带 `--branch --ahead-behind` 的状态查询解析分支、upstream 和 ahead/behind，staged Diff 同时兼容无首个 commit 的仓库；文件 Diff 必须携带快照 revision，陈旧 revision 返回 409，不能为旧树隐式重扫仓库。
- 不复制 shared contracts，不改变既有 URL、SSE 事件名、状态码或持久化语义。
- 修改后运行 App typecheck、对应 API 特征测试、全量测试、构建和恢复检查。

## 静态服务的资源失败记录（UX-25 第 4 条）

`workspace-preview-server.ts` 的有界 loopback 服务按条目记录**被拒绝的子资源请求**（路径、状态、时间，上限 30 条）与成功计数：静态预览不运行脚本，帧内看不到缺失的样式表或图片，这个服务是唯一目击者。记录随 `GET /workspace/preview-server` 一起返回（`assetFailures`/`assetSuccesses`），渲染器据此在预览上方列出原因并提供重试。

## 文件磁盘状态查询（UX-25 第 3 条，2026-09-26）

`GET /workspace/file-stat?root&path` 只回 `{ path, relativePath, exists, modifiedAt, size }`：静态预览面板据此在用户编辑期间发现"磁盘上的版本已变化"或"文件已被删除"，而不是等保存时撞 409。实现是 `statWorkspaceFile`（不读内容、不做预览工作），路径校验与预览/保存共用同一套 `resolveWorkspaceRoot`/`resolveWorkspaceTarget`。

## Git 审阅读取的一致性（UX-27 第 2 条，2026-09-26）

`workspace-git-review-consistency.ts` + `workspace-git-review.ts`：一次审阅读取由多条只读 Git 命令组成，**不是**原子快照。因此在装配前取指纹（`HEAD`、`.git/index` 的 mtime/size、以及**与装配同参数**的 `status --porcelain -z` 指纹），装配后重新取一次；不一致就**有界重读**（默认 2 次尝试，即 1 次重试）。两次都赶上变化时快照照常返回，但带 `unstable: true`，界面据此显示"仓库在读取期间仍在变化"，而不是把混合状态当成新结果。指纹必须用同一组参数取（用更窄的探针会让每次读取都被判成竞态，集成测试当场抓到过这个假阳性）。

## Git 读取失败的分类（UX-28 第 1 条，2026-09-26）

`workspace-git-failure.ts` 把整次审阅读取的失败按 Git 自己的 stderr 分类（`not-repository` / `dubious-ownership` / `permission-denied` / `corrupt-repository` / `timed-out` / `cancelled` / `git-unavailable` / `unknown`），每类给一句可执行的原因与下一步，原始 stderr 只保留首行且不超过 200 字符。分类作用于整次读取（index 损坏只让 `status` 失败而 `rev-parse` 仍成功），并映射为快照的 `availability` 与 `message`；取消仍然抛出（调用方按 AbortError 处理）。绝不自动写 `safe.directory` 或任何全局配置——属主不符时只把 Git 的话转达给用户。

## 无文本 hunk 的元数据变更（UX-28 第 3 条，2026-09-26）

纯重命名（或权限变化）只有 extended header，没有 `@@`：`parseDiffMetadata` 把它们解析成 `metadata`（`rename from/to`、`similarity index`、`old/new mode` 等，键保持 Git 原文），`readDiffLayer` 据此返回，而"该层使用了普通 unified diff 之外的格式"提示只在既没有 hunk 也没有元数据时出现。计数语义（分层增删之和，不是 HEAD 到工作树净变化）与两层并存的行为有 `workspace-git-layers.test.ts` 与 `workspace-git-review-metadata.test.ts` 钉住。

## 审阅上限与截断的可见性（UX-28 第 5 条，2026-09-26）

上限仍在原处（列表 2,000 个文件、每层 5,000 行、每层 8 MB），但现在都有实测：`workspace-git-review-limits.test.ts` 用 2,100 个未跟踪文件断言 `filesTruncated: true`、`files.length === 2000`、`totalFiles === 2100`，并且**合计被标成不完整**（`countsComplete: false`，因为 `additions`/`deletions` 只覆盖被列出的文件）；用 6,000 行改动断言该层 `truncated: true` 且提示里写明 5000 行上限。