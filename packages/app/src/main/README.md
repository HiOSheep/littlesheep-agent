# Electron Main

主进程是桌面产品组合根：负责启动顺序、用户数据基础设施、Runner/PluginHost 装配、Local App API、窗口和退出。

最后更新：2026-08-02 12:37:00

## 入口与所有权

- `index.ts`：启动与关闭编排；不得继续吸收领域实现。
- `local-app-api-server.ts`：兼容 facade，只负责 loopback server、领域路由装配和关闭顺序。
- `local-app-api/`：HTTP/SSE 基元、公共契约与各领域路由；新增接口必须进入对应领域。
- `session-index.ts`、`project-index.ts`、`archive-index.ts`：UI 元数据索引。
- `attachment-cache.ts`、`data-root-*.ts`、`workspace-*.ts`：各自受管数据和资源生命周期。
- `development-environment-definitions.ts`、`development-environment-files.ts`、`development-environments.ts`：LS 工具链定义、版本检测、导入/移除事务、版本偏好和终端派生环境；设置页面通过 Local App API 访问，不直接触碰文件系统。
- `workspace-office-preview.ts`：在主进程执行有界的 Office/OpenDocument 只读文本提取；先检查文件大小，并限制 ZIP 条目和 XML 展开规模，Renderer 只接收结构化结果。
- `embedded-browser.ts`：持久化浏览器分区、媒体/存储权限、网页新窗口回收和设置页的数据清理操作。
- `index.ts` 的 webview 宿主策略：网页预览留在 LS 内部，HTTP(S) 新窗口请求回收到当前 guest，非网页协议才按明确策略交给系统处理。
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
