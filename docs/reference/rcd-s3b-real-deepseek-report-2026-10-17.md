# RCD S3B-R — DeepSeek 真实 Provider 试跑报告

**日期：** 2026-10-17

**冻结产品提交：** `d5015136ca9cf9583423361263b5bacba257a385`

**评测工作树提交：** `edf35ef7cbe38aca901976623310ce5de6207bac`

**证据层级：** B — 真实模型；实际执行路径为 Node Runner / Harness / Tools，不是 Electron Renderer 验收。

## 结论

修正真实模型适配器后，四项任务各有一次有效 DeepSeek 试跑：CODE-01 通过、FILE-02 失败、DELIV-01 失败、MULTI-01 通过。四次均由真实 Runner/Harness 执行，独立 Oracle 判定，测试目录都清理成功；结果为 2/4 通过。样本只有四项任务，不能据此声称稳定的模型成功率。

其中 CODE-01 和 FILE-02 各有一次更早的真实请求失败：评测器把内部模型引用 `deepseek/deepseek-flash` 原样发给 Provider。DeepSeek 文档列出的模型 ID 是 `deepseek-flash`，故适配器现已只在评测出口去掉 Provider 前缀，并同时记录内部引用与线上 ID。修正后的两次复测使用 trial 2 独立账本。生产 Runtime、Prompt、任务和 Oracle 均未修改。

## Provider 与资源边界

