# Harness 瘦身第一批实施包：HL-00～HL-04 · 2026-09-12

最后更新：2026-09-12 17:35:19

状态：规格已细化，代码实施待开始。日期：2026-09-12。

上位任务书：[全面审计与任务书](harness-lean-audit-taskbook-2026-09-12.md)。本文不是第二份审计，而是第一批工作的执行合同：减少接手者重新探索和自行决定架构的成本。源码路径均相对仓库根；新增接口/用例均明确为待实现，不代表现有 API。

## 1. 交接入口与范围

本批目标：消除非法路由和错误验证通过，建立可信请求计时/完整用量，修复流式传递与界面归并。**本批不负责扩大轻量准入、不合并双驱动、不改变推理档位、不实施记忆沉淀迁移。**用户已确定的“自动沉淀随上下文压缩触发、不是逐 run 后台学习”保持在 HL-08，禁止反向加入逐 run 学习队列。

建议接手方式：执行模型一次只处理下表一个小包；修改前读其入口与相关测试，先形成失败用例，再实施、验收、提交交接记录。这里的“小包”是工作边界，不要求创建多个 Codex 任务或启动多个 Agent。本轮文档细化不授权自动交接、切换模型或并发改代码。

### 1.1 第一批工作顺序

| 小包 | 目的 | 前置 | 完成时交付 |
| --- | --- | --- | --- |
| 00A | 固化当前树/构建/运行身份 | 无 | 脱敏基线与可重现命令 |
| 00B | 固化失败用例和预期结果 | 00A | 回归清单及稳定反例 |
| 01A | 封住 respond 协议错误引发的执行升级 | 00B | 安全的失败路径与驱动集成测试 |
| 01B | DSML 与原生工具流收敛 | 01A | 完整解码、分片/引用/参数保真测试 |
| 02A | 收紧结构验证与无证据降级 | 00B | 验证判定及负例测试 |
| 02B | 贯通验证失败到最终结算 | 02A | 无旧成功文案漏发的 Runner 回归 |
| 03A | 统一请求/传输尝试生命周期 | 01B | 计时、重试身份和模型调用点清单 |
| 03B | 独立于诊断窗口的完整用量 | 03A | 聚合/回放/未知值/页脚契约 |
| 04A | 类型化流式更新与闭合规则 | 03A、01B | producer → SSE → reducer 一致性 |
| 04B | 最终正文流式、提示词与视觉补齐 | 04A、03B、02B | 实际请求投影、渲染证据与首帧测量 |

表中依赖允许独立工作先准备，但默认逐包执行，尤其不能同时修改 `llm/client.ts`、`model-observability.ts` 或同一个事件 reducer。通过 01A/02A 的局部测试不代表第一批已完成。

### 1.2 通用硬约束

1. 保留当前 dirty/untracked 改动；不要 reset、清理或还原整个文件。每包记录开始前的目标文件 hash 与变更范围，交付本包 diff；遇到重叠变化先重新读取，无法区分时报告。
2. 工具仍经过原有 ToolExecutionService 与 Main 权限判定；不得新增旁路 shell、绕开白名单或把半份参数提前执行。模型输出协议不是用户授权。
3. 不降低测试断言、默认推理配置、上下文完整性或产物要求换速度。已有错误预期可修改，但须指出冲突契约并补等价正例，不能只删除测试。
4. 不增加第三个状态机、通用 EventBus、任务平台或第二份记忆数据库。优先局部 helper、既有 durable event/codec 和存储边界。
5. 最终文案必须保持真实 LLM provenance 与原子登记/结算；Runtime 错误/进度可用固定标签，但不能伪装成新的 Agent 回复。
6. 边界外文件不是绝对禁止修改，但必须先写出“缺少它哪个验收无法成立”，限制为必要传播，并更新文件清单。公共类型改变必须带所有生产消费者、codec 与回放测试。
7. 真实 Provider/Electron 验收使用隔离测试数据根与受控工具，不动真实工作区或用户会话。无网络夹具优先；真实调用先明确模型与费用上限，不擅自跑长基准。

### 1.3 本次复核对旧审计措辞的补充

- `verify/routing.ts` 的 `publishVerifiedReply` 当前是空函数。F02/F03 确认的是错误 pass/路由风险；**实际权威回复发布在 FINALIZE/Runner**。反例必须同时检查这些下游，不能用调用空函数证明真实消息已经发布。
- `OpenAIClient` 的网络重试和 stream-usage fallback 在一次 `chat/chatStream` 内部；`callLlmForJson` 的解码重试在外部。两者必须分开计数，不能把一个包装调用当成一次真实 HTTP 尝试。
- `recordProviderUsage` 在快照不存在时会提前返回。只修改页脚求和或放大 64 份快照上限不能解决完整用量问题。
- 已有 app build fingerprint 工具、正文帧缓冲、SSE start 和 SVG 组件。复用并补覆盖，不重复造基础设施。

## 2. HL-00：基线与回归夹具

### 00A · 基线身份

