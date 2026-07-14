# @littlesheep/prompt

装配稳定的系统提示、行为 profile、工作区说明和有界记忆索引片段。

## 职责与边界

- 公开入口是 `src/index.ts`；`builder.ts` 负责装配，`profiles.ts` 定义通用/编程行为，`sections.ts` 提供分段。
- Prompt 表达原则和输出约束，不承担状态机、工具实现或全部业务逻辑。
- 禁止把完整长期记忆、用户项目正文或权限绕过规则常驻系统提示。

## 依赖与数据

- 依赖品牌、配置和公共契约；Context/Harness 决定本次实际注入内容。
- 不持久化 Prompt，构建结果只属于单次模型请求。

## 测试与修改定位

- 构建测试在 `src/builder.test.ts`，行为 profile 测试在 `src/profiles.test.ts`。
- 新行为模式必须保持与权限策略正交。
