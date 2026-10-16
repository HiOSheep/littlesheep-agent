# RCD S2B-2 — 同一 Run 持久恢复最小实现

**状态：** 第二单元已完成；S2B 整体仍未完成。T04-A 真实进程崩溃后续接通过。
**基线：** `3177624b`，分支 `codex/rcd-s2b-continuity`；已包含 S2B-1 `90811ce0` 与 VRS V2B `28667f84`。
**日期：** 2026-10-16。
**范围：** 同 Run 恢复资格、独占租约、Harness Context 重建、T04-A 与最小负向恢复保护。未推送、未合并 main。

## 结论

同一 Run 的安全段边界现在可以在 Runner 进程重启后重新进入现有 Harness。恢复沿用原 Run ID、Session ID、持久消息轨迹、累计预算和 effect identity；不重新提交 ingress，不新建 Run，也不通过普通 checkpoint continuation 重置额度。

T04-A 在真实子进程收到 `SIGKILL`、旧 lease 到期、全新 Runner 接管之后完成 35/35。恢复后的首个模型请求包含崩溃前已持久化的 30 个工具结果，之后继续第 31–35 项。最终 durable projection 为 `completed`，final reply 为 `settled`，有 35 个唯一且成功结算的 effect；35 个独立文件内容正确，`run_accepted` 和 `user_input_appended` 各只有一条。

这只证明受控 Provider 和本地内置文件工具下，**明确安全段边界**可以跨真实 Runner 进程重启恢复。Provider 请求未结算、effect unknown、最终回复回执故障窗口、真实 Electron 授权 UI 和真实 Provider 尚未由本单元覆盖。S2B-2 第三单元负责更完整的故障窗口验收；本结果不代表 S2B 整体完成。

## 实现契约

### 安全段 checkpoint 与上下文重建

- `execution-segment-started` checkpoint 新增可选的版本化 `safeSegmentBoundary`。其中只保存模型请求上下文摘要与执行上下文分项 SHA-256 指纹，不保存 prompt、密钥或授权对象。Runner 用分项执行上下文指纹作为恢复门；完整 ChatRequest 的摘要保留为边界证据，重建的模型上下文由持久 transcript 和 T04-A 首次恢复请求的 30 个旧工具结果独立验证。
- 写 checkpoint 前，Runner 把 Harness 当前 `produced` 消息逐条以 `appendIfAbsent` 写入 Session 持久消息存储；遇到相同 ID 但内容不同则失败关闭。其后写 checkpoint 和 `checkpoint_written` durable event。缺少最后一个 durable event 的 checkpoint 不具备自动恢复资格。
- 新 Runner 从持久 Session 轨迹重建 Harness 请求上下文，并与 checkpoint 指纹逐组件比较；仅在 identity、工具目录、当前配置/权限、prompt 和 memory 上下文均匹配时启动 Harness。不能安全重建的旧 v1 checkpoint 仍可读取，但因没有安全边界标记不会自动重入。
- 从原 checkpoint 恢复 TaskBook/plan、分类、循环预算、已结算副作用、web evidence、失败恢复计数，并从 durable projection 延续 stage-transition 与 model-request 序号。已处理 ingress 不重新追加，原始 inbound 只通过持久 message ID 引用。
- Run-wide model-call、tool-call、loop-iteration、elapsed 和 no-progress 限制在资格检查中必须仍有余额；Segment 不能重置 Run 预算。Runtime event queue 必须无待处理事件。

### 恢复所有权与权限

- 自动恢复只接受仍为 running/execute、尚无 final reply、未终结、无 pending 或 unknown model/effect 的 checkpoint；同时要求唯一的原始 `run_accepted`、唯一且匹配 checkpoint inbound 的 `user_input_appended`，以及对应的 `checkpoint_written`。
- Runner 先取得原 Run 的独占 lease，再重新读取 checkpoint、event 和 projection 并重验资格；同一 lease 从资格复核持续持有到 Context 重建、Harness 执行及正常结算。
- DurableRunRecorder 有恢复专用初始化方式，不写 ingress。恢复期间不释放 lease 再另起执行。
- Run lease heartbeat 提供同步续租/所有权确认。每次 effect lease 获取和 settlement 确认前都重验 Run lease；旧 owner 在被接管后无法取得新的 effect lease。已运行中的副作用若 owner 丢失，仍按原 effect lease 及 unknown 结算规则处置，不由此宣称已完成强制 OS 进程隔离。
- Checkpoint 中不保存或恢复 `approve` 回调。恢复使用当前 Runner 的授权服务；受保护工具仍逐次经过 Tools 正常策略和审批。当前 host 权限及工作区边界以哈希参与 Context 比对；若无法重建出原来相同的权限上下文，Harness 在启动前失败关闭。当前 `recoverDurableRun` 不接收新的 per-run V2 policy snapshot，因此原 Run 使用此类 snapshot 而重启后无法由 Host 重建相同快照时会安全失败关闭；V2 Main policy 的真实 Electron 重新授权流程仍需后续接口与桌面验收确认。

### 不安全或不完整状态

缺失安全边界字段、旧 checkpoint、暂停/中断状态、预算耗尽、队列有积压、ingress 不唯一、Provider 回执未知、effect pending/unknown 或已存在终态事件，均不会进入自动 Harness 恢复。未知副作用仍按原 effect identity 阻断，不能用新 Segment 或新 Runtime identity 重试。原有 durable recovery 继续处理这些不满足安全重入条件的 Run。

