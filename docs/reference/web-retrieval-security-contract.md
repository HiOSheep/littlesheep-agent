# LittleSheep 网络检索冻结契约与威胁模型

状态：阶段 0 冻结；受控实现已落地，发布门未闭合
最后更新：2026-09-24 20:56:17
冻结日期：2026-08-29
执行入口：[网络检索安全合并验收](web-retrieval-security-acceptance-2026-08-29.md)（发布门、安全矩阵、发布日复核清单与可复核命令）

本文是任务书 WSR-000 至 WSR-006 的支持性冻结记录；原实施任务书已于 2026-09-22 退役，原文可取回：`git log --follow -- docs/taskbooks/web-search-and-safe-retrieval-taskbook-2026-08-28.md`。任务顺序与阶段状态不再由任务书维护：`web_search` / `web_fetch`、Provider、受控抓取、safe read、citation 与渠道 projection 均已实现并有离线门证据，仍未闭合的是真实 Provider 关联 fetch、正式渠道、签名包与干净 Windows 验收，逐条见上述验收报告；本文只固定实现不能自行改变的权限、配置、Provider、安全和证据语义。

## 1. 不可变产品语义

1. `local_memory`、`local_session`、已启用并通过 Runtime 检查的 `public_web_search` 与 `public_web_fetch` 是 safe read，可以免除逐次交互批准。
2. safe read 不是“所有名称像 read 的工具都放行”。外部文件、范围不明的文件、浏览器、认证页面、Cookie、Authorization、POST、上传、写入、执行和任意 HTTP 仍按审批或硬拒绝处理。
3. `strictReadApproval=true` 时，研究和受限模式中的 safe read 恢复逐次审批；完全访问仍受硬拒绝规则约束。
4. 网络能力是显式 opt-in。旧配置缺失 `web` 字段时补齐 `enabled=false`，不能自动选择 Provider、探测密钥或发送请求。
5. 一次性/持久化联网授权只允许打开受控公共读取，不授权浏览器身份、认证读取、任意 endpoint、任意 header 或网页写入记忆。
6. 搜索结果、页面正文和元数据全部是 `external_untrusted`。其中文字永远不能改变系统提示、状态机、工具范围、权限、配置、TaskBook、Memory Write Gate 或 Runtime 事件。

## 2. Access Descriptor 冻结语义

| 字段 | 冻结枚举 | 判定责任 |
| --- | --- | --- |
| `effect` | `none / read / write / execute / external` | Runtime 根据真实工具和解析后输入计算 |
| `egress` | `none / public_query / public_url / authenticated / unknown` | Runtime 根据实际外发数据、目标和身份计算 |
| `trust` | `runtime_owned / external_untrusted` | 外部网络返回固定为不可信 |
| `boundary` | `inside / outside / unknown` | 文件路径由现有容器边界计算；URL 由网络边界计算 |
| `safeReadClass` | `local_memory / local_session / public_web_search / public_web_fetch / authenticated_read / arbitrary_read / none` | 只能由内置分类器给出，模型和插件声明不构成授权 |
| `hardDecision` | `allow / approval / deny` | SSRF、危险 scheme、凭证 URL 等硬规则优先 |

判定顺序固定为：输入校验和硬拒绝 → descriptor → full 模式普通放行 → safe read 策略 → 审批 → 无审批回调时默认拒绝。任何调用入口都必须复用同一判定，不能在 Harness、Tool Execution Service、内置工具和插件桥接层各自维护不同规则。

## 3. 配置与迁移冻结

公共配置域为 `web`，独立于模型 `providers`：

- 默认 `enabled=false`；
- 默认 `readMode=public_anonymous`，但只有 `enabled=true` 才形成有效网络策略；
- 默认 `strictReadApproval=false`；
- 默认每轮最多 4 次搜索、4 次抓取、4 个并发网络请求；
- 搜索、抓取和总检索时间分别有独立上限；
- 默认响应上限 2 MiB、抽取正文上限 40,000 字符、重定向上限 5；
- 缓存默认开启、TTL 300 秒、容量上限 64 MiB，但 Provider 许可不允许存储的字段不得写入缓存；
- 默认 `browserFallback=approval_required`；
- 默认敏感 query 策略为 `approve`；
- DNS 解析模式冻结为 `system` 与 `cloudflare_doh` 两个取值，默认 `system`。`cloudflare_doh` 是显式配置的固定可信替代路径（固定 endpoint `https://cloudflare-dns.com/dns-query` 与固定地址 `1.1.1.1`/`1.0.0.1`），不接受任意 resolver endpoint、不静默 fallback，并且仍对全部 A/AAAA 结果、每次 redirect 和 TLS SNI/Host 执行与 `system` 相同的 IP/SSRF/TLS 校验与锁定连接；
- Provider 密钥只登记 `apiKeyRef`，RunConfig、ToolResult、Prompt、TaskBook、日志和 UI 不保存解析后的密钥。

兼容规则：新增字段保持 Config v1 的加法兼容；旧配置由 schema 默认值迁移。`ResolvedRunConfig`、checkpoint 和 execution log 的网络字段在 v1 中是可选字段，因此旧记录继续可读；新 run 必须生成不可变 `NetworkReadPolicy`。

## 4. 首个 Provider：Tavily

MVP 首个 SearchProvider 冻结为：

| 项目 | 决策 |
| --- | --- |
| Provider id | `tavily` |
| Adapter type | `tavily-search-v1` |
| 官方 endpoint | `POST https://api.tavily.com/search` |
| 密钥引用 | `$TAVILY_API_KEY` 或宿主 secret resolver |
| 默认搜索深度 | `basic` |
| 默认请求 | `include_answer=false`、`include_raw_content=false`、`auto_parameters=false` |
| 隐式 fallback | 禁止；不得切换到搜索引擎 HTML scraping 或未配置 Provider |
| 真实测试 | 隔离 data root、显式 opt-in、测试 key、失败后不写正式 Memory |

