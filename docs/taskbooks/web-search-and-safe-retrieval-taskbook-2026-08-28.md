# LittleSheep 实时网络检索与安全读取任务书 2026-08-28

最后更新：2026-09-02 17:48:08

状态：实施中（WB-01 至 WB-08 已完成并有离线/定向证据；WB-09 的全量回归、构建、恢复、专项 release、性能和 Electron 状态连续性门已通过，真实 Tavily search 已验证；当前 system DNS 会把公开域名解析到 `198.18.0.0/15` 保留网段，关联 fetch 必须被 SSRF 策略阻断。显式 `cloudflare_doh` 已于 2026-09-02 复验独立匿名 public-fetch，但尚未在同一持有 Tavily key 的进程完成 search -> fetch -> citation；真实 Tavily evidence 驱动的 LLM、正式渠道和签名/干净环境发布验收也尚未完成；不能宣称专项 ready）

**WB-09 当前复验（2026-09-02）**：当前工作树串行通过 `verify:web-release`（Provider/Tavily boundary 19/19、渠道 projection/loopback Webhook 31/31、LLM boundary 1/1、live verifier boundary 3/3、迁移/回退和构建产物扫描），`verify:web-performance`（48 次隔离迭代、P95 0.29ms、heap delta 1,022,376 bytes、Provider calls 48、HTTP calls 1、cache hits 47、外部网络请求 0），真实 DeepSeek V4 Flash 合成 Runtime evidence 四场景，以及 `verify:electron-ui-state-continuity` 串行验收。本轮核心传输集合另通过 7 个文件、86 项，覆盖 Tavily 的 401/403/429/500 映射与错误脱敏、provider schema 拒绝、SSRF/DNS/redirect、压缩/正文上限、citation 绑定、超时/配额和每 run evidence 隔离；这属于可重复的离线故障模拟，不替代真实 Tavily 账户的 auth/rate-limit/timeout 结果。历史上 system DNS 曾在短暂可用窗口使 `verify:web-fetch` 通过 HTTP 200、readability、`externalUntrusted=true`、Runtime citation 和 `completeness=complete`；这不是稳定前置条件。当前 system DNS 再次返回 `198.18.0.73`，属于 `198.18.0.0/15` 保留网段，Runtime 因此正确返回 `web_ssrf_blocked`。本轮显式 `cloudflare_doh` 的独立 `verify:web-fetch` 已通过同一匿名 public-fetch/citation 检查；尚需在持有 Tavily key 的同一进程以该 resolver 完成真实 search -> fetch -> citation。一次与 LLM evidence 同时启动的 App build 造成的 `output-unavailable` 已通过构建稳定后的串行复验排除，不作为产品失败。

本轮不能继续闭合真实 Provider 发布门：当前 Codex 进程没有 Tavily key，无法执行真实 Tavily search 到其规范结果的 safe fetch/citation 以及真实网页 evidence LLM；此前用户终端的真实 Tavily search 只证明了 1 次搜索请求、3 个非缓存且非 partial 的归一化结果。QQ、飞书、Telegram、外部反向代理 Webhook 的正式认证/收发/回调/限流、签名最终安装包、干净 Windows 安装/升级/卸载也仍无证据。`check:repo` 本轮唯一失败为无关的 `packages/app/src/renderer/workspace/use-workspace-layout-controller.ts` 从 538 行变为 539 行；本专项未修改该文件，不能把该失败改写成 Web 通过。

**WB-09 发布日前置复核（2026-09-02 00:40:28）**：当前 lockfile 下重跑 `pnpm.cmd audit --prod --json` 为 production 346、optional 40、total 386 个依赖且各漏洞等级均为 0；`pnpm.cmd --filter @littlesheep/web outdated --format json` 返回空对象。许可证工具将 `khroma@2.1.0` 标为 `Unknown`，已核验为 manifest 缺少字段的识别问题：该安装包 `license` 文件为 MIT，依赖链为 `@littlesheep/app -> mermaid@11.17.2 -> khroma@2.1.0`；最终 release notices 与法务核对仍不可跳过。当前进程没有 Tavily 或正式渠道凭证，用户证书库中没有代码签名证书；系统 DNS 又将公开域名解析到 `198.18.0.0/15` 保留网段。故不得运行消耗配额的 live smoke，也不得放宽 SSRF/TLS/IP pinning、使用 hosts/固定 IP 或任意代理/解析器绕过。真实 Provider、正式渠道、签名最终包和干净 Windows 门继续 blocked。

**2026-09-01 配置入口补充**：网络设置页现提供 Main-owned Tavily 配置入口。密钥只由 Electron `safeStorage` 保存为 `TAVILY_API_KEY`，配置文件只登记 `$TAVILY_API_KEY` 与固定 `tavily-search-v1` adapter；保存后重建当前 Runner，但不自动打开网络总开关。新增的 Main-owned provider-check 只在用户主动点击且网络已启用时执行一次固定最小搜索，成功才把当前运行时状态显示为 `ready`；检查状态不写入配置，策略变化、Runner 重建和重启都会清除。当前实际用户数据根仍未保存 Tavily key，真实 search->fetch->citation、真实网页 evidence LLM、正式渠道、签名和干净 Windows 门仍保持未完成。
最后更新：2026-09-02（当前 system DNS Fake-IP 与 Cloudflare DoH 复验状态已校正）
本次记录：修复审阅界面生产约束测试中 `review-diff.tsx` 残留的 `?? []`，新增并通过 `verify:web-fetch` 真实匿名公共 GET smoke；随后 `check:repo` 33/33、当前稳定工作树的全量 `verify:full` 通过（387 个测试文件、2642 项通过、1 项 skipped），并完成 typecheck、App build 和 recovery。全量门期间 5 个 UI 指纹保持不变，未重现并行改写竞态。随后串行通过 `verify:web-release`、`verify:web-performance`、`verify:electron-ui-state-continuity` 和 `verify:web-llm-evidence`：发布边界 18 项、LLM verifier 边界 1 项、迁移/回退和 238 个构建文本文件扫描通过；性能隔离基线为 48 次迭代、P95 0.31ms、heap delta 1,095,592 bytes、HTTP 读取 1 次、缓存命中 47 次；Electron 已实际验证草稿、折叠状态、侧栏/文件导航宽度、设置页、原生窗口和 137px 聊天底部阅读间距恢复；真实 DeepSeek V4 Flash 生产 `execute_final_reply` 已通过合成 partial/truncated、rate-limit、fetch-timeout 和 disabled evidence 四场景。为使 Electron 连续性夹具正确模拟用户主动滚动，本轮将脚本等待 resize settle 并补发原生 `scroll` 事件，仍保持 1px 锚点误差门。修复 Windows 候选打包脚本的共享 staging 竞态：每次构建现在使用发布锁、唯一 staging、临时 builder 配置和临时 `electronDist`，并在失败时清理；发布脚本单测 2/2、锁冲突快速路径通过。当前源码的 Windows unpacked、NSIS 安装器候选和整个 `release` 目录已于 22:05 重新生成并扫描通过，实际扫描 659 个文件和 14363 个归档条目，0 个读取错误、四类敏感命中均为 0；安装器 SHA-256 为 `EC08404472EFA9E5179C089677F423B27DDD7154793FD057B5C2425498B8F769`，签名状态 `NotSigned`，不能作为正式包。electron-builder 已确认使用本地 prepared Electron runtime，避免缓存未命中时下载 Electron；其 duplicate dependency 和跨平台 optional dependency 提示仍需供应链复核。用户终端以测试 key 严格执行 Tavily smoke：关闭网络零请求通过，1 次真实 Provider search 返回 3 个非缓存、非 partial 的归一化结果；后续搜索结果关联 fetch 因 DNS 将目标指向保留网段而被 Runtime 正确阻断为 `blocked/web_ssrf_blocked`，没有放宽 SSRF 规则。后续只读诊断直接指定 `1.1.1.1` 与 `8.8.8.8` 查询同一域名，仍均返回 `198.18.0.82`；当前网络存在统一 DNS 改写或强制解析路径，不能靠切换单个 resolver 完成真实公网验收。Provider/public-fetch smoke 输出边界自动化回归增至 18 项；其中新增的 Runtime 回归固定要求搜索结果 citation 只能绑定其规范 URL，URL 不匹配会在 HTTP 请求前以 `web_citation_invalid` 拒绝。Provider smoke 同时拒绝未使用的 `--fetch-url`，只读取 Tavily 归一化结果，且不回显带敏感参数的输入。LLM evidence verifier 失败输出边界 1 项也已接入 `verify:web-release` 并通过。最新 `verify:web-release` 复扫当前构建的 238 个文本文件，四类敏感命中均为 0；`verify:web-release`、仓库卫生与 `git diff --check` 通过。可用公开 DNS 环境、真实 Tavily 网页 evidence 联调、正式渠道与签名工具仍缺失，因此专项继续保持实施中。
任务书类型：跨 Tools、Safety、Harness、Runner、LLM、Memory、App 的能力专项

本轮复核更正：显式 Cloudflare DoH 下的独立真实匿名 `web_fetch` 已通过；本轮修正了与当前共享 CSS/keep-mounted presence 契约不一致的两个验收断言，并通过真实 Electron 重跑。当前最新 `verify:full` 为 389 个测试文件、2649 项通过、1 项 skipped；`check:repo` 33/33、28 个 TypeScript project references、App build、recovery、`verify:web-release`、`verify:web-performance`、`verify:web-llm-evidence`、`verify:electron-ui-state-continuity` 和 `git diff --check` 均通过。真实 Tavily search→fetch→citation 仍需由拥有 key 的终端执行 `--dns-resolver=cloudflare_doh` 版本。

本轮最新复验（2026-09-01 20:45:00，实施中）：将 Main-owned Provider 检查的进程内状态、并发 Promise 合并和 generation 失效闸门提取到独立 `packages/app/src/main/local-app-api/web-provider-check.ts`；Web 配置或 Runner 热替换后，旧检查结果不会重新发布为当前 `ready`，Runtime 路由也不再重复写回过期结果。新增竞态回归后，Provider/UI 定向测试为 10/10，Web 相关定向集合为 7 个文件、54/54；`pnpm.cmd run check:repo` 通过 33/33 和 28 个 TypeScript project references，App typecheck、App production build、`pnpm.cmd run verify:web-release` 和 `git diff --check` 均通过。随后 `pnpm.cmd run verify:full` 通过 389 个测试文件、2654 项通过、1 项 skipped，workspace build、App build 和 recovery 通过；`verify:web-performance` 通过 48 次隔离迭代（P95 0.85ms、heap delta 1,053,808 bytes、Provider 48 次、HTTP 1 次、缓存命中 47 次）；真实 DeepSeek V4 Flash 的 `execute_final_reply` evidence 门四场景通过，但外部 Web 请求为 0，不能替代真实 Tavily evidence 联调；修复 CDP 默认 execution context 握手后，`verify:electron-ui-state-continuity` 串行通过，恢复草稿、会话/项目折叠、侧栏 249、文件导航 286、浏览器设置页、原生窗口和聊天底部 137px 间距。当前进程严格执行 `pnpm.cmd run verify:web-provider -- --require-live` 在 Provider 请求前因 `TAVILY_API_KEY`/`LS_TAVILY_API_KEY` 均不存在而安全返回 `setup/skipped`，没有新增真实 Provider 请求；用户终端此前已取得的真实 Tavily search（3 个非缓存、非 partial 结果）及默认 DNS 下的 `web_ssrf_blocked` 仍是当前真实 Provider 证据。真实 Tavily search→fetch→citation、真实网页 evidence 驱动的 LLM、Provider 真实失败状态、QQ/飞书/Telegram/Webhook 正式渠道、签名安装包和干净 Windows 安装/升级/卸载仍未完成，专项继续保持实施中。

当前环境网络复核（2026-09-01 21:02:00，实施中）：实际用户数据根仅有 `DEEPSEEK_API_KEY` 条目，`web.enabled=true` 但 `defaultProvider=null`、`providers=[]`，故此前通过的 Tavily search 来自用户终端的临时环境变量，尚未成为当前 LS 持久配置。当前进程的 `verify:web-provider -- --dns-resolver=cloudflare_doh --require-live` 因无 Tavily key 在任何 Provider 请求前安全 `setup/skipped`。独立 `verify:web-fetch -- --dns-resolver=cloudflare_doh` 也不再成功，而是在 HTTP 前返回 `web_dns_check_failed`；只读诊断显示系统仍能解析普通公开域名，但固定 Cloudflare DoH IP `1.1.1.1:443` TCP 不可达，直接请求 `cloudflare-dns.com` 发生 TLS 连接失败，Windows 代理配置仍指向 `127.0.0.1:7897`。不得为适应该环境放宽 TLS、SSRF、IP pinning 或引入任意代理/resolver；应在可直连固定 DoH 的网络，或恢复可信代理/TUN 的真实公网解析模式后，使用隔离 key 重跑关联 citation smoke。
本轮复验补充（2026-09-01 21:14:05，实施中）：当前 Codex 进程未设置 `TAVILY_API_KEY`/`LS_TAVILY_API_KEY`，且活动用户数据根配置的安全投影为 `web.enabled=true`、`defaultProvider=null`、`providers=[]`、`dnsResolver=system`；因此未从活动用户数据根读取或复制密钥。执行 `pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live` 在 Provider 请求前安全返回 `setup/skipped`，没有消耗 Tavily 配额；独立执行 `pnpm.cmd run verify:web-fetch -- --dns-resolver=cloudflare_doh` 在 HTTP 前返回 `status=blocked`、`errorKind=web_dns_check_failed`。只读网络检查仍显示固定 DoH 路径不可达，且本机存在 `127.0.0.1:7897` 的 Vortex helper/TUN 环境。该结果是外部网络前置条件阻断，不是 Tavily 认证或 Runtime SSRF 逻辑失败；不得降低 TLS/SSRF/IP pinning、修改 hosts、固定目标 IP 或接受任意代理/resolver。此前在可用网络中独立 `web_fetch` 通过的历史证据继续保留，但不能替代同一真实环境中的 Tavily search→fetch→citation；专项继续保持实施中。

本轮全量门复验（2026-09-01 21:40:00，实施中）：当前工作树执行 `pnpm.cmd run verify:full` 已完成并通过，389 个测试文件、2,654 项通过、1 项 skipped；workspace TypeScript 构建、App production build 和 recovery 均通过。Recovery 仍报告 3 个历史 sampled runId 缺失 execution log、以及用户布局快照包含非默认外部 root 两项 warning；现有证据表明它们不属于本专项生成的 Web run，不将 warning 改写为无告警。随后 `pnpm.cmd run verify:web-performance` 通过 48 次隔离迭代：P95 1.07 ms、heap delta 1,070,304 bytes、Provider calls 48、HTTP calls 1、cache hits 47，外部网络请求 0。该组新证据没有改变真实 Tavily search→fetch→citation、真实网页 evidence LLM、正式渠道、签名包和干净 Windows 生命周期仍未完成的结论。

本轮新增真实联调入口（2026-09-01，实施中）：新增 `scripts/verify-web-live-llm-evidence.mjs`，将真实 Tavily search、首条规范结果的 Runtime safe public fetch/citation 和真实 DeepSeek `synthesizeFinalReply()` 串为一个隔离验收门；Tavily/DeepSeek key 只接受当前进程环境变量，输出只保留计数、HTTP 状态、正文长度/hash、citation 状态和回答 hash，不输出 query、URL、正文、回答全文或密钥。无 key 时使用 `--require-live` 在任何 Provider 请求前安全 `skipped`；`verify:web-live-llm-evidence-boundary` 已纳入 `verify:web-release`。当前环境无 key 且固定 Cloudflare DoH 不可达，因此真实联调尚未运行，不能以该入口的边界测试或合成 evidence 验收替代真实门。

本轮参数转发修复与复验（2026-09-01 22:30:00，实施中）：修复 `scripts/verify-web-live-llm-evidence.mjs` 只接受前导 `--` 的解析缺陷；package script 已固定追加 `--require-live` 时，pnpm 转发的 `--dns-resolver=cloudflare_doh` 会位于该参数之后，现可被正确接受，同时仍拒绝重复或孤立分隔符。新增回归覆盖该真实参数形状，`scripts/verify-web-live-llm-evidence.test.mjs` 为 3/3；`node scripts/verify-web-live-llm-evidence.mjs --require-live -- --dns-resolver=cloudflare_doh` 返回脱敏 `status=skipped`，退出码 1 符合缺少 Tavily/DeepSeek live key 时 `--require-live` 的安全契约。`pnpm.cmd run verify:web-live-llm-evidence -- --dns-resolver=cloudflare_doh` 已不再误报 `unexpected_failure`，当前因缺少 Tavily key 在 Provider 请求前安全跳过。随后 `pnpm.cmd run verify:web-release` 通过（Provider/Tavily 19/19、LLM boundary 1/1、live入口 3/3、迁移回退和产物扫描）；本轮没有发生真实 Provider、网页或 LLM 请求。真实 Tavily search→fetch→citation、真实网页 evidence LLM、正式渠道、签名包和干净 Windows 生命周期仍未完成。

本轮渠道可见性与 Webhook 链路收口（2026-09-01 22:46:00，实施中）：修复共享 `formatWebEvidenceSources()` 丢失 `fetchedAt`、且零 citation evidence 被静默省略的问题。CLI、Webhook 和其他文本渠道现在对每条来源显示抓取时间；disabled、unconfigured、rate-limit 等无来源 evidence 仍显示“无已验证来源”及脱敏的人类可读状态，不输出 `web_*` 内部诊断。新增 `packages/channels/webhook/src/channel-integration.test.ts`：它用临时 binding store、真实 `DefaultChannelManager`、真实 loopback `WebhookChannelPlugin` 和 HTTP POST 验证组合链路中的来源/时间/partial/truncated/blocked/citation 投影以及正文/query/error kind 零泄露。`verify:web-channel-boundary` 31/31、补充渠道集合 61/61、Types/Plugins/Webhook typecheck 和已接入该门的 `verify:web-release` 全部通过；不使用 Provider、外网、LLM 或第三方渠道凭证。该本机 Webhook 证据不能替代 QQ、飞书、Telegram 或外部反向代理的正式运行时验收，且签名/干净 Windows 与真实 Tavily 门仍未完成。

当前实现状态：本文件既是专项唯一执行入口，也是当前代码基线的详细交付清单；只将已经有代码、测试和对应验收证据的事项标为完成，局部实现不得等同于阶段完成。

关联文档：

- [架构原则](../principles/architecture-principles.md)
- [核心 Agent 流程规范](../principles/core-agent-flow-guidelines.md)
- [仓库指南](../reference/repository-guide.md)
- [Core Flow 状态契约](../reference/core-flow-state-contract.md)
- [插件开发说明](../reference/plugin-development.md)
- [网络检索冻结契约与威胁模型](../reference/web-retrieval-security-contract.md)
- [文档决策入口](../README.md)

外部调研依据：

