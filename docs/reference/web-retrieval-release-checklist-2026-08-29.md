# Web Retrieval Release Checklist 2026-08-29

状态：发布前清单已建立；当前专项仍不可发布为 `ready`。
最后更新：2026-09-02 00:43:46

本清单只允许记录已经获得的证据。完成其中的离线项不等于真实 Provider、真实网页或渠道已可用。

## 已完成的离线门

- [x] 默认 `web.enabled=false`，旧配置缺失 `web` 字段仍安全关闭。
- [x] `web_search` 与 `web_fetch` 经统一 Runtime、safe-read、quota、citation 和 evidence projection 边界执行。
- [x] SSRF、DNS/IP、redirect、响应/解压上限、取消、缓存、citation、prompt injection 和 durable leakage 的离线安全矩阵有自动化证据。
- [x] 未知 `Content-Encoding` 经统一错误边界处理：响应流会被关闭/清理并返回非重试 `web_content_unsupported`，不会从 HTTP 回调同步逸出或携带原始编码文本；`http-client`、`url-policy`、`service` 定向矩阵 46 项通过，且本轮未发生 Provider 或公共网页请求。
- [x] execution log/checkpoint 只保存有界 projection，重启后读取历史 evidence 不触发新请求。
- [x] `pnpm.cmd run verify:web-release` 通过 Provider/public-fetch smoke 报告边界 18 项、LLM evidence verifier 失败输出边界 1 项、迁移/回退与 build-directory 敏感数据扫描。Provider smoke 只能抓取 Tavily 返回的规范 URL；任何替代 `--fetch-url` 均会在网络初始化前拒绝，Runtime 也会在 HTTP 前拒绝 citation 与 URL 不匹配的组合。
- [x] 已建立并接入 `verify:web-live-llm-evidence-boundary`：真实联调入口会将 Tavily search、Runtime safe fetch/citation 和真实 DeepSeek final reply 串联；key 只来自当前进程环境变量，输出不含 query、URL、正文、回答全文或密钥；无 key 时在 Provider 请求前安全跳过。该项只证明入口与脱敏边界，不替代真实联调。
- [x] `pnpm.cmd run verify:web-performance` 记录隔离 fake-provider/fake-HTTP workload 的时间、堆趋势和共享缓存边界；本轮 48 次迭代为 P95 0.45ms、heap delta 1,027,064 bytes、HTTP 读取 1 次、缓存命中 47 次、缓存 18,895 bytes，外网请求为 0。
- [x] `pnpm.cmd audit --prod --json`、许可证清单和 `@littlesheep/web` 过期检查已有本时间点记录。
- [x] UI、CLI 与渠道 formatter 对来源、缓存、partial、truncated、blocked 和稳定错误类别有离线投影测试；`DefaultChannelManager` 另有 manager 级回归验证真实 `RunnerResult.webEvidence` 到渠道消息的安全投影，不带出正文、原始 query 或内部错误 id。
- [x] Webhook 已增加本机真实组合链路：临时绑定存储、真实 `DefaultChannelManager`、真实 loopback HTTP POST 与 `WebhookChannelPlugin` 串联，验证 `RunnerResult.webEvidence` 的来源、抓取时间、partial/truncated/blocked 和 citation 会进入 HTTP reply，而网页正文、原始 query 和内部 `web_*` error id 不会进入。该验收不发外网、不使用第三方账号，不替代 QQ、飞书、Telegram 或外部反向代理的正式环境验收。
- [x] 共享 CLI/文本渠道 formatter 现在为每条 citation 输出 `fetchedAt`，并在 `citationCount=0` 的 disabled、unconfigured、rate-limit 等 evidence 下输出“无已验证来源”和脱敏的人类可读状态；内部 `web_*` kind 仍不进入用户文本。`verify:web-channel-boundary` 覆盖 formatter、ChannelManager 和 loopback Webhook 组合链路，共 31 项通过，并已接入 `verify:web-release`。
- [x] `pnpm.cmd run verify:web-llm-evidence` 以真实 DeepSeek V4 Flash 调用生产 `execute_final_reply`，在合成的 `partial/truncated`、rate-limit、fetch-timeout 和 disabled Runtime evidence 下验证不伪造 citation、不夸大完整性且不输出内部错误 id；该过程无 Tavily 或公开网页请求。其失败报告另由 1 项无 Electron/无密钥的边界测试锁定为仅输出稳定 error kind，不输出原始错误文本。
- [x] 当前稳定工作树的 `pnpm.cmd run verify:full` 通过：389 个测试文件、2649 项通过、1 项 skipped；同时通过 `check:repo` 33 项、28 个 workspace TypeScript 项目、App build 和 recovery。运行前后 5 个 UI 文件指纹未变化；recovery 仍有两个已知 warning：少量 sampled runId 缺失 execution log，以及 workspace layout 使用非默认 root；二者未使 gate 失败，需在发布前按责任边界复核。
- [x] `pnpm.cmd run verify:electron-ui-state-continuity` 已在真实 Electron 窗口通过：composer draft、conversation/project 折叠状态、侧栏宽度 249、文件导航宽度 286、浏览器设置页、原生窗口和 137px 聊天底部阅读间距均恢复。ChatView 以 resize 前真实 bottom gap 判断 sticky 状态，用户滚动会取消旧 repair timer；验收夹具等待 120ms resize settle，并按 keep-mounted Settings presence 的 `presence-hidden` 状态确认关闭，仍要求锚点误差不超过 1px。
- [x] 当前 Windows release 候选已重新生成并完成扫描：修复发布脚本共享 staging 竞态后，构建使用发布锁、唯一 staging、临时 builder 配置和本地 prepared Electron runtime；2026-08-30 22:05 的 `release/win-unpacked` 与整个 `release` 目录共扫描 659 个文件、14363 个归档条目，0 个读取错误，provider secret、私密 fixture、用户 Memory 和绝对用户路径均为 0。当前 NSIS 候选 `LittleSheep-0.1.0-x64-Setup.exe` 的 SHA-256 为 `EC08404472EFA9E5179C089677F423B27DDD7154793FD057B5C2425498B8F769`，签名状态为 `NotSigned`。发布脚本单测 2/2 通过，锁冲突快速路径已验证；此候选不能替代签名正式包。
- [x] 历史 `pnpm.cmd run verify:web-fetch` 曾通过真实 `https://example.com/` 匿名公共 GET、正文抽取、`externalUntrusted` 标记、Runtime citation 和 bounded complete evidence；该门不证明 Tavily search/provider 可用。成功报告只投影 requested/final origin，绝不输出完整 requested URL，避免调用者指定 URL 含敏感参数时进入验收输出；Provider 与 public-fetch smoke 的失败输出均只允许白名单 `web_*` kind 或 `unexpected_failure`。`verify-web-provider-smoke.test.mjs` 锁定无 key 零请求跳过、初始化失败不投影伪 key/原始错误文本，以及两条 smoke 报告的字段边界。
- [x] 当前显式 `pnpm.cmd run verify:web-fetch -- --dns-resolver=cloudflare_doh` 已在 Fake-IP 环境真实通过：HTTP 200、`readability`、`externalUntrusted=true`、未截断、Runtime citation 和 `complete` evidence。该模式固定 Cloudflare DoH endpoint/IP，继续执行 A/AAAA、SSRF、TLS SNI/Host、IP pinning 和 redirect 检查；默认 `system` DNS 仍可正确以 `web_ssrf_blocked` 阻断 Fake-IP。它不证明 Tavily 搜索结果关联 fetch/citation 已通过，也不允许任意 resolver endpoint 或静默 fallback。
- [ ] 当前环境重新执行 `verify:web-fetch` 被 Runtime 正确阻断：系统 DNS 将 `example.com` 动态解析到保留的 `198.18.0.0/15` 基准测试网段，本轮观测为 `198.18.0.132`，此前观测为 `198.18.0.82`；输出为 `status=blocked`、`errorKind=web_ssrf_blocked`，没有发起 HTTP 请求。2026-09-01 的进一步只读诊断确认 Windows 系统代理为本机 `127.0.0.1:7897`，监听进程为 `com.vortex.helper`，活动 `Meta Tunnel` 的 DNS 为 `198.18.0.1`，`example.com`、Microsoft 与 Cloudflare 等多个公共域名均被改写到 `198.18.0.x`；这是代理 TUN/Fake-IP 路径与严格 SSRF 校验的兼容冲突，不是 Tavily key 或搜索失败。直接指定 `1.1.1.1` 或 `8.8.8.8` 的历史 A 记录查询也返回同一保留网段，说明不能仅更换普通 UDP resolver。此环境不能重新证明安全公共 fetch；不得允许保留/私网地址、加入 SSRF 例外、修改 hosts 或固定目标 IP。复验时应临时关闭该 TUN/Fake-IP DNS，或切换到会返回真实公网地址的 real-IP/redir-host 等价模式；先确认公共域名解析为全球可路由地址，再运行真实 smoke。
- [x] 已在用户终端以测试 key 严格执行 `verify:web-provider -- --require-live`：disabled 零 Provider 请求通过；真实 Tavily search 以 1 次 Provider 请求返回 3 个归一化结果，且非缓存、非 partial。后续搜索结果关联的 public fetch 被当前 DNS/SSRF 防护以 `web_ssrf_blocked` 正确阻断，因此这只证明 Provider 认证与搜索，不证明 fetch/citation 的端到端链路。
- [x] 严格 Provider smoke 已增加零配额公共 DNS 预检：在创建真实搜索请求前调用与生产相同的 URL/DNS/IP policy，但不发 HTTP。当前 Fake-IP 环境用无效占位 key 复验时，在 `stage=public-fetch-preflight` 返回 `blocked/web_ssrf_blocked`，`providerRequests=0`；因此后续重复诊断不会再浪费 Tavily 配额。正常 DNS 环境仍必须继续执行真实 Tavily search，并抓取其规范化首条结果验证 Runtime citation，预检不降低端到端门槛。相关 Provider/public-fetch 边界仍为 18/18 通过。
- [x] 内置工具维护文档已登记 `web_search`/`web_fetch` 的 Runtime、匿名 GET、`external_untrusted`、投影和失败关闭边界；相关工具/执行服务/registry 定向回归 3 个文件、49 项通过。仓库卫生曾发现与 Web 无关的 `main/index.ts` 启动入口超过 600 行且无受控登记，现已在模块拆分图登记上限和复查日期后恢复 `check:repo` 33/33；该治理修复不替代真实 Provider 或发布验收。
- [x] 已于 2026-08-30 进行一次 Tavily 公开资料复核并记录在供应链审查：Search API 为 Bearer `POST /search`，最大 20 结果；公开页显示 basic/fast/ultra-fast 为 1 credit、advanced 为 2 credits，Free 每月 1,000 credits、PAYG 每 credit USD 0.008。隐私政策明确 query data 的处理、可能的第三方索引转交及非固定保留规则；条款允许调整 rate limit、地域/环境与认证要求。此项没有使用 key 或发生 API 请求，不能替代真实 Provider/部署地/合同验收。

