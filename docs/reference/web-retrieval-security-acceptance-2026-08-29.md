# Web Retrieval Security Acceptance 2026-08-29

状态：受控实现（`web_search`、`web_fetch`、Provider、受控抓取、safe read、citation 与渠道 projection）已落地；离线安全、迁移/回退、供应链、构建产物、性能、用户可见投影、稳定工作树全量回归、Electron 状态连续性、DeepSeek API 实测 V4 Flash 对合成 evidence 的最终回复门和 Webhook loopback 组合链路已通过；显式 Cloudflare DoH 下的独立真实匿名 `web_fetch` 已通过；测试 key 下的真实 Tavily search 已通过。真实 Tavily 搜索结果关联 fetch/citation、真实网页 evidence 驱动的端到端 LLM 联调、第三方正式渠道运行时和签名发布条件仍未验收，网络检索的发布状态保持“未就绪”，逐条见“仍然阻断 ready 的事项”。
最后更新：2026-09-24 20:56:17

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
- 真实公共 fetch：显式 `--dns-resolver=cloudflare_doh` 通过 HTTP 200、`readability`、`externalUntrusted=true`、未截断、Runtime citation 和 complete evidence；默认 `system` DNS 在本机代理环境下于 HTTP 前返回 `blocked/web_ssrf_blocked`（2026-08-29 记录为 `example.com` 被 Fake-IP 解析到保留网段 `198.18.0.0/15`；2026-09-24 复核同一域名在本机被解析到 `0.0.0.0`，阻断结论不变，具体地址随本机代理/DNS 配置变化，不写成稳定事实）。任何正式实现都必须显式配置、限制固定解析端点、校验全部 A/AAAA 结果并保留每次 redirect 复核，不能把保留网段直接放行。verifier 仅输出 origin、hash/长度和稳定错误类别。
- 用户终端以测试 key 严格执行 `verify:web-provider -- --require-live`：`disabled-zero-request` 通过（0 次 Provider 请求）；真实 Tavily `search` 通过（1 次 Provider 请求、3 个归一化结果、`cached=false`、`partial=false`）。其后搜索结果关联 fetch 在本机 DNS/SSRF 检查处以 `web_ssrf_blocked` 阻断；报告没有保存 key、query、结果 URL、正文或原始 Provider JSON。
- Provider strict smoke 现在在真实 search 前执行 `validatePublicUrl('https://example.com/')` 作为只做 DNS/IP policy、不做 HTTP 的环境预检；以无效占位 key 在 Fake-IP 环境复验得到 `stage=public-fetch-preflight`、`errorKind=web_ssrf_blocked`、`providerRequests=0`，证明预检不会调用 Provider。
- 渠道：QQ、飞书、Telegram、Webhook 插件测试共 4 个文件、108 项通过；Webhook 另有真实 `DefaultChannelManager` + loopback `WebhookChannelPlugin` 组合验收，断言来源标题、citation、抓取时间、partial/truncated/blocked 可见而网页正文、原始 query 和内部 `web_provider_rate_limited` 不可见。`verify:web-channel-boundary` 为 3 个文件、31 项通过，补充插件定向集合为 4 文件、61 项通过。这些都不连接外部平台。
- `verify:web-performance` 使用 48 次 fake-provider/fake-HTTP 隔离 run 通过 Runtime search/fetch、citation、正文抽取和共享缓存路径，外网请求为 0；它是本地控制流和资源封套基线，不代表互联网或 Provider 延迟。
- `verify:web-llm-evidence` 以 DeepSeek API 实测 V4 Flash 调用生产 `synthesizeFinalReply()`：四个无网页请求的隔离场景分别提供 partial/truncated、rate-limit、fetch-timeout、disabled evidence，均保留不确定性、不伪造 citation 且不含内部 error id。验收中发现 durable projection 的 `errorKinds` 曾被直接传给模型，现已只向模型传递可见 evidence 字段。
- 全量回归：2026-08-29 记录的 `verify:full` 为 389 个测试文件、2,649 项通过、1 项 skipped，并完成 typecheck、App build 和 recovery。文件数与用例数会随每次运行变化，**不作为常驻结论**（口径与命令入口见[项目状态](../decision/project-status.md) 的维护规则）。本文早前记录的"仍有 1 个与 Web 无关的并行 Renderer 样式测试失败"与发布清单记录的通过结果不一致：当前以通过记录为准，但必须在发布日复跑确认，不得据此改写历史失败或宣称必然通过。
- 供应链：**当前事实以[生产依赖安全记录](production-dependency-security.md) 为准**——2026-09-22 的复核把 `@huggingface/transformers` 升到 4.3.0、自然解析出 `adm-zip@0.6.1` 与 `sharp@0.35.4` 并删除这两个 override，保留 `dompurify@3.4.13` 与 `@xmldom/xmldom@0.8.15` 两个 pin；审计结果为 **0 漏洞**（340 个生产依赖、41 个可选、381 个总计，2026-09-24 复核）。本文与已退役的供应链审查里"3 moderate / 10 high、xmldom 0.8.13 / sharp 0.35.0 / adm-zip 0.6.0"的读数是修复前的历史快照，**不得再作为当前状态引用**。`@littlesheep/web` 的 `outdated --format json` 在 2026-09-02 返回空对象，此后未重跑。

