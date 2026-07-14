# Electron Main

主进程是桌面产品组合根：负责启动顺序、用户数据基础设施、Runner/PluginHost 装配、Local App API、窗口和退出。

## 入口与所有权

- `index.ts`：启动与关闭编排；不得继续吸收领域实现。
- `local-app-api-server.ts`：现有兼容 facade，后续路由按领域拆分。
- `session-index.ts`、`project-index.ts`、`archive-index.ts`：UI 元数据索引。
- `attachment-cache.ts`、`data-root-*.ts`、`workspace-*.ts`：各自受管数据和资源生命周期。

主进程拥有 Electron 生命周期和用户数据 adapter，不拥有 Agent Workflow、记忆算法或 renderer 交互状态。

## 依赖与禁止事项

- 可以装配 workspace 公共入口；不得深层依赖 package 私有实现。
- Local App API 只监听 loopback，外部渠道必须走插件宿主。
- 禁止把密钥、用户正文或长工具输出写入日志；禁止在 renderer 中复制主进程存储。

## 测试与修改定位

- 测试与实现同目录，临时数据必须使用隔离目录。
- 新 API 先确定领域路由、共享协议、错误格式和恢复语义，再接入兼容 facade。
