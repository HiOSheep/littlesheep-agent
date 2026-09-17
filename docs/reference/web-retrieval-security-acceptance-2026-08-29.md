# Web Retrieval Security Acceptance 2026-08-29

状态：WB-09 的离线安全、迁移/回退、供应链、构建产物、性能、用户可见投影、稳定工作树全量回归、Electron 状态连续性、DeepSeek API 实测 V4 Flash 最终回复合成 evidence 门和 Webhook loopback 组合链路已通过；测试 key 下的真实 Tavily search 已通过，但当前环境的搜索结果 public-fetch 因 DNS 解析到保留地址被正确阻断，真实 Tavily + 网页 evidence 联调与第三方正式渠道运行时仍未验收，专项保持“实施中”。
本轮状态更正：显式 Cloudflare DoH 下的独立真实匿名 `web_fetch` 已通过；当前 `verify:full` 仍有 1 个与 Web 无关的并行 Renderer 样式测试失败，因此不能把本轮全量回归称为全绿。真实 Tavily 搜索结果关联 fetch/citation、真实网页 evidence 驱动 LLM、正式渠道和正式发布条件仍未验收。
最后更新：2026-09-01 22:46:00

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
| final reply diagnostic leakage | 模型专用 Web projection 移除 `errorKinds`；Runtime/UI 保留诊断映射 | `final-reply.test.ts` 与DeepSeek API 实测 V4 Flash `verify:web-llm-evidence` | 最终回复不能看到或复述 `web_disabled`、`web_fetch_timeout` 等内部 id；不影响 Runtime 审计或 UI 标签 |
| durable data leakage | `sanitizeWebEvidenceProjection` 白名单；模型正文仅 run-local | Runner/Web tests；checkpoint reload 回归；artifact scan | durable 边界不保存 query、网页正文、raw provider JSON 或 credential-like URL 参数 |
| timeout、cancel、restart | per-request/total deadline、abort propagation、dispose | runtime/service cancellation tests；migration verifier | 取消后拒绝后续请求；历史读取不会触发 replay search/fetch |
| quota/concurrency/cache | per-run counter、request slot、hash-only cache key、TTL/corruption isolation | runtime/service/cache tests | 缓存可共享，但 quota/citation/abort 不跨 run 共享 |
| browser fallback | `approval_required` 独立于 public fetch | Safety/Tools browser-approval 定向测试 | 浏览器、认证、Cookie 和交互页面不因 safe read 自动放行 |
| 关闭网络后的数据保留 | feature flag 与存储分离 | `verify:web-migration` | execution log/checkpoint evidence 和 Memory 可读，provider 请求为零 |
| 文本渠道来源与失败投影 | 共享 content-free formatter；ChannelManager 附加来源 | Types/Plugins + loopback Webhook 组合测试 | 来源、抓取时间、partial/truncated/blocked 或零来源失败状态可见；正文、query、内部 error kind 不出现在文本回复 |

## 本轮可复核命令

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

结果摘要：