必读入口：`scripts/lib/app-build-fingerprint.mjs`、`scripts/lib/build-fingerprint.mjs`、`scripts/ensure-app-build.mjs`、`packages/app/src/main/index.ts`、`packages/runner/src/runner.ts`、`packages/runner/src/execution-log.ts`。

允许改动：构建身份的只读投影、定向测试/诊断脚本及其报告结构；必要的 app shared 类型。不得在此包重构 Runner 或把旧构建的 fingerprint 写成新源码版本。

操作步骤：

1. 记录 `git rev-parse HEAD`、`git status --short`、Node/pnpm 版本和本包目标文件内容 hash。HEAD 不是脏树的完整身份；不把整个 diff/日志上传第三方。
2. 读取已有构建 manifest；`pnpm run assert:app-build` 若报告 stale，作为基线事实保留，不直接改 manifest 绕过检查。需要新的桌面基准时再执行标准构建。
3. 固化最小 `RunBuildIdentity` 语义：源码输入 digest、构建输出 digest、启动时捕获的构建身份、实际 harness mode、模式覆盖来源。字段可复用现有结构；缺失明确标 unknown。**每 run 读取当前磁盘 manifest 不能证明已加载进程版本。**
4. 报告独立记录 source-test、built-artifact、loaded-process 三种身份。纯源码测试不填 loaded-process；纯构建通过不填 UI 验收通过。

输出：本地脱敏报告，包含版本、身份/完整性、模式、任务 ID、命令/退出码、失败用例清单。报告不含密钥、用户提示词/记忆正文或原始工具参数。仓库内只加入可复用脚本/合成夹具及短结论。

验收：旧进程+新磁盘构建能被辨别；模式 override 可追溯；缺 manifest 或 stale 不伪装当前；无调用 Provider、无改权限、无新增每请求内容 hash 全量计算。

### 00B · 回归清单

复用 `packages/harness/src/tests/helpers.ts` 的 `makeCtx/createMockLlm`、既有注入 fetch 的 LLM client 测试，以及 Renderer reducer 测试模式。不用 AST 提取/空发布替身替代持久回归。

每个用例 ID 必须出现在测试名称或报告中：`HA-01-*`、`HA-02-*`、`HA-03-*`、`HA-04-*`，对应后文矩阵。必须先确认关键负例在基线按预期失败；不要求把任意拼出来的 context 当有效 fixture。

基线阶段允许在本地记录已知失败；每个修复包结束时，其负责用例不得处于 skip/todo/expected-failure。保留本来通过的对照用例。不要把“当前错误行为成立”写成长期正确预期。

共同记录格式：

```text
用例 ID / 固定输入与故障注入点
预期可见状态、工具调用数、模型请求/尝试数、durable 终态
基线实际结果与失败断言
修复后实际结果 / 命令 / 退出码 / 证据位置
仍未覆盖项（不得默认为通过）
```

## 3. HL-01：路由与协议边界

### 01A · respond 纠偏的保守修复决定

入口与修改范围：`packages/harness/src/stages/reply.ts`、其测试、`packages/types/src/stage-transitions.ts` 及测试、`run-context-contract.ts`，两驱动的测试。`default-harness.ts/durable-harness.ts` 默认只作调用与验证入口，不在本包合并。

**固定决定：不以 DSML 文本触发 respond → execute，也不为这段错误自动补 `reply → decide` 边。** 普通 respond 请求的 tools 缺失表示没有工具能力；Provider 违反这一合同应作为协议失败处理，不由模型声明补授权。

步骤：

1. 删除/替换由原始 DSML 触发的 classification 写入、`route_decided:execute` 与非法跳转。同步收窄只为该分支增加的 ownership 权限，并检查还有无其他合法 writer；不得盲删公共字段。
2. 完整、非引用的非法控制输出撤回 provisional 正文，记录具体 Runtime 协议错误，并走现有合法退出/失败结算路径。第一批不新增“协议纠错模型重试”，避免与文案去重/连续性修复叠加预算。
3. 因错误路由未执行的用户任务不能假装完成。真正执行请求应由已有入站活动路由进入 execute；补固定中英文执行请求路由正例。若这需要扩大分类器/轻量准入，记为 HL-05 问题，不在本包偷偷加关键词。
4. 若后续确有证据需要从 respond 纠偏到 execute，必须单独设计由用户当前输入/已绑定 continuation 证明的意图合同、预算和 checkpoint，不借本次 DSML 修复引入。

| 用例 | 输入/故障 | 必须断言 |
| --- | --- | --- |
| HA-01-01 | 问候/状态询问，Provider 返回工具封套 | 执行工具 0 次；无 execute route event；正文撤回；合法 Runtime 终态 |
| HA-01-02 | 明确创建文件，经正常 classify → execute，Provider 返回工具调用 | 进入原工具服务并执行批准后的操作；不是全局禁用工具 |
| HA-01-03 | 用户解释协议，回复 fenced/inline 示例 | 保留解释文本；不执行、不升级、不误报任务完成 |
| HA-01-04 | 注入非法 stage.next | 两驱动均拒绝，错误包含边；普通合法转移不受影响 |
| HA-01-05 | 失败前已有正文预览，随后终态失败/重连 | UI 和持久历史无那份成功草稿，Runtime 错误可见，注册表无伪完成 |

