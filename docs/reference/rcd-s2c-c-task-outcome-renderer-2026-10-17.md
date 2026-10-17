# RCD S2C-C — Task Outcome 可信成果展示与交付

**日期：** 2026-10-17

**分支：** `codex/rcd-s2c-c`

**S2C-B 基线：** `47a21bf0b6e6b204a2bfa7d06c87e12e0bbb28ad`
**性质：** Renderer / API 消费、窄范围运行时集成和 Electron 验收

## 结论

用户现在可以在任务回复附近区分 Runtime 执行状态、逐项要求检查、已记录文件操作和剩余工作。Renderer 从 Runner 对 Durable Task Outcome 的权威回放读取结构化结果；它不依据最终回复、Run 完成状态或工具成功状态推断要求通过。

真实 Electron Main/Runner 与本地确定性 Provider 的三类文件场景通过：正确文件经 Runtime 检查后显示 `passed`，错误内容显示 `failed`，只有写入而没有独立检查时显示 `unverified`。普通聊天不会出现空结果面板。历史重载后每个 Run 只显示一个 Outcome 卡片。

本批没有开始 S2C-D/E 或 S3，也没有合并或推送。

## 数据来源与展示行为

- Runner 在直播结果和历史 ExecutionLog 回放时读取同一 Run 的 Durable Task Outcome。Projection 与 ExecutionLog 不一致、回放失败或旧 Run 缺少记录时保守返回 `unknown`，不回填 `passed`。
- 只有终态活动显示结果卡片。执行结束、要求验收和整体 Outcome 分开呈现；取消、阻断、失败、未验证和部分完成保留各自语义。
- 逐项要求可展开查看来源类型、检查结果、可信证据引用和原因。界面展示工作区内相对路径与短摘要，不展示绝对路径、正文、Memory 或工具输出；打开文件仍走现有工作区文件访问入口。
- 已有文件变更卡片改称“文件操作记录”，调用成功文案不再暗示产物已验收。旧 Run 缺少 Outcome 时，仅在有已确认写入/编辑事实的任务中提示“缺少验收记录”。
- 旧证据无法解析或当前无法确认时不沿用历史通过状态。模型最终回复保持原样，结构化结果作为单独的可信事实展示。

## 最小运行时集成调整

真实 Electron 验收暴露出两项 S2C-B 接入问题，本批作了窄范围修正：

1. S2C-B 文件内容检查器是 Runtime 生成的只读工具。之前审批分类把它当作未知外部工具。现在可信工具闭包通过 WeakMap 绑定固定目标路径；`ToolExecutionService` 只把这个固定目标按原生 `read` 访问分类，并继续执行既有真实路径检查和 Permission V2 校验。模型不能提交目标路径，也不能借此扩大授权。
2. 英文明确文件要求句尾的 ASCII 句点曾被误纳入要求内容（`hello.`）。解析器现在容许句末标点，并新增回归用例。

这两项修正用于让已定义的可信检查链路在真实 Runner/Tools 路径工作；没有增加验证引擎、模型审阅循环、工具权限或第二套 Harness。

## 验收结果

### 真实 Electron Renderer

`pnpm run verify:task-outcome-renderer` 通过，报告：

`%TEMP%\ls-task-outcome-renderer-Mrv1Xs\report.json`

截图：

`%TEMP%\ls-task-outcome-renderer-Mrv1Xs\task-outcome-renderer.png`

该验收使用 Electron 44.4.5、真实 Main/Runner、真实 workspace Tools 和本地受控 HTTP Provider。三项独立任务的事实如下：

| 场景 | 工具事实 | 独立检查 | UI / Outcome |
|---|---|---|---|
| `s2cc-passed.txt`，要求内容为 `hello` | 写入成功 | Runtime 读取实际文件并比对成功 | Requirement `passed`；展示相对路径及检查时文件版本摘要 |
| `s2cc-failed.txt`，要求内容为 `hello` | 写入成功；实际写入 `goodbye` | Runtime 读取实际文件并比对失败 | Requirement `failed`；显示“文件内容与要求不一致”，整体不能显示完成 |
| `s2cc-unchecked.txt`，要求内容为 `hello` | 写入成功 | 没有执行独立检查 | Requirement `unverified`；显示“尚未执行独立检查” |