- `verify:web-release` 通过。它先运行 18 项 Provider/public-fetch smoke 报告边界、public-fetch URL 参数拒绝、pnpm 参数分隔符转发、Provider smoke 对未使用替代 `--fetch-url` 的拒绝、citation 与规范搜索结果 URL 必须匹配且在 HTTP 前阻断的 Runtime 回归，以及 Tavily 401/403/429/500 映射回归；另运行 1 项真实 LLM evidence verifier 的失败输出边界回归；随后迁移 verifier 覆盖旧 config 的默认关闭、新 config secret reference、关闭/重启后的零 provider 调用、execution log/checkpoint 历史可读、Memory 保留和普通本地写入。
- 发布扫描通过：扫描 `packages/app/out`、`packages/web/dist`、`packages/types/dist` 中 238 个可发布文本文件；测试 key、私密 fixture、用户 Memory 和绝对用户路径四类命中均为 0。88 个 source map、16 个测试编译文件和 1 个不支持的二进制文件被单独计数，而非作为已扫描发布正文。PDF worker 的固定 `/home/web_user` 上游运行时常量有精确 allowlist，见供应链审查。2026-08-30 22:05 重新生成的 `release` 候选扫描进一步覆盖 659 个文件和 `app.asar` 内 14363 个条目，同样四类命中均为 0；当前 NSIS 候选的 SHA-256 为 `EC08404472EFA9E5179C089677F423B27DDD7154793FD057B5C2425498B8F769`，签名状态为 `NotSigned`。发布脚本已通过唯一 staging、发布锁、临时 builder 配置和本地 prepared Electron runtime 消除并发 staging 竞态与 Electron 缓存未命中时的下载依赖，发布脚本单测 2/2 和锁冲突快速路径已通过。
- `RunCheckpointStore` 新增回归保证 bounded Web evidence projection 跨重建读回，同时仍不保存正文。
- 历史独立真实公共 fetch smoke 曾通过：构建后的 `WebRetrievalRuntime` 匿名 GET `https://example.com/` 返回 HTTP 200，使用 `readability` 抽取 185 字符，`externalUntrusted=true`，未截断，并生成 Runtime-owned citation、content hash 和 complete evidence；该结果不证明 Tavily search/provider 可用。
- 当前重新执行 `pnpm.cmd run verify:web-fetch` 输出 `status=blocked`、`errorKind=web_ssrf_blocked`：本机 DNS 把 `example.com` 动态解析到保留基准测试网段 `198.18.0.0/15`，本轮观测为 `198.18.0.132`、此前观测为 `198.18.0.82`，Runtime 在 HTTP 前正确阻断。2026-09-01 进一步确认 Windows 系统代理为 `127.0.0.1:7897`、监听进程为 `com.vortex.helper`，`Meta Tunnel` 使用 `198.18.0.1` 作为 DNS，多个公共域名均返回 `198.18.0.x`；根因是本机代理的 TUN/Fake-IP 解析方式，不是 Tavily 搜索或凭证错误。历史上直接指定 `1.1.1.1` 与 `8.8.8.8` 的 A 记录查询也都落入同一保留网段，表明不能以更换普通 UDP resolver 作为验收修复。一个不进入生产路径的只读原型通过固定可信 HTTPS DNS 端点取得真实公网 A 记录后，继续使用现有 IP 公网校验、TLS SNI/Host 与锁定地址连接，能够得到 HTTP 200；这仅证明存在可研究的显式 trusted-DoH 兼容方向，不是当前产品能力或验收证据。任何正式实现都必须显式配置、限制固定解析端点、设置超时/响应上限、校验全部 A/AAAA 结果、保留每次 redirect 复核，并披露额外 DNS egress，不能把 `198.18.0.0/15` 直接放行。verifier 仅输出 origin、hash/长度和稳定错误类别，不输出正文、完整 URL、请求头、凭证或原始错误消息。它支持 `pnpm run` 的单个前导 `--` 后仅传入 `--url=https://<public-anonymous-page>/` 的最多 4,096 字符替代 smoke 输入；分隔符重复、孤立或错位以及未知参数均在网络初始化前失败且不回显。替代 URL 仍进入相同 URL/DNS/IP/redirect/资源限制路径。当前环境不能再次证明安全公共 fetch，且不得为使 smoke 通过而放宽 SSRF/DNS 规则。
- 用户终端已用测试 key 严格执行 `pnpm.cmd run verify:web-provider -- --require-live`：`disabled-zero-request` 通过（0 次 Provider 请求）；真实 Tavily `search` 通过（1 次 Provider 请求、3 个归一化结果、`cached=false`、`partial=false`）。其后搜索结果关联 fetch 在本机 DNS/SSRF 检查处以 `web_ssrf_blocked` 阻断。该结果证明 Provider 认证和 search 路径，尚未证明搜索结果到匿名页面、Runtime citation 和 end-to-end evidence 的链路；报告没有保存 key、query、结果 URL、正文或原始 Provider JSON。
- 本轮补充：`pnpm.cmd run verify:web-fetch -- --dns-resolver=cloudflare_doh` 已真实通过 HTTP 200、readability、`externalUntrusted=true`、未截断、Runtime citation 和 complete evidence；这项独立 fetch 证据不替代 Tavily search-result fetch/citation。拥有测试 key 的终端仍需运行 `pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live`。
- Provider strict smoke 现在在真实 search 前执行 `validatePublicUrl('https://example.com/')` 作为只做 DNS/IP policy、不做 HTTP 的环境预检。以无效占位 key 在当前 Fake-IP 环境复验得到 `stage=public-fetch-preflight`、`errorKind=web_ssrf_blocked`、`providerRequests=0`，证明预检不会调用 Provider；正常解析时仍继续原有 Tavily search→首条规范 URL fetch→citation 绑定链路。边界回归验证预检位于 search 前，且输出仍只包含稳定阶段、状态、错误类别和请求计数。
- QQ、飞书、Telegram、Webhook 的插件测试共 4 个文件、108 项通过；新增 `DefaultChannelManager` manager 级 Web projection 回归后，渠道相关定向测试为 29 项通过并完成 Plugins typecheck。这是离线/本地模拟运行时证据，不等同于正式渠道凭证和真实发送/接收验收。
- Webhook 现有一条更强的本机组合验收：真实 `DefaultChannelManager` 创建 session/binding 并调用真实 loopback `WebhookChannelPlugin`，HTTP POST 返回 Runner 的 bounded source projection。回归断言来源标题、citation、抓取时间、partial/truncated/blocked 可见，网页正文、原始 query 和内部 `web_provider_rate_limited` 不可见；此外 shared formatter 对零 citation 的 disabled、unconfigured、rate-limit evidence 输出无来源和脱敏状态，而非空字符串。`verify:web-channel-boundary` 为 3 个文件、31 项通过，补充 plugin 定向集合为 4 文件、61 项通过。它不连接外部平台，也不替代 QQ、飞书、Telegram 或外部反向代理场景。
- `verify:web-performance` 使用 48 次 fake-provider/fake-HTTP 隔离 run 通过 Runtime search/fetch、citation、正文抽取和共享缓存路径：外网请求为 0，P95 0.31ms，heap delta 1,095,592 bytes，HTTP 读取 1 次、缓存命中 47 次、缓存 18,895 bytes。它是本地控制流和资源封套基线，不代表互联网或 Provider 延迟。
- Renderer 来源卡覆盖 partial/truncated、稳定错误映射和不暴露 Runtime error id 的离线测试；CLI/channel formatter 继续使用 content-free `WebEvidenceProjection`。这不替代真实 LLM 对部分完成文案的最终表达验收。
- `verify:web-llm-evidence` 以DeepSeek API 实测 V4 Flash 调用生产 `synthesizeFinalReply()`；四个无网页请求的隔离场景分别提供 partial/truncated、rate-limit、fetch-timeout、disabled evidence。四项均保留不确定性；有来源时只接受 Runtime-issued citation，无来源时不伪造 citation，且最终回复不含内部 error id。验收中发现 durable projection 的 `errorKinds` 曾被直接传给模型，现已仅向模型传递可见 evidence 字段并完成真实复验。verifier 自身的失败路径也已收紧为仅输出稳定 error kind，不再输出截断后的原始错误消息。
- 当前稳定工作树最终 `pnpm.cmd run verify:full` 已通过：387 个测试文件、2642 项通过、1 项 skipped，并完成 typecheck、App build 和 recovery；运行前后 5 个 UI 文件指纹未变化，未重现并行改写竞态。Electron 状态连续性门随后通过，覆盖草稿、折叠状态、侧栏/文件导航宽度、设置页、原生窗口和 137px 聊天底部阅读间距恢复。最新 `verify:web-release` 复扫重建后的 238 个 build 文本文件，四类敏感命中仍均为 0；当前 release 候选目录历史扫描为 659 个文件、14363 个归档条目，四类敏感命中均为 0。
- `pnpm audit --prod --json` 在本时间点报告 0 个 info/low/moderate/high/critical 漏洞；`@littlesheep/web` 的 `outdated --format json` 返回空对象。详细依赖、许可证和时效限制见供应链审查。

