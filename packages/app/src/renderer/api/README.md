# Renderer API 客户端

最后更新：2026-09-22 12:57:18

本目录承载 Electron Renderer 对 Local App API 的类型化 fetch/SSE 客户端。根级 `../api.ts` 是面向既有调用方的兼容入口，本目录按领域保存实现。

## 领域边界

| 文件 | 职责 |
| --- | --- |
| `common.ts` | Local App API 基址、通用错误、SSE frame 解析和 `window.littlesheep` 桥接类型声明。 |
| `run.ts` | Agent run、流式事件和权限批准。 |
| `run-checkpoints.ts` | RunCheckpoint 列表、详情、续跑流和放弃。 |
| `application-lifecycle.ts` | 活动任务快照、`active_runs` SSE 订阅和暂停/继续/中断控制；目前由设置页直接导入。 |
| `sessions.ts` | 会话、项目、归档和历史消息分页。 |
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

## 依赖与数据边界

- 路由只从 `../../shared/local-app-api-routes.ts` 读取，禁止在客户端重复硬编码 URL。
- 跨进程类型只从 `../../shared/*-contracts.ts` 或其明确所有者导入，禁止在 Renderer 复制协议。
- 本目录不保存用户数据，不直接访问文件系统，也不承担 UI 状态。
- 新领域应新增独立客户端并由 `../api.ts` 导出；根 barrel 当前导出 run、run-checkpoints、sessions、runtime、attachments、workspace、extensions、browser、development-environments 和 memory，`application-lifecycle.ts` 尚未进入 barrel。不要把实现重新写回兼容 barrel。

## 验证

- 修改客户端后至少运行 `pnpm.cmd --filter @littlesheep/app run typecheck`。
- 修改路由或 SSE 契约时同时运行对应 Local App API 特征测试和全量质量检查。