## 当前环境复验补充（历史记录：2026-09-01 21:14:05）

- [ ] 当时的 Codex 进程没有 `TAVILY_API_KEY`/`LS_TAVILY_API_KEY`；活动用户数据根的脱敏配置为 `web.enabled=true`、`defaultProvider=null`、`providers=[]`、`dnsResolver=system`，没有从数据根读取或复制密钥。该时点的 `pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live` 在 Provider 请求前安全返回 `setup/skipped`，没有消耗 Tavily 配额；独立 `verify:web-fetch` 当时在 HTTP 前返回 `web_dns_check_failed`。这一条仅保留为网络波动历史，不代表当前 DoH 可用性；不得通过放宽 TLS/SSRF/IP pinning、修改 hosts、固定目标 IP 或接受任意代理/resolver 绕过。

## 当前工作树复验（历史记录：2026-09-01 23:22:48）

- [x] 当前工作树重新执行 `pnpm.cmd run verify:web-release` 通过：Provider/Tavily boundary 19/19、渠道 projection/loopback Webhook 31/31、LLM verifier boundary 1/1、live verifier boundary 3/3、迁移/回退通过；构建目录扫描 240 个文本文件，四类敏感命中均为 0。
- [x] 当时 `system` DNS 路径曾短暂通过 `pnpm.cmd run verify:web-fetch`：`HTTP 200`、`readability`、`externalUntrusted=true`、未截断、Runtime citation 1 条且 `completeness=complete`。这是历史网络窗口，不是稳定部署前置条件，也不替代 Tavily 返回结果的关联 fetch/citation。
- [ ] 当时显式 `cloudflare_doh` 路径在 HTTP 前返回 `status=blocked`、`errorKind=web_dns_check_failed`。这是历史网络状态，不再代表当前 DoH 可用性；不应关闭 TLS、SSRF、IP pinning 或改用任意 resolver/proxy 伪造通过。
- [x] 当前 `pnpm.cmd run verify:web-performance` 通过：48 次隔离迭代、P95 0.35ms、heap delta 1,025,128 bytes、Provider calls 48、HTTP calls 1、cache hits 47，外部网络请求 0。
- [x] 当前 `pnpm.cmd run verify:web-llm-evidence` 通过：真实 DeepSeek V4 Flash 在合成的 partial/truncated、rate-limit、fetch-timeout、disabled evidence 四场景均完成生产 `execute_final_reply`，citation 和 caveat 约束均成立，且不泄露内部 error id。该验证不发 Tavily 或公开网页请求。
- [x] 当前 `pnpm.cmd run verify:electron-ui-state-continuity` 串行通过：草稿、会话/项目折叠、侧栏 249、文件导航 286、浏览器设置页、原生窗口和聊天底部 137px 阅读间距均恢复。一次与 `verify:web-llm-evidence` 并行启动时因两个 app build 同时替换输出而出现的 `output-unavailable` 不代表产品失败；构建完成后串行复验通过。
- [ ] 当前 Codex 进程仅有 DeepSeek key、没有 Tavily key。因此不能在当前进程重跑真实 Tavily search→搜索结果安全 fetch→Runtime citation→真实网页 evidence LLM；历史用户终端的 Tavily search 成功证据仍只覆盖 search。正式渠道、签名最终包和干净 Windows 安装/升级/卸载同样仍未完成。

