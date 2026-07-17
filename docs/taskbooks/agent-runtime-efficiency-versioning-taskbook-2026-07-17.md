# LittleSheep Agent Runtime 效率与版本化连续性任务书 2026-07-17

最后更新：2026-07-17 13:24:05

状态：本轮实现已完成工具调用级并行、数据与工作区 shadow Git 检查点、退出冻结和 LLM 调用收敛；活动 run 重启续跑、运行中事件重入、TaskBook 步骤级并行和后台托盘仍未完成。

本文是本轮“并行执行、可回退、少而有效地调用 LLM”工作的专项任务书。长期分工以 [架构原则](../principles/architecture-principles.md) 为准，当前事实以 [项目状态](../decision/project-status.md) 为准，旧连续性任务书中的阶段设计仍有效，但与本文冲突的完成状态以本文和项目状态为准。

## 1. 目标与边界

本任务线只服务两个核心目标：不失忆、高效完成任务。所有缓存、日志、版本、调度和上下文结构都必须证明能够减少丢失、重复、等待、无效 Token 或恢复成本，否则应简化或延后。

- LLM 负责理解、推理、提出计划、工具调用建议和用户可见表达；Agent Runtime 负责状态、权限、调度、执行、验证、记忆提交、版本和恢复。
- 用户看到的最终回答、执行结论和阶段性表达必须由 LLM 结合运行时 `SOUL.md` 生成。确定性代码只负责隐藏的流水记录、状态装配、验证、版本提交和安全兜底，不能把有风格的前台表达改成固定模板。
- 并行只针对相互独立、无资源读写冲突、权限语义明确的工具调用；缺少依赖和资源信息时默认串行。TaskBook 步骤级并行是后续独立阶段，不能把工具调用并行误称为完整任务并行。
- 版本化只作用于 LS 应用数据和用户明确授权的工作区，不修改用户已有 `.git`，不把密钥、缓存、SQLite/WAL、构建物或无关未跟踪文件纳入管理。

## 2. 已完成实现

### 2.1 工具调用级并行

- LLM 在同一响应中提出多个独立工具调用时，Runtime 先做依赖、资源读写和权限判定，再把安全的调用分成有限波次执行。
- 默认并发度为 4，硬上限为 8；读操作可并行，不同文件的写入可并行，`exec`、Skill 创建和未知副作用保持独占。
- 同一资源、重叠路径、共享审批或顺序敏感操作自动串行；结果按模型原始调用顺序归并，保证并发不会改变证据语义。
- 每个分支保留开始、结束、状态、错误、耗时和工具结果；取消、超时和失败不会重做无关分支。

主要实现：`packages/harness/src/stages/execute/tool-scheduler.ts`、`packages/harness/src/stages/execute/tool-loop.ts`。

### 2.2 Shadow Git 与检查点

- LS 数据根和用户工作区使用相互独立的本地 bare shadow Git；用户工作区原有 `.git` 不被接管或污染。
- 每次完整 run 生成关联的数据域与工作区域检查点，manifest 采用 `pending`、`complete`、`partial` 状态，记录 run、session、before/after revision、文件清单、时间和结果。
- `write`/`edit` 修改前必须先成功保存 preimage；可能写入的 `exec` 先冻结工作区。创建前不存在的文件可回退为“不存在”。
- 支持回退到 run 的 `before` 或 `after` 状态；只恢复 shadow Git 管理的文件，不执行 `git clean -fd`，无关未跟踪文件保留。
- Runner 关闭时先关闭 SQLite/Embedding，再执行 `shutdown-freeze`；退出期间未完成的检查点保留可诊断状态。
- 密钥、缓存、日志、SQLite/WAL、向量和构建产物等敏感或可再生内容默认排除，不能因为 checkpoint 存在而进入版本库。

主要实现：`packages/types/src/versioning.ts`、`packages/snapshot/src/git-client.ts`、`packages/snapshot/src/git-checkpoint.ts`、`packages/snapshot/src/git-checkpoint-files.ts`、`packages/runner/src/version-checkpoint-lifecycle.ts`。

### 2.3 LLM 调用与上下文收敛

