# @littlesheep/web

最后更新：2026-09-22 12:43:39

LittleSheep 的 provider 无关网络检索领域包。

职责：

- 定义 SearchProvider、HTTP client、Provider registry 和 WebRetrievalRuntime；
- 归一化搜索结果并生成运行时 citation；
- 通过受控 HTTP GET 获取公开页面，执行 URL、DNS/IP、重定向、大小、超时和取消检查；
- 将网页正文标记为 `externalUntrusted`，只向持久化边界提供有界 evidence projection；
- 提供短 TTL、容量受限的进程内缓存。

本包不负责：

- LLM prompt、Harness 状态转移或 UI；
- Cookie、Authorization、浏览器登录态、任意 HTTP method 或上传；
- 自动写入 workspace、daily、长期 Memory 或向量库；
- 未配置 Provider 的隐式 fallback 或搜索引擎结果页 scraping。

首个生产适配器是 `tavily-search-v1`。网络能力仍由 Runner 解析为不可变 `NetworkReadPolicy`，工具必须通过统一 Tool Execution Service 调用本包。

桌面端的 Tavily 配置由 App Main 进程完成：用户密钥进入 Electron `safeStorage`，Web 配置只登记 `$TAVILY_API_KEY`，保存后仍需单独启用网络检索；没有通过真实检查时 Provider 状态保持 `configured_unchecked`，不显示为 `ready`。

Provider 的真实检查必须由用户主动触发；它使用当前 Runtime 的固定 Tavily 搜索路径，只返回脱敏状态和结果数量，不把健康探测放入启动或 Runner 构建流程，也不把检查结果持久化为配置事实。

安全契约：

- 默认 `EnvironmentSecretResolver` 只解析 `$ENV_NAME`；测试或宿主密钥库必须显式注入 `SecretResolver`，明文 `apiKeyRef` 不会被当作密钥。
- Tavily 适配器固定使用官方 HTTPS Search endpoint，只发送归一化的搜索字段，并始终关闭 answer、raw content 和 auto parameters。
- public fetch 先规范化 URL、检查全部 DNS answer，再把 socket 固定到已检查的公开 IP；每个 redirect 都重新执行相同检查。
- public fetch 的低层 HTTP transport 不从包入口导出，只能匿名 GET，不接受调用方 method、header、Cookie、Authorization、Referer、body、proxy 或 output path。
- DNS 默认使用系统解析；在 Fake-IP/TUN 环境下可由已解析的 `NetworkReadPolicy` 显式选择固定 Cloudflare DoH 模式。该模式只使用固定端点/IP、固定 TLS SNI/Host，并对 DNS 响应做大小、事务、问题、A/AAAA、TTL、超时和取消校验；解析结果仍必须通过全部 SSRF/IP hard deny，不能静默 fallback 或接受调用方 endpoint。
- wire bytes、解压 bytes、redirect、抽取输入、模型可见字符、缓存 TTL/容量、并发、配额和总时限分别受硬上限约束。
- URL 含 token、credential 或 signature 参数时不使用共享缓存；cache key 只保存 URL 的 SHA-256，Provider/cache/socket 原始错误和 resolved secret 不跨边界。
- 搜索摘要和页面正文始终是 `external_untrusted` 数据；本包不会执行页面指令，也不会自动写入 Memory、workspace 或运行日志。