## 发布日前置复核（2026-09-02 00:40:28）

- [x] 重新执行 `pnpm.cmd audit --prod --json`：production `346`、optional `40`、total `386` 个依赖，info/low/moderate/high/critical 漏洞均为 `0`；`pnpm.cmd --filter @littlesheep/web outdated --format json` 返回空对象。该结果是当前 lockfile 和注册表 advisory 的快照，不替代最终发布时复跑。
- [x] 许可证清单已重新生成。`khroma@2.1.0` 被工具标记为 `Unknown`，但已从该安装包的 `license` 文件核验为 MIT，且其引入链为 `@littlesheep/app -> mermaid@11.17.2 -> khroma@2.1.0`。这消除了工具元数据缺失造成的未知标签；最终 release 仍须由发布责任人确认 notices、选择性许可证和实际分发包内容。
- [ ] 当前进程没有 Tavily、QQ/飞书/Telegram/Webhook 正式环境或 Windows 代码签名凭证；当前用户证书库中可用代码签名证书数量为 `0`。系统 DNS 同时将 `example.com` 解析到 `198.18.0.73`/`198.18.0.74` 保留网段，因此不得发起会消耗 Tavily 配额的 live smoke，也不得通过 hosts、固定 IP、任意 proxy/resolver 或放宽 SSRF/TLS/IP pinning 规避。真实 Provider、正式渠道、签名最终包和干净 Windows 发布门继续为 blocked。

