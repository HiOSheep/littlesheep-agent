# Harness Hooks

最后更新：2026-09-22 12:40:16

Hooks 在受控策略下扩展 Harness 生命周期，不改变核心状态机所有权。

## 边界

- `runner.ts` 的 `HookRunner` 负责 hook 注册、优先级顺序、claim 和失败降级；唯一调用方是 `../durable-harness.ts` 的驱动循环。
- 三种 hook 模型：`void`（只观察）、`modifying`（before 可改 ctx，after 可替换 StageResult）、`claiming`（仅 before，首个非空 StageResult 取代默认 stage）。阶段内顺序为 void → modifying → claiming，priority 降序、同级按注册序。
- Hook 只能修改契约允许的数据，不能跳过权限、验证、执行证据或最终化。
- 失败策略必须显式且有界：hook 抛错只记录 warn 并降级为 no-op（claiming 视为未 claim），不能让非关键 hook 中断核心 run。

## 测试

- Hook 顺序、异常、claim 和降级测试位于 `runner.test.ts`。
- 新 hook 类型先进入公共契约并说明调用时机和可变范围。
