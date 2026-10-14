# 自定义模型供应商

最后更新：2026-10-14 19:10:00

本文固定 LS 当前实现的“用户自定义供应商与模型”契约：配置字段、权威来源、密钥存放、未知能力的表达，以及仍然不支持的部分。设置页“通用 → 模型供应商”按本契约读写 Main 的配置与密钥库。

## 0. 支持的 API 协议

`providers[].api` 是一个**闭合枚举**：只有 `@littlesheep/llm` 真正实现了客户端的协议才合法，其它值在配置加载时就被 schema 拒绝，而不是被当成兼容接口发出去、在运行中变成一个难以理解的 4xx。

| `api` | 端点 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `openai-chat-completions`（默认） | `POST {baseURL}/chat/completions` | `Authorization: Bearer` | 最通用的 OpenAI 兼容形态；多数网关、Ollama、vLLM 都支持 |
| `openai-responses` | `POST {baseURL}/responses` | `Authorization: Bearer` | OpenAI 较新的 Responses 形态；请求体用 `input` 条目，输出是 typed 事件流 |
| `anthropic-messages` | `POST {baseURL}/messages` | `x-api-key` | Anthropic 原生形态；`system` 是顶层字段，工具用 `tool_use`/`tool_result` |

协议无关的部分（请求 deadline、`Retry-After`、可重试状态判定、usage 回执、SSE 分帧）只在 `packages/llm/src/protocol-transport.ts` 实现一次；每个协议自己的线格式翻译与流式解释留在各自的客户端里，因为共享一个"知道 Anthropic 用 `tool_use`"的模块比重复更糟。

`api` 决定实际构建哪个客户端（`create-client.ts`）。这个字段以前被完全忽略，于是配成 Anthropic 的供应商会被用 chat-completions 的请求体驱动，失败在运行中的一次 4xx——这是本节存在的直接原因。

设置页的“API 协议”下拉框只列出这张表里的值，并随保存写入配置。

## 1. 目标与边界

LS 允许用户自行添加供应商和模型，从而接入自建的 OpenAI 兼容服务或 Anthropic 兼容服务（官方 DeepSeek、GLM、Kimi、OpenRouter、硅基流动、Ollama / LM Studio / vLLM、Anthropic 等），而不需要改源码。

边界同样明确：

- 协议只支持上表列出的三种。`api` 的其它取值会被 schema 拒绝，不会被当成兼容接口发送。
- 新增一个协议意味着两件事同时成立：`@littlesheep/llm` 有一个通过 `client-conformance.test.ts` 的客户端，且 `@littlesheep/config` 的 `PROVIDER_API_PROTOCOLS` 收录它。conformance 套件会断言"枚举里的每个协议都被驱动测试覆盖"，所以只改枚举不会让一个未实现的协议上线。
- 供应商和模型只是“可用选择”，不改变权限、工具范围、记忆策略、验证和收尾步骤。
- LS 不会替用户猜能力数值，也不会把本地估算显示成实测。

### 已知限制

- **助手消息的 `reasoning_content` 不会回放为 Anthropic 的 `thinking` 块**：Anthropic 会校验它签发的 `signature`，而中立契约里没有这个字段。响应方向（thinking 块 → `reasoningContent` / `reasoning_delta`）是完整实现的。
- **`plugins` 之外没有真实厂商端点验收**：三个协议都以文档化的线格式实现，并由共享 conformance 套件、各协议的线格式测试和一个真实窗口门禁覆盖；但"能连上某个真实厂商"未经实测，需要你自己用真实密钥验证。

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
| `api` | 否 | 线协议，取值见第 0 节；缺省为 `openai-chat-completions`。未知取值被 schema 拒绝。 |
| `headers` | 否 | 额外的请求头，用于需要网关路由头的服务。这些头随每次 `chat/completions` 请求发出；运行时投影只回传头部**名称**，不把可能含密钥的值送回 Renderer。 |
| `timeoutSeconds` | 否 | 该供应商的 HTTP 超时。 |
| `models` | 否 | 模型列表，元素可以是字符串 id，也可以是下节的元数据对象。没有模型的供应商不会出现在模型选择器里。 |

### 网关会话头与客户端标识

