# @littlesheep/tools

提供内置工具、注册表，以及所有宿主工具共享的统一执行服务。
桌面流程验收（RS-07，2026-09-27）：`pnpm run verify:desktop-file-consistency` 在真实窗口里跑完七段桌面流程，14 项检查。① Agent 读文件；② 用户在自己编辑器保存（同长度改写）；③ Agent 的 `edit` 被拒（会话存储里是 `changed after it was read; read it again before overwriting it`），盘上保留用户的字节；④ 重读后同一编辑成功；⑤ `exec` 写的文件随后退出 3——盘上是命令写入的内容，而基于旧读取的后续编辑被拒；⑥ `document_create` 对已存在的同名文档返回 `already exists`，既有文档字节不变；⑦ 研究模式下写入的批准请求由客户按真实审批端点**拒绝**，文件未被创建。最后做**对账**：从应用自己的 shadow 版本仓库（`backups/versioning/repositories/workspaces/*.git`）重建该文件的每个历史版本，断言每个版本都是这次流程真实产生过的内容，并报告最新版本与最终文件一致——"有备份"不等于"没有误覆盖"。证据同时来自本进程读到的磁盘字节与会话存储；模型是确定性替身、编辑器 UI 与审批弹窗 UI 未驱动（报告 `limits` 明写）。

真实文件一致性验收（RS-07，2026-09-27）：`pnpm run verify:file-consistency-faults` 在临时工作区用**真实文件与真实工具**（`read`/`write`/`edit`/`exec`）验证文件观察守卫，并在每一步断言**磁盘上的字节**而不是工具的自述。覆盖：同大小且保留 mtime 的改写（`observation_stale`）、文件其它区域被改动、部分读取后写入被拒（`observation_missing`）与重读后成功、被截断的读取不产生观察、目录被换成 junction 的路径重定向、删除后重建（同内容放行／不同内容拒绝）、两个会话并发创建、跨会话提交后旧会话被拒、审批被拒时文件不变、`exec` 部分失败后基于旧观察的编辑被拒、以及进程重启后必须重读。报告在 `limits` 里写明未覆盖项（回滚检查点失败属于桌面入口，不在本脚本内）。

最后更新：2026-09-27 21:10:43

- **可重跑声明**（2026-09-27，HC-04）：`write` 与 `edit` 声明 `reRunnableAfterResourceChange`，表示“同一参数在 Runtime 记录了同资源的后续成功变更之后，可以是一次新的执行”。声明本身不授权任何调用：账本只有在持有该记录时才发放新身份（见 `packages/harness/README.md`）；`exec` 等不透明工具不声明，其同参数重复仍被拒。

## 职责与边界

