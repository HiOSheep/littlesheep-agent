# Electron Preload

Preload 只通过安全的 context bridge 暴露 renderer 启动所需的最小运行时信息。

## 边界

- 入口是 `index.ts`。
- 不直接暴露 Node.js、文件系统、shell、密钥或任意 IPC。
- 业务请求统一走 Local App API；新增桥接字段必须是只读、可序列化且有明确消费者。

## 验证

- 修改后运行 App typecheck 和 build，并检查 renderer 在 `contextIsolation` 下正常启动。
- 禁止把 preload 作为绕过权限或 Local App API 契约的捷径。
