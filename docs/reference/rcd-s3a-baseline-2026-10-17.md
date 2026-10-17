# RCD S3A — 真实任务评测基线

**日期：** 2026-10-17
**冻结产品提交：** `d5015136ca9cf9583423361263b5bacba257a385`
**范围：** 评测协议、24 项 RCD 场景审计、12 项代表任务定义、4 项受控 Runner/Harness 试跑及 Electron S2C-E 复核。

## 结论

S3A 建立了可重放的确定性评测层，分别记录评测基础设施状态和任务外部 Oracle 结果。冻结产品源码未修改；评测脚本、任务定义、Oracle 适配器和报告作为独立评测覆盖层记录指纹。

本批没有运行真实模型 Provider，也没有进行 Agent 产品对照。受控 Provider 结果只说明对应工具与 Runtime 路径在固定输入下的表现，不能解释为开放式用户任务完成率。

## 固定版本与环境

- 产品 HEAD：`d5015136ca9cf9583423361263b5bacba257a385`。
- 冻结产品 tree：`e3026c491fab73d3c863efcd0a84059bab5f7894`。
- 锁文件 SHA-256：`da61e379b2ec7d84811c9d913b33e40c201dac2e4ff130e3207f98a61efb7e9b`。
- 环境：Windows 10 build `10.0.26200` x64、Node `v26.4.0`、pnpm `11.9.0`、Electron `44.4.5`（S2C-E Electron 复核）。
- 干净产品树校验与评测覆盖层运行分别记账，不混用工作树指纹。任务账本记录产品 HEAD/tree、评测器输入指纹、运行工作树指纹、任务定义哈希和配置哈希。

Electron 下载最初失败。复用的 Electron 44.4.5 缓存压缩包与该版本包内 `checksums.json` 的 SHA-256 匹配，解压到隔离评测工作树的忽略目录后，实际二进制报告 `v44.4.5`；未关闭 TLS 校验。构建钩子曾将桌面快捷方式指向隔离工作树，随后已从主工作区恢复并核实目标为 `D:\Repositories\littlesheep\scripts\launch-littlesheep.vbs`。

## 24 项既有 RCD 场景

审计覆盖全部 24 个定义：6 项具有场景专用 Runner/Harness 路径和外部 Oracle；其余 18 项只有通用组件探针或定义，没有完整场景触发与独立场景验收，继续标为 `unverified`。24 项适配器都使用模拟 Provider。场景定义或组件探针通过不等于用户任务成功。

在干净 `d5015136` 产品提交的独立工作树中，六项冻结核心复跑结果如下。基础设施 6/6 实际执行、清理 6/6 成功，没有环境阻断或 Harness 错误：

| 场景 | 本次 Oracle 结果 | 含义 |
|---|---|---|
| C02 | `passed` | 修复后的参数纠错路径通过；历史 S0-F 的 `failed` 记录保留。 |
| C08 | `passed` | 原冻结语义保持通过。 |
| R01 | `passed` | S1C 后的受控中途检索路径通过；历史 S0-F 的 `failed` 记录保留。 |
| R02 | `correctly_blocked` | 禁网策略正确阻断，不计作用户目标成功。 |
| L01 | `partially_completed` | 原配置仍在 30/35 边界停止；未改写历史基线。 |
| X01 | `correctly_blocked` | unknown 副作用按原契约阻断；属于受控异常注入，不是 OS 进程崩溃证明。 |

## 首批 12 项代表任务

任务集保持要求的分布：代码理解与修改 3 项、文件创建与批处理 2 项、本地工作中途查证 2 项、长任务与恢复 2 项、纠错与可靠交付 2 项、多要求组合 1 项。每个定义都包含原始用户输入、合成初始状态、工具与权限范围、Oracle、失败/部分完成条件、清理和安全限制。

当前有实际适配器的 4 项经 Runner/Harness/Tools 与独立 Oracle 执行。另 8 项保持 `not_run`，未用组件测试替代端到端结果。

| 任务 | Oracle 结果 | 执行摘要 |
|---|---|---|
| CODE-01 | `passed` | 修改临时模块；独立 Node 进程导入并检查导出函数。3 次脚本模型请求、2 次工具调用，约 18.4 秒。 |
| FILE-02 | `passed` | 读取合成 CSV 并写 JSON；独立读取磁盘结果，检查聚合值、排序和文件集。3 次模型请求、2 次工具调用，约 16.7 秒。 |
| DELIV-01 | `passed` | 参数错误后在同一执行中修正；外部检查确认结果文件和工具记录。3 次模型请求、2 次工具调用，约 14.2 秒。 |
| MULTI-01 | `partially_completed` | 两项要求分别检查，一项通过、一项未满足；Oracle 正确判定部分完成。5 次模型请求、4 次工具调用，约 18.7 秒。 |

