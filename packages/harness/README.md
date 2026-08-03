# @littlesheep/harness

实现 LittleSheep 的硬控制流状态机，按 stage 驱动活动路由、决策、执行、验证、恢复、记忆和收尾。

最后更新：2026-08-03 17:35:20

## 职责与边界

- 公开入口是 `src/index.ts`；装配入口为 `default-harness.ts`，阶段实现在 `src/stages/`。
- Harness 决定状态转移和 TaskBook 语义，通过端口使用 LLM、工具、Context、记忆与会话。轻量单步骤 TaskBook 也必须保留 `execution` 安全契约；每个依赖 wave 完成后先同步并持久化步骤结果，再消费暂停或中断，停止时不提前生成最终回答。
- `stages/evolve.ts` 只负责 EVOLVE 调用与普通记忆/Skill 提案；`stages/evolve/reconciliation.ts` 负责重复 Atom 方案，`stages/evolve/hierarchy.ts` 负责显式关系驱动的叶子 reparent，`stages/evolve/subtree.ts` 负责有界非叶子 subtree move。三条结构调和路径都把模型限制到本轮 adopted KnownState、精确 revision 和有界 Runtime 端口；Harness 记录提案与 Runtime 决定，但不直接修改 Atom 存储。
- `response-continuity*.ts` 在 FINALIZE 中依据 LS 实际发布的最终回答判断记忆是否连续，并从 `ReplyProvenance` 回查真正进入因果模型请求的近期历史、版本化摘要和 active/adopted Atom。保存、检索或注入成功都不是充分条件；明确追问的历史值必须在最终回答中逐项正确出现，漏答、答错、否认记得或来源未进入请求都不能判为 `supported`。当前字段门支持 `executionCount / 执行次数`、`ticks`、`completed`、短数字、布尔值、Markdown 粗体、反引号和表格，但标签和值必须精确对应，无关位置出现相同数字不能补足错误字段。`session-summary-fidelity-text.ts` 只解析 Runtime 拥有的摘要精确字段封套，不负责会话压缩或存储。
- 显式工具提议仍由 Runtime 逐项校验。普通直接路径只接受可证明且无需审批的 `read/write`；完全访问模式可额外接受来源明确为内置、参数完整、非 Checkpoint 恢复态的单次 `exec`。缺少副作用声明时 Runtime 保守推导为 `external`，显式冲突声明仍拒绝。
- 对话区的回复、澄清、任务/步骤说明、验证说明和交付表达必须由真实 LLM 调用结合运行时 `SOUL.md` 构思并由 Harness 保留；Runtime 只提供事实、状态、权限、路径、进度和证据，Renderer 不自行生成 Agent 人格文案。Harness 在发布前通过 Session 的持久化注册表原子占用规范化回复指纹，覆盖同一会话完整历史、重启和并发 run；冲突候选只交给 LLM 改写。改写耗尽、注册表不可用或模型不可用时只返回 Runtime 错误状态，不发送固定人格模板。
- 禁止依赖 Electron、CLI、具体渠道或 App 私有实现，也不直接拥有文件系统生命周期。

## 依赖与数据

- 依赖领域公开契约；Runner 是它的主要上层应用服务。
- run 状态和执行证据由调用方持久化，Harness 不另造用户数据副本。

## 测试与修改定位

- 总体回归在 `src/default-harness.test.ts`、`src/e2e.test.ts`，回答级连续性与摘要字段解析分别位于 `src/response-continuity.test.ts`、`src/session-summary-fidelity-text.test.ts`，各阶段测试与实现同目录。
- 修改状态转移先更新 stage 契约和特征测试，再调整实现。
