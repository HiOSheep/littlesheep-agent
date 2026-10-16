# LS RCD S2B-G — Electron 验收与阶段收口

**日期：** 2026-10-16 · **分支：** `codex/rcd-s2b-continuity` · **基线提交：** `d9ae23d8101fdec1f9c865bccd18644acc759bfa`
**验收结论：** **A — S2B 工程验收通过**（范围限于下文列出的安全 Segment checkpoint 恢复路径）

## 结论

Windows 上的真实 Electron 44.4.5 Main、Local App API、Runner、Harness 和 Main-owned Permission V2 完成了同一 Run 的跨进程恢复验收。Run 在第二段安全 checkpoint 写入后被真实终止；新 Electron Main 接管原 Run，继续完成 35 项受控文件任务。独立 Oracle 确认原 Run/Session 身份、35 个唯一副作用、单一 ingress、累计预算及一次最终结算均保持连续。

另以真实 Electron Renderer 完成 Permission V2 桌面验收。该测试覆盖权限选择、审批与拒绝、工作区写入边界、降权后恢复，以及恢复后的 Shell 调用重新要求用户决策。它与 35 项自动恢复测试是两条不同的验收路径：35 项恢复流程通过 Main/API/Runner/Harness，未交互 Renderer。

因此本报告通过的是 **安全段边界恢复**，不是任意崩溃点恢复，也不是任意外部 Shell 副作用的 exactly-once 保证。

## Electron 环境

- `packages/app/package.json` 声明 Electron `^44.0.0`；`pnpm-lock.yaml` 固定解析到 `44.4.5`。未发现版本解析不一致或验收脚本路径配置错误。
- 找到版本匹配的 Electron 官方发布 ZIP 缓存，SHA-256 为 `11c395820a5aaa8ebcc0686b476d0ac98a730274ebfbdc8cf5538a7c2815cb5d`，与已验证的发布校验值一致。
- 通过该校验后的归档恢复 Electron 包内二进制；未关闭 TLS 校验、未更改 Electron 版本，也未使用模拟 Electron。
- `pnpm run ensure:app-build` 成功，Electron 44.4.5 桌面构建新鲜；两个真实 Electron 验收脚本均成功启动 Main。
- 原始下载失败的底层网络子因（代理、DNS、TLS 或瞬时下载源错误）没有可复现的保留诊断记录，故不将其归因于某一具体项。可确认的是依赖版本正确、可信归档校验通过、恢复后的构建和真实启动均成功。

## G02：真实 Electron Main / Runner 自动恢复

执行入口：`node scripts/verify-electron-s2b-recovery.mjs --keep`。

| 检查项 | 运行证据 |
|---|---|
| 执行层级 | 真实 Electron Main + Local App API + Runner + Harness + 本地受控 OpenAI-compatible HTTP Provider；此流程没有 Renderer 交互 |
| 故障点 | 在 Main 检查到 `execution-segment-started` checkpoint 已持久化、段号 2、累计 30 次循环时暂停；立即终止 Electron 进程树 |
| Run / Session | Run `conversation-run-5f0a102fc97a8fb2fe041ba5fe9b20ac3dbd40903d653d5ff8160b4d9bf16e81`；Session `63d2a19d-6f6c-42ce-8dde-a55e5a240578`；重启后身份一致 |
| 预算 | 每段 30 次循环；Run 总循环 60；显式 Run 总模型调用预算 64、工具调用预算 64。恢复前计数 30，最终模型尝试 35、工具调用 35，未重置 |
| 副作用 | 故障前 30 个文件；恢复后恰好 35 个编号文件、35 个唯一工具调用 ID；没有重放前 30 项 |
| ingress | 原用户 ingress 匹配数为 1；没有重新注入原始输入 |
| Provider / Usage | 36 次本地夹具请求，合成 usage 2304 prompt / 576 completion tokens；没有公网请求、真实付费 Provider 或真实费用数据 |
| 最终结算 | 最终回复 `settled`；durable `run_completed` 事件恰好 1 次 |

Provider 是确定性受控夹具，只提供可重复的工具调用序列；文件操作仍经过真实 Runner/Harness 与 Main 权限边界。合成 usage 只证明记录和恢复的连续性，不代表真实 Provider 计费或用户任务成功率。

## G03：Permission V2 正向与负向证据

### 真实 Electron Renderer 验收

