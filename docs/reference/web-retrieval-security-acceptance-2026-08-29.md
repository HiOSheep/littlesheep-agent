# 网络检索发布验收清单

本页维护发布时必须补齐的网络检索证据，不复述历史执行日志。运行时安全契约见[网络检索安全契约](web-retrieval-security-contract.md)，当前实现状态见[项目状态](../decision/project-status.md)。文件名中的日期标识原专项来源，不代表本地 Provider、网络或发布环境已验收。

## 每个发布候选

- 运行 `pnpm run verify:web-release` 与 `pnpm run verify:full`。前者覆盖 Provider／抓取边界、渠道投影、迁移和 Web 产物检查；后者验证仓库核心回归。跳过、未配置或不完整证据须保留为未验收。
- 对最终签名发布目录运行 `node scripts/verify-web-release-artifacts.mjs --root=<release-directory>`；候选生成前的扫描不能代替最终产物扫描。
- 在干净 Windows 环境安装并检查启动、升级、卸载和用户数据根保留。签名、哈希、平台依赖与安装结果随发布记录，不追加到本指南。

## 真实服务验收

发布联网能力前，在隔离数据根和测试凭据下执行：

- 真实搜索与匿名公开抓取：`pnpm run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live`，确认 Runtime 签发的 citation、partial／truncated 状态、超时与限流结果。
- 同一条真实 LLM 与 Web evidence 路径的端到端检查，覆盖完整、partial、timeout、rate-limit 与网络关闭状态。合成 evidence 测试不替代真实 Provider 联调。
- 配置所支持的外部渠道后，确认来源、时间与不完整状态可见，网页正文、完整 query、密钥和内部错误标识不会进入渠道回复。
- 当日复核 Provider 条款、部署地可用性、计划限额、价格和数据保留；这些事实会变化，历史 smoke 不能代替复核。

## 必须保持的拒绝边界

- 仅允许 Runtime 选择的 Provider 和匿名公共 HTTP(S) GET。每次连接与重定向前复查 scheme、DNS/IP、SSRF、响应大小、超时与取消；登录态、表单、上传、POST 和私网目标不能因 safe read 获得授权。
- 代理或本机 DNS 把公开域名解析到保留／私有地址时，抓取须在 HTTP 前 fail closed。可在验收环境使用契约允许的固定解析方式；不得放行保留地址、固定目标 IP 或回退到 HTML scraping 来换取绿灯。
- 网络关闭、Provider 未配置或检查未通过时不得显示 `ready`，并且应为零 Provider 请求。只有本轮 Runtime 签发的引用可用于最终已核验表述。
- durable evidence 只保存有界脱敏 projection，不保存网页正文、完整 query、Provider 原始 JSON、Cookie、Authorization 或凭据。
