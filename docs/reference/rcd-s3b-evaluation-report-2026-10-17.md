# RCD S3B 真实模型评测与失败归因报告

**结论：** 受控评测链路已建立并完成 8 项运行；真实模型试跑仍为 `real_provider_pending`，因此 S3B 真实模型验收尚未完成。没有发起真实 Provider 请求。

## 冻结版本与实现提交

评测目标产品版本为 S3A 冻结提交 `d5015136ca9cf9583423361263b5bacba257a385`。评测工作位于隔离分支 `codex/s3b-real-model-evaluation`，产品源码未修改；受控记录标记 `productSourceDirty=false`，并保留提交和工作树指纹。S3A 的 12 项任务定义及原 Oracle 未改动，任务集 SHA-256 为 `b210e505c89a8c795fbae62693295cd2527a50d04c355e6e9c43dd7e54a629ec`。

实现按范围提交：

- S3B-1 计量和预检：`6694c3110732a804179204b312fdcbf95596f7a2`
- S3B-2 八项适配器：`38167d3346244b6d665d5368b2bff1d73566a74f`
- S3B-2 缺失指标保持 unavailable：`003d29d184cdd776c94fa533f7b6fafcf950738e`
- S3B-2 恢复场景不伪造 Run ID：`fd3868746e4090363a2d01ea577e7846d5d9fd2c`
- S3B-3 本待授权账本及报告：本报告提交

没有合并 main，也没有推送。主工作区的 Renderer 未提交修改保留原样。

## 受控 Provider 运行结果

最终账本由提交 `fd3868746e4090363a2d01ea577e7846d5d9fd2c` 运行生成，见 [S3B 受控任务机器账本](rcd-s3b-controlled-baseline-2026-10-17.json)。这是 A 层确定性 Runtime 评测；它不是模型自主任务成功率。

| 任务 | 评测基础设施 | 产品任务结果 | 实际执行证据 |
|---|---|---|---|
| CODE-01 | executed | passed | Runner/Harness/Tools、脚本 Provider、独立 Node 进程导入并检查输出模块 |
| FILE-02 | executed | passed | 隔离目录实际读写；独立 JSON 内容及文件集合检查 |
| DELIV-01 | executed | passed | 实际参数校验反馈、一次有效写入、文件回读 |
| MULTI-01 | executed | partially_completed | 两个文件要求分别检查；保留部分完成结果 |
| RETR-01 | executed | passed | 本地文件先读到 v1，再通过内建 `web_search` 查受控信息并写成 v2；仅有 1 次 `127.0.0.1` HTTP 请求，公网 Agent 请求为 0 |
| LONG-01 | executed | passed | 确定性连续执行控制：35/35 个文件、35 个唯一 Effect、至少 2 个 Segment；不代表开放式模型能力 |
| LONG-02 | executed | passed | 真实 Runner 子进程在安全 Checkpoint 被终止，新 Runner 恢复同一 Run；生产测试断言 35 个唯一写入 Effect、36 个已结算 Effect、终态和 lease 释放。该层级不是 Electron 验收 |
| DELIV-02 | executed | failed | 实际写入 `goodbye`，用户要求是 `hello`；没有 Runtime 文件检查，Task Outcome 为 unknown、requirement 为 unverified，但最终回复声称完成 |

汇总：8/8 个适配器实际运行；评测基础设施 `executed=8`、`blocked=0`、`harness_error=0`；Oracle 产品结果 `passed=6`、`failed=1`、`partially_completed=1`。另 4 项任务仍 `not_run`，因为还没有执行适配器。清理失败为 0。

DELIV-02 的失败归因为高置信度 `insufficient_verification`，次因是严格要求解析器未识别该任务措辞。外部 Oracle 成功发现了错误产物与虚假完成声明；这表示评测判定成功检测到产品失败，不表示产品任务通过。该控制 Provider 预先提供错误写入调用，不据此评价真实模型推理能力。

LONG-02 的嵌套测试没有向外层适配器导出真实 Run ID、模型请求数、工具调用提议或逐调用记录，因此这些账本字段保留 `null`。不把测试夹具 ID 当作 Run ID，也不把未导出的计数当作 0。总模型请求、工具提议及工具执行数因此保持 unavailable；受控 Provider 的物理 Provider HTTP 请求总数为 0。8/8 项的 Provider Usage 与成本均 unavailable，没有从文本或 token 价格推算账单。

