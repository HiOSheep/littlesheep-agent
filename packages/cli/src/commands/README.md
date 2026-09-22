# CLI Commands

这里保存 CLI 的管理型子命令 adapter。

最后更新：2026-09-22 12:43:39

## 边界

- `memory.ts`：`memory rollback`（从写入前快照恢复，恢复动作本身也会被快照）和 `memory experience decay`（经验置信度衰减与低置信清理）；两者在加载 provider 之前执行。
- 旧 `memory archive` 写入命令已经退役；CLI 只保留默认拒绝识别，避免被误当作聊天输入。
- `import-repo.ts`：把仓库知识蒸馏为受控经验的命令，组合 config + LLM + ExperienceStore；URL 源浅克隆到临时目录并在 `finally` 清理。
- 命令只负责参数、进度、退出码和调用领域服务，不复制领域算法。

## 测试与修改定位

- 每个命令的测试与实现同目录（`memory.test.ts`、`import-repo.test.ts`）。
- 新命令同时更新根帮助、参数解析、错误输出和数据安全说明。
