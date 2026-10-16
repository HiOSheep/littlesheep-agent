# RCD S2B-2 — 同一 Run 持久恢复协议审计

**状态：** 第一单元完成；第二、三单元未实施。S2B-2 与整体 S2B 均未完成。  
**基线：** `90811ce0`，分支 `codex/rcd-s2b-continuity`，继承 VRS V2B `28667f84`。  
**审计日期：** 2026-10-16。  
**范围：** Runner / Harness 源码审计、T04-A 真实子进程崩溃目标测试；没有修改生产 Runtime 行为。

## 结论

当前 Runner 重启恢复负责 durable event 投影对账、未结算模型/工具状态的保守结算，以及已完成 Run 的最终回复回执修复。它没有重新装配原 Run 的 Harness Context，也没有同 Run 的 Harness 重新进入路径。

普通 checkpoint 续接不能代替该能力：现有路径把它作为新的逻辑 Run 执行，建立新的 Run 身份，并通过 `continuationLoopBudget` 将模型调用、工具调用、循环次数及无进展预算归零。将这条路径改成保留 Run ID 会同时碰到 ingress 幂等、lease 所有权、上下文重建、授权重新校验及终结事件不可逆等契约；不能只改一次 `run()` 调用。

本次新增的真实子进程故障测试在段边界证明该缺口：第 30 项工具副作用完成后，第二段 checkpoint 已原子写入；子 Runner 随即被 `SIGKILL`。旧 Run lease 过期后，通过新 Runner 的 `recoverDurableRun(sessionId, runId)` 恢复，当前投影为 `waiting_user`，并没有启动新的 Provider 请求或继续剩余 5 项。已完成的 30 项文件保持不变，没有重放。目标测试以 `it.fails` 保留，作为 S2B-2 后续实现必须转绿的回归。

## 生产路径审计

### Checkpoint 与 Harness 上下文

- `packages/harness/src/stages/execute/tool-loop.ts` 在段额度耗尽后先增加 Segment 序号、写入运行时续接控制消息，再调用 `ctx.persistRuntimeCheckpoint('execution-segment-started')`，成功后在同一个存活的 `runToolLoop` 中继续。
- `packages/runner/src/run-checkpoint.ts` 持久化 Run/Session ID、段与累计预算、事件队列快照、运行中的工具账本、Context 快照 ID、任务/恢复元数据等有限字段；不序列化完整 Harness 模型消息、未发送的 segment 控制消息及完整运行配置/运行时授权对象。
- 新 Runner 可从会话存储找到原始 inbound，但目前没有“按检查点精确还原该 Run 的 Harness 输入与任务内存工作集”的接口。直接重新执行普通的 session/context 装配会重新加载当前会话历史、Memory 与当前配置，不能证明得到与原 Run 相同的事实与权限边界。
- 额外工具仅以封闭的恢复配方保存少数受支持类型；普通 `additionalTools` 闭包不能跨进程恢复。新路径不能假定进程内工具对象仍存在。

### Durable event、ingress 与终结

- `packages/runner/src/durable-run-recorder.ts` 的 `createDurableRunRecorder` 会为固定 Run ID 写入 `run_accepted`；每次模型入口还会写入 `user_input_appended`。同一 Run 恢复时重复调用这些 ingress 会与 inbox 幂等冲突，不能直接复用完整的新 Run 初始化过程。
- `packages/runner/src/durable-run-recovery.ts` 获取 Run 与 pending effect lease，调用 `DurableHarnessKernel.recoverRun`，然后在 `finally` 释放所有 lease。它不接收或启动 Harness。
- 对没有已结算最终回复的未完成 durable Run，`DurableHarnessKernel.recoverRun` 会留下 `runtime_status_settled(waiting_user)`。该事实用于安全地暴露恢复阻塞；如果要自动续接，必须先通过持久恢复资格检查避免把可恢复安全段错误终结。写入之后不能再无歧义地将同一 Run 视为普通活动执行。
- 最终回复已经由现有 reservation、registry settlement、`run_completed` 幂等身份协调。恢复只能沿原回执修复，不得重新运行已终结 Run 的 Harness。

### Lease、并发及 fencing

- 活动 Runner 通过 `DurableRunOwnership` 持有 Run heartbeat 和 effect lease coordinator；租约更新失败会通知 Runner 中断。
- 恢复适配器在投影对账期间持有 lease，但返回前释放；若在它之后才单独启动同 Run Harness，会出现释放到重新获取间的竞争窗口。恢复接管必须持有同一 Run lease 贯穿“检查恢复资格 → 重建上下文 → Harness 执行/终结”。
- durable event store 的 `trustExclusiveRunOwnership` 是当前进程内写入/缓存优化标记，不携带持久 Run lease owner token；它不是跨进程 fencing token。heartbeat 丢失后虽会中断当前 Run，仍需证明旧持有者无法在新 owner 接管后通过迟到回调追加结算或开始新的副作用。
- effect lease 已经为工具副作用提供独立所有权与 recovery 对账；未知 effect 会被标记 unknown 并阻止自动重放。该安全处理必须继续由原 effect identity 驱动，不能用新 Segment/call ID 掩盖。

## 恢复资格与建议协议

恢复资格必须由 Runner 根据持久事实决定。建议只允许自动恢复具备显式 `safe_segment_boundary` 记录的 checkpoint，并且同时满足：