## Recovery Warning 责任边界

本轮新增真实 DoH 证据：`pnpm.cmd run verify:web-fetch -- --dns-resolver=cloudflare_doh` 在当前 Fake-IP 环境通过 HTTP 200、readability、`externalUntrusted=true`、未截断、Runtime citation 和 complete evidence；默认 `system` DNS 仍在 HTTP 前以 `web_ssrf_blocked` 阻断。DoH 是显式固定 Cloudflare endpoint/IP 的生产配置，不是静默 fallback；任意 resolver endpoint 不被配置或 smoke 参数接受。该证据只闭合安全匿名 public-fetch 子门，不闭合真实 Tavily search-result fetch/citation 或真实 LLM evidence 联调。

`verify:full` 仍报告两类通用恢复 warning，当前已完成归因但没有将它们伪装成通过：一类是检查器从历史会话前 20 个 JSONL 文件抽样出的 3 个 runId 缺少 execution log；另一类是 layout 快照包含用户曾选择的外部工作区 root。源码级复核表明，二者分别属于历史会话日志完整性观察项和外部工作区布局状态，不涉及本专项 Web evidence、网页正文、Provider 请求、网络关闭回退或 Memory 保留；因此不阻断本报告已通过的 Web 迁移/回退与投影边界，但仍作为全项目发布前责任项保留。后续若恢复模块补齐日志/升级外部 root 策略，必须重新运行 `verify:full`；若发现与 Web 数据链路存在因果关系，则立即撤销本结论并重新验收。