## Web 传输与证据边界复核（2026-09-02 00:43:46）

- [x] 执行 Web 定向集合 `pnpm.cmd exec vitest run packages/web/src/fetch/http-client.test.ts packages/web/src/fetch/url-policy.test.ts packages/web/src/fetch/service.test.ts packages/web/src/runtime.test.ts packages/tools/src/builtin/web-tools.test.ts packages/runner/src/web-runtime.test.ts`：6 个测试文件、75 项通过。
- [x] 该集合重新证明：HTTP 请求必须使用预先校验的公网地址并在 socket 上 pin；每次 redirect 都重新执行 URL/DNS/IP policy；citation 与搜索结果 canonical URL 不匹配时在 HTTP 请求前拒绝；响应/解压大小、取消、cache、每 run quota 与 Runtime evidence projection 仍受有界控制；网页正文和原始 query 不进入 durable replay。
- [ ] 当前系统 DNS 不是稳定公开解析条件：本轮再次将 `example.com` 解析为 `198.18.0.73`/`198.18.0.74`。这与上一轮短暂完成匿名 public fetch 的状态相矛盾，说明网络路径会波动；只有当 live smoke 执行前解析结果均为全球可路由地址且 Tavily key 存在时，才可执行并采信真实 Tavily search→fetch→citation 证据。

