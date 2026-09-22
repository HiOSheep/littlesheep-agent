# Web Retrieval Release Checklist 2026-08-29

状态：发布前清单；当前专项仍不可发布为 `ready`。
最后更新：2026-09-22 10:56:22

本清单只允许记录已经获得的证据。完成其中的离线项不等于实际 Provider、真实网页或渠道已可用。

## 当前门状态

| 门 | 状态 | 依据 |
| --- | --- | --- |
| 网络默认关闭与 opt-in | 通过 | `web.enabled=false` 为默认；旧配置缺失 `web` 字段仍安全关闭；`configured_unchecked` 显示为“尚未检查”而非 ready，网络关闭或 provider 未配置时不发出请求 |
| 统一 Runtime 边界 | 通过 | `web_search` 与 `web_fetch` 经同一 safe-read、quota、citation 和 evidence projection 边界执行；浏览器、登录态、Cookie、Authorization、POST、上传和私网目标仍需独立批准或被硬拒绝 |
| 离线安全矩阵 | 通过 | SSRF、DNS/IP、redirect、响应/解压上限、取消、缓存、citation、prompt injection 和 durable leakage 均有自动化证据；未知 `Content-Encoding` 经统一错误边界关闭响应并返回非重试的 `web_content_unsupported` |
| 持久化与回退 | 通过 | execution log/checkpoint 只保存有界 projection；重启后读取历史 evidence 不触发新请求；关闭网络后 Memory 与历史记录仍可读 |
| 构建产物与供应链 | 部分通过 | 构建目录与 `release` 候选扫描的 provider secret、私密 fixture、用户 Memory 和绝对用户路径命中均为 0；许可证清单已核对（`khroma@2.1.0` 经包内 `license` 文件核验为 MIT）。**生产依赖审计不再是零**：2026-09-22 复核报告 `3` 个 moderate、`10` 个 high，涉及 `@xmldom/xmldom`、`sharp` 与 `adm-zip`，处置见[生产依赖安全记录](production-dependency-security.md)；修复前不得以"生产依赖无漏洞"作为发布依据 |
| Release 聚合门 | 通过 | `pnpm.cmd run verify:web-release` 通过：Provider/public-fetch smoke 报告边界 `19` 项、LLM evidence verifier 失败输出边界 `1` 项、真实 LLM 联调入口参数/脱敏边界 `3` 项、渠道 projection/loopback Webhook `31` 项、迁移/回退与构建产物扫描 |
| 用户可见投影 | 通过 | UI、CLI 与渠道 formatter 对来源、缓存、partial、truncated、blocked 和稳定错误类别有离线投影测试；共享 formatter 为每条 citation 输出抓取时间，零 citation 时输出脱敏的“无已验证来源”状态；内部 `web_*` kind 不进入用户文本 |
| 真实 Provider search | 通过 | 用户终端以测试 key 执行 `verify:web-provider -- --require-live`：disabled 零请求通过；真实 Tavily search 以 1 次 Provider 请求返回 3 个归一化结果，非缓存、非 partial |
| 真实匿名 public fetch | 通过（显式 DoH） | `verify:web-fetch -- --dns-resolver=cloudflare_doh` 返回 HTTP 200、`readability`、`externalUntrusted=true`、未截断、Runtime citation 和 `completeness=complete`；它不证明 Tavily 搜索结果关联的 fetch/citation |
| 搜索结果关联 fetch/citation | 未通过 | 搜索结果关联的匿名 fetch 在本机 DNS/SSRF 检查处以 `web_ssrf_blocked` 阻断 |
| 真实网页 evidence 驱动 LLM 联调 | 未通过 | 只有合成 evidence 的 `verify:web-llm-evidence` 通过（DeepSeek V4 Flash 生产 `execute_final_reply`，覆盖 partial/truncated、rate-limit、fetch-timeout、disabled 四场景）；缺少真实 Tavily + 真实网页的端到端验收 |
| 正式渠道 | 未通过 | 已有真实 `DefaultChannelManager` + loopback `WebhookChannelPlugin` 组合链路，但 QQ、飞书、Telegram 与外部反向代理环境的正式发送/接收、认证、限流和回调仍未验收 |
| 签名包与干净 Windows 环境 | 未通过 | 当前 NSIS 候选 `LittleSheep-0.1.0-x64-Setup.exe`（SHA-256 `EC08404472EFA9E5179C089677F423B27DDD7154793FD057B5C2425498B8F769`）签名状态为 `NotSigned`；干净环境安装/升级/卸载未做；当前证书库中可用代码签名证书数量为 `0` |

## 当前环境限制

本机 DNS 处于代理 TUN/Fake-IP 模式（系统代理 `127.0.0.1:7897`，活动 DNS `198.18.0.1`），会把 `example.com` 等公开域名解析到保留网段 `198.18.0.0/15`，因此默认 `system` DNS 路径下匿名 public fetch 在 HTTP 前即被 `web_ssrf_blocked` 正确阻断。这是严格 SSRF 校验与 Fake-IP 解析的兼容冲突，不是 Tavily key 或搜索失败。不得为让 smoke 通过而放行保留/私网地址、加入 SSRF 例外、修改 hosts 或固定目标 IP；复验应临时关闭该 TUN/Fake-IP 解析，或改用会返回真实公网地址的 real-IP/redir-host 等价模式。`cloudflare_doh` 是唯一获准的固定可信替代解析模式，它仍执行全部 A/AAAA、redirect、TLS 和 pinned socket 硬拒绝。

