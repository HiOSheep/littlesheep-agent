# Electron Main

最后更新：2026-09-26 05:57:16

主进程是桌面产品组合根：负责启动顺序、用户数据基础设施、Runner/PluginHost 装配、Local App API、窗口和退出。

## 入口与所有权

- `index.ts`：启动与关闭编排；不得继续吸收领域实现。启动分三段：①数据根迁移、用户布局、keychain、config、Memory v3（顺序不可改，是任何写入者的前置条件）；②UI 索引 + Local App API 监听 + 窗口提前加载渲染器（此时执行能力未就绪）；③Runner 与 RunRouter 构建完成后发布执行就绪。`runner` 引用只在第③段由 `startExecution()` 赋值。
- `bootstrap-timing.ts`：仅在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 时记录无用户正文的结构化启动阶段耗时；`processUptimeMs` 是唯一冷启动锚点（Electron 的 `process.getCreationTime()` 不是同一时间轴，禁止用它做差值）；正常启动不输出、不轮询。
- `runtime-readiness.ts`：执行就绪的唯一事实来源（`starting`/`ready`/`failed` + 阶段 + 原因 + 端口），经 `../shared/runtime-readiness-ipc.ts` 的通道推给窗口，并由 `/runtime/readiness` 暴露给渲染器；窗口每次发布时重新解析，关闭到后台替换窗口不会丢失通知。
- `local-app-api-server.ts`：兼容 facade，只负责 loopback server、领域路由装配、可变 Runner/PluginHost/Config 热替换，以及实例级资源（run/terminal router、附件缓存、向量模型与开发环境管理器）的启停顺序。Runner 通过 `getRunner()` 惰性读取：监听早于 Runner 建立，`/runtime/readiness`、`/sessions`、`/projects`、`/runtime`、应用生命周期（含桌面验收）在未就绪时照常应答，其余 Runner 依赖路由以 503 `runtime-not-ready` 失败关闭；`setRunner()` 同时构建 RunRouter 并初始化附件缓存。**请求入口不得等待 RunRouter 恢复**（2026-09-24）：路由只在 RunRouter 构建完成后按世代号原子发布（`activeRunRouter`），恢复期间元数据、Runtime、会话索引与工作区路由立即应答，Run/Checkpoint/审批返回 503；否则旧任务恢复会让这些轻量请求一起无响应。历史事件分区的兼容扫描同样移出就绪关键路径，见 `local-app-api/README.md` 的"恢复期间的路由隔离"与"旧事件异步补扫"。
- `local-app-api/`：HTTP/SSE 基元、公共契约与各领域路由；新增接口必须进入对应领域。启动恢复的发现/详情/续跑/放弃路由（`local-app-api/run-checkpoint-routes.ts`）与它投影给窗口的两个诊断计数（`run-checkpoint-view.ts`）同属这一层：计数必须互斥地描述"最近一次扫描"——`invalidFiles` 是读不出来的记录数，`warningCount` 只统计不属于这些记录的发现，详见 `local-app-api/README.md`。Runtime 的模型引用校验同样在这一层：`runtime-routes.ts` 的 `validateModelRef` 按解析后的模型 id 比较，因为供应商的 `models` 允许裸 id 与声明元数据两种形状（自定义供应商保存的是后者）。
- `local-app-api/workspace-git-*.ts`：工作区 Git 仓库定位、分层审阅、opaque revision、状态/Diff 有界缓存和子进程并发控制；详细契约由 `local-app-api/README.md` 维护。
- `desktop-shell.ts`（配合 `tray-controller.ts`、`close-policy.ts`、`desktop-window-state.ts`、`desktop-startup-page.ts`、`desktop-visual-acceptance.ts`）：BrowserWindow、托盘、三档关闭策略、窗口拖拽与退出前落盘 IPC；`desktop-acceptance-snapshot.ts` 为其提供只读验收快照。原生标题栏覆盖区、启动页与渲染器标题栏共用 `desktop-startup-page.ts` 导出的实色 `#101010` 契约（启用 acrylic 会在原生按钮区形成可见接缝，已移除）；`currentWindow()` 供就绪发布按次解析当前窗口。**隔离验收运行默认不把窗口显示出来**：`desktop-visual-acceptance.ts` 判定"这次是否扣住窗口"，`desktop-shell.ts` 把判定放在**唯一的上屏出口 `showWindow()`** 里——启动页、渲染器就绪、恢复几何和 `show()` 都经过它，只在 `show()`/`showStartup()` 上设卡会漏掉内部调用（实测窗口照样弹出、盖住用户）。需要像素的检查必须显式放行：验收动作先调 `allowAcceptanceWindow()` 再 `show()`（顺序有单测）。生产启动不受影响（只认验收环境变量）。
- `local-app-api/workspace-preview-server.ts`：运行工作区 HTML 页面的**有界 loopback 静态服务**（UX-26）。静态预览不执行脚本，所以"运行"必须经 HTTP：每个工作区根一个监听、URL 带随机 token、只答 `GET`/`HEAD`、`Host` 必须是 loopback、解码后的路径再经 `realpath` 校验（穿越与符号链接逃逸都拒）、无目录列表、无 CORS 头、单文件上限、有界服务数 + 空闲回收 + 显式 `stop`（API server 关闭时 `stopAll`）。它只服务项目根内的普通文件，不代理进程、不执行项目脚本、不安装依赖。
- `embedded-browser-hardening.ts`：guest webview 的**硬约束**（UX-26 第 3 条）。渲染器在 `<webview webpreferences>` 里写的偏好属于渲染器自己的攻击面，所以 Main 在 `will-attach-webview` 上重写：强制关掉 Node 集成三件套、打开 contextIsolation/sandbox/webSecurity、关掉 insecure content/experimental/webviewTag/plugins，把 `partition` 固定为内嵌浏览器分区，**删除 `preload`/`preloadURL`/`additionalArguments`**（preload 是把 LS bridge 交给网页的通道），`src` 不是 http(s) 的挂载直接拒绝；纠正过的字段会打一条警告便于发现渲染器漂移。纯函数 + 3 例单测，`embedded-browser.ts` 只做接线。
- `embedded-browser-diagnostics.ts`：运行中的工作区页面**不必打开 DevTools** 就能被诊断（UX-26）：有界（40 条、消息截断 300 字符、逐出最旧）记录每条脚本报错/资源失败/加载失败，按页面 URL 查询，`/browser/diagnostics?url=…` 只读投影给渲染器。两条来源缺一不可——`console-message` 只报页面自己抛的错（实测缺失样式表与图片**完全不产生** console 消息），子资源 4xx 与连接被拒来自 session 的 `webRequest.onCompleted/onErrorOccurred`，用 `referrer`（缺失时用最近访问的页面 URL）归到页面上。
- `desktop-visual-acceptance.ts`：CS-02 接缝检查所需的原生侧事实（标题栏高度、覆盖区颜色、启动页底色、窗口背景）、有界窗口缩放与最大化/还原（`setWindowMaximizedForAcceptance`），以及在实机窗口上渲染启动页与启动失败页；它是"验收快照里的声明值"，验收脚本据此与实测像素比对。只服务隔离验收运行，不接管窗口生命周期（窗口由 `index.ts` 在调用点解析后传入）。
- 启动页 / 启动失败页取证（`desktop-acceptance-actions.ts` 装配、`desktop-visual-acceptance.ts` 的 `showStartupPageForAcceptance` / `showStartupErrorPageForAcceptance` 渲染，经应用生命周期路由的 `startup-page` / `startup-error` 动作触达）：把生产同一份启动文档交回窗口、把真实失败文案交给与生产同一份 `showStartupError` 文档，供隔离验收捕获像素。这两页都无法靠等待到达（启动页只停留约 90 ms），因此这是唯一能对它们取证的入口；`desktop-acceptance-actions.ts` 在 `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` 之外整体返回 `undefined`，渲染函数自身也再判一次，生产路径不受影响。捕获证明的是页面外观，不证明启动页的停留时长——交接时序仍属人工验收项。
- 就绪窗口的验收拉长（`desktop-acceptance-actions.ts` 的 `acceptanceReadyDelayMs()` / `waitForAcceptanceReadyDelay()`，`index.ts` 在发布就绪前调用）：只推迟**发布**，Runner 照常构建，被拉长的只是渲染器看到的未就绪窗口，用以在真实窗口上验证"先可用界面"的交互契约（草稿、发送禁用、真实阶段文案）。仅 `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` 且 `LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS` 为正整数时生效，上限 60 s，生效时打出 `acceptance-ready-delay` 阶段标以免被误读成初始化变慢；正常启动为 0。
- 启动失败的两个阶段各有明确的可见状态（实机取证见基线文档的"失败态"一节）：渲染器尚未接管时由独立启动失败页承载错误，渲染器已在屏上时由 `RuntimeReadinessNotice` 原地陈述同一原因（该条状表面**只服务失败**；正常启动的阶段文字由渲染器就地显示在发送按钮旁，见 `renderer/runtime-readiness/README.md`），并保留可修复配置的设置入口。`desktop-shell.ts` 的 `hasLoadedRenderer()` 是这条分支的唯一判据，不要改回无条件切换文档。
- `runtime-config-change.ts`：判断保存后的配置是否让当前 Runner 失效——Runner 在构建时捕获一份不可变 `Config` 并从这份副本解析 run 的有效策略，所以只按"模型/网络是否变化"重建会让其余已保存设置（首当其冲是默认工作区）继续向下一轮描述旧世界。比较按字段而非白名单：除 `desktop`（窗口策略，读者每次从当前配置实时读取）和 `version`（文件格式）之外的任何键变化都重建；`updateRuntimeConfig` 先持久化、再按需重建，重建失败照常向上报错而不是静默沿用旧 Runner。`createRuntimeConfigUpdater` 把这条事务固定成**规范化 → 持久化 → 按需重建**的顺序，并且**持久化失败时拒绝 promise、不替换 Runner**（调用方拿到错误，不会显示"已保存"）；并发保存被串行化，不会各自对着半应用的状态做判断。**"已保存"和"已生效"是两个版本，不能混为一谈**：`current()` 只回答后者，而持久化会立刻把新版本写进它读的那个槽位（`persistRuntimeConfig` 设 `currentConfig`），所以比较必须在持久化**之前**做；一次重建失败会被记成"已落盘但未生效"，**再次保存同一个版本仍然重建 Runner**——否则用户重试保存 B 时比较的是 B 与已保存的 B，得到"无变化"并返回成功，而下一个 run 仍按 A 解析策略。它的测试夹具始终持有一份已载入的配置，所以 `current()` 在该用例里不返回 `null`（`null` 仍是 Main 尚未读取配置时的契约）。
- `execution-retry.ts`：执行阶段的有界重试（连续 3 次失败、成功即重置、并发请求被拒），由 preload 的 `retryExecution()` 经 `RUNTIME_RETRY_EXECUTION_CHANNEL` 触达；每次尝试**先重读 `config.json`** 再调 `startExecution`，因此"改好模型设置后不用重启"，失败时用 `readiness.fail(message, { retryable })` 决定窗口是否继续提供入口。`runtime-config-preparation.ts` 是它与启动路径共用的配置归一化，不要各自实现一份。
- `plugin-host-startup.ts`：可选插件宿主的一次性启动，由 `index.ts` 在执行就绪之后动态导入。插件包会带出全部内置渠道实现，静态导入会把它算进"首条业务日志之前的模块求值"；实测其动态导入 + 创建只占约 2.8 ms，因此它既不进静态图，也不阻塞 `readiness.ready()`（渠道晚几毫秒连接，核心 API 在宿主缺失时仍可用）。
- `run-activity-monitor.ts`、`run-policy.ts`：聚合当前与正在退场的 Runner 活动快照；解析权限模式和行为 profile，并在执行前重算容器边界与审批，启动期恢复读取只经 `createRecoveryReadAuthorizer`。
- `local-app-api/session-routes.ts` 的 `buildSessionContextUsageRecord` 按会话汇总每次 run 的 provider 用量，产出**会话累计缓存命中**（`cachedPromptTokens / promptTokens`，含冷启动、不含分离调用），与验收账本同源同公式；`requestsWithoutUsage > 0` 时标注为局部读数。同一个文件的 `PATCH /sessions/:id` 还拥有**项目会话的显式目录切换**：项目会话按项目（或它自己记录的目录）运行，保存默认工作区不会搬动它，因此换目录必须是针对该会话的显式操作。
- `local-app-api/run-support.ts` 的 `resolveOwnedRunWorkspace` 在解析目录前先解析会话归属：只有没有自身绑定的会话才吃请求里的 `workspace`（渲染器随每次请求下发的是 Runtime 当前工作区）。判定与取舍见该目录 README；回归在 `local-app-api/run-support.test.ts` 与 `run-stream-api.test.ts`。
- `session-index.ts`、`project-index.ts`、`archive-index.ts`、`workspace-layout-index.ts`、`workspace-artifact-index.ts`、`terminal-activity-index.ts`：UI 元数据索引。`workspace-layout-index.ts` 的恢复镜像同时保存会话现场的两个导航宽度（`fileNavigatorWidth` 与 `reviewNavigatorWidth`，UX-18），两者各按 `WORKSPACE_FILE_NAVIGATOR_WIDTH_*` 独立 clamp；旧镜像缺 `reviewNavigatorWidth` 时落回默认值，不继承文件导航的宽度。
- `attachment-cache.ts`、`data-root-*.ts`、`workspace-*.ts`：各自受管数据和资源生命周期。
- `development-environment-definitions.ts`、`development-environment-files.ts`、`development-environments.ts`：LS 工具链定义、版本检测、导入/移除事务、版本偏好和终端派生环境；设置页面通过 Local App API 访问，不直接触碰文件系统。
- `memory-files.ts`、`memory-tree-control.ts`、`memory-atom-control.ts`、`memory-v3-*.ts`、`memory-embedding-model-control.ts`：用户记忆文件投影、记忆树/资源/Atom 管理适配（只由 Local App API 的用户操作触达，不是 Agent 工具）、v3 迁移与本地向量模型生命周期；不建立第二份记忆索引。
- `keychain.ts`、`provider-calibration.ts`、`local-app-api-locator.ts`：API key 安全存储与进程环境注入、显式触发的有界真实 Provider 检查、带 token 的 loopback 定位文件读写。
- `workspace-office-preview.ts`：主进程内的路径适配器；`stat` 后委托 `@littlesheep/documents/office-preview` 做有界只读提取（ZIP/XML 限额归该包），Renderer 只接收结构化结果。
- `embedded-browser.ts`：持久化浏览器分区、媒体/存储权限、设置页数据清理，以及网页宿主策略——HTTP(S) 新窗口回收到当前 guest，仅 `mailto:`/`tel:` 交给系统，guest 导航限制在 HTTP(S)。
- `dataDir` 是 Agent 的逻辑容器根。Run 路由、终端路由和 Runner 必须在 Main 重新计算容器内/外/未知边界；Renderer 提供的 `approved` 不能替代 Main 判定。当前不宣称具备 Docker/OS 进程级隔离。
- 外部工作区可以响应用户主动的选择、预览和保存，但不会改变容器边界；研究/受限模式下，Agent 对外部工作区启动 run 时先跳过自动索引，后续访问由 Main 按权限矩阵审批。用户已经确认完全访问后，外部与 `unknown` 普通操作直接继续，仍保留真实边界记录、核心源码只读和危险命令硬拒绝。

