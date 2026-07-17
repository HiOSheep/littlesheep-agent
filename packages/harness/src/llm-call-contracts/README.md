# LLM Call Contract 边界

本目录定义 Core Flow 每种模型调用的版本化认知契约。

- `definitions.ts`：CLASSIFY、DECIDE、EXECUTE tool-loop/final reply、RECOVER、VERIFY、EVOLVE、CAPTURE、REPLY、ASK_USER、FINALIZE 和会话压缩的最小契约模板。
- `registry.ts`：根据本轮真实目标、工具和 Context 阈值生成不可变的已解析契约。

## 所有权与验证

本目录只拥有调用策略模板和解析，不拥有 Prompt 正文、Context 内容、工具实现或记忆存储。公共类型唯一来源是 `@littlesheep/types`，发送入口是 `../model-observability.ts`，Context 强制执行位于 `@littlesheep/context`。

契约负责声明调用目的、允许输入、可作决定、输出结构、记忆意图、工具权限和预算。模型请求仍由 Context Engine 装配，工具执行和记忆提交仍只由运行时完成。每轮另有模型调用硬上限；`CAPTURE` 默认走确定性运行流水，`EVOLVE` 自适应调用。用户可见的回复、任务说明、执行结论、验证说明和运行时澄清由 LLM 结合 `SOUL.md`/profile 生成或复用既有模型文案；DECIDE 已生成的澄清不重复调用，运行时兜底澄清才使用有界 `ASK_USER` 调用。按钮、状态、权限、路径和进度等机器事实不交给模型生成，`FINALIZE` 明确禁止额外模型调用。定向验证位于 `../model-observability.test.ts`，多调用隔离由 `../e2e.test.ts` 覆盖。
