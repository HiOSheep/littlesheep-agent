# @littlesheep/prompt

最后更新：2026-09-22 12:40:16

装配稳定的系统提示、行为 profile、工作区说明和有界记忆索引片段，并公布缓存边界。

## 职责与边界

- 公开入口是 `src/index.ts`；`builder.ts` 负责装配并给出 `stableText`/`stableSegments` 与 `trailingSegments` 两半；`cache-boundary.ts` 只定义 `CACHE_BOUNDARY_MARKER`；`profiles.ts` 定义通用/编程行为，`sections.ts` 提供分段，`runtime-time.ts` 负责运行时时钟格式。
- system 消息恰好是边界以上的 sections；边界以下的 bootstrap、Runtime facts 和会话摘要由调用方的追加式尾部各自成消息，Prompt 不替调用方决定消息位置。
- Prompt 表达原则和输出约束，不承担状态机、工具实现或全部业务逻辑。
- 禁止把完整长期记忆、用户项目正文或权限绕过规则常驻系统提示。

## 依赖与数据

- 依赖品牌、配置和公共契约；Context/Harness 决定本次实际注入内容。
- 不持久化 Prompt，构建结果只属于单次模型请求。

## 测试与修改定位

- 构建测试在 `src/builder.test.ts`，行为 profile 测试在 `src/profiles.test.ts`，运行时时钟在 `src/runtime-time.test.ts`。
- 新行为模式必须保持与权限策略正交。