## Recovery Warning 责任边界

`verify:full` 报告的两类通用恢复 warning 已完成归因，但不伪装成通过：一类是检查器从历史会话前 20 个 JSONL 文件抽样出的 3 个 runId 缺少 execution log；另一类是 layout 快照包含用户曾选择的外部工作区 root。源码级复核表明，二者分别属于历史会话日志完整性观察项和外部工作区布局状态，不涉及本专项 Web evidence、网页正文、Provider 请求、网络关闭回退或 Memory 保留；因此不阻断本报告已通过的 Web 迁移/回退与投影边界，但仍作为全项目发布前责任项保留。若发现与 Web 数据链路存在因果关系，则立即撤销本结论并重新验收。

## 仍然阻断 ready 的事项

1. 必须在拥有测试 key 的隔离环境执行 `pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live`，实际证明搜索结果关联的匿名公开 fetch、citation、认证/限流/超时可见行为和部署地可用性。
2. QQ、飞书、Telegram、Webhook 仍需用正式渠道配置或等价真实运行环境，证明统一 Runner 接收 Web evidence 后能正确输出来源、时间、partial/truncated/error 状态。
3. 当前未签名 Windows release 候选已以 `--root=release` 扫描通过；签名后的最终平台 release 包生成后，仍必须以 `--root=<release-directory>` 重新运行发布扫描。
4. 实际 Provider 条款、价格、速率、数据保留与地区可用性均会变化，live smoke 当日必须重新复核。
5. 真实 LLM 的合成 Runtime evidence 门已通过；真实 LLM 与真实 Tavily/公开网页 evidence 同时可用时，仍必须在隔离数据根验证 partial/timeout/rate-limit/disabled 的最终回复不会把部分资料表述为完整验证，并保留 Runtime source projection。

本报告不能用于宣称 LittleSheep 已稳定实时联网。当前可准确表述为：受控网络检索的离线实现、安全边界、持久化隔离和可关闭回退、真实 Tavily Provider search、显式 Cloudflare DoH 下独立真实 public-fetch、Electron 状态连续性以及 DeepSeek API 实测 V4 Flash 对合成 evidence 的最终回复治理已经验证；搜索结果关联 fetch/citation、真实网页 evidence 驱动的端到端 LLM 联调、正式渠道上线、签名包和干净 Windows 验收尚未完成。

## 发布日复核（原《网络检索发布清单 2026-08-29》并入，2026-09-24）

**本机环境限制**：

