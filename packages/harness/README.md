# @littlesheep/harness

Harness 是 Agent run 的确定性控制流层，拥有活动 stage manifest、单一 execute 循环、Runtime evidence settlement 和 RECOVER。Runner 提供应用生命周期与持久化；Harness 不拥有 Electron、网络服务、文件策略或 UI。

状态机、权限与持久化契约由 LittleSheep 自有 Runtime 掌握；外部 orchestration 库只可作为设计参考或受控 adapter，不能代替这些边界。

## 执行契约

- 普通会话和任务进入同一 execute 主循环；另一条可路由路径仅用于 Runtime 能力／状态事实回复。
- 模型可直接回答或请求注册工具；Runtime 校验并执行请求、记录结果，再追加回同一循环。
- `ToolContext` 接收由宿主捕获的 Permission V2 快照，包含资源根、独立审批策略和约束可用性；权限判定不是 Harness 提示词或行为 profile 的一部分。
- TaskBook 步骤执行、DECIDE、验证模型、恢复模型和 CAPTURE 不属于当前执行路径；持久 TaskBook 仅作只读历史。
- EXECUTE 在发布回复前结算 invocation、result、副作用与回复来源的一致性；证据完整只表示运行事实可用，不代表用户目标已验收，新的结构性结算记录为 unverified。
- 证据缺口进入 RECOVER 的有界路径；已结算副作用不重复执行，未知副作用不自动重放。
- RECOVER 作出有界的确定性重试、停止或升级用户决定；已结算副作用不重复执行。
- 面向用户的最终自然语言必须来自真实 LLM 调用，并在发布前按 settlement 身份登记。
- `model-observability` 在正文校验前按逻辑请求身份与物理 attempt 持久化 `provider_usage_recorded`；每个回执只累加一次，之后的逻辑响应结算不再重复累加。Provider 已返回用量而正文无效时，用量仍保留。
- Hooks 可在受控策略下扩展生命周期，但不能取得状态机所有权或跳过权限、验证、证据与收尾；失败降级规则有界。

合法状态转移与旧检查点规范化由 `packages/types` 和 [Core Flow 状态契约](../../docs/reference/core-flow-state-contract.md)维护。

## 代码入口与验证

`stages/execute` 拥有请求循环、工具协作和回复发布前的证据结算；`stages/recover` 决定重试／停止／升级，并将历史 `verify` checkpoint 安全迁入现有恢复路径；`llm-call-contracts` 定义请求身份与输出契约；`durable-kernel.ts`、`checkpoint-resume.ts` 管理事件与续跑边界。历史 `verify` stage 名、事件与验证记录只用于旧数据读取，不属于活动 stage manifest。

测试与 stage 同目录；`current-path-contract.test.ts` 防止第二执行路径或退役路由回流。缓存质量报告只描述实际记录的当前运行；版本对比必须来自不同 checkout，不能用 durable 记录模式标签制造第二条 Harness 路径。局部改动用 Harness 定向测试；权限、持久化或重启变化还需相应 Runtime 与 Electron 验收。跨包使用公开导出，不深层导入私有实现。