- [OpenAI Web Search 官方文档](https://developers.openai.com/api/docs/guides/tools-web-search.md)
- [OpenClaw Web Search](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/web.md)
- [OpenClaw Web Fetch](https://raw.githubusercontent.com/openclaw/openclaw/main/docs/tools/web-fetch.md)
- [OpenCode Web Search](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/websearch.ts)
- [OpenCode Web Fetch](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/tool/webfetch.ts)
- [Kimi CLI Search](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/main/src/kimi_cli/tools/web/search.py)
- [Kimi CLI Fetch](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/main/src/kimi_cli/tools/web/fetch.py)
- [Qwen Code Web Search](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/tools/web-search.ts)
- [Qwen Code Web Fetch](https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/tools/web-fetch.ts)
- [OpenManus Web Search](https://raw.githubusercontent.com/FoundationAgents/OpenManus/main/app/tool/web_search.py)
- [Pi Session Search](https://raw.githubusercontent.com/earendil-works/pi/main/packages/agent/docs/search.md)

> 历史与当前状态边界：本任务书保存本专项的设计和阶段验收，不维护全项目最新测试数字。当前实现、测试结果和其他 P0 阻断项仍以项目状态、源码和对应专项任务书为准。

## 0. 执行摘要

LS 要获得实时资料能力，不应在本机维护一份完整互联网索引，也不应把某一个模型厂商的原生联网协议硬编码成核心基础设施。推荐实现一个由 Runtime 统一治理的本地检索层：

~~~tex
用户意图
  -> 安全检索路由
  -> web_search -> 可插拔 SearchProvider -> 归一化搜索结果
  -> web_fetch  -> 本地受控 HTTP 获取 -> 正文抽取
  -> 证据/引用/缓存/审计
  -> LLM 基于有界、带来源的外部资料生成回答

浏览器自动化只作为 JS、登录态、验证码和交互页面的后备能力。
~~~

本专项冻结以下核心决定：

1. 本地记忆查询和明确受控的公共网络只读检索属于 safe read，免除逐次交互批准。
2. 免除的是每次调用的审批，不是网络能力的配置授权、数据外发披露、配额、审计和安全硬规则。
3. 权限判断从单一 action/boundary 扩展为 effect、egress、trust、resource boundary 四类信号。
4. web_search 与 web_fetch 必须是两个独立能力：搜索负责发现和排名，抓取负责获取和抽取。
5. 搜索 provider 可替换；MVP 先接一个 API-backed provider，同时保留中文 provider、自托管 SearXNG 和 hosted-native adapter 的扩展位。
6. web_fetch 默认由 LS 本地安全 HTTP 栈执行，不默认启动浏览器，不携带 Cookie、Authorization 或用户登录态。
7. 网页内容永远是 external_untrusted data，不能改变 Runtime 状态、权限、工具范围或记忆写入策略。
8. 实时网页内容默认不写入长期记忆；只有用户明确要求保存且通过现有 Memory Write Gate，才可生成带来源、时间和失效信息的记忆。
9. 顶层活动仍保持 respond、execute、clarify 三种语义；简单联网问答使用 execute 下的 compact retrieval 策略，不启动完整重型 TaskBook。
10. 当前任务书完成后，LS 应能明确区分“本地记忆搜索”“工作区搜索”“实时网页搜索”和“浏览器交互”，不能把它们统称为模糊的 search。

实现阶段必须逐步修改契约、测试、文档和 UI，任何阶段都不能通过提示词暗示模型自行绕过 Runtime 权限。

### 0.1 当前实施基线（2026-08-30）

下表是本任务书的恢复锚点。它描述的是当前工作树已经可见的专项代码状态，不是对用户可用能力的宣称；任何后续执行必须先用源码和定向测试重新验证。

| 范围 | 当前状态 | 已有事实 | 尚缺的闭环 |
| --- | --- | --- | --- |
| 冻结语义与威胁模型 | 已完成 | safe read、显式 opt-in、Tavily MVP、无隐式 fallback、SSRF/注入/日志规则已冻结 | 持续将规则落实到所有调用入口和回归测试 |
| 公共类型、配置与 RunConfig | 已完成（定向契约） | `NetworkReadPolicy`、Web port、`web.maxQueryChars`、有界 evidence projection、脱敏 provider snapshot 已落地 | 在真实 run 中实际消费这些字段，并持续保持向后兼容 |
| 中央 Safety descriptor 与执行入口 | 已完成（WB-01 子门） | `effect/egress/trust/safeReadClass/hardDecision`、`strictReadApproval`、hard deny 短路、ToolExecutionService/direct proposal/scheduler/Main 回查已落地并通过定向回归 | 仍需在真实 `web_search`/`web_fetch` 工具接入后保持同一结论；URL/DNS/redirect 属于网络领域层，不因本子门完成而视为完成 |
| `@littlesheep/web` 领域层 | 已完成（WB-03 领域安全门） | Provider registry/Tavily、严格 secret resolver、URL/DNS/IP/redirect、固定地址匿名 GET、wire/decompress/extractor/cache 上限、取消/超时、quota/concurrency/retry/total deadline 和稳定错误均有离线测试 | 内置工具、模型正文/durable 双投影和 UI projection 已由 WB-04/WB-05/WB-08 接通；独立真实 `web_fetch` smoke 已在显式 Cloudflare DoH 下通过，真实 Tavily search 结果关联 fetch/citation 仍待 WB-09 |
| Runner 注入 | 已完成（WB-02） | 每个 run 按脱敏 provider snapshot 与 registry 状态双重 gate 创建独立 `WebRetrievalRuntime`；只共享 registry/cache，不共享 quota、citation、abort 或 deadline；结束时统一 dispose；evidence projection 可进入 checkpoint/log/replay | 工具、模型正文/durable 双投影和 Harness 数据流已由 WB-04/WB-05/WB-06 接通；真实 Provider、搜索结果到页面的关联 fetch 仍待 WB-09；网络关闭或 provider 未配置时继续保持零调用 |
| `web_search` / `web_fetch` 工具 | 已完成（WB-04） | 两个 strict 内置工具、统一 registry/ToolExecutionService、敏感 query egress 和最终 capability gate 已落地并有定向回归 | 真实公共 `web_fetch` smoke 已通过；真实 Tavily Provider search/citation 和发布状态仍待 WB-09 |
| Evidence、持久化与 citation | 已完成（WB-05） | 模型正文与 durable projection 双投影、citation 绑定/校验、checkpoint/log/replay 隔离已闭合 | 真实 Provider 的证据仍待 WB-09；来源 UI 的 Electron 端验收仍需收口 |
| Harness 检索路由 | 已完成（WB-06） | `RetrievalIntent`、compact retrieval、TaskBook 路由、工具集过滤和 final citation validation 已落地 | 真实网络条件下的最终行为仍待 WB-09 |
| Memory 协同、App、渠道 | 已完成（WB-07/WB-08） | Memory-first 最小 query、web 写入闸门、Web 设置页/API、来源 projection、CLI/channel formatter 已落地 | Electron 状态连续性已通过；真实 Provider 联调和渠道正式验收仍待收口 |
| 真实网络与发布 | 进行中（WB-09） | 隔离 smoke runner、迁移/回退 verifier、供应链审查、构建产物扫描、显式 Cloudflare DoH 下真实公共页面 `web_fetch`、真实 Tavily search、Web Runtime 性能基线、来源卡/formatter 投影测试、真实 DeepSeek V4 Flash 最终回复 evidence 验收、稳定工作树全量回归、Electron 验收路径和 release 候选扫描已准备并有证据 | 用户终端测试 key 已证明 1 次 Tavily search 返回 3 个归一化结果；默认系统 DNS 下搜索结果关联 fetch 因当前 Fake-IP/SSRF 防护阻断，显式 DoH 下独立 public-fetch 已通过，但 Tavily 结果关联 citation 未完成。真实 Tavily + 网页 evidence 的端到端 LLM 联调、正式渠道运行、签名安装器、干净 Windows 安装/升级/卸载及发布当天复核仍待执行；不得以 mock、工具注册或仅模型流畅回答宣称可用 |

当前仍存在的发布阻断点如下：

1. 用户终端已使用测试 Tavily key 执行隔离 strict smoke：关闭网络零请求与真实 search（1 次 Provider 请求、3 个归一化结果）通过；默认系统 DNS 下搜索结果关联 fetch 被解析至保留网段后的 SSRF 检查阻断。当前已用显式 `--dns-resolver=cloudflare_doh` 真实通过独立匿名 public-fetch，但尚未在拥有 Tavily key 的同一终端完成 Tavily search→fetch→citation；仍需执行 DoH 版本的 `--require-live`，不能以独立 fetch 证据替代关联 citation、费用和地区可用性验收。
2. 当前稳定工作树的全量验证门已经通过：`pnpm.cmd run verify:full`（387 个测试文件、2642 项通过、1 项 skipped，另含 28 个 workspace TypeScript 项目、App build 和 recovery）；`pnpm.cmd run check:repo`（33 项）也通过，且运行前后 5 个 UI 文件指纹未变化。这些结果不替代真实 Provider、安全矩阵、迁移/回退、供应链或渠道验收。
3. Electron 实际窗口状态连续性已通过 `pnpm.cmd run verify:electron-ui-state-continuity`，覆盖 composer draft、conversation/project/sidebar、sidebar/file navigator width、settings、native window geometry 和 137px chat bottom reading gap；验收夹具等待 120ms resize settle 并显式派发用户滚动事件，仍要求锚点误差不超过 1px。这不替代真实联网和正式渠道运行时验收。
4. CLI/channel 已复用安全来源 projection，但 QQ、飞书、Telegram、Webhook 的正式运行时验收仍需在 WB-09/发布前完成。
5. 迁移/回退、依赖许可证/漏洞/供应链检查和 release 候选目录扫描已完成当前离线门；`release/win-unpacked`、NSIS 安装器候选及整个 `release` 目录均已扫描通过，未发现 provider secret、私密 fixture、用户 Memory 或绝对用户路径。安装器尚未签名，也未在干净 Windows 环境完成安装/升级/卸载。专项总体状态必须继续保持“实施中”，直到真实 Provider smoke、正式渠道运行时、签名/干净环境发布和其余发布门均通过。

### 0.2 不可拆分的用户可见闭环

以下十个条件构成一个最小的“实时资料能力”交付闭环。它们必须全部成立，才可以把任意入口显示为 `ready`；其中任一缺失时，界面和文档只能显示 `disabled`、`unconfigured`、`configured_unchecked`、`degraded` 或 `unavailable`。

1. 默认不联网，且网络关闭、未配置 provider 或未明确启用时零请求、失败关闭。
2. 用户明确需要实时资料时，Runtime 选择安全的最小检索路径，而不是把训练知识伪装成查证结果。
3. `web_search` 只外发被策略允许的最小 query，且不能让模型决定 endpoint、密钥、header 或 provider。
4. `web_fetch` 只能匿名、受控地 GET 已校验的公共 HTTP(S) 页面；scheme、DNS/IP、redirect、响应大小、解压和取消均受硬边界保护。
5. public web safe read 与 local memory safe read 在三种权限模式下免逐次审批，但认证、浏览器、外部文件、写入和执行不因此放开。
6. 网页和搜索摘要始终以 `external_untrusted` 证据封套进入模型，不能生成 Runtime 指令、权限事实或记忆写入。
7. 每个最终来源都能回溯到本轮真实的 provider/fetch evidence；模型不能自造 citation。
8. 模型可获得有界正文，但 session、checkpoint、日志和 UI 默认只持久化有界、脱敏的 projection，不保存完整网页正文或 provider 原始 JSON。
9. 用户请求结合项目历史时，Memory 和 Web evidence 分层；网页不会自动写入长期 Memory。
10. 有假 Provider、真实 opt-in Provider、SSRF、注入、取消、重启、缓存和 UI/渠道测试证据，并能一键禁用和回退。

### 0.3 任务书使用方式与执行状态定义

本任务书同时承担设计冻结、实施清单、验收记录和发布门四种职责，但四者必须分开阅读：

| 内容 | 作用 | 允许的证据 | 不能推出的结论 |
| --- | --- | --- | --- |
| 设计冻结 | 规定本专项应该如何工作 | 契约、威胁模型、接口和决策记录 | 代码已经实现 |
| 实施清单 | 指向代码、测试、配置和文档任务 | 修改文件、定向测试、类型检查 | 已经具备真实网络可用性 |
| 验收记录 | 记录某个时间点实际通过的门 | 命令输出、隔离数据根、测试报告和复现条件 | 未来版本无需重验 |
| 发布门 | 决定是否可以对外宣称 `ready` | 真实 Provider、真实渠道、最终包和干净环境证据 | mock、fixture 或模型流畅回答可以替代真实验证 |

每个工作包和阶段只能处于以下状态之一：

- `未开始`：尚无足够实现或验证材料。
- `进行中`：已有局部实现、失败证据或外部条件未满足；不得向用户宣称能力可用。
- `部分通过`：离线或隔离子门已通过，但仍缺真实环境、渠道或发布条件。
- `已完成`：该工作包自己的完成门已满足，但不代表整个专项可以发布。
- `ready`：仅允许专项 Definition of Done、真实 Provider、真实渠道、最终安装包和干净环境发布门全部通过后使用。

执行时必须先读本节和第 23 节的当前状态，再按第 14 节的依赖顺序行动。任务书中的历史证据不自动继承到新代码、新配置、新 Provider 版本或新发布包；任何易变外部事实都必须在发布当天复核。

### 0.4 最终实现蓝图

实现完成后，LS 的一次网络研究 run 应严格经过以下边界。每一层都必须有自己的输入校验、输出投影和失败状态，不能由模型把层级合并成一个“万能搜索工具”。

```tex
用户请求
  -> LLM 只提出 RetrievalIntent / 受限工具意图
  -> Runtime 判断是否需要 local memory、web_search、web_fetch 或 Browser
  -> local memory：本地索引读取，不外发
  -> web_search：Runtime 选择已配置 Provider API，得到归一化发现结果
  -> web_fetch：Runtime 本地匿名 GET，校验 DNS/IP/redirect 后抽取有界正文
  -> evidence ledger：登记 run-scoped citation、时间、hash、完整性和错误状态
  -> 模型 projection：有界正文 + external_untrusted 封套
  -> VERIFY：检查引用绑定、完整性、时效、冲突和是否足以支持结论
  -> FINALIZE：只发布真实 LLM 生成且经 Runtime 校验的回答
  -> durable projection：只持久化脱敏来源事实，不保存全文和秘密
```

以下事实必须在实现和验收中保持不变：

1. Memory、session、workspace 和 Web 是四种不同来源；来源混合时必须保留 source、时间和权威边界。
2. SearchProvider API 负责发现和排序；它不获得完整会话、Memory、附件、内部路径或凭证，也不替代 LS 的 fetch、citation 和持久化治理。
3. `web_fetch` 的公共读取范围只包含匿名 HTTP(S) GET；动态脚本、登录、验证码、表单、上传和浏览器身份进入独立 Browser/approval 边界。
4. `external_untrusted` 是数据属性，不是系统消息；网页文字没有改变工具、权限、状态机、配置或 Memory Write Gate 的能力。
5. 网络关闭、Provider 未配置、Provider 未通过真实检查、配额耗尽、超时、取消、SSRF 拒绝和引用不一致都必须失败关闭或返回明确的部分状态。

## 1. 背景与问题定义

### 1.1 用户问题

当前模型只能可靠利用训练数据、当前请求上下文和 LS 已经注入的本地记忆。以下问题需要新鲜外部资料：

- 今天、当前、最新、实时的新闻、版本、价格、政策、赛事或产品状态；
- 用户要求“查资料”“搜索网页”“给出来源”“联网确认”；
- 需要比较多个外部页面、核对官方文档或追踪近期变化；
- 需要把外部资料与用户自己的项目记忆、偏好或历史决策结合；
- 需要在模型不确定时明确返回“查不到、来源冲突或资料过期”，而不是用训练数据补全。

### 1.2 当前架构缺口

当前 LS 已有统一工具执行、权限、记忆、TaskBook、执行日志和恢复基础，但网络检索还缺少以下能力：

| 缺口 | 当前表现 | 需要补齐 |
| --- | --- | --- |
| 工具协议 | LLM 侧只有 OpenAI-compatible Chat Completions function tool | 新增普通 LS web_search/web_fetch 工具；原生 hosted search 另设 adapter |
| 权限语义 | restricted 对全部工具无条件要求批准 | 增加 safe read 判断；不能把任意 read 工具自动放行 |
| 网络边界 | 当前 path boundary 不能表达 URL、DNS、重定向和私网 | 增加 URL/IP/网络 egress 检查 |
| 搜索来源 | 没有 provider port 和结果归一化 | 增加 SearchProvider、provider registry 和稳定错误 |
| 页面获取 | 没有受控 fetch、正文抽取和截断标记 | 增加 HTTP GET、Readability/Markdown 抽取和限制 |
| 普通问答路由 | REPLY 当前不发送 tools | 把明确实时检索请求送入 compact retrieval 或受控工具循环 |
| 证据 | 工具证据可记录调用，但没有网页 citation 模型 | 增加 source、citationId、时间、hash、truncated 和引用校验 |
| 记忆协同 | 本地 memory 与外部资料没有 freshness/authority 区分 | 允许先查记忆、再查网；禁止把网页正文自动污染长期记忆 |
| 产品控制 | 没有网络读取开关、provider 状态和隐私说明 | 增加一次性/持久化网络读取配置和渐进式披露 |

关键代码基线：

- 权限读取集合和三档权限判定在 [permission-boundary.ts](../../packages/safety/src/permission-boundary.ts)；中央 safe-read descriptor、hard deny 的入口消费和 strict-read 回查已由 WB-01 收口；DNS/redirect 执行前复核仍属于 WB-03 网络领域层。
- 统一调用生命周期在 [tool-execution-service.ts](../../packages/tools/src/tool-execution-service.ts)；这里应继续作为最终审批、超时、取消、清洗和证据入口。
- 简单自主读取目前只允许 glob、grep、read，在 `compact-autonomous-read-task.ts`（已随极简方案删除，见 `docs/decision/project-status.md` 2026-09-21 条目） 中仍明确排除 network 和 memory。
- REPLY 当前是无工具的直接回答路径，在 [reply.ts](../../packages/harness/src/stages/reply.ts) 中没有把工具调用纳入普通回应。
- LLM 工具协议当前在 [types.ts](../../packages/llm/src/types.ts) 中仅定义 function tool；不能假定切换模型后自动获得厂商原生联网协议。
- Runner 当前在 [infra.ts](../../packages/runner/src/infra.ts) 装配 web provider registry、provider snapshot 和共享 cache，并由 [runner.ts](../../packages/runner/src/runner.ts) 按本轮 quota/timeout 创建独立 `WebRetrievalRuntime` 注入 `RunContext`；本轮 runtime 的 evidence、abort、citation 和 deadline 不跨 run 共享。

### 1.3 外部 Agent 的共同实现规律

前面调研的代表性项目显示，主流 Agent 几乎没有在客户端本机维护完整互联网索引：

| 项目 | 互联网能力 | 本地部分 | 对 LS 的启示 |
| --- | --- | --- | --- |
| Codex/OpenAI | Responses API hosted web_search | 调度、协议解析、事件和日志 | hosted search 是 provider，不应取代 LS 证据层 |
| Claude Code | hosted WebSearch/WebFetch，动态站点可交给浏览器 | 结果装配、页面处理和浏览器衔接 | 搜索、抓取、浏览器应分层 |
| OpenClaw | 多 provider：Brave、Exa、Tavily、Perplexity、Kimi、SearXNG 等 | HTTP fetch、正文抽取、缓存、SSRF 防护 | 可插拔 provider + 本地安全 fetch 最值得吸收 |
| OpenCode | Exa/Parallel 等远程搜索或 MCP | 本地 HTTP 获取、HTML 转 Markdown、大小/超时限制 | MCP 可以是 provider，不能绕过统一 Runtime |
| Pi agent | 核心没有互联网搜索 | JSONL/SQLite FTS/Elastic 的本地会话搜索 | “本地搜索”通常是会话/文件/记忆搜索，不是互联网索引 |
| Kimi CLI | Moonshot 搜索/Fetch 服务优先 | aiohttp、trafilatura fallback | 中文 hosted provider 与本地 fallback 可以共存 |
| Qwen Code | DashScope hosted web_search/web_extractor | WebFetch 处理和工具编排 | 模型原生搜索需 adapter，不应污染通用 LLM client |
| OpenManus | Google、Baidu、Bing、DuckDuckGo 页面或第三方库 | 直接抓页面 | HTML scraping 适合实验，不应成为生产默认 |

结论是：LS 应实现“本地检索网关”，而不是“本地互联网搜索引擎”。

### 1.4 LS 的最终实现决策：什么放在本地，什么调用 API

这是本专项最重要的边界，后续实现不得重新混淆：

| 能力 | LS 的实现方式 | 是否调用外部服务 | 原因与边界 |
| --- | --- | --- | --- |
| 本地 Memory Tree 导航、memory_search、session/experience 查询 | 本地 Runtime、索引和受控存储 | 默认不调用网络 | 用户私有上下文属于 LS 本地能力；若改用远程 embedding，必须另建 egress 策略，不能继续伪装成本地读取 |
| 互联网“找什么”——关键词搜索、排序、时间/域名过滤 | 调用已配置的 SearchProvider API；MVP 为 Tavily adapter | 是 | LS 不维护全网实时索引；Provider 只负责发现、排名和过滤，不接收完整会话/记忆 |
| 互联网“打开什么”——明确 URL 的公开页面 | LS 本地受控 HTTP(S) GET、DNS/IP/redirect 检查和正文抽取 | 直接访问目标网站，是 | 目标 URL 由 Runtime 校验；不携带 Cookie/Authorization，不由 Provider 代抓正文，不默认启动浏览器 |
| 搜索结果到页面正文的关联 | LS 本地 citation registry、URL binding 和 evidence ledger | 不新增外部服务 | 防止模型自造来源，并让 search 与 fetch 的证据可追溯 |
| 短期搜索/正文缓存 | LS 本地、独立于 Memory 的有界 cache | 默认不调用网络 | 只为减少重复请求；有 TTL、容量、scope 和清理，不等同长期记忆 |
| JS、登录态、验证码、点击/滚动等交互页面 | 独立 Browser Adapter | 可能访问网络 | 这是高能力浏览器操作，不属于 public safe fetch；默认需单独审批，不把浏览器 profile 交给模型 |
| OpenAI/Anthropic/Qwen 等模型原生联网协议 | `packages/web` 中可选 hosted-native adapter | 是 | 只作为一种 Provider/模型能力适配，不污染通用 Chat Completions tool contract；不支持该协议的模型仍走普通 LS tools |
| Google/Bing/Baidu 结果页 HTML scraping | 仅实验或显式配置的后备 adapter | 是 | 生产默认关闭，避免隐式改变条款、隐私、稳定性和结果语义 |

因此，MVP 的真实数据流固定为：

~~~tex
本地 Memory（可选）
       |
       v
最小化 query ──> SearchProvider API ──> 归一化候选与 citation
                                      |
                                      v
                 LS 本地匿名 HTTP GET ──> 公开页面正文
                                      |
                                      v
                 LS 本地 evidence/citation/cache/audi
                                      |
                                      v
                 LLM synthesis（正文带 external_untrusted 封套）
~~~

禁止的替代实现：在 Renderer 里直接请求搜索 API；在工具中读取 key 并拼接任意 endpoint；用 `exec`/浏览器偷偷搜索；provider 失败时静默改抓搜索结果页；把网页正文自动复制进长期 Memory；或为了“本地化”而在 MVP 内维护一个未经授权、不可更新、不可审计的全网索引。

## 2. 目标、非目标与完成定义

### 2.1 总目标

让 LS 在不依赖模型训练时点的前提下，能够：

1. 根据用户意图选择本地记忆、实时网页搜索、指定页面抓取或组合路径；
2. 获取有时间、来源、状态和完整性标记的外部资料；
3. 把资料作为有界证据提供给 LLM，生成可点击、可核查的引用；
4. 在研究和受限模式中免除安全读取的逐次审批；
5. 对隐私、成本、SSRF、网页注入、超时、限流、失败和部分完成保持可观测；
6. 在 provider 不可用时明确失败，不以训练记忆伪装成实时结论；
7. 让网络能力成为可替换、可禁用、可测试的 Runtime 组件。

### 2.2 非目标

本专项不包含：

- 在本机爬取并维护覆盖互联网的完整索引；
- 默认使用 Google、Bing、Baidu 搜索结果页 HTML scraping；
- 默认通过浏览器自动化搜索所有页面；
- 绕过验证码、登录限制、robots 规则、服务条款或访问控制；
- 让模型自行发送任意 HTTP method、header、cookie、body 或文件；
- 把每次搜索的完整网页正文自动写进长期记忆或向量库；
- 把 OpenAI、Anthropic、Qwen 等厂商的原生联网协议硬编码进通用 Chat Completions 类型；
- 用一个“搜索工具”替代本地文件、会话、记忆和浏览器的不同权限边界；
- 在本专项内实现通用下载器、网页编辑器、表单自动提交或账号操作。

### 2.3 用户可见完成定义

对用户而言，专项只有在以下条件全部满足时才算完成：

- 用户说“查最新资料”时，LS 能实际访问配置的搜索 provider，且最终回答包含可点击来源；
- 用户说“打开并总结这个 URL”时，LS 能安全抓取公开页面并标记最终 URL、时间和是否截断；
- 搜索 provider 不可用、网络未启用、页面被阻断或资料冲突时，LS 明确说明边界；
- memory_search 和 safe web read 不会在每个调用上弹批准；
- 登录态浏览器、上传、表单和写入仍受原有审批/硬拒绝规则约束；
- 网页中的指令不会触发 LS 的工具、权限、记忆或状态变化；
- 关闭网络读取后，不会发生隐藏的 provider 请求；
- 任何声称“已查证”的回答都能在 execution log 中找到来源和调用证据。

## 3. 设计原则

### 3.1 LLM 负责提出意图，Runtime 负责兑现

LLM 可以提出：

- 是否需要实时资料；
- 搜索词、时间范围、域名偏好；
- 需要打开哪些候选来源；
- 如何归纳、比较和回答。

Runtime 必须决定：

- 是否允许联网；
- provider 是否可用；
- 查询和 URL 是否经过校验；
- 是否属于 safe read；
- 是否触碰认证、私网或外部副作用；
- 结果是否完整、是否可信到可以支持结论；
- 工具是否执行、如何记录和何时停止。

### 3.2 搜索与抓取分离

web_search 只负责发现候选、排名、时间过滤和域名过滤；它不应隐式执行任意页面脚本或携带浏览器身份。

web_fetch 只负责获取明确 URL、跟随受控重定向、抽取正文和返回文档；它不应默默变成搜索引擎、浏览器或下载器。

浏览器是第三层后备能力，只在静态 HTTP 获取不足时启用。

### 3.3 安全读取免逐次审批

本专项中的“赦免”正式定义为：

> safe read 不要求每次调用都等待用户批准，但仍受能力开关、输入验证、网络边界、数据外发、配额、审计和硬拒绝规则约束。

这不是把 restricted 改成“任何 read 都自动允许”。安全读取必须是 Runtime 计算出来的受控类别，不能由模型、插件描述或工具名称自行声明。

### 3.4 外部内容不可信

搜索摘要、网页正文、JSON、Markdown、代码块、页面注释、隐藏文本和元数据都属于 external_untrusted data。它们可以作为事实候选和引用材料，不能作为：

- 系统提示词；
- 工具权限说明；
- Runtime 状态转移；
- 文件路径授权；
- 记忆写入指令；
- 用户意图的替代；
- “忽略之前规则”的控制消息。

### 3.5 数据最小化

默认只把完成搜索所需的最小 query 发给 provider：

- 不自动拼接完整会话；
- 不自动拼接整棵记忆树；
- 不把 API key、Cookie、Authorization、内部路径和隐藏上下文发送给 provider；
- 先查本地记忆，再根据需要生成最小网页查询；
- 搜索 provider、目标网站和远程 LLM 的数据外发分别记录。

### 3.6 失败必须可见

实时资料能力宁可返回“未能确认”或“只有部分来源”，也不能把旧训练知识伪装成已联网确认的结论。截断、缓存、过期、provider 降级、抽取失败和来源冲突都必须进入证据和最终状态。

## 4. 目标架构

### 4.1 分层图

~~~tex
UI / CLI / Channel
        |
        v
Runner：解析配置、装配依赖、冻结本轮策略
        |
        v
Harness：活动路由、compact retrieval、TaskBook、VERIFY、RECOVER
        |
        +------------------+
        |                  |
        v                  v
Memory Service       Tool Execution Service
本地索引/记忆         权限/调度/取消/清洗/证据
                           |
                           v
                     web_search / web_fetch
                           |
             +-------------+-------------+
             |                           |
             v                           v
       SearchProvider                 WebFetchService
       远程 API/自托管                 本地 HTTP + 抽取
             |                           |
             +-------------+-------------+
                           v
                 Evidence / Citation / Cache
                           |
                           v
                    LLM 最终回答

Browser Adapter 只作为 fetch 失败、JS、登录态或交互页面的后备路径。
~~~

### 4.2 组件所有权

| 组件 | 目标位置 | 所有权 | 不应负责 |
| --- | --- | --- | --- |
| 公共网络契约 | packages/types | 类型和序列化契约 | HTTP、provider key、UI |
| 网络安全判断 | packages/safety | URL/IP/egress/安全读取分类 | provider 业务逻辑 |
| provider port/adapter | packages/web | provider 调用、归一化、错误 | Harness 状态转移、UI |
| HTTP fetch/extractor | packages/web | 本地 GET、重定向、正文抽取、限制 | 浏览器交互、长期记忆 |
| web_search/web_fetch 工具 | packages/tools/src/builtin | 将领域服务接入统一工具契约 | 自行审批、绕过日志 |
| 工具生命周期 | packages/tools | 查找、schema、审批、调度、超时、清洗、记录 | provider 内部排序 |
| 检索路由 | packages/harness | 识别意图、选择 compact/TaskBook、校验结果 | 直接执行 HTTP |
| 依赖装配 | packages/runner | provider、fetch、配置、生命周期 | 复制网络算法 |
| 设置/来源展示 | packages/app | 网络开关、provider 状态、引用 UI | 决定权限事实 |
| 外部浏览器 | browser/plugin adapter | 页面交互和登录态 | 默认为搜索路径 |

### 4.3 新增包的建议边界

建议新增 packages/web，目标包名为 @littlesheep/web。最终名称在阶段 0 冻结，但不能把复杂 provider 和 HTML 抽取长期堆进 packages/tools 或 packages/runner。

建议目录：

~~~tex
packages/web/
  src/
    contracts.ts
    provider.ts
    provider-registry.ts
    providers/
      <first-provider>.ts
      <optional-provider>.ts
    fetch/
      http-client.ts
      url-policy.ts
      redirect-policy.ts
      extract.ts
      content-limits.ts
    cache/
      web-cache.ts
    errors.ts
    index.ts
  package.json
  README.md
  src/*.test.ts
~~~

该包只提供可测试的领域服务和端口；所有真实工具调用仍通过 Tool Execution Service。

## 5. 权限、外发与信任模型

### 5.1 Access Descriptor 扩展

在现有 ToolAccessDescriptor 基础上增加以下可计算字段。字段名称可以在阶段 0 微调，但语义不可丢失：

~~~tex
effect:
  none | read | write | execute | external

egress:
  none | public_query | public_url | authenticated | unknown

trust:
  runtime_owned | external_untrusted

safeReadClass:
  local_memory | local_session | public_web_search | public_web_fetch
  authenticated_read | arbitrary_read | none

boundary:
  inside | outside | unknown

hardDecision:
  allow | approval | deny
~~~

descriptor 必须根据解析后的输入和 Runtime 配置计算，而不是只看 tool.requiresApproval。比如：

- 同一个 web_fetch 工具，匿名 HTTPS 公共 URL 可以是 public_web_fetch；
- 带用户名密码的 URL、私网地址或需要 Cookie 的 URL 必须是 authenticated/unknown；
- 同一个浏览器工具即使最后只读取页面，也不能自动归类为 public_web_fetch；
- 同一个 memory_search 若使用远程 embedding，应保留 local_memory 的 effect，但把 egress 标为 provider-dependent，并由网络外发策略单独处理。

### 5.2 Safe Read 判定

建议把权限判定收敛为以下顺序：

~~~tex
1. 解析输入并执行硬拒绝检查
2. 计算 effect / egress / trust / boundary
3. 若 hardDecision = deny，立即拒绝
4. full 模式按现有策略放行，但不能越过硬拒绝
5. 若 safeReadClass 是 local_memory/local_session，且 Runtime 允许安全读取，自动放行
6. 若 safeReadClass 是 public_web_search/public_web_fetch，
   且 networkReadEnabled、provider/domain/URL 检查通过，自动放行
7. authenticated、unknown、outside file、write、execute、external 进入审批
8. 没有审批回调时，审批分支 fail closed
~~~

restricted 的新目标语义：

> 有影响的工具和未明确界定的工具都需要批准；受控安全读取可以自动执行。

现有 research 仍保留其容器内读取语义；网络 safe read 是否自动执行不再由容器路径决定，而由 networkReadEnabled 与网络安全分类共同决定。

### 5.3 权限矩阵

| 能力 | full | research | restricted | 额外条件 |
| --- | --- | --- | --- | --- |
| 本地 memory_search | 自动 | 自动 | 自动 | 本地或已明确允许的记忆后端 |
| 本地 memory_tree/deep_search | 自动 | 自动 | 自动 | 只改变 run working set，不写持久状态 |
| 容器内普通 read | 自动 | 自动 | 仍按严格读取策略 | 不因 safe memory 例外而全面放开 |
| 公共 web_search | 自动 | 自动 | 自动 | 网络读取已启用，query 通过最小化和敏感性检查 |
| 匿名公共 web_fetch | 自动 | 自动 | 自动 | HTTPS/HTTP 受控 GET，SSRF 和大小限制通过 |
| 外部文件 read | 自动 | 需要批准 | 需要批准 | 路径边界仍有效 |
| 浏览器公共页面 | 按 full 规则 | 需要批准 | 需要批准 | 浏览器具有脚本、身份和交互能力 |
| Cookie/认证站点 | 按 full 规则 | 需要批准 | 需要批准 | 不属于 safe public read |
| POST/上传/表单/下载落盘 | 仍受硬规则 | 需要批准 | 需要批准 | 不能由 web_fetch 代发 |
| write/edit/exec | 按 full 规则 | 需要批准 | 需要批准 | 核心源码和危险命令硬拒绝仍优先 |

### 5.4 一次性网络授权

网络读取的“配置授权”与每次工具审批必须分离：

- local memory safe read 默认可用；
- web safe read 只有在网络读取能力已启用且 provider 已配置时可用；
- 第一次启用时可以通过设置页、首次使用提示或用户明确配置完成一次授权；
- 后续同一配置下的公共搜索和匿名抓取不再逐次弹窗；
- 用户可以随时关闭网络读取，关闭后工具不可用，不允许模型通过 exec 或浏览器偷偷恢复；
- 可提供 strictReadApproval 高级选项，供高度敏感环境重新要求每次读取审批；
- UI 必须明确显示查询会发送给哪个 provider、页面请求会被哪个站点看到，以及是否使用缓存。

“用户明确说请搜索”可以作为本次检索意图，但不能在没有任何网络能力配置和披露的情况下静默建立持久联网授权。

### 5.5 数据外发边界

必须分别记录以下三条可能的数据流：

~~~tex
用户输入/最小查询 -> SearchProvider
用户指定 URL       -> 目标网站
搜索结果/网页正文  -> 配置的 LLM Provider
~~~

默认规则：

- provider API key 只能来自环境变量、系统密钥链或受控密钥引用；
- API key 不进入 prompt、工具结果、错误、execution log、缓存键或 UI；
- query 默认不包含完整历史、完整记忆和附件原文；
- URL 禁止用户名密码；疑似 token、签名参数或内部地址要拒绝或脱敏；
- 默认不带 Cookie、Authorization、Referer 和浏览器 profile；
- 远程 LLM 收到网页正文时，必须携带来源、时间、截断和 external_untrusted 标记；
- memory 结果是否可以进入远程 LLM 请求，仍由现有 Context/Provider 策略控制，不由 web 工具偷偷扩大范围。

## 6. 网络安全硬规则

### 6.1 URL 和协议

只允许显式的 http 和 https。拒绝：

- file、data、javascript、vbscript、blob 等 scheme；
- 空 URL、解析失败 URL、控制字符和非法编码；
- 用户名/密码部分；
- 未知或不支持的协议升级；
- 将 URL 当作本地路径解析的歧义输入。

### 6.2 SSRF 与地址边界

web_fetch 每次请求前必须：

1. 解析主机名并规范化大小写、尾点和 IPv6 表示；
2. 拒绝 localhost、127.0.0.0/8、0.0.0.0、::1、私有地址、link-local、广播地址和云 metadata 地址；
3. DNS 解析后对实际 IP 再做一次同样检查；
4. 每次重定向重新执行 host/IP 检查；
5. 防止 DNS rebinding：连接使用的实际地址必须与检查结果一致；
6. 允许配置域名 allowlist/blocklist，allowlist 优先于通用公共访问；
7. 不允许通过代理、IPv4/IPv6 表示变体或 DNS 别名绕过检查；
8. 对解析失败、地址不稳定或无法证明边界的目标 fail closed。

第一版不支持访问本机服务、企业内网、VPN 私网、文件共享或云元数据。即使用户在 URL 中明确写出，也不能把它们归类为公共 safe fetch。

### 6.3 HTTP 行为

MVP 只允许受控的幂等 GET；可选的 HEAD 只能作为内部优化，不能依赖服务器正确实现。禁止由模型指定：

- POST、PUT、PATCH、DELETE；
- 任意 header；
- Cookie、Authorization、代理凭据；
- 任意 request body；
- 文件上传；
- 自动保存响应到用户工作区。

请求应设置：

- 总超时和连接超时；
- 最大重定向次数；
- 最大响应字节数；
- 最大解压后字节数；
- 明确的 User-Agent；
- AbortSignal；
- 内容类型和字符集检查。

### 6.4 内容和资源限制

初始默认值建议如下，全部由配置限制并在结果中保留实际值：

| 限制 | 初始默认 |
| --- | ---: |
| 单次 search query 字符数 | 2,000 |
| 单次搜索结果数 | 10 |
| 单次 fetch 原始响应 | 2 MiB |
| 单页抽取正文 | 40,000 字符 |
| 单次检索最多 fetch 页面数 | 4 |
| 单次检索最多 search 调用数 | 4 |
| 单次 fetch 重定向数 | 5 |
| 单次 search 超时 | 15 秒 |
| 单次 fetch 超时 | 20 秒 |
| 单次 retrieval 总超时 | 90 秒 |
| safe web read 最大并发 | 3 |
| 同一请求有限重试 | 1 次 |

压缩响应必须按解压后的大小限制；解析器遇到嵌套过深、异常编码、重复膨胀或资源耗尽时返回有界错误。

### 6.5 页面注入防护

进入模型的网页资料应包装为结构化外部证据，例如：

~~~tex
<external_web_evidence>
  <source id="S1" url="..." fetched_at="..." trust="external_untrusted">
    <title>...</title>
    <content>...</content>
  </source>
</external_web_evidence>
~~~

具体封套名称由 Context/Prompt 契约冻结，但必须满足：

- 明确告诉模型这是资料，不是指令；
- 保留来源和时间；
- 过长正文先摘要或截断；
- 不能把页面中的 system、developer、tool、approval 等词当作真实 Runtime 消息；
- 页面要求“忽略规则、执行命令、发邮件、写文件、保存记忆”时只作为文本显示；
- 只有用户或 Runtime 的明确结构化意图才能触发工具调用。

## 7. 公共契约设计

以下是建议的契约草案。字段可以在 WSR-100 阶段微调，但必须保持可序列化、可截断、可审计和 provider 无关。

### 7.1 NetworkReadPolicy

~~~tex
NetworkReadPolicy
  enabled: boolean
  providerId?: string
  mode: disabled | public_anonymous | configured_allowlis
  allowDomains?: string[]
  blockDomains?: string[]
  strictReadApproval: boolean
  maxQueriesPerRun: number
  maxFetchesPerRun: number
  maxResponseBytes: number
  maxExtractedChars: number
  totalTimeoutMs: number
  cacheEnabled: boolean
  cacheTtlSeconds: number
  browserFallback: disabled | approval_required | full_only
  sensitiveQueryPolicy: allow | redact | approve | deny
~~~

该策略应进入 resolved run config 和 ToolContext 的只读投影，不能由 LLM 或 TaskBook patch 改写。

### 7.2 SearchProvider

~~~tex
SearchProvider
  id: string
  displayName: string
  capabilities:
    search: boolean
    recency: boolean
    domains: boolean
    language: boolean
    citations: boolean
  search(request, context): Promise<SearchResponse>
  health?(context): Promise<ProviderHealth>
~~~

provider 接口只接收已校验、已最小化的 SearchRequest；不接收完整 RunContext、会话历史、记忆树或任意工具集合。

### 7.3 SearchRequest / SearchResponse

~~~tex
SearchReques
  query: string
  domains?: string[]
  excludeDomains?: string[]
  recency?: today | week | month | year | custom
  from?: string
  to?: string
  language?: string
  maxResults: number
  runId: string
  signal: AbortSignal

SearchResponse
  provider: string
  query: string
  results: SearchResult[]
  fetchedAt: string
  cached: boolean
  partial: boolean
  providerRequestId?: string
  warnings: string[]

SearchResul
  rank: number
  title: string
  url: string
  canonicalUrl?: string
  snippet?: string
  publishedAt?: string
  siteName?: string
  language?: string
  citationId: string
  sourceStatus: search_result | cached_result | partial
~~~

provider 返回的任何额外字段都必须经过归一化和有界清洗，不得把原始 API 响应直接放入模型上下文。

### 7.4 FetchRequest / FetchedDocumen

~~~tex
FetchReques
  url: string
  citationId?: string
  maxChars?: number
  purpose?: user_url | search_followup | verification
  signal: AbortSignal

FetchedDocumen
  requestedUrl: string
  finalUrl: string
  redirectChain: string[]
  status: number
  contentType: string
  title?: string
  publishedAt?: string
  extractor: readability | markdown | plain_text | json | none
  content: string
  contentHash: string
  fetchedAt: string
  cached: boolean
  truncated: boolean
  externalUntrusted: true
  warnings: string[]
~~~

第一版只承诺 HTML、text/plain 和有限 JSON；PDF、图片 OCR、音视频和需要浏览器渲染的页面列为后续能力，不应通过隐式下载实现。

### 7.5 Citation / Evidence

~~~tex
WebCitation
  id: string
  url: string
  title?: string
  provider?: string
  publishedAt?: string
  fetchedAt: string
  status: search_result | fetched | cached | blocked | partial
  contentHash?: string
  truncated: boolean

WebEvidenceBundle
  query?: string
  citations: WebCitation[]
  documents?: FetchedDocument[]
  generatedAt: string
  completeness: complete | partial | none
  conflicts?: string[]
~~~

Citation id 必须由 Runtime 生成并绑定到真实搜索/抓取记录。LLM 只能引用已经提供的 id，不能自行发明 URL 或来源。

### 7.6 工具 schema

~~~tex
web_search
  query: string
  domains?: string[]
  excludeDomains?: string[]
  recency?: string
  language?: string
  maxResults?: number

web_fetch
  url: string
  citationId?: string
  maxChars?: number
~~~

工具输入不包含 method、headers、cookies、body、proxy、credential 或 outputPath。所有上限由 Runtime 再次裁剪，不能以 schema 上限作为唯一安全边界。

## 8. Provider 策略

### 8.1 MVP provider 原则

第一版只接一个明确可配置的 API-backed provider，避免同时引入多个外部服务、多个计费体系和多个故障面。provider 选择由部署场景决定：

- 全球通用：Brave、Tavily 或 Exa 中选择一个；
- 中文资料：Moonshot 或 DashScope/Qwen 作为可选适配；
- 隐私/自托管：SearXNG 作为后续 provider；
- Firecrawl、Jina 类服务：作为抓取或抽取 fallback，不作为默认搜索入口；
- OpenAI/Anthropic/Qwen 原生搜索：作为独立 hosted-native adapter；
- Google/Bing/Baidu 结果页 scraping：仅实验或显式配置，不作为生产默认。

具体第一 provider、费用、地区可用性和许可证在 WSR-005 冻结；代码不能把 provider 名称散落在 Harness、UI 和工具中。

### 8.2 Provider registry

Registry 负责：

- 按 provider id 解析适配器；
- 检查配置和密钥引用；
- 报告能力和健康状态；
- 在 provider 不可用时返回稳定错误；
- 不自动切换到未授权的 provider；
- 保留实际 provider id 供证据和 UI 展示。

Fallback 规则：

1. 同一 provider 的有限重试；
2. 用户已经配置且策略允许的第二 provider；
3. 本地 fetch 只用于抓取明确 URL，不能把它伪装成搜索；
4. 没有可用 provider 时明确失败。

不能无提示地从 API 搜索降级为搜索引擎 HTML 抓取，因为这会改变隐私、稳定性、服务条款和数据外发语义。

### 8.3 API key 与配置

支持以下密钥来源：

- 环境变量引用；
- 操作系统密钥链；
- 现有受控 secret resolver；
- 测试中的内存注入。

不允许：

- 把真实 key 写入仓库；
- 把 key 放在 TaskBook、Prompt、ToolResult 或 execution log；
- 用 URL query 参数传递 key；
- 在 provider 错误中回显 Authorization；
- 用模型输出作为密钥来源。

### 8.4 Hosted-native adapter

Hosted-native adapter 的职责是把某个厂商原生搜索协议翻译成 SearchResponse/WebEvidenceBundle。它可以使用 Responses API 或其他专用协议，但必须：

- 位于 packages/web 的 adapter 层；
- 不改变通用 LlmClient 的 function tool 契约；
- 把厂商 annotation、source、search call 和页面结果归一化；
- 允许不支持该协议的模型继续使用普通 web_search 工具；
- 在能力声明中明确 provider/model 依赖。

## 9. 本地 Web Fetch 与正文抽取

### 9.1 Fetch pipeline

标准顺序：

~~~tex
输入 schema 校验
  -> URL canonicalize
  -> scheme/credential/host/IP 检查
  -> DNS 解析与 rebinding 检查
  -> 受控 GET
  -> 每次重定向重新检查
  -> 响应大小/类型/编码检查
  -> HTML/text/JSON 抽取
  -> 清除脚本、样式、导航噪声和危险控制字符
  -> 内容截断并标记
  -> contentHash
  -> FetchedDocument + Citation
~~~

### 9.2 抽取策略

MVP 优先保证可解释和稳定：

- HTML 使用成熟的 Readability 或同等正文抽取器；
- Markdown 转换保留标题、段落、列表、表格和链接的基本语义；
- text/plain 保留正文；
- JSON 只返回有界、可序列化的结构化内容；
- 脚本、iframe、style、事件属性和隐藏导航不进入正文；
- 原始 HTML 默认不进入 LLM Context；
- 抽取失败时可以返回有限标题/摘要和明确错误，但不能假称正文完整。

依赖引入必须遵守生产依赖安全记录，固定版本、许可证和移除条件；不能因为一个 extractor 方便就把未经审计的大型浏览器栈放进核心。

### 9.3 缓存

缓存分为：

- search result cache：短 TTL，键由 provider、规范化 query 和过滤参数组成；
- fetched document cache：短 TTL，键由规范化 URL、请求策略和内容版本组成；
- no durable memory：缓存不是长期记忆，也不能进入 Memory Tree 的业务 Atom。

缓存要求：

- 不把 secret 放进 key；
- 可按设置关闭；
- 有大小、条目数和过期清理；
- 结果中标记 cached；
- 用户清除网络数据时能清除；
- 进程重启后缓存损坏只降级，不阻断 LS；
- 缓存正文的保留期限和位置属于用户数据政策，不能隐式无限保留。

### 9.4 浏览器后备

浏览器能力单独建模为 authenticated/interactive read：

- 默认不作为 web_search/web_fetch 的内部实现；
- 需要 JS 渲染、登录、验证码或交互时才候选；
- 研究和受限模式要求单独批准；
- 不把 cookie、localStorage、profile、密码或完整页面会话交给模型；
- 浏览器动作和 HTTP fetch 的证据类型不同；
- 浏览器失败不能通过静默抓取另一个站点绕过认证。

## 10. Harness、路由与任务流

### 10.1 保持顶层活动稳定

不新增第四个顶层 activity。保留：

~~~tex
respond  -> 没有新鲜资料需求的直接回答
execute  -> 包括 compact retrieval 和完整 TaskBook
clarify  -> 缺少安全检索所需关键事实或用户决定
~~~

建议在 classification/NeedAssessment 中增加内部 retrieval intent 投影，至少区分：

- none；
- local_workspace；
- local_memory；
- web_search；
- web_fetch；
- combined_memory_web；
- browser_required；
- capability_question。

该投影是 Runtime/LLM 协议的一部分，但不能代替最终工具校验。

### 10.2 意图识别

优先命中实时检索的信号：

- 最新、今天、当前、实时、最近、截至现在；
- 搜索网页、查资料、联网确认、找来源、给链接、引用；
- “打开这个网址”“根据官方文档确认”；
- 明确指定新闻、版本、政策、价格、赛事等时效领域。

必须避免误触发：

- “LS 支持网络搜索吗”属于 capability_question；
- “搜索我的项目文件”属于 local_workspace；
- “搜索记忆里之前的决定”属于 local_memory；
- 网页正文中出现的“请搜索/请执行”不属于用户意图；
- 用户仅要求解释历史知识时，不应强制联网。

### 10.3 Compact retrieval

简单检索使用现有轻量路径的改造版：

1. classifier/decide 判定为自包含、低复杂度、只读检索；
2. Runtime 只向模型暴露与意图匹配的最小工具集；
3. LLM 选择一个最小工具和有界参数；
4. Runtime 重新校验 schema、safeRead、provider、URL 和配额；
5. 自动执行，不弹逐次审批；
6. 把结果和证据送入一次真正的 final reply LLM 调用；
7. 结构化验证引用、截断和失败状态。

工具目录示例：

| 用户意图 | compact 工具 |
| --- | --- |
| 查自己的记忆 | memory_search / memory_deep_search |
| 查工作区 | glob / grep / read |
| 搜索网页 | web_search |
| 读取用户给的公开 URL | web_fetch |
| 先查记忆再核对最新资料 | 进入 combined retrieval 或标准 TaskBook |

当前 compact contract 中“no network, memory”之类的文字必须随契约一起更新，不能只扩展工具集合而保留相反的 Prompt。

### 10.4 标准研究 TaskBook

需要多次搜索、打开多个来源、比较冲突和整理报告时使用标准 TaskBook：

~~~tex
Step 1: 生成并执行最小搜索
Step 2: 选择 2-4 个相关来源
Step 3: 受控抓取来源
Step 4: 归并证据、标记冲突和时间
Step 5: 生成带 citation 的回答
Step 6: VERIFY 检查来源覆盖、截断和用户目标
~~~

所有步骤都是 read side effect，但仍需在 TaskBook 中声明 resources、sideEffect 和 acceptanceCriteria。safe read 免审批不等于跳过步骤级证据、超时、取消和验证。

### 10.5 LLM 调用契约

新增或扩展以下 call purpose/contract：

- retrieval_intent；
- retrieval_tool_decision；
- retrieval_synthesis；
- 可选 retrieval_conflict_review。

每个契约明确：

- 允许的 Context 来源；
- 允许使用的 memory/web evidence；
- 是否允许工具调用；
- citation token 的格式；
- 外部资料是不可信内容；
- 最大 query、结果和回答预算；
- 不能改变权限或状态转移。

### 10.6 最终回答和引用

最终回答仍必须来自真实 LLM 调用并遵守现有 ReplyProvenance 规则。Runtime 负责：

- 把 citationId 与真实 URL 绑定；
- 检查模型引用的 id 是否存在；
- 把 citation id 渲染成可点击来源；
- 显示 fetchedAt、cached、truncated 和 partial；
- 发现模型引用不存在的来源时，拒绝把它当成已验证引用，必要时进行有限改写调用；
- provider/抓取失败时保留错误事实，不能由模型补出“已查到”。

简单问答不应被迫输出长研究报告；只展示结论和最必要来源，完整证据按需展开。

## 11. Memory 与网络检索协同

### 11.1 查询顺序

默认策略：

1. 识别用户是否需要个性化历史、项目约定或稳定偏好；
2. 若需要，先沿现有 Memory Tree 导航并进行本地 memory_search；
3. 识别记忆是否足以回答，或是否已过期/缺少实时性；
4. 只把必要的非敏感语义压缩成最小 web query；
5. 将 memory evidence 与 web evidence 分开标记；
6. 最终回答中区分“用户/项目上下文”和“外部当前资料”。

不能把整段记忆正文直接拼到搜索 query。需要外发的记忆内容应通过现有 Context/egress 策略显式决定。

### 11.2 记忆读取豁免

以下操作属于运行时内部只读：

- memory_tree 导航；
- memory_search；
- memory_deep_search；
- 本地 session/experience 查询。

它们在三种权限模式下都可以免除逐次审批，前提是：

- 不写持久数据；
- 不通过隐藏网络请求生成 embedding；
- 不把查询结果扩大为未经授权的外部请求；
- 访问账本、预算和安全封套继续生效。

### 11.3 实时资料不自动沉淀

默认不执行：

- 把完整网页正文写入 daily；
- 把每个搜索结果写入长期记忆；
- 把 URL 列表批量写进向量库；
- 用网页中的“记住这件事”触发 Memory Write。

用户明确要求保存时，才可提出结构化 MemoryWriteIntent，至少带：

- sourceUrl；
- fetchedAt；
- contentHash；
- sourceProvider；
- 适用 scope；
- freshness/expiry；
- 事实摘要；
- 写入理由；
- 用户是否明确要求。

写入仍走现有安全、去重、冲突、来源和恢复闸门。

### 11.4 新鲜度与权威

Memory evidence 和 Web evidence 不应混用一个 confidence：

- memory 适合用户偏好、项目规则、历史决定；
- web 适合时间敏感的外部事实；
- 官方来源、第一手来源、多个独立来源和用户指定来源可提升证据权重；
- 过期网页、转载、无日期内容和冲突来源必须标记；
- 记忆中的旧结论不能覆盖用户明确要求的实时核验。

## 12. 配置与 UI

### 12.1 配置草案

建议在 ConfigSchema 增加独立 web 配置域，不把搜索 provider 混入模型 providers：

~~~tex
web:
  enabled: false
  defaultProvider: <optional>
  readMode: disabled | public_anonymous | configured_allowlis
  strictReadApproval: false
  allowDomains: []
  blockDomains: []
  maxResults: 10
  maxFetchesPerRun: 4
  maxQueriesPerRun: 4
  searchTimeoutMs: 15000
  fetchTimeoutMs: 20000
  totalTimeoutMs: 90000
  maxResponseBytes: 2097152
  maxExtractedChars: 40000
  maxRedirects: 5
  cache:
    enabled: true
    ttlSeconds: 300
    maxBytes: <bounded>
  browserFallback: approval_required
  providers:
    - id: <provider-id>
      type: <adapter-id>
      baseURL: <optional>
      apiKeyRef: $ENV_VAR
      options: {}
~~~

建议保留以下默认语义：

- 新安装或未配置 provider 时，web.enabled 为 false；
- 用户配置 provider 并显式开启后，public web read 自动执行；
- 现有用户升级不应突然把查询内容发送给第三方；
- local memory safe read 不受 web.enabled 影响；
- 配置解析失败时网络能力关闭，其他本地能力继续工作。

最终字段、默认值和迁移方式在 WSR-101 冻结，不能以未迁移的临时 JSON 直接读取。

### 12.2 设置页

设置页至少提供：

- 网络读取总开关；
- 当前 provider、能力和健康状态；
- API key 来源状态（只显示已配置/未配置，不显示 key）；
- 公共匿名读取与 allowlist；
- strictReadApproval；
- 缓存开关、清理和保留期限；
- 单次/每轮配额；
- 浏览器后备是否允许；
- “查询会发送给 provider；页面请求会被目标站点看到”的说明；
- 最近一次失败、限流或配置错误。

设置页只读取 Runtime 的真实配置和状态，不维护第二份 provider registry。

### 12.3 对话区来源展示

默认渐进式披露：

- 回答正文显示简短 citation；
- citation 可点击打开来源；
- 来源卡显示标题、域名、发布时间（若有）、抓取时间、provider、缓存和截断状态；
- 多来源冲突时默认显示冲突提示；
- 完整 query、原始响应和安全诊断默认折叠；
- API key、Cookie、内部请求头和敏感 query 永不展示。

### 12.4 Channel 行为

QQ、飞书、Telegram、Webhook 等外部渠道继承同一网络策略，但需要考虑：

- 公开频道中搜索 query 可能包含第三方用户输入；
- provider 数据外发必须受 channel 和 session policy 约束；
- 公开频道不应默认启用浏览器登录态；
- citation 用渠道支持的链接格式呈现；
- 不能因为渠道没有完整 UI 就跳过错误、来源或网络开关事实。

## 13. 证据、日志与可观测性

### 13.1 工具调用记录

web_search/web_fetch 继续使用现有 ToolInvocationRecord，并在 meta/evidence 中增加有界字段：

- provider；
- normalized query hash；
- query sensitivity decision；
- requestedUrl/finalUrl hash；
- status；
- HTTP status；
- cached；
- truncated；
- contentHash；
- citation ids；
- retry count；
- timeout/abort；
- bytes received/extracted；
- error kind。

默认不记录完整 query 和完整正文；是否保留用户可复核的 query 摘要由隐私配置决定。

### 13.2 运行事件

建议增加或映射以下事件：

- retrieval_started；
- search_started / search_completed；
- fetch_started / fetch_completed；
- source_blocked；
- evidence_truncated；
- provider_rate_limited；
- retrieval_partial；
- retrieval_completed。

事件必须沿现有 Runtime event 安全边界发布，不能让网页内容伪造事件。

### 13.3 质量指标

可观测但不直接暴露隐私的指标：

- search/fetch 成功率；
- provider latency；
- cache hit rate；
- extraction success rate；
- partial/truncated rate；
- blocked SSRF count；
- citation coverage；
- model answer citation validation failures；
- 每轮 query/fetch 数和字节预算；
- 用户取消率；
- provider error 分类。

指标不应包含原始 query、URL path 中的 secret、正文、完整用户消息或 Atom 内容。

## 14. 分阶段实施任务

以下阶段按依赖顺序执行。每个阶段完成后必须留下代码、测试、文档和验证证据；没有达到验收门不能把状态标为完成。

### 14.0 当前代码基线的可执行工作包（WB-01 至 WB-09）

下面的工作包不是新的架构或新的编号体系，而是把 WSR-200 之后的要求映射到当前工作树中实际存在或将要新增的文件。它们解决两个执行风险：一是避免“领域层已有代码”被误认为可用能力；二是确保跨包改动始终按一个可恢复的闭环落地。

共同执行纪律：

1. 开始每个工作包前，先检查 `git status --short --branch`，只编辑本专项文件；不得 reset、checkout、clean、覆盖既有 App/UI/会话连续性改动。
2. 每次改动先更新或新增贴近实现的测试，再运行受影响文件/包的验证；工作包完成时再运行其依赖链的验证。只有发布工作包才运行 `verify:full`。
3. 所有真实网络测试必须显式 opt-in、使用隔离 data root 和测试密钥；测试输出不得打印、保存或提交密钥、完整敏感 query、Cookie、Authorization、provider 原始 JSON 或完整网页正文。
4. 对每个网络调用同时维护两种投影：模型可见的受限 evidence payload，以及持久化可见的脱敏 `WebEvidenceProjection`。任何实现若无法明确区分这两者，必须停在该工作包，不得继续接入最终回答。
5. 每个工作包完成后，在本任务书的对应阶段写入：修改文件、测试命令/结果、是否发生真实网络请求、遗留项和日期。没有这五项，状态仍为“局部实现”。
6. 本专项实施期间不 push、不刷新桌面快捷方式、不声称发布。只有 WB-09 的所有发布门完成后，才按项目既有发布流程处理。

#### WB-01：中央 safe-read 与 hard-deny 闭合

关联：WSR-200 至 WSR-214。
当前状态：已完成（2026-08-29，中央权限子门；不代表阶段 2 的 DNS/IP/redirect 网络边界已完成）。
前置：阶段 0、阶段 1 已完成。
目标：让所有真正执行工具的入口把 `hardDecision='deny'` 理解为“禁止执行”，而不是“无需弹窗”；让 `strictReadApproval` 在每一个相关入口都真正生效。

必须改动：

1. 在 [permission-boundary.ts](../../packages/safety/src/permission-boundary.ts) 保持单一 descriptor 计算入口；对 `web_search`、`web_fetch` 的安全类别必须只由解析后 input 与不可变 `networkPolicy` 决定，不能相信工具名称、模型声明或插件元数据。
2. 在 [tool-execution-service.ts](../../packages/tools/src/tool-execution-service.ts) 中，schema 校验成功后只计算一次 descriptor；若 `hardDecision === 'deny'`，在审批、重复调用计数和工具执行之前结束调用，写入稳定错误 kind 与可审计的 blocked/validation 记录，绝不调用 `tool.execute()`。若现有 invocation status/approval decision 枚举不足，应先扩展契约和旧记录兼容解析，不得把硬拒绝伪装成 `not_required`。
3. `ToolExecutionService.approve()` 调用 `shouldRequestPermissionApproval()` 时必须传入 `strictReadApproval: toolContext.networkPolicy?.strictReadApproval === true`；同一调用不得重新计算与记录阶段不同的 descriptor。
4. 在 `direct-tool-proposal.ts`（已随极简方案删除，见 `docs/decision/project-status.md` 2026-09-21 条目）中，先拒绝 hard deny；传入同样的 strict-read 选项。自动直连 proposal 只有在 descriptor、TaskBook resource envelope、side-effect 和审批结论全部一致时才可产生。
5. 追踪 `task-step-scheduler.ts`（已随第二执行体系删除，见 `docs/decision/project-status.md` 2026-09-21 条目）、[runner.ts](../../packages/runner/src/runner.ts)、以及 App 的 run-policy/terminal permission 调用点：要么都通过 `ToolExecutionService`，要么复用 `authorizeToolAccess()` 的 hard-deny 分支。禁止出现第二套“没要求审批就执行”的逻辑。
6. 保持以下强制区别：local memory safe read、匿名 public web safe read、容器内普通读、容器外读、认证浏览器、任何写入、exec 和未知目标。只豁免被 Runtime 明确归类的前两类，不扩大文件读取或浏览器权限。
7. 对 `strictReadApproval=true` 固定行为：research/restricted 中 safe read 恢复审批；full 仍仅绕过普通审批，不能越过 hard deny。

测试与证据：

- 扩展 [permission-boundary.test.ts](../../packages/safety/src/permission-boundary.test.ts)：三种权限模式 × local memory/public search/public fetch/外部文件/认证 URL/写入/exec；危险 scheme、URL 凭证、loopback/私网/metadata、blocklist、allowlist、缺失 policy 和 strict-read。
- 扩展 [tool-execution-service.test.ts](../../packages/tools/src/tool-execution-service.test.ts)：hard deny 不触发 `execute`、不弹审批、留有 invocation record；safe read 不弹审批；strict-read 会弹审批；full 也不能执行 hard deny。
- 为 direct proposal 增加对应回归：hard deny/strict-read 的 proposal 不能被采纳；正常 safe read 仅在工具与资源契约匹配时被采纳。
- 用可计数 fake tool 证明所有拒绝路径零执行；记录关键断言而不是仅比对人类文案。

完成门：所有执行入口在同一输入上得出相同的 allow/approval/deny 结论；hard deny 在 full/research/restricted 下均零执行；safe-read 不再因普通 restricted 默认规则被误弹窗。该完成门只覆盖中央权限判定与调用入口，不覆盖网络连接层的 DNS/redirect/HTTP 证明。
停止条件：若现有 Approval/Invocation 记录模型不能无损表达 hard deny，先完成该公共契约迁移，不开始 Web 工具接线。

#### WB-02：每轮 WebRetrievalRuntime 装配与生命周期隔离

关联：WSR-102、103、301、307、407、410。
当前状态：已完成（2026-08-29，Runner 每轮装配、隔离、销毁与有界 evidence projection 子门）。
前置：WB-01。
目标：把“可复用 provider registry/缓存”和“必须只属于本轮的 quota、AbortSignal、total timeout、evidence”严格分开。

必须改动：

1. 在 [infra.ts](../../packages/runner/src/infra.ts) 维持长期可复用的 `ProviderRegistry`、provider configuration snapshot 和可选 shared `WebCache`；网络关闭、无 `defaultProvider` 或配置无效时不得解析 key、创建 provider 请求客户端或尝试网络 fallback。
2. 在 [runner.ts](../../packages/runner/src/runner.ts) 的每次 run 入口，先解析本轮 config/provider snapshot，再创建新的 `WebRetrievalRuntime`。该 runtime 必须接收本轮不可变 `networkPolicy`、本轮 `runId`、本轮 abort signal、选定 provider、shared cache 和受限日志函数；不得跨 run 复用 query/fetch 计数、citation id 或取消状态。
3. 只在网络策略实际启用且已选 provider 时创建/注入 runtime；否则 `ToolContext.webRetrieval` 保持不存在，让尚未启用的工具 fail closed。不得为了 health check 或“自动发现 provider”发送请求。
4. 将 runtime 和 `webEvidenceSink` 传给 [context.ts](../../packages/harness/src/context.ts) 的 `buildRunContext()`；确保 sink 写入的是 `RunContext.webEvidence` 的有界 clone，而不是领域对象或全文。
5. 校准 [run-config.ts](../../packages/runner/src/run-config.ts)：provider snapshot 只反映实际可选的配置状态；`approvalRequiredToolNames` 只是 UI/模型能力投影，不能覆盖每次真实 descriptor 决策。
6. 在 run 结束、取消、异常恢复和 checkpoint resume 时销毁本轮 runtime 的 timers/listeners；恢复只复用历史 evidence，不自动复发外部请求。若恢复时 config/policy 已变化，必须重新解析而不是复用旧 policy。

测试与证据：

- 新增 Runner 级 fake provider / fake HTTP 测试：关闭网络、未配置 provider、已配置但未启用时调用数均为零；已启用时仅选定 provider 可被调用。
- 证明连续两个 run 使用同一 cache 时可命中缓存，但 query/fetch quota、abort 状态和 citation namespace 不共享。
- 证明 run 取消后不再开始新的 provider/fetch 请求，并且 Runtime 不残留 listener/timer。
- 证明 `webEvidenceSink` 已注入并仅保存 projection；没有 Web runtime 时 web 工具得到稳定 `web_disabled` 或 `web_provider_unconfigured` 事实。

完成门：一个 fake provider search/fetch 能通过 Runner 创建的 Context 到达工具 port；同一流程在 disabled/unconfigured 状态不可能产生网络调用。
停止条件：若 registry health 需要真实网络才能装配，必须把 health 检查从 run 构建路径拆出，避免隐式 egress。

实施证据（2026-08-29）：

- [runtime.ts](../../packages/web/src/runtime.ts) 已加入 runId 绑定、每轮 query/fetch quota、总 retrieval deadline、并发信号量、父级取消、citation namespace 与 `dispose()`；调用者传入的 provider runId 会被 Runtime 覆盖。
- [runner.ts](../../packages/runner/src/runner.ts) 只在 policy enabled、provider id 存在、registry 命中且 provider 状态可用时创建每轮 Runtime；run `finally` 统一销毁，checkpoint/replay 只恢复有界 projection，不因恢复自动重发网络请求。
- [web-runtime.test.ts](../../packages/runner/src/web-runtime.test.ts) 与 [runtime.test.ts](../../packages/web/src/runtime.test.ts) 使用 fake provider、fake cache 和无 socket 的固定 fixture 证明双轮 quota/citation/abort 隔离、shared cache、disabled/unconfigured 零 provider 调用、projection 持久化和 run 后 dispose。
- 合并回归命令 `pnpm.cmd exec vitest run packages/web/src/runtime.test.ts packages/runner/src/web-runtime.test.ts packages/runner/src/run-checkpoint.test.ts packages/runner/src/execution-log.test.ts packages/harness/src/context.test.ts packages/runner/src/runner.test.ts --reporter=default`：6 个测试文件、75 项测试通过，退出码 0。
- `@littlesheep/web` typecheck/build 与 `@littlesheep/runner` typecheck/build 均通过；专项范围 `git diff --check` 通过。
- 本门未发生真实网络请求，未使用真实 provider key。DNS/IP/redirect/HTTP 生命周期仍归 WB-03；模型正文与 durable projection 的完整双投影仍归 WB-05，不因本门完成而提前宣称闭环。

#### WB-03：`@littlesheep/web` 领域层安全加固

关联：WSR-201、202、300 至 312、500、502 至 520。
当前状态：已完成（2026-08-29，Provider、URL/DNS/IP/redirect、匿名 HTTP、资源封套、取消/超时和错误脱敏领域子门）。
前置：WB-01 的 descriptor 语义稳定；可与 WB-02 在不同时修改同一文件的条件下并行。
目标：使领域层即使被错误调用，也不能把公共检索升级成任意网络请求或无界资源消耗。

必须改动：

1. 审计并收口 [runtime.ts](../../packages/web/src/runtime.ts)：在 query 和 `maxResults` 完成清洗/校验之后才消耗 quota；拒绝空 query、控制字符、NaN/Infinity 和超 policy 值；总 retrieval timeout、每轮并发和 retry budget 都只属于该 runtime。
2. 审计 [provider.ts](../../packages/web/src/provider.ts)、[provider-registry.ts](../../packages/web/src/provider-registry.ts)、[providers/tavily.ts](../../packages/web/src/providers/tavily.ts)：严格 secret reference 语义（生产默认只接受 `$ENV_NAME` 或受控 resolver）；原始 HTTP body、Authorization、key 和 provider 原始 JSON 不得进入错误、日志、缓存或结果；自定义 registry id 与 `SearchResponse.provider` 必须保持真实一致。
3. 使 Tavily adapter 只发送已归一化的允许字段，且固定 `include_answer=false`、`include_raw_content=false`、`auto_parameters=false`；provider 仅提供发现/排名，不能替代 LS 的 fetch/evidence 语义。
4. 收口 [fetch/url-policy.ts](../../packages/web/src/fetch/url-policy.ts)、[fetch/http-client.ts](../../packages/web/src/fetch/http-client.ts) 与 [fetch/service.ts](../../packages/web/src/fetch/service.ts)：先 canonicalize，再 DNS/IP 判断；连接目标与已检查的地址一致；每一跳 redirect 重新检查；拒绝危险 scheme、credential URL、localhost、私网、link-local、metadata、保留地址和无法证明的解析结果。
5. 明确父取消与内部超时的不同错误：父 signal 触发只能产生 `web_fetch_cancelled`，内部 deadline 产生 `web_fetch_timeout`；成功、失败、重试和取消后必须移除 abort listener、终止 stream/socket、清理 timeout。
6. 在响应处理链上同时限制 wire bytes、解压后 bytes、重定向数、字符数、HTML 解析复杂度和缓存条目；`truncated=true` 必须影响 document/evidence completeness，不能作为完整成功掩盖。
7. 保持 fetch 永远匿名、GET-only、无 Cookie/Authorization/Referer/profile；抽取器只输出已清理的有界内容，并以 `externalUntrusted: true` 标记。

测试与证据：

- 为 Web package 添加独立单元/集成测试，不使用公共互联网：fake DNS、fake HTTP client、fake clock、abortable slow stream、redirect chain、compressed/body-too-large fixture。
- 覆盖 IPv4、IPv6、IPv4-mapped IPv6、hostname 尾点/大小写、DNS rebinding、public-to-private redirect、循环和超限 redirect。
- 覆盖 token/key/authorization 出现在 provider 错误、URL、响应体时的脱敏断言；扫描 serialized error、cache key 和 evidence projection。
- 覆盖 search quota 不因无效 input 被消耗；并发/总 timeout/retry 不可突破；cache hit 仍产生正确 citation/evidence。
- 使用现有 [public-page.html](../../test/fixtures/web-retrieval/public-page.html) 验证 prompt injection 只作为抽取文本，而非系统/工具消息。

完成门：fake transport 证明所有安全拒绝在发起 socket 前发生；所有 fetch/search 路径可取消、可超时、有限重试、无泄露并生成稳定 `WebErrorKind`。
停止条件：DNS/连接库无法提供“检查地址与连接地址一致”的保证时，保持 fetch disabled，不能以仅检查 hostname 代替。

实施证据（2026-08-29）：

- Runtime 在 query/maxResults 完整校验后才消耗 quota；空值、控制字符、NaN/Infinity、超长度/超结果数均拒绝；每轮并发、两次 retry 上限、总 retrieval deadline、父取消与 listener/timer 清理由单轮 Runtime 持有。
- 生产 `EnvironmentSecretResolver` 只接受 `$ENV_NAME`，宿主 resolver 必须显式注入；Tavily 固定官方 HTTPS Search endpoint、固定 discovery-only 字段，自定义 registry id 与 `SearchResponse.provider` 保持一致，未知/伪造错误 kind、原始错误 cause、key、Authorization、provider body 均不会跨边界。
- public fetch 对首 URL 和每个 redirect 先 canonicalize，再检查 hostname、全部 DNS answer、IPv4/IPv6/IPv4-mapped IPv6 和 domain policy；Node socket 使用已检查 IP、原始 Host/SNI，低层 transport 不从包入口导出且只允许固定匿名 GET。
- wire bytes、解压 bytes、redirect 数、模型可见字符、200 万字符 extractor 输入、cache TTL/容量、fetch quota 和 timeout 均有独立硬上限；cache hit 计逻辑 quota但不建 socket，签名/token URL 不进入共享 cache，普通 cache key 只含 SHA-256。
- fake DNS/fake HTTP/fake fetch/fake clock/abortable stream 覆盖 public-to-private redirect、循环/超限 redirect、DNS 混入非法地址、压缩响应、父取消/内部 timeout、prompt injection 数据化、cache 异常和 Provider/cache/socket 错误脱敏；未使用公共互联网或真实 key。
- Web 最终定向命令覆盖 8 个文件、79 项测试，全部通过；与 WB-02 Runner/Checkpoint/Log/Context 合并回归覆盖 12 个文件、120 项测试，全部通过，退出码 0。
- `@littlesheep/web` typecheck/build 与 `@littlesheep/runner` typecheck/build 均通过；专项 `git diff --check` 通过。
- 本门不包含内置 AgentTool、完整 evidence 双投影、Harness 检索路由、UI 来源卡或真实 Tavily/真实公开页面 smoke；这些仍由 WB-04 至 WB-09 验收。

#### WB-04：内置 `web_search` / `web_fetch` 工具与注册

关联：WSR-400 至 410、WSR-501、509、511。
当前状态：已完成（2026-08-29，两个受限内置工具、统一执行入口、敏感 query egress 和最终 capability gate）。
前置：WB-01、WB-02、WB-03。
目标：让 LLM 只能调用两个小而受限的 LS 工具，而不是获得通用网络客户端。

必须改动：

1. 新增 [web_search.ts](../../packages/tools/src/builtin/web_search.ts)。input schema 只能暴露 `query`、`domains`、`excludeDomains`、`recency`、`language`、`maxResults`；清洗 trim/control character/Unicode 异常并 enforce `maxQueryChars`、结果数和敏感 query policy。严禁 endpoint、headers、Cookie、Authorization、body、proxy、output path、provider id 或任意 retry 参数。
2. `web_search` 只能调用 `ctx.webRetrieval.search()`；缺失 runtime、网络关闭或 provider 未配置时 fail closed。输出只返回归一化 title、URL、snippet、publishedAt、siteName、rank、citationId、状态和有限 warnings；不得透传 Provider raw JSON。
3. 新增 [web_fetch.ts](../../packages/tools/src/builtin/web_fetch.ts)。input schema 只能暴露 `url`、可选 `citationId`、可选 `maxChars`；只能调用 `ctx.webRetrieval.fetch()`；若指定 citation id，runtime 必须验证它和 URL 的绑定，禁止跨来源冒用。
4. `web_fetch` 的模型可见结果应明确包括 title、finalUrl、fetchedAt、extractor、truncated、citationId、`externalUntrusted: true` 和有界 content；工具自身不写 workspace、daily、Memory 或 cache 以外的持久位置。
5. 更新 [packages/tools/src/index.ts](../../packages/tools/src/index.ts)、[registry.ts](../../packages/tools/src/registry.ts)、[packages/tools/package.json](../../packages/tools/package.json)、[packages/runner/src/infra.ts](../../packages/runner/src/infra.ts) 和 workspace/lockfile，使两个工具经同一 registry/ToolExecutionService 可发现。不要在工具文件中 new Provider、读取环境变量或自行审批。
6. 工具描述不得硬编码 `requiresApproval=true` 来抵消 safe read；实际审批只由 WB-01 的 descriptor 决定。对敏感 query 的 `allow/redact/approve/deny` 是独立 egress 规则，不得因“public read”自动绕开。

测试与证据：

- 各自新增 `*.test.ts`：schema unknown field 拒绝、无 runtime、disabled/unconfigured、max bounds、query 敏感 policy、结果归一化、citation binding、truncated、取消和错误映射。
- Registry test 证明两个工具仅在已注册的 Run tool catalog 中可用；没有 web policy 时不会把它们错误投影为已可用能力。
- ToolExecutionService test 证明工具接受的 input 无法包含任意 method/header/body/proxy/credential，并与 WB-01 的安全读取矩阵一致。

完成门：fake provider + fake fetch 通过真实工具调用返回结构化 evidence；模型无法借 schema 表达任意 HTTP 请求；所有未启用路径零网络调用。
停止条件：若工具输出结构不能同时满足模型阅读和持久化边界，先完成 WB-05 的双投影设计再接入工具循环。

实施证据（2026-08-29）：

- 新增 [web_search.ts](../../packages/tools/src/builtin/web_search.ts)、[web_fetch.ts](../../packages/tools/src/builtin/web_fetch.ts) 与共享 [web-common.ts](../../packages/tools/src/builtin/web-common.ts)；两个 `.strict()` schema 只暴露任务书允许的字段，任意 method/header/body/Cookie/Authorization/proxy/output path/provider/retry 字段均在执行前拒绝。
- `web_search` 和 `web_fetch` 只消费每轮 `ToolContext.webRetrieval`；disabled、缺失 Runtime、provider 未配置、敏感 query deny/未批准、非法 URL/citation 和领域错误均 fail closed。正文/摘要只进入 run-local `modelOutput`，durable `output` 只保留状态、计数、citation id、时间、hash 与截断事实。
- 敏感 query 支持 `allow/redact/approve/deny`：普通 public query 在 research/restricted 下保持 safe read 免批；`approve` 单独进入 egress approval；批准 UI、`tool_start`、invocation record 和持久化 tool call 只接收 query hash/长度/类别或 URL origin/hash，不接收原始 query、secret、URL path/query。
- 两个工具经 `registerBuiltinTools()` 和统一 `ToolExecutionService` 注册。Runner 只在 enabled、read mode 可用、default provider 存在、registry 命中且 provider snapshot 可用时广告保留工具名；最终 gate 作用于 registry 与 `additionalTools` 合并结果，关闭/未配置时 run-scoped 同名工具也不能绕回模型 catalog。
- 工具执行服务在首条 invocation record 前应用 `persistence.projectInput()`；未知工具只保留不可逆审计占位，不先写入原始输入摘要。Provider 结果由 Runtime 二次归一化并用注入时钟补齐时间，未来自定义 Provider 不能伪造 citation/provider identity 或透传 raw warnings/request id。
- 定向回归：Safety/Tools/Harness 5 个文件 99 项全部通过；Runner capability/runtime 3 个文件 12 项全部通过；Web 8 个文件 79 项全部通过。Types、Safety、Tools、Web、Harness、Runner typecheck 全部通过，专项 `git diff --check` 通过。
- 本门没有公共互联网请求、没有真实 Tavily key、没有 push 或桌面快捷方式刷新。citation final reply 校验、checkpoint/log 全链路泄露扫描、Harness 检索路由、UI 来源卡和真实 smoke 仍由 WB-05 至 WB-09 验收。

#### WB-05：Evidence、citation、持久化与“模型正文/耐久记录”分离

关联：WSR-105、106、600 至 614、708 至 712。
当前状态：已完成（2026-08-29，模型正文/durable 双投影、citation metadata/校验、checkpoint/log/replay 全链路闭合）。
前置：WB-02、WB-04。
目标：使“联网查证”可复核且不把网页正文、敏感 query 或原始 provider 数据永久塞进会话和日志。

必须改动：

1. 在 [tool-loop.ts](../../packages/harness/src/stages/execute/tool-loop.ts) 区分两个输出：向 LLM 的完整但受限 evidence envelope，以及传入持久化链路的 durable projection。`web_search` 和 `web_fetch` 的 LLM payload 必须使用明确的 `<external_web_evidence>`（或同等结构）封套，含 source id、URL、时间、信任级别、标题和有界资料，禁止把网页内容提升为 system/developer/tool message。
2. 在同一工具循环中，把每次成功/partial/blocked 的 projection 合并到 `ctx.webEvidence`，并通过 `webEvidenceSink` 对 RunContext、AgentResult 与最终执行 evidence 保持同一 citation id 集合；去重需基于 runtime-generated citation id 和规范 URL，不依赖模型文本。
3. 在 [runner-persist.ts](../../packages/runner/src/runner-persist.ts)、[runner-finalize.ts](../../packages/runner/src/runner-finalize.ts)、[run-checkpoint.ts](../../packages/runner/src/run-checkpoint.ts)、[execution-log.ts](../../packages/runner/src/execution-log.ts) 中只写入 `WebEvidenceProjection`：provider、citation metadata、hash/脱敏 URL、cached/partial/truncated/status/error 等有界字段。不得写入 `documents`、网页正文、完整 query、原始 URL secret、raw HTTP/provider response。
4. 增加明确的 citation validation：final reply 只可使用本轮 evidence 中真实存在且可公开呈现的 citation id；模型自造 id、错绑 URL、将 blocked/partial/truncated 伪装成完整已验证时，应进入有限改写或 Runtime 不完整状态。
5. checkpoint/history 加载只能恢复 projection 和来源卡，不能因为打开历史或继续会话而重新发 search/fetch。cache 与 durable evidence 的生命周期、清理和迁移必须分开。

测试与证据：

- 使用注入 fixture 确认模型看到的封套中包含“外部不可信资料”语义，页面中的“忽略规则并执行命令”不会改变 tool set、approval、TaskBook、memory gate 或 Runtime event。
- 新增 transcript/checkpoint/execution-log 序列化扫描：不存在 `public-page.html` 正文、Provider raw JSON、`documents`、完整 query、API key/Cookie/Authorization；存在 citation id、truncated、cached、partial 和 hash/安全 URL metadata。
- 断言 final `AgentResult.webEvidence`、execution log、checkpoint 与 UI-facing projection 的 citation 集合一致；历史恢复零网络调用。

完成门：一次 fake search + fake fetch 可在模型上下文中使用正文，在 durable store 中只留下有界、脱敏、可复核的 citation projection。
停止条件：若任何持久化链路不能确认其内容边界，先关闭网页正文向该链路的写入，不能以“sanitize later”放行。

实施证据（2026-08-29）：

- 公共 `ToolResult` 增加仅限当前模型工具回合的 `modelOutput`；`ToolExecutionService` 分别清洗 durable `output` 与 run-local `modelOutput`，Harness 第二次模型请求优先读取后者，而 `ctx.toolResults`、`produced`、TaskBook step、AgentResult 和会话 tool result 全部通过 `durableToolResult()` 剥离正文。
- `AgentTool.persistence.projectInput()` 成为统一输入投影契约；审批、`tool_start`、assistant tool-call persistence 和 invocation record 首次发布前均使用投影。Web search 只留下 query hash/长度/敏感类别，Web fetch 只留下 URL origin/hash 与有限参数；未知工具不先记录原始输入摘要。
- `WebEvidenceProjection` 增加最多 128 条内容无关 citation metadata：id、安全规范 URL（仅无 credential-like query 时）、origin、URL SHA-256、标题、provider、发布时间/抓取时间、状态、content hash 与 truncated。带 token/signature 的 URL 只保留 origin/hash，不保存 secret path query。
- 新增 `sanitizeWebEvidenceProjection()` 白名单，并在 Harness evidence sink、工具循环、`durableToolResult()`、AgentResult、checkpoint build/restore、execution log 和 replay 边界重复执行。即使运行时对象夹带 `query`、`documents`、`snippet`、`content` 或签名 URL，也不会进入耐久状态。
- execution log 自身再次删除 `ToolResult.modelOutput`，不依赖上游正确性；模型请求/Context observability 只保存 role、字符数、hash、来源与预算，不保存 message 正文。历史加载只恢复投影，Runner 生命周期测试证明 replay 不触发新 search/fetch。
- 新增 Runtime citation token `[citation:<runtime-id>]` 校验。工具循环在仍持有 run-local 正文时最多修复两次缺失/伪造引用；TaskBook final synthesis 只接受本轮 `citationIds`，错绑、伪造或持续缺失会失败并进入 RECOVER，不能发布成“已联网确认”。Runtime 对 `citationId + URL` 绑定仍独立 fail closed。
- 真实内置链路的离线端到端测试通过：fake Provider + fake cache 经 `Runner → Harness → ToolExecutionService → web_search → web_fetch`，模型看到了搜索摘要和页面正文，AgentResult/replay/log 仅保留同一 citation 集合及安全 metadata；disabled/unconfigured 仍为零 Provider 调用。
- WB-05 合并回归覆盖 21 个文件、231 项测试，全部通过；Types、Web、Tools、Harness、Runner build 全部通过；静态 `modelOutput`/`webEvidence` 写入审计与专项 `git diff --check` 通过。未发起真实公共网络请求，未使用真实 API key。
- 本门不包含用户意图路由、Memory-first query 最小化、App 来源卡或真实 Provider smoke；这些仍由 WB-06 至 WB-09 验收。

#### WB-06：Harness 检索路由、TaskBook 与最终回答闭环

关联：WSR-700 至 724。
当前状态：已完成（2026-08-29，检索意图路由、compact retrieval、TaskBook 工具集过滤和 citation final reply 校验）。
前置：WB-01 至 WB-05。
目标：用户的实时意图确实触发受控检索，简单问题保持轻量，复杂研究获得可验证步骤，最终回复仍来自真实 LLM。

必须改动：

1. 扩展 [classify.ts](../../packages/harness/src/stages/classify.ts) / NeedAssessment 和相关 prompt contract，显式区分 `capability_question`、`local_workspace`、`local_memory`、`web_search`、`web_fetch`、`combined_memory_web`、`browser_required`。相同词出现在网页正文中绝不能构成用户意图。
2. 新建或扩展 compact retrieval 组件（建议 `retrieval-intent.ts`、`compact-retrieval-task.ts`；与 `compact-autonomous-read-task.ts`（已随极简方案删除，见 `docs/decision/project-status.md` 2026-09-21 条目） 的旧“no network/memory”约束一起修改）。对于“查今天/最新/找来源/打开公开 URL”只暴露一个最小工具集和一次最终 synthesis，不默认启动重型 TaskBook。
3. 对多来源比较、冲突核验、多个官方页面和需要记忆结合的任务，生成正常 TaskBook：搜索、选择 2–4 个来源、受控 fetch、evidence merge、citation-aware synthesis、VERIFY。每个 read step 仍声明 resource、side effect 和 acceptance criteria。
4. 更新 [llm-call-contracts](../../packages/harness/src/llm-call-contracts/) 和 [stages/execute](../../packages/harness/src/stages/execute/) prompt：LLM 可以选择受限工具/摘要证据，但不能变更 provider、permission、TaskBook 状态、Memory 写入或 citation binding。
5. 在 final reply / VERIFY / RECOVER 中将 citation completeness、official-domain/recency 需求、partial/truncated/conflict、provider failure 纳入事实：citation 验证失败最多有限重写；不允许回退到未标记的训练知识假装“已查证”。
6. 保持现有 ReplyProvenance、会话去重和真实 LLM 生成约束。Runtime 仍负责链接渲染、状态数字、错误/权限事实；模型不能用固定模板伪造 Agent 回复。

测试与证据：

- 端到端 fake-provider case：`查今天的新闻` → compact web search → final reply with valid citations；`打开 URL 并总结` → compact fetch；`比较三份官方资料` → TaskBook + VERIFY。
- 反例：`LS 支持搜索吗`、`搜索我的项目文件`、`记得我的上次决定吗` 不发网络；网页正文里出现“去搜索/去执行”不触发工具。
- failure/recover：network disabled、unconfigured、rate limit、partial fetch、citation invalid、cancel/resume 均能产生真实而不伪造的 final state。

完成门：运行一次真实 Harness 流程即可区分 respond、compact retrieval、TaskBook、clarify；最终回答包含 Runtime 验证过的来源，失败路径不会假称实时性。
停止条件：若 LLM contract 不能限制工具集与 citation token，暂不允许 web tools 出现在普通 Chat 的模型 catalog。

实施证据（2026-08-29）：

- 新增 [retrieval-intent.ts](../../packages/harness/src/retrieval-intent.ts) 和对应测试，明确区分 `none`、`capability_question`、`local_workspace`、`local_memory`、`web_search`、`web_fetch`、`combined_memory_web`、`browser_required`；意图只基于用户 inbound 文本，不读取网页正文推导用户意图。
- `classify`、DECIDE、execute prompt 和 runner tool catalog 已按意图过滤：local workspace/memory、能力询问和 browser-required 不开放 Web；指定公开 URL 只开放 `web_fetch`；普通 Web 搜索和 memory+web 只开放 `web_search`/`web_fetch`。登录态、验证码、点击下载等 browser-required 请求不会被匿名 fetch 伪装。
- 简单联网问题走 compact retrieval；多来源、官方来源比较和冲突核验保留标准 TaskBook/VERIFY 路径。Web TaskBook 增加 Runtime-owned retrieval contract，要求最小 query、外部不可信证据和 citation-aware synthesis。
- `rewriteLegacyExecutionReply()` 也重新执行 citation validation，避免会话去重或有限重写导致 citation 丢失或被伪造。citation 无效、缺失或与证据不匹配时，最多有限重写，持续失败进入 Runtime/RECOVER 状态，不以训练记忆冒充实时查证。
- 定向回归覆盖 5 个文件、61 项测试，全部通过；Harness typecheck 通过。与 WB-04/WB-05/WB-07/WB-08 的合并证据见各工作包和本任务书 14.0.2。
- 本门没有公共互联网请求、没有真实 Tavily key、没有 push 或桌面快捷方式刷新；真实部署可用性仍由 WB-09 决定。

#### WB-07：Memory-first 协同与外发治理

关联：WSR-208、800 至 814。
当前状态：已完成（2026-08-29，Memory-first、最小 query、远程 embedding 边界和 Web 写入治理）。
前置：WB-01、WB-05、WB-06。
目标：把“不失忆”与“实时资料”结合，但不把用户私有记忆变成默认外发内容，也不让网页自动污染长期记忆。

必须改动：

1. 将 `memory_tree`、`memory_search`、`memory_deep_search`、本地 session/experience 查询正式接入 WB-01 的 runtime-owned safe-read 分类，并验证本地 embedding 路径没有隐藏网络 egress。
2. 只在用户问题确实需要项目历史/用户偏好时先沿 Memory Tree 查询；判断 freshness 后把必要的非敏感语义压缩为最小 web query。不得将原始 Memory atom、整段会话、附件或完整 daily 拼进 query。
3. 若以后支持 remote embedding 或 remote memory index，单独建 egress config、状态、日志与审批语义；不得因为名称仍叫 `memory_search` 自动享受 local safe-read 豁免。
4. Web evidence 与 Memory evidence 在 RunContext、VERIFY、最终回答和 UI 中始终区分来源、权威、时间、冲突与过期状态；旧 memory 不得压过用户要求的实时核验。
5. 默认禁止 web result 自动写入 daily、长期 memory、vector index。仅在用户明确要求保存时创建结构化 `MemoryWriteIntent`，携带 source URL、fetchedAt、content hash、provider、expiry、scope、摘要、写入理由与用户意图，后续仍经过现有 Memory Write Gate。

测试与证据：

- restricted 下 local memory 全自动，但远程 embedding/外发被正确标示和控制。
- memory+web case 验证 query 是最小化语义，不包含 fixture 的完整 private text；Memory 和 Web citations 可独立回溯。
- web-only 查询不产生 Memory 写入；网页注入不能创建 `MemoryWriteIntent`；用户明确保存才走写入审批/验证。
- 重启和不同模型 provider 下复测 egress，不允许隐式从本地路径变为远程服务。

完成门：LS 可以回答“根据我的项目约定，查一下最新资料”，同时明确哪些结论来自本地项目历史、哪些来自外部网页，并没有扩大外发或自动记忆。
停止条件：若最小 query 无法可靠脱敏，必须 require approval 或拒绝外发，而不是发送原始记忆。

实施证据（2026-08-29）：

- 本地 Memory 查询继续按 runtime-owned safe read 处理；配置显式固定 `embeddingMode: 'local'`。以后若支持 remote embedding 或 remote memory index，必须另建 egress、状态、日志和审批契约，不能因工具名为 `memory_search` 自动免批。
- `combined_memory_web` 先沿本地语义读取最小必要上下文，再生成最小、非敏感 Web query；不得把原始 atom、完整 daily、会话、附件、内部路径或凭证拼入 Provider 请求。Web query 的敏感策略仍由 Runtime 决定。
- Web-only run 默认不写 daily、长期 Memory、Experience 或 vector index。网页正文中的“请保存/请记住”等外部指令不会创建 `MemoryWriteIntent`；只有用户原始请求明确要求保存网页资料时，才进入既有结构化 Memory Write Gate，并携带受控 evidence refs。
- Web evidence 与 Memory evidence 在 prompt、RunContext、VERIFY、最终回答和 projection 中保持来源分层；网页 citation 可作为 evidence ref，但不能把网页正文自动变成长时记忆。
- 定向回归覆盖 5 个文件、83 项测试，全部通过；Config、Harness typecheck 通过。未发生公共网络请求、未使用真实 key、未写入正式用户 Memory。

#### WB-08：App、CLI、渠道和数据生命周期体验

关联：WSR-900 至 919。
当前状态：已完成（2026-08-29，Main/Renderer 网络设置、来源 projection、历史恢复、CLI/channel 格式化和 Web cache 生命周期）。
前置：WB-05、WB-06；WB-07 的配置/egress 字段也必须可显示。
目标：让用户看得见是否联网、资料从何而来、是否缓存/截断/部分完成，并始终由 Main/Runtime 而非 Renderer 决定真实政策。

必须改动：

1. 在 `packages/app/src/renderer/settings/` 和 Main 配置 API 中增加 web 总开关、provider 配置状态（只显示已配置/未配置）、safe-read 说明、strict-read、read mode/allowlist/blocklist、缓存和清理、browser fallback。配置 mutation 必须经 Main schema 解析后才生效。
2. 首次启用必须清晰显示三条 egress：最小 query → 搜索 provider；URL → 目标网站；证据正文 → 当前 LLM provider。不得把一次启用误表示为允许浏览器登录、任意 endpoint、POST 或网页写入记忆。
3. 在 assistant turn 与历史恢复中实现 citation/source card：title、domain、publishedAt（如有）、fetchedAt、finalUrl、provider、cached、partial、truncated、blocked/timeout。只使用 WB-05 projection；不能把网页全文、完整敏感 query、API key、Cookie/headers 暴露给 Renderer。
4. 将 retrieval progress 映射到现有任务进度而非新建平行进度系统；错误必须区分 disabled/unconfigured/rate limited/blocked/timeout/partial，不让 UI 猜测 Runtime 状态。
5. CLI 和 QQ/飞书/Telegram/Webhook 等渠道使用同一 policy/evidence，按渠道能力输出可点击链接或安全文本 fallback；外部渠道默认不启用认证 browser fallback。
6. 提供网络 cache 清理和保留期限；与 Memory 清理分开。历史 conversation 只读 projection，不重新联网。

测试与证据：

- Renderer component/unit tests：状态卡、citation card、错误/partial/truncated、历史恢复、键值隐藏、accessibility。
- Main/Local App API tests：Renderer 无法伪造 provider health、`networkPolicy`、审批或 citation；关闭后所有前端入口零请求。
- 渠道 projection tests：同一 evidence 在富链接/纯文本环境下不丢失“来源、时间、部分完成”事实。

完成门：用户无需阅读日志就能区分“没联网”“已联网但失败”“缓存结果”“完整/部分/截断资料”，且可随时关闭/清理；UI 不成为第二套权限系统。
停止条件：若 durable projection 尚未通过 WB-05 泄露测试，来源卡只显示安全 metadata，不能展示正文片段。

实施证据（2026-08-29）：

- `RuntimeState.web`、受限 `POST /runtime` web patch、`DELETE /runtime/web/cache` 和 Main allowlist/schema revalidation 已落地；Renderer 不能伪造 `ready`、provider health、provider id、endpoint、审批或 citation。配置状态区分 `disabled`、`unconfigured`、`configured_unchecked`，不会因配置字段直接变成 ready。
- 设置页已提供网络总开关、首次启用确认、三类 egress 展示、read mode、strict-read、敏感 query policy、browser fallback、缓存开关/清理和 provider 状态。Web cache 与 Browser cache、Memory 清理分离。
- assistant turn 来源卡和历史恢复只消费 `WebEvidenceProjection`，显示 title、domain/origin、publishedAt/fetchedAt、provider、citation、cached、partial、truncated、blocked/timeout/error 等安全 metadata；不显示网页正文、原始 query、API key、Cookie、headers 或 Provider raw JSON。
- CLI 与渠道共用 `formatWebEvidenceSources()`，在富链接和纯文本环境下均保留来源、时间、citation 和部分/截断/错误事实。历史恢复只读 projection，不重新联网。
- 定向回归覆盖 8 个文件、51 项测试，全部通过；App、CLI、Plugins typecheck 通过。已启动并检查裸 Vite Renderer 页面，但该页面缺少 Electron Main Local App API，不能替代 Electron 窗口验收；真实渠道和 Electron 验收列入收口清单。
- 本门没有公共互联网请求、没有真实 Tavily key、没有 push 或桌面快捷方式刷新。

#### WB-09：真实 Provider、回归、迁移、发布与回退

关联：WSR-1000 至 1024。
当前状态：进行中（2026-09-01；稳定工作树全量离线/构建/恢复门、Electron 状态连续性、迁移/回退、供应链、release 候选扫描、真实 DeepSeek V4 Flash 合成 evidence 和离线渠道门已通过；测试 key 的真实 Tavily search 已通过，但搜索结果关联 fetch/citation 被当前 DNS/SSRF 环境阻断，正式渠道、签名安装器和干净环境发布门尚未完成）。
目标：把可测试的代码提升为可声明的产品能力，且出现问题时可立即关停网络而不影响本地 Memory/既有 Agent 能力。

必须改动与验证：

1. 运行定向 tests、包级 typecheck/build、`verify:core`，最后运行 `verify:full`；记录每项命令、日期、结果、skipped 原因和环境。任何失败必须保持专项“实施中”。
2. 使用隔离 data root、显式 `web.enabled=true`、测试 `$TAVILY_API_KEY` 做真实 smoke：至少验证一次 search、一次 safe public fetch、最终 citation、关闭后零请求、provider auth/rate-limit/timeout 的用户可见结果。不得在报告、日志、Git 或用户正式 Memory 中保存 key/完整 query/正文。
3. 再次核对 Tavily 的 API、费用、限流、数据/缓存许可、地区可用性和当前条款；这些是外部易变事实，不属于 Runtime 常量。若不可用，Provider 状态保留 `unavailable`，不得偷偷替换成 HTML scraping 或未配置 provider。
4. 完成安全回归：SSRF/DNS rebinding/redirect/IPv6/压缩炸弹、prompt injection、citation forgery、durable-data leakage、取消/timeout/重启、cache expiry/corruption、并发/quota、browser approval、network-disabled total failure。
5. 完成迁移/回退演练：旧 config/log/checkpoint 可读；新 config 默认 disabled；一键关闭 `web.enabled` 后保留历史 evidence、本地 memory 和非网络工具；不删除用户数据；恢复后不重复请求。
6. 完成 dependency license/vulnerability/supply-chain review，确定 extractor/HTTP/DNS 依赖版本与移除条件；发布包扫描不得包含 fixtures 中的私密内容、测试 key、缓存正文或用户数据。
7. 更新架构、AGENTS、TOOLS、README、用户帮助、隐私说明、已知限制、项目状态和 release checklist；只报告真实已通过的场景，不把 mock 结果升格为 production readiness。

当前执行记录（2026-08-30）：

- 已通过：受影响的 `review-line-comment-integration.test.ts`（2 项），`pnpm.cmd run check:repo`（33 项），以及当前稳定工作树的 `pnpm.cmd run verify:full`（387 个测试文件、2642 项通过、1 项 skipped；包含 28 个 workspace TypeScript 项目、App build 和 recovery）。`verify:full` 报告路径为 `.codex_tmp/verification-reports/latest.json`；运行前后 5 个 UI 文件指纹未变化。
- 已通过：`pnpm.cmd run verify:electron-ui-state-continuity`，已实际启动 Electron 窗口并验证 composer draft、conversation/project/sidebar 状态、sidebar width 249、file navigator width 286、settings page、native window geometry 和 137px chat bottom reading gap。验收夹具现在等待 120ms resize settle 并显式派发用户滚动事件，仍要求最终锚点误差不超过 1px。
- 已准备并执行真实 Provider smoke runner：`pnpm.cmd run verify:web-provider` 能构建 `@littlesheep/types` 与 `@littlesheep/web`，检查关闭状态零 Provider 请求；无 key 时安全输出 `status: skipped, ok: false`。用户终端以测试 key 显式执行 `pnpm.cmd run verify:web-provider -- --require-live` 后，`disabled-zero-request` 通过，真实 Tavily search 以 1 次 Provider 请求返回 3 个非缓存、非 partial 的归一化结果；后续搜索结果关联 fetch 被 `web_ssrf_blocked` 正确阻断。成功 fetch 报告只输出 requested/final origin，不输出完整 URL；失败报告只输出白名单稳定 `web_*` error kind，完全不输出原始错误消息。runner 现会额外投影失败阶段并把 DNS/SSRF 拦截标记为 `blocked`。`verify-web-provider-smoke.test.mjs` 自动锁定无 key 跳过、初始化错误脱敏、阶段/状态分类和成功报告的 origin-only 字段契约。
- 为避免已知 Fake-IP 环境反复消耗 Provider 配额，strict smoke 在 Tavily search 前新增 `public-fetch-preflight`：它只用生产 URL policy 对固定匿名公共域名执行 DNS/IP 检查，不发 HTTP、不生成 citation、不消耗 fetch quota。当前环境以无效占位 key 实测在该阶段 `blocked/web_ssrf_blocked`，`providerRequests=0`；DNS 正常时 runner 仍必须完成真实 Tavily search、抓取搜索返回的首条规范 URL 并验证 Runtime citation。Provider/public-fetch 边界回归 18/18、脚本语法、仓库卫生 33/33 和 TypeScript 项目清单 28/28 均通过。
- 历史已通过独立真实公共 fetch smoke：使用构建后的 `WebRetrievalRuntime` 匿名 GET `https://example.com/`，收到 HTTP 200，正文抽取器为 `readability`，`externalUntrusted=true`，正文 185 字符，未截断；Runtime 生成 citation、`contentHash` 和 complete evidence。该证据只证明安全公共 `web_fetch` 路径，不证明 Tavily search 或 Provider 可用。其成功输出只投影 final origin、长度、hash 和 evidence metadata，失败输出仅为白名单 `web_*` kind 或 `unexpected_failure`，与 Provider smoke 保持相同的无原始错误消息边界。
- 当前环境复验 `pnpm.cmd run verify:web-fetch` 被 Runtime 正确阻断：系统 DNS 将 `example.com` 动态改写到保留的 `198.18.0.0/15` 基准测试网段，继续抽样的多个公开域名也落入同一保留网段，输出 `status=blocked`、`errorKind=web_ssrf_blocked`，未发生 HTTP 请求。2026-09-01 的只读系统诊断进一步定位到 `com.vortex.helper` 提供的本机代理 `127.0.0.1:7897` 与 `Meta Tunnel`，其 DNS 为 `198.18.0.1`；因此这是代理 Fake-IP 与“先解析并拒绝非公网地址、再锁定已检查 IP”的安全模型发生冲突，不是 Provider 配置失败。该结果不代表领域安全逻辑退化，反而证明 DNS/IP hard deny 保持有效；但它使本环境无法重新证明真实公共 fetch，WB-09 的真实网络门仍保持未闭合。一个隔离的只读原型已证明：从固定可信 HTTPS DNS 端点获得真实公网 A 记录后，现有公网校验与 IP pinning 请求可返回 HTTP 200；该实验不进入源码、不计为验收通过。若后续把代理兼容纳入产品，必须使用显式、可关闭、固定端点的 trusted-DoH 解析模式，并补齐隐私披露、A/AAAA 全量校验、DNS 响应上限、超时/取消、缓存 TTL、redirect 重检和发布回归；不能自动把任意 private/reserved 回答改用备用解析，更不能放行 `198.18.0.0/15`。当前发布复验应临时关闭 TUN/Fake-IP 或切换 real-IP/redir-host 等价模式，先确认公共域名返回全球可路由地址，再运行 Provider smoke。verifier 对 `web_ssrf_blocked` 和 `web_dns_check_failed` 显式输出 `blocked`，其他错误为 `failed`，避免把外部网络前置条件误写成已通过或普通代码故障。发布环境可用 `verify:web-fetch -- --url=https://<public-anonymous-page>/` 提供替代匿名公开页面；前导 `--` 仅用于 pnpm 参数转发，最多一个且只能位于开头，随后只允许唯一 `--url`。该输入最大 4,096 字符、未知参数失败，仍完整经过 Runtime 的 URL/DNS/IP/redirect/资源限制，完整 URL 不会进入输出，不能用它绕过 SSRF 检查。
- 已将上述公共 fetch 验收固化为 `pnpm.cmd run verify:web-fetch`；本轮通过，命令输出不包含页面正文、请求头、凭证或用户数据。
- 本轮更正：默认 `system` DNS 在 Fake-IP 环境下仍会以 `web_ssrf_blocked` 在 HTTP 前失败；显式 `--dns-resolver=cloudflare_doh` 已进入生产配置与 Runtime，并在本机真实通过匿名公共 GET、readability 抽取、`externalUntrusted`、Runtime citation 和 complete evidence。DoH 固定 Cloudflare endpoint/IP，校验 A/AAAA、响应大小、事务、超时/取消和 TTL，继续执行公网 IP、TLS SNI/Host、IP pinning 与 redirect 检查；它不是静默 fallback，也不接受任意 resolver endpoint。该证据不等于真实 Tavily 搜索结果关联 fetch/citation 已完成。
- 已通过本轮新增门：`pnpm.cmd run verify:web-release`。该门先运行 `verify:web-provider-boundary`，锁定 Tavily 401/403/429/500 映射和 smoke 报告不泄露 key、原始错误或完整 URL；再运行 `verify:web-llm-evidence-boundary`，锁定真实 LLM evidence verifier 自身失败时只投影稳定 error kind，不输出原始错误文本；随后迁移 verifier 证明旧 config 缺失 web 字段时默认关闭、新 config 只保存 secret reference、关闭/重启后零 Provider 调用、历史 execution log/checkpoint 可读、Memory 保留且普通本地写入可用；修复后的 Windows 候选重新扫描实际检查 659 个文件和 14363 个归档条目，测试 key、私密 fixture、用户 Memory 和绝对用户路径命中均为 0。`RunCheckpointStore` 新增 Web evidence reload 回归，避免 checkpoint 丢失 projection。完整矩阵见 [安全合并验收报告](../reference/web-retrieval-security-acceptance-2026-08-29.md) 和 [供应链审查](../reference/web-retrieval-supply-chain-review-2026-08-29.md)。
- 已通过离线渠道门：QQ、飞书、Telegram、Webhook 4 个插件测试文件、108 项通过；另有 `DefaultChannelManager` Web projection 回归和类型检查通过；这不是正式渠道凭证验收。
- 已通过本轮新增门：`pnpm.cmd run verify:web-performance`。在 48 次 fake-provider/fake-HTTP 隔离 run 中验证 Runtime search/fetch、citation、正文抽取、缓存和资源封套；外网请求为 0，P95 0.31ms，heap delta 1,095,592 bytes，HTTP 读取 1 次、缓存命中 47 次、缓存 18,895 bytes。Renderer 来源卡新增 partial/truncated 与稳定错误标签覆盖，错误 id 不直接面向用户；CLI/channel formatter 继续只使用 `WebEvidenceProjection`。这两项均不替代真实互联网、真实 Provider 或真实 LLM 输出验收。
- 本轮继续复核通过：`pnpm.cmd run verify:core`（132 项通过），Web 领域/工具/Harness 定向回归（12 个测试文件、111 项通过），`pnpm.cmd run verify:web-release`（迁移/回退、构建产物敏感扫描）以及 `pnpm.cmd audit --prod --json`（各严重级别 0）。这些结果未改变真实 Tavily、正式渠道、签名和干净 Windows 发布门的状态。
- 本轮补齐工具维护入口和仓库卫生门：`packages/tools/src/builtin/README.md` 已登记 `web_search`/`web_fetch` 与 Runtime、匿名 GET、`external_untrusted`、projection、失败关闭边界；`packages/app/src/main/index.ts` 因现有启动状态恢复改动达到 603 行，已在模块拆分图登记为受控超限文件（620 行上限、2026-09-24 复查），不改变启动逻辑。随后 `pnpm.cmd exec vitest run packages/tools/src/builtin/web-tools.test.ts packages/tools/src/tool-execution-service.test.ts packages/tools/src/registry.test.ts` 通过 3 个文件、49 项；`pnpm.cmd run check:repo` 恢复 33/33，`git diff --check` 通过。
- 已建立 [发布清单与已知限制](../reference/web-retrieval-release-checklist-2026-08-29.md)，明确每个发布当天需要的真实 smoke、渠道、release 包扫描和禁止发布条件。
- 已确认未完成：真实 Tavily 搜索结果关联 fetch/citation、Provider auth/rate-limit/timeout 线上结果、真实 Tavily evidence 驱动的端到端 LLM 联调、QQ/飞书/Telegram/Webhook 正式运行时、签名安装器、干净 Windows 安装/升级/卸载、用户数据与版本升级解耦验证，以及发布当天 checklist 的重新执行。
- 已完成当前 release 候选门：修复发布脚本共享 staging 竞态、前置发布锁并接入本地 prepared Electron runtime 后，`pnpm.cmd run package:win` 和 `pnpm.cmd run package:win-installer` 串行成功；`node scripts/verify-web-release-artifacts.mjs --root=release` 通过（扫描 659 个文件、14363 个归档条目、0 个读取错误、0 个 provider-secret literal、0 个 fixture-private marker、0 个 embedded user memory、0 个 absolute user path）。锁冲突快速路径和发布脚本单测 2/2 通过。NSIS 安装器候选为未签名产物，不能视为正式发布。
- 已完成一次无凭证的 Tavily 官方公开资料复核：Search API 当前为 Bearer `POST /search`，`max_results` 上限为 20；当前公开 API credit 规则为 basic/fast/ultra-fast 每次 1 credit、advanced 每次 2 credits，公开定价页显示 Free 每月 1,000 credits、PAYG 每 credit USD 0.008。平台条款允许调整 rate limit、地域/环境和认证要求；隐私政策说明 query data 可能用于改进响应、有限情形可转交第三方索引，且公开保留规则不是固定 TTL。该证据进一步支持最小 query、敏感 query 阻断和显式启用，但没有 key、未发生 Provider API 请求，不能证明实际账户限额、部署地可用性、DPA/保留例外或 real smoke。同期补强 `TavilySearchProvider` 的 HTTP 映射测试：401/403 均为不可重试的 `web_provider_auth_failed`，429 为带 `retryAfterMs` 的可重试 `web_provider_rate_limited`，500 为可重试 `web_provider_unavailable`；定向测试 11 项通过。详见 [供应链审查](../reference/web-retrieval-supply-chain-review-2026-08-29.md)。
- 既有 recovery warning：少数采样 runId 没有对应 execution log；workspace layout 快照包含非默认外部根目录。该 warning 尚未证明阻断本专项，但必须在发布前决定是否修复、豁免并留证。
- 2026-09-01 继续收口 HTTP 解压失败边界：未知 `Content-Encoding` 现在经同一稳定错误路径关闭/清理响应流并返回非重试 `web_content_unsupported`，不会从 HTTP 回调同步逸出或携带原始编码文本。`http-client`、`url-policy`、`service` 定向矩阵为 3 个文件、46 项通过，随后 `@littlesheep/web` build 与 `verify:web-release` 通过；没有发生 Provider 或公共网页请求。该离线安全加固不替代真实 Tavily search/fetch/citation、正式渠道、签名和干净 Windows 门。

完成门：所有 Definition of Done、真实 smoke、安全/回归/迁移证据、UI/渠道验证和一键回退均通过，才把专项状态改为“已完成/ready”。
停止条件：真实 smoke、敏感数据扫描、SSRF、citation validation、取消或 `verify:full` 任一失败，立即保持/切回 `disabled` 或 `degraded`，修复后从失败工作包重验。

### 14.0.1 强制顺序与允许并行度

~~~tex
WB-01 中央安全判定
  -> WB-02 每轮 Runtime 注入
  -> WB-03 Web 领域层加固（WB-02 后段可与其并行，但不得并改共享策略文件）
  -> WB-04 两个内置工具/注册
  -> WB-05 evidence 与 durable 双投影
  -> WB-06 Harness 路由与 citation final reply
  -> WB-07 Memory/egress 协同
  -> WB-08 App/CLI/channel
  -> WB-09 真实网络、迁移、发布和回退
~~~

允许的有限并行：WB-03 的 isolated Web package 测试可与 WB-02 的 Runner 注入测试并行；WB-08 的静态来源卡原型可在 WB-05 contract 冻结后并行，但不得连接真实数据流；WB-07 的 egress fixture 可在 WB-06 routing 前准备。所有并行工作必须最终回到 WB-01 的权限结论、WB-05 的 evidence projection 和相同的 `NetworkReadPolicy`，不能各自创建 provider、审批或日志协议。

禁止的并行：在 WB-01 前接工具；在 WB-03 的 SSRF/HTTP gate 前开启 `web_fetch`；在 WB-05 前把网页正文写进 durable store；在 WB-06 前让普通 REPLY 任意拿到 web tools；在 WB-09 前把 provider 状态显示为 `ready` 或执行发布。

### 阶段 0：契约冻结与威胁模型（WSR-000 至 WSR-006）

状态：已完成（2026-08-29）
目标：在写代码前冻结语义，防止 provider、权限和 UI 各自发明一套规则。

任务：

1. WSR-000：确认本任务书为专项唯一执行入口，标记当前“设计已冻结、实现已局部开始但尚未形成可用闭环”。
2. WSR-001：冻结 safe read 的定义、三档权限新语义和 strictReadApproval 兼容开关。
3. WSR-002：冻结 effect、egress、trust、boundary 和 safeReadClass 的公共语义。
4. WSR-003：冻结 web.enabled、一次性网络授权、provider 配置和旧用户迁移策略。
5. WSR-004：建立威胁模型，覆盖 SSRF、DNS rebinding、内容注入、数据外发、API key、限流、成本、缓存泄露、解析器 DoS 和浏览器身份。
6. WSR-005：确定第一 provider、许可证、费用、地区可用性、测试方式和禁用 fallback。
7. WSR-006：冻结错误码、citation 规则、截断语义、日志脱敏和发布状态枚举。

完成证据：

- [网络检索冻结契约与威胁模型](../reference/web-retrieval-security-contract.md) 固定 safe read、Access Descriptor、迁移、威胁、错误、引用、日志和发布状态；
- 首个 Provider 固定为 `tavily / tavily-search-v1`，默认关闭，禁用隐式 HTML scraping 和未配置 Provider fallback；
- 价格、条款和地区可用性标记为发布前必须重新核对的外部事实，不硬编码进 Runtime。

交付物：

- 本任务书的冻结记录；
- provider 选择记录；
- 网络安全威胁模型；
- 兼容/迁移说明；
- 不依赖真实密钥的契约夹具。

验收：

- 产品、Runtime、Tools、App 对“免逐次审批”和“一次性网络授权”使用同一含义；
- 任何人都不能从文档推导出“所有 read 自动放行”；
- 第一 provider 和 browser fallback 都有明确的 enabled/disabled 语义；
- 所有后续阶段的公共字段和错误大类已经可追踪。

### 阶段 1：公共类型、配置和运行投影（WSR-100 至 WSR-109）

状态：已完成（2026-08-29，定向契约门通过）
依赖：阶段 0
目标：先建立稳定契约，再实现具体 provider。

任务：

1. WSR-100：在 packages/types 增加 web request/response、citation、evidence、provider health、network policy 类型。
2. WSR-101：扩展 ConfigSchema，增加 web 域、provider 配置、上限和默认值。
3. WSR-102：扩展 ResolvedRunConfig，保存本轮实际 network policy、provider id 和能力快照。
4. WSR-103：扩展 ToolContext，向工具提供只读 network policy、AbortSignal、日志和 evidence sink。
5. WSR-104：定义稳定 WebErrorKind 和 partial/completeness 枚举。
6. WSR-105：为 ToolResult/meta 设计有界 web evidence 投影，不把完整正文塞进工具调用记录。
7. WSR-106：为 checkpoint、execution log 和历史恢复确定可选字段及向后兼容解析。
8. WSR-107：把所有新增类型从公共 index 导出，并更新包 README。
9. WSR-108：添加配置迁移和默认值测试，覆盖缺失、非法、过大和未知字段。
10. WSR-109：建立 fake provider/fake fetch 的共享测试 fixture。

完成证据：

- `packages/types/src/web-retrieval.ts`、`ToolContext`、`ToolResult`、`ResolvedRunConfig`、checkpoint 和 execution log 已加入向后兼容的有界契约；
- `packages/config` 已增加默认关闭的 `web` 域和旧配置默认迁移；
- `packages/runner/src/run-config.ts` 每轮冻结 `NetworkReadPolicy` 和脱敏 Provider 快照；
- `test/fixtures/web-retrieval` 提供归一化结果、Tavily 原始响应和含注入文字的公开页面夹具；
- 2026-08-29 定向测试：4 个文件、31 项通过；types/config 重建后 runner 单包 typecheck 通过。

验收：

 - 阶段 1 直接涉及的 types/config/runner 契约测试和包级 typecheck 通过；全仓 typecheck 作为 WSR-1000 发布门再次执行；
- 旧配置不配置 web 时行为不变；
- 网络策略不会被 TaskBook patch、LLM 输出或 Renderer 改写；
- checkpoint 读取旧版本不失败，新版本字段有界；
- 测试 fixture 不需要真实 API key。

### 阶段 2：安全读取权限与网络边界（WSR-200 至 WSR-214）

状态：已完成（2026-08-29；WB-01 中央 safe-read/hard-deny 子门与 WB-03 URL/DNS/IP/redirect/HTTP 执行前网络子门均已通过）
依赖：阶段 1
目标：在工具真正联网前完成中央安全判定。

任务：

1. WSR-200：扩展 PermissionBoundaryContext，加入 network policy 和 safe read policy。
2. WSR-201：在 packages/safety 新增 URL canonicalization、scheme、credential、host/IP 和 redirect 检查。
3. WSR-202：实现 DNS 解析后二次 IP 校验和 rebinding 防护接口。
4. WSR-203：扩展 ToolAccessDescriptor 的 effect/egress/trust/safeReadClass。
5. WSR-204：实现统一 isSafeAutonomousRead 和 hard deny 判定。
6. WSR-205：调整 shouldRequestPermissionApproval：safe local read/public web read 在策略允许时不请求逐次批准。
7. WSR-206：让 authorizeToolAccess、ToolExecutionService、direct-tool-proposal、TaskBook scheduler 复用同一判定。
8. WSR-207：处理 restricted 模式兼容、strictReadApproval 和 resolved approvalRequiredToolNames。
9. WSR-208：将 memory_search、memory_deep_search、memory_tree 标记为 runtime-owned safe read，但保留远程 embedding egress 检查。
10. WSR-209：保证普通 read、外部路径、浏览器、认证 URL 不因 memory/web 例外而被放开。
11. WSR-210：加入 approval record 的 not_required/safe_read 记录，让“没有弹窗”仍可审计。
12. WSR-211：覆盖 hard deny 优先于 full、research 和 restricted 的组合规则。
13. WSR-212：覆盖取消、审批锁、并发和重新检查，避免 TOCTOU。
14. WSR-213：更新 safety/tools/harness 的 README 和权限测试契约。
15. WSR-214：更新 AGENTS/架构原则中的目标权限语义；在实现未完成前标记为 proposed，而不伪装当前状态。

必须测试：

- 三种模式 × local memory/public search/public fetch/outside read/authenticated/browser/write/exec；
- file/data/javascript/credential URL；
- localhost、IPv4/IPv6 私网、metadata、DNS 失败和重定向到私网；
- web tool 被错误声明为 read、plugin source、缺失 policy、缺失 container root；
- strictReadApproval 开关；
- approval callback 缺失、拒绝、取消和并发调用。

阶段门拆分：

- 已通过的中央权限子门：WSR-200、WSR-203、WSR-204、WSR-205、WSR-206、WSR-207、WSR-208、WSR-209、WSR-210、WSR-211、WSR-212、WSR-213、WSR-214 的 safe-read/hard-deny 相关部分，由 WB-01 记录和 82 项定向回归证明。
- 已通过的网络领域子门：WSR-201、WSR-202，以及 URL canonicalization、DNS/IP 决策、连接地址固定、redirect 每跳重验和 HTTP 生命周期证明，由 WB-03 的 fake transport 安全回归证明。

验收：

- restricted 下安全读取不弹逐次批准；
- restricted 下普通文件读取、浏览器认证和写入仍按原规则；
- 任何未知网络目标 fail closed；
- Full 模式不能绕过硬拒绝；
- direct proposal 和 ToolExecutionService 得出完全一致的审批结论。

WB-01 实际完成记录（2026-08-29）：

- 修改文件：`packages/safety/src/permission-boundary.ts`、`packages/safety/src/permission-boundary.test.ts`、`packages/tools/src/tool-execution-service.ts`、`packages/tools/src/tool-execution-service.test.ts`、`packages/harness/src/stages/execute/direct-tool-proposal.ts`、`packages/harness/src/stages/execute/direct-tool-proposal.test.ts`、`packages/harness/src/stages/execute/task-step-scheduler.ts`、`packages/harness/src/stages/execute/task-step-scheduler.test.ts`、`packages/app/src/main/run-policy.ts`、`packages/app/src/main/run-policy.test.ts`、`packages/runner/src/index.ts`。
- 关键实现：新增 `allow/approval/deny` 完整权限决策与 `hard_denied/blocked` 审计状态；hard deny 在审批、重复计数和执行前结束；local memory、local session、启用的匿名 public web search/fetch 在默认策略下属于 safe read；`strictReadApproval` 只对 safe-read 恢复 research/restricted 的逐次审批；`session_status(action=set)`、普通文件读取、外部读取、写入和 exec 不被扩大放行；Runner 公共入口导出 `resolveNetworkReadPolicy`，Main 侧重新使用同一 strict-read 策略回查。
- 定向测试证据：`pnpm.cmd exec vitest run packages\\safety\\src\\permission-boundary.test.ts packages\\tools\\src\\tool-execution-service.test.ts packages\\harness\\src\\stages\\execute\\task-step-scheduler.test.ts packages\\harness\\src\\stages\\execute\\direct-tool-proposal.test.ts packages\\app\\src\\main\\run-policy.test.ts packages\\app\\src\\main\\local-app-api\\terminal-permission.test.ts packages\\runner\\src\\execution-log.test.ts`；2026-08-29 实际运行结果为 7 个文件、82 项通过：WB-01 核心安全矩阵与入口测试 55 项，`execution-log` 23 项，terminal permission 4 项。
- 类型/构建证据：`@littlesheep/types`、`@littlesheep/safety`、`@littlesheep/tools`、`@littlesheep/harness`、`@littlesheep/runner` 均通过 package typecheck；`@littlesheep/runner` build 通过；`@littlesheep/app` typecheck（main + web）通过。
- 真实网络请求：未发生。所有测试使用本地 policy 和 fake tool，不使用 API key，不访问真实 provider。
- 遗留项：WB-02 已完成 Runner 每轮 runtime 注入，WB-03 已完成 URL/DNS/IP/redirect/HTTP 生命周期加固，WB-04 至 WB-08 已完成工具、证据、Harness、Memory、App/CLI/channel 的离线/定向实现门；用户可用闭环仍因 WB-09 的真实 Provider、全量安全/发布和 Electron/渠道正式验收未完成而不得标记 ready。
- 完成门结论：中央权限子门通过。hard deny 在 full/research/restricted 下均未调用 approval callback 或 `tool.execute()`；默认 safe-read 未弹逐次审批；严格模式、Main 回查、direct proposal 和 TaskBook scheduler 结论一致。阶段 2 的网络领域子门另由 WB-03 证明，二者合并后阶段 2 完成。

### 阶段 3：Provider port、registry 与第一个 provider（WSR-300 至 WSR-312）

状态：已完成（2026-08-29，Provider/registry/Tavily 领域层；真实 provider smoke 仍按阶段 10/WB-09 执行）
依赖：阶段 1、阶段 2
目标：实现与模型无关的搜索 provider 层。

任务：

1. WSR-300：创建 packages/web 的 provider port、contracts、errors 和 index。
2. WSR-301：实现 provider registry、能力声明和配置解析。
3. WSR-302：实现 apiKeyRef/env/keychain resolver，统一脱敏错误。
4. WSR-303：接入第一 provider，完成 query、domain、recency、language 和 maxResults 映射。
5. WSR-304：归一化标题、URL、snippet、publishedAt、siteName、rank 和 citationId。
6. WSR-305：处理 HTTP 状态、provider JSON 变更、空结果、限流、鉴权失败和未知字段。
7. WSR-306：实现有限重试、退避、AbortSignal 和 provider timeout。
8. WSR-307：实现 provider health/configuration check，不在普通查询中泄露 key。
9. WSR-308：实现 fake provider contract test 和 provider response fixture。
10. WSR-309：加入 provider 版本/能力快照到 evidence。
11. WSR-310：明确 provider 不可用时不自动抓搜索引擎 HTML。
12. WSR-311：为中文 provider、自托管 SearXNG 和 hosted-native adapter 保留扩展测试接口。
13. WSR-312：更新 packages/web README 和生产依赖安全记录。

验收：

- fake provider、未配置 provider、限流、超时、取消和空结果均有稳定结果；
- provider 原始响应不直接进入模型；
- citationId 每次只绑定一个真实来源；
- API key 不出现在任何测试 snapshot、日志和错误；
- provider 可以替换而不改 Harness/permission 逻辑。

### 阶段 4：web_search 工具与统一执行（WSR-400 至 WSR-410）

状态：已完成（2026-08-29，WB-04；仅离线/定向实现门，真实 Provider smoke 归阶段 10）
依赖：阶段 2、阶段 3
目标：把 provider 作为真正的 LS 工具接入。

任务：

1. WSR-400：新增 web_search AgentTool 和 bounded input schema。
2. WSR-401：实现 query trim、Unicode/control character、长度和敏感信息初筛。
3. WSR-402：只从已解析的 network policy 选择 provider，不接受模型指定任意 endpoint。
4. WSR-403：调用 SearchProvider，返回归一化 SearchResponse。
5. WSR-404：实现 max results、query quota、timeout、cancel、retry 和 repeat-call 限制。
6. WSR-405：把 provider、query hash、citation、cached、partial 写入 evidence/meta。
7. WSR-406：标记工具为 public_web_search safe read，但每次仍由 Runtime 重新计算。
8. WSR-407：在 Runner/registry 中装配，保持 provider 依赖注入，不在工具内创建全局客户端。
9. WSR-408：更新工具清单、模型工具 prompt 和运行时能力投影。
10. WSR-409：为 provider 未配置、网络关闭、空结果和部分结果编写用户可见事实。
11. WSR-410：接入 ToolExecutionService 的超时、清洗、记录和事件。

验收：

- web_search 在 research/restricted 下不弹逐次审批；
- 网络关闭时不发请求；
- 查询次数、长度、并发和总超时硬上限生效；
- 结果有 citationId 和 fetchedAt；
- provider 错误不会被模型误认为成功；
- 重复相同 query 不无界重试。

实施证据：WB-04 已完成两个 strict 内置工具、registry/ToolExecutionService 接线、敏感 query 规则、最终 capability gate 和零网络失败关闭测试；定向 Safety/Tools/Harness 5 个文件 99 项、Runner capability/runtime 3 个文件 12 项通过，Types/Safety/Tools/Web/Harness/Runner typecheck 通过。未使用真实 Provider key。

### 阶段 5：web_fetch、本地 HTTP 和正文抽取（WSR-500 至 WSR-520）

状态：已完成（2026-08-29，WB-03/WB-04/WB-05/WB-08 的离线实现门；真实公共 `web_fetch` smoke 已在阶段 10 通过，真实 Tavily search/citation、搜索结果关联 fetch 和 Electron 网络闭环仍归阶段 10）
依赖：阶段 2、阶段 3
目标：安全获取公开页面并返回有界正文。

任务：

1. WSR-500：实现 WebFetchService 和 HTTP client port。
2. WSR-501：新增 web_fetch AgentTool，输入只允许 url/citationId/maxChars。
3. WSR-502：实现 URL canonicalization、scheme、credential、DNS/IP、redirect 检查。
4. WSR-503：实现匿名 GET、timeout、AbortSignal、响应大小和解压大小限制。
5. WSR-504：实现 HTML/text/plain/有限 JSON 内容类型处理。
6. WSR-505：接入 Readability/Markdown extractor，并清除脚本、样式、导航和隐藏控制内容。
7. WSR-506：实现字符集、异常编码、空正文和解析器错误降级。
8. WSR-507：计算 contentHash、保存 redirectChain、truncated、extractor 和 fetchedAt。
9. WSR-508：拒绝 file/data/javascript、私网、metadata、URL credentials 和任意 headers。
10. WSR-509：实现 public_web_fetch safe read 分类；认证/浏览器/unknown 进入审批或拒绝。
11. WSR-510：实现 fetch cache，短 TTL、大小上限、清理和禁用。
12. WSR-511：实现 provider 搜索结果到 fetch 的 citationId 关联。
13. WSR-512：处理 3xx、4xx、5xx、压缩炸弹、内容过大、超时和取消。
14. WSR-513：增加 SSRF、DNS rebinding 和 redirect regression fixture。
15. WSR-514：暂不实现 PDF/OCR/音视频；为后续 adapter 留接口。
16. WSR-515：浏览器后备只定义 port 和显式 approval boundary，不在本阶段默认启用。
17. WSR-516：更新 web/tools README 和安全依赖记录。
18. WSR-517：在真实公开测试页面和本地 fixture 上验证 HTML 抽取。
19. WSR-518：验证不把响应自动写入 workspace、daily 或长期 memory。
20. WSR-519：验证 fetch 工具被取消后底层 socket/stream 能关闭。
21. WSR-520：验证最终 URL 变化和截断状态在 UI/evidence 中可见。

验收：

- public HTTPS 页面可以得到正文、标题、hash、时间和来源；
- 私网和重定向绕过全部被阻断；
- 受限模式下匿名公共 fetch 不弹逐次审批，认证浏览器仍需审批；
- 内容超限明确标记 truncated；
- fetch 失败不被包装成空成功；
- 取消和超时后没有悬挂请求。

实施证据：WebFetchService、匿名固定地址 GET、正文抽取、cache、citation binding、`web_fetch` AgentTool、模型/durable 双投影和来源 projection 已接通；覆盖 SSRF、DNS rebinding、redirect、IPv4/IPv6、压缩/响应上限、取消/timeout、prompt injection、cache 和错误脱敏的 Web 定向回归全部通过。`verify:web-fetch` 已以固定 `https://example.com/` 完成 `WSR-517` 所需的真实公共 fetch 路径 smoke；该证据不能替代真实 Tavily search 或搜索结果到页面的真实关联链路。

### 阶段 6：证据、引用、缓存和持久化（WSR-600 至 WSR-614）

状态：已完成（2026-08-29，WB-05；离线/定向 evidence 与 durable projection 门）
依赖：阶段 4、阶段 5
目标：让“实时检索”可核查、可重放、可解释。

任务：

1. WSR-600：定义 WebCitation/WebEvidenceBundle 的 execution evidence 适配。
2. WSR-601：把搜索和抓取调用与 tool call、step、run、provider 关联。
3. WSR-602：实现 citation token 生成、绑定、去重和排序。
4. WSR-603：把 cached、partial、blocked、truncated、stale 写入证据。
5. WSR-604：扩展 execution log 的有界序列化和旧版本读取。
6. WSR-605：保存 query/url 的脱敏摘要或 hash，不默认保存敏感原文。
7. WSR-606：实现 source completeness 和 conflict 记录。
8. WSR-607：实现缓存命中和缓存失效证据。
9. WSR-608：为 citation validation 设计结构化输入和输出。
10. WSR-609：验证模型不能引用不存在的 source id。
11. WSR-610：实现 source drawer 所需的 UI-facing projection，隐藏内部安全字段。
12. WSR-611：实现 retrieval 事件和指标。
13. WSR-612：将 evidence 纳入 VERIFY 的验收输入。
14. WSR-613：实现重启后读取历史检索证据，不重复自动联网。
15. WSR-614：实现用户清除 web cache 的数据生命周期。

验收：

- 每个最终 citation 都能回到真实 provider/fetch record；
- 缓存结果明确标记，不伪装成刚刚获取；
- 截断、部分和冲突不会被隐藏；
- execution log 有界且不含 key/敏感正文；
- 重启后能看历史来源，但不会因打开历史而重新请求网络。

实施证据：WB-05 合并回归覆盖 21 个文件、231 项测试并全部通过；模型只获得 run-local 有界正文，AgentResult、tool result、checkpoint、execution log、replay 和 UI-facing 数据只保留脱敏 `WebEvidenceProjection`；citation token 由 Runtime 生成并在 final reply 校验，历史恢复不重复联网。未使用真实 Provider key。

### 阶段 7：Harness 检索路由与回答闭环（WSR-700 至 WSR-724）

状态：已完成（2026-08-29，WB-06；fake-provider/离线 Harness 闭环，真实网络行为归阶段 10）
依赖：阶段 4、阶段 5、阶段 6
目标：让普通用户请求真的触发检索，并保持轻量流程。

任务：

1. WSR-700：扩展 classifier/NeedAssessment 的 retrieval intent。
2. WSR-701：区分 capability_question、local search、memory search 和 web search。
3. WSR-702：让明确实时请求进入 execute 的 compact retrieval strategy。
4. WSR-703：扩展 compact retrieval tool catalog 和 bounded contract。
5. WSR-704：更新 compact contract 中关于 network/memory 的旧排除文字。
6. WSR-705：为明确 URL、普通搜索、记忆+网络组合分别定义最小工具集。
7. WSR-706：保证单次 web_search/web_fetch 可直接执行并生成 final reply。
8. WSR-707：多来源研究进入标准 TaskBook，保留步骤、依赖、sideEffect 和 acceptance。
9. WSR-708：在 execute tool loop 中支持 web evidence 归并和 citation context。
10. WSR-709：扩展 final reply prompt，明确外部内容封套和 citation 规则。
11. WSR-710：在最终回答发布前校验 citation id、partial/truncated 和 provider status。
12. WSR-711：引用失败时有限重新生成；耗尽后返回 Runtime 错误/不完整状态。
13. WSR-712：VERIFY 检查来源覆盖、时间要求、用户问题覆盖和未完成步骤。
14. WSR-713：RECOVER 只重试失败搜索/抓取步骤，不重复已完成来源。
15. WSR-714：provider 失败时禁止 fallback 到训练知识而不标记。
16. WSR-715：实现用户取消、网络关闭、配额耗尽和中断恢复。
17. WSR-716：验证普通 REPLY 不会在 capability_question 上误触发搜索。
18. WSR-717：验证搜索请求不启动完整复杂 TaskBook。
19. WSR-718：验证多页面研究不被 compact 单工具限制错误截断。
20. WSR-719：更新 LlmCallContract registry、model request snapshot 和 usage 记录。
21. WSR-720：对当前 DeepSeek/OpenAI-compatible Chat Completions 做 function tool 校准。
22. WSR-721：为 hosted-native adapter 保留独立能力测试，不影响普通 provider。
23. WSR-722：验证最终回复仍遵守 ReplyProvenance 和会话级去重。
24. WSR-723：验证实时回答的来源链接可在历史恢复后继续打开。
25. WSR-724：更新 Harness README 和 core flow 文档。

验收：

- “今天/最新/查来源”会搜索；
- “LS 支持搜索吗”不会无故搜索；
- “搜索我的项目”不会发到网页 provider；
- 简单查询最多一个最小检索步骤和一个最终回答调用；
- 多来源研究有步骤级证据和 VERIFY；
- provider/HTTP 失败时最终回答不伪造已查证；
- citation 不存在、截断或冲突时结果明确可见。

实施证据：已实现 `RetrievalIntent` 路由、compact retrieval、标准 TaskBook 检索、按意图过滤 Web 工具、Memory+Web contract 和 final citation validation；定向 5 个文件、61 项测试通过，Harness typecheck 通过。已证明能力询问、本地工作区/记忆查询不会触发 Web，browser-required 不会被匿名 fetch 伪装。未执行真实 Provider smoke。

### 阶段 8：Memory 协同与外发治理（WSR-800 至 WSR-814）

状态：已完成（2026-08-29，WB-07；本地 embedding 与 Memory/Web 写入治理门）
依赖：阶段 2、阶段 6、阶段 7
目标：把本地记忆和实时资料组合起来，但不扩大隐私外发和长期记忆污染。

任务：

1. WSR-800：把 memory safe read 纳入统一安全读取判定。
2. WSR-801：验证本地 embedding 路径不触发隐藏网络请求。
3. WSR-802：若支持远程 embedding，明确 egress、开关、日志和审批策略。
4. WSR-803：实现 memory-first / web-freshness retrieval strategy。
5. WSR-804：生成最小 web query，禁止整段会话/记忆拼接。
6. WSR-805：在 evidence 中区分 memory source 和 web source。
7. WSR-806：实现网页结果默认不写 Memory 的结构化保护。
8. WSR-807：实现用户明确保存实时事实时的 MemoryWriteIntent 适配。
9. WSR-808：保存 sourceUrl、fetchedAt、hash、expiry、scope 和 write reason。
10. WSR-809：让过期网页、冲突网页和旧 memory 进入不同验证分支。
11. WSR-810：验证网页 prompt injection 不会触发 memory write。
12. WSR-811：验证 memory query 的结果不被自动全部复制到 web query。
13. WSR-812：更新 Memory Tree 访问账本，记录本地检索与 web follow-up 的关系。
14. WSR-813：增加跨重启、跨模型和远程 provider 的 egress regression。
15. WSR-814：更新 memory 文档和用户隐私说明。

验收：

- 本地 memory 查询在 restricted 下无逐次审批；
- 远程 embedding 被明确标记和控制；
- 只查询网页不会自动产生长期 memory；
- 用户明确保存时可追溯到来源和写入理由；
- memory/web 冲突不会用一个来源覆盖另一个来源。

实施证据：本地 Memory safe read、`embeddingMode: 'local'`、Memory-first 最小 query、Web/Memory evidence 分层、Web-only 禁止写入、明确用户保存才进入 Memory Write Gate 均已落地；定向 5 个文件、83 项测试通过，Config/Harness typecheck 通过。未发生公共网络请求，远程 embedding 仍是未来单独能力，不属于本门已实现范围。

### 阶段 9：App、设置和渠道交互（WSR-900 至 WSR-919）

状态：已完成（2026-08-29，WB-08；Main/Renderer/CLI/channel 代码与定向测试，Electron/渠道正式验收归阶段 10）
依赖：阶段 1、阶段 6、阶段 7
目标：让能力可发现、可控制、可解释，但不把 UI 做成第二套 Runtime。

任务：

1. WSR-900：在设置页增加网络读取开关和 provider 配置状态。
2. WSR-901：显示安全读取自动执行与 strictReadApproval 状态。
3. WSR-902：增加 provider 健康、未配置、限流和网络关闭状态。
4. WSR-903：增加缓存开关、清理和保留期限。
5. WSR-904：增加 allowlist/blocklist 和浏览器后备策略。
6. WSR-905：在首次启用时显示数据外发说明。
7. WSR-906：在 assistant turn 中渲染 citation 和来源卡。
8. WSR-907：显示 fetchedAt、publishedAt、cached、partial、truncated 和 finalUrl。
9. WSR-908：来源卡支持展开原始摘要/正文片段，但遵守输出上限。
10. WSR-909：错误状态明确显示网络关闭、provider error、blocked、timeout、partial。
11. WSR-910：不显示 API key、Cookie、内部请求头、完整敏感 query。
12. WSR-911：把 retrieval progress 接入现有任务进度，不新增重复进度体系。
13. WSR-912：历史 assistant turn 能恢复 citation projection，不重复请求。
14. WSR-913：为 CLI 提供等价配置和来源文本格式。
15. WSR-914：为 QQ/飞书/Telegram/Webhook 定义 citation fallback。
16. WSR-915：渠道默认禁用浏览器认证后备，除非明确配置。
17. WSR-916：更新设置测试、渲染测试和 accessibility。
18. WSR-917：验证 Renderer 不能直接改变 network policy。
19. WSR-918：验证 Local App API 只传安全 projection。
20. WSR-919：更新用户帮助、TOOLS.md 和隐私文档。

验收：

- 用户知道是否联网、使用哪个 provider 和是否命中缓存；
- 来源可点击且与真实 evidence 一致；
- 关闭网络后 UI、CLI、渠道都不再发请求；
- 历史加载不重复联网；
- UI 不生成或改写 Runtime 权限事实。

实施证据：RuntimeState.web、Main allowlist/schema revalidation、设置页、三类 egress 展示、provider 状态、cache 清理、来源卡、历史 projection、CLI/channel 安全 formatter 已落地；定向 8 个文件、52 项测试通过，App/CLI/Plugins typecheck 通过。新增的 `DefaultChannelManager` 回归用真实 `RunnerResult.webEvidence` 验证完整来源与 partial/truncated/blocked 状态可达渠道，同时断言页面正文、原始 query 和内部 `web_provider_rate_limited` 不进入消息。已检查裸 Vite Renderer 页面，但它没有 Electron Main Local App API，不能作为 Electron 端到端验收；正式 Electron 网络闭环、QQ/飞书/Telegram/Webhook 运行时验证仍列入阶段 10。

### 阶段 10：安全、性能、真实 provider 与发布（WSR-1000 至 WSR-1024）

状态：进行中（2026-09-02；WB-09 的稳定工作树全量、离线、Electron 和真实 DeepSeek V4 Flash 合成 evidence 门已完成；本轮重新通过专项发布、性能、核心传输和设置/权限边界门。真实 Provider public-fetch/citation 与发布环境仍待满足）
依赖：阶段 2 至阶段 9
目标：在声明可用前完成全链路验证和回退准备。

任务：

1. WSR-1000：运行定向 safety、types、tools、web、harness、runner 和 app 测试。
2. WSR-1001：运行 typecheck、package build、core verification 和 full verification。
3. WSR-1002：在隔离 data root 中使用真实 provider 做 opt-in smoke test。
4. WSR-1003：验证无 key、无网络、provider 限流和 provider schema 变化。
5. WSR-1004：验证 SSRF、DNS rebinding、redirect、IPv6、压缩炸弹和超大正文。
6. WSR-1005：验证 prompt injection、伪造 citation、伪造 tool result 和恶意 URL。
7. WSR-1006：验证 query、key、cookie、正文、内部路径不会进入不应有的日志。
8. WSR-1007：验证取消、超时、重启、断开 SSE 和后台任务生命周期。
9. WSR-1008：验证缓存上限、清理、过期和损坏恢复。
10. WSR-1009：验证每轮 query/fetch/bytes/concurrency/total timeout 硬上限。
11. WSR-1010：验证并行 fetch 的资源封套、确定性归并和失败隔离。
12. WSR-1011：验证多 provider adapter 不改变 safe read 结论。
13. WSR-1012：验证 browser fallback 仍需独立审批。
14. WSR-1013：验证网络能力关闭时所有入口 fail closed。
15. WSR-1014：完成依赖许可证、漏洞、版本和供应链检查。
16. WSR-1015：完成配置迁移、升级和回滚演练。
17. WSR-1016：写入项目状态，但只报告已通过的真实场景。
18. WSR-1017：更新所有 README、架构原则、AGENTS 和任务入口。
19. WSR-1018：建立 feature flag 和一键禁用 provider 的回退。
20. WSR-1019：确认默认不会启用未配置 provider。
21. WSR-1020：确认发布包中不包含测试 key、真实 query、缓存正文和用户数据。
22. WSR-1021：完成性能基线和资源趋势记录。
23. WSR-1022：完成用户可见错误和部分完成文案的真实 LLM/Runtime 联调。
24. WSR-1023：完成 release checklist 和已知限制清单。
25. WSR-1024：只有所有发布门通过后，将专项状态改为已完成。

阶段 10 当前验收状态（2026-08-30）：

| 验收组 | 状态 | 证据或阻断 |
| --- | --- | --- |
| WSR-1000 定向回归 | 已通过 | 2026-09-01 21:40 的 `pnpm.cmd run verify:full` 通过 389 个测试文件、2,654 项通过、1 项 skipped；运行包含 workspace 构建、App 构建和 recovery，recovery 保留两类历史 warning |
| WSR-1001 类型、构建与核心门 | 已通过 | `pnpm.cmd run check:repo` 33 项、28 个 TypeScript project references、workspace/App build、recovery 和 `pnpm.cmd run verify:full` 均通过；本轮 Web 相关边界命令另有独立通过证据 |
| WSR-1002 真实 Provider smoke | 部分通过，fetch/citation 待真实 DoH 端到端 | 用户终端的 `pnpm.cmd run verify:web-provider -- --require-live` 已验证 disabled 零请求和 1 次真实 Tavily search（3 个归一化、非缓存、非 partial 结果）；默认 system DNS 下关联 fetch 被 `web_ssrf_blocked` 阻断。显式 `cloudflare_doh` 已通过独立 public fetch，但当前进程没有 Tavily key，尚无同一进程的 search -> fetch -> citation |
| WSR-1003 至 WSR-1013 安全合并回归 | 已通过离线合并门 | 本轮核心传输集合为 7 文件、86 项通过，覆盖 Tavily 401/403/429/500 与 schema 错误、SSRF、注入、citation、泄露、取消、缓存、配额、browser approval 和 disabled failure-closed；真实账户的 auth/rate-limit/timeout 仍需发布环境证据 |
| WSR-1014 供应链 | 已通过本时间点离线审查 | `audit --prod` 为 0 漏洞，许可证/直接依赖/Node 内建实现/过期检查和复核条件见供应链审查；依赖变更或发布前须重做 |
| WSR-1015 / WSR-1018 迁移与回退 | 已通过隔离演练 | 旧 config 默认 disabled，历史 log/checkpoint 可读，关闭/重启零 provider 调用，Memory/普通本地路径保持可用 |
| WSR-1016 至 WSR-1024 发布文档与包扫描 | 部分通过 | 任务书、供应链、安全报告和发布清单已同步；本轮 `verify:web-release` 通过且 240 个构建文本文件零敏感命中；build 文本文件与 `release/win-unpacked`/整个 `release` 候选扫描通过；WSR-1021 本轮隔离性能基线为 P95 0.29ms、heap delta 1,022,376 bytes、外网 0；WSR-1022 已通过真实 DeepSeek V4 Flash + 合成 Runtime evidence 的 partial/truncated、限流、超时、关闭文案/citation/内部错误 id 隔离验收。真实 Tavily + 网页 evidence 的端到端 LLM 联调、正式渠道、签名安装器、干净 Windows 验证和发布当天 checklist 尚未收口 |
| Electron / 渠道运行时 | Electron 已通过；渠道离线门与 Webhook loopback 组合门已通过，正式渠道待执行 | Electron 状态连续性脚本已通过；四渠道插件测试 108 项、Webhook HTTP/Manager 组合链路 31 项通过，尚未使用 QQ/飞书/Telegram 或外部反向代理正式配置验证 |

## 15. 测试与验收矩阵

### 15.1 功能场景

| 场景 | 预期路径 | 必须证明 |
| --- | --- | --- |
| 普通闲聊 | respond | 不联网、不增加工具调用 |
| 问模型/LS 是否支持搜索 | respond/capability_question | 不误触发搜索 |
| “查今天的新闻” | execute/compact retrieval/web_search | provider 调用、来源和时间 |
| “查最新版本并给官方来源” | execute/TaskBook | 官方域名过滤、citation 覆盖 |
| “总结这个公开 URL” | execute/compact retrieval/web_fetch | URL 安全、正文抽取、hash |
| “比较三家官方页面” | execute/TaskBook | 多 fetch、冲突和完整性 |
| “记得我上次的决定吗” | safe local memory | 不联网、不审批 |
| “结合我的项目约定查最新方案” | memory + web | query 最小化、来源分离 |
| provider 未配置 | clarify/runtime error | 不伪造实时答案 |
| 网络关闭 | runtime error/clarify | 零网络请求 |
| provider 限流 | recover/partial | 有限重试、明确部分状态 |
| 页面私网重定向 | deny | SSRF 阻断 |
| 网页要求执行命令 | normal evidence | 不执行、不写记忆 |
| 用户要求登录站点 | approval | 不把认证读取当公共 fetch |
| 用户要求保存资料 | memory write flow | 明确意图、来源和写入闸门 |

### 15.2 权限场景

每个场景都要验证：

- approval.required；
- approval.decision；
- descriptor；
- tool 是否真正执行；
- evidence 是否记录；
- UI 是否显示正确事实。

场景至少包括：

- research/restricted/full × local memory；
- research/restricted/full × public search；
- research/restricted/full × public fetch；
- restricted × workspace read；
- research/restricted × outside read；
- restricted × authenticated browser；
- all modes × write/edit/exec；
- hard deny × full。

### 15.3 安全场景

必须有自动化回归：

- file/data/javascript/vbscript/blob URL；
- URL credentials；
- localhost、loopback、私网、link-local、metadata、IPv6 特殊地址；
- DNS 解析地址与连接地址不一致；
- redirect chain 中途进入私网；
- redirect 超限；
- chunked/压缩响应超过解压上限；
- 非法 charset、嵌套 HTML、恶意 script/style/iframe；
- 控制字符和 Unicode 同形异义域名；
- query 中疑似 API key、token、Cookie、内部路径；
- provider 返回伪造系统消息或 tool call；
- 页面正文中的 prompt injection；
- citation id 不存在或指向另一个 URL；
- 缓存键包含 secret；
- abort 后 socket、timer、listener 未释放；
- 重复调用无界重试；
- 并发超过上限；
- 网络关闭后隐藏 fallback。

### 15.4 质量和性能初始门

以下是初始工程门，不是对所有网络环境的硬性用户体验承诺：

- 单次 search/fetch 必须有明确 timeout；
- 一轮 retrieval 必须在 total timeout 内结束或返回 partial/timeout；
- 单轮并发不超过配置上限；
- 单轮 response/extracted bytes 不超过配置上限；
- 取消后不得继续发送新的 provider 请求；
- 缓存命中不能绕过 citation/evidence；
- 失败请求不能产生假成功的 final reply；
- 长内容被截断时，模型和 UI 都能看到 truncated；
- 运行日志和内存占用保持在既有工具输出预算内；
- 真实 provider smoke test 使用隔离数据根，不写入正式用户记忆。

## 16. 错误、恢复与部分完成

建议稳定错误分类：

~~~tex
web_disabled
web_provider_unconfigured
web_provider_auth_failed
web_provider_rate_limited
web_provider_unavailable
web_provider_invalid_response
web_invalid_query
web_sensitive_query_blocked
web_url_invalid
web_scheme_blocked
web_ssrf_blocked
web_dns_check_failed
web_redirect_blocked
web_fetch_timeou
web_fetch_cancelled
web_response_too_large
web_content_unsupported
web_extraction_failed
web_cache_unavailable
web_partial
web_citation_invalid
~~~

恢复原则：

1. 只对幂等 search/fetch 做有限重试；
2. 已完成的来源不重复抓取，除非缓存过期或用户明确刷新；
3. provider 失败不自动把训练记忆当实时证据；
4. 一部分来源成功时，返回 partial 并列出缺失来源；
5. citation 验证失败时，只重做最终回答或失败步骤，不重做所有网络请求；
6. 用户取消后停止后续 fetch 和 synthesis；
7. 重启恢复只恢复 TaskBook/evidence，不自动重新发送外部请求；
8. 网络策略改变后，恢复时重新计算权限和 provider，不沿用旧批准；
9. 无法证明来源完整时，VERIFY 不能返回 pass；
10. 所有失败最终都要区分工具失败、权限拒绝、配置缺失、网络失败、解析失败和验证缺口。

## 17. 代码改动定位与所有权

### 17.1 预计新增文件

~~~tex
packages/web/src/contracts.ts
packages/web/src/provider.ts
packages/web/src/provider-registry.ts
packages/web/src/providers/<first-provider>.ts
packages/web/src/fetch/http-client.ts
packages/web/src/fetch/url-policy.ts
packages/web/src/fetch/redirect-policy.ts
packages/web/src/fetch/extract.ts
packages/web/src/cache/web-cache.ts
packages/web/src/errors.ts
packages/web/src/index.ts
packages/tools/src/builtin/web_search.ts
packages/tools/src/builtin/web_fetch.ts
packages/safety/src/network-boundary.ts
packages/types/src/web-retrieval.ts
packages/harness/src/retrieval-intent.ts
packages/harness/src/compact-retrieval-task.ts
~~~

实际文件名可以在 WSR-100/300 冻结，但责任不能跨层漂移。

### 17.2 预计修改文件

~~~tex
packages/types/src/tool.ts
packages/types/src/runtime-contracts.ts
packages/types/src/task.ts
packages/config/src/schema.ts
packages/config/src/defaults.ts
packages/runner/src/run-config.ts
packages/runner/src/infra.ts
packages/runner/src/runner.ts
packages/tools/src/index.ts
packages/tools/src/registry.ts
packages/tools/src/tool-execution-service.ts
packages/harness/src/compact-autonomous-read-task.ts
packages/harness/src/stages/classify.ts
packages/harness/src/stages/decide/*
packages/harness/src/stages/execute/*
packages/harness/src/stages/reply.ts
packages/harness/src/llm-call-contracts/*
packages/app/src/renderer/settings/*
packages/app/src/renderer/chat/*
packages/app/src/shared/*
docs/principles/architecture-principles.md
docs/principles/core-agent-flow-guidelines.md
AGENTS.md
TOOLS.md
docs/README.md
~~~

修改时必须保留用户已有工作树改动，不得用 reset、checkout 或大范围格式化覆盖无关文件。

## 18. 并行实施建议

可以并行的工作：

- 阶段 1 的公共类型与阶段 2 的威胁模型夹具；
- 阶段 3 provider adapter 与阶段 5 fetch/extractor；
- 阶段 6 evidence projection 与阶段 9 UI 原型；
- 阶段 7 路由测试与阶段 8 memory egress 测试。

必须串行的工作：

- 权限契约冻结后才能放行真实网络工具；
- URL/SSRF 安全门通过后才能接入 web_fetch；
- evidence/citation 契约稳定后才能接入最终回答；
- Harness 路由必须在工具和证据契约后实现；
- 真实 provider 测试必须在密钥隔离和日志脱敏通过后执行；
- 发布默认值必须在迁移和回退演练后变更。

所有并行分支都必须回到同一 Tool Execution Service 和同一 evidence contract，不能各自实现一套审批或记录。

## 19. 验证命令与证据要求

按仓库现有验证层级执行：

~~~tex
纯逻辑单文件：
pnpm.cmd run verify:task -- --files=<path>

单包契约：
pnpm.cmd run verify:task -- --package=<name>

公共契约、Harness、Runner、Context、Memory：
pnpm.cmd run verify:core

阶段完成或发布前：
pnpm.cmd run verify:full
~~~

网络专项还需要：

- web package unit/integration tests；
- safety URL/SSRF tests；
- fake provider contract tests；
- isolated real-provider smoke test；
- route/evidence/citation e2e；
- cache/abort/restart tests；
- renderer citation/settings tests；
- channel projection tests。

每次阶段验收必须记录：

- 使用的配置和 permission mode；
- 是否使用真实 provider；
- provider/model；
- 网络是否实际发生；
- 请求/结果/缓存/截断摘要；
- 失败和 skipped 原因；
- 真实文件、execution log、截图或测试报告路径；
- 未覆盖的边界。

不能用 mock provider 的通过结果宣称真实网络能力已完成；mock 只证明契约和控制流。

## 20. 发布与回退

### 20.1 Feature flag

建议至少有：

~~~tex
web.enabled
web.defaultProvider
web.browserFallback
web.strictReadApproval
web.cache.enabled
~~~

任何 provider 级异常都可以通过配置禁用，不需要删除代码或改动 Harness。

### 20.2 迁移

升级旧版本时：

- 默认不突然启用第三方网络请求；
- 旧 permission mode 的行为变化必须在设置和 release notes 中明确；
- strictReadApproval 可以作为兼容开关；
- 旧 execution log、checkpoint 和历史消息可以读取；
- 新字段缺失采用安全默认；
- web cache 与 memory 数据分开迁移和清除；
- API key 只迁移引用，不复制明文。

### 20.3 回退

发生以下情况时可以安全回退：

- provider 违反接口或隐私预期；
- SSRF/解析器安全测试失败；
- citation/evidence 与最终回答不一致；
- 网络请求无法取消；
- UI 或渠道泄露敏感字段；
- 默认配置造成意外外发。

回退动作：

1. 关闭 web.enabled；
2. 保留本地 memory 和原有工具；
3. 不删除历史 execution evidence；
4. 标记未完成 retrieval，不伪造普通成功；
5. 修复后重新执行阶段门。

## 21. 未决事项与默认决策

以下事项必须在相应阶段明确，不能由实现者临时决定：

| 事项 | 当前推荐默认 | 决策阶段 |
| --- | --- | --- |
| 第一 provider | Tavily（`tavily-search-v1`） | WSR-005，已冻结 |
| 中文 provider | 可选 Moonshot/DashScope adapter | WSR-005 |
| web 默认开关 | 未配置时关闭，配置后用户显式开启 | WSR-003 |
| restricted safe read | 默认允许明确 safe read | WSR-001 |
| strictReadApproval | 高级可选，默认关闭 | WSR-001 |
| 搜索引擎 HTML scraping | 默认关闭 | WSR-005 |
| 浏览器 fallback | approval_required | WSR-003 |
| PDF/OCR | MVP 不做 | WSR-514 |
| 网页自动写记忆 | 默认禁止 | WSR-806 |
| 缓存正文 | 短 TTL、可关闭、独立于 memory | WSR-603 |
| 敏感 query | 默认检测并按策略阻断/审批 | WSR-401 |
| provider fallback | 只使用已配置 provider | WSR-307 |
| citation 缺失 | 不能宣称已验证 | WSR-710 |
| 远程 embedding | 默认关闭或明确单独授权 | WSR-802 |

## 22. Definition of Done

当且仅当以下条件全部满足，专项才能在项目状态中标记为完成：

1. 公共类型、配置、RunContext、checkpoint 和日志契约完成并向后兼容；
2. safe read 权限在三种模式下有自动化矩阵，且 direct proposal 与 ToolExecutionService 一致；
3. provider port、registry、密钥脱敏和第一个真实 adapter 完成；
4. web_search 能返回归一化、有 citation、可取消、有限重试的结果；
5. web_fetch 能完成 SSRF 防护、匿名 GET、重定向检查、正文抽取、截断和 hash；
6. 浏览器、认证、POST、上传和私网目标没有被误归为 safe read；
7. 普通最新问题能进入 compact retrieval，复杂研究能进入 TaskBook；
8. 最终回答由真实 LLM 生成，引用经 Runtime 校验；
9. provider、页面和 LLM 的数据外发边界清楚可见；
10. 网页内容不能改变工具、权限、记忆或状态机；
11. 实时网页资料不会自动污染长期记忆；
12. cache、evidence、execution log、历史恢复和清理完成；
13. UI/CLI/channel 能显示网络状态、来源、时间、缓存、截断和失败；
14. 真实 provider smoke test、离线测试、SSRF 测试、取消测试、重启测试和全量回归通过；
15. 默认配置不意外联网，且可以一键禁用和回退；
16. 文档、AGENTS、TOOLS、README、项目状态和已知限制同步；
17. 没有任何阶段把 mock 通过、工具注册或模型回答流畅误当成实时网络能力完成。

## 23. 当前状态与下一执行顺序

当前状态：

- WSR-000..006：已完成，冻结记录见网络检索安全契约；
- WSR-100..109：已完成公共类型、配置、RunConfig 投影、兼容字段、测试和共享 fixture；
- WSR-200..214：已完成（WB-01 中央 safe-read/hard-deny 与 WB-03 URL/DNS/IP/redirect 网络子门均通过）；
- WSR-300..312：已完成 Provider/registry/Tavily 领域层与每轮 Runtime 生命周期；真实 Provider 联网 smoke 仍归 WSR-1002/WB-09；
- WSR-400..410：已完成（WB-04；内置工具、统一执行、敏感 query 和 capability gate；真实 Provider smoke 仍归 WSR-1002）；
- WSR-500..520：已完成离线实现门（WB-03/WB-04/WB-05/WB-08），并已通过 `verify:web-fetch` 的真实 `https://example.com/` 匿名公共 GET、正文抽取和 Runtime citation smoke；WebFetchService/HTTP/extractor/cache/citation、AgentTool、模型/durable projection 和 UI projection 已接线，真实 Tavily search/citation、Electron 与正式渠道运行时验收仍待 WSR-1002 及发布门；
- WSR-600..614：已完成（WB-05；evidence/citation、持久化边界、缓存生命周期和历史 replay 离线门）；
- WSR-700..724：已完成（WB-06；Harness 检索意图、compact retrieval、TaskBook、工具集过滤和 final citation validation 离线门）；
- WSR-800..814：已完成（WB-07；本地 Memory-first、最小 query、远程 embedding 边界和 Web 写入治理离线门）；
- WSR-900..919：已完成代码与定向门（WB-08；Main/Renderer、来源卡、历史 projection、CLI/channel formatter）；Electron 窗口已通过，正式渠道运行时验收仍待 WSR-1000；
- WSR-1000..1024：进行中（WB-09）；WSR-1000/1001 的当前稳定工作树全量回归、类型、构建、恢复和 Electron 状态连续性已通过；WSR-1002 严格 `--require-live` 已由用户终端测试 key 验证 Tavily search，但搜索结果关联 fetch 在当前 DNS/SSRF 环境被阻断；离线安全合并报告、迁移/回退、供应链、build-directory 与当前 release 候选扫描、Web Runtime 性能基线、用户可见 projection 和离线渠道门已完成；WSR-1022 已通过真实 DeepSeek V4 Flash 生产最终回复对合成 evidence 的验收，并修复 `errorKinds` 注入模型提示，verifier 失败输出也已限制为稳定 error kind。真实 Tavily + 网页 evidence 端到端 LLM、正式渠道、签名安装器和干净 Windows 发布门仍待完成；
- 当前工作树：本专项已开始修改源码；与本专项无关的现有改动继续保留。
- 现有用户改动：与本专项无关的工作树修改必须保留。

推荐实际执行顺序：

~~~tex
WSR-000..006
  -> WSR-100..109
  -> WSR-200..214
  -> WSR-300..312
  -> WSR-400..410 + WSR-500..520
  -> WSR-600..614
  -> WSR-700..724
  -> WSR-800..814
  -> WSR-900..919
  -> WSR-1000..1024
~~~

下一次实际执行应继续 WB-09：在拥有现有测试 key 的终端运行 `pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live`，完成真实 Tavily 搜索结果关联的 safe public fetch、citation、失败状态和关闭后零请求；随后完成真实 Tavily + 网页 evidence 的端到端 LLM、QQ/飞书/Telegram/Webhook 正式运行时、签名最终包和干净 Windows 验收。保持 `configured_unchecked`、`unavailable` 或 `blocked` 的真实状态，不执行伪 smoke、不 push、不刷新桌面快捷方式。

### 23.1 已完成工作包证据索引

| 工作包 | 实现证据 | 定向证据 | 真实网络 | 当前结论 |
| --- | --- | --- | --- | --- |
| WB-01 | 中央 descriptor、safe-read/hard-deny、strict-read 和所有入口复用 | Safety/Tools/Harness 定向矩阵 | 未发生 | 安全子门完成 |
| WB-02 | 每轮 `WebRetrievalRuntime`、quota/abort/citation/deadline 隔离和 dispose | Runner/Web runtime、checkpoint/log/replay 回归；6 文件 75 项 | 未发生 | Runtime 生命周期子门完成 |
| WB-03 | Provider/Tavily 领域层、SSRF、DNS/IP、redirect、HTTP、extractor、cache、资源上限 | Web 定向 8 文件 79 项；合并 12 文件 120 项 | 未发生 | 网络领域安全门完成 |
| WB-04 | strict `web_search`/`web_fetch`、registry、统一执行、敏感 query 和 capability gate | Safety/Tools/Harness 5 文件 99 项；Runner 3 文件 12 项 | 未发生 | 工具接线完成 |
| WB-05 | 模型正文与 durable projection 双投影、citation validation、历史不重联网 | 合并 21 文件 231 项 | 未发生 | 证据闭环完成 |
| WB-06 | `RetrievalIntent`、compact/TaskBook 路由、工具集过滤、final citation 校验 | 5 文件 61 项；Harness typecheck | 未发生 | Harness 离线闭环完成 |
| WB-07 | Memory-first、local embedding、最小 query、Web 写入闸门 | 5 文件 83 项；Config/Harness typecheck | 未发生 | Memory/egress 治理完成 |
| WB-08 | Main/Renderer 网络设置、来源卡、history projection、CLI/channel formatter、cache 清理 | 8 文件 51 项；App/CLI/Plugins typecheck | 未发生 | App/CLI/channel 代码门完成；Electron/正式渠道待收口 |
| WB-09 | 真实 Provider、全量验证、迁移、回退、供应链和发布 | 当前稳定工作树全量回归/类型/构建/恢复/Electron、离线安全合并、迁移/回退、供应链、238 文件 build 扫描、release 候选扫描、真实公共 `web_fetch` smoke、48 run 性能基线、来源卡/formatter 和离线渠道测试已通过；真实 DeepSeek V4 Flash 对 partial/truncated、限流、超时、关闭的生产最终回复验收已通过，LLM verifier 失败输出已锁定为稳定 error kind | runner 已显式 opt-in；用户终端测试 key 已验证 Tavily search，但搜索结果关联 fetch/citation 被当前 DNS/SSRF 环境阻断；正式渠道、签名安装器和干净 Windows 发布仍未验收 | 进行中；只有所有发布门通过后才可标记 ready |

### 23.2 当前不可宣称事项

- 不能说“LS 已经可以稳定实时联网”，只能说“实时网络检索的受控离线实现已接通，真实 Provider 尚未验收”。
- 不能把 fake provider、fake HTTP、fixture、工具注册、模型看到正文或 citation 格式正确当作真实网络可用证明。
- 不能把 `configured_unchecked` 显示成 `ready`；没有真实 key 时不探测、不自动联网、不切换隐式 fallback。
- 不能因为 public web safe read 免逐次审批，就取消网络总开关、egress 披露、敏感 query 审批、SSRF/URL/DNS/redirect、配额、审计或浏览器认证边界。
- 不能在 WB-09 完成前 push 或刷新桌面快捷方式；不能把当前工作树中与专项无关的用户改动视为本专项产物。

### 23.3 发布日执行 Runbook

本节是 WB-09 的实际执行顺序。只有具备对应前置条件时才执行下一步；没有凭证、渠道或签名环境时，必须记录 `blocked/skipped`，不能用 fake provider、普通网页 fetch 或模型回答替代。所有命令在仓库根目录 `<repo-root>` 执行，测试数据根必须是临时隔离目录，不得指向活动用户数据根。

#### A. 执行前冻结与环境检查

1. 读取 `git status --short --branch`，确认本轮只修改专项文件；保存当前分支、工作树状态和 Node/pnpm/Windows 版本。
2. 确认 `LS_TAVILY_API_KEY` 或 `TAVILY_API_KEY` 是否存在。只向隔离 smoke 进程注入，不写入 shell profile、配置文件、日志、任务书或测试报告；不能用 `DEEPSEEK_API_KEY` 代替 Tavily key。
3. 确认网络开关默认关闭，确认测试 data root、release 输出目录和正式用户数据根互不相同。
4. 确认渠道测试使用正式或等价真实环境的最小凭证，并能在验收后撤销；凭证不得进入截图、SSE、execution log、checkpoint 或渠道回显。
5. 确认签名工具、证书选择和干净 Windows 验收机可用；没有签名环境时，安装器只能标记为未签名候选。

执行前产出：环境摘要、凭证存在/缺失的布尔结果、隔离目录路径、当前代码版本和未执行项目清单。产出中不得出现 key、完整 query、正文、Cookie、Authorization 或用户绝对路径。

#### B. 自动化离线门

按以下顺序执行，并保存每条命令的退出码和有界摘要：

```tex
pnpm.cmd run check:repo
pnpm.cmd run verify:web-release
pnpm.cmd run verify:web-performance
pnpm.cmd run verify:web-llm-evidence
pnpm.cmd run verify:electron-ui-state-continuity
pnpm.cmd run verify:full
pnpm.cmd audit --prod --json
pnpm.cmd licenses list --prod
pnpm.cmd --filter @littlesheep/web outdated --format json
```

任何一项失败，都只能回到对应工作包修复并重跑其依赖链；不得继续执行真实 Provider 或发布。`verify:web-llm-evidence` 使用合成 evidence，只证明最终回答的失败/部分状态治理，不证明真实网页联调。

#### C. 真实 Provider 与公共页面门

仅当 A、B 全部通过且已获得隔离 Tavily key 时执行：

```tex
pnpm.cmd run verify:web-provider -- --require-live
pnpm.cmd run verify:web-fetch
```

真实 Provider runner 必须至少证明：

| 场景 | 成功条件 | 失败时状态 |
| --- | --- | --- |
| Tavily search | 真实请求、归一化结果、Provider identity 和 citation 可回溯 | `unavailable` 或 `configured_unchecked` |
| 搜索结果关联 fetch | 真实公开 URL 可匿名 GET，URL 与 citation 绑定 | `web_partial`、`web_fetch_*` 或 `web_citation_invalid` |
| 认证失败 | key 无效时不泄露 Authorization/key，用户可见稳定状态 | `web_provider_auth_failed` |
| 限流 | 不超过有限重试和 quota，用户知道结果不完整 | `web_provider_rate_limited` / partial |
| timeout/cancel | 中止后没有新请求，socket/listener/timer 收口 | `web_fetch_timeout` / `web_fetch_cancelled` |
| 关闭网络 | Provider 请求数为 0，历史与本地 Memory 仍可读 | `disabled` |

真实 smoke 的报告只能保存请求数量、HTTP 状态类别、结果数量、citation 数量、完整性、时间、hash 和错误大类；禁止保存完整 query、原始 Provider JSON、页面正文、凭证或带秘密参数的 URL。`verify:web-fetch` 已经证明安全公共 fetch 路径，但不能替代 Tavily search/citation 门。

#### D. 真实 LLM evidence 联调

只有 C 的真实 Tavily search/fetch evidence 已获得后，才可以把该 evidence 接入真实 LLM 的生产 `execute_final_reply` 路径，重跑以下四类场景：

1. 完整资料：只引用本轮 Runtime 签发的 citation，并能区分 Memory 与 Web。
2. partial/truncated：明确资料不完整，不把已取到的页面表述为全面查证。
3. Provider rate-limit 或 fetch timeout：保留失败来源和缺口，不用训练记忆补成实时结论。
4. network disabled/unconfigured：不发生请求，不自造 citation，不声称已联网。

验收必须同时检查模型原始输入投影、最终 LLM 文案、durable projection 和 UI 来源卡；模型可见 projection 可以有界包含正文，durable projection 和渠道投影不能包含正文、完整 query 或内部 `errorKinds`。

#### E. Electron 与正式渠道门

1. Electron：启动正式构建，验证设置页开关、provider 状态、首次启用说明、来源卡、关闭后零请求、历史恢复不重联网和缓存清理；再验证应用重启、网络中断、取消和回退。
2. QQ、飞书、Telegram、Webhook：分别发送一个完整来源结果、一个 partial/truncated 结果、一个 timeout/rate-limit 结果和一个 disabled 结果；接收端必须显示来源、时间和状态，不得显示 query、正文、Cookie、Authorization 或内部错误 id。
3. 对每个渠道记录真实发送/接收方向、消息 id、脱敏时间、状态和回调结果；渠道失败不改变 Runtime 的安全结论，也不能通过 formatter 绕过 evidence projection。

离线插件测试只能证明 formatter/adapter 契约；正式渠道没有凭证或没有可回调环境时，状态保持“正式渠道待验收”。

#### F. 最终包、安装升级与回退

1. 在通过 A-E 后重新构建 Windows unpacked 和 NSIS 安装器。
2. 对签名后的最终 release 目录执行：

```tex
node scripts/verify-web-release-artifacts.mjs --root=<final-release-directory>
```

3. 记录安装器签名状态、SHA-256、包扫描统计、版本号和构建输入；任何 secret、fixture 私密 marker、用户 Memory、缓存正文、完整 query 或绝对用户路径命中都立即阻断发布。
4. 在干净 Windows 环境依次验证安装、首次启动、默认关闭、配置 Provider、启用/关闭、升级、历史可读、普通本地 Memory/工具可用、卸载和用户数据根保留策略。
5. 演练回退：关闭 `web.enabled`，确认本地 Memory、历史、非网络工具和既有会话仍可用；恢复历史不能自动重新请求；不删除证据或用户数据。

只有签名最终包和干净环境均通过，才能从“候选”进入正式发布判断。

### 23.4 验收证据记录模板

每个 WSR/WB 验收记录至少包含以下字段。字段值必须是脱敏的，不能以“日志见附件”替代关键事实：

| 字段 | 要求 |
| --- | --- |
| `date` / `commitOrWorkspace` | 执行时间和代码版本；工作树不干净时说明原因 |
| `scope` | WSR 编号、WB 编号和受影响 package |
| `command` | 完整可复现命令，不含 secret、Cookie 或完整敏感 query |
| `environment` | OS、Node、pnpm、provider id、model；secret 只写 present/absent |
| `networkOccurred` | `0` 或 `1`，并分别记录 provider/http 请求计数 |
| `inputProjection` | 只描述 query 长度、敏感策略和 URL 类别，不保存原文 |
| `resultProjection` | 结果数、citation 数、状态、时间、hash、partial/truncated |
| `securityAssertions` | SSRF、日志泄露、投影边界、取消、重试和 quota 关键断言 |
| `artifacts` | 报告、测试输出、包扫描和截图的相对证据入口 |
| `gaps` | 未覆盖场景、skipped 原因、外部前置条件 |
| `conclusion` | `pass / partial / blocked / fail`，不得写成超出证据的产品承诺 |

证据保存位置优先使用 `.codex_tmp/verification-reports/` 或对应专项报告；不得把真实网页正文、Tavily raw response、用户 Memory 或明文凭证复制到仓库。

### 23.5 失败恢复与责任边界

| 失败类型 | 立即动作 | 可恢复路径 | 禁止动作 |
| --- | --- | --- | --- |
| 配置缺失/无 key | 保持 `unconfigured`/`configured_unchecked` | 注入隔离 key 后从 WSR-1002 重跑 | 探测 key、自动选 Provider、HTML scraping fallback |
| Provider auth/限流/不可用 | 保留稳定错误和部分状态 | 修复凭证或服务条件后重跑真实 smoke | 用训练知识伪造实时结果 |
| SSRF/DNS/redirect 失败 | 在 socket 前或下一跳前拒绝 | 修复网络边界后重跑安全矩阵 | 放宽 hostname-only 检查 |
| evidence/citation 错误 | 不发布最终实时结论 | 修复 registry/projection 后重做验证 | 接受模型自造 citation |
| 取消/超时泄露资源 | 中止 run，检查 socket/listener/timer | 修复生命周期后重跑取消门 | 无限重试或后台继续联网 |
| 日志/包扫描命中秘密 | 立即停止发布，隔离并清理泄露路径 | 修复投影/打包后全量重扫 | 只删报告而不修复来源 |
| 渠道发送失败 | 保留 Runtime 结果，标记渠道失败 | 修复 adapter/凭证后重发同一有界 projection | 渠道自行读取 raw evidence |
| 签名/干净环境不可用 | 标记候选，不标 ready | 准备签名和验收机后重跑 | 把未签名包称为正式版 |

### 23.6 Safe read 的最终产品解释

本专项对“赦免”的准确实现是：用户明确授权并启用受控网络能力后，`local_memory`、`local_session`、`public_web_search` 和 `public_web_fetch` 在默认 research/restricted 流程中不再为每一次只读调用弹出审批；这减少重复交互成本，符合“不影响用户及其外界”的只读语义。

但免逐次审批不等于免除以下控制：网络总开关、Provider 配置和真实 health、最小化 query 外发、敏感 query 策略、匿名 GET 限制、URL/DNS/IP/redirect/SSRF 检查、响应和解压上限、取消/超时、quota、缓存隔离、审计、citation 校验、外部内容不可信封套，以及浏览器/登录态/认证/写入/执行的独立审批。`strictReadApproval=true` 仍可让 safe read 在 research/restricted 下恢复逐次审批；hard deny 在 full 模式也不能绕过。

因此，产品可以把这类调用显示为“安全读取，按当前网络策略自动执行”，但不能显示为“所有读取都免审”或“网络已永久授权”。