- 每轮模型调用有独立 `modelCallCount` 和默认 32 次硬上限，不依赖有界观测数组的长度。
- `CAPTURE` 默认从已持久化的对话、步骤和工具状态生成确定性 daily 原子，不为内部流水额外调用 LLM；`EVOLVE` 使用 `adaptive/always/never`，默认只在复杂任务、持久化工具、恢复/重规划或明确记忆信号出现时调用。
- `REPLY`、DECIDE 产生的任务说明、执行步骤结果、VERIFY 说明和多步骤 `execute_final_reply` 由 LLM 生成；运行时生成的澄清事实由 `ASK_USER` 做一次有界表达，DECIDE 已写好的澄清直接复用，不重复调用。所有前台自然语言调用均注入运行时 `SOUL.md`，保证用户配置的人格、语气和渐进式披露风格。按钮、状态、权限、路径和进度由 Runtime 固定提供，`FINALIZE` 禁止新增模型调用。
- Context Engine 区分阶段软目标与模型窗口硬上限：先按优先级裁剪可选内容，必要内容在未超过真实模型窗口时可以超过软目标；未知模型不会凭软目标触发会话压缩。
- 每次请求在缓存边界后注入精确到秒的 runtime awareness；最近对话优先于重复的静态时间段，时间、耗时和进度仍由运行时事实提供。
- 记忆上下文继续沿 `root index -> branch index -> expand -> branch-scoped search`，只把有任务价值、作用域正确、证据可解释且预算允许的 Atom 放入请求。

主要实现：`packages/harness/src/model-observability.ts`、`packages/context/src/engine.ts`、`packages/harness/src/context-candidates.ts`、`packages/harness/src/stages/capture.ts`、`packages/harness/src/stages/execute/final-reply.ts`。

## 3. 尚未完成

1. **运行中事件重入**：建立 `RuntimeEventQueue`，在安全边界消费用户追加要求、暂停、恢复和设置变更，并只生成局部 `TaskBookPatch`。
2. **TaskBook 步骤级并行**：为步骤声明依赖、读写集合、副作用和验收标准；无依赖、无冲突步骤才可并行，并按稳定依赖顺序归并结果。
3. **活动 run 重启续跑**：把 TaskBook、分支状态、事件游标、权限结果和幂等副作用状态纳入可恢复检查点；启动时提供恢复、放弃和现场查看，而不是只恢复数据文件。
4. **后台执行控制面**：托盘状态、重新打开、暂停、中断、彻底退出和关闭窗口策略需要独立语义与 UI；在配套完成前不改变当前关闭行为。
5. **真实 Provider 校准**：使用 OpenAI、DeepSeek、GLM 真实凭证校准模型窗口、reasoning、usage、上下文本地账本和前台表达质量；mock 只证明本地结构。
6. **版本治理 UI**：在不把内部 Atom 结构暴露给普通记忆页的前提下，增加用户可理解的 run checkpoint、数据/工作区回退和恢复结果入口。

## 4. 验收标准

- 并行与串行在相同输入下得到等价的工具证据、验证结论和记忆写入；冲突资源不并行，长期运行无集合、监听器、子进程或句柄无界增长。
- 每轮完整对话、写入前和退出冻结均有可定位版本；数据与工作区能同步回退，回退不删除无关未跟踪文件，密钥和生成物不入 shadow Git。
- 普通聊天、复杂任务和运行时澄清的用户可见自然语言都能在请求快照中找到 LLM 调用与 `SOUL`/profile 上下文来源；已由 DECIDE 生成的澄清不重复调用，确定性 CAPTURE 不增加前台模型调用。
- Context 快照记录实际纳入与排除的来源和理由；真实模型窗口未知时不显示伪精确 Token 百分比，也不因软目标误触发压缩。
- 运行中失败、取消、关闭和重启都有明确状态，不能把部分完成伪装成成功。

## 5. 验证顺序

```powershell
pnpm.cmd run check:repo
pnpm.cmd test
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd run verify:app-recovery
```

涉及正式用户数据时，只读记录 `<用户目录>/.littlesheep` 基线并使用隔离目录验证；未经单独授权不得迁移、重写或清理正式数据。每次桌面构建完成后刷新 `%USERPROFILE%\Desktop\LittleSheep.lnk`，快捷方式必须指向最新本地构建并能直接启动应用。

## 6. 后续顺序

先完成真实 Provider 校准和统一 Tool Execution Service，再实现 RuntimeEventQueue 与 TaskBook 步骤并行，随后把现有 shadow Git 检查点升级为活动 run 可恢复续跑，最后补后台控制面、版本治理 UI 和效率对比基线。
