# 跨平台沙箱运行时 — P3-0 契约

本文只定义能力证据契约，不实现操作系统沙箱、工具自动审批、权限持久化、Runner 协调器或回退执行器。

## 边界所有权

- **Main / 可信宿主**拥有活动 run 身份、规范化工作区路径、权限快照和后端能力探测。Renderer、模型、工具输入和插件不能证明能力，也不能替换受作用域约束的快照。
- **Permission V2**唯一负责作出 `allow / approval / deny / unavailable` 决策和显式用户升级。`assessSandboxReadiness` 不是授权决策。
- **ToolExecutionService**仍是唯一 Agent 工具生命周期。原生 `read/write/edit` 守卫在实际文件操作边界执行；`exec` 将来只能使用真正约束子进程及其后代的平台后端。
- **后端**负责操作系统隔离、进程生命周期、工作区挂载/访问和网络出口。不能只凭静态平台探测就把能力标成 `verified`。

## 能力矩阵

| 操作 | 有资格自动执行所需的已验证保证 |
| --- | --- |
| 原生文件读取 | `native-file-read-confinement` |
| 原生文件写入/编辑 | `native-file-write-confinement` |
| Shell（`exec`） | `process-filesystem-confinement`、`process-network-confinement`、`child-process-containment`、`process-tree-termination` |

`verified` 表示可信后端已针对当前平台、工作区、run 和运行配置，实际证明该操作需要的**全部**保证。`partial` 或 `unavailable` 都不够；未知证据按不可用处理。仅有 `status: 'verified'` 的数据对象不是安全令牌，也不能独自构成证明。

`SandboxCapabilitySnapshot.scope` 绑定 Main 规范化的工作区根和单次 run。工作区变化、进程重启后未重新探测，或恢复时授权发生变化，都需要新的可信评估。字符串相等检查有意保持精确；路径规范化和实际文件系统约束属于宿主边界，不属于共享类型包。

## 未来的平台后端

- **Windows**：实验验证受限身份/AppContainer、显式 ACL 授权、Job Object 进程树管理、PowerShell/Node/Git 兼容性、网络限制及 junction/reparse point 处理。Job Object 本身不是文件系统沙箱。[P3-A 实机报告](windows-shell-sandbox-poc.md)记录了当前实验发现的边界泄漏。
- **Linux**：在部署内核上实验验证命名空间沙箱（例如 Bubblewrap）、文件系统限制（可能使用 Landlock）、seccomp 和网络命名空间。检测非特权命名空间能力缺失；保证不完整时拒绝自动执行。
- **macOS**：实验验证受支持的 App Sandbox 和签名 helper、用户授权目录及子进程行为。不能把未文档化的沙箱 profile 当成生产保证。

平台可能只支持部分能力；底层保护不同时不能宣称保证一致。后端必须通过负向测试证明实际约束，而不只是证明普通命令能运行。

## 不可妥协的失败行为

1. 能力证据缺失或过期、后端启动失败、路径或 run 不匹配、网络隔离失败、子进程逃逸或进程清理不完整时，**不得沙箱自动执行**。
2. 不得静默退回未隔离的宿主 Shell。如果权限策略允许，可走单独且明确的审批路径申请提升/未隔离执行，并准确说明风险；批准不能悄悄升级原沙箱保证。
3. 运行授权不可变更规则与 checkpoint 恢复规则相互独立；产生恢复副作用前须重新检查当前会话授权。结算状态未知的副作用不得重放。
4. 只有 Main/宿主拥有的执行约束才能产生正向能力证据。TypeScript `readonly` 与纯评估函数都不是操作系统安全原语。

## P3-A 验收门槛

- 可证明受限的 Shell 及其后代无法读写授权根以外的资源，也无法进行未授权网络连接。
- 超时、中止、崩溃和沙箱初始化失败不会留下逃逸子进程，也不会触发无隔离重试。
- 进程启动和工具结果仍沿用现有 run、审批、审计及 durable 副作用路径。
- 每个平台都需在把能力接入 `verified` 之前完成真实负向测试。
