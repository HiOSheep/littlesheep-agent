# RCD S2B-F — 持久恢复权限集成与阶段收口

- **日期：** 2026-10-16
- **分支：** `codex/rcd-s2b-continuity`
- **实现基线：** `aa19632b8232d738f5aaeeca143eaa6d82c63850`
- **Main 恢复权限集成提交：** `977915c8fa0f42251d192ca5eee217023b3e1293`
**验收状态：** 部分完成；真实 Electron 权限恢复验收被环境阻断，S2B 不得标记为全部完成。

## 结论

已接入 Main 当前 Permission V2 状态到同 Run 安全段恢复入口，并补上首次运行前的 Main SessionIndex 绑定。Runner 仍在取得原 Run 独占 lease、重读 checkpoint 并通过恢复资格检查后才解析授权；恢复仍使用原 Run ID、Session ID、原始 ingress 与累计预算。执行上下文指纹检查没有放宽。

Main 权限解析器单元测试、应用和 Runner 类型检查、Runner 构建、跨进程无进展恢复、RCD 六项核心场景及仓库检查通过。真实 `verify:desktop-permission-v2` 无法启动 Electron：构建过程卡在 `electron/install.js` 下载 Electron 44.4.5 二进制，最终返回 `fetch failed`。没有实际启动 Main 窗口，也没有完成真实 Main-owned 恢复授权的正向或负向验收。因此本次只交付可审查的实现与组件/Runner 级证据，**不宣称真实 Electron 权限恢复通过，也不宣称 S2B 全部完成**。

## Main → Runner 恢复授权路径

1. 新 App Run 在 Main 侧生成 Session ID，并由 `bindRunSessionPolicy` 在调用 Runner 前持久化 Permission V2 版本、预设、scope、project 和 workspace。避免首次运行在安全段 checkpoint 后崩溃时，Main 尚无可校验的原始 Session 权限归属。
2. Main 创建 Runner 时注入 `resolveRecoveryAuthorization`。恢复入口先通过原有 durable event/checkpoint 资格检查，取得 Run/Effect 所有权，并在所有权内再次检查 checkpoint 与事件投影，然后才调用 Main resolver。
3. Resolver 将 checkpoint 中的身份和路径当作待验证声明，重新查询当前 SessionIndex、ProjectIndex 与 Config；校验 Run/Session、App 来源、无附件、安全段边界、当前 V2 policy、项目版本和 workspace `realpath` 绑定。它用当前 Main 状态重新构建 Permission V2 snapshot、Memory grant 与 workspace context。
4. Runner 将原 Run、Session、输入消息和 checkpoint 交回既有 `executeRun`。原始 ingress 不会重新追加，预算和副作用身份沿用 checkpoint；已有 `executionContextFingerprint` 比对继续校验工具目录、配置、Prompt、Memory 和权限上下文。上下文不匹配时，在 Harness/工具执行前失败关闭。
5. Main 没有恢复期交互审批 broker，因此当前不可重建的审批会被拒绝。Shell repeat authorization 的消费端在恢复期间固定返回 false；checkpoint 不会恢复一次性 Shell 批准，也不会补发重复执行次数。普通 Tools 入口仍负责实际准入，没有特殊免审批执行路径。

首次 Session 绑定和 Main resolver 都有单元测试。Resolver 的测试确认缺少 Main Session authority、workspace 改变时拒绝，当前权限收窄会生成较窄的 snapshot；Runner 原有指纹检查仍会阻止与 checkpoint 不一致的上下文继续。由于 Electron 未能安装，本批没有证明上述 Main 组装在真实 Electron 生命周期内完成，也没有证明真实审批 UI 能在恢复时重新请求授权。

## 恢复支持范围

### 可自动恢复

- 已写入且可验证的安全 Execution Segment checkpoint。
- Run、Session、当前 Main 权限和 workspace/project 身份均可重建，并与原执行上下文兼容。
- Provider 与 Effect 没有未结算/unknown 状态，Run 仍未取消或暂停，预算和无进展限制仍允许继续。
- 依赖现有 Main 权限即可执行的后续工具调用；每次仍经过正常 Tools 策略。

### 保持阻断

- 旧 checkpoint 缺少安全段边界、原始 ingress 引用或完整执行上下文。
- Main 当前无法解析原 Session/Project 权限，授权已撤销，或 workspace、工具、Config、Prompt、Memory 权限指纹与原 checkpoint 不匹配。
- 恢复需要新的交互授权但审批 broker/UI 不可用。Shell 一次性及 process-local 重复授权不会恢复或续期。
- 用户取消、暂停、总预算耗尽、达到无进展上限，或 Effect/Provider 请求状态未知。
- Provider 已收到但响应正文/tool calls 未可靠持久化；Usage 记录不能代替响应内容，也不能拼接成模型回答。
- 旧格式、跨主机或进程身份不足以安全回收的 lease。PID 退出不能证明其启动的外部子进程已停止。

此范围不提供任意崩溃点续跑、不提供所有宿主 Shell 命令的 exactly-once 语义、不提供真实 Provider 请求无成本重放，也未验证跨主机接管、OS 沙箱或所有平台。

## 验收结果