主进程拥有 Electron 生命周期和用户数据 adapter，不拥有 Agent Workflow、记忆算法或 renderer 交互状态。

## 依赖与禁止事项

- 可以装配 workspace 公共入口；不得深层依赖 package 私有实现。
- Local App API 只监听 loopback，外部渠道必须走插件宿主。
- 禁止把密钥、用户正文或长工具输出写入日志；禁止在 renderer 中复制主进程存储。
- 完全访问是用户显式确认后的宿主资源访问权限：容器外、动态命令和未知范围不再逐次审批。Main 仍必须记录真实边界并执行核心源码只读、危险命令硬拒绝及参数校验。

## 测试与修改定位

- 测试与实现同目录，临时数据必须使用隔离目录。
- 新 API 先确定领域路由、共享协议、错误格式和恢复语义，再接入兼容 facade。
- 启动恢复的 HTTP/SSE 契约（发现、详情、续跑、放弃、观察者断开后仍继续恢复）定位在 `run-checkpoint-api.test.ts`；它用假 Runner 构造 `runCheckpoints`，因此 **store 诊断新增字段时必须同步这个夹具**（`warningFindings` 曾经漏加，列表路由因此 500）。真实窗口的五类恢复状态由 `pnpm run verify:recovery-states` 覆盖。

