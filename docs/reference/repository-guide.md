# LittleSheep 仓库指南

本页帮助从需求定位源码、owner 和验证入口；当前实现状态见[项目状态](../decision/project-status.md)，跨模块长期约束见[架构原则](../principles/architecture-principles.md)。

## 快速定位

| 需求 | 位置 |
| --- | --- |
| 桌面窗口、Local App API、启动与 Main 资源 | `packages/app/src/main` |
| Renderer、preload 与跨进程协议 | `packages/app/src/renderer`、`src/preload`、`src/shared` |
| Run 生命周期、checkpoint 与持久化 | `packages/runner` |
| 单一主循环、VERIFY、RECOVER | `packages/harness`；状态转移契约在 `packages/types` |
| Context、Prompt、Session 与缓存边界 | `packages/context`、`packages/prompt`、`packages/session` |
| 受控工具、路径授权与快照 | `packages/tools`、`packages/safety`、`packages/snapshot` |
| Memory、Provider、插件与外部渠道 | `packages/memory-tree`、`packages/llm`、`packages/plugins`、`packages/channels` |
| CLI、公开 Web 读取与文档处理 | `packages/cli`、`packages/web`、`packages/documents` |
| 检查、构建与验收入口 | 根 `package.json`、`scripts/README.md` |

Workspace manifest 与 `package.json` 表达包边界；公开导出从 package README 查找。`docs/reference/module-split-map.md` 是生产文件拆分门的登记输入，不证明行为正确。

## 开发约定

- 先检查工作树并保留与当前任务无关的改动。
- 不提交密钥、用户数据、运行日志、生成物或工作区产物。
- 跨 package 使用公开入口；新增持久格式或公共契约时检查生产者、消费者、旧数据读取与失败恢复。涉及不可信文本的公共投影必须**显式枚举允许值**：把允许的代码值写进类型（有限字面量联合），投影处只放行枚举内的值，枚举外的任何输入都不投影（fail closed）；用长度／控制字符净化或已知标记黑名单都**不能代替**枚举，也不得原样透传自由文本。快照／版本标识须覆盖所有影响其语义的字段，并由契约测试验证。
- Runtime／Main 拥有安全、授权和数据所有权。Prompt、Renderer 声明或用户选择的路径不自行授予权限。
- package README 保持简短，说明职责、公开入口、依赖／所有权边界和正式验证方式；只在这些事实实质变化时更新。私有 helper、测试、样式和时间流逝不要求改 README，src 子目录不因目录存在而自动配文档。
- 验收报告区分通过、失败、跳过、未运行和 unverified；证据不完整时不扩大结论。

## 验证选择

- **L1 局部低风险**：定向测试／typecheck，或 `pnpm run verify:task -- --files=<path>`。
- **L2 公共契约或跨模块**：覆盖直接生产者、消费者和受影响 package；范围不清楚时使用 `verify:core`。
- **L3 安全、权限、迁移、durable 数据或副作用**：核心回归加故障注入、迁移、权限或恢复专项。
- **L4 发布、安装包、构建链或全仓共享配置**：`verify:full` 加对应 Electron、打包或供应链专项。

`verify:changed`、`verify:core`、`verify:full` 是本地编排入口，不自动包含所有 Electron、Provider 或发布专项。实际范围以命令摘要为准；旧构建、selector 不确定和 `skipped` 都不能当成通过。

权限／容器的当前安全事实由 Main、Safety 与 [架构原则](../principles/architecture-principles.md)维护；公开 Web 抓取边界见[网络检索安全契约](web-retrieval-security-contract.md)；细分实现与检查路径见 package owner README 和相邻测试。