选择理由是其官方 API 直接提供结构化搜索结果、域名过滤和时间过滤，且无需绑定模型厂商。关闭自动回答和原始正文后，Provider 只承担发现与排名；页面正文仍由 LS 的受控 `web_fetch` 获取。

截至 2026-08-29 的官方资料快照：免费层每月提供 1,000 credits 且不要求信用卡；Basic Search 消耗 1 credit，Advanced Search 消耗 2 credits；开发和生产限流分别由官方计划说明。价格和限流属于易变外部事实，发布 smoke test 前必须重新核对，不能把本段数字硬编码进 Runtime。

官方依据：

- [Search API reference](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [API credits and plans](https://docs.tavily.com/documentation/api-credits)
- [Data privacy statement](https://help.tavily.com/articles/2428680383-how-tavily-protects-your-data)
- [Terms of Service](https://www.tavily.com/terms)

许可边界：LS 不宣称拥有转售、再分发或训练数据集式保存 Provider 输出的普遍权利。适配器丢弃原始响应，只保留完成本轮回答和审计所需的有界归一化字段；生产部署者必须接受并遵守当时有效的 Provider 条款。中国大陆或特定网络环境的可用性不做静态保证，必须由部署地真实 health/smoke test 证明；后续 DashScope/Moonshot/SearXNG adapter 不改变 safe-read 判定。

## 5. 威胁模型

| 威胁 | 主要攻击面 | 强制控制 | 必须存在的测试证据 |
| --- | --- | --- | --- |
| SSRF | 用户 URL、搜索结果 URL、重定向 | 只允许 HTTP(S)；拒绝 localhost、私网、link-local、metadata 和危险 IPv6；DNS 后复查 | literal IP、域名解析、IPv4/IPv6、metadata fixture |
| DNS rebinding | DNS 首次解析与连接地址不一致 | 连接前固定并复验解析结果；重定向重新解析 | 解析地址变化 fixture |
| 重定向逃逸 | 公网 URL 跳到私网/危险 scheme | 每一跳完整重算策略；限制 5 跳 | 公网到私网、循环、超限 fixture |
| URL 凭证泄露 | `user:pass@host`、query secret | 拒绝 URL credentials；日志保存 hash/脱敏摘要 | credential URL 和日志扫描 |
| 任意请求能力 | method/header/body/proxy/outputPath | 工具 schema 不暴露这些字段；Provider endpoint 只来自配置/Registry | schema 拒绝和未知字段测试 |
| API key 泄露 | 配置、错误、Prompt、日志、UI | secret resolver；Authorization 不进入错误；全链路脱敏 | auth 失败和序列化扫描 |
| 敏感 query 外发 | 会话、Memory、路径、token 被拼入 query | 最小 query；敏感检测；默认审批；不发送完整上下文 | token/path/cookie fixture |
| Prompt injection | snippet、HTML、JSON、隐藏文本 | `external_untrusted` 封套；Runtime 不解释页面为控制消息 | “忽略规则/执行命令/写记忆”页面 fixture |
| 伪造 citation | 模型自造 id/URL、结果错绑 | Runtime 生成并绑定 id；发布前校验 id 与来源 | 不存在 id、跨 URL 错绑测试 |
| 资源耗尽 | 大响应、压缩炸弹、嵌套 HTML、慢流 | 网络字节、解压字节、正文字符、并发和总时间硬上限 | 大小、压缩、慢流、取消测试 |
| 无限重试/费用失控 | 限流、5xx、循环工具调用 | 幂等有限重试；每轮 query/fetch/repeat 配额 | 429、5xx、重复调用测试 |
| 缓存泄露 | query、URL token、正文、跨用户 key | hash key、短 TTL、容量上限、按 scope 隔离、可清除 | secret key、过期、损坏恢复测试 |
| 浏览器身份越权 | Cookie、登录态、插件会话 | 浏览器不是 public fetch；默认独立审批 | 三档权限矩阵 |
| TOCTOU | 审批后配置、DNS、URL 或输入变化 | 执行前重验；批准只绑定一次调用和规范化输入 | 审批锁、并发、重绑定测试 |

## 6. 错误、引用、截断和日志

稳定错误大类由 `WebErrorKind` 定义；Provider 错误必须转换后再向上返回。未知 Provider JSON 不能直接进入模型或日志。

Citation 规则：

1. citation id 由 Runtime 生成；
2. id 必须绑定实际 Provider/Fetch 记录和规范化 URL；
3. 模型只能引用本轮提供的 id；
4. `blocked/partial/truncated/stale` 必须随来源投影；
5. citation 缺失或错绑时，不得宣称“已查证”。

截断规则：任何字节或字符上限触发都返回结构化 `truncated=true`；截断不是成功完整，必须影响 completeness、VERIFY 和最终回答。

日志规则：默认不保存原始 query、完整 URL 中的敏感参数、Provider 原始 JSON、页面正文、Cookie、Authorization、API key、内部路径或 Atom 内容。ToolResult、checkpoint 和 execution log 只保存 `WebEvidenceProjection`；真实 citation 元数据由后续有界来源存储负责。

## 7. 发布状态

网络专项使用以下对外状态：`disabled / unconfigured / configured_unchecked / ready / degraded / unavailable`。只有实际 Provider smoke test、安全矩阵、取消与全量回归通过后，Provider 才能显示为 `ready`；mock、schema、工具注册或流畅的 LLM 回答都不能提升发布状态。