当前进程没有 `TAVILY_API_KEY`/`LS_TAVILY_API_KEY`，也没有 QQ、飞书、Telegram、外部反向代理 Webhook 或 Authenticode 签名凭证，因此上述未通过项无法在本机补齐。

## 发布当天必须复核

- [ ] 使用隔离测试数据根、明确 `web.enabled=true` 和测试 key 运行：

  ```text
  pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live
  ```

  目标是完成搜索结果关联的匿名 public fetch、citation，以及 auth/rate-limit/timeout 的用户可见结果。输出不得包含 key、Authorization、完整 query、正文、完整 URL、provider 原始 JSON 或原始错误消息；失败只输出白名单稳定错误类别。`system` DNS 在 Fake-IP 模式下不可作为该 smoke 的前置路径。
- [ ] 当默认 public-fetch target 因部署 DNS 返回保留网段而被阻断时，只可在正常公开 DNS 环境使用经 Runtime 校验的替代页面复验：

  ```text
  pnpm.cmd run verify:web-fetch -- --url=https://<public-anonymous-page>/
  ```

  `--` 仅是 `pnpm run` 的前导参数分隔符，不能重复、不能单独使用或出现在其他位置；`--url` 是唯一 smoke 输入，最大 4,096 字符，未知参数直接失败；完整 URL 不进入输出。
- [ ] 取得真实 Tavily search/fetch evidence 后，以真实 LLM 验收同一条 Runtime 路径的 partial、timeout、rate-limit 和 disabled 最终回复；合成的 `verify:web-llm-evidence` 不替代该端到端门。
- [ ] 再次复核 Tavily 服务条款、价格、账户计划限额/限流、数据保留和部署地可用性；不可用时状态维持 `unavailable`，不得隐式回退到 HTML scraping。
- [ ] 使用正式或等价真实环境验收 QQ、飞书、Telegram、Webhook 的来源、时间与 partial/truncated/error 投影。
- [ ] 生成签名后的最终平台 release 包后，以实际包目录执行：

  ```text
  node scripts/verify-web-release-artifacts.mjs --root=<release-directory>
  ```

- [ ] 重新运行供应链命令与完整回归，并记录日期、lockfile 状态、平台与 skipped 原因。
- [ ] 核对设置页没有把 `configured_unchecked` 呈现为 `ready`，网络关闭和 provider 未配置均没有请求；核对浏览器、登录态、Cookie、Authorization、POST、上传和私网目标仍要求独立批准或被硬拒绝。
- [ ] 在干净 Windows 环境安装、启动、升级、卸载，确认用户数据根与版本升级解耦，并记录安装器签名、哈希和结果。

## 发布阻断条件

- 实际 Provider 的搜索结果关联 fetch/citation 未通过、被跳过或输出不完整。
- 任意 secret、完整 query、网页正文、用户 Memory、execution log/checkpoint 或用户绝对路径进入最终 release 包。
- citation 无法回溯到当前 run 的 Runtime evidence，或部分资料被表述成完整验证。
- 网络关闭后仍产生 provider/HTTP 请求，或恢复/历史阅读自动重放检索。
- 正式渠道输出缺少来源状态，或展示原始 query、Cookie、Authorization、完整页面正文。

## Recovery Warning 处置边界

`verify:full` 的 recovery warning 已完成责任边界复核，但不改写成无 warning：`sampled runIds missing execution logs` 来自通用恢复检查器对历史会话前 20 个 JSONL 文件的抽样，缺日志的 3 个 runId 不属于本专项生成的 Web run；`workspace layout snapshot uses non-default roots` 来自用户曾选择并保存在 layout 快照中的外部工作区 root。二者均不阻断 Web 迁移/回退门，但正式发布前仍需由恢复与工作区模块责任人决定补日志、清理历史引用或形成独立豁免；若发现与 Web evidence、网络回退或数据丢失存在因果关系，必须重新打开对应阻断条件。

## 已知限制

- 当前 MVP 仅接 Tavily adapter；未配置 key 时只能显示 `disabled`、`unconfigured`、`configured_unchecked` 或 `unavailable`，不能声称实时资料可用。
- `web_fetch` 只做匿名公共 HTTP(S) GET；动态 JS、登录站点、验证码、表单、上传和认证内容不是该能力的 fallback。
- Web Runtime 的性能基线使用受控本地 provider/HTTP 夹具（隔离 fake-provider/fake-HTTP 迭代，外网请求为 0），证明本地控制流与资源边界，不代表任何互联网、Provider 或地域网络延迟承诺。
- 渠道测试目前是插件/本地运行时验证；真实第三方平台的认证、回调、限流和消息格式仍需发布前验收。
- 当前 Windows NSIS 安装器候选未签名；签名、干净环境安装/升级/卸载和最终包复扫仍是正式发布门。