- 公开入口是 `src/index.ts`；注册表在 `registry.ts`，统一服务在 `tool-execution-service.ts`，调度、中断、记录摘要和结果处理分别在 `tool-execution-scheduler.ts`、`tool-execution-control.ts`、`tool-execution-records.ts` 和 `tool-execution-result.ts`，审批、清洗、计时包装和并发策略在 `approval.ts`、`sanitize.ts`、`wrapper.ts`、`execution-policy.ts`，路径只读策略在 `path-protection.ts`，内置工具在 `src/builtin/`。
- Tool Execution Service 是所有宿主工具（内置、插件、run-scoped）唯一的执行边界，统一负责查找与来源、schema 校验、权限与单次批准、超时/中断、资源冲突调度、执行、结果清洗、事件和有界 `ToolInvocationRecord`。调用超时由 `tools.invocationTimeoutMs` 统一配置，默认 120 秒、范围 1 秒到 24 小时，并继续受 run 总超时约束（服务自身在未传超时时回落到 `DEFAULT_TOOL_TIMEOUT_MS` 60 秒）；超时或中断后最多等待 1.5 秒让工具清理，再向上层返回确定的控制错误。并行 TaskBook 分支必须传入已校验的资源封套，实际工具访问越界或选择独占工具时由服务拒绝。
- `builtin/request_user_input.ts` 是模型唯一能主动提问的入口：调用本身不做 IO，问题由 Harness 作为本轮回复发布并记录一条等待事实。它的描述写明**提问的门槛**——只有答案会阻塞有用或安全的结果时才用；存在合理默认时（做哪种小游戏/玩具/演示、文件名、布局）选一个、用一句话说明并开工，用户看到结果后再改；"用户偏好哪个选项"不算缺失事实。这条措辞是 2026-09-24 实机验收里真实模型在该场景提问后的直接修订（见 `packages/prompt/README.md`）。
- 模型可见的工具目录在一个会话区间内固定，不随轮次增删；某一轮不得使用的能力通过 `executeBatch` 的 `allowedToolNames` 在执行时拒绝（`admittedTools` 是执行范围，不是可见性），拒绝照常写入调用记录并回报给模型（记录状态 `validation_failed`、错误类别 `step_tool_not_allowed`，文案说明是"已注册但本请求未准入"，不再提已删除的 TaskBook 步骤）。
- `file-observation.ts` 是"模型只能覆盖自己读过的版本"这一约定的宿主半边：它提供原始字节的 sha256、规范路径键（拒绝符号链接与非普通文件，Windows 折叠大小写）、同路径互斥表，以及**有界、内存内、不持久化**的观察登记表。它自己既不读写用户文件也不替调用方决定能做什么；表随 Runner 退出，淘汰或重启只意味着模型需要重读。冻结端口期间不登记新观察、已有观察也不得授权写入（供 `exec` 这类不透明修改使用）。写工具的公共校验入口是 `readVerifiedFile()`：按内容哈希而非 size/mtime 判定版本，覆盖已有文件时要求整文件观察，失败一律以 `ok: false` 返回而不抛异常。
- 工具可以在 `meta.errorKind` 里声明一个**有界**的小写原因（如 `observation_stale`、`target_exists`）；Tool Execution Service 会把它写进 `ToolInvocationRecord.errorKind`，因此审计与失败分类看到的是真实原因而不是笼统的 `failed`。插件共享这条通道，所以格式被限制为 `^[a-z][a-z0-9_]{0,63}$`，不合格的值被忽略。
- Harness 只负责单一模型循环和副作用检查点生命周期；已持久化的 TaskBook 只是可读历史，没有步骤调度器，也没有第二个执行器。生命周期钩子 `afterInvoke` 除结果外还收到 `ToolInvocationOutcomeInfo`（`status`/`errorKind`），因为原始 `ToolResult` 无法区分"命令跑完返回非零"与"调用被超时/中断切断"，而副作用结算必须区分这两者。
- 工具实现只完成受约束动作并保留动作前的路径二次复核；不得自行重复请求已经由统一服务授予的同一次批准。
- 禁止工具自行绕过工作区、审批或执行日志，也不把长输出原样塞入 Context。
- ToolContext 中的 `containerRoot` 是活动 `.littlesheep` 数据根的逻辑容器分类边界。完全访问经一次显式风险确认后，对容器内外及范围不明的读、写、改、删、执行免逐次批准；研究只对容器内读取免批准；受限所有操作都要批准。
- 当前内置写入、编辑和命令工具必须尊重容器边界以及核心源码只读根；核心源码拒绝发生在审批之前，不能靠完全访问或单次批准绕过。拒绝一律带 `meta.errorKind: 'core_source_read_only'`（`path-protection.ts` 的 `CORE_SOURCE_READ_ONLY_KIND`），让主循环无需匹配文案就能判定这是权威边界；文案由 `coreSourceReadOnlyMessage()` 统一生成，点名仍然可用的只读形态（`Get-ChildItem` 列举、`Test-Path -LiteralPath` 存在性、`Get-Content`/`rg` 读取、`glob`/`grep`/`read` 工具）以及"写入应改用可写工作区"。
- `path-protection.ts` 的 `isReadOnlyCoreCommand()` 是受保护根内**唯一**的只读命令白名单，窄形态可证明：单条命令、无 `;`/`&&`/`|`/重定向/子表达式，且不含 `-Credential`（避免把本地探测变成认证通道）。它放行列举与存在性（含单条 `Test-Path`），写入类（`mkdir`、`Set-Content`、`Remove-Item`）与任何组合语法仍然拒绝。它只决定"受保护根内这条命令是否可执行"，不改变容器边界分类，也不免除审批。
- `exec` 对动态 Shell、网络、外部进程和不能静态证明范围的命令标记为 `unknown`；研究/受限 fail closed，完全访问直接放行普通命令。stdout/stderr 分别只保留最多 64 KiB 的首尾内容，并记录原始长度、保留长度、截断、退出码、超时/中断和进程是否关闭；Windows 使用 `taskkill /t /f` 关闭进程树，POSIX 使用独立进程组。危险命令黑名单和核心源码保护始终优先；内置终端必须使用同一套判定。

## 依赖与数据

- 依赖会话、记忆、经验、向量、文档、安全和公共契约；不依赖 `@littlesheep/config`，上层 Harness/Runner 决定调用时机。
- 工具不拥有用户文件，只在授权路径和调用生命周期内访问。

## 测试与修改定位

- 注册、调度、统一执行、清洗、审批、路径保护和每个内置工具均有同目录测试。
- 新工具必须定义 schema、权限等级、执行并发策略、资源读写集合、输出上限、中断语义和失败格式；插件与未来 MCP 工具也必须通过统一服务执行。
- 依赖边收口（2026-09-27，SL-02）：移除实测零引用的 `@littlesheep/experience`、`@littlesheep/vector` 与 `@littlesheep/memory-core`（后者在 F-02 首轮核对时被误配到别的包——重新取证后确认本包对它是零引用）。**保留** `@littlesheep/safety`（本包 13 个文件引用）与 `@littlesheep/types`（35 个文件）。