1. Run 未有 `run_completed`、`run_failed`、`run_interrupted` 或已发布的 runtime waiting-user 终结状态。
2. 最新 checkpoint 明确处于段边界；其 durable event cursor 与 projection cursor 对齐。
3. 无 pending/unknown effect，无未结算模型请求，无最终回复 proposal/settlement 歧义。
4. 原始 inbound、Harness 会话轨迹、loop budget、Segment 序号、run event queue 游标及工具输入身份完整且通过版本化 codec 校验。
5. 取消与暂停状态、已入队用户消息、当前工具目录、网络禁令、Memory 权限、Shell 授权与 workspace 环境在接管时重新验证；任何无法证明有效的授权都不继承为可执行许可。
6. Run 总预算未耗尽，无进展和累计尝试状态跨重启保留；新 Segment 不补发额度。
7. 恢复者在整个判定及续跑期间持有同一 Run lease；工具仍使用原 effect identity，最终回复继续使用原 settlement identity。

不满足条件时，保留原 Run 和 checkpoint，准确记录阻塞原因并等待用户处理。不得临时创建新 Run 来自动重试。

## 最小后续实施拆分

### S2B-2B — 最小安全恢复路径

- 在现有 checkpoint codec 中增加封闭、版本化的安全段边界状态与 Harness 可恢复快照引用。先确定 Context/消息快照现有存储是否提供不可变、按 Run 定位的读取能力；若没有，新增的数据必须有大小上限、完整性哈希和隐私/清理策略，不能把临时 prompt 或凭据写入普通事件日志。
- 为 DurableRunRecorder 增加只用于接管既有 Run 的无 ingress 初始化方式；保持原 Run ID、Session ID、事件序号与原始输入引用。
- 将 lease 获取与恢复资格判定交由一个 Runner 所有权生命周期持有，在 lease 释放前进入现有 Harness；避免先 `recoverDurableRun`、再 `run()` 的 TOCTOU。
- 使用严格的恢复权限上限；不能从 checkpoint JSON 还原 Main/Host capability。重新检查当前控制消息与授权并在权限不足时停止。
- 只让明确安全的段边界重入 Harness。pending Provider、pending effect、unknown、暂停、取消、不兼容 checkpoint 与终结状态继续走现有保守处理路径。

### S2B-2C — 故障窗口与恢复验收

- T04-A 真实 OS 进程崩溃后的 35/35 同 Run 自动续接。
- T04-B 两个恢复者竞争及旧 owner fencing。
- T04-C Provider 发起后无可靠回执，明确不静默重发并保留 usage unavailable/unknown。
- T04-D 文件副作用后结算前崩溃，unknown 不重放。
- T04-E final reply 丢失，只修复原 settlement，不重跑 Harness。
- T05-R、T08-R、T03-R 覆盖重启后取消/暂停/steering/授权、usage 去重及无进展累计。
- 保留 S2B T01/T02/T05、VRS evidence settlement、旧 checkpoint 兼容及 S1/RCD 核心回归。

## T04-A 可复现测试

测试 `packages/runner/src/durable-runner-segment-recovery.test.ts` 启动真实 Vitest 子进程，运行 Runner + Harness，完成 30 个独立临时文件工具副作用。子进程包装 checkpoint store 的 `write`，在第二段 checkpoint 已由真实 store 写入后阻塞；父进程对其发送 `SIGKILL`。新 Runner 等待原 30 秒 lease 过期，再通过生产 `recoverDurableRun` 入口处理同一 `sessionId/runId`。

当前目标断言失败：

- 预期同一 Run `completed` 且完成 35 项。
- 实际 projection 为 `waiting_user`；未重启 Harness，也没有新增 Provider 调用。
- 原来已落盘的 30 项仍然存在；没有证据显示重复文件副作用。
- 这是实际 OS 子进程终止与重建 Runner 的测试层级，但当前只覆盖安全段边界。Provider pending、effect pending、授权撤销、双恢复者以及 Electron 启动自动恢复仍未覆盖。

可复现命令：

```powershell
pnpm exec vitest run packages/runner/src/durable-runner-segment-recovery.test.ts --pool=threads --maxWorkers=1 --minWorkers=1
```

测试在源码中以 `it.fails` 表达尚未实现的目标，因此测试套件将其显示为预期失败通过；2026-10-16 的临时诊断运行将 `.fails` 暂时移除，观察到上述 `waiting_user` 与 `completed` 的断言差异，然后恢复 `.fails`。恢复 lease 等待约 30 秒是生产默认租期带来的真实行为。

## 实施与验收状态

| 部分 | 状态 | 证据 |
|---|---|---|
| S2B-2A 源码/调用链审计 | 完成 | 本文生产路径与协议审计 |
| S2B-2A T04 目标失败测试 | 完成 | 真实子进程 SIGKILL 后的 Runner recovery 测试 |
| S2B-2B 同 Run 自动恢复 | 未实施 | T04-A 目标失败，生产代码保持不变 |
| S2B-2C 故障与跨重启回归 | 未实施 | 依赖安全恢复协议与实现 |
| S2B-2 出门条件 | 未满足 | T04-A 未通过；T04-B～E、T05-R、T08-R、T03-R 未完成 |

本阶段只提交恢复协议与失败证据，不代表 S2B-2 或 S2B 完成。没有启动 S2C/S3，没有推送或合并。