执行入口：`node scripts/verify-desktop-permission-v2.mjs --keep`。本次结果 `ok: true`，27 条断言通过，38 次本地 Provider 请求。

- 实际 Renderer 显示 read-only / workspace-write / full-access 权限状态，用户审批保持可见且可拒绝。
- Main 对工作区写入、越界写入、过期文件观察和受保护源码实施边界检查。
- Shell 请求显示宿主执行风险并要求精确授权；精确重复执行遵循当前批准范围。降权后，旧重复授权失效；恢复后的 Shell 调用要求新的宿主决策，拒绝后不执行。
- Renderer 停止动作产生可恢复 checkpoint；重启后使用当前降权的只读策略，并重新请求 Shell 决策。

Renderer 测试中的恢复是既有受支持的 `waiting_user` checkpoint 路径，不等同于 G02 的安全 Segment 自动续接路径。

### Main / Runner 恢复拒绝与安全门

- `run-recovery-authorization.test.ts` 验证 Main 从当前 Session/Project 索引和当前配置重建授权；缺失 Main Session/Project 权威服务、Session 工作区改变、Run/Session checkpoint 身份不匹配和 Project workspace 重新绑定均失败关闭。
- 当前 Session 被降至 read-only 时，Main 重建出的 Permission V2 也为 read-only。恢复授权的 `approve(exec, ...)` 在无交互审批 broker 时返回拒绝。Main 不复用 checkpoint 内旧授权对象；恢复装配将 Shell 重复授权消费函数固定为拒绝，因此进程内的一次性或重复授权不会因 Runner 重启而重新发放。
- `durable-runner-segment-recovery-policy.test.ts` 的 18 项检查覆盖不完整/旧 checkpoint、暂停/中断、取消状态、模型/工具/Run 总预算和无进展额度耗尽、未知或未结算副作用、未结算/未知 Provider 请求、checkpoint 事件缺失、重复 ingress、原始输入不匹配、待处理 Runtime 事件和已终结 Run；非安全条件均拒绝自动续接。
- `memory-access-host.test.ts` 与 Host→Runner→MemoryService v2/v3 集成测试确认 Memory grant 由当前 Session/Project 身份重新生成；项目移除、重绑定或 Session 所有权改变会令旧上下文失效，未登记身份不会获得 Project Memory 读取权。应用没有与 Permission V2 preset 等价的独立“Memory 权限档位”；本验收证明当前 Host 所有权边界延续，不宣称完成所有 Memory 内容来源的端到端审计。
- R02 网络配对夹具验证显式允许的本地查询发出 1 个 loopback 请求；相同执行路径在用户禁止联网时为 Web 工具拒绝且请求数为 0。此项是 Harness/Tools 层受控网络验收，不是公网或真实 Provider 验收。

测试层级有区分：G02 是真实 Electron Main/Runner 自动恢复；桌面 Permission V2 是真实 Renderer + Main/Runner；恢复身份、暂停/取消、预算、unknown 和 Provider crash window 的负向覆盖由 Main/Runner 定向测试完成。没有将单元测试描述为 Renderer 操作。

## RCD 核心回归

执行器校验 24 个场景定义通过，场景集合 SHA-256：`7f36e4f399b3c752b6b73621c63676f2c4af39e3643cadc4b8c186d7e5d1c940`。本次运行仅执行冻结的六项核心回归，六项基础设施均为 `executed`，清理均成功：

| 场景 | 结果 | 关键证据 |
|---|---|---|
| C02 | passed | 2 次工具调用：一次结构化 Schema 校验失败、无副作用；修正提案成功执行 1 次 |
| C08 | passed | 冻结 Oracle 通过；不将其解释为“相同 Shell 命令不能合法重执行” |
| R01 | passed | 本地发现后提出 Web 查询；只访问 loopback fixture，1 次请求 |
| R02 | correctly_blocked | 允许查询对照 1 次请求；用户禁网分支 0 次请求，Runtime 拒绝工具准入 |
| L01 | partially_completed | 30/35，停止原因 `single_segment_iteration_budget_exhausted`；与新 T01 结果分开记录 |
| X01 | correctly_blocked | 文件副作用发生后通过受控异常注入使结算为 `unknown`，恢复未重放；这不是 OS 进程崩溃测试 |

机器账本：[rcd-s2b-g-core-regression-2026-10-16.json](rcd-s2b-g-core-regression-2026-10-16.json)。其中 Provider usage/cost 对六个 RCD 场景均为 unavailable，不虚构用量。