| 项目 | 状态 | 证据与限制 |
|---|---|---|
| F01 Main-owned 权限重建 | 部分通过 | Main resolver 与首次 Session 绑定单测通过；Runner 接入保留 lease、checkpoint 重验和 execution-context fingerprint。没有真实 Electron Main 端到端证据。 |
| F02 Electron 正向恢复 | 阻断 | `pnpm run verify:desktop-permission-v2` 未能完成；Electron 44.4.5 安装下载失败（`fetch failed`），Main 窗口未启动。 |
| F02 权限负向矩阵 | 部分通过 | Main 单测覆盖缺少 Session authority、workspace 变化与权限收窄；既有 Runner/Shell 测试覆盖恢复资格、权限与 lease。撤销、一次性耗尽、过期重复授权、Memory 收窄和离线策略的真实 Electron 联合矩阵未完成。 |
| F03 跨进程无进展 | 通过（受控 Runner） | 子 Runner 在第 30 轮安全边界、累计 `noProgressRounds=1` 时被 `SIGKILL`。新 Runner 在原 Run 恢复；无进展状态进入提示；workspace 保持 28 个文件，没有重复写入。非 Electron Main 流程。 |
| F04 Provider 响应窗口 | 限制已冻结 | 响应状态和 Usage 不能恢复未持久化正文；该窗口继续 unknown/安全阻断，不新增响应正文存储。前一单元 T04-C 证据见第三单元报告。 |
| F05 旧数据/lease 边界 | 保守处理 | 旧格式/缺字段、跨主机及不完整进程身份继续拒绝自动接管；不以 PID 退出推断子进程已结束。 |
| F06 回归 | 部分通过 | 当前受影响的类型、构建、Runner 恢复、VRS 兼容、Tools/Shell 与 RCD 核心组通过；完整真实 Electron 验收未通过，因此阶段出门条件未满足。 |

## RCD 核心运行

`node scripts/rcd-s0.mjs run --core` 实际运行 6 项，临时资源全部清理；结果保持既有 Oracle：

| 场景 | 产品结果 | 执行证据 |
|---|---|---|
| C02 | passed | Harness Execute + 真实 `ToolExecutionService`；错误 Schema 输入 1 次、修正后成功执行 1 次、畸形参数无副作用。 |
| C08 | passed | Harness Execute + builtin exec；合法运行造成可观测输入变化；临时产物已清理。 |
| R01 | passed | Harness Execute + builtin Web Search + 本地 HTTP 适配器；没有公网请求。 |
| R02 | correctly_blocked | 网络禁用策略下拒绝 Web 调用；无公网请求。 |
| L01 | partially_completed | 真实主循环 + scripted Provider；因单段迭代预算耗尽停止，保留原 30/35 基线。 |
| X01 | correctly_blocked | 受控 post-effect/pre-settlement 异常；单次工具执行后状态为 unknown，不重放。它不是 OS 进程崩溃验证。 |

六项基础设施均为 `executed`，清理均成功；usage、token 和 cost 为 `unavailable`。此 RCD 适配器不是真实 Provider 下的用户任务完成率。

## 验证记录

- `pnpm run typecheck`：通过。
- `pnpm --filter @littlesheep/app run typecheck`：通过。
- `pnpm --filter @littlesheep/runner run typecheck`：通过。
- `pnpm --filter @littlesheep/runner run build`：通过。
- `pnpm run check:repo`：35 项通过、0 失败、3 条 advisory；TypeScript 项目引用 27/27 通过。Main `index.ts` 因恢复装配超过 600 行，已在模块拆分地图登记 610 行受控上限。
- `git diff --check`：通过。
- `node scripts/rcd-s0.mjs validate`：24 个场景定义与分类校验通过。
- `node scripts/rcd-s0.mjs run --core`：6 项实际执行，3 passed、1 partially_completed、2 correctly_blocked；账本 Run ID `rcd-s0b-1792147889827`，场景执行层级和证据在配套 JSON 中。
- Main Permission/Shell Authorization 定向组：6 个文件、51 个测试通过。
- Harness Execute/usage reconciliation：2 个文件、54 个测试通过。
- Runner recovery/VRS checkpoint/lease/usage 组：10 个文件、89 个测试通过；其中新跨进程无进展用例通过。
- T04-A 安全段进程恢复：真实子进程 `SIGKILL` 与新 Runner 接管，35/35；1 个测试通过。该 Runner fixture 使用受控执行环境，不等同于 Main-owned Electron 权限验收。
- 真实 Electron：未运行成功。`verify:desktop-permission-v2` 在 Electron 二进制安装下载阶段失败，不能记为通过。

此前 T04-B/C/D/E、S1B-F、S1C、VRS Evidence Settlement 与旧 checkpoint 兼容证据继续保留在 `rcd-s2b-2-third-unit-recovery-acceptance-2026-10-16.md`；本报告不覆盖该历史结果，也不把它们冒充为真实 Electron 授权验收。

## 提交与停止边界

本批只提交 Main-owned 恢复权限接入、首次 Session policy 绑定、对应测试、跨进程无进展验收及本报告/账本。未推送远端、未合并 main。由于真实 Electron F02 被阻断，S2B 的最终工程验收仍未完成；保留安全失败关闭行为。本批结束后停止，不启动 S2C。
