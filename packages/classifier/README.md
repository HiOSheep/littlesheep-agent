# @littlesheep/classifier

用确定性规则为 Harness 提供活动路由证据：命中规则的会话请求路由到 `reply`，其余请求交给单一主循环（`execute`），由模型决定直接回答还是调用工具。旧 `chat / problem / unclear` 字段只用于会话、检查点和插件兼容，不再定义新产品语义。

## 职责与边界

- 公开入口是 `src/index.ts`；`rules.ts` 提供快速规则。
- 只负责活动路由证据和结果，不规划任务、不调用工具、不写记忆，也不消耗模型请求。
- 禁止把 Workflow、权限或 UI 分支塞进分类规则。

## 依赖与数据

- 仅依赖 `@littlesheep/types` 契约。
- 不持久化用户输入或模型结果。

## 测试与修改定位

- 规则测试在 `src/rules.test.ts`。
- 新分类字段先进入 `@littlesheep/types`，再同步 Harness 消费方。
