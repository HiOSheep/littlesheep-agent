# @littlesheep/cli

提供 LittleSheep 的命令行入口、参数解析、REPL 和管理命令。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 公开入口是 `src/index.ts`（`runCli`），可执行入口是 `src/bin.ts`；参数解析在 `src/args.ts`，REPL 在 `src/repl.ts`，命令位于 `src/commands/`。
- CLI 是 Runner 和记忆/经验服务的 adapter，不复制 Agent Workflow 或存储实现；单次运行在 next 持久化模式下发布 settlement 后的权威回复（其余模式用 runner 返回的 reply），并附加 Runtime 签发的 Web 来源。
- 子命令在加载 provider 之前完成前置判断：`memory rollback` 与 `memory experience decay` 只需 branding，`memory archive` 已退役并显式拒绝，未知 flag 直接失败。
- 禁止在命令层绕过配置校验、权限、安全写入和数据备份。

## 依赖与数据

- 可以组合公开 workspace 包，但不得深层 import 私有文件。
- CLI 不拥有会话和记忆数据，只通过领域服务访问用户数据。

## 测试与修改定位

- 参数和入口测试在 `src/args.test.ts`、`src/cli.test.ts`；命令测试与命令同目录。
- 新命令必须在帮助文本（`USAGE`）、参数解析、退出码和错误输出上保持一致。
