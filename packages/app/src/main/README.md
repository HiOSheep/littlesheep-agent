# Electron Main

Main 是应用数据、窗口、Local App API、Runner 生命周期、文件系统与进程能力的权威方。Renderer 请求一律作为不可信输入；Main 在执行前校验路径、会话归属、权限和副作用范围。

## 生命周期与就绪

- 创建可写服务前先解析并准备活动数据根。数据根可迁移；`workplace` 只是其中的默认工作区。用户选择的数据根外路径仍属于外部资源。
- Runner 恢复完成前，Local App API 可提供元数据和安全的会话／工作区读取；run、checkpoint 和审批等依赖 Runner 的路由必须明确返回未就绪状态，不能暴露半初始化的路由器。
- Renderer 接管前的启动失败使用独立失败页；接管后的就绪错误由应用壳层显示。Runner 恢复与界面就绪是不同状态。
- 正常启动页以内嵌小尺寸透明 WebP 显示品牌待机呼吸，不依赖 Renderer、网络或播放器库，也不等待动效结束才接管。减少动态效果、缺失动效与启动错误优先使用透明球体 PNG，透明素材缺失时保留兼容图标回退；资源解析兼容仓库与打包后的路径。

## 安全与模块归属

- Main 在 Agent 操作实际执行时重新分类路径；Renderer 的批准状态本身不授予权限。
- Agent 工具与 Agent Shell 命令使用相同路径和权限策略；用户直接操作的交互终端走另一条路由。
- 核心源码对 LS Runtime 工具保持宿主级只读；危险命令和硬拒绝优先于普通授权。
- 凭据留在宿主密钥存储；日志与 API projection 有界且脱敏。插件与 guest 页面不得取得不受限的文件或进程句柄。
- `index.ts` 与 `desktop-shell.ts` 组合进程和窗口；Local App API 在 `local-app-api-server.ts` 与 `local-app-api/`；路径和 run policy 由 `run-policy.ts` 与 safety package 所有。
- 原生标题栏与启动页初始色跟随系统；Renderer 首帧应用持久主题后，通过窄布尔 `window-appearance-contracts.ts` 同步标题栏符号色及不透明底色。Main 仅接受本窗口的布尔主题事实；启动失败页仍跟随系统主题。

## 验证

局部改动运行 App typecheck 与 Main 定向测试。路径授权、启动恢复、文件修改、原生窗口行为和发布产物分别使用 [脚本索引](../../../../scripts/README.md) 中相应验证；Electron 检查前运行 `pnpm run ensure:app-build`。