另验证了展开证据不暴露临时工作区绝对路径，普通聊天没有空 Outcome 卡片，同一 Electron Renderer 重载后持久回放仍为每个 Run 展示唯一结果。

**执行层级限制：** Electron 中的 Main/Runner/Tools 路径是真实产品代码；模型响应由本地确定性夹具提供，不能证明真实 Provider 的任务理解质量。Renderer 通过 CDP DOM 事件驱动，不是物理鼠标或辅助设备验收。检查能力仅覆盖明确、单一、工作区根目录文本文件要求。截图反映验收结束时的未验证场景；通过/失败场景另由同一报告的 DOM Oracle 和真实工具记录验证。

构建使用 Electron 44.4.5，`ensure:app-build` 结果为 `built`，输入摘要 `85e3b1397e859a71f28952ccae35715dddb2c694c527275a42228638c70faefe`，输出摘要 `fcda5bbe488a41af89433ccccf93982c2216707796ebbc1b2976fcafb92d26a8`。

### RCD 冻结核心回归

`node scripts/rcd-s0.mjs run --core --timeout-ms=120000` 完成 6/6，基础设施状态为 executed 6、blocked 0、harness error 0、not run 0。结果：

| 场景 | 结果 |
|---|---|
| C02 | passed |
| C08 | passed（保留原冻结语义） |
| R01 | passed |
| R02 | correctly_blocked |
| L01 | partially_completed（仍为 30/35） |
| X01 | correctly_blocked（受控异常注入，不是 OS 进程崩溃） |

R02 使用允许/禁止联网配对夹具：允许分支只访问 loopback；禁止分支网络请求数为零。所有场景均尝试清理并成功，无残留。该账本中 usage/cost unavailable。

机器账本：`%TEMP%\littlesheep-rcd-s0-evidence\rcd-s0b-1792208313640.json`。其源 HEAD 为 S2C-B `47a21bf0…`，执行时工作树指纹为 `82ceff29b04b4eb99657633f0b69214a93f5d99291cbeef40d472380cb172a0b`。该账本维持历史冻结，不覆盖 S0-F 报告。

### 自动化回归

- Task Outcome、Runner durable replay、VRS Evidence Settlement/FINALIZE、S2B 段恢复、聊天/历史/产物卡片与 Permission V2 文件边界的定向回归：17 个测试文件、186 项通过。
- 最终修改后的重点重跑：7 个测试文件、97 项通过。
- TypeScript 类型检查：通过。
- `check:repo`：35 项通过、0 失败；报告 3 类既有 advisory（源码热点计数提示），不是本批新增错误。
- `git diff --check` 与接受脚本 `node --check`：通过。
- 真实 Electron 任务结果脚本：3/3 场景通过。

自动化覆盖了 FINALIZE/Evidence Settlement 和同 Run 段恢复的定向测试。此批未重跑所有真实 Provider、跨平台发布、物理 Renderer 交互或任意崩溃窗口验收。

## 分支与改动边界

实施前主工作区为干净状态，主线 HEAD 为 `a6ca3da1d45120658e5328b5d62e69a690a1562d`；S2C-B 分支为 `47a21bf0…`，二者共同祖先为 `d2c5b3d2…`。主线有一项独立的 Renderer 提交；本批在 `codex/rcd-s2c-c` 隔离分支继续，没有覆盖主线。

后续集成时需要重点检查双方同时修改的 `package.json`、`packages/app/src/renderer/app-shell/chat-view.tsx`、`packages/app/src/renderer/chat/assistant-turn.tsx`。本报告不代表已完成合并或解决这些文件的后续冲突。

## 仍未完成的验收

- 尚未覆盖完整的自然语言要求识别；inventory 不完整时必须继续保守显示。
- 没有通用文件格式或通用任务 Oracle。
- 没有物理输入设备/可访问性设备的真实 Renderer 操作测试。
- 没有真实付费 Provider、所有平台打包或发布验收。
- S2C-D/E 的额外恢复故障窗口和交付冻结仍未执行。

## 本次变更

包含可信 Task Outcome 的直播/历史消费、结果卡片及证据展开、文件操作文案澄清、主进程只读 API、必要的文件检查接入、定向测试、真实 Electron 验收脚本和本报告/账本。