完成标准：测试从真实 driver 运行 stage，而不仅断言 REPLY 的返回值；不放宽迁移 manifest，不新增写入权限，无协议失败引发的新副作用。

### 01B · 统一 DSML 解码，不丢参数、不漏分片

入口/范围：`packages/llm/src/client.ts`、`dsml-tool-calls.ts`、`types.ts`、对应测试；可新增一个仅属于 LLM 适配层的增量解码 helper。Harness/Renderer 不新增协议 regex。

语义合同（可用内部 tagged result 实现，不要求公开另一个协议 API）：

| 结果 | 条件 | 对下游行为 |
| --- | --- | --- |
| text | 普通文本、明确 fenced/inline/转义的引用示例 | 原样正文，不产生工具候选 |
| pending | 非引用控制起始前缀尚未收齐 | 暂缓可疑尾部，继续等分片；不得执行 |
| tool-calls | 完整合法封套，request 允许工具，schema 后续仍须校验 | 标准 toolCalls + 可见前导正文；执行仅在完整响应后 |
| protocol-error | 非引用控制封套残缺、未知工具、无工具权限、非法参数 | 不落成普通成功正文；明确失败，不擅自执行 |

具体要求：

- 以增量状态扫描新字符及有限未决尾部，支持已经约定的全角/ASCII delimiter 变体；一次归一化规则服务流式和非流式，不每个 chunk 全文 regex 重扫。
- 支持“前导说明 + 完整封套”，引用语法由协议词法边界识别，不靠正文包含 `DSML` 单词判定。非明确引用且无法消除执行歧义时保守报协议错误；不得猜测执行。
- 保持 `string=true` 参数中的前后空格、换行、Unicode 和转义语义；目前 `.trim()` 会影响这类内容，应以参数保真测试约束。`string=false` 只解析合法 JSON；重复参数名、未知结构、嵌套控制残片 fail closed。
- 每个调用独立 index，原生名字/arguments 分片正确拼接；DSML 与原生 toolCalls 同时出现且不能证明同一合法结果时，报协议冲突而不是执行两份或静默选一份。
- 工具 callId 在逻辑调用内稳定，不用全局“相同参数 hash”合并不同调用。每次传输重试明确 reset，未完成尝试不生成可执行工具。
- 解码器可报告准备中的名字/字符数；完整 input 仍必须到 ToolExecutionService 校验，UI 进度不预执行。

| 用例 | 必须覆盖 |
| --- | --- |
| HA-01-06 | 合法封套逐字符切分及所有 delimiter 切分点；最后返回的 toolCalls 与非流式相同 |
| HA-01-07 | 两工具交错、名称分片、参数含中文/emoji/首尾换行，完整 arguments 内容一致 |
| HA-01-08 | 缺关闭标签、重复参数、非法 JSON、未知名字、request 无 tools、原生/DSML 冲突均 0 次执行 |
| HA-01-09 | 代码块、行内代码、转义、前导文字、普通 `<`/`DSML` 单词，不误执行、不吞正常正文 |
| HA-01-10 | 失败后重试，旧尝试前缀/参数不污染新响应；长流扫描成本随输入近线性增长 |

门禁：`pnpm exec vitest run packages/llm/src/client.test.ts packages/llm/src/dsml-tool-calls.test.ts packages/harness/src/stages/reply.test.ts packages/harness/src/default-harness.test.ts packages/harness/src/e2e.test.ts packages/types/src/stage-transitions.test.ts packages/types/src/run-context-contract.test.ts`。新增 driver/流解码测试文件须加入命令与报告。公共边界变更再跑 `pnpm run verify:core`。

## 4. HL-02：验证与最终交付

### 02A · 固定验证规则

入口/范围：`packages/harness/src/stages/verify.ts`、`verify/routing.ts`、`verify/task-state.ts`、`verify/evidence.ts`、`verify/model-call.ts`、`verify/contracts.ts` 和对应测试。必要时读取 execution evidence/tool source，但不新增执行器或 TaskBook 替代品。

第一批的确定性决定：

1. 停用“任意成功 read 在最后 write 之后就通过”的 lean shortcut，不立即设计泛用轻量验证器。保留经补强后的窄范围只读/精确写读快速验证。
2. 无 TaskBook 不等于无缺口；工具记录不存在、记录窗口被截断、副作用未结算等均不能因为 verifier 不可用而 degraded pass。
3. Model verifier 的 pass 也必须先通过执行事实门：受影响步骤/调用存在，失败/拒绝/unknown effect 未被掩盖。模型判断不能修复丢失的 Runtime 证据。
4. 狭窄结构验证成功可免 LLM；否则继续现有有界 verifier。verifier transport/decode 失败且没有独立满足目标的证据时，结果是“未能验证”，不是“任务已验证完成”。不得默认再多加一轮自检。

