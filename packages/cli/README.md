# @littlesheep/cli

提供 LittleSheep 的命令行入口、参数解析、REPL 和管理命令。

## 职责与边界

- 公开入口是 `src/index.ts`，可执行入口是 `src/bin.ts`；命令位于 `src/commands/`。
- CLI 是 Runner 和记忆服务的 adapter，不复制 Agent Workflow 或存储实现。
- 禁止在命令层绕过配置校验、权限、安全写入和数据备份。

## 依赖与数据

- 可以组合公开 workspace 包，但不得深层 import 私有文件。
- CLI 不拥有会话和记忆数据，只通过领域服务访问用户数据。

## 测试与修改定位

- 参数和入口测试在 `src/args.test.ts`、`src/cli.test.ts`；命令测试与命令同目录。
- 新命令必须在帮助文本、参数解析、退出码和错误输出上保持一致。