## 仍然阻断 ready 的事项

1. 测试 key 已证明当前用户终端中的 Tavily search 可用；默认系统 DNS 下公共 fetch 目标仍被重写到保留地址，但显式 DoH 下独立 public-fetch 已通过。必须在拥有测试 key 的隔离环境执行 `pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live`，实际证明搜索结果关联的匿名公开 fetch、citation、认证/限流/超时可见行为和部署地可用性。
2. QQ、飞书、Telegram、Webhook 仍需用正式渠道配置或等价真实运行环境，证明统一 Runner 接收 Web evidence 后能正确输出来源、时间、partial/truncated/error 状态。
3. 当前未签名 Windows release 候选已以 `--root=release` 扫描通过；签名后的最终平台 release 包生成后，仍必须以 `--root=<release-directory>` 重新运行发布扫描。
4. 实际 Provider 条款、价格、速率、数据保留与地区可用性均会变化，live smoke 当日必须重新复核。
5. 真实 LLM 的合成 Runtime evidence 门已通过；真实 LLM 与真实 Tavily/公开网页 evidence 同时可用时，仍必须在隔离数据根验证 partial/timeout/rate-limit/disabled 的最终回复不会把部分资料表述为完整验证，并保留 Runtime source projection。

本报告不能用于宣称 LittleSheep 已稳定实时联网。当前可准确表述为：受控网络检索的离线实现、安全边界、持久化隔离和可关闭回退、真实 Tavily Provider search、显式 Cloudflare DoH 下独立真实 public-fetch、Electron 状态连续性以及DeepSeek API 实测 V4 Flash 对合成 evidence 的最终回复治理已经验证；本轮 `verify:full` 仍有 1 个无关 Renderer 样式测试失败，搜索结果关联 fetch/citation、真实网页 evidence 驱动的端到端 LLM 联调、正式渠道上线、签名包和干净 Windows 验收尚未完成。