建议内部 helper 返回三种决策，复用现有状态，不强迫为其新建 durable schema：

```ts
// 待实现的内部合同；不是 Provider 返回格式。
type VerificationGate =
  | { kind: 'proven'; rule: string; evidenceIds: string[] }
  | { kind: 'needs_model'; reasonCode: string }
  | { kind: 'blocked'; reasonCode: string; failedStepIds: string[] };
```

`proven` 只允许现有窄规则及补齐的证据条件；`needs_model` 不能直接 pass；`blocked` 表示当前不能确认完成，不必等价于产物已经损坏。暂复用现有非 pass verdict/Runtime reason 承载未知，不能新加 enum 值而漏改持久化与 UI。内部 reasonCode 不作为 Agent 自然语言发布。

精确写读规则的必要条件：可信的 builtin 工具来源；通过已授权工具服务产生的同 scope 目标；输入、完整输出与 callId/effect 对应；写入后读取同一产物版本，之后无未验证修改；目标明确要求的字节/文本确实匹配。路径标准化不是绕过 Main 的 realpath/链接审批；不能把“文件读回一致”泛化成程序功能正确。

只读快速规则必须限定目标为取得相应事实，并确认相关 callId 唯一、来源可信、结果成功且满足需要的完整性。若目标要求语义总结/推断，或搜索为 partial，不因调用成功免掉必要的模型判断。不要把“所有任务必须调用工具”变成新规则；respond 文本任务不受写入验证约束。

### 02B · 失败不漏发旧成功草稿

入口/范围：上述文件及 `harness/reply-state.ts`、`stages/finalize.ts`、Runner authoritative reply/失败结算的必要传播与测试。默认保留唯一最终结算机制，不在 VERIFY 发布第二份回复。

- verifier 失败后，旧的成功候选不得继续成为最终答案；按现有失败边界撤回预览/清理不合格候选，保留已发生工具/effect 证据。
- 有界 RECOVER 可以生成如实说明状态的 LLM 文案，但不能盲重做 unknown effect，也不能把 verifier 网络故障变成用户缺少需求。模型不可用时用 Runtime 错误，不用固定成功/失败模板冒充 Agent。
- 验证记录、最终 run 状态、记忆反馈和会话历史保持一致。保留合理的“部分完成/未验证”交付，不以简单清空所有信息损害连续性。

| 用例 | 构造 | 必须断言 |
| --- | --- | --- |
| HA-02-01 | write A 后 glob 无关 B | 不 structural pass；不存在假验证事实 |
| HA-02-02 | 错内容/错路径/同名插件工具/无关 effect callId | 不通过窄验证；插件名不能冒充 builtin |
| HA-02-03 | 写两文件只验证一个；读取后再写；结果截断 | 未覆盖变更不被判为全部完成 |
| HA-02-04 | 无 TaskBook，verifier timeout/非法 JSON | 不 degraded pass；不发布旧成功草稿 |
| HA-02-05 | 已失败/拒绝/unknown effect，verifier 强行返回 pass | Runtime 事实覆盖模型 pass；0 次未经授权重做 |
| HA-02-06 | 完整精确写读、窄只读查询 | 仍可结构通过且 0 次 verifier LLM；保持性能正例 |
| HA-02-07 | 需要语义验证的成功执行 | verifier 仍可按证据通过；不是一刀切全部 fail |
| HA-02-08 | 流式候选 → 验证失败 → 持久化/重启读取 | 最终历史不含原成功交付；失败/未知和工具证据保留 |

门禁：`pnpm exec vitest run packages/harness/src/stages/verify.test.ts packages/harness/src/stages/finalize.test.ts packages/harness/src/e2e.test.ts packages/harness/src/user-facing-reply.test.ts packages/runner/src/authoritative-reply.test.ts packages/runner/src/runner-persist.test.ts`；另加本包新 driver/Runner 负例，完成后 `pnpm run verify:core`。

## 5. HL-03：请求计时与完整用量

### 03A · 区分逻辑请求与真实传输尝试

入口/范围：`harness/model-observability.ts`、`model-observability-state.ts`、`stages/_shared.ts` 和所有 `callLlmForJson` 调用点；`llm/client.ts/types.ts/retry.ts`；types token ledger/durable projection 与 codecs。先用 `rg` 列完直接 `llm.chat/chatStream`、回调重复计费和 SDK 内重试，交付调用点清单。

固定身份与计时合同：

