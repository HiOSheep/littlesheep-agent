# @littlesheep/harness

Harness 是 Agent run 的确定性控制流层，拥有活动 stage manifest、单一 execute 循环、证据式 VERIFY 和 Runtime 管理的 RECOVER。Runner 提供应用生命周期与持久化；Harness 不拥有 Electron、网络服务、文件策略或 UI。

状态机、权限与持久化契约由 LittleSheep 自有 Runtime 掌握；外部 orchestration 库只可作为设计参考或受控 adapter，不能代替这些边界。

## 执行契约

- 普通会话和任务进入同一 execute 主循环；另一条可路由路径仅用于 Runtime 能力／状态事实回复。
- 模型可直接回答或请求注册工具；Runtime 校验并执行请求、记录结果，再追加回同一循环。
- TaskBook 步骤执行、DECIDE、验证模型、恢复模型和 CAPTURE 不属于当前执行路径；持久 TaskBook 仅作只读历史。
- VERIFY 只评估 Runtime 证据。窄结构成功可记为 pass；需要人工判断的其他完整 run 保持 unverified。
- RECOVER 作出有界的确定性重试、停止或升级用户决定；已结算副作用不重复执行。
- 面向用户的最终自然语言必须来自真实 LLM 调用，并在发布前按 settlement 身份登记。
- `model-observability` 在正文校验前按逻辑请求身份与物理 attempt 持久化 `provider_usage_recorded`；每个回执只累加一次，之后的逻辑响应结算不再重复累加。Provider 已返回用量而正文无效时，用量仍保留。
- Hooks 可在受控策略下扩展生命周期，但不能取得状态机所有权或跳过权限、验证、证据与收尾；失败降级规则有界。

合法状态转移与旧检查点规范化由 `packages/types` 和 [Core Flow 状态契约](../../docs/reference/core-flow-state-contract.md)维护。

## 代码入口与验证

`stages/execute` 拥有请求循环和工具协作；`stages/verify` 分类证据；`stages/recover` 决定重试／停止／升级；`llm-call-contracts` 定义请求身份与输出契约；`durable-kernel.ts`、`checkpoint-resume.ts` 管理事件与续跑边界。

测试与 stage 同目录；`current-path-contract.test.ts` 防止第二执行路径或退役路由回流。局部改动用 Harness 定向测试；权限、持久化或重启变化还需相应 Runtime 与 Electron 验收。跨包使用公开导出，不深层导入私有实现。
