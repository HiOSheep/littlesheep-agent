# Web Retrieval Security Acceptance 2026-08-29

状态：受控实现（`web_search`、`web_fetch`、Provider、受控抓取、safe read、citation 与渠道 projection）已落地；离线安全、迁移/回退、供应链、构建产物、性能、用户可见投影、稳定工作树全量回归、Electron 状态连续性、DeepSeek API 实测 V4 Flash 对合成 evidence 的最终回复门和 Webhook loopback 组合链路已通过；显式 Cloudflare DoH 下的独立真实匿名 `web_fetch` 已通过；测试 key 下的真实 Tavily search 已通过。真实 Tavily 搜索结果关联 fetch/citation、真实网页 evidence 驱动的端到端 LLM 联调、第三方正式渠道运行时和签名发布条件仍未验收，网络检索的发布状态保持“未就绪”，逐条见“仍然阻断 ready 的事项”。
最后更新：2026-09-22 23:05:46

## 审查范围

本报告覆盖 LittleSheep 的 `web_search`、`web_fetch`、Web evidence projection、checkpoint/log 持久化、发布产物和关闭网络后的回退路径。测试使用 fake provider、受控 HTTP client、临时目录和已有构建产物；它们不发送实际 Provider 请求，也不会读写活动应用数据根。

## 安全矩阵

| 场景 | 运行时控制 | 离线证据 | 结论 |
| --- | --- | --- | --- |
| 网络关闭、未配置 provider | `enabled=false` 和 runtime/provider 双 gate | `verify-web-provider-smoke` 的 disabled 零调用；迁移 verifier 的两次 disabled search | fail closed；不证明真实 provider |
| 搜索 query、endpoint、header | strict `web_search` schema；provider 由 Runtime 固定 | `web-tools.test.ts` 拒绝 endpoint/header/非法 query；runtime quota 测试 | 模型无法表达任意 HTTP 请求 |
| SSRF、DNS rebinding、redirect、IPv6/loopback | scheme、DNS/IP、固定解析地址、每跳 redirect 复核 | `url-policy`、`http-client`、`service` 定向测试 | 私网和不安全跳转在 socket 前或下一跳前被阻断 |
| 压缩炸弹、异常编码和响应大小 | wire/decompress 双限制、正文上限；未知 `Content-Encoding` 经统一错误边界关闭响应 | `http-client.test.ts` identity/gzip 限制与未知编码回归 | 超限或不支持编码均返回稳定错误，不继续抽取 |
| prompt injection、伪造工具结果 | 外部资料标记 `external_untrusted`；工具与状态机由 Runtime 所有 | Harness/Runner Web integration、tool result durable projection 测试 | 外部文本不能修改权限、工具或 Memory 写入策略 |
| citation forgery | run-scoped citation registry 和 final validation | runtime provider identity/citation 测试、Harness final citation 验证 | 只有本轮 Runtime 发出的 citation 可用于已核验表述 |
| final reply diagnostic leakage | 模型专用 Web projection 移除 `errorKinds`；Runtime/UI 保留诊断映射 | `final-reply.test.ts` 与 DeepSeek API 实测 V4 Flash `verify:web-llm-evidence` | 最终回复不能看到或复述 `web_disabled`、`web_fetch_timeout` 等内部 id；不影响 Runtime 审计或 UI 标签 |
| durable data leakage | `sanitizeWebEvidenceProjection` 白名单；模型正文仅 run-local | Runner/Web tests；checkpoint reload 回归；artifact scan | durable 边界不保存 query、网页正文、raw provider JSON 或 credential-like URL 参数 |
| timeout、cancel、restart | per-request/total deadline、abort propagation、dispose | runtime/service cancellation tests；migration verifier | 取消后拒绝后续请求；历史读取不会触发 replay search/fetch |
| quota/concurrency/cache | per-run counter、request slot、hash-only cache key、TTL/corruption isolation | runtime/service/cache tests | 缓存可共享，但 quota/citation/abort 不跨 run 共享 |
| browser fallback | `approval_required` 独立于 public fetch | Safety/Tools browser-approval 定向测试 | 浏览器、认证、Cookie 和交互页面不因 safe read 自动放行 |
| 关闭网络后的数据保留 | feature flag 与存储分离 | `verify:web-migration` | execution log/checkpoint evidence 和 Memory 可读，provider 请求为零 |
| 文本渠道来源与失败投影 | 共享 content-free formatter；ChannelManager 附加来源 | Types/Plugins + loopback Webhook 组合测试 | 来源、抓取时间、partial/truncated/blocked 或零来源失败状态可见；正文、query、内部 error kind 不出现在文本回复 |

## 可复核命令