| 字段/概念 | 唯一语义 |
| --- | --- |
| requestId | 一次 prepared 逻辑请求；JSON 改写重试是新 requestId，通过 retryOf 关联 |
| transportAttempt | 同一 requestId 下单调递增的真实 HTTP 尝试；429 重试、连接重试、usage-option fallback 都计入 |
| usageKey | requestId + transportAttempt；同一次 usage 的流末/最终响应重复报告只计一次 |
| durationMs | 对应尝试 dispatch 到响应体/流结束的单调时钟耗时，不含重试 backoff、上下文构造或落盘等待 |
| requestElapsedMs | 整次逻辑调用耗时，可包含所有尝试/backoff；不能用来冒充纯生成时长 |
| TTFT | 本次尝试 dispatch 到首 content/reasoning/tool-args；细分三类；无 token 或非流式不可观察时为 unknown |
| providerReachStatus | dispatch 仅表示尝试发出，不证明服务器收到；按响应/传输事实区分 reached/not_reached/unknown |

实现方向：

1. `prepareModelRequest` 之前确定本次使用 chat 还是 stream，使 request snapshot、call contract 与真实 body 的 stream 一致。真实 body hash 与 prepared 模型输入 hash 若覆盖内容不同，分别标 scope；不谎称后者等于所有 HTTP headers/body。
2. JSON helper 增加一个可选请求执行回调（语义例如 `executeRequest(request): Promise<ChatResponse>`），调用 Harness 统一包装层；迁移原 `beforeRequest/onResponse/onError` 中重复生命周期职责。standalone helper 可继续默认 llm.chat，但不得既包装又重复回调计费/结算。
3. LlmClient 添加向后兼容的可选 transport observer 或等价内部接缝；由真正发请求的 client 报告 attempt，而非 Wrapper 猜。与必需的 started 持久化门分离：先等 durable request start，再允许网络。实际重试应可观测，但本包不另造第二套 Provider 重试策略。
4. 采集 prepare/start-wait/dispatch/first-chunk/end/parse/settle 的分段时间；进程内使用单调时钟，持久化 durations + 关联 ID，墙钟用于日志定位。不持久化可被跨进程误减的 performance.now 绝对值。
5. 每次请求 success/error/abort/无 usage 都闭合。不支持 transport observer 的旧 mock/外部 client 标 `coverage:unknown`，可以记录包装调用耗时，但不能编造 HTTP attempt/TTFT。
6. 失败尝试返回的有效 usage 仍计入已知消耗；无 usage 则标成本不完整，不能估出 tokens 补零。usage fallback 改变真实请求选项应留 attempt 级事实，不记录认证 header。

边界补充：attempt 级事件/usage 的幂等键必须包含 attempt，不能覆盖现有 request 级 started/received/settled。逻辑请求仍只闭合一次，attempt 失败不直接把仍在正常重试的整个 request 永久终结。旧 client 无 attempt 观测时，只保留一次明确标为 request-level 的已知 usage，不能同时作为 attempt usage 再加一次。

### 03B · 账本不依赖 64 份窗口

入口/范围：上述生命周期、`types/agent.ts` 的 RunUsage、`types/token-ledger.ts`、durable model usage projection/codec、Runner result/log、`app/shared/run-usage.ts`、live/result/history reducer 与页脚。

所有新字段向后兼容为可选，旧日志不凭空回填计时。建议复用 RunUsage 增补以下语义，具体嵌套形式在包开始时固定，禁止中途让 Main 与 Renderer 各自定义一套：

- observedRequestCount / observedAttemptCount / usageReportedCount。
- usageCompleteness：complete / partial / unknown；cache、timing 各自报告覆盖数，不能混成一个布尔值。
- 每 provider/model 的已知 usage 小计，以及 matching-timed-set 的 completionTokens/durationMs/attemptCount。
- legacy fallback 的来源标志：旧快照求和属于 partial/legacy，不能与新累计账本重复相加。

数据流固定为：**客户端事实 → Harness 一次接纳/去重 → 既有 durable usage 事件与紧凑累计值 → Runner 结果/日志 → UI 格式化**。诊断快照仅是展示窗口。若接纳失败，保留可恢复事实，不独立维护第二个无对账的计数源。

具体约束：

1. usage 在附加快照前进入账本；窗口已经淘汰该 request 时仍能依靠生命周期身份记录。不能通过提高快照数量解决。durable projection 目前未完整携带 cacheWrite/duration 等字段，传播时补 codec/旧记录读取，不只改 TS interface。
2. 重复 response callback、重复 durable replay 或 UI result 不重复累计；同一 key 的不同 usage 不静默选最后一个，应标冲突/不完整，保留诊断原因。一次已知 usage 的扩充更新不能再次加全部数值。
3. 最终回复引用的请求 provenance 不能随窗口淘汰而失效；保持必要紧凑身份或通过既有权威记录查证，不保存无界原始 prompt 来解决。
4. 缓存字段缺失显示“未提供/部分请求未提供”；真实 0 才显示 0。部分覆盖时可以显示有标注的小计，不把剩余输入全部算作未缓存。cacheWrite 不加入 prompt/output 总和；reasoning 是 completion 的子集，不重复加。
5. 同 provider/model 且计时和 usage 都完整时，`tok/s = ΣcompletionTokens / (ΣdurationMs / 1000)`；它是包含该尝试首 token 等待的平均输出率，不称解码速度。并发请求时 duration 求和不是 run 墙钟。
6. 数据部分计时：默认页脚隐藏单一 TPS，可在详情展示 matching set 速度及覆盖数。多模型分别展示，不用一个 modelRef 归属全部输出；零时长/NaN/负数不得 Infinity 或伪精确零速度。