## 最新离线门复验（2026-09-01 21:40:00）

- [x] 当前工作树 `pnpm.cmd run verify:full` 通过：389 个测试文件、2,654 项通过、1 项 skipped；workspace TypeScript 构建、App production build 和 recovery 通过。Recovery 保留 3 个历史 sampled runId 缺失 execution log、以及非默认外部 root 两类 warning，未将其伪装成无告警。
- [x] `pnpm.cmd run verify:web-performance` 通过：48 次隔离迭代、P95 1.07 ms、heap delta 1,070,304 bytes、Provider calls 48、HTTP calls 1、cache hits 47，外部网络请求 0。

## 本轮渠道投影收口（2026-09-01 22:46:00）

- [x] 修复文本渠道遗漏来源抓取时间以及零 citation 错误状态被静默丢弃的问题；Webhook、CLI 和其他复用共享 formatter 的纯文本渠道现在能显示来源时间或无来源失败状态，但不泄露网页正文、完整 query、Cookie、Authorization 或内部 error kind。
- [x] `pnpm.cmd run verify:web-channel-boundary` 通过 3 文件 31 项；补充执行 Webhook plugin/manager/formatter 定向集合为 4 文件 61 项通过，Types、Plugins、Webhook 三个 package typecheck 通过；`pnpm.cmd run verify:web-release` 随后完整通过。无 Provider、公共网页、第三方渠道或 LLM 请求发生。
- [ ] 本机完成的 Webhook 是 loopback 等价真实收发，不等同于 QQ、飞书、Telegram 或经外部反向代理暴露 Webhook 的正式平台验收。当前没有这些渠道凭证，正式发送/接收、认证、限流和回调仍是发布门。

## 本轮验收脚本修复（2026-09-01 22:30:00）

- [x] 修复 `verify-web-live-llm-evidence.mjs` 的 pnpm 参数转发解析：package script 固定参数之后的单个 `--` 现在可正确分隔用户参数，重复/孤立分隔符仍在网络初始化前拒绝；新增回归后 `scripts/verify-web-live-llm-evidence.test.mjs` 为 3/3。
- [x] `pnpm.cmd run verify:web-release` 重新通过：Provider/Tavily 边界 19/19、LLM boundary 1/1、live verifier boundary 3/3、迁移回退通过、当前构建产物扫描 240 文件且四类敏感命中均为 0；没有真实 Provider、网页或 LLM 请求。
- [ ] 真实联调命令参数问题已排除；当前 Codex PowerShell 没有 Tavily process key，因此不能证明搜索结果关联 fetch/citation 或真实网页 evidence LLM。`cloudflare_doh` 的独立 fetch 已于 2026-09-02 复验通过，但不能替代同一持有 Key 进程的关联 smoke。缺少 key 时 `--require-live` 返回退出码 1 是预期的安全失败，不是验收通过。

## 必须在发布当天复核

