# Renderer API client

本目录提供 Renderer 使用的 Local App API 类型化 fetch／SSE client。它不保存用户数据、不访问文件系统、不拥有 UI 状态，也不决定授权。公开兼容入口是父级 `api.ts`；具体 client 按领域组织。

## 请求边界

- 路由名从 `src/shared/local-app-api-routes.ts` 导入，不在 Renderer 重复硬编码。跨进程类型由 shared contract 拥有。
- `common.ts` 负责基址解析、通用错误和 SSE 帧处理。所有实际 HTTP 请求使用 `localApiFetch()`；未就绪时有界等待，不请求端口 `0`。纯 URL 生成只用于已确认服务就绪后的调用点。
- client 只发送 Main 定义的请求并展示响应。工作区路径、文件内容、权限、数据归属和服务生命周期都由 Main 复核。
- Workspace preview client 只持有 loopback token URL 与生命周期请求；路径范围、静态资源读取和安全策略由 Main preview service 所有。
- SSE 断开仅说明 Renderer 不再观察流；Agent run 是否停止按 API 契约决定。

`run`、checkpoint、session、runtime、attachment、workspace、review、terminal、browser、memory 与 extensions client 按领域维护；父级 `api.ts` 作为既有调用方的兼容 barrel。

验证使用 App typecheck、对应 client／route／SSE 测试；跨 Main、Runner 或文件系统的行为使用 Local App API 或 Electron 专项验收。