| 用例 | 固定数据/故障 | 预期 |
| --- | --- | --- |
| HA-03-01 | chat/stream/JSON 三种相同假时钟延迟 | 统一门禁与计时；JSON 也报告 duration，无双倍 usage |
| HA-03-02 | HTTP 429 → 成功；JSON 无效 → 新请求；usage fallback | 逻辑请求/attempt/retryOf 数量分别正确，旧流不污染新流 |
| HA-03-03 | 1000 输出未计时 + 100 输出计时 1 s | 总已知输出 1100，timing partial；页脚不得显示 1100 tok/s |
| HA-03-04 | 65+ 请求，每次有已知 usage，首请求延迟回报 | 窗口有界；累计和正确；早期/最终 provenance 可验证 |
| HA-03-05 | usage 重复回调/重放；相同 key 冲突 | 同值仅一次；冲突显式不完整，不重复加 |
| HA-03-06 | cache 缺失、真实 0、混合模型、reasoning 子集 | 未知不补零；分类对账；无重复推理计数 |
| HA-03-07 | dispatch 前 abort、流中断、无 usage、clock 回拨 | 每个已准备请求有终态；不编造 Provider 已收到/TTFT/tokens |
| HA-03-08 | 无新字段的旧会话/日志 | 可读且标 partial/unknown；不覆盖新账本或 double count |

门禁：`pnpm exec vitest run packages/harness/src/model-observability.test.ts packages/harness/src/model-observability-state.test.ts packages/harness/src/stages/_shared.test.ts packages/harness/src/cache-provider-usage-reconciliation.test.ts packages/llm/src/client.test.ts packages/harness/src/durable-kernel.test.ts packages/runner/src/runner-persist.test.ts packages/app/src/shared/run-usage.test.ts packages/app/src/renderer/chat/run-result-reducer.test.ts packages/app/src/shared/history-activity.test.ts`；加入新增 attempt/aggregate/codec tests，完成后 `pnpm run verify:core`。

## 6. HL-04：流式与前端归并

### 04A · 增量、快照、重置各自只有一种含义

入口/范围：`llm/types.ts`、`harness/stages/execute/model-transcript.ts`、`execute/tool-loop.ts`、`stages/reply.ts`、`types/agent.ts` 的 ToolStreamEvent、API SSE、`renderer/api/run.ts`、`chat/run-event-handlers.ts`/types/activity-model、历史投影。

最小接口方向：在既有 ToolStreamEvent 上增量扩展流关联信息，不重写全部工具事件。新模型文本 producer 必须提供等价于以下的合同；字段命名在 04A 开始时冻结并列出所有消费者：

```ts
// 待实现；可作为既有事件上的 streamRef，不是第二套事件总线。
type TranscriptStreamRef = {
  version: 1;
  runId: string;
  requestId: string;
  transportAttempt: number;
  sequence: number;
  operation: 'append' | 'replace' | 'reset';
};
```

- `phaseId` 标识该尝试中的具体行；row key 必须包含 run/request/attempt/phase，不能只用 `execute:turn-1`。sequence 在该 request/attempt 的发送序列内单调；快照补全须带覆盖水位。
- attempt 和 sequence 均从 1 开始。重试先闭合/重置旧 attempt，再开启新 attempt；旧事件不跨 attempt 合并。节流应在对外 sequence 编号前完成；若必须合并已编号事件，需携带覆盖范围，不能让正常合并被 reducer 误判为丢包。这里的 sequence 仅覆盖该模型 transcript 流，不与未订阅的内部 durable 事件共用编号。
- `model_reasoning`：新运行中的 summary 是 append 真增量；完成可用 replace 全文。REPLY 不再发送累计尾段冒充 delta。Runtime 阶段名/参数计数不是 model_reasoning。
- 新 `tool_preparing` 事件为 snapshot，带 tool index、可选完整 name/callId、累计 `receivedCharacters`、生成状态；用“字符”明确 `.length` 口径，若显示字节需独立 UTF-8 计数。累积小片段不逐条追加为新行。
- Runtime 准备/规划/验证/结算沿既有 `reasoning` 或明确 Runtime 状态投影，属于 snapshot；发生请求前不伪造 requestId/模型 token。
- reset 以尝试为 scope，清正文预览、对应思考/参数准备缓冲和帧队列；保留先前真正执行的工具事实。协议内容重分类不能复用“整个请求失败重试”的 reset 语义。
- done/failed/aborted 都闭合活动行；`tool_start` 仍只由工具执行服务发送。生成完参数到审批/开始之间，不显示“正在执行”；缺真实工具事件不创建成功工具计数。
- 新版本流不再发无 operation 的含混模型事件；旧历史只走一次兼容投影，不强行推断缺失的 delta/attempt。API 的事件白名单及 runtime parser 必须同步接入，避免后端发了但 Renderer 静默丢弃。

