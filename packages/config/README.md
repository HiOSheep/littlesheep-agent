# @littlesheep/config

负责配置 schema、默认值、模型/Provider 能力声明和配置文件加载。

最后更新：2026-09-22 12:43:39

## 职责与边界

- 公开入口是 `src/index.ts`，另有 `./model-capabilities` 子路径；主要实现位于 `schema.ts`、`defaults.ts`、`loader.ts`、`model-capabilities.ts`、`provider-models.ts` 和 `configured-models.ts`。
- `tools.invocationTimeoutMs` 是宿主工具统一超时配置，默认 120 秒，兼容范围为 1 秒到 24 小时；实际执行仍受 run 总超时和取消信号约束。
- 拥有压缩与上下文默认值：`compaction.threshold=400`、`keepRecent=200`、`background=false`，以及 `contextCompressionThresholdRatio=0.8`（取值 0.5–0.95）。
- 拥有模型/Provider 登记查询：`model-capabilities.ts` 提供上下文窗口、tokenizer 与 reasoning 能力，`provider-models.ts` 归一化 Provider 的模型声明，`configured-models.ts` 把用户声明的模型元数据注册进能力表。
- `web` 是独立、默认关闭的网络读取域，旧配置缺失该字段时只补默认值，不会自动选择 provider 或发起网络请求。
- 负责验证配置形状，不负责保存明文密钥或执行 Provider 请求。
- `web.providers[].apiKeyRef` 只登记环境变量/密钥链引用；配置包不解析密钥，也不允许 Renderer 或模型把 endpoint、header 或 credential 注入一次工具调用。
- `web.dnsResolver` 只允许 `system` 或显式 `cloudflare_doh`；DoH 是额外的域名外发路径，不能由模型、Renderer 或单次工具调用指定任意 resolver endpoint。
- 禁止放入 Electron UI 状态、Runner 装配和供应商网络逻辑。

## 依赖与数据

- 只依赖 zod，不引入 workspace 运行时依赖；上层 App、Runner、CLI 和 LLM 消费它。
- 配置文件属于用户数据，包本身不拥有密钥生命周期。

## 测试与修改定位

- schema 回归位于 `src/schema.test.ts`，已配置模型能力回归位于 `src/configured-models.test.ts`。
- 新增配置必须同时提供默认值、校验、兼容解析和对应消费方测试。