- 请求以 `User-Agent: LittleSheep/0.1` 标识自己，让网关能区分 Agent 流量与通用 HTTP 库（裸 `fetch` 只会发 `node`）。`headers` 里显式配置的同名头优先。
- 部分网关还要求一个稳定的会话头：opencode Go（`https://opencode.ai/inference/go/v1`）在缺少 `x-opencode-session` 时直接回 `400 MissingSessionID`，此时连凭证都不看。LS 对这类端点自动补头——有对话上下文的请求用当前会话 id，无法归属对话的辅助调用（例如会话压缩）用进程内稳定的客户端 id，因此不会出现“模型能不能用取决于某个调用路径”。
- 判定与拼装集中在 `packages/llm/src/provider-headers.ts`：`headers` 只留给网关自己的路由头，用户不必手写会话头。
- `/models` 目录读取不需要会话头（实测 opencode Go 返回 200），它走 Renderer 的独立客户端，见第 7 节。

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

## 6. 未声明能力的默认值

用户自己添加的模型，只要留空就按下面的默认值使用，因此**不填也能直接用**：

| 字段 | 留空时的默认值 |
| --- | --- |
| `contextWindow` | 256000（256K） |
| `maxOutputTokens` | 32000（32K） |
| `reasoningOptions` | 全部档位：`auto` / `low` / `medium` / `high` / `ultra` |

规则与边界：

- **默认值只作用于用户自己列出的模型**。用户完全没提到的 `provider/model` 仍然解析为未知（`undefined`），不会凭空获得一个窗口。
- **内置厂商事实优先**。`resolveModelContextWindow` 先查内置注册表，所以默认值永远不会覆盖已文档化的数值。
- **默认值是假设，不是实测**。解析结果带 `source: 'assumed-default'`，运行时投影带 `assumedDefaults: true`；设置页据此把这类数值显示为“约 256K”并用警示色，而不是与真实声明并列显示成事实。这条区分是必须保留的：上下文窗口决定何时压缩上下文，一个说清楚来源的假设可以用，一个冒充实测的假设会误导人。
- **用户声明的数值永远优先**。填了就用自己的，不填才用默认。
- **tokenizer 状态不变**：用户声明的模型仍然没有经过验证的最终请求计数器，因此 tokenizer 状态是 `unavailable`（原因 `no-verified-final-request-counter`），上下文用量不会显示本地精确计数。这条与默认值无关——有了窗口不等于有了精确计数器。内置注册表已声明 `exact` 的模型不受此限：`deepseek/deepseek-flash` 与 `deepseek/deepseek-v4-flash` 当前由 V4.1 架构提供服务并使用 `deepseek-v41-provider-calibrated-tokenizer-v1`，`deepseek/deepseek-v4-pro` 保持 V4 精确计数器；精确性按模型与请求形态记录，不能外推到未验证形态。

### 为什么改掉了原来的“留空即未知”

原契约是“LS 不会替用户猜能力数值，留空就保持未知”。它的代价比收益大：一个刚加进来的自定义供应商因为没有任何窗口而**完全不可用**，用户被迫去查一个厂商常常根本不在文档里写的数字。现在改为一律给默认值，但把“这是默认值”这件事全程标出来，让可用性和诚实性同时成立。

## 7. 获取模型（OpenAI 兼容 `/models`）

编辑面板提供“获取模型”，把该接口的模型目录合并进草稿，省掉手抄模型 ID。契约如下：

- **谁发请求**：Renderer 直接向草稿里的 API 地址发一次 `GET {baseURL}/models`。**不经过 Main**：Main 只认识已保存的供应商，把草稿绕过去就会在用户决定保留之前先落一份配置。
- **密钥**：只发送用户在“API 密钥”里当场输入的明文。密钥库里的值不会被读回界面——已配置好的供应商若要获取模型，按钮会说明需要再填一次密钥，而不是发一个无凭证的请求。明文密钥不进 URL、不进错误文案、不进日志。
- **可用性判断**：“要求密钥”和“密钥库里有可复用的密钥”是两件事，按钮按后者决定：`$VAR` 引用且密钥库能解出值（`hasKey`）→ 提示重新填写；引用解不出值、或配置里直接写了明文密钥（`envVar` 为 null）→ 说明“没有可用的密钥”，而不是谎称已保存；无需密钥的本地端点、以及尚未保存的新供应商 → 直接可用。
- **地址推导**：地址以 `/models` 结尾就照用，否则追加 `/models`；查询串会被丢弃。请求带 `x-littlesheep-model-discovery: 1` 头，便于网关区分目录读取。超时 15 秒。
- **合并规则**：只在草稿里补上目录里**已有的**模型 ID。已存在同 ID 的行保留用户写下的所有数值，且**只出现一次**（重复按按钮是幂等的，不会产生重复 ID 而让保存失败）；目录里没有列出的行**不会被删除**（目录不等于清单）。合并结果会说明补了几个、保留了几个。
- **只补 ID**：目录只给模型 ID，所以新加的模型行不带这些数值；留空的字段按第 6 节的默认值使用（并在界面上标为“约”），而不是把目录没说的东西当成目录说了。
- **结果状态**：按钮是“可用/不可用 + 原因 + 结果”三态，禁用时同句说明缺哪个事实（缺地址、地址非法、没有可用的密钥）。请求完成后若草稿的 API 地址已被改动，这次结果会被丢弃并说明，不会写进一个它不属于的草稿。
- **不是连接检查**：读目录成功只证明该地址能应答 `/models`，不代表 `/chat/completions` 可用。第 6 节的“保存不等于已验证可调用”不变。