## RCD 核心复跑

在同一产品源码版本上运行冻结六项核心：C02=`passed`、C08=`passed`、R01=`passed`、R02=`correctly_blocked`、L01=`partially_completed`、X01=`correctly_blocked`。六项评测基础设施均 `executed`。L01 保持单段预算边界；X01 仍是受控故障注入，不代表真实 OS 崩溃。机器输出保存在本机临时目录，本仓库历史 S0-F 账本没有覆盖。

## 真实模型试跑状态

真实试跑入口只允许 CODE-01、FILE-02、DELIV-01、MULTI-01，任务输入、种子和 Oracle 沿用 S3A。适配器会使用真实 LLM 协议适配器，不预置工具序列；Agent Web 工具关闭。Shell `exec:...` 命令级范围未由通用 Runner 适配器提供可信 Main 授权时不会被扩大为通用 Shell 权限。

当前预检为 `real_provider_pending`：缺少 Provider/模型/协议/HTTPS 端点/API 密钥、物理请求预算、输出 token 上限、美元费用上限、Provider 侧账单封顶确认及用户授权标志。`--run-real` 的负向闸门检查在缺少授权确认时于网络发送前拒绝。真实调用计数为 0，实际 Token、费用和真实模型 Oracle 结果均 unavailable。待授权状态见 [S3B 真实模型账本](rcd-s3b-real-baseline-2026-10-17.json)。

本地执行器只能硬限制 Provider 物理请求数和输出 token 数，不能硬执行美元账单上限。之后若获授权，仍需 Provider 侧费用封顶、明确的总请求/费用预算，并按任务及试验分别输出账本，避免覆盖单次失败轨迹。建议每个符合条件的任务最多先做 1 次 smoke，再按授权预算决定是否重复；本报告不预设任何额度。

## 测试与环境

- `node scripts/s3b-eval.mjs --suite`：通过，12 项定义、8 个不同适配器，S3A 任务集哈希匹配。
- `node scripts/s3b-eval.mjs --preflight`：通过且未联网；真实 Provider 配置未就绪。
- `node scripts/s3b-eval.mjs --run-controlled`：通过，8 项全部执行，0 项基础设施错误。
- `node scripts/s3b-eval.mjs --run-real --task=CODE-01 --trial=1 --authorize-live --max-cost-usd=1`：按预期被授权闸门拒绝，错误为缺少 `S3B_REAL_PROVIDER_AUTHORIZED`，未发起网络请求。
- `pnpm exec vitest run test/s3b-provider-metering.test.ts`：5/5 通过，包括真实 HTTP 边界上的本地模拟计量、请求预算和禁止重定向检查。
- 定向 Runtime/安全/持久化回归：11 个测试文件、130/130 测试通过，覆盖 S1A 参数纠错、Shell Authorization V2、S1C retrieval、S2B 分段/恢复、S2C Outcome 与崩溃矩阵。
- RCD S0-F 核心：6/6 实际执行，产品结果如上。
- `pnpm run typecheck`：通过。
- `pnpm run check:repo` 与 `git diff --check`：最终交付前运行并记录结果。

环境为 Windows x64、Node `v26.4.0`、pnpm `11.9.0`，lockfile SHA-256 为 `da61e379b2ec7d84811c9d913b33e40c201dac2e4ff130e3207f98a61efb7e9b`。Electron 依赖声明为 `^44.0.0`，本工作树没有 Electron 二进制，因此未运行 Electron Main/Renderer。本批主要适配层是 Runner/Harness 测试，不把单元或子进程测试冒充真实桌面验收。

## 未解决项与结论

1. 获得真实 Provider、模型、端点、明确费用与请求预算、Provider 侧费用封顶及当前用户直接授权后，才可执行 B 层试跑；在此之前保持 pending。
2. 四项真实模型试跑适配器还没有真实 Provider 验证；S3B 不能宣称真实模型任务成功率或真实成本。
3. 其余 4/12 项仍没有完整执行适配器，当前 `not_run`，不以组件测试替代。
4. DELIV-02 暴露严格文件要求解析器覆盖不足和结构化结果与自然语言最终回复不一致的风险，归入后续产品修复评审，不在 S3B 中修改生产 Runtime。
5. 受控结果、真实模型结果和未来产品对照属于不同证据层，不能混合统计。

**S3B 阶段状态：部分完成，真实 Provider 任务评测待授权。完成本批后停止，不启动 S3C。**
