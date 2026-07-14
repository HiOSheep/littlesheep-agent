# Local App API

本目录承载 Electron Main 与 Renderer 之间的 loopback HTTP/SSE 桥。它是本地应用内部接口，不是外部渠道网关；外部渠道由插件宿主提供。

## 结构

| 模块 | 职责 |
| --- | --- |
| `contracts.ts` | Server 构造参数和生命周期公共契约。 |
| `http.ts` | JSON、SSE、请求体上限和 HTTP 错误基元。 |
| `run-routes.ts` / `run-support.ts` | Agent run、流式事件、审批、中断、会话归属和产物。 |
| `project-routes.ts` | 项目注册、重绑定、归档转换和目录创建。 |
| `session-routes.ts` | 会话、归档和执行日志重放。 |
| `runtime-routes.ts` | Runtime、Provider key、数据根和应用重启。 |
| `memory-routes.ts` | Skills、记忆树、记忆策略和项目记忆投影。 |
| `workspace-routes.ts` | 附件导入、文件、布局和产物路由。 |
| `workspace-file-service.ts` | 安全目录列表、预览和文本保存。 |
| `workspace-support.ts` | 工作区边界、scope 和资源索引同步。 |
| `terminal-*.ts` | PTY/进程、终端会话、命令捕获、一次性命令和终端路由。 |
| `extension-routes.ts` | 插件与外部渠道控制面。 |
| `vscode-launcher.ts` | VS Code 命令发现与启动。 |

## 路由领域

- Run：`/run`、`/run/stream`、`/approvals/:id`。
- 会话：`/sessions`、`/projects`、`/archive`、`/runs/:id`。
- Runtime：`/state`、`/runtime`、`/config/*`、`/data-root/*`、`/application/restart`。
- 工作区：`/workspace/*`、`/attachments/*`、`/workspace/terminal/*`。
- 记忆：`/skills/*`、`/memory/*`。
- 扩展：`/plugins/*`、`/channels/*`。

静态路由、动态前缀和 ID 编解码只以 `../../shared/local-app-api-routes.ts` 为准。

## 维护规则

- `../local-app-api-server.ts` 只负责组合和生命周期，不新增领域实现。
- 路由返回 `true` 表示已处理；未匹配必须返回 `false`，由总入口统一生成 404。
- 长生命周期资源必须归属一个 router/server 实例，并在 `stop()` 中释放 controller、timer、listener 和子进程。
- 不复制 shared contracts，不改变既有 URL、SSE 事件名、状态码或持久化语义。
- 修改后运行 App typecheck、对应 API 特征测试、全量测试、构建和恢复检查。
