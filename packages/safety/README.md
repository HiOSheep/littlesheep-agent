# @littlesheep/safety

提供输入校验、提示/记忆清洗、隔离区、安全存储包装和权限/路径判定基元。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 根公开入口是 `src/index.ts`；校验在 `validate.ts`，注入模式在 `patterns.ts`，清洗在 `sanitize-prelude.ts`，隔离在 `quarantine.ts`，安全存储包装在 `safe-memory-store.ts`。
- `permission-boundary.ts` 拥有逻辑容器边界、路径/符号链接规范化、Shell 范围保守判定、safe read 分类、敏感 query 识别和三档权限决策（`describeToolAccess`、`resolvePermissionDecision`、`authorizeToolAccess`）；产品层仍负责审批 UI 和生命周期，不得绕过这些判定。
- Node 专用的 `@littlesheep/safety/verified-asset` 子路径提供有界哈希、下载完整性校验、临时文件恢复和原子发布机械层；模型注册、URL、重试策略、manifest 与生命周期仍由调用领域拥有。
- 当前边界是 Main 进程中的 fail-closed 逻辑约束，不等同于真实 Docker/OS 沙箱；`unknown` 始终保留保守分类。研究/受限模式必须升级到用户审批（公共 Web safe read 与本地记忆导航免逐次批准，但仍受网络总开关与硬拒绝约束），已经显式确认的完全访问按策略直接放行；核心源码只读和危险命令硬拒绝不受权限模式影响。
- 禁止吞掉风险或把隔离内容重新注入 Context。

## 依赖与数据

- 只依赖公共契约，供 Memory、Experience、Tools 等领域调用。
- 隔离数据和安全审计属于用户数据；包不拥有业务实体。

## 测试与修改定位

- 每个主要模块（validate、sanitize-prelude、quarantine、safe-memory-store、verified-asset、permission-boundary）均有同目录测试。
- 新规则必须覆盖误报、漏报、截断和 Unicode/路径边界。