- 默认 `system` DNS 在代理环境下会把公开域名解析到不可路由地址（2026-09-24 复核 `example.com` → `0.0.0.0`），匿名 public fetch 因此在 HTTP 前被 `web_ssrf_blocked` 正确阻断。这是严格 SSRF 校验与代理解析的兼容冲突，不是 key 或搜索失败；不得为让 smoke 通过而放行保留/私网地址、加入 SSRF 例外、修改 hosts 或固定目标 IP。`cloudflare_doh` 是唯一获准的固定可信替代解析模式，仍执行全部 A/AAAA、redirect、TLS 和 pinned socket 硬拒绝。
- 当前进程没有 `TAVILY_API_KEY`/`LS_TAVILY_API_KEY`，也没有 QQ、飞书、Telegram、外部反向代理 Webhook 或 Authenticode 签名凭证，因此"仍然阻断 ready 的事项"无法在本机补齐。

**发布当天必须复核**（逐项执行后按结果更新本节，不预填结论）：

- [ ] 隔离测试数据根 + `web.enabled=true` + 测试 key：`pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live`。输出不得含 key、Authorization、完整 query、正文、完整 URL、provider 原始 JSON 或原始错误消息；失败只输出白名单稳定错误类别。
- [ ] 默认 public-fetch 目标因部署 DNS 返回不可路由地址而被阻断时，只在正常公开 DNS 环境使用经 Runtime 校验的替代页面复验：`pnpm.cmd run verify:web-fetch -- --url=https://<public-anonymous-page>/`（`--` 只是 `pnpm run` 的前导分隔符；`--url` 是唯一 smoke 输入，最大 4,096 字符，未知参数直接失败）。
- [ ] 取得真实 Tavily search/fetch evidence 后，用真实 LLM 验收同一条 Runtime 路径的 partial、timeout、rate-limit 与 disabled 最终回复；合成的 `verify:web-llm-evidence` 不替代该端到端门。
- [ ] 再次复核 Tavily 服务条款、价格、账户计划限额/限流、数据保留和部署地可用性；不可用时状态维持 `unavailable`，不得隐式回退到 HTML scraping。
- [ ] 使用正式或等价真实环境验收 QQ、飞书、Telegram、Webhook 的来源、时间与 partial/truncated/error 投影。
- [ ] 生成签名后的最终平台 release 包后，以实际包目录执行 `node scripts/verify-web-release-artifacts.mjs --root=<release-directory>`。
- [ ] 重新运行供应链命令与完整回归，并记录日期、lockfile 状态、平台与 skipped 原因。
- [ ] 核对设置页没有把 `configured_unchecked` 呈现为 `ready`，网络关闭和 provider 未配置均没有请求；核对浏览器、登录态、Cookie、Authorization、POST、上传和私网目标仍要求独立批准或被硬拒绝。
- [ ] 在干净 Windows 环境安装、启动、升级、卸载，确认用户数据根与版本升级解耦，并记录安装器签名、哈希和结果。

**发布阻断条件**（任一条成立即不得发布）：

- 实际 Provider 的搜索结果关联 fetch/citation 未通过、被跳过或输出不完整。
- 任意 secret、完整 query、网页正文、用户 Memory、execution log/checkpoint 或用户绝对路径进入最终 release 包。
- citation 无法回溯到当前 run 的 Runtime evidence，或部分资料被表述成完整验证。
- 网络关闭后仍产生 provider/HTTP 请求，或恢复/历史阅读自动重放检索。
- 正式渠道输出缺少来源状态，或展示原始 query、Cookie、Authorization、完整页面正文。

**已知限制**：MVP 仅接 Tavily adapter，未配置 key 时只能显示 `disabled`、`unconfigured`、`configured_unchecked` 或 `unavailable`；`web_fetch` 只做匿名公共 HTTP(S) GET，动态 JS、登录站点、验证码、表单、上传和认证内容不是它的 fallback；性能基线使用受控本地 fake provider/HTTP 夹具，不代表互联网、Provider 或地域网络延迟；当前 Windows NSIS 安装器候选未签名，签名、干净环境安装/升级/卸载与最终包复扫仍是发布门。

## 供应链与许可证（原《网络检索供应链审查 2026-08-29》并入，2026-09-24）