- [ ] 使用隔离测试数据根、明确 `web.enabled=true` 和测试 key 运行：

  ```text
  pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live
  ```

  已实际证明 Tavily search 与关闭后零请求；当前应使用显式 DoH 版本完成搜索结果关联的匿名 public fetch、citation，以及 auth/rate-limit/timeout 的用户可见结果。输出不得包含 key、Authorization、完整 query、正文、完整 URL、provider 原始 JSON 或原始错误消息；失败仅输出白名单稳定错误类别。

  当前机器的 `system` DNS 在 Vortex TUN/Fake-IP 模式下会返回 `198.18.0.0/15`，因此不得将 system DNS 作为此 smoke 的前置路径。`cloudflare_doh` 是唯一允许的固定可信替代解析模式，已于 2026-09-02 通过独立 public-fetch 验收；它仍对全部 A/AAAA、redirect、TLS 和 pinned socket 执行相同的 hard deny，不是放宽 SSRF/IP 边界。

- [ ] 在当前默认 public-fetch target 因部署 DNS 返回保留网段而被阻断时，只可在正常公开 DNS 环境使用经 Runtime 校验的替代页面复验：

  ```text
  pnpm.cmd run verify:web-fetch -- --url=https://<public-anonymous-page>/
  ```

  `--` 仅是 `pnpm run` 的前导参数分隔符，不能重复、不能单独使用，也不能出现在其他位置；`--url` 是唯一 smoke 输入，最大 4,096 字符，未知参数直接失败。它不绕过 URL canonicalization、域名策略、DNS/IP/redirect、响应限制或匿名 GET-only 规则，且完整 URL 不进入输出。不得使用 IP literal、私网/保留地址、登录页、带 Cookie 的页面或通过代理/hosts 绕过 Runtime 检查。

- [ ] 在真实 Tavily search/fetch evidence 已取得后，再以真实 LLM 验收同一条实际 Runtime 路径的 partial、timeout、rate-limit 和 disabled 最终回复；`verify:web-llm-evidence` 的合成 evidence 验收不替代此端到端门。

- [ ] 发布当天再次复核 Tavily 服务条款、价格、账户计划限额/限流、数据保留和部署地可用性，并结合真实 key 执行结果确认；2026-08-30 的公开资料快照见供应链审查，但未证明实际账户、组织 DPA、地域许可或固定 rate limit。不可用时状态维持 `unavailable`，不得隐式回退到 HTML scraping。
- [ ] 使用正式或等价真实环境验收 QQ、飞书、Telegram、Webhook：来源、时间、partial/truncated/error 投影必须在真实发送链路中正确输出。
- [ ] 生成签名后的最终平台 release 包后，以实际包目录执行：

  ```text
  node scripts/verify-web-release-artifacts.mjs --root=<release-directory>
  ```

  当前未签名的 Windows NSIS 安装器只是候选，虽然当前 `release` 目录扫描通过，也不能替代签名包扫描。

- [ ] 重新运行供应链命令和完整回归，并记录日期、lockfile 状态、平台与 skipped 原因。
- [ ] 核对设置页没有将 `configured_unchecked` 呈现为 `ready`，网络关闭和 provider 未配置均没有请求。
- [x] 桌面网络设置页已提供 Tavily 配置入口：密钥由 Main 进程交给 Electron `safeStorage` 保存，配置只保留 `$TAVILY_API_KEY` 引用，保存密钥不会自动打开网络总开关；配置变化会重建当前 Runner。
- [ ] 核对任何浏览器、登录态、Cookie、Authorization、POST、上传和私网目标仍要求独立批准或被硬拒绝。
- [ ] 在干净 Windows 环境安装、启动、升级、卸载，并确认用户数据根与版本升级解耦；记录安装器签名、哈希和结果。

## 本轮本地发布前复验（2026-09-02）

