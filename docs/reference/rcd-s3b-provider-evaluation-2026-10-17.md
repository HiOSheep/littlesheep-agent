# RCD S3B 真实模型评测协议

本评测器是冻结产品提交 `d5015136ca9cf9583423361263b5bacba257a385` 上的评测覆盖层。S3B 不修改产品 Runtime、Harness、Tools、权限策略、Prompt 或任务 Oracle。

## 证据层级

- **A：受控 Provider。** 使用确定性脚本响应或本地假 HTTP 响应，只测 Runtime 与评测器链路，不代表模型自主完成任务的质量。
- **B：真实模型。** 使用明确配置的 Provider 发出真实请求，并由独立 Oracle 检查隔离的合成任务产物。这是唯一能够测量模型自主决策的层级。
- **C：产品对照。** 不属于 S3B 范围。

S3A 原有四个受控适配器及其 Oracle 保持不变。新增任务适配器作为独立的 S3B 扩展维护，原始 12 项任务定义及历史基线账本均未修改。

## Provider 配置与隐私

`node scripts/s3b-eval.mjs --preflight` 只读取以下环境变量，不发送请求：`S3B_PROVIDER_ID`、`S3B_MODEL`、`S3B_API_PROTOCOL`、`S3B_BASE_URL`、`S3B_API_KEY`、`S3B_MAX_PHYSICAL_REQUESTS`、`S3B_MAX_OUTPUT_TOKENS`、二选一的 `S3B_MAX_COST_USD` / `S3B_MAX_COST_CNY`、`S3B_PROVIDER_BILLING_CAP_CONFIRMED=true`、`S3B_PROVIDER_BILLING_CAP_BASIS`、`S3B_TIMEOUT_SECONDS`（默认 120）和 `S3B_MAX_ATTEMPTS`（默认 1）。支持现有 LLM 包使用的 OpenAI Chat Completions、OpenAI Responses 与 Anthropic Messages 协议。外部端点必须使用 HTTPS；普通 HTTP 只允许用于本机回环测试服务。

预检仅显示端点源和脱敏后的模型设置，不显示密钥、授权头、请求正文、Prompt 或完整端点路径。真实请求记录内部模型引用与线上模型 ID、实际请求的 temperature、reasoning/thinking 设置和输出 token 上限。Provider 适配器会将内部 `provider/model` 引用转换为对应 Provider 的裸模型 ID。当前 Harness 请求契约不提供 `top_p` 或 `seed`，因此将它们记录为不支持或未设置，不推测其实际值。

真实调用还要求环境变量 `S3B_REAL_PROVIDER_AUTHORIZED=I_AUTHORIZE_THIS_EVALUATION_RUN`、明确的正数请求预算和费用上限，以及已配置 Provider 侧费用限制的确认。费用上限可以用 USD 或 CNY 表示，但必须与 Provider 的实际硬限制一致；`S3B_PROVIDER_BILLING_CAP_BASIS` 记录所依据的硬限制机制。软件检查只是附加防护，不能代替当前任务中的用户直接授权。本地执行器限制物理 HTTP 请求数和最大输出 token，但不能独立保证货币费用上限。除非 Provider 返回权威费用回执，usage/cost 继续记为 `unavailable`。

## 测量约定

- 物理 Provider 请求在注入的 `fetch` 边界计数，包括重试；发送前被拦截的请求另行计数。
- 逻辑模型请求统计 `chat` 与 `chatStream` 调用。
- 工具提议次数来自 Provider 返回的工具调用；实际执行和拒绝次数来自 Runner `toolInvocations`。不能用提议数替代执行数。
- 已结算 Effect 来自 Runner 副作用证据。Unknown Effect 单独记录，不能作为任务成功证据。
- Provider usage 只来自 `onProviderResponse` 回执；缺失回执时记为 unavailable 或 partial。
- Agent Web 请求与 Provider HTTP 请求分别记录，并分别检查离线/回环网络策略。
- 审批数来自可信审批回调的实际调用次数；执行路径未提供计数时记为 unavailable。
- 每项运行记录独立 Oracle 结果、失败归因和证据、脱敏 Provider 配置、环境/配置指纹及清理状态。

报告不得保存完整 Prompt、响应正文、API 凭据、私人用户数据或未受限的工具输出。任务目录只使用合成夹具。宿主 Shell 尚未处于 OS 沙箱之中，本评测不宣称能够隔离宿主进程。

## 执行命令

- `node scripts/s3b-eval.mjs --preflight`：检查脱敏配置，不联网。
- `node scripts/s3b-eval.mjs --suite`：校验未修改的 12 项任务集、哈希和 8 个可执行适配器。
- `node scripts/s3b-eval.mjs --verify-provider-metering`：使用本地假 HTTP 响应校验计量，不访问公网。
- `node scripts/s3b-eval.mjs --run-controlled [--task=<ID>] [--output=<绝对路径>]`：运行全部 8 个受控适配器或指定单项；默认账本为 `docs/reference/rcd-s3b-controlled-baseline-2026-10-17.json`。
- `node scripts/s3b-eval.mjs --run-real --task=<CODE-01|FILE-02|DELIV-01|MULTI-01> --trial=<N> --authorize-live --max-cost-usd=<USD>` 或 `--max-cost-cny=<CNY> [--output=<绝对路径>]`：受保护的真实 Provider 试跑入口。还需要上述环境配置及 `S3B_REAL_PROVIDER_AUTHORIZED=I_AUTHORIZE_THIS_EVALUATION_RUN`；这些程序参数本身不构成用户授权。

真实模型试跑使用原 S3A 任务文本、夹具种子与外部 Oracle，不预置工具调用序列。四个新增受控适配器不纳入真实试跑：RETR-01 仅访问本机回环服务；LONG-01 是确定性连续执行控制；LONG-02 调用真实子进程恢复测试；DELIV-02 暴露当前任务措辞未被严格要求解析器识别的问题。

任务的 `network: denied` 限制作用于 Agent 工具；真实模型试跑禁用 `web_search` 与 `web_fetch`。Provider API 是单独授权并计量的评测基础设施网络流量，因此该试跑并非完全离线。通用 Runner 适配器不会伪造 Main 持有的命令级 Shell 授权；`exec:...` 范围没有可信宿主路径提供时会标记为不可用，不能改为宽泛 Shell 授权。

## 当前状态

S3B-R 已在用户授权的 DeepSeek 账户余额边界内完成首批 CODE-01、FILE-02、DELIV-01、MULTI-01 Runner/Harness 试跑。逐次账本与综合报告见 `rcd-s3b-real-deepseek-batch-2026-10-17.json` 和 `rcd-s3b-real-deepseek-report-2026-10-17.md`。本地账户余额耗尽时 Provider 会返回 402；该机制限制整个账户，不是每项任务独立预算。物理 token Usage 可取得，但没有权威费用回执时成本仍为 `unavailable`。
