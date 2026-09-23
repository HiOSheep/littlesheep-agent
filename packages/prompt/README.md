# @littlesheep/prompt

最后更新：2026-09-23 22:50:00

装配稳定的系统提示、行为 profile、工作区说明和有界记忆索引片段，并公布缓存边界。

## 职责与边界

- 公开入口是 `src/index.ts`；`builder.ts` 负责装配并给出 `stableText`/`stableSegments` 与 `trailingSegments` 两半；`cache-boundary.ts` 只定义 `CACHE_BOUNDARY_MARKER`；`profiles.ts` 定义通用/编程行为，`sections.ts` 提供分段，`runtime-time.ts` 负责运行时时钟格式。
- system 消息恰好是边界以上的 sections；边界以下的 bootstrap、Runtime facts 和会话摘要由调用方的追加式尾部各自成消息，Prompt 不替调用方决定消息位置。
- `# Workspace` 段落是 run 级事实，不是配置项：`RuntimeFacts.workspace`（调用方传入的实际执行目录）优先于 `resolvePromptConfig` 的 `agents.defaults.workspace`，只有未提供运行时事实时才回退到配置默认值。同一目录同时决定提示、工具 cwd、权限分类与产物归属。
- 两套输出契约各自的定位（CE-10）：`outputDirectivesSection()` 服务执行路径，含"用用户的语言（默认中文，术语保留英文）"、"代码/路径/命令内联不翻译"，以及"目标清晰、低风险、有明显默认值就不要先问——选合理默认、说明选择后开工；只有缺关键事实、目标冲突、不可逆动作或缺权限时才提问"。`responseDirectivesSection()` 服务会话路径，一直带有等价的"先给出带假设的最佳回答"。执行路径此前缺这条，是"做一个小游戏吧"落在执行路径上却先被追问的结构原因。
- Prompt 表达原则和输出约束，不承担状态机、工具实现或全部业务逻辑。
- 禁止把完整长期记忆、用户项目正文或权限绕过规则常驻系统提示。

## 依赖与数据

- 依赖品牌、配置和公共契约；Context/Harness 决定本次实际注入内容。
- 不持久化 Prompt，构建结果只属于单次模型请求。

## 测试与修改定位

- 构建测试在 `src/builder.test.ts`，行为 profile 测试在 `src/profiles.test.ts`，运行时时钟在 `src/runtime-time.test.ts`。
- 新行为模式必须保持与权限策略正交。
