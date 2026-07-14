# Harness Hooks

Hooks 在受控策略下扩展 Harness 生命周期，不改变核心状态机所有权。

## 边界

- `runner.ts` 负责 hook 注册、顺序、claim 和失败降级。
- Hook 只能修改契约允许的数据，不能跳过权限、验证、执行证据或最终化。
- 失败策略必须显式且有界，不能让非关键 hook 随意中断核心 run。

## 测试

- Hook 顺序、异常、claim 和降级测试位于 `runner.test.ts`。
- 新 hook 类型先进入公共契约并说明调用时机和可变范围。
