# @littlesheep/tools

提供内置工具、注册表，以及所有宿主工具共享的统一执行服务。

## 职责与边界

- 公开入口是 `src/index.ts`；注册表在 `registry.ts`，统一服务在 `tool-execution-service.ts`，调度、中断、记录摘要和结果处理分别在 `tool-execution-scheduler.ts`、`tool-execution-control.ts`、`tool-execution-records.ts` 和 `tool-execution-result.ts`，路径只读策略在 `path-protection.ts`，内置工具在 `src/builtin/`。
- Tool Execution Service 统一负责查找与来源、schema 校验、权限与单次批准、超时/中断、资源冲突调度、执行、结果清洗、事件和有界 `ToolInvocationRecord`。Harness 只负责模型循环、TaskBook 编排与副作用检查点生命周期。
- 工具实现只完成受约束动作并保留动作前的路径二次复核；不得自行重复请求已经由统一服务授予的同一次批准。
- 禁止工具自行绕过工作区、审批或执行日志，也不把长输出原样塞入 Context。
- ToolContext 中的 `containerRoot` 是活动 `.littlesheep` 数据根的逻辑容器边界。完全访问只对容器内且可证明范围的读、写、改、删、执行免批准；研究只对容器内读取免批准；受限所有操作都要批准；容器外或范围不明的操作三档都要批准。
- 当前内置写入、编辑和命令工具必须尊重容器边界以及核心源码只读根；核心源码拒绝发生在审批之前，不能靠完全访问或单次批准绕过。
- `exec` 对动态 Shell、网络、外部进程和不能静态证明范围的命令 fail closed；内置终端必须使用同一套判定，不得把工作目录在容器内误当作命令一定安全。

## 依赖与数据

- 依赖配置、会话、记忆、经验、向量和公共契约；上层 Harness/Runner 决定调用时机。
- 工具不拥有用户文件，只在授权路径和调用生命周期内访问。

## 测试与修改定位

- 注册、调度、统一执行、清洗、审批和每个内置工具均有同目录测试。
- 新工具必须定义 schema、权限等级、执行并发策略、资源读写集合、输出上限、中断语义和失败格式；插件与未来 MCP 工具也必须通过统一服务执行。