```text
pnpm.cmd run verify:web-migration
pnpm.cmd run verify:web-artifacts
pnpm.cmd run verify:web-fetch
pnpm.cmd run verify:web-provider-boundary
pnpm.cmd run verify:web-release
pnpm.cmd exec vitest run packages/runner/src/run-checkpoint-store.test.ts
pnpm.cmd exec vitest run packages/channels/feishu/src/plugin.test.ts packages/channels/qqbot/src/plugin.test.ts packages/channels/telegram/src/plugin.test.ts packages/channels/webhook/src/plugin.test.ts
pnpm.cmd audit --prod --json
pnpm.cmd licenses list --prod
pnpm.cmd --filter @littlesheep/web outdated --format json
```

## 结果摘要

- `verify:web-release` 通过：Provider/public-fetch smoke 报告边界 `19` 项、public-fetch URL 参数拒绝、pnpm 参数分隔符转发、Provider smoke 对未使用替代 `--fetch-url` 的拒绝、citation 与规范搜索结果 URL 必须在 HTTP 前匹配的 Runtime 回归，以及 Tavily 401/403/429/500 映射回归；另运行 1 项真实 LLM evidence verifier 失败输出边界回归、3 项真实 LLM 联调入口参数/脱敏边界回归和 31 项渠道 projection/loopback Webhook 回归；随后迁移 verifier 覆盖旧 config 的默认关闭、新 config secret reference、关闭/重启后的零 provider 调用、execution log/checkpoint 历史可读、Memory 保留和普通本地写入。
- 发布扫描通过：`packages/app/out`、`packages/web/dist`、`packages/types/dist` 与 `release` 候选中的 provider secret、私密 fixture、用户 Memory 和绝对用户路径四类命中均为 0；扫描计数见发布清单。PDF worker 的固定 `/home/web_user` 上游常量有精确 allowlist。
- `RunCheckpointStore` 回归保证 bounded Web evidence projection 跨重建读回，同时仍不保存正文。
- 真实公共 fetch：显式 `--dns-resolver=cloudflare_doh` 通过 HTTP 200、`readability`、`externalUntrusted=true`、未截断、Runtime citation 和 complete evidence；默认 `system` DNS 在本机 TUN/Fake-IP 解析下于 HTTP 前返回 `blocked/web_ssrf_blocked`，因为 `example.com` 被解析到保留网段 `198.18.0.0/15`。任何正式实现都必须显式配置、限制固定解析端点、校验全部 A/AAAA 结果并保留每次 redirect 复核，不能把保留网段直接放行。verifier 仅输出 origin、hash/长度和稳定错误类别。
- 用户终端以测试 key 严格执行 `verify:web-provider -- --require-live`：`disabled-zero-request` 通过（0 次 Provider 请求）；真实 Tavily `search` 通过（1 次 Provider 请求、3 个归一化结果、`cached=false`、`partial=false`）。其后搜索结果关联 fetch 在本机 DNS/SSRF 检查处以 `web_ssrf_blocked` 阻断；报告没有保存 key、query、结果 URL、正文或原始 Provider JSON。
- Provider strict smoke 现在在真实 search 前执行 `validatePublicUrl('https://example.com/')` 作为只做 DNS/IP policy、不做 HTTP 的环境预检；以无效占位 key 在 Fake-IP 环境复验得到 `stage=public-fetch-preflight`、`errorKind=web_ssrf_blocked`、`providerRequests=0`，证明预检不会调用 Provider。
- 渠道：QQ、飞书、Telegram、Webhook 插件测试共 4 个文件、108 项通过；Webhook 另有真实 `DefaultChannelManager` + loopback `WebhookChannelPlugin` 组合验收，断言来源标题、citation、抓取时间、partial/truncated/blocked 可见而网页正文、原始 query 和内部 `web_provider_rate_limited` 不可见。`verify:web-channel-boundary` 为 3 个文件、31 项通过，补充插件定向集合为 4 文件、61 项通过。这些都不连接外部平台。
- `verify:web-performance` 使用 48 次 fake-provider/fake-HTTP 隔离 run 通过 Runtime search/fetch、citation、正文抽取和共享缓存路径，外网请求为 0；它是本地控制流和资源封套基线，不代表互联网或 Provider 延迟。
- `verify:web-llm-evidence` 以 DeepSeek API 实测 V4 Flash 调用生产 `synthesizeFinalReply()`：四个无网页请求的隔离场景分别提供 partial/truncated、rate-limit、fetch-timeout、disabled evidence，均保留不确定性、不伪造 citation 且不含内部 error id。验收中发现 durable projection 的 `errorKinds` 曾被直接传给模型，现已只向模型传递可见 evidence 字段。
- 全量回归：最近一次记录的 `verify:full` 为 389 个测试文件、2,649 项通过、1 项 skipped，并完成 typecheck、App build 和 recovery。本文早前记录的“仍有 1 个与 Web 无关的并行 Renderer 样式测试失败”与发布清单记录的通过结果不一致：当前以通过记录为准，但必须在发布日复跑确认，不得据此改写历史失败或宣称必然通过。
- 供应链：2026-09-02 的复核记录为 0 漏洞，但 **2026-09-22 重新执行 `pnpm audit --prod --json` 报告 `3` 个 moderate、`10` 个 high、`0` 个 critical**（受影响生产依赖为 `@xmldom/xmldom@0.8.13`、`sharp@0.35.0`、`adm-zip@0.6.0`），因此本报告不再声明生产依赖无漏洞；处置与复查日期见[生产依赖安全记录](production-dependency-security.md)。`@littlesheep/web` 的 `outdated --format json` 在 2026-09-02 返回空对象，该读数未在 2026-09-22 重跑。