汇总：评测基础设施 `executed=4`、`blocked=0`、`harness_error=0`、`not_run=8`；产品 Oracle 结果为通过 3、部分完成 1、失败 0、正确阻断 0、未验证 0。四项 Oracle 评测检查均成功执行。总运行时间约 67.9 秒；受控 Provider 脚本请求共 14 次、工具调用提议共 10 次。部分适配器没有提供可信的实际工具执行次数，因此对应字段为空。

四项使用固定脚本 Provider 和独立临时工作区，临时资源清理均成功。Provider 物理 token、缓存 token 和成本均为 `unavailable`，不是零；脚本请求数不是 Provider 账单用量。没有真实 Provider 请求，也没有推算 token 或费用。

## Electron S2C-E 复核

在隔离工作树对 S2C-E 主要产物检查和 Renderer 历史回放进行了真实 Electron 44.4.5 复核。执行层级为 Electron Renderer + Main/Runner + 本地受控 HTTP Provider + 实际工作区 Tools，不是单独组件测试。四个文件场景覆盖正确内容、错误内容、没有独立检查、两项要求的部分结果，共 8 项可见行为断言通过，包括历史重载不重复生成 Outcome 卡片、普通聊天不显示空任务卡片。

此结果证明受控 Provider 下的产品链路和 Renderer 消费行为。交互由 CDP DOM 事件驱动，没有验收原生鼠标或辅助技术；不代表真实模型质量。临时报告与截图保存在系统临时目录，不进入仓库。逐项摘要、校验和及 Electron 来源证据见桌面验收账本。

## 指标与失败分类

机器 Schema 将产品任务结果、评测基础设施状态、Oracle 检查状态分别记录；还定义要求通过率、未验证要求数、产物、虚假完成声明、模型物理请求、工具提议与执行、时间、压缩/续接、用户审批和继续输入、恢复与安全事件，以及主要/次要失败分类。

当前四项受控运行中没有任务失败，因此没有产品失败原因可统计。对没有可靠来源的物理 Provider 用量、成本、恢复异常及部分执行指标保持 `unavailable` 或空值，不根据模型消息推断。完整口径和失败类别见协议及 JSON Schema。

## 可复现入口

在评测工作树中安装冻结依赖并构建所需 workspace 包后运行：

```powershell
node scripts/s3a-eval.mjs --suite
node scripts/s3a-eval.mjs --audit
node scripts/s3a-eval.mjs --run
node scripts/s3a-eval.mjs --task=CODE-01
node scripts/rcd-s0.mjs run --core --trials=1 --output=<独立临时账本路径>
pnpm run verify:task-outcome-renderer
```

`--suite` 只验证 12 项定义；`--audit` 只盘点 24 项 RCD 场景；`--run` 仅执行当前 4 个受控适配器。默认账本会更新，保留历史时应使用独立输出路径或归档结果。评测输入指纹覆盖协议、指标 Schema、任务定义、适配器和 Runner 脚本；生成账本和报告不参与自身指纹，避免重复运行造成自引用漂移。

## 未完成与边界

- 8 项代表任务没有适配器，保持 `not_run`。
- 24 项 RCD 中 18 项仍缺少完整场景执行和独立 Oracle。
- 真实模型层 B 未运行；没有据此测量开放任务完成率、真实物理 usage 或成本。
- Agent 产品对照层 C 未启动。
- 本批没有修改产品 Runtime 源码、VRS、S2B 或 S2C 生产语义。
- 宿主 Shell 不等于 OS 沙箱；loopback 网络夹具不证明公网或真实账号路径。

## 账本与协议

- [机器可读任务基线](rcd-s3a-baseline-2026-10-17.json)
- [24 项 RCD 场景可执行性审计](rcd-s3a-scenario-audit-2026-10-17.json)
- [干净提交六项核心复跑](rcd-s3a-clean-core-baseline-2026-10-17.json)
- [Electron S2C-E 桌面验收](rcd-s3a-desktop-acceptance-2026-10-17.json)
- [12 项代表任务定义](rcd-s3a-task-suite-2026-10-17.json)
- [指标 Schema](rcd-s3a-metrics-schema-2026-10-17.json)
- [评测协议](rcd-s3a-evaluation-protocol-2026-10-17.md)
