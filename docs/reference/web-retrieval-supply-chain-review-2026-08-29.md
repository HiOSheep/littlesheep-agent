# Web Retrieval Supply-Chain Review 2026-08-29

状态：已完成本时间点的离线依赖审查；实际 Provider 条款、费用和部署地可用性仍需在 live smoke 时复核。
最后更新：2026-09-22 10:56:22

## 范围与方法

- 日期：2026-08-30（Asia/Hong_Kong）。
- 包管理器：pnpm 11.9.0。
- 审查对象：`@littlesheep/web` 及其运行时依赖、整个 workspace 的生产依赖和许可证清单。
- 变更边界：本审查没有把 API key、完整用户 query、网页正文、Cookie、Authorization 或用户数据复制进仓库。
- 可复核命令：
  - `pnpm.cmd audit --prod --json`
  - `pnpm.cmd licenses list --prod`
  - `pnpm.cmd --filter @littlesheep/web outdated --format json`

## Web 包实现与依赖

`@littlesheep/web` 当前只有 workspace 类型依赖 `@littlesheep/types`。HTTP、HTTPS、DNS、压缩、加密、网络流、URL 解析和取消控制使用 Node.js 内建模块；Web 包没有新增第三方 HTTP 客户端或 HTML 抽取依赖。

生产实现因此由 LittleSheep 自己控制以下边界：Provider API adapter、匿名 HTTP GET、URL/DNS/IP/redirect 检查、响应和解压大小限制、正文抽取、缓存、超时、取消、配额、citation 和 projection 脱敏。若未来引入 Readability、HTML parser、代理客户端或浏览器依赖，必须重新做许可证、漏洞、维护状态、bundle 内容和 SSRF 行为审查，并增加对应的安全回归。

## 漏洞审查结果

**当前结果（2026-09-22 复核）**：`pnpm audit --prod --json` 报告生产依赖 `346`，`3` 个 moderate、`10` 个 high、`0` 个 critical。受影响的生产依赖是 `@xmldom/xmldom@0.8.13`（经 `mammoth@1.12.0` 由 `@littlesheep/documents` 引入）、`sharp@0.35.0` 与 `adm-zip@0.6.0`（两者都经 `@huggingface/transformers@4.2.0` 引入，且当前 workspace override 已低于各自修复线）。处置与复查日期见[生产依赖安全记录](production-dependency-security.md)。**本节以下 2026-08-29 与 2026-09-02 的零漏洞读数已被本次结果取代，不得再作为当前状态引用。**

2026-08-29 执行 `pnpm.cmd audit --prod --json`，当时的结果摘要如下（历史快照）：

| 等级 | 数量 |
| --- | ---: |
| info | 0 |
| low | 0 |
| moderate | 0 |
| high | 0 |
| critical | 0 |

该次命令报告的生产依赖数为 346，开发依赖数为 0，可选依赖 40，总依赖数 386。依赖数量本身仍是当前值，但漏洞计数只对该时点成立；发布前必须重新执行。

`pnpm --filter @littlesheep/web outdated --format json` 在当时返回空对象。它只表示该命令当时没有报告 Web 包的过期项，不替代安全公告、维护活跃度和发布变更审查。

### 2026-09-02 发布日前置复核（历史快照）

当日重新执行上述三条命令时，`audit --prod` 报告 production `346`、optional `40`、total `386` 个依赖，漏洞计数为 `0`；`@littlesheep/web` 的 `outdated --format json` 返回空对象。**该零漏洞读数已于 2026-09-22 失效**（见本节开头）。

当日许可证清单工具将 `khroma@2.1.0` 标记为 `Unknown`。这是该包 manifest 缺少 `license` 字段导致的工具识别缺口，不应直接作为许可证未知发布。已从安装包内的 `node_modules/.pnpm/khroma@2.1.0/node_modules/khroma/license` 核验到 MIT 正文；`pnpm why khroma --prod` 证明它由 `@littlesheep/app -> mermaid@11.17.2` 引入。该核验只澄清当前依赖的许可证文本，最终发行包仍须包含所需 notices，并由发布/法务责任人核对实际分发内容。

## 许可证审查

`pnpm.cmd licenses list --prod` 输出中包含常见的 MIT、Apache、BSD、ISC 和 CC-BY 许可证，也包含以下需要在发布材料和依赖升级时持续保留记录的组合或替代许可证：

| 依赖 | 当前清单中的许可证表达 | 处理要求 |
| --- | --- | --- |
| `pako` | MIT AND Zlib | 保留两份通知要求，升级时复核。
| `jszip` | MIT OR GPL-3.0-or-later | 选择并记录实际分发所依据的许可路径，发布包附带 notices。
| `dompurify` | MPL-2.0 OR Apache-2.0 | 记录采用的许可路径并保留相应通知。
| `@img/sharp-win32-x64` | Apache-2.0 AND LGPL-3.0-or-later | 评估平台可选依赖是否进入发布包，保留 LGPL 履行材料。

