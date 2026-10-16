# RCD S1C — 动态信息检索与网络准入

**状态：** 动态准入实现并通过受控回归；私有自由文本的数据来源追踪和真实 Electron / Provider 验收仍未完成。
**基线：** 修复前确定性 Runtime 基线；本报告不代表真实 Provider 下的用户任务完成率。
**实现提交：** 见本文件末尾的提交记录。

## 调用链审计

1. 初始检索意图由 `packages/harness/src/retrieval-intent.ts` 根据首条用户文本/分类结果推断；它只描述任务开始时的证据需求。
2. Harness 请求沿用稳定的内置工具目录。模型看见 Web schema 不代表该次请求已获准执行。
3. 原先 `main-loop.ts` 将 Web 工具从 `admittedTools` 排除，`tool-loop.ts` 在调用 `ToolExecutionService` 前拒绝请求，因而模型在本地执行中产生的新公开查证需求不能进入 Web 权限校验路径。
4. 现在本地/记忆任务提出新 Web 请求时，工具循环只为本次请求临时增加 `web_search` / `web_fetch`，且必须同时满足：运行级网络策略启用、策略不是 disabled、工具已注册为 builtin、显式工具范围未排除 Web、可信用户消息未明确禁止联网。Shell、Memory 或其他工具集合不因此改变。
5. 动态请求仍走原 `ToolExecutionService`、内置 Web 工具及 `authorizeToolAccess`。Main 在 Runner 装配时从可信首条用户文本识别明确离线要求，并把本次 Run 的冻结网络策略设为 disabled；在执行时 Web 工具还检查网络策略、敏感查询策略、审批、Provider 配置、查询/目标与 Runtime 配额。
6. 内置 Web 工具和 `packages/web` Runtime 负责查询 schema、凭据/路径/明确私有内容标记、审批、目标/SSRF/重定向、响应大小、配额、超时和取消。网页结果带有 `externalUntrusted` 标记，不能成为网络授权来源；动态离线拒绝只检查可信入站与运行中用户事件，不从 Web 结果或模型文本重算。
7. 本阶段没有新建 Harness 循环或权限引擎。Web 请求失败保留稳定错误种类和实际 evidence 投影；取消沿 Run signal 传播。

## 改动与契约

- 在 `packages/harness/src/stages/execute/tool-loop.ts` 增加本轮、单工具的动态 Web 准入。仅真正注册的 builtin Web tool 可通过，且原有显式工具范围和网络策略仍是硬门槛。
- 在 `packages/harness/src/retrieval-intent.ts` 更新本地/Memory 意图说明：先取本地证据；执行中若缺少公开信息，可以提出 Web 请求，但请求不是授权，且不得把私有源内容放入公开查询。
- 在 `packages/runner/src/runner.ts` 与 `run-config.ts` 将可信用户的显式离线要求固化为本次 Run 的网络硬拒绝。工具 schema 可保持稳定可见，实际 Web 执行能力为零查询/零抓取配额，Provider 投影为 disabled。
- 在 `packages/safety/src/permission-boundary.ts` 增加对明确标注为 private/confidential/internal Memory、文件、文档、笔记、数据或内容的查询识别。既有凭据、Cookie 和本机路径识别继续生效；按 configured `sensitiveQueryPolicy` 进行 deny/approval/redact。
- 不改变 Shell 重复执行/恢复副作用账本，不修改 VERIFY 结算逻辑，不启用公网或付费 Provider。

## 结果

S1C 本地回归记录见 [机器可读账本](./rcd-s1c-core-regression-2026-10-16.json)。这是在当前工作树、脚本 Provider 和本地夹具上的执行记录，未覆盖实时 Electron、真实 Provider 或公网请求。

| 验收项 | 结果 | 证据 |
|---|---|---|
| R01 本地任务中途检索 | **passed** | Harness Execute；先执行本地发现，再提出 Web 请求；本地 HTTP 请求计数为 1；Web invocation 成功；返回夹具事实并进入 VERIFY。 |
| R02 明确禁止联网 | **correctly_blocked** | 允许联网的配对控制发送 1 次本地请求；禁止场景额外请求为 0。禁止请求在 Harness 准入边界被挡住，工具错误为 `tool_not_admitted`。 |
| C02 参数纠错 | **passed** | 同一 Run 内错误 Schema 提案 `validation_failed`、无副作用；修正提案成功；1 次实际工具执行。 |
| C08 合法 Shell 重执行 | **passed** | 保持既有两次相同命令和可信状态变化证据。 |
| L01 / X01 | **部分完成 / 正确阻断** | 预算仍为 30/35；受控异常注入后的 unknown effect 未被恢复重放。 |
| 六场景基础设施 | **6 executed / 0 blocked / 0 harness_error** | 详见账本逐场景 observation、清理及证据引用。 |

