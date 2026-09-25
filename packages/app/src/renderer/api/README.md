# Renderer API 客户端

最后更新：2026-09-26 03:30:19

本目录承载 Electron Renderer 对 Local App API 的类型化 fetch/SSE 客户端。根级 `../api.ts` 是面向既有调用方的兼容入口，本目录按领域保存实现。

## 领域边界

| 文件 | 职责 |
| --- | --- |
| `workspace-files.ts` / `terminal.ts` | 工作区选择、目录读取、文件预览、布局、产物与终端活动的客户端。请求路径必须由 `LOCAL_APP_API_ROUTES` 插值构造；`workspace-client-paths.test.ts` 断言实际发出的路径以文档化路由开头且不含常量字面量（2026-09-24 曾因模板字符串缺少 `${` 使右侧目录与预览全部失效，只在真实渲染器里可见）。 |
| `common.ts` | Local App API 基址、通用错误、SSE frame 解析和 `window.littlesheep` 桥接类型声明（含就绪查询/订阅与失败后的 `retryExecution()`）。基址按需向 preload 求解（`localApiBase()`）；`localApiFetch()` 在就绪前等待端口，绝不请求端口 0，`localApiUrl`/`localApiUrlSync` 只服务已确认就绪的纯 URL 调用点。**SSE 帧解析对无法解析的 `data:` 行返回 `null` 跳过该帧，不再抛出**：抛出一个畸形帧会中断整条流的读取，连带丢掉其后的增量与 `result`（UX-20 分层定位结论）；"始终没有可解析结果"的失败关闭由 `run.ts` 的 `consumeRunStream` 承担，坏帧不得被当成静默成功。 |
| `workspace-preview-server.ts` | 运行工作区 HTML 页面的有界 loopback 服务客户端（UX-26）：`startWorkspacePreviewServer(root, path)` 返回带随机 token 的 loopback URL，`stopWorkspacePreviewServer(root)` 释放它。根范围、真实路径校验与生命周期都由 Main 拥有，这里只发请求。 |
| `run.ts` | Agent run、流式事件和权限批准。 |
| `run-checkpoints.ts` | RunCheckpoint 列表、详情、续跑流和放弃。 |
| `browser.ts` | 内置浏览器分区状态与清理，以及 `getBrowserDiagnostics(url)`（UX-26：运行页面的脚本报错/资源失败，供"运行"旁的诊断读数使用）。 |`n| `application-lifecycle.ts` | 活动任务快照、`active_runs` SSE 订阅和暂停/继续/中断控制；目前由设置页直接导入。 |
| `sessions.ts` | 会话、项目、归档和历史消息分页；`updateSessionWorkspace` 是项目会话显式换目录的调用入口（独立会话跟随默认目录，不走这里）。 |
| `runtime.ts` | Provider、Runtime、API key、Web Provider 检查、数据根和应用重启。 |
| `attachments.ts` | 附件选择、浏览器文件导入和本地路径解析。 |
| `workspace-files.ts` | 工作区选择、目录、预览、保存、布局、产物和外部打开。 |
| `workspace-review.ts` | Git 审阅 snapshot/revision 查询与按 revision 绑定的 Diff 请求；支持 `AbortSignal` 与 `force` 刷新。Renderer 只负责 fetch，不直接访问文件系统。 |
| `terminal.ts` | 一次性命令、终端活动和交互式终端会话。 |
| `browser.ts` | 内置浏览器存储状态与清理。 |
| `development-environments.ts` | 开发环境状态、版本偏好、导入和移除。 |
| `extensions.ts` | 插件和外部渠道控制面。 |
| `memory.ts` | 记忆树查询、资源管理和项目记忆投影。 |
| `workspace.ts` | 工作区与终端的兼容 barrel。 |

## 就绪与基址

窗口早于 Local App API 出现，因此本目录不再假设"import 时端口已存在"：

- `localApiBase()` 向 preload 求解基址并有界等待（90 秒）；`localApiFetch()` 是唯一对外请求入口，未就绪时等待而不是请求端口 `0`。
- `localApiUrl` / `localApiUrlSync` 只服务已确认就绪的纯 URL 调用点，不得用于新请求。
- 未就绪或失败以真实错误抛出，由既有的 `runtimeError` 回灌路径呈现；`run.ts` 恢复草稿的既有语义不变，不伪造成功。

## 依赖与数据边界

- 路由只从 `../../shared/local-app-api-routes.ts` 读取，禁止在客户端重复硬编码 URL。
- 跨进程类型只从 `../../shared/*-contracts.ts` 或其明确所有者导入，禁止在 Renderer 复制协议。
- 本目录不保存用户数据，不直接访问文件系统，也不承担 UI 状态。
- 新领域应新增独立客户端并由 `../api.ts` 导出；根 barrel 当前导出 run、run-checkpoints、sessions、runtime、attachments、workspace、extensions、browser、development-environments 和 memory，`application-lifecycle.ts` 尚未进入 barrel。不要把实现重新写回兼容 barrel。

## 验证

- 修改客户端后至少运行 `pnpm.cmd --filter @littlesheep/app run typecheck`。
- 修改路由或 SSE 契约时同时运行对应 Local App API 特征测试和全量质量检查。

## 预览服务客户端（2026-09-26）

`workspace-preview-server.ts` 增加 `listWorkspacePreviewServers()`（GET），返回值除服务身份外还带 `assetFailures`（路径/状态/时间）与 `assetSuccesses`；静态预览用它把哪些相对资源没加载显示给用户并可重试（UX-25 第 2、4 条）。

## 文件状态与保存错误（2026-09-26）

`workspace-files.ts` 增加 `statWorkspaceFile(root, path)`（元数据轮询，UX-25 第 3 条）；同时 `saveWorkspaceFile` 的失败改为 `localApiResponseError`，保留 HTTP 状态码与服务端原句——预览面板因此能对 403/409/413/415 显示可执行的原因，而不是一律"稍后重试"。