归并规则：

| 输入 | 行为 |
| --- | --- |
| 新 request/attempt | 新行空间，不复用前次缓冲 |
| append | 只追加本次增量；重复序号忽略 |
| replace/snapshot | 覆盖该行，不追加累计摘要 |
| reset | 清该尝试未结算显示及 pending delta；旧片段晚到不得复活 |
| done/failed/aborted | 闭合；晚到旧 running 不反转终态 |
| 序号缺口 | 明确标 incomplete/等待权威快照；不能静默把缺口文本当完整 |
| run/result 权威完成 | 先 flush/clear 当前帧队列，再按已结算结果归并一次 |

传输在同一 SSE 连接内有序，但重连、异步回调和 UI 切会话仍需身份验证；此包不擅自建立无限内存重放缓冲或新增可靠消息总线。

### 04B · 正文、提示词、状态与 SVG

正文：`execute/final-reply.ts` 的汇总请求也接入统一流式预览；工具循环、REPLY、必要文案改写共用闭合规则。JSON 规划/验证不原样流到正文，只显示真实 Runtime 状态。完整最终候选仍经校验、文案登记与 FINALIZE/Runner 唯一结算；不多生成一份“为了流式而写的回答”。

闭合实现检查：把 stop、exception、cancel、引用修复 continue、force-final 等所有出口列成表，保证每个已开始的 transcript 在 finally 或等价唯一收口中终止。终止原因保留，不能一律标 done。正文 preview → 过程消息归属变化只做同回合移动/归并，不重复向会话发布相同文案。

提示词：一 run 一个可折叠顶层“系统提示词”行；按实际请求版本展开，默认指向第一个实际派发请求，并标 request/purpose。数据从最终 prepared request 取，不从提前 assemble 的基础 prompt 取。Runtime/working set 注入改变时保留对应版本。长全文按需加载或复用本地受控投影引用，不每个 token 重发；无法完整保存时明确 unavailable/truncated，不能称全文。只展示 LS 自身授权内容，不外发密钥或跨 session/scope 内容。

界面范围：复用 `renderer/ui/icons.tsx` 与 `agent-tool-row.tsx` 现有 SVG；补系统/思考/上下文/准备/工具及历史 fallback 的残留文字/emoji 图标。Input/Output 两区；Running、待批准、失败、取消不混淆；Normal/Compact 仅影响完成轮次的披露，错误和权限事项始终可见。这里不更改应用整体视觉风格。

渲染负载：复用 `assistant-delta-buffer.ts`，正文/思考/参数进度按帧或有界间隔批量更新，首个有效事件立即可见；保留已有文本/行数上限并显式标截断。不能向浏览器逐帧发送整份工具 JSON，不能累积 100,000 个 UI 事件对象后才处理。

| 用例 | 固定分片/状态 | 必须断言 |
| --- | --- | --- |
| HA-04-01 | 思考 append“先看”/“目录”，完成 replace“先看目录” | 只出现“先看目录”，无累计尾段重复 |
| HA-04-02 | 准备 snapshot 10→20→30 字符 | 一行最终 30；不拼成三句，不算三次工具调用 |
| HA-04-03 | 两工具交错、函数名分片、审批等待 | 各自正确计数/名字；审批前不出现实际执行时长 |
| HA-04-04 | reset/error/abort/stop/citation-repair 各出口 | 缓冲与终态正确，无永久 Running、旧尝试复活 |
| HA-04-05 | TaskBook 最终汇总分段，结束前暂停假 Provider | 完成前 DOM 已有前半正文；settlement 后不重复正文 |
| HA-04-06 | prepare 前基础 prompt 与 dispatch 前完整 prompt 不同 | 展示对应实际请求；一顶层行；错误提示词版本不冒充实际 |
| HA-04-07 | SSE 新事件类型、重复/晚到/跨 run 事件、result 前仍有帧队列 | 不丢新类型，不污染另一会话、不回滚终态 |
| HA-04-08 | Normal/Compact、实时→历史、重连、失败/拒绝 | 同一事实/计数；必要异常可见；全部目标图标为 SVG |
| HA-04-09 | 100,000 小分片/Unicode/长参数 | 文本正确或明确截断，状态有界，无超线性累计重扫 |

定向门：`pnpm exec vitest run packages/harness/src/stages/execute.test.ts packages/harness/src/stages/reply.test.ts packages/harness/src/stages/execute/final-reply.test.ts packages/app/src/renderer/chat/run-event-handlers.test.ts packages/app/src/renderer/chat/run-actions.test.ts packages/app/src/renderer/chat/run-result-reducer.test.ts packages/app/src/renderer/chat/assistant-turn.test.ts packages/app/src/renderer/api/run.test.ts packages/app/src/main/local-app-api/run-routes.test.ts packages/app/src/main/run-stream-api.test.ts packages/app/src/shared/history-activity.test.ts packages/app/src/renderer/ui/icons.test.ts`。补新的 model-transcript/SVG fallback 与生产路由夹具；`pnpm run verify:core` 通过后再做真实渲染验收。

