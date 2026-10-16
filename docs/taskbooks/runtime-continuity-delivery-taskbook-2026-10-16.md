# Runtime Continuity & Delivery（RCD）任务书 2026-10-16

日期：2026-10-16
状态：**24 项均经过执行器运行和清理，但 18 项仍是 Harness 组件探针且 Oracle 为 `unverified`；S0B 未通过；S1–S3 未开始。**

## 1. 目标与边界

本专项依据用户提供的 RCD 实施任务书，改善 LittleSheep 在工具输入纠错、恢复调用身份、任务内检索、长任务续接、成果验收和用户交付方面的可靠性。工作顺序为 S0 → S1 → S2 → S3。本批只实施 S0，不改变产品运行行为。

安全边界：不扩大 Shell 权限，不改变 Shell 隔离冻结，不绕过授权或取消，不自动重放未知副作用，不读取真实用户 Memory、外部账号或凭据，也不把模型自述当作验收证据。真实 Provider 实验需单独确认资源与成本上限后执行；本次没有启用付费模型。

工作流：阶段独立实施、验证和报告；保留已有工作树修改；不 reset、clean、stash、推送或改写历史。当前基线见 [S0 基线报告](../reference/rcd-s0-baseline-2026-10-16.md)。

## 2. 阶段计划

| 阶段 | 目标 | 本轮状态 |
|---|---|---|
| S0 | 盘点既有证据链，定义 24 个可独立判定任务，建立可追溯离线基线 | 24 项执行基础设施均 `executed` 且清理成功；6 项有原场景适配器，18 项仅组件探针并 `unverified`；S0B 出门条件未满足 |
| S1 | 修复确定未执行输入错误、新执行与恢复重放身份、动态检索判定、停止原因观测 | 未开始 |
| S2 | 在现有 Runner/Harness 上提供有界任务续接、任务验收状态和交付摘要 | 未开始 |
| S3 | 使用固定场景进行同环境对照并审查安全、效果和成本 | 未开始 |

## 3. S0 固定场景

机器可读场景集为 [`scripts/rcd-s0-scenarios.json`](../../scripts/rcd-s0-scenarios.json)，校验入口为 `node scripts/rcd-s0.mjs validate`。

| 类别 | 数量 | 覆盖范围 |
|---|---:|---|
| C · 编码 | 8 | 重复测试命令、参数纠错、跨模块修复、重构、类型修复、解析器边界、冲突解决 |
| F · 文件 | 4 | 创建、跨文件一致性、重命名引用、并发修改冲突 |
| R · 信息查证 | 4 | 中途查公开资料、禁止联网、敏感信息外发、页面提示注入 |
| L · 长任务 | 4 | 超过 30 轮、无进展、取消、授权后继续 |
| X · 恢复 | 4 | 未结算副作用、上下文压缩、暂停重启、未知结果核实 |

每个场景都包含任务输入、合成环境、工具及权限、独立 Oracle、可接受停止行为、禁止行为和重置说明。统一入口支持按 ID、类别和全部场景选择：`node scripts/rcd-s0.mjs run --id=C02`、`--category=C`、`--all`，可用 `--trials=N` 和 `--timeout-ms=N` 控制重复次数及超时。本批 `--all` 有 24 条实际执行记录；18 项只运行 Harness 组件探针，未完成冻结任务条件，结果明确为 `unverified`，不等同于场景评测闭环。逐场景账本与复跑稳定性见 [S0B 可执行基线 JSON](../reference/rcd-s0b-executable-baseline-2026-10-16.json)。S0 尚未完全验收。

评测 infrastructure 状态与产品 Oracle 结果分开统计。Infrastructure 使用 `executed | blocked | harness_error | not_run`；产品结果使用 `passed | failed | partially_completed | correctly_blocked | unverified`。正确拒绝/预期阻断不折入普通成功率。测试层级、模拟 Provider、工具错误/调用数、授权、停止原因、副作用证据、Oracle 引用、清理结果、usage/cost 可得性均写入逐次 JSON 记录；无真实 usage 时保持 `unavailable`。

## 4. 基线协议

- 每次批次绑定 HEAD、分支、源码/夹具/配置哈希、环境版本、任务输入哈希、权限配置引用和重复编号。
- 基线产物只保留路径、计数、哈希、状态、停止原因和证据引用；不复制 Prompt、工具输出、Memory、凭据或完整执行日志。
- token 使用量仅从 Provider 实际回执读取；无回执为 `unavailable`。无可靠价格表时费用为 `unavailable`。
- 离线确定性测试、本地 Runtime 端到端、真实 Provider 三层分别报告，不相互替代。
- 固定任务需使用外部 Oracle 检查结果；退出码为 0、模型自述或 Runtime 自身 `success` 均不足以证明目标完成。
- 批次预算、模型/协议、授权和停止条件在运行前冻结；本次真实 Provider 层为 `not_run`。

## 5. 后续工作

S0 后续为 18 项组件探针补齐真实场景夹具、逐场景 Oracle 与 teardown，并保留已发现的产品失败；不修改生产 Runtime 来配合基线。全部 24 项按原场景语义执行、重要项目复现稳定并保存逐次账本后，才关闭 S0。没有对应授权与成本上限时，真实 Provider 一栏继续标记未运行。只有 S0 验收通过后，才启动 S1。
