# Local App API

本目录承载 Electron Main 与 Renderer 之间的 loopback HTTP/SSE 桥。它是本地应用内部接口，不是外部渠道网关；外部渠道由插件宿主提供。

最后更新：2026-08-04 01:01:23

## 结构

| 模块 | 职责 |
| --- | --- |
| `contracts.ts` | Server 构造参数和生命周期公共契约。 |
| `http.ts` | JSON、SSE、请求体上限和 HTTP 错误基元；`openSse()` 统一发送响应头与 15 秒注释心跳，单连接待写数据达到 512 KiB 前主动断开慢观察者，并幂等释放 timer/listener。 |
| `run-routes.ts` / `run-support.ts` | Agent run、流式事件、审批、中断、会话归属和产物。 |
| `application-lifecycle-routes.ts` | 活动任务快照、`active_runs` SSE、暂停/继续/中断控制；监听器生命周期归 Main 的 `RunActivityMonitor`。 |
| `project-routes.ts` | 项目注册、重绑定、归档转换和目录创建。 |
| `session-routes.ts` | 会话列表、独立/项目会话重命名、归档、删除和执行日志重放；重命名同时更新会话 metadata 与 UI 索引，索引失败时回滚 metadata。 |
| `runtime-routes.ts` | Runtime、Provider key、数据根和应用重启。 |
| `memory-routes.ts` | Skills、记忆树、记忆策略和项目记忆投影。 |
| `memory-migration-routes.ts` | Memory v3 迁移、回滚和固定本地向量模型准备。 |
| `workspace-routes.ts` | 附件导入、文件、布局和产物路由。 |
| `workspace-file-service.ts` | 安全目录列表、预览和文本保存。 |
| `workspace-support.ts` | 工作区边界、scope 和资源索引同步。 |
| `terminal-*.ts` | PTY/进程、终端会话、命令捕获、一次性命令和终端路由。 |
| `extension-routes.ts` | 插件与外部渠道控制面。 |
| `vscode-launcher.ts` | VS Code 命令发现与启动。 |

## 路由领域

- Run：`/run`、`/run/stream`、`/approvals/:id`。
- 会话：`/sessions`、`/projects`、`/archive`、`/runs/:id`。
- Runtime：`/state`、`/runtime`、`/config/*`、`/data-root/*`、`/application/restart`、`/application/active-runs`、`/application/active-runs/stream`、`/application/active-runs/:id/control`。
- 工作区：`/workspace/*`、`/attachments/*`、`/workspace/terminal/*`。
- 记忆：`/skills/*`、`/memory/*`。
- 扩展：`/plugins/*`、`/channels/*`。

静态路由、动态前缀和 ID 编解码只以 `../../shared/local-app-api-routes.ts` 为准。

## 维护规则

- `../local-app-api-server.ts` 只负责组合和生命周期，不新增领域实现。
- 路由返回 `true` 表示已处理；未匹配必须返回 `false`，由总入口统一生成 404。
- 长生命周期资源必须归属一个 router/server 实例，并在 `stop()` 中释放 controller、timer、listener 和子进程。
- SSE 路由统一调用 `openSse()`，不能复制响应头、心跳或缓冲策略；必须同时处理请求中止、响应关闭和订阅建立期间的竞态，任何退出路径只能释放一次 timer、listener 和订阅。
- 普通 Agent run、Checkpoint 续跑和活动任务订阅的 SSE 只是观察连接；观察者断开不会取消 Main 持有的任务。显式中断必须走活动任务控制入口。终端主动命令保持独立语义，观察连接断开时仍取消对应命令。
- `writeSse()` 在响应已关闭时安全返回；Node 的普通背压不会立即断流，只有累计待写数据越过 512 KiB 上限才关闭该观察连接。不得通过无界排队补偿慢客户端。
- 不复制 shared contracts，不改变既有 URL、SSE 事件名、状态码或持久化语义。
- 修改后运行 App typecheck、对应 API 特征测试、全量测试、构建和恢复检查。