- **Web 包的依赖边界**：`@littlesheep/web` 当前只有 workspace 类型依赖 `@littlesheep/types`；HTTP、HTTPS、DNS、压缩、加密、网络流、URL 解析与取消控制全部使用 Node 内建模块，**没有引入第三方 HTTP 客户端或 HTML 抽取依赖**。Provider adapter、匿名 GET、URL/DNS/IP/redirect 检查、响应与解压上限、正文抽取、缓存、超时、取消、配额、citation 与 projection 脱敏因此都由 LS 自己控制。未来引入 Readability、HTML parser、代理客户端或浏览器依赖时，必须重做许可证、漏洞、维护状态、bundle 内容与 SSRF 行为审查，并新增对应安全回归。
- **许可证**：唯一已知识别缺口是 `khroma@2.1.0`（其 manifest 缺 `license` 字段，工具报 `Unknown`）；已从包内 `node_modules/.pnpm/khroma@2.1.0/.../license` 核验为 MIT，由 `@littlesheep/app → mermaid@11.17.2` 引入。最终发行包仍须包含所需 notices，并由发布责任人核对实际分发内容。需要持续保留的组合/替代许可证清单（`pako`、`jszip`、`dompurify`、`@img/sharp-win32-x64`）与依赖处置见[生产依赖安全记录](production-dependency-security.md)。
- **Tavily 公开资料快照（2026-08-30 读取，必须在发布当天重新复核）**：`search` 为 `POST https://api.tavily.com/search` + Bearer key，`max_results` 0–20，`basic`/`fast`/`ultra-fast` 每次 1 credit、`advanced` 2 credits（LS adapter 固定 `basic`、`include_answer=false`、`include_raw_content=false`、`auto_parameters=false`）；Free 每月 1,000 credits、按量 USD 0.008/credit；条款说明额度、rate limit、功能、地域/环境访问与认证要求可由 Tavily 调整，key 不得共享；隐私政策说明会收集 query，可能在有限情形与第三方搜索索引提供商共享，保留规则不构成 LS 可承诺的固定 TTL。这些只是当日公开资料，不能解释为任何部署地已获准使用；LS 的对应约束是只发送经敏感策略允许的最小 query、不发 Memory/完整会话/附件/内部路径/凭证、默认关闭且需显式启用。
- **发布扫描规则**：锁文件或依赖树变化时重新执行 audit 与 license 清单并审查新增直接依赖；`packages/app/out`、`packages/web/dist`、`packages/types/dist` 与未来 release 包必须通过 `pnpm.cmd run verify:web-artifacts`。source map 与测试编译文件默认不作为发布敏感数据证明的主体，最终打包配置仍须决定是否从发布包排除。扫描器允许 PDF worker 内置的固定 `/home/web_user` 常量（上游浏览器 worker 的运行时字符串，不是用户路径）；Windows `Users/Documents`、macOS `/Users/*` 与其他 Linux `/home/*` 仍是失败项。该 allowlist 只限这一精确常量，升级该依赖或修改 bundle 时必须重新复核。

## 已接受缺口（不阻断 ready，退役任务书时显式保留）

原实施任务书（`web-search-and-safe-retrieval-taskbook-2026-08-28`，已于 2026-09-22 退役，原文见 git 历史）里有两项**只有清单、没有实现**的建议项，退役后在此如实记录，避免被误读为已具备：

1. **检索运行事件未映射**：任务书建议的 `retrieval_started`、`search_started`、`search_completed`、`fetch_started`、`fetch_completed`、`source_blocked`、`evidence_truncated`、`provider_rate_limited`、`retrieval_partial`、`retrieval_completed` 在源码中不存在。当前可观测性来自 `WebEvidenceProjection`、工具调用记录与 smoke 报告，UI 不消费独立检索事件流。
2. **检索质量指标未实现**：任务书列出的 search/fetch 成功率、Provider 延迟、缓存命中率、抽取成功率、partial/truncated 比例、SSRF 阻断计数、citation 覆盖率与校验失败数等指标没有独立实现；这些数字目前只能由 smoke 报告与验收脚本间接得出，不能当作常驻可查询指标。

两项都未出现在任何完成门、Definition of Done 或发布 Runbook 中，因此不阻断既有结论；若要作为产品能力补齐，应单独立项并给出消费者与验收标准，而不是回填进本报告的通过结论。