## 7. 本批性能夹具与交付门

### 7.1 用延迟注入代替主观截图

在隔离环境将可控假 Provider 挂到实际 Runner/API/Electron 渲染链路，不用生产密钥。复用现有 verified-electron 脚本入口；如需新脚本，限制为本批测试，不加入生产依赖。

固定场景：请求接收后延迟 2 s 发首模型事件；每 50 ms 发分片；中途工具参数保持生成状态 2 s；最后正文发送一半后暂停 2 s；再完成验证/结算。每个停顿都通过可控 latch/假时钟和 DOM 断言确认“尚未完成时已经显示”，不能仅看全部执行后的截图。不得把假的状态文案注入生产。

记录：发送→本地占位，API start→Renderer 接收，request dispatch→首事件，Renderer 接收→paint，工具准备→真实 start，候选末 token→可靠 done。每进程单调计时；跨进程没有校准时只报告各自分段，不能直接相减伪造延迟。

目标沿用总任务书：受控热环境本地首反馈 P95 ≤ 200 ms，收到可展示增量后绘制 P95 ≤ 100 ms。先记录样本数/机器/负载；不够样本则只报功能验证，不宣布 P95 达标。JSON/真实工具耗时不计为 Renderer 处理延迟。

100,000 分片压测测 25k/50k/100k 的处理时间与峰值状态，观察增长趋势和截断策略；允许回传有界进度，最终执行输入必须保持完整。不得为通过压测删除关键文字或降低工具内容精度。

### 7.2 完成条件

- 每包定向门、必要新增负例、类型检查通过；公共 Harness/Runner/Context/Memory/事件契约按 `verify:core`，第一批候选再跑 `pnpm run verify:full`。
- 需要桌面验证的包执行标准构建并 `pnpm run assert:app-build`；记录实际运行进程身份与受控流式渲染证据。
- 01/02 包提供两驱动与 Runner 终态证据；03 包提供 attempt/usage/回放对账；04 包提供完成前 DOM/绘制证据。仅 mock stage 通过不算跨层验收。
- 若发现基线已有无关失败，写出命令、失败路径和为何与本包无关；可以交付局部结果，但不能标全部验收通过或删除失败测试。
- 本批正确性修复可能暂时让过去误免验证的任务多一次 verifier 调用；如实报告，这是恢复原质量底线，不称提速。真正消除冗余调用仍依赖 HL-05/06。
- 真实 Provider 配对性能与完整恢复矩阵属于 HL-12/HL-10；本批不宣称发布 ready，也不自动切默认/重启用户应用。

## 8. 接手提示词与每包报告模板

将以下模板交给执行模型，并把“小包 ID”替换成当次唯一范围：

```text
在当前 LittleSheep 工作树实施小包 <ID>。
先读 AGENTS.md、docs/taskbooks/harness-lean-audit-taskbook-2026-09-12.md 的相关发现，
以及 docs/taskbooks/harness-lean-phase-a-implementation-taskbook-2026-09-12.md 的通用约束和该包全文。
核实前置包的产物和验收证据；没有前置结果就先说明缺口，不假定已完成。
读取目标文件当前实现与测试，记录已有改动，禁止覆盖其他工作。
先把该包负例变成稳定失败测试，再做必要实现，运行定向门及要求的公共契约门。
不得扩大轻量准入、改默认推理/权限、引入新状态机、后台学习平台或顺手重构其他包。
如果规格与当前代码冲突，报告具体接口/用例；不能靠放宽断言或新增旁路求通过。
完成后按本文件的报告模板交付，停在该包边界，不自动执行下一包。
```

每包交付：

1. 小包 ID、开始/结束源码身份、实际修改文件和范围；所有新测试路径。
2. 根因 → 具体改变 → 哪条旧契约保持不变；必要接口/字段及所有消费者清单。
3. 每条 HA 用例修复前失败点、修复后结果；命令、退出码、报告位置。
4. 工具/模型尝试数、已知 usage 与 completeness、终态等关键断言，不只报测试总数。
5. 构建/实际 UI 验证状态；未做明确写未做。
6. 已知限制、前置包影响、下一包可使用的接口；是否需要更强模型审查的具体问题。

升级审查条件：需要改变用户授权或最后一次成功判定、无法用现有事实恢复 effect、需要迁移旧 durable 格式而不能兼容读取、需要重复发布/修改回复注册规则、压缩/记忆范围被意外牵入、同一验收失败连续局部尝试仍无根因。暂停扩大修改并给出证据，不以增加思考轮次或继续补丁掩盖未确定的合同。

本次文档交付仅完成施工规格。上述小包、接口、回归新增和性能门均待实施；后续按包更新状态与证据，不能将文档存在视作代码完成。