## 8. 相关实现与验证

- Renderer：`packages/app/src/renderer/settings/models.tsx`（卡片、入口与“获取模型”事务）、`model-provider-editor.tsx`（编辑面板）、`model-provider-draft.ts`（纯校验、合并与转换）、`provider-model-list-client.ts`（`/models` 客户端）、`provider-model-fetch-gate.ts`（按钮可用性与禁用原因）、`provider-editor-session.ts`（只驻内存的草稿）。
- Main：`packages/app/src/main/local-app-api/provider-routes.ts`（列表/新增/更新/删除）、`runtime-payload.ts`（运行时投影）、`keychain.ts`（密钥库）。
- 测试：`packages/config/src/configured-models.test.ts`、`packages/app/src/main/model-provider-api.test.ts`、`packages/app/src/renderer/settings/model-provider-draft.test.ts`（含目录合并与幂等）、`provider-model-list-client.test.ts`（URL 推导、payload 解析与失败分类）、`provider-model-fetch-gate.test.ts`（可用性与禁用原因）、`model-provider-editor.test.ts`、`provider-editor-session.test.ts`。

### 页面形态

设置页遵循应用自身的“一页一面板”约定：进入“模型供应商”先看供应商卡片列表，点击“编辑/添加”后**在页面内切换**到编辑面板（使用设置壳的 `.overlay`/`.dialog` 平面面板，而不是浮层对话框），取消即返回列表。这不是纯样式选择：设置壳会把面板内的 `.dialog` 变成不透明白底浮层之外的平面容器（`width: min(1040px, 100%)`、`background: transparent`），把编辑器当浮层叠加会让透明的面板压在卡片列表上。

真实渲染回归：`pnpm run verify:model-provider-ui` 启动真实 Electron 应用（隔离数据根），断言列表态没有编辑面板、卡片互不重叠、页面无横向溢出，编辑态只剩面板且宽度正常，并保存两个状态的截图供人工复核。

### 卡片要说清楚“配了哪些模型”

供应商卡片在标题旁用文字给出模型总数（`40 个模型`），chips 只是预览：超过 12 个就折到 8 个，并给出“还有 N 个模型，展开全部”；≤12 个时全部显示，也不出现多余的展开控件。按默认值估算的模型数量会单独说明，并在 chip 上用“约 256K”和警示色标出——它们是默认值而不是实测值，这一点不能静默略过。

这样做的理由：一个供应商可以声明几十个模型，而每个 chip 长得一样，整页只会变成一片无法阅读的小块，页面反而说不上来到底配置了什么。

真实渲染回归：`pnpm run verify:provider-card-model-summary` 用一个声明 40 个模型的自定义供应商和一个 2 个模型的供应商，断言总数文案、折叠预览数量、展开后可达全部模型、`aria-expanded` 状态，以及两种状态下都不溢出窗口。

### 列表只显示已配置的供应商

“模型供应商”页不再罗列所有内置预设。一个供应商只有在下面任一条件下才出现在列表里：

- 已经有密钥（密钥库里的值，或进程环境里已经存在的 `$VAR` 指向的值）；
- 本身不需要密钥（例如本地 Ollama / LM Studio / vLLM 这类自建端点）；
- 是用户自建的供应商（即使密钥还没填，用户主动创建的东西不隐藏）。

未配置的内置预设（OpenAI / DeepSeek / GLM）不会出现在列表里，而是出现在“添加提供方”里，和 OpenRouter、Moonshot、百炼、硅基流动等模板并列，选择后直接进入编辑面板补密钥或改模型。这样不会再把“看起来可用其实没配”的供应商摆给用户。

引导位置：

- 列表为空时显示空态卡片，说明按钮的作用和“配好后可在输入栏选择模型”的结果；
- 输入栏的模型选择器在没有任何可用模型时，标题提示“在 设置 → 模型供应商 里添加供应商和模型”。
