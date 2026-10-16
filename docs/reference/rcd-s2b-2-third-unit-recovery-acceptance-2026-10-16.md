# RCD S2B-2 第三单元：跨进程故障恢复与一致性验收

**日期：** 2026-10-16

**分支：** `codex/rcd-s2b-continuity`

**测试基线提交：** `c717c740d916a878fa99ffd443f88219c54aa9bb`
**前置实现提交：** `3177624b`（S2B-2 第二单元）

**本单元提交：** A `14e0e574`（跨进程 Run Lease）；B `a5407166`（Provider Usage 恢复）；C 提交包含本报告、账本及最终结算/无进展测试。

## 验收结论

本单元为真实 Runner 子进程崩溃后的并发接管、未结算 Provider 请求、未知工具副作用和最终回复结算补上了跨进程证据，并修复了一项恢复时丢失 `available` Usage 状态的问题。T04-A/B/D/E 的关键边界测试通过；T01/T02/T05、S0-F 六项核心场景、S1B-F 和 VRS 相关回归通过。

**S2B 整体仍不能标记为全部完成。** `recoverDurableRun` 当前没有可信的恢复期 per-run Permission V2 policy 注入协议；Provider 的 `model_response_received` 事件持久化用量和状态，不持久化模型响应正文。因而无法在旧 Run 缺少安全执行 Checkpoint 时重新授权或从单独的 Provider 响应事件继续执行。两种缺口均保持失败关闭，并作为真实 Electron 发布验收限制登记。

测试在 Windows x64、Node.js v26.4.0 上执行。HTTP Provider 测试只访问本机 loopback；所有模型都由受控夹具代替，没有调用真实付费 Provider 或公网服务。

## 生产改动

- Run Lease 新记录保存本机 hostname 和 Runner PID。过期 Lease 只有在同机旧 PID 已不存在时才能被接管；仍存活、跨主机或旧格式中缺少进程身份的 Lease 均阻止自动接管。PID 被重用只会导致保守阻断。当前所有权令牌仍由文件锁和原有 Run/Effect Lease 保护。
- Lease 所有者即使因调度暂停错过 TTL，也可在令牌、主机和 PID 均匹配时续租。接管后的旧令牌仍不能续租、释放或取得新的 Effect Lease。
- Durable Kernel 现在会保留 `model_response_received` 中的 `usageStatus: available`。之前 reducer 只复制 `unavailable` 和 `unknown`，导致已持久化的 Usage 在恢复投影中被降级。
- Runner README 记录本机进程身份回收规则和它的边界。此机制不会终止 Runner 已经启动的外部子进程，也不宣称宿主 Shell 有 exactly-once 语义。

未修改恢复资格以放宽权限或未知副作用保护，没有更换逻辑 Run ID、重放 ingress 或重置预算。

## 跨进程故障窗口

| 用例 | 结果 | 实际证据 |
|---|---|---|
| T04-A 安全段恢复 | 通过 | 真实子进程在第 30 项安全段边界收到 `SIGKILL`；新 Runner 恢复原 Run 并完成 35/35。文件恰好 35 个、Effect ID 唯一、原始 ingress 一次、最终完成事件一次。 |
| T04-B 并发接管 | 通过 | 两个独立 Runner 进程通过 barrier 同时争抢同一 Run；只有一个进程调用 Provider 并完成剩余 5 项，另一个未启动 Harness。Lease 在完成后释放。活着但过期的原 owner 不可被接管；因此不存在“先转移给新 owner、再让旧进程继续”的可执行窗口。 |
| T04-C1 请求尚未发送 | 安全阻断 | 故障夹具能证明 HTTP 请求数为零，但 durable Run 记录无法证明进程是在发送前死亡。恢复把该 Provider 请求标为 `unknown` 并进入 `waiting_user`，不重发。系统尚不能把“明确未发送”状态持久化后自动续接。 |
| T04-C2 请求已发出、无响应 | 正确阻断 | loopback HTTP 服务收到 1 次 POST 后不返回响应；旧 Runner 收到 `SIGKILL`。恢复记录 Provider reach 和 Usage 为 `unknown`，不再发送请求。 |
| T04-C3 HTTP 响应到达但未交给 Runtime | 正确阻断 | loopback 服务返回带 Usage 的 JSON；测试适配器确认响应已到达并解析后，在返回 Harness 前暂停，旧进程被 `SIGKILL`。durable 状态没有响应结算，恢复保持 `unknown`，网络请求仍为 1 次。 |
| T04-C4 响应与 Usage 已持久化 | 部分通过 | Durable Event Store 重开后，Provider receipt 去重，Usage `20/5/25` 保持 `available`，Kernel 只生成一次结算事件且不重复模型调用。该事件不包含响应正文；若安全 Checkpoint 尚未保存上下文，恢复会等待用户，不能从 Usage 事件还原模型回答。 |
| T04-D 未结算文件副作用 | 通过 | 现有真实子进程测试在文件写入后、Effect 结算前 `SIGKILL`。新 Runner 将 Effect 标为 `unknown`，保留文件内容，不重新调用工具；后续恢复也不重放。S1B-F 对相同操作使用新 callId 仍保持阻断。 |
| T04-D 已结算副作用 | 通过（非 OS 故障窗口） | S1B-F B03 在 Runner 重开后两次恢复，Effect ID 和成功结算保持不变，工具没有再次执行。Effect 结算后回执丢失另有 Runner 幂等恢复测试；该回执窗口使用受控异常，不是进程终止。 |
| T04-E 最终回复 | 通过（逻辑结算） | 新增真实子进程测试：Runner 完成并持久化 final reply 和 `run_completed` 后、调用方拿到结果前 `SIGKILL`。恢复返回相同 final reply，LLM 不再调用，`final_reply_settled` 与 `run_completed` 各一条。另有 durable event / reply registry 写入后丢失确认的异常注入测试。 |

