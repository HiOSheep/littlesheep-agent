# LLM Call Contract 边界

本目录定义 Core Flow 每种模型调用的版本化认知契约。

- `definitions.ts`：CLASSIFY、DECIDE、EXECUTE tool-loop/final reply、RECOVER、VERIFY、EVOLVE、CAPTURE、REPLY、FINALIZE 和会话压缩的最小契约模板。
- `registry.ts`：根据本轮真实目标、工具和 Context 阈值生成不可变的已解析契约。

## 所有权与验证

本目录只拥有调用策略模板和解析，不拥有 Prompt 正文、Context 内容、工具实现或记忆存储。公共类型唯一来源是 `@littlesheep/types`，发送入口是 `../model-observability.ts`，Context 强制执行位于 `@littlesheep/context`。

契约负责声明调用目的、允许输入、可作决定、输出结构、记忆意图、工具权限和预算。模型请求仍由 Context Engine 装配，工具执行和记忆提交仍只由运行时完成。`FINALIZE` 明确禁止额外模型调用。定向验证位于 `../model-observability.test.ts`，多调用隔离由 `../e2e.test.ts` 覆盖。