- [x] `pnpm.cmd run verify:web-release` 串行通过：Provider/Tavily 报告与 adapter 边界 `19/19`、渠道 projection/loopback Webhook `31/31`、LLM evidence 输出边界 `1/1`、真实 LLM 联调入口参数/脱敏边界 `3/3`、迁移/回退以及构建产物扫描均通过；扫描 `240` 个文本文件，四类敏感命中均为 `0`。该命令没有读取 Tavily key 或访问第三方渠道。
- [x] `pnpm.cmd run verify:web-performance` 通过 `48` 次隔离 fake-provider/fake-HTTP 运行：P95 `0.29 ms`、heap delta `1,022,376 bytes`、Provider `48`、HTTP `1`、cache hits `47`、外网请求 `0`。这是本地资源封套与缓存边界，不代表互联网延迟或 Provider SLA。
- [x] 显式 `pnpm.cmd run verify:web-fetch -- --dns-resolver=cloudflare_doh` 通过 HTTP `200`、`readability`、`externalUntrusted=true`、未截断、Runtime citation 和 `completeness=complete`。同轮默认 `pnpm.cmd run verify:web-fetch` 在 HTTP 前返回 `blocked/web_ssrf_blocked`，因为 system DNS 将公开域名指向 `198.18.0.73`；两条结果共同证明 Runtime 没有放宽保留网段 hard deny。
- [x] `pnpm.cmd exec vitest run packages/app/src/renderer/settings/web.test.ts packages/app/src/main/local-app-api/runtime-web-policy.test.ts packages/tools/src/tool-execution-service.test.ts packages/safety/src/permission-boundary.test.ts` 通过 `4` 个文件、`49` 项：`configured_unchecked` 显示为“尚未检查”而非 ready，网络关闭/provider 未配置不会请求，严格 safe-read 审批可恢复，浏览器 fallback 与带认证信息的请求没有被 safe-read 放行。
- [ ] 当前进程仍无 `TAVILY_API_KEY`/`LS_TAVILY_API_KEY`，也无 QQ、飞书、Telegram、外部反向代理 Webhook 或 Authenticode 签名凭证；因此本轮不能把上述本地门替代为真实 Provider 端到端、真实渠道、签名包或干净 Windows 证据。

## Recovery Warning 处置边界

本轮 `verify:full` 的 recovery warning 已完成责任边界复核，但不将其改写为无 warning：

- `sampled runIds missing execution logs` 来自通用恢复检查器对历史会话前 20 个 JSONL 文件的抽样；当前发现的 3 个 runId 没有对应 execution log，但不属于本专项生成的 Web run，也没有证据表明 Web evidence、checkpoint 或用户 Memory 因此丢失。该项保留为全项目历史数据治理观察项，不阻断本专项的 Web 迁移/回退门，但正式发布前仍需由恢复模块责任人决定补日志、清理历史引用或形成独立豁免。
- `workspace layout snapshot uses non-default roots` 来自用户曾选择并保存在 layout 快照中的外部工作区 root；这是合法的工作区生命周期状态，不是 Web 资源、网页正文或敏感数据泄露。它不阻断 Web 回退门，但正式发布前需由工作区/恢复模块确认外部 root 的升级和恢复策略。

这两项 warning 不得在发布报告中表述为 Web 专项“全部恢复检查无告警”；它们也不应被误判为 Web 检索失败。若后续发现 warning 与 Web evidence、网络关闭回退、数据丢失或安全边界存在因果关系，必须重新打开对应发布阻断条件。

## 发布阻断条件

- 真实 Provider 的搜索结果关联 fetch/citation 未通过、被跳过或输出不完整。
- 任意 secret、完整 query、网页正文、用户 Memory、execution log/checkpoint 或用户绝对路径进入最终 release 包。
- citation 无法回溯到当前 run 的 Runtime evidence，或部分资料被表述成完整验证。
- 网络关闭后仍产生 provider/HTTP 请求，或恢复/历史阅读自动重放检索。
- 正式渠道输出缺少来源状态，或展示原始 query、Cookie、Authorization、完整页面正文。

## 已知限制

- 当前 MVP 仅接 Tavily adapter；未配置 key 时只能显示 `disabled`、`unconfigured`、`configured_unchecked` 或 `unavailable`，不能声称实时资料可用。
- `web_fetch` 只做匿名公共 HTTP(S) GET；动态 JS、登录站点、验证码、表单、上传和认证内容不是该能力的 fallback。
- Web Runtime 的性能基线使用受控本地 provider/HTTP 夹具，证明本地控制流与资源边界，不代表任何互联网、Provider 或地域网络延迟承诺。
- 渠道测试目前是插件/本地运行时验证；真实第三方平台的认证、回调、限流和消息格式仍需发布前验收。
- 当前 Windows NSIS 安装器候选未签名；签名、干净环境安装/升级/卸载和最终包复扫仍是正式发布门。