## 预览服务的资源失败记录（2026-09-26）

`local-app-api/workspace-preview-server.ts` 除服务文件外，还记录被拒绝的子资源请求（路径、状态、时间，各条目上限 30）与成功计数，供静态预览显示哪个资源没加载、为什么。这是 UX-25 第 2、4 条把相对资源交给 Main 校验后的观测面；边界（token、根内真实路径、无目录列举、无写方法）不变。

## 打开文件的磁盘状态（2026-09-26）

`local-app-api/workspace-file-service.ts` 增加 `statWorkspaceFile` 与 `GET /workspace/file-stat`：只回 exists/modifiedAt/size，供渲染器在编辑期间发现外部改写或删除（UX-25 第 3 条）。它不读文件内容，也不改变保存路径的 409 语义——那是最后一道防线，新查询是更早的提示。

## Git 审阅的有界一致性重读（2026-09-26）

`local-app-api/workspace-git-review.ts` 现在用 HEAD、index stat 与 status 指纹在装配前后比对，必要时重读一次；仍不稳定就把快照标成 `unstable`（共享契约 `workspace-review-contracts.ts` 的可选字段），由渲染器提示。这是 UX-27 第 2 条要求的"读取前后一致性校验 + 丢弃过期结果"，仍然复用既有缓存/取消/合并逻辑，没有新增调度层。

## Git 读取失败的分类（2026-09-26）

`local-app-api/workspace-git-failure.ts` 把审阅读取的失败按 Git 的 stderr 分类（不是仓库 / 属主不符 / 权限拒绝 / 仓库损坏 / 超时 / 取消 / 未找到 Git / 未分类），每类一句可执行原因，原始证据不超过首行 200 字符；分类作用于整次读取，取消仍然抛出。LS 不会自动写 `safe.directory`（UX-28 第 1 条）。

## 差异层的元数据（2026-09-26）

`local-app-api/workspace-git-diff.ts` 的 `readDiffLayer` 会把纯重命名 / 权限变化的 extended header 作为 `metadata` 返回（`parseDiffMetadata` 解析，键保持 Git 原文），"该层使用了普通 unified diff 之外的格式"只在既无 hunk 又无元数据时出现（UX-28 第 3 条）。

## 审阅上限的呈现（2026-09-26）

`review-tree.tsx` 的 `reviewSummaryLabel` 把被截断的列表写成"显示前 N 个，共 M 个文件"；`workspace-git-review-limits.test.ts` 用 2,100 个文件与 6,000 行改动钉住列表/每层上限与"合计不完整"的标记（UX-28 第 5 条）。