## Recovery Warning 责任边界

`verify:full` 报告的两类通用恢复 warning 已完成归因，但不伪装成通过：一类是检查器从历史会话前 20 个 JSONL 文件抽样出的 3 个 runId 缺少 execution log；另一类是 layout 快照包含用户曾选择的外部工作区 root。源码级复核表明，二者分别属于历史会话日志完整性观察项和外部工作区布局状态，不涉及本专项 Web evidence、网页正文、Provider 请求、网络关闭回退或 Memory 保留；因此不阻断本报告已通过的 Web 迁移/回退与投影边界，但仍作为全项目发布前责任项保留。若发现与 Web 数据链路存在因果关系，则立即撤销本结论并重新验收。

## 仍然阻断 ready 的事项

1. 必须在拥有测试 key 的隔离环境执行 `pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live`，实际证明搜索结果关联的匿名公开 fetch、citation、认证/限流/超时可见行为和部署地可用性。
2. QQ、飞书、Telegram、Webhook 仍需用正式渠道配置或等价真实运行环境，证明统一 Runner 接收 Web evidence 后能正确输出来源、时间、partial/truncated/error 状态。
3. 当前未签名 Windows release 候选已以 `--root=release` 扫描通过；签名后的最终平台 release 包生成后，仍必须以 `--root=<release-directory>` 重新运行发布扫描。
4. 实际 Provider 条款、价格、速率、数据保留与地区可用性均会变化，live smoke 当日必须重新复核。
5. 真实 LLM 的合成 Runtime evidence 门已通过；真实 LLM 与真实 Tavily/公开网页 evidence 同时可用时，仍必须在隔离数据根验证 partial/timeout/rate-limit/disabled 的最终回复不会把部分资料表述为完整验证，并保留 Runtime source projection。

本报告不能用于宣称 LittleSheep 已稳定实时联网。当前可准确表述为：受控网络检索的离线实现、安全边界、持久化隔离和可关闭回退、真实 Tavily Provider search、显式 Cloudflare DoH 下独立真实 public-fetch、Electron 状态连续性以及 DeepSeek API 实测 V4 Flash 对合成 evidence 的最终回复治理已经验证；搜索结果关联 fetch/citation、真实网页 evidence 驱动的端到端 LLM 联调、正式渠道上线、签名包和干净 Windows 验收尚未完成。

## 已接受缺口（不阻断 ready，退役任务书时显式保留）

原实施任务书（`web-search-and-safe-retrieval-taskbook-2026-08-28`，已于 2026-09-22 退役，原文见 git 历史）里有两项**只有清单、没有实现**的建议项，退役后在此如实记录，避免被误读为已具备：

1. **检索运行事件未映射**：任务书建议的 `retrieval_started`、`search_started`、`search_completed`、`fetch_started`、`fetch_completed`、`source_blocked`、`evidence_truncated`、`provider_rate_limited`、`retrieval_partial`、`retrieval_completed` 在源码中不存在。当前可观测性来自 `WebEvidenceProjection`、工具调用记录与 smoke 报告，UI 不消费独立检索事件流。
2. **检索质量指标未实现**：任务书列出的 search/fetch 成功率、Provider 延迟、缓存命中率、抽取成功率、partial/truncated 比例、SSRF 阻断计数、citation 覆盖率与校验失败数等指标没有独立实现；这些数字目前只能由 smoke 报告与验收脚本间接得出，不能当作常驻可查询指标。

两项都未出现在任何完成门、Definition of Done 或发布 Runbook 中，因此不阻断既有结论；若要作为产品能力补齐，应单独立项并给出消费者与验收标准，而不是回填进本报告的通过结论。
