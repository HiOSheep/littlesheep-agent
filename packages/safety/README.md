# @littlesheep/safety

提供输入校验、提示/记忆清洗、隔离区和安全存储包装。

## 职责与边界

- 公开入口是 `src/index.ts`；校验在 `validate.ts`，清洗在 `sanitize-prelude.ts`，隔离在 `quarantine.ts`。
- 负责安全策略基元，不决定产品权限模式或替代 Tool Execution 审批。
- 禁止吞掉风险或把隔离内容重新注入 Context。

## 依赖与数据

- 只依赖公共契约，供 Memory、Experience、Tools 等领域调用。
- 隔离数据和安全审计属于用户数据；包不拥有业务实体。

## 测试与修改定位

- 每个主要模块均有同目录测试。
- 新规则必须覆盖误报、漏报、截断和 Unicode/路径边界。