R02 的“正确阻断”结合配对允许控制和零外发计数判断，不是单凭所有 Web 请求都被禁止来宣称成功。

## 正向与负向覆盖

- 动态准入、固定模型目录、保持同一 Harness Run 和显式工具白名单收窄：`packages/harness/src/tool-catalog-stability.test.ts`。
- 首条用户明确离线、能力问题不误判为离线、检索意图更新：`packages/harness/src/retrieval-intent.test.ts`。
- 可信离线要求冻结本次 Run 的网络策略且 Provider 状态 disabled：`packages/runner/src/run-config.test.ts`。
- 假 API key、本地私有路径、明确标记的 Memory/文件私有内容在 Provider 请求前拦截；强制审批拒绝前零请求、批准后限定本次读取；Provider 故障无虚假成功；取消信号传递且没有隐式重试：`packages/tools/src/builtin/web-tools.test.ts`。
- 目标/网络策略决策和 Web Runtime 的 SSRF、配额、超时、取消回归由 Safety/Web 定向测试覆盖。
- 外部网页内容仍以 `externalUntrusted` 返回；工具目录中的外部内容不输入授权判定。网页内容作为不可信文本、而非用户权限指令的现有提示边界由 Harness retrieval-intent 测试覆盖。

## 数据外传边界与未完成事项

已验证的保护针对明确可识别的凭据格式、Cookie、文件系统路径以及查询中明确标记为私有/机密/内部的内容；查询进入 Provider 前受 configured policy 控制。**这不等同于通用私有文本的数据血缘追踪。** 如果模型把一段未标记的私有文件或 Memory 内容改写成看似普通的公开问题，当前 Runtime 没有跨模型上下文 taint/provenance 信息，不能保证仅靠字符串分类识别。该风险未由本次测试覆盖；在建立可信来源标记或要求更强用户授权前，不应把本阶段描述为对任意私有内容外传的完备防护。

用户在一次 Web 请求已经进入 Provider 后追加离线指令，只能在 Harness 下一安全边界阻止后续请求；当前冻结的 Run 网络策略不会因追加消息被改写，也没有专用的按请求网络策略撤销信号。Run 取消会通过现有 AbortSignal 取消活动请求。实际公网 Provider 的中途撤销行为未做 Electron 验收。

其他未覆盖项：无付费 Provider、无真实 Electron、无真实 OS/Provider 故障；受控 local HTTP 是 loopback 测试夹具；没有真实用户秘密参与测试。Usage/cost 不适用，报告保持 unavailable。

## 测试执行

- S1C 定向：retrieval intent、tool catalog、Runner run config、Web builtins、Safety permission boundary —— **85 tests passed**。
- RCD 六场景核心：**6 executed**；产品结果 3 passed、1 partially completed、2 correctly blocked；R01 passed，R02 correctly_blocked。
- S1B-F Shell invocation、Main authorization、effect recovery/leases，加 Web Runtime/provider/fetch regression —— **117 tests passed**。
- `pnpm run typecheck` —— 通过。
- `pnpm run check:repo` —— 通过：35 项通过、3 条 advisory、0 失败；TypeScript project references 检查通过（27 packages）。其中大型文件/拆分地图为既有 advisory。
- `git diff --check` —— 通过。

## 复现与提交

- 核心场景：`node scripts/rcd-s0.mjs run --core --output=docs/reference/rcd-s1c-core-regression-2026-10-16.json`
- S1C 和安全回归：`pnpm exec vitest run packages/harness/src/retrieval-intent.test.ts packages/harness/src/tool-catalog-stability.test.ts packages/runner/src/run-config.test.ts packages/tools/src/builtin/web-tools.test.ts packages/safety/src/permission-boundary.test.ts`
- Shell / Runner 恢复 / Web Runtime：使用本次会话最终记录的定向 Vitest 文件集（14 files / 117 tests）。
- 核心运行 Git HEAD：`4c942651ac1946259c4cc1b40c5af06619758917`。
- 核心执行账本记录的工作树指纹：`c312259ed31687630a6cce7ab996579e677d513a71e87b6b0c0d48c15f01b7ed`。此指纹在场景执行开始时采集，包含当时已有的 S1C 产物状态。
- 独立提交：`feat(rcd): admit runtime web retrieval safely`；提交哈希由交付记录给出。
