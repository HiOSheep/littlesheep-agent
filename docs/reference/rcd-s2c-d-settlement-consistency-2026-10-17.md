# RCD S2C-D — Task Outcome 结算一致性

**验收基线：** 主线 S2C-I `1528a613` 及其父提交中的集成结果

**结论：** 跨进程故障矩阵通过；各持久存储仍是顺序协调，不具备全局事务。缺少 ExecutionLog 证据时，读取端安全降级为 `unknown`。

## 写入顺序与所有权

当前生产 Runner 的 FINALIZE 路径依次执行：

1. Harness FINALIZE 提交最终回复提案，并将带有 `proposed` 状态的回复写入 Session transcript。
2. Runner 根据可信运行结果与工具证据构造 Task Outcome，并以 `${runId}:task-outcome:v1` 身份写入 Durable Event。
3. Runner 将 ExecutionLog 写入单独文件。单文件使用临时文件和重命名；这不与 Durable Event 或 Session transcript 组成事务。
4. Runner 结算 Session 回复注册表，再写入 `final_reply_settled` Durable Event。
5. Runner 更新 ExecutionLog 中的 final-reply 投影。
6. Runner 写入 `run_completed` Durable Event，完成 Run checkpoint 后才向调用方返回。

Durable Event 的稳定身份使相同事实重复写入时幂等；相同 Task Outcome 身份但内容不同会冲突。ExecutionLog 文件更新是单文件原子替换。Session transcript、回复注册表、ExecutionLog、Durable Event、checkpoint 与调用方回执之间没有全局原子提交。

恢复只在匹配的最终回复提案已写入 transcript 时推进它：Runner 校验 Session、Run、settlement ID、回复正文、指纹和模型请求 ID；之后通过既有回复注册表结算，再补写 Durable Event。仅有预留状态而没有匹配的持久 transcript，不足以结算。投影缺失或证据不一致时不重跑工具，也不重建 Task Outcome 的通过证据。

## 真实进程故障矩阵

所有进程故障点都由独立 Node/Vitest 子进程执行真实 Runner/Harness/Tools 路径；父进程在标记边界对该子进程发送 `SIGKILL`。为避免测试等待完整 lease 超时，只有在确认旧子进程已退出后，测试才把隔离临时目录中的 lease 到期时间提前。该操作只用于测试时钟，不改变产品 lease 行为。

| 故障点 | 杀进程时已持久事实 | 恢复后结果 |
|---|---|---|
| Outcome 构造前 | 最终回复提案事件存在，匹配回复尚未完整写入 transcript | 记录保守 `unknown` Outcome；不结算回复、不写完成事件；不产生虚假通过 |
| Outcome 已写入、ExecutionLog 尚未写入 | Outcome 与回复提案已持久化；ExecutionLog 缺失 | 依据匹配 transcript 幂等结算回复与 Run；`replayTaskOutcome` 因验收审计投影缺失返回 `unknown`，不显示通过 |
| ExecutionLog 已写入、最终回复尚未结算 | Outcome、ExecutionLog 和回复提案均存在 | 校验 transcript 后结算回复及 Run；公共 Task Outcome 保留已检查证据 |
| 最终回复已结算、`run_completed` 尚未写入 | 回复注册表、回复事件、ExecutionLog 结算已提交 | 恢复只补 `run_completed` |
| Run 已完成、调用方未收到返回 | 三个结算事实均已提交 | 重复恢复不重新解释 Outcome，不重复结算 |
| 恢复对账已追加 `run_completed` 后再次 `SIGKILL` | 恢复事件已经写入，恢复调用方未收到返回 | 第二次恢复保持同一 Run、Outcome、回复与完成事件各一份 |

独立 Oracle 同时检查事件数、Outcome、ExecutionLog、工具 Effect、真实文件和 Run ID。矩阵各点的真实进程覆盖及证据保存在 [机器账本](rcd-s2c-d-settlement-consistency-2026-10-17.json)。组件级异常注入不替代这些 `SIGKILL` 用例。

## 文件检查证据的时间语义

`file_state` 与 `requirement_check` 证据现在记录可信工具 invocation 的结束时间 `checkedAt` 和当时文件内容 SHA-256。它们只证明指定文件在该检查时点的版本；不证明文件后来没有改变，也不代表历史打开会话时重新读取了文件。

定向测试覆盖同一 Run 后续写入使旧检查失效；进程级场景在检查之后、Outcome 事件写入之前从外部将文件改为 `goodbye`，随后又删除文件。历史 Outcome 仍准确保留“检查时 `hello` 通过”的事实及其时间和摘要。Renderer 明确提示文件此后可能变化且历史记录不会自动复核。当前文件内容、是否存在，需要重新检查才能确认。

缺失、损坏或与 ExecutionLog invocation 时间不匹配的证据引用不能继续作为 `passed` 的解析证据；旧记录没有 `checkedAt` 时仍兼容读取，但不会补造检查时间。

## 验收结果

- 真实进程故障矩阵、FINALIZE 恢复、Task Outcome 构造与回放、类型 codec、Renderer 卡片定向测试全部通过：**6 个测试文件，27 项测试**。
- D 修改后重跑真实 Electron Renderer/Main/Runner 验收：3 个场景、7 项检查通过；包括错内容失败、正确内容通过、未检查保持未验证、会话重载只显示一张 Outcome 卡片，以及普通对话不插入空卡片。Electron 44.4.5，构建新鲜度检查通过。
- `pnpm run typecheck` 通过；`pnpm run check:repo` 通过（35 项通过、0 失败、3 类既有 advisory）；`git diff --check` 通过。
- S2B 已有真实子进程恢复和最终回复崩溃测试保留；未知副作用和未结算 Provider 仍不作为完成证据。
- 本批没有创建第二套 Harness、VERIFY Stage 或跨存储事务框架。

## 支持边界

**支持：** 真实 Run 下的幂等 Task Outcome 事件、匹配 ExecutionLog 时的证据解析、最终回复与 Run 终态恢复、缺投影时的安全降级，以及文件检查时点的历史证据。

**不保证：** 多文件/多存储全局事务；缺失的 ExecutionLog 自动重建；未结算 Provider 请求或未知 Effect 的自动重放；文件检查后当前内容仍未变化；所有中断窗口均自动恢复。上述情形保持已有安全阻断或 `unknown` 语义。
