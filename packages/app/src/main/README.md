# Electron Main

最后更新：2026-09-23 14:21:56

主进程是桌面产品组合根：负责启动顺序、用户数据基础设施、Runner/PluginHost 装配、Local App API、窗口和退出。

## 入口与所有权

- `index.ts`：启动与关闭编排；不得继续吸收领域实现。启动分三段：①数据根迁移、用户布局、keychain、config、Memory v3（顺序不可改，是任何写入者的前置条件）；②UI 索引 + Local App API 监听 + 窗口提前加载渲染器（此时执行能力未就绪）；③Runner 与 RunRouter 构建完成后发布执行就绪。`runner` 引用只在第③段由 `startExecution()` 赋值。
- `bootstrap-timing.ts`：仅在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 时记录无用户正文的结构化启动阶段耗时；`processUptimeMs` 是唯一冷启动锚点（Electron 的 `process.getCreationTime()` 不是同一时间轴，禁止用它做差值）；正常启动不输出、不轮询。
- `runtime-readiness.ts`：执行就绪的唯一事实来源（`starting`/`ready`/`failed` + 阶段 + 原因 + 端口），经 `../shared/runtime-readiness-ipc.ts` 的通道推给窗口，并由 `/runtime/readiness` 暴露给渲染器；窗口每次发布时重新解析，关闭到后台替换窗口不会丢失通知。
- `local-app-api-server.ts`：兼容 facade，只负责 loopback server、领域路由装配、可变 Runner/PluginHost/Config 热替换，以及实例级资源（run/terminal router、附件缓存、向量模型与开发环境管理器）的启停顺序。Runner 通过 `getRunner()` 惰性读取：监听早于 Runner 建立，`/runtime/readiness`、`/sessions`、`/projects`、`/runtime`、应用生命周期（含桌面验收）在未就绪时照常应答，其余 Runner 依赖路由以 503 `runtime-not-ready` 失败关闭；`setRunner()` 同时构建 RunRouter 并初始化附件缓存。
- `local-app-api/`：HTTP/SSE 基元、公共契约与各领域路由；新增接口必须进入对应领域。
- `local-app-api/workspace-git-*.ts`：工作区 Git 仓库定位、分层审阅、opaque revision、状态/Diff 有界缓存和子进程并发控制；详细契约由 `local-app-api/README.md` 维护。
- `desktop-shell.ts`（配合 `tray-controller.ts`、`close-policy.ts`、`desktop-window-state.ts`、`desktop-startup-page.ts`、`desktop-visual-acceptance.ts`）：BrowserWindow、托盘、三档关闭策略、窗口拖拽与退出前落盘 IPC；`desktop-acceptance-snapshot.ts` 为其提供只读验收快照。原生标题栏覆盖区、启动页与渲染器标题栏共用 `desktop-startup-page.ts` 导出的实色 `#101010` 契约（启用 acrylic 会在原生按钮区形成可见接缝，已移除）；`currentWindow()` 供就绪发布按次解析当前窗口。
- `desktop-visual-acceptance.ts`：CS-02 接缝检查所需的原生侧事实（标题栏高度、覆盖区颜色、启动页底色、窗口背景）、一个有界窗口缩放，以及在实机窗口上渲染启动失败页；它是"验收快照里的声明值"，验收脚本据此与实测像素比对。只服务隔离验收运行，不接管窗口生命周期（窗口由 `index.ts` 在调用点解析后传入）。
- 启动失败页取证（`desktop-acceptance-actions.ts` 装配、`desktop-visual-acceptance.ts` 的 `showStartupErrorPageForAcceptance` 渲染，经应用生命周期路由的 `startup-error` 动作触达）：把真实失败文案交给与生产同一份 `showStartupError` 文档，供隔离验收捕获像素。启动失败页无法靠等待到达，因此这是唯一能对它取证的入口；`desktop-acceptance-actions.ts` 在 `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` 之外整体返回 `undefined`，渲染函数自身也再判一次，生产路径不受影响。
- `plugin-host-startup.ts`：可选插件宿主的一次性启动，由 `index.ts` 在执行就绪之后动态导入。插件包会带出全部内置渠道实现，静态导入会把它算进"首条业务日志之前的模块求值"；实测其动态导入 + 创建只占约 2.8 ms，因此它既不进静态图，也不阻塞 `readiness.ready()`（渠道晚几毫秒连接，核心 API 在宿主缺失时仍可用）。
- `run-activity-monitor.ts`、`run-policy.ts`：聚合当前与正在退场的 Runner 活动快照；解析权限模式和行为 profile，并在执行前重算容器边界与审批，启动期恢复读取只经 `createRecoveryReadAuthorizer`。
- `local-app-api/session-routes.ts` 的 `buildSessionContextUsageRecord` 按会话汇总每次 run 的 provider 用量，产出**会话累计缓存命中**（`cachedPromptTokens / promptTokens`，含冷启动、不含分离调用），与验收账本同源同公式；`requestsWithoutUsage > 0` 时标注为局部读数。
- `session-index.ts`、`project-index.ts`、`archive-index.ts`、`workspace-layout-index.ts`、`workspace-artifact-index.ts`、`terminal-activity-index.ts`：UI 元数据索引。
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
