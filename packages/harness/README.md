# @littlesheep/harness

实现 LittleSheep 的硬控制流状态机，按 stage 驱动分类、决策、执行、验证、恢复、记忆和收尾。

## 职责与边界

- 公开入口是 `src/index.ts`；装配入口为 `default-harness.ts`，阶段实现在 `src/stages/`。
- Harness 决定状态转移和 TaskBook 语义，通过端口使用 LLM、工具、Context、记忆与会话。
- 禁止依赖 Electron、CLI、具体渠道或 App 私有实现，也不直接拥有文件系统生命周期。

## 依赖与数据

- 依赖领域公开契约；Runner 是它的主要上层应用服务。
- run 状态和执行证据由调用方持久化，Harness 不另造用户数据副本。

## 测试与修改定位

- 总体回归在 `src/default-harness.test.ts`、`src/e2e.test.ts`，各阶段测试与实现同目录。
- 修改状态转移先更新 stage 契约和特征测试，再调整实现。