- Provider：DeepSeek；模型：`deepseek-flash`；OpenAI Chat Completions；HTTPS 源站 `https://api.deepseek.com`。DeepSeek 当前文档列出此模型及该 OpenAI 格式基础 URL，并支持工具调用。[官方模型与价格表](https://api-docs.deepseek.com/quick_start/pricing/)、[Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- 本批开始时通过官方余额接口核实 CNY 可用余额，并将其作为整个授权批次共享的余额上限；试跑配置记为 12.10 CNY。用户随后明确授权余额用尽，因此该共享余额边界取代先前 10 CNY 上限。它不是每项任务各自可花的金额。DeepSeek 文档说明余额查询返回 CNY/USD 总额，余额耗尽时 API 返回 402。[余额接口](https://api-docs.deepseek.com/api/get-user-balance/)、[错误码](https://api-docs.deepseek.com/quick_start/error_codes/)
- 每次运行最多 8 个物理 Provider 请求、每次输出最多 2,048 tokens、120 秒超时、单次尝试。真实运行实际请求只用了有效配置试跑的 13 个物理请求；两次错误模型 ID 运行另有 16 个 HTTP 失败请求。
- 四项有效试跑的 Provider 回执累计为 input 38,093、output 1,794、cached input 26,240 tokens。没有权威账单回执，所以人民币成本保持 `unavailable`；没有根据 token 数或余额变化推算费用。
- 真实模型 API 请求属于评测基础设施网络流量。Agent Web 工具关闭，四个任务都声明禁止网络；Shell 未提供。评测只使用合成工作区。
- API Key 仅在当前进程环境中使用，没有写入源码、账本或工作区。该 Key 曾粘贴在对话中，建议测试后撤销并重新生成。

## 任务结果

| 任务 | 有效试跑 | 独立 Oracle | 观察到的行为 |
|---|---:|---|---|
| CODE-01 | trial 2 | `passed` | 读取 `src/label.mjs`、修改、再次读取；独立 Node 进程调用 `taskLabel()` 得到 `ready`。4 次 Provider 请求，3 次工具调用执行。 |
| FILE-02 | trial 2 | `failed` | 读取 CSV 并写入 JSON，但输出字段为 `total_quantity`，Oracle 要求 `total`；SKU 顺序及数量正确。4 次 Provider 请求，3 次工具调用执行。 |
| DELIV-01 | trial 1 | `failed` | 文件内容正确且写入已结算；未出现参数校验失败再修正的证据，Oracle 条件未满足。2 次 Provider 请求，1 次工具调用执行。 |
| MULTI-01 | trial 1 | `passed` | 两个文件都与要求相符，持久化 Task Outcome 中两项要求均为 `passed` 且 inventory 为 complete。3 次 Provider 请求，4 次工具调用执行。 |

四项有效试跑合计 13 次逻辑模型请求、13 次物理 Provider 请求、11 次工具提议、11 次工具执行、7 个已结算 Effect。没有 Agent Web 请求、禁网违规请求、清理残留或评测基础设施失败。模型使用了 `thinking: enabled`；没有发送 temperature、top_p 或 seed，未将 Provider 默认值伪装成显式设置。

四项总耗时为 32,831 ms。首个有效产物时间不可用，因为当前观察器没有记录首个产物时间戳。Runner 结果没有向适配器暴露最终回复文本，因此虚假完成声明计数不可用。人工干预次数同样不可用；唯一的审批回调来自自动返回允许的测试适配器，不是用户在界面中的批准。

DELIV-01 的写入事实与任务 Oracle 结果分开：工具副作用成功并不自动通过“错误参数后修正”的任务条件。FILE-02 也保留真实产物失败，不因 Runtime `ok` 标为通过。

## 评测器问题与处置

1. **错误测试文件分派。** 初次两条命令选中了 S3A scripted 测试文件，却用真实试跑测试名过滤，导致没有测试被选中。两次记录保留为 dispatch diagnostics，不计作模型试跑。分派顺序已修正：`B_real_model` 优先进入 `test/s3b-live-task-trials.test.ts`。
2. **模型 ID 前缀。** 首次 CODE-01、FILE-02 实际发送 16 个物理请求，模型引用仍含 `deepseek/`；其中 FILE-02 已记录到 8 个 HTTP 400。没有 Provider Usage 回执、工具提议或工具执行。该配置错误的尝试不计入修正后的四项任务结果；原始账本仍保留。
3. **账本诊断字段。** 加入安全受限的 HTTP 状态、结构化错误字段（不保存错误正文）、子进程退出码和信号、模型 wire ID 与运行参数记录，便于后续归因。

DeepSeek 的接口文档接受裸模型 ID `deepseek-flash`、基础 URL `https://api.deepseek.com` 和工具调用；适配器修正后，请求都返回 HTTP 200 并获得实际 Usage 回执。[官方模型列表与协议](https://api-docs.deepseek.com/quick_start/pricing/)、[工具调用文档](https://api-docs.deepseek.com/guides/tool_calls/)

## 可复现性与限制

- 机器账本：[DeepSeek 批次结果](rcd-s3b-real-deepseek-batch-2026-10-17.json)。它链接六个真实 Runner/Harness 尝试及两个测试分派诊断，并逐项保留产品提交、场景哈希、评测器指纹、工作树指纹、Usage、Oracle 与清理证据。
- 两个评测分派诊断及六次 Runner/Harness 运行均使用独立临时目录并清理成功。有效配置试跑的评测器指纹有两个版本：DELIV-01 / MULTI-01 在加入 reasoning 元数据字段之前运行；CODE-01 / FILE-02 trial 2 在加入之后运行。产品提交与冻结任务/Oracle 哈希一致，所有运行均报告 `productSourceDirty: false`。因此行为对照以任务结果和产品基线为准，不能声称所有记录使用同一字节级评测器版本。
- `approve` 由测试适配器回调；一项运行计到一次回调，但这不是 Electron Main 的真实审批 UI 或人工确认。无真实 Electron / Renderer 验收。
- 这些数据是 DeepSeek 真实 Provider 结果，不是 Codex GPT-6 Luna 的 LS 内运行结果，也不代表真实用户任务总体成功率。费用没有权威回执；没有进行付费预算外的重复试跑。
- Provider 的真实计费成本、全套 12 项模型任务、Electron 用户审批、发布构建和产品对照仍未完成。本轮没有执行 S3C。

## 验证

- `pnpm exec vitest run test/s3b-provider-metering.test.ts test/s3b-task-adapters.test.ts`：11 项通过。
- `pnpm run typecheck`：通过。
- `node --check scripts/s3b-eval.mjs`：通过。
- `node scripts/s3b-eval.mjs --suite`：12 个任务定义及 8 个可执行适配器通过校验。
- `git diff --check`：通过。
