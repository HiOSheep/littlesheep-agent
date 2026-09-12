# 自定义模型供应商

最后更新：2026-09-11 10:06:00

本文固定 LS 当前实现的“用户自定义供应商与模型”契约：配置字段、权威来源、密钥存放、未知能力的表达，以及仍然不支持的部分。设置页“通用 → 模型供应商”按本契约读写 Main 的配置与密钥库。

## 1. 目标与边界

LS 允许用户自行添加供应商和模型，从而接入任意 OpenAI 兼容服务（官方 DeepSeek、GLM、Kimi、OpenRouter、硅基流动、Ollama / LM Studio / vLLM 等），而不需要改源码。

边界同样明确：

- 协议只支持 OpenAI 兼容的 `chat/completions`。`api` 字段只有 `openai-chat-completions` 一个合法取值，其它协议会被 schema 拒绝，不会被当成兼容接口发送。
- 供应商和模型只是“可用选择”，不改变权限、工具范围、记忆策略、验证和收尾步骤。
- LS 不会替用户猜能力数值，也不会把本地估算显示成实测。

## 2. 权威来源与优先级

能力数值只有两个来源，且优先级固定：

1. **内置事实**（`packages/config/src/model-capabilities.ts`）：来自官方文档的上下文窗口、输出上限、推理档位、Provider reasoning 映射和精确 tokenizer 状态。用户声明不能覆盖它。
2. **用户声明**（`packages/config/src/configured-models.ts`）：只对内置注册表不认识的 `provider/model` 生效。声明了什么就用什么，没声明就保持未知。

`packages/config/src/provider-models.ts` 负责把配置里的模型列表（字符串 id 或元数据对象）归一成同一形状，并按 id 合并预设与用户条目；合并时“裸 id 不会擦掉另一侧的元数据”。

## 3. Provider 字段（`providers[]`）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 供应商 id，长度 1–64。小写 slug 才能生成稳定的密钥库条目名（设置页按 `^[a-z0-9][a-z0-9._-]*$` 校验）。 |
| `name` | 否 | 显示名称，缺省用 id。 |
| `baseURL` | 是 | OpenAI 兼容 API 根地址，必须能解析为 http(s) URL。 |
| `apiKey` | 否 | 写 `$ENV_VAR` 表示引用密钥库条目；缺省表示该供应商不需要密钥。 |
| `api` | 否 | 唯一的合法值是 `openai-chat-completions`（当前默认值）。 |
| `headers` | 否 | 额外的请求头，用于需要网关路由头的服务。运行时投影只回传头部**名称**，不把可能含密钥的值送回 Renderer。 |
| `timeoutSeconds` | 否 | 该供应商的 HTTP 超时。 |
| `models` | 否 | 模型列表，元素可以是字符串 id，也可以是下节的元数据对象。没有模型的供应商不会出现在模型选择器里。 |

## 4. 模型条目字段（`models[]`）

| 字段 | 说明 |
| --- | --- |
| `id` | 发送给该接口的模型名，必填。 |
| `name` | 显示名称，缺省用 id。 |
| `contextWindow` | 声明的上下文窗口 token 数。 |
| `maxOutputTokens` | 声明的最大输出 token 数。 |
| `reasoningOptions` | 该模型接受的运行时推理档位（`auto/low/medium/high/ultra`）子集。缺省只有 `auto`。 |
| `ultraEffort` | `ultra` 映射到 Provider 的哪一个 `reasoning_effort`（`high/xhigh/max`），缺省 `high`。 |
| `vision` | 是否支持图片输入。 |
| `sourceUrl` | 声明数值的文档链接（可选，仅作记录）。 |

## 5. 密钥与凭证

- 设置页输入的明文密钥只经 Main 写入系统密钥库（`<data-root>/config/keys.json`，Electron `safeStorage` 加密），配置文件里只保留 `$<ID>_API_KEY` 引用，例如 `my-gw` → `MY_GW_API_KEY`。
- 启动时 `loadApiKeys()` 解密后注入 `process.env`，所以既有的 `apiKey: "$DEEPSEEK_API_KEY"` 形态继续有效。
- 编辑供应商时留空密钥表示“保持已保存的密钥”；发送显式空字符串才会清除引用。
- 明文密钥不进入配置、运行时不变量、日志或 Renderer 载荷。

## 6. 未知能力的表达

- 未声明 `contextWindow` 且内置注册表也不认识时，运行时投影不带 `contextWindow`，UI 显示“未声明”，不显示 0 或猜测值。
- 未声明的模型只有 `auto` 推理档位，不会凭空出现 `high/ultra`。
- 用户声明的模型没有经过验证的最终请求计数器，因此 tokenizer 状态是 `unavailable`（原因 `no-verified-final-request-counter`），上下文用量不会显示本地精确计数。

## 7. 相关实现与验证

- Renderer：`packages/app/src/renderer/settings/models.tsx`（卡片与入口）、`model-provider-editor.tsx`（编辑对话框）、`model-provider-draft.ts`（纯校验与转换）。
- Main：`packages/app/src/main/local-app-api/provider-routes.ts`（列表/新增/更新/删除）、`runtime-payload.ts`（运行时投影）、`keychain.ts`（密钥库）。
- 测试：`packages/config/src/configured-models.test.ts`、`packages/app/src/main/model-provider-api.test.ts`、`packages/app/src/renderer/settings/model-provider-draft.test.ts`。

### 页面形态

设置页遵循应用自身的“一页一面板”约定：进入“模型供应商”先看供应商卡片列表，点击“编辑/添加”后**在页面内切换**到编辑面板（使用设置壳的 `.overlay`/`.dialog` 平面面板，而不是浮层对话框），取消即返回列表。这不是纯样式选择：设置壳会把面板内的 `.dialog` 变成不透明白底浮层之外的平面容器（`width: min(1040px, 100%)`、`background: transparent`），把编辑器当浮层叠加会让透明的面板压在卡片列表上。

真实渲染回归：`pnpm run verify:model-provider-ui` 启动真实 Electron 应用（隔离数据根），断言列表态没有编辑面板、卡片互不重叠、页面无横向溢出，编辑态只剩面板且宽度正常，并把两个状态的截图写到 `.codex_tmp/`。

### 列表只显示已配置的供应商

“模型供应商”页不再罗列所有内置预设。一个供应商只有在下面任一条件下才出现在列表里：

- 已经有密钥（密钥库里的值，或进程环境里已经存在的 `$VAR` 指向的值）；
- 本身不需要密钥（例如本地 Ollama / LM Studio / vLLM 这类自建端点）；
- 是用户自建的供应商（即使密钥还没填，用户主动创建的东西不隐藏）。

未配置的内置预设（OpenAI / DeepSeek / GLM）不会出现在列表里，而是出现在“添加提供方”里，和 OpenRouter、Moonshot、百炼、硅基流动等模板并列，选择后直接进入编辑面板补密钥或改模型。这样不会再把“看起来可用其实没配”的供应商摆给用户。

引导位置：

- 列表为空时显示空态卡片，说明按钮的作用和“配好后可在输入栏选择模型”的结果；
- 输入栏的模型选择器在没有任何可用模型时，标题提示“在 设置 → 模型供应商 里添加供应商和模型”。