这些条目不是本次 Web 包新增依赖的证据；它们来自 workspace 生产依赖清单，仍应由发布责任人根据最终平台包和分发方式确认。Web 包本身没有因正文抽取而引入新的第三方 extractor。

## Provider 与外部条款

Tavily 是当前 MVP provider adapter。离线依赖检查不能证明 Tavily 的当前价格、速率、数据保留、地区可用性、服务条款或部署环境认证状态。配置真实 key 后必须执行：

```text
pnpm.cmd run verify:web-provider -- --require-live
```

live smoke 输出只允许保留 provider 请求计数、状态、HTTP 状态类别、来源 origin、citation 和 bounded/truncated 状态，不得输出 key、Authorization、原始 provider JSON、完整 query 或网页正文。

### 2026-08-30 公开资料复核

本次只读取 Tavily 的公开文档、定价页、平台条款和隐私政策，未登录、未创建 key、未发送 Tavily API 请求，也未读取账户、用量或计费信息。来源在访问当日可见，仍须在正式发布当天重新复核：

- [Search API 文档](https://docs.tavily.com/documentation/api-reference/endpoint/search) 显示当前搜索接口为 `POST https://api.tavily.com/search`，使用 Bearer API key；`max_results` 允许 0 至 20。`basic`、`fast`、`ultra-fast` 为每次 1 credit，`advanced` 为每次 2 credits。LS adapter 固定使用 `basic`、`include_answer=false`、`include_raw_content=false`、`auto_parameters=false`，因此未把 Provider answer 或全文作为本地 evidence 的替代。
- [定价页](https://tavily.com/pricing) 当日显示 Free 每月 1,000 API credits、Pay As You Go 为每 credit USD 0.008；不同付费计划只说明有更高 rate limits，未公开可作为 LS 产品承诺的固定请求速率。真实账户的额度/用量应由 [Usage API 文档](https://docs.tavily.com/documentation/api-reference/endpoint/usage) 所示的授权 `GET /usage` 或当日账户/合同确认，不能在启动时做隐式探测。
- [平台条款](https://tavily.com/terms) 当日说明 key/Agent Key 的使用、调用上限、rate limit、功能、地域或环境访问及认证要求可由 Tavily 调整；key 不得共享给第三方。LS 因此保持每 run quota、有限重试、`unavailable`/`configured_unchecked` 状态和无 HTML scraping fallback，不能将公开页面解释为任何部署地已获准使用。
- [隐私政策](https://tavily.com/privacy)（页面标注最后更新 2025-11-24）说明其收集 query data，除非合同另有约定，可能使用部分 query 改进响应；在有限情形还可能与第三方搜索索引提供商共享 query。其公开保留规则为账号存续、有效删除请求、业务必要性或服务提供商运营目的等条件，而非可供 LS 承诺的固定查询 TTL；政策还说明部分服务提供商位于美国并涉及跨境传输安排。

本次复核加强了 LS 的既有产品边界：只发送经敏感策略允许的最小 query；不发送 Memory atom、完整会话、附件、内部路径、凭证或其他个人信息；默认关闭且需显式启用。公开资料不足以证明实际计划、地区可用性、组织 DPA、保留例外或实际限流，故这些仍是 live smoke 和采购/合规责任人必须完成的发布门。

## 发布前复核条件

- 锁文件与依赖树发生变化时重新执行 audit 和 license 清单，并审查新增直接依赖；2026-09-22 的 audit 结果已包含在生产依赖安全记录的处置清单中。
- `packages/app/out`、`packages/web/dist`、`packages/types/dist` 以及未来 release 包必须通过 `pnpm.cmd run verify:web-artifacts`。
- source map 和测试编译文件默认不作为发布敏感数据证明的主体；最终打包配置仍须决定是否从发布包排除它们。
- 扫描器允许 PDF worker 内置的固定 `/home/web_user` 常量，因为它是上游浏览器 worker 的运行时字符串，不是用户路径；Windows `Users/Documents`、macOS `/Users/*` 和其他 Linux `/home/*` 仍是失败项。这个 allowlist 仅限该精确常量，升级该依赖或修改 bundle 时必须重新复核。
- 新增网络库、HTML parser、代理、浏览器或远程 extractor 时，必须补充供应链、SSRF、响应限制、注入和许可证回归。
- Provider key 只能通过 secret reference 注入，不能进入配置快照、日志、checkpoint、Memory 或构建产物。
- `node scripts/verify-web-release-artifacts.mjs --root=release` 扫描了 659 个文件和 `app.asar` 归档条目；读取错误及 provider secret、私密 fixture、嵌入用户 Memory、绝对用户路径四类命中均为 0。**待核实**：归档条目数在两份记录中不一致——本文记录 14356，Web 发布清单记录 14363；两次扫描未在本轮重新执行，发布前应以签名包的实扫结果为准。该候选安装器尚未签名，签名包仍需重新扫描。