客户端在网络层是否只收到一次消息仍无端到端确认协议，因此只保证 durable 逻辑结果不重复结算，不宣称物理投递 exactly-once。

## 控制、权限、预算与进展状态

- T05-R 控制面：同 Run 自动恢复策略拒绝 paused、interrupted/cancelled、排队 Runtime 消息、未处理 ingress、预算耗尽、未知副作用、未结算 Effect 和 Provider 请求。T04-A 恢复保留原 Run 和 ingress 游标，没有再次追加原始输入。
- 当前权限：Shell one-shot、精确重复授权范围、拒绝、取消及未知 Effect 回归通过。网络禁止的 R02 仍为正确阻断；恢复策略不会通过新 Segment 或 callId 扩权。
- 未关闭的权限缺口：真实 Main-owned Permission V2 snapshot 不会随 `recoverDurableRun` 传入。暂停后 Shell 授权到期/环境指纹改变，以及 Web、Memory 授权撤销，尚未在恢复执行路径中完成真实 Electron 端到端重验。当前安全行为是阻断需授权的自动恢复，不复用 checkpoint 中的旧授权。
- T08-R Usage：运行中的已报告 Usage、Provider 物理回执去重、重开 durable store 后的 `available` 状态和多次恢复幂等通过。没有可靠回执的请求保持 `unknown`；没有真实 Provider 账单、真实 token 回执的场景仍为 unavailable，未伪造费用或 token 数。
- T03-R 无进展：增加恢复资格测试，证明 `noProgressRounds` 达上限时安全段不符合自动续接资格；Harness checkpoint 恢复仍会在无进展 latch 关闭时拒绝工具。跨真实 OS 重启后持续重复无进展直到终止的完整进程级测试未完成，标记部分完成。

## 回归结果

### S2B 与 Runner/Harness

- T01：真实 Runner/Harness 受控 Provider，单段 30 次边界后同一 Run 续接至 35/35；无重复 Effect。
- T02：新 Segment 不重置 Run 总工具预算。
- T05：段间取消在下一次 Provider 调用前生效。
- T04-A/B：真实 `SIGKILL` 和两个竞争 Runner 子进程均通过。
- T04-C：三个受控 HTTP 故障位置均通过安全阻断；已持久化 Usage 去重通过，但从单独响应事件恢复正文仍不支持。
- T04-D：真实 Effect 崩溃 unknown/no-replay 通过；已结算回执 lost-ack 由异常注入覆盖。
- T04-E：真实进程终止后的唯一逻辑完成结算通过；客户端物理送达不作为 exactly-once 声明。
- T03-R：资格拒绝与 Harness latch 测试通过；全程 OS 重启稳定性仍未验证。

### RCD 与既有专项

- S0-F 六项在本工作树重跑：C02 passed、C08 passed、R01 passed、R02 correctly_blocked、L01 partially_completed、X01 correctly_blocked。L01 保留原预算结果；X01 仍是受控异常注入而非 OS 崩溃。
- S1B-F B01–B05、F02/F03/F05/F06 与 Shell Main/Tools 权限测试通过；一次性授权和未知副作用保护没有退化。
- S1C retrieval intent、工具目录、loopback Web Runtime、离线策略和权限边界相关测试通过；没有调用公网。
- VRS Evidence Settlement、RECOVER、旧 VERIFY checkpoint、Runner checkpoint/store/controller/disposition 测试通过。

## 验证命令

- `pnpm run typecheck`：通过。
- `pnpm --filter @littlesheep/runner --filter @littlesheep/harness run build`：通过。
- `pnpm run check:repo`：35 项通过、0 失败、3 条现存 advisory；TypeScript 项目引用 27/27 通过。
- `node scripts/rcd-s0.mjs validate`：24 个场景定义和类别计数通过。
- `node scripts/rcd-s0.mjs run --core`：6 项均实际执行；3 passed、1 partially_completed、2 correctly_blocked。
- S1B-F 直接定向 Vitest 命令：11 个测试文件、82 个测试通过。
- Runner/Harness/VRS 定向组：11 个测试文件、112 个测试通过；另一个 Runner continuation / checkpoint / execute 组 3 个文件、82 个测试通过；VRS settlement/recover/checkpoint 组 5 个文件、67 个测试通过。
- RCD 检索/权限组：8 个文件、107 个测试通过。
- T04-C Provider HTTP 进程故障组：3 个真实子进程崩溃测试通过。
- T04-E final settlement：1 个真实子进程崩溃测试通过。
- `git diff --check`：通过。

测试并非全仓全量测试；没有运行真实 Electron Main/Renderer 授权恢复验收、真实外部 Provider、付费账单、公开网络或 OS Shell 隔离测试。

## S2B 最终门槛状态

**本第三单元：跨进程安全恢复的核心故障证据已建立。S2B 全部出门条件：仍未满足。** 完成总体预算和 safe segment 自动恢复并不意味着可在所有 Checkpoint 恢复。恢复需要可验证的 Main 权限协议；尚无响应正文的恢复存储契约；跨 OS 重启的无进展完整进程测试和真实 Electron 授权回归仍待补足。现有保守阻断必须保留，直到这些接口和证据补齐。

本单元结束后停止，不进入 S2C；未推送远端，也未合并 main。