## 回归命令与结果

- `node scripts/rcd-s0.mjs validate` — 24 项场景定义通过。
- `node scripts/rcd-s0.mjs run --core --output=docs/reference/rcd-s2b-g-core-regression-2026-10-16.json` — 6 项执行，3 passed、1 partially completed、2 correctly blocked；0 blocked、0 harness error、0 未运行。
- S2B Runner 恢复定向集：13 个测试文件、99 项测试通过，覆盖段预算、跨进程恢复、并发恢复、无进展、Provider 请求故障窗口、Effect、最终回执、VRS checkpoint 兼容、Usage 去重及 Main 授权 resolver。
- S1B-F / S1C / Shell 与 Web 定向集：9 个测试文件、116 项测试通过，覆盖 Shell 授权、重复执行、网络策略、工具准入、取消/Runner checkpoint 和 Usage 记录。
- 额外 Main / Memory / 恢复组：29 项通过、1 个 worker helper 文件按设计跳过；包括真实子进程 Segment 恢复、无进展跨进程恢复、Main Permission resolver、Memory Host→Runner 的 v2/v3 集成与 18 项恢复资格检查。
- 真实 Electron S2B-G 自动恢复 — 通过；真实 Renderer Permission V2 — 27 条断言通过。
- `pnpm run ensure:app-build` — 通过，构建新鲜。
- `pnpm run typecheck` — 通过。
- `pnpm run check:repo` — 35 项硬检查通过、0 失败；3 组既有架构规模/拆分地图提示为 advisory。
- `git diff --check` — 通过。

## 冻结的恢复范围

**自动恢复支持：** 同一 Run 的有界跨段执行；具有完整且可验证执行上下文的安全 Segment checkpoint；由当前 Main Session/Project/配置重新构建的 Permission V2 与 Memory Host grant；预算、ingress、Effect 身份和结算证据连续；当前 Runner 独占 lease；已可靠结算的结果以及幂等最终回执。

**自动恢复不支持，必须等待、人工处理或安全停止：** Provider 请求已发送但结果未知；已收到但正文未可靠持久化的响应；未知的不透明外部副作用；缺少安全 Segment 元数据的旧 checkpoint；Session、Project、workspace、Context 或当前策略无法一致重建；需要交互审批但当前审批 broker 不可用；跨主机接管；宿主 Shell 子进程的完整隔离和 exactly-once 执行。

恢复能力不跨越用户取消、暂停、预算耗尽、无进展上限、拒绝授权、失效的精确 Shell grant 或禁止联网策略。自动续接不会发放新的 Shell/Web/Memory 权限。

## VRS 关系与最小集成顺序

当前 HEAD 的祖先包含 VRS V2B Evidence Settlement 提交 `28667f84`；S2B 基于该迁移后的 Runner/Harness 结算边界实现，未复制独立 VERIFY Stage，也未再次应用 VRS 迁移。

本次没有合并或推送。后续集成前先确认目标分支包含 `28667f84`，再比较 VRS 与 S2B 从共同祖先之后各自的提交；若目标已含 VRS，仅集成 S2B 后续提交。冲突处理以 VRS 的 EXECUTE 可信证据结算为单一结算边界，并保留 S2B 的 Run lease、Segment checkpoint 与预算连续性；不得恢复已移除的独立 VERIFY Stage。

## 未纳入本次产品验收的限制

- 未使用真实付费 Provider；36 次 Provider 请求和 usage 均为本地确定性 fixture。
- G02 的 35 项流程未驱动 Renderer；Renderer 由独立 Permission V2 验收证明。
- 没有验证任意指令点或每个崩溃窗口都可以自动继续；未结算 Provider/Effect 窗口保持阻断。
- 未证明跨主机恢复、所有 Windows 关闭/重启变体、POSIX 平台行为、OS 级 Shell 隔离或所有外部命令 exactly-once。
- Electron 二进制下载失败的网络底层子因缺少保留诊断；恢复使用的是 SHA-256 已校验的官方版本归档。
- 通用可见窗口连续性脚本因测试窗口停放在屏幕外而未作为产品验收证据；本报告只计入实际通过的 Main/Runner 恢复与独立 Renderer Permission V2 验收。

本批完成后停止；未启动 S2C 或 S3。