## 验收证据

### T04-A 正向恢复

测试位于 `packages/runner/src/durable-runner-segment-recovery.test.ts`，子进程夹具位于 `packages/runner/src/durable-runner-segment-recovery-worker.test.ts`。

1. 子 Runner 使用独立临时 data root/workspace、受控 Provider 和真实 Runner/Harness；30 项通过内置 `write` 工具生成独立文件。
2. 测试包装 durable event store，在第二段 checkpoint 与 `checkpoint_written` 都落盘后等待父进程；父进程向真实 Node 子进程发送 `SIGKILL`，并确认退出信号。
3. 新 Runner 等待原 Run lease 过期，通过生产 `recoverDurableRun(sessionId, runId)` 接管同一个 Run。
4. 独立 Oracle 确认重启后第一条 Provider 请求含有 30 个旧工具结果；随后请求序列分别看到 30–35 个累计工具结果，最后回复完成。
5. Oracle 检查 35 个文件及内容、35 个不同且成功的 effect identity、无额外 Run ingress、model-request 序号不重复且延续到 30 之后、最终 projection/final reply 状态，以及 lease 两次取得后已释放。

**执行层级与差异：** 真正的子进程 `SIGKILL`、新 Runner、新 Harness、真实本地文件工具与生产恢复入口；Provider 为受控 fixture，Runner 的 `approve` 是本地测试中显式提供的 `async () => true`，不等同于 Electron Main 的审批 UI、真实 Provider 或公网行为。测试等待 lease 到期后才接管。

### 最小负向验收

- `durable-runner-segment-recovery-policy.test.ts`：17 项通过，覆盖有效边界及旧/不完整 checkpoint、pause/interruption、已取消/终结 Run、model/tool/Run-loop 预算耗尽、unknown/pending effect、pending 或 Provider reach unknown、缺少 checkpoint durable event、重复/不匹配 ingress、排队事件等失败关闭条件。
- `durable-run-lease-store.test.ts`：并发两 Runner 获取同一 Run lease 时只允许一个成功。
- `durable-run-ownership.test.ts`：模拟旧 lease 过期并被新 owner 接管；旧 Runner 在尝试获取新 effect lease 前同步重验失败，不会创建 effect lease。该验证覆盖 Runner lease/effect lease 边界，不模拟任意 OS 挂起后继续运行的硬件 fencing。
- 既有 `harness/src/stages/execute.test.ts` 覆盖 checkpoint 不可持久化时不执行 effect；既有 `tools/src/tool-execution-service.test.ts` 覆盖没有审批回调或审批不可用时 fail-closed、不执行工具。
- 原 T04-A 正向测试现在是普通通过测试，不再使用 `it.fails`。

## 测试与检查结果

本批实际通过：

- T04-A 真实子进程恢复：1/1；最终 35/35。
- T01/T02/T05 `runner-segments.test.ts`：3/3。T01 的 35 个 effectful 操作完成；测试断言按实际 loop-budget 口径更新为 37 个总 loop iteration（segment 2 为 7），因为 loop 预算记录的是执行循环轮次，不等同于文件副作用数量。
- RCD S0-F 六项核心回归：基础设施 6/6 executed、0 blocked、0 harness error；产品结果 3 passed、1 partially completed、2 correctly blocked。L01 仍部分完成；R02、X01 仍正确阻断。
- S1B-F Shell 重执行与恢复：9/9；S1B-F 完整受控 Shell replay 测试组通过。
- Runner effect/lease recovery、run recovery、checkpoint/store/controller、VRS 旧 VERIFY checkpoint 兼容、Harness side-effect ledger、model observability、Shell Authorization v2 与 ToolExecutionService 定向测试通过。
- `pnpm run typecheck`：通过。
- `pnpm --filter @littlesheep/runner build`、`pnpm --filter @littlesheep/harness build`：通过。
- `pnpm run check:repo`：通过，35 项通过、0 项失败、3 类 advisory；其中报告了既有大型文件和热点/拆分地图计数提示，不是本批硬失败。
- `git diff --check`：通过。

RCD 六项运行账本写入 `%TEMP%\rcd-s2b-core-2026-10-16.json`，不纳入仓库。

## 剩余限制与下一单元

- 本单元只恢复具有明确、已结算安全段边界的 Run。T04-B 两恢复者真实 Runner 竞争、T04-C Provider 请求发出后回执未知、T04-D effect 后结算前崩溃、T04-E final reply 回执丢失，以及 T05-R/T08-R 的全面重启控制与 usage 去重，仍留给 S2B-2 第三单元。
- 不证明真实 Electron 自动恢复启动、Main 审批 UI、真实付费 Provider 或外部副作用语义。
- Run lease 检查在每个新 effect lease 获取/确认前执行，配合 effect lease 防止合作式 Runtime 旧 owner 继续开始新副作用；跨进程存储尚未使用单一原子 fencing generation 同时保护 Run event append 和外部工具操作。异步 OS 暂停及已经启动的外部副作用仍应按 unknown 安全处理。
- S2C 的目标验收与最终交付结算未启动。

**本单元验收：T04-A 由目标失败转为真实通过；只证明受控安全段恢复。S2B/S2C 其余工作未开始或未完成。**
