# LittleSheep 项目状态

最后更新：2026-09-21 16:45:00

**修复方案的收益上限被算出：只修辅助路径达不到 95%（2026-09-21 16:45:00，同轮内更正一处误判）**

本轮先把修复的**收益上限**算出来，结论**推翻了我上一轮的建议**；同一轮内又**否证了自己刚提出的一个"新发现"**。

- **按形态分组的实测**（工具工作场景 18 请求）：主循环（12 工具）12 次 **94.42%**；冷启动 2 次 51.35%；零工具（强制收尾）2 次 75.76%；零工具（`ask_user`）2 次 41.09%；**稳态合计 91.996%**。
- **关键结论**：4 个零工具请求合计 5,470 输入 / 3,712 缓存（67.86%）。**即使它们完全达到主循环的 94.42%，稳态也只能到 94.418%——仍低于 95%。** 因此**主循环自身的 94.42% 才是约束**；修辅助路径仍正确（消除前缀不一致），但**不足以达标**。上一轮"修好辅助路径即可"的判断已更正。
- **同轮内否证的误判**：我曾据"12 工具请求出现两个 `toolSchema` 哈希"推断某工具描述可变，并定位到 `use_skill.ts` 的描述 getter。复核后发现两个哈希与**两个会话严格一一对应**（`034e96da→8ff283bb`、`a4d19cd8→3a8d13df`，各 7 次），**每个会话内只有一个哈希**，即工具 schema 在会话内完全稳定。跨会话不同是因为 `componentFingerprint` 把 **scope token 混入了摘要**（`hmac(key, domain\0scopeToken\0value)`），所以 **component 指纹不能跨会话比较**；"0 工具"两个哈希不同亦同此因。
- **附带确认**：生产代码的失效判定**正确**——`resolveInvalidationReasons` 对 `toolSchema` 的比较带 `sameScope` 守卫，不会产生假阳性；错的是我跨会话比较指纹的做法。教训已记入文档：比较任何 component 指纹前必须先确认同一 scope。
- **修正后的判断**：要让工具工作等场景跨过 95%，需处理 ① 辅助路径前缀不一致（已确认），并可能需 ② 短会话下 prompt 偏小（该场景主循环平均 prompt 仅约 4,541，`hit ≈ 1 − 192/prompt`）。两者都不属纯测量。
- 验证：仓库卫生 **33 passed / 0 failed**；相关提交已推送。



**完全访问策略下补齐"写后读回"与"重启不重复执行"两项验收，均通过（2026-09-21 16:40:00）**

5.23/5.25 曾如实记录两项语义验收**因策略限制无法验证**：研究策略下 `write` 始终 `approval_denied`，从未产生副作用。本轮新增 `LITTLESHEEP_COMPARISON_FULL_ACCESS=1`（在 `/run` 请求体传 `permissionMode: 'full'`，只作用于隔离的临时数据根）把两项补齐。

- **① 写后读回：通过 ✅**。工具序列 `write:succeeded,read:succeeded`；shadow 与 next **两条路径的工作区都出现 `notes.md`**，内容均为 `cache-probe-ok`；模型回复自述"写回确认与写入内容一致"。
- **② 重启不重复执行：通过 ✅**。全负载**成功写入恰好 1 次**；重启后的 4 个 run **无任何写入重放**；工作区仍为 4 个文件无重复产物；工具执行计数**两条路径完全一致**（`{read:2, write:1, glob:2, grep:1}`），既证明恢复不重放已完成副作用，也证明两路径行为未发散。
- **该组合的缓存读数**：稳态 94.966%（13 请求）——差 0.034 个百分点未达红线；冷启动 5.896% 单列；总体 88.903%。
- **任务验收现状**：方案第 6 节"保留范围的任务验收"中，**正确读取、写后读回、拒绝时零副作用、重启不重复执行**四项均已取得真实验证。剩余缺口集中在**缓存命中率**一项（三个不达标场景）。
- **顺带修复的文档缺陷**：`cache-95-acceptance.md` 中 `## 6. 完成条件` 出现**两次**（一次被我的历史编辑误插在 5.12 之前），已合并为末尾唯一一处；文中旧的三行状态表（已被 5.21/5.25 取代）一并清理。各 5.x 小节为**追加顺序**编号（5.10 在 5.9 之前），因任务书与状态日志按编号引用（5.19–5.23、3.1），**不做重编号**以免产生死引用。
- 验证：`node --check` 通过；仓库卫生 **33 passed / 0 failed**；提交 `c6dd4d3` 已推送。

**接入重启场景：5 个必需场景已全部测量（2026-09-21 16:35:00）**

方案第 5 条要求"重启"场景单独报告，此前夹具**完全没有该场景**；本轮补建并实测。

- **夹具**：新增 `LITTLESHEEP_COMPARISON_RESTART=1`——负载进行到一半时停掉两条路径的 app 进程，用同一数据根重新拉起，并**在同一会话**继续跑完；抽出 `launchApp()`/`stopApp()` 共用。两个关键细节：**重启前必须删掉 locator 文件**（否则 `waitForLocator` 立刻返回旧 locator、指向已关闭的端口）；`RESTART` **默认蕴含共享会话**（否则每轮各开新会话，重启只等于重新开始）。报告新增 `scenario` 与 `restarts` 字段。
- **实测**（`RESTART=1` + `TOOL_WORK=1`）：稳态 **89.872%** ❌ 未达红线；冷启动 5.877%（单列）；总体 83.328%。
- **结构性正面结果**：重启**确实发生在中途**（`restarts[0].atRound=1`），两条路径都在**同一会话**内延续；重启后 8 个 run **全部 200**；时间线显示断点（round 0 在 08:29:51–08:30:05，round 1 在 08:30:10 之后）；round 1 仍出现 `write:approval_denied`，说明恢复后权限判定未被绕过。
- **两项局限（如实记录）**：① **"重启不重复执行"未获语义验证**——该验收需要一次成功产生副作用再确认不被重放，但研究策略下 `write` 始终被拒，**从未产生副作用**，故本轮只验证"重启后能继续工作"；② **round 1 多数未再调用工具**（3 个 run 无工具调用），因为共享会话里 round 0 已答过的任务直接据上下文作答，属合理行为但使重启轮次对工具工作覆盖偏弱。
- **5 个必需场景已全部测量**：

| 场景 | 稳态命中率 | 红线 |
| --- | ---: | --- |
| 普通短对话 | 95.740% | 达成 |
| 共享会话（长会话，本仓追加） | 96.158% | 达成 |
| 连续工具工作 | 91.996% | 未达成 |
| 压缩 | 54.808% | 未达成 |
| 重启（+工具工作） | 89.872% | 未达成 |

- **结论**：2 个达标、3 个不达标；不达标的共同机制是辅助/强制路径（`ask_user`、`session_compaction`、`forceFinalResponse`）与主循环前缀互不通用。**方案整体未完成**（红线未覆盖全部场景，且"写后读回""重启不重复执行"两项语义验收因策略限制未验证）。
- 验证：`node --check` 通过；仓库卫生 **33 passed / 0 failed**；提交 `1e2605f` 已推送。

**修复"稳定前缀随会话增长而变"的测量缺陷，并更正上一条对其影响的判断（2026-09-21 16:30:00）**

- **定性更正（重要）**：上一轮（16:17 条目）把工具工作场景里 14,487 / 14,488 的 1 字节前缀差异列为"影响缓存的机制之一"，**这是不准确的**。复现后确认 `stablePrefix.fingerprint`/`byteLength` 是**本仓自有的诊断投影**，Provider 看不到它，只按真实请求字节计费——因此该差异**不造成 Provider 缓存损失**，实测命中率与之无关。
- **真实成因**：`splitRequestForCache` 把每条 stable 消息的**绝对数组下标**一并序列化进 stable 前缀；会话变长时下标跨越位数（9→10、11→12），序列化长度+1。合成复现：消息数 5/7/9 → 6,641 字节，11 → 6,642，13 → 6,643，**内容完全相同**。真实数据吻合：各分组稳定区逐字节相同（`stableChars=5409`、`markerAt=5411`、`projLen=8674`），仅消息条数不同。
- **修复**：stable 条目改用**相对下标**而非绝对下标；`STABLE_PREFIX_VERSION` 升为 `StablePrefixV2`。修复后消息数 5–13 的 `byteLength` 恒为 6,641、`fingerprint` 恒为 `ee51add897dd000f`。
- **回归护栏（已证明有效）**：`cache-observability.test.ts` 新增"会话增长不得改变 stable 前缀身份"用例。首次编写时**该用例在旧代码上也通过**（当时只在末尾追加 user/assistant 消息，stable 下标恒为 {0,1}，未复现缺陷）；改为末尾追加 runtime system 消息后，用 `git stash` 在修复前代码上验证**确实失败**（`expected 2 to be 1`），修复后通过。此处记录该反复，以免把空测当护栏。
- **影响范围**：仅诊断保真度（`invalidationReasons` 可能被这条无谓差异污染），**不改变运行时缓存行为**。属方案 P0"测量修正，不计缓存收益"。
- **工具工作场景的真实成因收敛为两条**：`forceFinalResponse` 丢掉整个工具清单（`tools: undefined`）、`ask_user` 使用独立的小系统提示。二者均属改变请求构造的架构改动，仍待授权。
- 验证：`pnpm run typecheck` 通过；全仓 **444/445 文件、3,087 项通过、1 skipped**（唯一失败为既有沙箱问题）；仓库卫生 **33 passed / 0 failed**；提交 `8e25ebd` 已推送。

**接入"连续工具工作"场景：实测 91.996% 不达标，但确认了拒绝零副作用（2026-09-21 16:20:00）**

方案第 5 条要求"连续工具工作"单独报告，但原冻结任务集 20 条里 14 条写着"不要调用任何工具"、实测 0 次工具调用，该场景此前无法覆盖。本轮为其建成夹具并实测。

- **夹具**：新增独立 `TOOL_TASKS`（读文件、写后读回、列 `.md`、grep 搜索）与 `LITTLESHEEP_COMPARISON_TOOL_WORK=1`；预置 `seed.txt`/`alpha.md`/`beta.md`。用**独立任务集**以免破坏原对话集的冻结基线可比性。顺带移除该脚本中残留的、我已在第 29 轮删除的配置键 `durableHarnessMode`。
- **实测**（2 轮 × 4 任务 = 8 run / 18 请求）：稳态 **91.996%**（16 请求）❌ 未达红线；冷启动 51.353%（单独记录）；总体 86.834%。
- 分用途：`execute_tool_loop` 16 次 87.68%；`ask_user` 2 次 41.09%。
- **功能层面的正面结果**：8 个 run **全部真的调用了工具**（read/glob/grep/write），平均 2.25 次模型请求/run，工具循环与多轮请求链路确实在工作；读、列目录、grep 三类任务正常完成；**"拒绝时零副作用"验收通过**——写任务在研究策略下被 `approval_denied`，随后转 `ask_user`，隔离工作区在 shadow 与 next **两条路径上都只有预置的 3 个文件，`notes.md` 未被创建**。
- **缺口**：① 稳态 91.996% 未达红线，机制与 5.22 压缩场景**同类**——辅助调用（`ask_user`）与主循环的 `request_kind`/`tool_schema` 不同，交错时使前缀失效；② **"写后读回"未验证**，研究策略下写被拒，需在完全访问策略下另跑一次。
- **场景覆盖现状**：普通短对话 ✅95.740%｜共享长会话 ✅96.158%｜**连续工具工作 ❌91.996%**｜**压缩 ❌54.808%**｜**重启 ❌未测**（夹具尚无此场景）。**5 个中 2 达成、2 不达标、1 未测；方案整体未完成。**
- 验证：`node --check` 通过；仓库卫生 **33 passed / 0 failed**；提交 `46d8556` 已推送。

**补齐场景覆盖：修复审计漏计压缩调用的缺陷，并发现压缩场景不达标（2026-09-21 16:15:00）**

按方案第 5 条补测缺失场景时，发现**一个测量工具缺陷**和**一个真实能力缺口**。

- **缺陷（已修复）**：审计脚本只统计 `execution-logs` 里的请求，而**压缩在独立分离上下文中执行、不进 run 的 `modelRequests`**。压缩场景的数据根有 100 个 `cache-observations`，脚本只算了 40 个，**漏计 60 个压缩调用与 61,872 input tokens**——直接违反方案"所有模型用途、重试、**压缩调用进入总账**"的规则。修复：读取 `cache-observations`，把日志中未出现的调用按 `requestKind` 折入总账并计入稳态，同时在 `observationReconciliation` 与 `usage cross-check` 显式报告差额。回归确认：无压缩的两个场景数值**完全不变**（95.740% / 96.158%），证明只补入缺失调用。
- **压缩场景不达标（真实缺口，未修复）**：`LITTLESHEEP_COMPARISON_COMPACTION=1`，2 轮 × 20 任务 → 稳态 **54.808%**（98 请求），总体 54.643%（100 请求）。
  - 分用途：`session_compaction` 60 次 **67.029%**；`execute_tool_loop` 40 次 **50.574%**。
  - **最关键对比**：同一实现、同一任务集，**未开压缩时主循环 95.740%，开启压缩后跌到 50.574%** —— 压缩把主循环命中率砍掉近一半。
  - 机制（由 `invalidationReasons` 直接读出）：请求在 `execute_tool_loop` 与 `session_compaction` 之间交替，两者 `request_kind` 与 `tool_schema` 不同，每次交替触发 `request_kind_changed` + `tool_schema_changed`；另有 25 次主循环被 `summary_compacted` 失效。
- **新增通过的场景**：共享会话 / 长会话（40 请求 / 1 会话）稳态 **96.158%**、仅 1 次冷启动，达成红线。
- **场景覆盖现状**：普通短对话 ✅ 95.740%｜共享长会话 ✅ 96.158%｜冷启动 ✅ 单列 64.780%｜**压缩 ❌ 54.808%**｜**连续工具工作 ❌ 未测**（冻结任务集 20 条里 14 条写着"不要调用任何工具"，实测 0 次工具调用）｜**重启 ❌ 未测**——`scripts/verify-harness-path-comparison.mjs` **尚无重启场景支持**，需要扩展夹具。
- **结论**：能力裁剪 P0–P4 完成；红线仅在普通短对话与长会话两个场景达成，**方案整体未完成**。上一轮我把"红线已达成"写成已收口，是**过早结论**，本轮已更正任务书、验收规程与 README 三处表述。
- 验证：`pnpm run typecheck` 通过；仓库卫生 **33 passed / 0 failed**；提交 `5c98b1c`。

**红线口径裁定为选项 ③ 并落地为可复算判定（2026-09-21 15:23:45）**

- 用户裁定：红线判定在**稳态命中率**（排除每会话首个请求，其余请求含失败/重试/取消/辅助全部计入），**冷启动单独记录**；同时报告含冷启动的总体值作为背景。依据是与同行做法一致（同类系统把首次建链成本单独处理，其 95%+ 读数多出现在长会话上），且混算会让指标随会话长度而非实现质量波动。
- **落地为可执行判定（`scripts/audit-cache-usage.mjs`）**：`--json` 新增 `steadyState` 与 `coldStart` 两组字段；`target.conclusion` 改按稳态判定，并同时输出 `overallHitPercent`；文本摘要打印 `red line basis` 与两行分解。
- **实现中的一个真实陷阱（已修正）**：初版按"run 的首个请求"分类，而本负载是 1 请求/run（60 个请求 = 60 个 run、3 个会话），导致 60 个请求全被判为冷启动、稳态为 0。改为按 `sessionId` 归并、并要求日志**按 `startedAt` 升序排序**（文件名序不等于时间序，初版因此把任意请求误判为冷启动，曾输出"3 个冷启动 96.365%"这种与事实相反的结果）。
- **核定结论（真实数据，3 轮 × 20 任务，60 请求 / 3 会话）**：

| 口径 | 请求数 | 输入 | 缓存 | 命中率 | 判定 |
| --- | ---: | ---: | ---: | ---: | --- |
| **稳态（红线）** | 57 | 269,797 | 258,304 | **95.740%** | **达成** |
| 冷启动（单独记录） | 3 | 13,041 | 8,448 | 64.780% | 不参与判定 |
| 总体（背景值） | 60 | 282,838 | 266,752 | 94.313% | — |

- 冷启动一项的准确说明：3 个会话首请求中**只有 1 个真正冷**（其余命中共享前缀），故该类合并命中为 64.780%，而非单请求的 5.889%。
- **能力裁剪完成（P0–P4）与 95% 达成分别标记，两者均已达成**；判定未使用填充、预热、排除调用或延长会话。
- 同步修订：`docs/reference/cache-95-acceptance.md` 新增 3.1（口径定义与"热缓存子集"的区别）、5.21（核定结论）；任务书第 6 节完成条件改为稳态口径并附修订说明。
- 验证：`pnpm run typecheck` 通过；全仓 **444/445 文件通过、3,086 项通过**（唯一失败为 `scripts/verify-web-live-llm-evidence.test.mjs`，已在干净基线复现确认为沙箱管道 stdio 既有问题）；仓库卫生 **33 passed / 0 failed**。已推送 `5564507`。

**发现意图门控与方案"稳定工具定义"要求的冲突（2026-09-21 14:42:00）**

- **相关事实核实**：本负载 60 个 run **零工具调用**，任务文本多数明确写着"不要调用任何工具"，但每次仍广播 10 个工具 schema。
- **发现的冲突**：方案第 66 行要求"每个会话压缩区间使用一个稳定 system 和**一套稳定工具定义**；工具名、schema、顺序固定"。而按 5.16 修复后的意图门控在**混合会话**中会改变工具集。实测序列："帮我写个函数"→6 个；"把报告导出为 PDF"→8 个（+文档工具）；"查一下今天的新闻"→8 个（文档退出、web 进入）；"再解释一下"→回到 6 个。**每次变化都会使该点之后的缓存前缀失效**，与第 66 行直接冲突。
- 本负载**未暴露**该冲突（全部纯对话，实测每个会话内只有 1 个工具集），但这只说明本负载不触发。
- **判断**：意图门控的价值在于让 Provider 与提示词看到**同一份能力集**（5.16 的正确性修复），**不在于**提升比例；不应为对话轮次单独裁剪工具来换比例——那既违反第 66 行稳定性要求，也属于"仅为比例而裁剪能力"。
- 该冲突需在"按意图收窄"与"按区间固定"之间作出选择，本轮如实记录，**未擅自改动**。
- 验证：`pnpm run typecheck` 通过；仓库卫生 **33 passed / 0 failed**；本轮无生产代码改动。

**修复工具门控未作用于 Provider 的缺陷，并如实报告其比例代价（2026-09-21 14:40:04）**

- **发现的真实缺陷**：`packages/harness/src/stages/execute/runners.ts` 把 `tools: explicitTools ?? ctx.tools` 直接交给 Provider，而 `toolsForRetrievalIntent(ctx)` 此前**只过滤提示词文本**里的工具清单。结果 Provider 收到**未过滤的 12 个工具**（含 `document_create`/`document_read`），与提示词声明的能力集**不一致**；实测 60 个 run 全部如此，而这些 run **零工具调用**。
- **修复**：改为 `tools: explicitTools ?? admittedTools`（`admittedTools = toolsForRetrievalIntent(ctx)`），使 Provider 与提示词看到同一份被准入集合。
- **效果**：Provider 收到的工具数 12 → **10**；负载总输入 **283,262 → 231,631（−18%，少 51,631 tokens）**；暖请求平均 prompt ~4,728 → **3,867**；总体命中率 94.578% → **93.445%**。
- **比例代价是模型预期的，不是回归**：按 `hit ≈ 1 − 192/prompt` 且 `d/dS[(C−S)/(P−S)] = (C−P)/(P−S)² < 0`（恒有 C<P），**任何减少已缓存前缀内容的改动都会降低比例**。修复后暖请求预测 95.035%、实测 94.762%，模型仍吻合。
- **不回滚该修复**：方案第 9 行明确要求"删除冗余后，不能仅因比例下降而恢复冗余"，且"Provider 与提示词能力集不一致"本身是正确性问题。本轮让实现**更精简**（少 51,631 tokens、少广播 2 个工具），代价是比例下降约 1.1 个百分点——这是"精简与 95% 相互拉扯"的又一实证。
- 验证：`pnpm run typecheck` 通过；`packages/harness` 62 文件、520 项通过；仓库卫生 **33 passed / 0 failed**。

**缺口归因收敛：暖请求已达标，唯一冷启动贡献 1.38 个百分点（2026-09-21 14:33:59）**

本轮检验两条此前未定量的改进路径，**两条均被否证**，缺口因此收敛到一个明确来源。

- **路径一（相位平移）否证**：只改变 `prompt mod 128` 而不改变 prompt 规模，对整个 128 位相取均值后命中率仍为 `1 − 192/prompt`（4,380 → 95.563%、4,750 → 95.916%、5,119 → 96.217%）。**相位平移无法抬高均值**，只有增大 prompt 才能，而增大只能靠填充（禁止）。
- **路径二（缩短前缀以减轻冷启动）否证**：建立"前缀缩短 S"模型并用 S=0 复现实测值校准（模型输出与实测 **94.578% 完全一致**）。缩短前缀使总体**变差**，因为暖请求按比例损失的已缓存量远大于冷启动省下的量：S=200 → 94.412%、S=500 → 94.133%、S=1,000 → 93.569%。
- **过程如实说明**：本轮初版模型对冷启动误用了暖请求的残差公式，一度得出"缩短 2,000 tokens 可达标 95.28%"的错误结论；用 S=0 校准发现无法复现实测值后已修正。记录在此以说明结论经过校准而非凑合。
- **最终归因**：

| 分组 | 请求数 | 命中率 |
| --- | ---: | ---: |
| 暖请求 | 59 | **95.959%（已达标）** |
| 冷启动 | 1 | 5.893% |
| 总体 | 60 | 94.578%（未达标） |

- 未达标的直接原因**不是**"prompt 太小"或"实现不够精简"，而是**每个新会话的首次请求必然全价**；唯一冷启动贡献 **1.38 个百分点**，若它表现得像暖请求，总体即 **95.959% ≥ 95%**。消除它只有两种手段——重复请求预热、跨会话复用前缀——前者被方案第 13 行明令禁止，后者在本负载下不存在可复用的既有前缀。
- **判定**：这是方案目标与"禁止预热"约束之间的**结构性冲突**，不是继续精简代码可以弥合的缺口。已达到"能力裁剪完成"，"95% 达成"因该冲突未达成，两项分别标记。
- 验证：`pnpm run typecheck` 通过；仓库卫生 **33 passed / 0 failed**；本轮无生产代码改动。

**更正"供应商常量"表述：残差实际取决于本实现的 prompt 规模（2026-09-21 14:32:26）**

- 本轮检验"`cached` 是否由**上一次**请求决定（滞后模型）"，结论**不成立**：滞后模型仅 29.8% 符合，而当次公式（`cached = floor((prompt−128)/128)×128`）符合 **94.7%**。
- 检验中仍得到一个成立的观察：**19/19** 个连续暖请求满足 `cached[i] ≤ prompt[i−1]`。它与当次公式不矛盾——两者同时成立当且仅当相邻 prompt 增长 < 256，实测增长为 −12 至 84（均值 40.8），条件满足。
- **必须更正我上一轮的表述**：5.11/5.13 把 192 称为"**供应商侧常量、不由本实现决定**"，在**均值**意义上不准确。精确式为 `residual = 128 + (prompt mod 128)`，其中余数**直接由本实现的 prompt 规模决定**；只有该余数在 [0,128) 上均匀时均值才为 192，而实测均值 56.5、分四档计数 23/9/17/10，**并非均匀**。
- **修正后的可达区间**（prompt=4,750 时）：`prompt mod 128 = 0` → **97.31%**；当前均值 → 95.96%；`mod = 127` → 94.63%。达标空间确实存在于"压低 `prompt mod 128`"这**一个本实现可影响的变量**上。
- **但结论不变，理由更正**：压低该余数的手段仍是移动块边界（即填充），被方案第 13 行禁止。因此不是"供应商常量无法改变"，而是"**可改变它的手段恰好被方案禁止**"。
- 验证：`pnpm run typecheck` 通过；仓库卫生 **33 passed / 0 failed**；本轮无生产代码改动。

**残差精确构成、"对齐"路径被方案自身禁止，以及精简与 95% 的结构性张力（2026-09-21 14:30:37）**

- **残差精确分解**（59 个暖请求中 56 个符合）：**未缓存量 = 128 + ((prompt − 128) mod 128)**。即一个固定整块 + 一个随 prompt 均匀分布的余数；实测 `(prompt−128) mod 128` 落在 [2,127]、均值 56.5，确认当前**没有任何对齐控制**。
- **一条表面可行的路径**：若把 prompt 规模控制到 `prompt mod 128` 固定，残差可从均值 192 压到约 128，暖请求命中率由 **95.96% 升到约 97.34%**（+1.38 点），足以让总体跨过 95%。
- **但该路径被方案自身禁止，故本轮不实施**：实现方式只能是给前缀补足最多 127 个**不携带信息价值**的 token 来移动块边界，这正是方案第 13 行明令禁止的"**不得通过填充上下文**……来宣告达标"。已记录为"技术可行但违反方案约束"。
- **暴露出一条结构性事实**：本 Provider 缓存模型下 `hit ≈ 1 − 192/prompt`，**命中率随 prompt 变小而下降**。"更精简"与"≥95%"在残差不变时**相互拉扯**：prompt 3,000 → 93.60%、4,000 → 95.20%、4,750（当前）→ 95.96%、5,486 → 96.50%。
- 本实现已删除的冗余（工具清单重复、过期提示、孤儿 prompt）**同时降低 prompt 与绝对成本**，正是方案所要；但对**比例**的作用中性甚至轻微负向。要在不填充的前提下把比例做到 95%，只剩"让等量 token 落在前缀而非尾部"与"降低冷启动绝对代价"两条，均已逐项核查，空间不足以单独补齐缺口。
- **如实结论**：在"禁止填充"与当前 Provider 缓存模型下，95% 与已完成的精简之间存在**方案未预期的张力**；当前 94.578%（60 请求口径）未达标。未通过对齐填充、预热或延长会话改写该结论。
- 验证：`pnpm run typecheck` 通过；仓库卫生 **33 passed / 0 failed**；本轮无生产代码改动。

**命中率可预测公式 `hit = 1 − 192/prompt`，并发现一处未擅自实施的架构权衡（2026-09-21 14:28:32）**

- 上一轮的"相位"假设经检验**不成立**（残差既非 `prompt mod 128`，也非 `floor(prompt/128)*128`）。进一步拟合得到更简单、且**经实测验证**的规则：**`cached` = 不大于 `prompt − 128` 的最大 128 倍数**。
- 验证强度：59 个暖请求中 **56 个（94.9%）**精确符合，平均绝对误差仅 **6.5 tokens**；预测聚合 95.939% vs 实测 95.959%（差 0.02 个百分点）。
- 推论：未缓存量恒为"一个整块 128 + 一个 0–128 余数"，即约 U[128,256)、均值 **192**；实测残差 134–261、均值 **191.0**，与理论几乎完全吻合。**该残差与 prompt 大小无关**，因此 `hit ≈ 1 − 192/prompt` ——**prompt 越大命中率越高（前提是新增内容可缓存）**。
- 这也解释了 5.10 的反直觉结果：那里把 tokens 加在**尾部**，同时增大了 prompt 与未缓存量，所以变差；加在**前缀**才会改善。
- **达标尺度（可直接计算，无需反复实测）**：暖请求 96.5% 需 prompt ≥ **5,486 tokens**；当前 4,380–5,119（均值 ~4,750，上限 95.96%）。即需给可缓存前缀增加约 **736 tokens**。
- **发现的增长点与权衡**：尾段 1,644 字符**全部**是 `output-directives`，而该函数已验证为确定性、无入参；上移可增加约 411 tokens（所需的一半以上）。但 `builder.ts:128-131` 明确要求"跨模式不同的段落不得位于边界之上"，`output-directives` 与 `respond` 模式的 `response-directives` 互斥，上移会改变跨模式缓存布局。
- 本负载未暴露该风险（请求类型全为 `execute_tool_loop`，且每会话 `promptVersion` 只有 1 个取值），但**这只能说明本负载不触发**。该改动属影响模式语义的架构调整、且方案未授权，故**本轮只记录可行点与代价，未实施**。
- 验证：`pnpm run typecheck` 通过；仓库卫生 **33 passed / 0 failed**；本轮无生产代码改动。

**三轮测量与达标灵敏度模型：多发送内容会让命中率变差（2026-09-21 14:25:26）**

- 把负载加长到 **3 轮 × 20 任务（60 个请求）**复测：新实现 **94.578%**、旧实现 94.429%（2 轮时为 93.538%，说明冷启动摊薄后读数上升）。3 个会话中**只有 1 个冷启动**（5.9%），另两个会话首个请求命中 94.3%。
- 拆分：暖请求 59 个 **95.959%**、冷启动 1 个 5.893%、总体 94.587%。暖请求块对齐浪费合计 **7,936 tokens**（平均 ~134，多数恰好 128）。
- **反直觉但重要的灵敏度结论**：在暖请求上**增加**内容会让总体**变差**——每请求 +64 tokens → 93.992%、+128 → 93.421%、+256 → 92.322%。原因是新增内容落在**未缓存尾部**。因此"多发送内容换更多缓存"是错误方向；正确方向只有**把内容从尾部移入可缓存前缀**或**减少尾部**。
- **达标所需幅度**：60 请求 + 1 次冷启动的结构下，暖请求需从 95.959% 提到 **约 96.5%**。若回收全部 7,936 tokens 块浪费，暖请求可达 98.8%、**总体 97.388%** —— 目标在可达区间内，缺口约"每条暖请求一个 128 块"。
- **机制补充**：会话内 `cached ≈ 0.975 × prompt − 81`；prompt 每请求 +41 tokens、cached +35.6，差距仅以 **5.5 tokens/请求**扩大。说明 128 残差是**恒定量化伪影**（由尾部相对块边界的相位决定），不是持续泄漏。结构上 `splitRequestForCache` 把**所有非 system 消息归入尾部**，可缓存部分只有 system 消息——会话历史必然位于前缀之后，属 chat 缓存固有语义。
- 验证：`pnpm run typecheck` 通过；仓库卫生 **33 passed / 0 failed**（本轮无生产代码改动，为测量与建模）。

**方案"保留底线"逐条核查：8 项覆盖，1 项部分（明确记忆写入）（2026-09-21 13:47:25）**：对方案第 1 节列出的 9 项保留底线逐条核对生产实现与测试覆盖，并更正了我此前关于 `memory-epistemic-policy` 的一个错误记录。

- **覆盖的 8 项**：真实模型回复（11 个测试文件）、原始会话与操作记录（9）、必要记忆读取（2）、宿主权限与源码保护（14）、工具参数和结果校验（1，`tool-execution-service.ts` 的 `inputSchema.parse` 含校验时间戳与错误分支）、取消与预算（22）、执行结果如实呈现（10）、同一操作及同一消息的持久化幂等（34）、减少复核不等于虚报验证（10）。
- **部分满足的 1 项：明确记忆写入**。可达的写入路径**存在且是生产代码**：`runner-finalize.ts` → `compactSessionAfterRun` → `memoryService.write(intent)`，并经过 `resolveMemoryWriteEpistemic`。但它是**压缩路径**的写入；**模型没有主动写记忆的工具**——`memory_tree` 只有只读动作（`root_index`/`branch_index`/`expand`/`deep_search`/`release`）。若按方案字面要求"明确记忆写入"，该项**未完全满足**，如实记录、未擅自改语义。
- **发现一个死选项**：`default-harness.ts` 的 `memoryWriter` 只在第 38 行声明、**从未被消费**（全文件仅 1 处出现），而 `infra.ts` 第 460/471 行仍在传入。属 EVOLVE/CAPTURE 删除后的遗留，应清理或接回（待用户确认语义方向后再动）。
- **更正我此前的错误记录**：我曾把 `memory-epistemic-policy` 记为死代码（依据是 `git grep -l` 只命中其自身测试）。本轮核实**该判断错误**：它被 `session-continuity.ts:26` 以多行 `import {` 块导入，并在第 385 行实际调用——`git grep -l` 按整行匹配文件名因而漏掉。该模块是**活代码**，保留正确。
- 验证：本轮为核查与文档，无生产代码改动；`pnpm run typecheck` 与全量测试沿用上一轮状态。

**对照方案自身基线与达标条件的进度核算（2026-09-21 13:44:10）**：此前我都用自己的口径报告，本轮改用**方案文档第 2 节给出的历史基线与其自身提出的达标条件**核算，结论更硬，也更能说明已走了多远。

- 方案基线（`ff59df5`）：输入 226,680、缓存 165,248、**总体 72.899%**；未缓存 U=61,432（每请求 777.6）。方案自述达标条件为 **C ≥ 19U**，并给出"U 需降至约 8,697，即减少 85.8%"的参照。

| 指标 | 方案基线 | 本次实测 | 变化 |
| --- | ---: | ---: | ---: |
| 总体命中率 | 72.899% | **93.538%** | **+20.64 个百分点** |
| 未缓存 U | 61,432 | 12,185 | **−80.2%** |
| 未缓存/请求 | 777.6 | 304.6 | −60.8% |

- **仍未达标，但缺口已精确**：按 C ≥ 19U，在 C=176,382 时需 U ≤ 9,283，当前 12,185，**还差 2,902 tokens**，折合每条暖请求再降 **约 74 tokens**。这与 5.4 用独立方法得到的"约 73 tokens"互证。
- **结构核算（新增）**：单会话 20 个请求中 `stablePrefix` 基本恒定（14,532→14,533 字节），`dynamicSuffix` 增长 2,799→8,211 字节（2.9 倍），但请求总 token 仅增 757。说明**历史本身已很紧凑**，U 的主因不是历史膨胀，而是 Provider 128-token 块残差；每个 run 恰好 1 次模型请求，本负载下不存在同 run 内多轮复用。
- 因此达标路径确定为：**让可缓存质量（C）增长或让块残差（U）减少**，而不是继续压缩历史。
- 验证：本轮为核算与文档，无生产代码改动；`pnpm run typecheck` 与全量测试状态沿用上一轮（444/445，唯一失败为 `scripts/verify-web-live-llm-evidence.test.mjs`，已在干净基线复现确认为既有问题）。

**系统性排查提示词中的"已删除能力"描述并清理（2026-09-21 13:42:27）**：连续三轮各自命中同类缺陷后，本轮改为一次性系统排查 prompt 与 stage 源码中的过时说明，共清理三处。

- **`sections.ts` 的 `renderStagedCoreFlow`（真实可达）**：`packages/harness/src/stages/reply.ts` 会传 `coreFlowStage: 'reply'`，因此该分支会真的渲染。它仍写着完整旧流程（`DECIDE → EXECUTE → VERIFY → EVOLVE → CAPTURE`、`needs_replan → DECIDE`），并给出 `decide`/`evolve`/`capture` 三个已删除 stage 的说明。已改为真实的单循环图与现存的 stage 说明（删除 `decide`/`evolve`/`capture` 三个 bullet）。上一轮（第 34 轮）只改了非 staged 的 fallback，**漏掉了这个可达分支**。
- **`explicit-tool-instruction.ts` 的三个孤儿 prompt（已删除）**：`resolveExplicitSingleToolInstruction`、`renderExplicitToolProposalContract` 与内部 `renderExplicitMultiToolProposalContract` 在生产代码中**无任何调用者**（仅有自身定义行）。它们会告诉模型"You are the **DECIDE** stage"，并要求返回 `requiresTaskBook`、`taskBook.steps`、`execution.dependsOn`、`mode: "serial"` —— 全部是 P3 已删除的结构。已删除，文件从 200 行降到 83 行；删除后无任何类型错误，反证其确无调用者。保留仍在使用的 `resolveExplicitToolInstructionSet` 与 `resolveBoundedToolJsonSchema`。
- **`context.ts` 的过时注释**：`replanAttempts` 处写着"VERIFY force-passes to EVOLVE to avoid infinite DECIDE↔VERIFY loops"，描述的 stage 已不存在；改为说明预算耗尽即停止、没有独立规划 stage 可回环。字段本身（`taskBookRevision`/`appliedTaskBookPatchIds`）属 checkpoint-carried，保留不动。
- **保留的引用**：`tool-loop.ts` 与 `side-effect-ledger.ts` 中的 `memory_search`/`memory_deep_search` 是**防御性名称表**（用于判定工具结果分类，兼容读取旧记录），不是给模型的指令，故保留；`default-harness.ts` 中解释"DECIDE/EVOLVE/CAPTURE 已删除"的注释是有价值的删除记录，保留。
- 验证：`pnpm run typecheck` 通过；`packages/harness` 62 文件、520 项通过；`packages/prompt` 通过。全仓 `pnpm exec vitest run` 444/445 文件通过，唯一失败为 `scripts/verify-web-live-llm-evidence.test.mjs`（`Unexpected end of JSON input`）；已用 `git stash` 在干净基线上复现同一失败，确认**与本轮改动无关**（沙箱管道 stdio 限制所致）。

**前缀稳定性核查：稳定前缀确实稳定，排除该假设；清理过期时间提示（2026-09-21 13:32:22）**

- **假设检验（否证）**：本轮按 5.5 的方向去查"高频小改动静默段是否在改写可缓存前缀"，直接比对**渲染后的 system prompt 字节**：40 个 run 只有 **2 种文本**（8,719 / 8,887 字符），差异**全部在缓存边界标记之后**的尾部段（`Runtime retrieval intent: none` vs `web_search`）；**边界之前的 8,576 字符在所有 run 中逐字节相同**。`toolSchema` 指纹在单会话 20 个请求中只有 1 个取值，`scope` 同样稳定。因此"前缀被逐请求改写"**不成立**，已从损失来源中排除。
- 顺带解释了一个易误读的信号：`components.systemPrompt` 指纹在单会话 20 个请求中有 20 个取值，与 `toolSchema` 的稳定形成对比。原因是指纹按 `splitRequestForCache` 的 `stableMessages` 计算，而它包含**边界之上的对话消息**，条数随会话推进增长（同会话不同 run 的 `totalMessageCount` 实测为 7 / 25 / 17）。它反映消息集合增长，不是前缀字节被改写。
- **清理过期提示**：`dateTimeSection` 原写着"运行时会在缓存边界之下注入精确时钟、UTC offset、run 耗时、任务进度与有界工具计时"——该注入已在 P1b 删除。改为一句"不注入时钟；需要时间请从 `session_status` 读取"。这与前两轮清掉 `memory_search`、"one EXECUTE turn"、"core-flow 旧流程" 属同类缺陷（描述已不存在的能力），会误导模型且占用前缀。
- 验证：`pnpm run typecheck` 通过；`packages/prompt` + `packages/harness` 共 66 文件、541 项通过；仓库卫生仍为 3 项既有失败（未跟踪方案文件引起）。
- 达标状态不变：**95% 未达成**（93.538%）。机制已锁定为 Provider 的 **128-token 块粒度残差**（5.5），块对齐全部回收的上限为 **96.594%**。

**机制定位：Provider 按 128-token 块缓存，块残差是主要损失（2026-09-21 13:23:39）**：本轮用逐请求建模定位了未缓存量的生成机制，并**更正了上一轮（5.4）"任务边界重建"的归因**。

- **证据**：39 个暖请求中 **32 个**的 `cachedTokenCount` 恰好等于 `floor(prompt/128)*128`；出现过的 `cached` 取值（4096/4224/4352/4480/4608/4736/4864）**全部是 128 的整数倍**。相邻暖请求之间 prompt 平均只增长约 18.5 tokens，而 `cached` 每次只前进 **0 或 128**。
- **结论**：未缓存量 = 自上一个 128 块边界以来累积的内容（134–341，约 4 请求一个周期）。它是**块粒度造成的结构性残差**，不是重复发送，也不是任务边界重建——上一轮把它归因为"任务边界重建上下文"是错的。
- **可达上限**：每个暖请求相对"块对齐后最优"平均浪费 **147.7 tokens**，39 条合计 **5,762 tokens**；全部回收可使总体从 93.538% 升到 **96.594%**。这是跨过 95% 的现实区间。
- **方向修正**：既然残差由块粒度决定，正确做法是**让可缓存部分相对残差更大**（更长的连续可缓存前缀、更少的高频小改动静默段），而不是"削减尾部"或"继续砍前缀"——后者会等比缩小可缓存部分，5.4 已定量证明其无效。
- 验证：`pnpm run typecheck` 通过；本轮为测量与机制建模，无生产代码改动；仓库卫生仍为 3 项既有失败（未跟踪方案文件引起）。

**达标缺口定量模型：杠杆在暖请求而非前缀（2026-09-21 13:06:56）**：本轮不猜方向，而是把"距 95% 还差多少"建成可计算的模型，并据此**否证**了我自己前两轮的推断。

- 前缀裁剪后复测（2 轮 × 20 任务，`--keep-data`）：新实现 **93.538%**、旧实现 93.514%；每次未缓存 304.6 tokens。
- 逐请求分解：暖请求 39 个 **95.579%**（单条未缓存 134–341，均值 207）；冷启动 1 个 **5.9%**（`stablePrefix` 14,532 字节全部未命中）。冷启动把总体从 95.58% 拖到 93.458%（−2.12 个百分点）。
- **否证**：把共享前缀再削 800 tokens，总体只从 93.458% 升到 93.866%（+0.4）。原因是冷启动只占 40 个请求中的 1 个，影响被稀释约 40 倍。**"继续缩前缀"不是达标路径**——这纠正了我 5.3/上两轮的推断。
- **真正的缺口**：在冷启动不变的前提下，暖请求必须从 95.579% 提升到 **97.159%**（+1.58 个百分点），约合 39 个暖请求合计再省 **≈2,840 未缓存 tokens**，即每条暖请求平均再省 **约 73 个**。
- 暖请求未缓存量呈 **134–341 的锯齿**：动态后缀大（41 项 / 8,211 字节）时未缓存少（249），后缀小（3–7 项 / 约 2,800–3,400 字节）时未缓存反而多（291–341）。说明锯齿来源是**任务边界处上下文被重建**，而不是前缀大小。
- 下一步（有依据的方向）：削减任务边界处重新发送的内容——检查任务切换时历史窗口与上下文装配是否把本可复用为前缀的内容放进了尾部；而不是继续压缩共享前缀。
- 验证：`pnpm run typecheck` 通过；全仓测试与仓库卫生状态见上一轮记录（本轮无代码改动，仅测量与文档）。

**修复版本检查点在并发原子写下的 ENOENT 竞态（2026-09-21 12:37:19）**：上一轮如实报告的 `publishes the run before an opt-in background compaction finishes` 间歇失败，本轮定位到根因并修复。

- 复现与证据：该用例单独运行时 **3 次里失败 2 次**（此前几次通过属偶然）。失败路径为 `runner: failed to complete version checkpoint: ENOENT: lstat '<sessions>\<id>.jsonl.<hash>.tmp'`，最终以 `finalize_persistence_failed` 结束整个 run。该失败与本轮及上一轮的功能改动无关：把 prompt 改动 stash 后重建，干净基线上同样失败。
- **根因**：`packages/snapshot/src/git-checkpoint-files.ts` 的 `walkFiles` 先 `readdir`，再对每个条目直接 `await lstat(path)`（**无保护**）。而 session/registry 的写入是"写临时名 + rename"的原子写（`packages/session/src/atomic-file.ts` 用 `<path>.<random>.tmp` 再 rename），失败时还会 unlink 临时名。因此在 readdir 与 lstat 之间临时文件可能已消失，lstat 抛 ENOENT 并让整个版本检查点中止。同文件里**已经有**为此准备的 `safeLstat`（try/catch 返回 undefined），但热路径没有用它。
- **修复**：`walkFiles` 改用 `safeLstat`，条目在遍历途中消失就跳过，而不是让整个检查点失败。最小改动，不放宽任何校验：仍存在的文件照常访问，消失的临时文件本就不应进入快照。
- 验证：修复前 3 次跑 2 次失败；修复后**连续 5 次全部通过**（同一用例、同一命令）。全仓 `pnpm exec vitest run` **445 个文件、3,087 项通过、0 失败、1 项 skipped** —— 近几轮首次全量零失败。`pnpm run typecheck` 通过；仓库卫生仅剩 3 项由未跟踪方案文件引起的既有失败。

**修复 `includeToolingText` 未生效的重复工具清单，并更正"缩前缀即提命中率"的推断（2026-09-21 12:11:41）**

- **真实缺陷**：`assembleSystemPromptBundle` 把 `facts.includeToolingText` 读进 `RuntimeFacts`，却**没有转发**给 `buildSystemPromptBundle`。结果是主循环明明按 `includeToolingText: false` 调用（因为工具 schema 已由 Provider 原生下发），渲染版工具清单仍被逐请求注入。修复后该路径的 system prompt 从 6,081 降到 4,201 字符（−1,880），实测负载总输入从 217,223 降到 188,728 tokens（**−28,495 tokens**）。
- **同时清理过期提示**：`tooling` 段删掉 `memory_search` 的说明（该工具已在第 11 轮删除、仓库中已无注册），并把"尽量在一次 EXECUTE 轮内完成"改为当前的单循环表述。
- **更正上一轮的推断**：我在上一轮写"缩短前缀能直接提高总体命中率"，实测**不成立为普遍规律**。本轮去掉约 28.5k tokens 的重复内容后，命中率并未提升（93.526%，上一轮 94.045%）——因为删掉的内容同时属于已缓存前缀与未缓存部分，比例取决于**未缓存部分**是否被针对性削减。更关键的是：本次**旧实现也同步降到 93.519%**（上一轮 93.911%），说明该波动来自 Provider 缓存状态本身，而非本轮改动；本负载仅 2 个会话，一次冷启动移位就足以让总体移动约 0.5 个百分点。因此单次运行的 0.1–0.5 个百分点差异**不足以判定优劣**，必须多轮取中位数才能比较。
- **如实报告的既有失败**：`packages/runner/src/runner.test.ts > publishes the run before an opt-in background compaction finishes` 现在失败（`status: 'error'`，错误码 `finalize_persistence_failed`，trace 为空）。我已验证这**与本轮改动无关**：把本轮 `packages/prompt` 改动 stash 后重建，该用例在干净基线上同样失败（单独运行、保留基线构建产物）。该失败原因尚未定位到具体持久化步骤（`execution_log`/`session_summary`/`version_checkpoint` 之一），尚未修复，列入下一轮优先项；本轮未通过放宽或跳过该测试来掩盖它。
- 验证：`pnpm run typecheck` 通过；`packages/prompt` 21 项通过；仓库卫生仅剩 3 项由未跟踪方案文件引起的既有失败。

**前缀裁剪与复测：命中率反超旧实现，冷启动按 Provider 缓存窗口计价（2026-09-21 11:49:13）**：按上一轮归因的"缩短共享前缀"方向做了两项裁剪，并复测。

- **裁剪一（工具 schema 意图门控）**：`document_read`/`document_create` 改为与 Web 工具相同的门控（命中条件：存在附件，或输入含文档措辞/文档类扩展名）。冻结负载任务实际广播的工具从 10 个（5,843 字节）降到 6 个（2,113 字节）。
- **裁剪二（system prompt 瘦身，6,197 → 5,727 字符）**：`core-flow` 段原描述的流程**已经不存在**（仍写着 DECIDE、EVOLVE、CAPTURE、`clarify` 可路由、`needs_replan → DECIDE`），改为当前真实的单循环流程（1,530 → 1,253 字符）；`output-directives` 删除两条针对"已不再注入的时钟/耗时"的精度指令，改为一句"时间需从 `session_status` 读取"（1,805 → 1,612 字符）。这既省前缀，也消除了会误导模型的过时说明。
- 复测（2 轮 × 20 任务）：新实现 **94.045%**，旧实现 **93.911%** —— 新实现**反超 +0.136 个百分点**（上一轮为低 0.05）；仍未达 95%。
- **重要发现：冷启动按 Provider 缓存窗口计价，不是按会话计价。** 逐会话读取显示每个会话首个请求都是约 5,026 tokens，但只有第一个会话付全价（0–5% 命中），**第二个会话的首个请求命中 96.8%**，因为 Provider 仍持有同一份共享前缀。因此总体 = 暖请求（96.15%）与"前缀首次建立"（≈5%）的加权，1 次冷启动摊到 40 个请求即得约 94.0%。
- 纪律：不得用"第二个会话命中 96.8%"或"暖请求 96.15%"单独宣称达标——按会话或按热子集挑样本与方案第 1 节禁止的做法同性质。
- 验证：`pnpm run typecheck` 通过；`packages/prompt` 21 项通过；全仓 `pnpm exec vitest run` 444/445 文件通过，唯一失败为 `publishes the run before an opt-in background compaction`，单独运行该文件 69 项全通过，属全量并发下的既有偶发，与本轮改动无关（已如实记录，未改动该测试）。

**缓存 95% 未达标的逐请求归因：损失由"每会话首个请求的冷启动"主导（2026-09-21 11:33:08）**：对保留数据根（`--keep-data`，20 个请求）逐条读取 `cache-observations`，把 94.09% 的缺口分解到单请求粒度，并**更正了上一版"均匀尾部"的结论**。

- **分解结果**：暖请求（19 条）`101,760 / 105,699 = 96.273%`，**已高于 95%**，单条区间 93.9%–97.6%；冷启动（1 条）`256 / 5,137 = 4.983%`，4,881 tokens 全部未命中；冷启动单独把总体从 96.27% 拉到 `102,016 / 110,836 = 92.04%`，**拉低 4.23 个百分点**。2 轮运行下冷启动固定 1 次/会话，摊到 40 个请求，故总体为 94.09%——与实测完全吻合。
- 旧实现同样承担这次冷启动（4,879 tokens 未命中，首条命中率同为 5.0%），因此两条路径总体仅差约 0.05 个百分点。
- 不存在跨请求前缀抖动：`prefixChangeReasons` 为空，`invalidationReasons` 仅 `prompt_version_changed` 且未造成失效。
- **可行动点**：冷启动付费的正是一份稳定前缀（system prompt + 工具 schema，该请求 14,849 字节），所以缩短前缀直接抬高总体命中率。本轮已完成的工具 schema 门控把冻结负载任务实际广播的工具从 10 个（5,843 字节）降到 6 个（2,113 字节），即冷启动少付约 3,730 字节（约 933 tokens）；这与暖请求无关（暖请求本来只付尾部）。
- **纪律**：不得只报暖请求的 96.27% —— 那是方案第 1 节明令禁止的"只统计热缓存子集"；完成条件按含冷启动的总体判定，冷启动不得隐藏。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **445 个文件、3,087 项通过、1 项 skipped**。
- 下一步方向（按收益排序）：① 继续压缩冷启动前缀（system prompt 的常驻段与工具描述）；② 评估把会话首个请求的成本摊薄（例如压缩区间/前缀复用策略），但在任何情况下都不改动"总体必须含冷启动"的判定口径。

**缓存 95% 实测（真实 DeepSeek Provider）：94.09%，未达标（2026-09-21 11:19:51）**：在 `DEEPSEEK_API_KEY` 可用后，按方案第 6 节与 `docs/reference/cache-95-acceptance.md` 的规程跑通了两组冻结负载对比。

- 负载：`deepseek/deepseek-flash`，2 轮 × 20 任务，两条路径各 40 个 run，全部 `status: 200`。
- 测量规则（方案指定）：`hit = sum(cached_input_tokens) / sum(input_tokens)`，取总体而非每请求平均。
  - 新实现：`207,360 / 220,376 = 94.094%`
  - 旧实现：`208,000 / 220,938 = 94.144%`
  - **均 < 95%，目标未达成**；新实现比旧实现低约 0.05 个百分点。
- 其他实测结果：`requestCount` 两侧持平（40/40）；`promptTokens` 新实现少 562；`completionTokens` 少 52；`latencyP95Ms` 低 169ms；`verificationPassRate` 两侧均为 0（该负载为纯对话任务，VERIFY 记为 `unverified`，与已记录的 P2 能力代价一致）。
- `incomplete` 仅剩 `reasoningTokens`（该 Provider 未报告），`cachedPromptTokens` 与 `cacheHitRatio` **本次已有真实数值**，不再是离线彩排时的不可用状态。
- 诚实结论：能力裁剪（P0–P4）已完成且质量门通过，但 **95% 未达成**；不得把 94.09% 说成达标，也不得以"冷启动/热缓存子集"重新表述。剩余损失来源与下一步见下。

**本轮同时完成：文档工具按意图门控（用户选定方案）**：`document_read`、`document_create` 原先在**每个请求**上广播，其中 `document_create` 单个 schema 达 2,115 字符（占内置工具 schema 总量 36%）。现改为与 Web 工具相同的门控规则：仅当该轮涉及文档时才广播（命中条件：存在附件，或输入中出现文档措辞/文档类扩展名）；非内置来源的文档工具在任何情况下都不因措辞被放行。

- 实测收益：普通请求的内置工具 schema 从 5,843 字符降到 **2,113 字符**，即**每个普通请求少 3,730 字符（约 933 tokens）**；文档轮次仍同时提供两个文档工具（4,822 字符），能力未丢失。
- 验证：`pnpm run typecheck` 通过；`packages/harness/src/retrieval-intent.test.ts` 新增双向用例（普通请求被门控 / 文档措辞、`.csv` 扩展名、附件三种命中 / 非内置来源不放行），20 项通过；`packages/harness` 与 `packages/runner` 共 114 文件、867 项全部通过。

**冻结负载验收：离线彩排已跑通，真实 95% 仍待凭据（2026-09-21 01:47:19）**：本轮把验收规程从"文档"推进到"可执行前置条件已就绪"，并如实记录了一个我此前的错误结论。

- **更正**：我在前几轮把 `docs/reference/core-flow-state-contract.md` 报为"mojibake 编码损坏"。本轮逐行检测（`\uFFFD` 与典型 GBK 误读特征）确认该文件 **0 处损坏**，内容是干净 UTF-8；当时看到的乱码是 PowerShell 控制台代码页对**输出**的转码，不是文件本身。已按实际内容校对（边表与新增说明正确），未做任何"修复"以免破坏完好的中文。
- **已完成的可执行前置**：`pnpm run build:app` 重建打包产物（比较脚本会拒绝在 App 产物过期时开跑）；`git worktree add <path> ff59df5` 建立旧实现工作树；`node scripts/verify-harness-path-comparison.mjs --offline` 彩排退出码 0，两侧各 4 个 run 全部 `status: 200`。
- **彩排暴露的关键行为（符合方案要求）**：确定性 Provider 不报告 `cachedPromptTokens`，因此报告把 `reasoningTokens`、`cachedPromptTokens`、`cacheHitRatio` 列入 `incomplete`，`releaseGate.status` 为 `blocked`。**这个 0 不是命中率**：不得据此宣称或否定 95%，也不得按零补齐。
- 结论未变：`hit = sum(cached_input_tokens) / sum(input_tokens)` 的两组冻结负载对比仍必须在 `DEEPSEEK_API_KEY` 下完成，当前环境该变量不存在；此为本轮唯一未完成的验收项，非能力裁剪项（P3/P4 已全部完成）。

**极简执行与缓存 95% 方案 P3 第七刀：清除双驱动留下的模式管道（2026-09-21 01:41:14）**：上一轮合并为单一驱动后，`shadow`/`next` 模式及其按来源/会话切换的配置全部成为死代码，本轮清除。

- 删除配置面：`agents.defaults.durableHarnessMode` 与 `durableHarnessSessionOverrides`/`durableHarnessOriginOverrides`/`durableHarnessProfileOverrides`（schema 与 defaults）、App 的 `RuntimeState`/`RuntimePatch` 字段与 `/runtime` POST 校验分支及 `parseDurableHarnessSessionOverrides` helper、CLI 接线、测试夹具。
- 语义收敛：`prepareAuthoritativeRunnerResult` 不再按模式提前返回（单一驱动下持久化投影始终权威）；`prepareAuthoritativeExecutionLog` 不再按 run 解析模式，记录统一按持久化结算校验（没有结算的记录由 replay 自行报告，而不是被假定可发布）；runner 中 `durableHarnessMode === 'next'` 的常量分支折叠为其生效路径。
- **一处必须保留的分支（本轮自查发现）**：`recordDurableRunOutcome` 的失败处理不能折叠。该路径的语义是"最终结算已持久化，缺失的 `run_completed` 回执由恢复流程补齐，不得降级成冲突的 Runtime 失败事件"；折叠后注入的 `run_completed` 追加失败会直接抛出，`keeps a settled success when run_completed append fails` 用例立刻失败。已恢复原分支并保留该用例。这也说明"模式常量"不能一律按死代码处理。
- 保留：`execution-log`/`runner-persist`/`authoritative-reply` 中作为**持久化数据字段**的 `durableHarnessMode`（旧记录仍需读取与判定），只删除它的选择与切换语义。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **445 个文件、3,086 项通过、1 项 skipped**（比上一批少 3 项，来自删除的模式切换与 API 校验用例）。

**极简执行与缓存 95% 方案 P3 第六刀：合并为单一持久化驱动（2026-09-21 01:12:27）**：`default-harness.ts` 里那份与 durable 驱动几乎相同的旧转移循环删除，`createDefaultHarness` 改为委托 `createNextHarness`；共享 stage 工厂按方案要求保留在 `default-harness.ts`（未删除整文件），因此 stage 注册与 Layer 2/3 可编辑性不变。

- 结果：仓库只剩一个转移循环，且它是记录 `stage_transition_recorded` 的持久化驱动；旧的 "core-flow" 驱动名与影子路径不再存在。
- 运行标签收敛：runner 的 `resolveDurableHarnessMode` 不再按 session/origin/profile 覆盖选择模式（那是方案要删除的"按来源/会话切换配置"），默认 `next`，即每个 run 都走持久化路径。之前默认 `shadow` 会让 run 跳过 durable 最终结算，那在只有一个驱动后是错误标签。
- 测试按新契约更新：删除 2 个 shadow/next 对比用例与 5 个 per-session/origin/profile 覆盖用例（能力已删除）；`e2e` 的能力问答用例改为断言单一驱动的持久事件序列（`stage_transition_recorded` 先行、路由事实随后、`final_reply_*` 结算成对出现）；`runner` 的会话来源捕获降级用例改为断言"降级被如实上报"（durable 路径在多个边界捕获，不再固定为 1 次）。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **445 个文件、3,089 项通过、1 项 skipped**（比上一批少 7 项，全部来自删除的双驱动用例）。

**极简执行与缓存 95% 方案 P3 第五刀：删除已不可达的 DECIDE 与紧凑规划层（2026-09-21 00:43:44）**：第二执行体系删除后，规划已经没有入口，本轮把它整层移除。

- 删除内容：`stages/decide.ts`、`stages/decide/`（8 个模块）与 `decide.test.ts`（1,358 行）；harness 的 DECIDE 注册与 `memoryRefiner`/`MemoryRunRefinementServiceLike` 依赖；`memory-taskbook-refinement.ts`（只服务规划后的记忆精炼）与其测试；紧凑规划层 `compact-autonomous-read-task.ts`、`compact-explicit-tool-decision.ts`、`compact-read-only-result.ts` 及测试；只服务已删执行器的 `execute/direct-tool-proposal.ts`、`execute/final-reply.ts` 及测试。
- **顺带消除第二套 EXECUTE 提示形状**：`execute/prompt.ts` 原先在"紧凑自主只读"分支切到 `respond` 模式的小提示（空工具表、无 bootstrap/记忆/摘要）。该分支只在单步骤 TaskBook 下成立，而计划已不再产生，因此删除后主循环只有一个提示形状——这正是缓存目标需要的。
- 运行时语义调整：`runtime-awareness` 的紧凑投影只剩 `capability_reply` 一类目的；两个驱动（default/durable）的运行时任务事件重定向从"回 DECIDE"改为"回主循环"（需要时先重新 CS 分类），并保留 `deferredRuntimeEventIds` 供循环读取；`reply.ts` 删除"已恢复 TaskBook 的最终回复"分支，恢复的旧计划按只读历史处理。
- 兼容性：`decide`/`capture` 仍留在 `StageName`、`allowedTransitions` 与 `stageNames` 中以便读取旧检查点，但已无注册实现；`resolveCheckpointResumeStage` 把恢复入口的 `decide` 映射到 `execute`，因此旧检查点仍能续跑。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **445 个文件、3,096 项通过、1 项 skipped**（比上一批少 5 个文件 / 78 项，全部来自删除的规划与紧凑层用例）。受影响的断言按新契约更新：`model-request-characterization` 去掉 DECIDE 请求形状用例；`core-agent-contracts` 删除 4 个 DECIDE 规划用例；`default-harness` 的运行时事件用例改写为"事件触发第二轮主循环执行且事件保持携带"，恢复续答用例改为普通 reply 契约；`runtime-awareness` 的紧凑事实用例改用仍存在的 reply 目的。没有以放宽断言保留已删除能力。

**极简执行与缓存 95% 方案 P3 第四刀：删除 TaskBook 步骤执行器（2026-09-21 00:15:36）**：第二执行体系落地删除。`execute` 永远运行单一主循环，`task-book-runner.ts`、`task-step-runner.ts`、`task-step-scheduler.ts`、`reply-candidate.ts` 及其测试删除；已持久化的 TaskBook 变成只读历史，多步骤工作在同一个循环内串行完成。

- 三处耦合改造（先做，再删文件）：恢复入口把 checkpoint 里的 `decide` 映射为 `execute`；续接守卫把绑定回答交给主循环；持久化的 `task_book` 策略降级为 `bounded_loop` 并保留原 reason code。
- 两处真实缺陷在删除过程中暴露并修复：
  1. **续接纠偏与工具证据冲突**：主循环里的有界连续性纠偏把 `role: 'tool'` 消息带进了 REPLY 契约（该契约禁止 `tool_result`）。现在纠偏请求只携带对话文本，且**只有纯对话回答才运行纠偏**——循环已经产出工具证据时，回答按 Provider 原文发布，与执行路径一贯行为一致。
  2. **旧计划被当成未完成计划**：`deriveReplanTargets` 从 TaskBook 步骤清单推导目标，于是恢复出来的只读计划被当作"待补步骤"，VERIFY 反复把 run 送回 EXECUTE 直到耗尽恢复预算并升级为 ASK_USER。现在只有**本次 run 实际记录过步骤结果**时才可能产生重规划目标，`runtimeExecutionEvidenceGap` 同样只对本次 run 执行过的计划要求步骤证据。
- 测试按新契约更新：`execute.test.ts` 删除 16 项随执行器消失的用例（步骤执行、显式/自主工具提议直执行、波次暂停、步骤级重规划）、`core-agent-contracts` 删除 1 项预置 TaskBook 的局部重规划用例；`runner-continuation` 的两项改写为循环流程（恢复边界重试现在由模型自己 `inspect_attachment`；目标改版直接进入循环，断言不再要求 DECIDE 规划文本）；"只重试被阻塞步骤"用例保留全部续接安全断言（副作用只发生一次、权限按当前策略重验、绑定与 disposition 不变、turn 只写一次），只去掉由已删除执行器产生的步骤簿记断言。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **450 个文件、3,174 项通过、1 项 skipped**（比上一批少 18 项，全部来自随执行器删除的用例；没有以放宽断言保留已删除能力）。

**缓存 95% 冻结负载验收规程落盘（2026-09-21 00:15:00）**：新增 `docs/reference/cache-95-acceptance.md` 并从 `docs/README.md` 链接，把方案第 6 节的实测步骤写成可重复规程：冻结任务集/模型/轮数/会话组织/压缩阈值/数据根，旧实现（`ff59df5`）与新实现各跑一次同一负载，用 `scripts/audit-cache-usage.mjs` 出脱敏汇总；测量规则固定为 `hit = sum(cached_input_tokens) / sum(input_tokens)`，全部用途与重试进入总账，未知 usage 明确计数并使达标结论变为不可用；同时写明禁止做法（填充上下文、预热、排除失败调用、延长会话、只报热缓存子集）与完成条件。真实对比唯一缺口仍是 `DEEPSEEK_API_KEY`（密钥不入仓库）。

**P3「删除第二执行体系」的依赖测绘（2026-09-20 23:45:00，未提交改动，本轮已回滚）**：本轮尝试直接删除 TaskBook 步骤执行器（`task-book-runner.ts`、`task-step-runner.ts`、`task-step-scheduler.ts`、`reply-candidate.ts` 及其测试，并让 `execute` 永远走主循环），在删改过程中测绘出该路径的真实耦合面，随后**回滚**，避免在覆盖不足的状态下落地。

- 已确认可达性：`selectWorkPolicy` 已不再为新请求返回 `task_book`（2026-09-20 23:05 条目），所以对新输入而言第二执行体系已经不可达；删除它只影响"已持久化 TaskBook / 旧 checkpoint"的续跑。
- 删除必须同时处理的三处耦合（本轮实测）：
  1. **恢复入口**：旧 checkpoint 持久化了 `entryStage: 'decide'`，resume 直接进入 DECIDE，不经过 classify 重算策略；因此需要把恢复入口映射到 `execute`，否则删除 DECIDE 后旧 checkpoint 无法续跑。
  2. **续接守卫**：`classify` 对 `resumedFromCheckpointId && clarificationResponse` 有硬编码 `next: 'decide'`（等待用户回答后回到规划）；删除规划前必须改为交给主循环，并保持 binding 审计字段。
  3. **旧策略降级**：`resolveExecutionWorkPolicy` 会原样返回持久化的 `task_book` 策略；删除执行器后需要把它降级为 `bounded_loop` 并保留原 reason code。
- 测试面（本轮实测失败集合）：`execute.test.ts` 16 项（TaskBook 步骤执行、显式/自主工具提议直执行、波次暂停、步骤级重规划等，能力随执行器一并删除）、`runner-continuation.test.ts` 7 项（检查点声明/恢复/幂等与"同会话回答绑定"等**通用续接安全语义**，必须逐项改写为循环流程而不是删除）、`test/core-agent-contracts.test.ts` 1 项（预置 TaskBook 的局部重规划）。因此该删除应作为一个独立批次：先做上面三处耦合改造，再逐项改写续接用例，最后删除文件。
- 回滚后状态：`pnpm run typecheck` 通过，`packages/harness`、`packages/runner` 与 `test/core-agent-contracts.test.ts` 123 个文件 / 980 项全部通过，工作树回到 2026-09-20 23:05 的提交状态（本轮无提交）。
- 第二次尝试（2026-09-21 00:00，同样回滚）把三处耦合改造先做出来（恢复入口 `decide → execute`、续接守卫交主循环、持久化 `task_book` 策略降级），失败面从 24 项降到 3 项：`classify.test.ts` 1 项（守卫断言，可直接更新）与 `runner-continuation.test.ts` 2 项。后者暴露更深的问题：这些续接用例的场景（恢复边界进程丢失后重试、同一任务目标改版）在旧流程里靠"DECIDE 规划 + 步骤执行"满足验证证据，改成循环后需要模型自己先 `inspect_attachment` 再作答，且首次 `execute` 在 4 次重试中稳定失败（推测与首次尝试已结算的回复身份或资源恢复后的验证证据缺口有关）。因此删除批次应先把这两个续接场景按循环流程重写并确认 `execute` 失败原因，再删除文件；不要用 skip 或放宽断言绕过。

**极简执行与缓存 95% 方案 P3 第三刀：新请求一律进入单一主循环，规划不再被创建（2026-09-20 23:05:00，进行中）**：按方案「删除第二执行体系」，`selectWorkPolicy` 不再为任何**新**请求返回 `task_book`：复杂范围、超长请求、检索意图、续接、延迟运行时事件和默认兜底全部落到 `bounded_loop`，只保留原有 reason code 作为"为什么这轮更重"的审计说明。规划请求因此只可能由**已持久化的 TaskBook**（旧 checkpoint / 旧计划续跑）触发，而不再由新输入触发。

- 语义：多步骤工作现在完全在主循环内串行完成（工具调用 → 结果 → 继续或作答），与前面几轮删除的并行波次、升级入口和自动记忆沉淀一致；`task_book` 成为只服务旧数据的兼容路径（下一步连同 `task-book-runner.ts`/DECIDE 一起删除）。`ctx.taskBook` 存在的历史分支保留，`isSupportedWorkPolicy` 与 `allowedTransitions` 不变，旧记录继续可读。
- 测试按新契约更新：`classify.test.ts` 的复杂/检索用例改为断言进入主循环并带解释性 reason code；`lean-work-policy.test.ts` 的重型请求用例改为断言 `bounded_loop` + reason code；`e2e.test.ts` 两个依赖"新请求会自动生成 TaskBook"的局部重规划用例替换为一条"多步骤工作在主循环内执行、不产生规划请求"的用例（重规划机制本身仍有 `verify.test.ts` 与 `execute.test.ts` 的阶段级覆盖）；`core-agent-contracts` 的"只重规划失败步骤、不重跑已完成工作"用例改为预置 TaskBook 后驱动，保留该安全不变量；`memory-v3` 删除只覆盖"规划后工作集精炼"的用例，另两个用例去掉队列里的规划响应（release/readmit 本来就由 `memory_tree` 工具驱动，现在直接在循环里生效）；runner 的"运行不写记忆"用例改为断言单次循环请求。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **453 个文件、3,199 项通过、1 项 skipped**（比上一批少 2 项：两个 e2e 局部重规划用例替换为一条主循环多步骤用例，`memory-v3` 删除一条只覆盖"规划后工作集精炼"的用例）。

**极简执行与缓存 95% 方案 P4 第四刀：删除已无引用的记忆配置（2026-09-20 22:30:00，进行中）**：按方案「删除……无引用配置与专用 UI 开关」，删除两组已无生产引用的记忆配置。

- 自动化开关：`memory.llmCapture`、`memory.llmEvolve`、`memory.autoMemoryPolicy`（schema 与默认值），以及 8 个验证脚本中为它们设置兼容值的行。生产代码此前已不再读取它们（EVOLVE 与 CAPTURE 均已删除），因此不改变任何运行时行为。
- 死配置键：`memory.preludeDays`、`preludeMaxCharsPerDay`、`preludeTotalMaxChars`（固定 daily prelude 注入早已关闭）、`autoDistill`、`distillAfterDays`（自动蒸馏随自动演化一并取消）、`searchMaxResults`（唯一消费者 `memory_search` 已删除）、`embeddingMode`（占位声明，无任何读取方；远程 embedding 仍由"不存在远程适配器"这一结构事实保证）。审计方式：解析 `MemoryConfigSchema`/`SessionsConfigSchema`/`ContextConfigSchema` 的全部键，统计 `packages/**` 中除 config 包之外的 `.key` 访问；上列键计数为 0，且 `git grep` 复核只剩 config 自身、一个脚本字面量与一处配置单测。
- 测试清理：`memory-v3.integration.test.ts` 中三处 `autoMemoryPolicy: 'legacy-per-run'` / `llmCapture = true` pin（原本用于显式选择已删除的旧策略）、`config/src/schema.test.ts` 中对应的默认值与 embedding 占位断言。历史任务书中的相关记录保留：那是当时决策的事实记录，不是当前配置说明。
- 验证：`pnpm run typecheck` 通过；`packages/config`、`packages/app/src/main`、`packages/runner/src/memory-v3.integration.test.ts` 全部通过（342 项）；全仓 `pnpm exec vitest run` **453 个文件、3,201 项通过、1 项 skipped**（比上一批少 1 项：删除的 embedding 占位断言）。


**极简执行与缓存 95% 方案 P4 第三刀：删除 legacy-per-run 记忆总结（CAPTURE）（2026-09-20 21:55:00，进行中）**：按方案「保留明确写入与压缩需要的最小服务」，CAPTURE stage 及其模型总结路径、确定性 daily 写入、写入闸门与提示词一并删除。流程变为 `VERIFY → FINALIZE`：一次 run 只记录对话与执行事实，不再为自己写任何持久记忆。

- 删除内容：`stages/capture.ts`、`stages/memory-intent-gate.ts`、`stages/memory-stage-prompts.ts` 与其测试、CAPTURE 的 stage 注册与 harness `memoryWriter` 依赖、`insights` 状态写入路径。保留 `stages/memory-epistemic-policy.ts`：它仍被 runner 的 `session-continuity.ts` 在压缩路径中使用，属于"压缩需要的最小服务"。
- 记忆写入来源收敛为两处：明确写入（`memory_tree` 等工具经统一校验与写入闸门）与压缩路径（会话摘要/候选）。`capture` 作为历史 `StageName` 与合法旧迁移目标保留，只为读取与展示旧记录。
- 代价（方案已列明）：失去每轮自动 daily 流水与"运行即沉淀"；本样本没有 capture 请求，因此不减少本样本调用数。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **453 个文件、3,202 项通过、1 项 skipped**（比上一批少 1 个文件/4 项：删除的 CAPTURE 阶段与其测试）。测试按新契约更新：trace 去掉 `capture`；`memory-stages.test.ts` 整体删除（其剩余用例只覆盖被删除的 CAPTURE）；`memory-v3` 改为"运行不写任何持久记忆 + 明确写入仍可导航、可重启读取"与"压缩仍经单一入口结算、不再自动提升"；runner 的 CAPTURE 持久化用例改为断言"完成一次 run 不产生任何记忆写入"。

**极简执行与缓存 95% 方案 P4 第二刀：删除自动记忆演化编排（2026-09-20 21:10:00，进行中）**：按方案「删除……自动 merge/move/revise 演化编排；保留明确写入与压缩需要的最小服务」，EVOLVE stage 及其全部编排模块删除，流程变为 `VERIFY → CAPTURE → FINALIZE`。

- 删除内容：`stages/evolve.ts`、`stages/evolve/`（reconciliation、hierarchy、subtree、revision、correction、atom-proposal-*、signal、skill-proposal 及各自测试）、`EVOLVE_MEMORY_PROMPT`、harness 的 evolve stage 注册与仅供它使用的 reconciliation/hierarchy/subtree/revision/correction 服务依赖、runner infra 中对应的 service 构造与 `createSkillFn` 自动技能回调，以及 `memory.llmEvolve` 配置项；`verify` 的成功出口改为 `capture`。
- 保留：明确记忆写入（`memory_tree`/`write_memory`/`record_experience` 与写入闸门）、CAPTURE 的确定性 daily 运行记录、以及压缩与会话摘要所需的最小服务。`evolve` 仍在 `StageName`/`allowedTransitions`/model-activity 标签中保留，只为读取与展示旧 run 记录；它不再被注册或可达。
- 代价（方案已列明）：失去自动 Atom 合并/移动/修订/纠正编排，长期与项目分支只由明确写入产生。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **454 个文件、3,206 项通过、1 项 skipped**（比上一批少 3 个文件/32 项：删除的 EVOLVE 编排与其测试，以及改为 CAPTURE 契约的用例）。测试按新契约更新：trace/purpose 断言去掉 `evolve`；`memory-stages.test.ts` 只保留 CAPTURE 用例（删除 761 行 EVOLVE 用例）；`memory-v3` 的两个用例改写为"确定性 CAPTURE 原子可导航、可重启读取"和"运行不再自行写 project 原子"；runner 的 EVOLVE/CAPTURE 持久化用例改为 CAPTURE-only；`core-agent-contracts` 删除已被方案取消的 EVOLVE 准入契约用例。没有以放宽断言保留被删除的能力。

**极简执行与缓存 95% 方案 P4 第一刀：删除自动技能创建（2026-09-20 20:35:00，进行中）**：按方案「删除自动 skill 创建」，`create_skill` 工具从运行时注册表、`@littlesheep/skills` 公共 API、权限写工具清单、EVOLVE 的持久工具信号集和桌面审批文案中移除，实现与其测试一并删除。

- 影响：每个请求的工具 schema 少一条自我演化入口；技能只能由用户或技能来源提供，运行时只保留 `use_skill` 的按需加载。`dirs.skills` 与技能热加载仍由 loader 使用，加载路径不变。
- 保留的写能力不受影响：`write`/`edit`/`exec`、`write_memory`、`record_experience`、`document_create` 仍在权限与审批名单内，明确记忆写入仍可用。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **457 个文件、3,238 项通过、1 项 skipped**（比上一批少 1 个文件/1 项，来自删除的 `create-skill.test.ts`）。被删除的用例是被方案取消的自动创建能力；安全/权限清单中的名字移除后没有以放宽断言代替。

**极简执行与缓存 95% 方案 P3 第二刀：TaskBook 只串行执行，删除依赖波次与并行打包（2026-09-20 20:05:00，进行中）**：按方案 P3「删除 TaskBook DAG/并行波次」，`task-step-scheduler.ts` 从"图校验 + 并行波次选择 + 资源冲突打包 + 按波次降级判定"缩到 107 行的纯校验与串行选择，`task-book-runner.ts` 的 `Promise.allSettled` 波次循环改为一次一个步骤。

- 具体改动：`nextTaskStepWave` → `nextTaskStep`（按计划顺序返回第一个依赖已完成的步骤）；删除 `DEFAULT_MAX_PARALLEL_TASK_STEPS`、`MAX_PARALLEL_TASK_STEPS`、`parallelDowngradeReason`、`toolResourcesConflict` 打包、`ScheduledTaskStep.mode`/`downgradeReason` 与相应的 strict-read/审批降级规则；`task-book-runner` 删除 `mergeWave`/`finishWaveFailure`，改为 `mergeOutcome`/`finishStepFailure`；`task-step-runner` 删除 `parallelStep`/`maxParallelTools` 分支与"并行分支"事件文案。保留的仍是不可协商的部分：步骤 id 唯一性、依赖必须指向更早步骤、资源封套归一化（供权限与副作用校验）、以及每步的取消边界与已结算副作用保护。
- 代价（方案已列明）：失去自动并行计划与按波次的局部降级；多步骤任务仍按计划顺序串行执行。工具调用层面的有界并行（`tool-execution-scheduler`）不受影响，属于主循环内部能力。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **458 个文件、3,239 项通过、1 项 skipped**（比上一批少 4 项：`task-step-scheduler.test.ts` 从 8 项并行波次用例改为 4 项校验/串行选择用例；`execute.test.ts` 的两个并发分支用例改为断言"同一时刻只有一个步骤在跑"与严格 `step_start → step_done` 顺序，其余断言保留）。没有以放宽断言代替删除：被删除的用例正是方案明确取消的并行能力。

**极简执行与缓存 95% 方案 P2 收口：常规会话与工具任务共用同一主循环与同一提示形状（2026-09-20 19:20:00，进行中）**：活动路由不再把请求分成"会话 REPLY 提示"与"执行循环提示"两套形状。命中会话规则的请求与未命中规则的请求现在都进入同一个主循环：模型要么直接回答，要么请求工具，一次成功请求结束普通聊天。

- 具体改动：`classify` 把规则识别出的会话活动（`greeting`、`direct_response_constraint` 等，`type: 'chat'`）也路由到 `execute`，仍保留 `type` 与 `reasonCode` 供审计；`selectWorkPolicy` 为这类请求新增 `conversational_default` → `bounded_loop`，且优先于残留 TaskBook、续接标记与运行时事件，因此问候不会被旧计划重新拉进规划；确实需要检索的请求保持原有规划路径。`reply` stage 只剩能力/状态问答（`capability_reply` 最小契约）这一条路由。
- 保留的能力：原本只在 REPLY 路径上的有界连续性纠偏移入主循环的发布路径（`_shared.ts` 同一 transcript + `repairDiscontinuousReply`，只有本地评估判定 `discontinuous` 时才追加一次调用）；流式增量也补回主循环——`runTranscriptModelTurn` 在关闭 transcript 时直接把文本增量转发到 `onAssistantDelta`，在有 transcript 时仍由收集器转发，不会重复。
- 顺带修复两个被这次路由暴露的真实缺陷：RECOVER 现在在信号已取消时直接停止（此前会重试一次已取消的调用并挂死），以及 `cache-quality-report` 不再把 `unverified` 判决计入 `failCount`（新增 `unverifiedCount`），避免把"结构性通过但不可证"报告成失败。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **458 个文件、3,243 项通过、1 项 skipped**。受影响的断言按新契约更新：harness/e2e/default-harness/runner/core-agent-contracts 的会话路径断言改为 `enter → classify → execute → verify → evolve → capture → finalize` 且 purpose 为 `execute_tool_loop`；续接"新任务"用例改为断言"进入主循环但不进入 DECIDE、不继承旧 TaskBook"；缓存质量报告用例改为断言存在 `unverified` 判定且质量连续性原因不再出现。

**极简执行与缓存 95% 方案工具范围第一刀：删除记忆兼容检索工具（2026-09-20 18:55:00，进行中）**：按方案 §3「首先删除 `memory_search`、`memory_deep_search` 的兼容工具注册，相关动作收归 `memory_tree`」，删除两条兼容检索入口。

- 删除内容：`packages/memory-tree/src/memory-tool.ts` 的 `createMemorySearchCompatibilityTool` / `createMemoryDeepSearchCompatibilityTool` 及其 schema、`memory-tree` 的对应导出、`packages/runner/src/infra.ts` 的两条注册，以及从未被运行时注册过的 `packages/tools/src/builtin/memory_search.ts` / `memory_deep_search.ts`（含其测试）与它们的 barrel 导出。
- 影响：每个请求的工具 schema 少两条重复检索入口；记忆读取只剩单一 `memory_tree`（已包含 root_index、branch_index、expand、deep_search）。`memory_deep_search` 的兼容测试改为只覆盖 `memory_tree` 的 deep_search 导航约束（模型跳过 expand 时返回导航错误而不是直接检索）。
- 保留但不再匹配：安全只读清单、side-effect ledger、tool-loop 的记忆工具鉴权、`run-config` 的自动批准豁免、`memory-feedback-evidence` 的导航工具集合与 `task-step-scheduler` 的只读判定中仍保留这两个名字（纯防御性名单，不注册任何工具）；`retrieval-intent` 按运行时工具表取名，因此自动不再暴露它们。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **458 个文件、3,243 项通过、1 项 skipped**（比上一批少 6 项，来自删除的兼容工具与其测试；`runner.test` 改为断言注册表不再包含这两个名字）。

**极简执行与缓存 95% 方案 P3 第一刀：删除主循环的 TaskBook 升级入口（2026-09-20 18:30:00，进行中）**：删除 `work-policy-upgrade.ts`、`request_task_book` 工具与 `execute → decide` 的升级守卫。主循环不再向模型暴露"中途升级为 TaskBook"的能力：它只做当前循环内的串行工作（最多 20 轮、带无进展检测），复杂/大型/续接/检索请求仍由路由在开始前决定是否进入 DECIDE。

- 删除内容：`work-policy-upgrade.ts` 及其测试（134+101 行）、工具循环里的升级工具与提案分支、`executeLegacyLoop` 的升级交接分支、`ToolLoopResult.workPolicyUpgradeProposal`、两处 harness 驱动里的 `execute → decide` 守卫、`selectWorkPolicy` 的 `bounded_loop_promoted` 分支、以及 call-contract registry 中 `request_task_book` 的运行时控制工具白名单。每个主循环请求因此少一个工具 schema；模型也不再有第二条执行体系入口（方案 P3 要求）。
- 兼容性：`execute → decide` 边仍由 `allowedTransitions` 保留（运行时事件的 `shouldReplan` 重定向使用它），`ctx.workPolicyUpgradeRequest` 字段与 DECIDE 的读取路径保留，因此旧 checkpoint/持久记录仍可解析，不会被误执行。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **459 个文件、3,249 项通过、1 项 skipped**（比上一批少 10 项，来自删除的升级模块与其 7 个用例，另两处断言改为不再包含升级工具）。删除的用例是被方案明确取消的能力的证据，没有以放宽断言代替。

**极简执行与缓存 95% 方案 P2 第六刀：单一 session transcript（2026-09-20 18:05:00，进行中）**：删除 `_shared.ts` 的 per-purpose 历史窗口 `recentHistoryForModel` 及其三个调用点，所有用途共用同一条有界 session transcript（追加式、按量化下界裁剪、上限 12k 字符）。

- 具体改动：紧凑 DECIDE（`decide/request.ts`）、能力回答（`reply.ts`）与紧凑只读步骤（`execute/task-step-runner.ts`）不再各自重组最近历史；`recentHistoryForModel` 及其单元测试删除。主循环、规划、回答、压缩与演化因此投影逐字节相同的对话记录，跨路径的历史前缀不再因用途而异。
- 代价：紧凑路径此前只有 ≤8 条/6k 字符窗口，现在与其它用途一样是有界 12k 记录；首次投影略大，但同一用途的后续请求复用同一前缀。方案 §3 要求取消这类小型特例路径，这里按方案执行。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **460 个文件、3,259 项通过、1 项 skipped**（比上一批少 2 项，来自删除的 per-purpose 窗口测试）。`_shared.test.ts` 保留并继续锁定 transcript 的追加式与量化边界不变量。

**极简执行与缓存 95% 方案 P2 第五刀：per-run 稳定 Runtime 事实进入可缓存前缀（2026-09-20 17:45:00，进行中）**：`runtime-awareness` 从"每请求一个尾部块"改为按变化频率分层。

- 稳定层（可缓存前缀）：能力快照的 epoch、权限策略、工作区、网络与工具可用性在同一个 run 内不变，现在作为主 system 提示之后、历史之前的 system 消息注入（候选 `order = 0.5`，正好排在 order 0 的主提示之后）；实测 12 工具时该块 384 字符（≈96 token），从"每次调用都不可缓存"变为"每个前缀只付一次"。
- 变化层（缓存边界之后）：任务状态与进度、能力探针结果、权限决定仍留在尾部最小变更说明；没有任务书也没有探针/权限事件时**不再追加尾部段**，前缀之外只剩新输入与回答（此前每个请求都要重发约 176 token 的尾部块，P1b 后仍有约 110 token）。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **460 个文件、3,260 项通过、1 项 skipped**。请求形状断言按新契约更新：`model-request-characterization` 断言"主提示 → Runtime 事实 → 历史/输入"的新顺序且尾部不再有 runtime_event；`runtime-awareness.test.ts` 重写为分别断言稳定前缀与尾部状态、以及"无任务书时不追加尾部段"；`cache-request-shape-matrix`、`reply/execute/ask_user` 与 runner 压缩夹具改为按角色/内容定位消息，不再假设固定下标。

**极简执行与缓存 95% 方案 P2 第四刀：活动路由完全确定化（2026-09-20 17:20:00，进行中）**：`classify` 不再调用分类模型。命中规则的会话请求走 `reply`，能力/状态询问与需要检索的请求按既有确定性路径分流，其余请求直接进入主循环 `execute`，由模型自己决定直接回答还是请求工具。每个 run 因此最多再省一次路由请求，且路由阶段不再产生任何提示词形状。

- 删除内容：`packages/classifier/src/llm.ts` 与 `llm.test.ts`、`classify()` 混合入口、`ClassifierOptions`（含 `systemPromptPrefix`、观察回调）、`@littlesheep/llm` 依赖，以及 `ClassifyStageDeps` 的 `llm`/`model`。新增 `ClassificationReasonCode` 值 `deterministic_default_execute`；未命中规则时的分类为 `activity: 'execute'`、`source: 'rules'`、`confidence: 0.5`，因此工作策略落到 `bounded_default` → 主循环。
- 语义变化：`clarify` 早已不可路由，现在连“unclear”也不再存在——无法命中的输入由主循环的模型回答（可以追问细节）。内部 stage id `classify` 与旧 `chat / problem / unclear` 字段继续作为历史兼容；分类失败（内部错误）改为保守进入主循环而不是伪装成会话回复。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **460 个文件、3,260 项通过、1 项 skipped**（比上一批少 11 项，来自删除的分类器模型测试）。受影响的测试按新契约重写：`classify.test.ts` 改为断言"不发出任何模型请求 + 未命中即主循环"，新增未命中默认路由用例；`e2e.test.ts` / `default-harness.test.ts` 的 problem 与 unclear 用例改为"无路由请求、主循环作答、无澄清检查点"；`runner.test.ts` 的前缀变化用例改为由真实工具调用产生后续请求，路径切换用例改为用真实路由差异产生提示词变化；`memory-v3` 与 `core-agent-contracts` 的脚本队列去掉已不存在的分类响应，并按真实请求序列修正断言。

**极简执行与缓存 95% 方案 P2 第三刀：常规 execute 直接进入单一主循环（2026-09-20 16:20:00，进行中）**：`selectWorkPolicy` 的兜底从 `task_book`/`uncertain_execution_scope` 改为 `bounded_loop`/`bounded_default`。常规 execute 请求不再强制先花一次 DECIDE 规划请求，也就不用再走独立最终回复：模型在同一主循环里选择“直接回答”或“请求工具”，Runtime 负责权限、校验、执行与结果追加。

- 保留的规划入口：可证明复杂（`COMPLEX_SCOPE`）、超长请求、既有 TaskBook、续接（checkpoint / 澄清回答 / 局部重规划 / 验证反馈）、延迟运行时事件与需要检索的请求仍然先走 DECIDE；主循环自己也可以通过既有的受限升级入口请求 TaskBook（`bounded_loop` 上暴露的升级工具，Runtime 校验后才进入 DECIDE）。因此“少花一次规划请求”没有取消范围控制，只是把默认路径从“先规划”改成“先执行、需要时再规划”。
- 影响：常规工具任务的模型调用从 `classify → decide → execute(+工具) → execute_final_reply` 降为 `classify → execute(+工具) → execute`（最终回答直接来自主循环），因此每个常规执行 run 少一次规划请求和一次最终回复请求；同时这些 run 的提示词形状统一为主循环，跨请求前缀更一致。VERIFY/RECOVER 已在上一批变为零模型请求。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **461 个文件、3,271 项通过、1 项 skipped**。受影响的断言按新契约更新：`e2e.test.ts` 的 problem 路径与 `default-harness.test.ts` 的 problem 路径改为断言“无 DECIDE 请求、无 TaskBook 事件、无 verify 请求”，需要继续覆盖 TaskBook 局部重规划的用例改用可证明多步骤的请求（`as a multi-step job`）以留在规划路径；`memory-v3` 与 `runner` 中依赖 TaskBook 记忆精化/EVOLVE 的用例同样改用语料，等价的 daily 摘要断言同步更新；崩溃夹具的响应队列去掉已不再发生的规划响应。
- 尚未完成：`execute_final_reply` 在 TaskBook 路径上仍会发出（复杂任务专用），以及 `_shared.ts` 的用途特定历史窗口尚未统一为单一 session transcript。（CLASSIFY 的模型请求已于 2026-09-20 17:20 删除，见上一条。）

**极简执行与缓存 95% 方案 P2 第二刀：RECOVER 改为 Runtime 自有路由（2026-09-20 15:55:00，进行中）**：删除 `recover/model-call.ts` 与 `recover/contracts.ts`，恢复路径不再消耗模型请求。

- 决策只由记录到的事实推导（`stages/recover/policy.ts`）：结构化输出解码失败在第一次恢复时重试产生失败的阶段；存在 `planned`/`in_progress`/`unknown` 副作用时显式停止（`next: exit`、`ok: false`、Runtime 状态文案，绝不自动重放）；记录到 `aborted` 时显式停止；记录到 `permission_denied` 时升级到 `ASK_USER`；其余情况在 `maxRecoveryAttempts` 上限内重试失败阶段；上限耗尽仍按既有规则升级到 `ASK_USER`。
- 删除的能力：模型裁决（retry/escalate/abort）、`revisedPlan` 安装与过期任务书清理、以及模型撰写的升级问句与中止文案。升级路径现在统一生成 Runtime 澄清事实（`copySource: runtime_fallback`、含三个选项），用户可见文字仍只来自 `ASK_USER` 的真实模型调用或 Runtime 状态；`types` 中已无引用的 `RecoveryDecision` 一并删除。`recover` 调用契约保留声明以便历史日志与回放解析。
- 验证：`pnpm run typecheck` 通过；全仓 `pnpm exec vitest run` **461 个文件、3,271 项通过、1 项 skipped**。`recover.test.ts` 重写为 13 项锁定新契约（每种失败的重试目标、解码失败重试、权限升级、副作用未结算显式停止且不发布文案、预算耗尽升级、绑定用户重试只消费一次、以及"任何恢复路径都不发出模型请求"）。`scripts/lib/electron-acceptance-provider.mjs` 中已死的 VERIFY/RECOVER 夹具分支删除。

**极简执行与缓存 95% 方案 P2 第一刀：删除强制验证模型调用（2026-09-20 15:35:00，进行中）**：按方案 P2 的第一项独立切片，删除 `verify/model-call.ts`（连同 `verify/contracts.ts`、`verify/evidence.ts`、`verify/memory-evidence.ts`）。VERIFY 现在只断言 Runtime 证据能证明的事实，每个 run 少一次模型请求。

- 判定契约：窄结构形态（单只读步骤、确定性写后读回）仍为 `pass`；其余已完成的 run 记为新增 verdict **`unverified`**——记录到的工具证据完整、全部调用成功，且存在可回查到真实 Provider 请求的模型回复，但需要人工判断的验收标准未经验证。记录到的失败、缺失步骤、截断证据、未结算副作用或缺少模型回复一律不能成为 `pass`，仍走 `routeKnownIncompleteExecution` 的有界恢复、局部重规划与达到上限后的用户决策路由。
- 连带改动：`VerificationRecord`/durable projection/codec 增加 `unverified`；UI 标签把 `unverified` 显示为“未验证”而不是“验证通过”；`verify` 调用契约保留声明（历史日志与回放仍需解析该 purpose），但内核不再发出该请求。局部重规划目标改为只由记录到的失败/阻塞步骤推导（`deriveReplanTargets` 不再接受模型提供的 `failedStepIds`），未执行的步骤留给原计划，“不重跑已完成步骤”的契约保持不变。
- 记忆与反馈的诚实边界：新增 `verification-state.ts` 的 `hasCleanVerification`（未失败）与 `hasProvenVerification`（仅 `pass`）。EVOLVE/CAPTURE 准入门槛、演化信号与自动 Skill 创建改为“未失败”即可；routing 级反馈（atom `routingFeedback.useful`、会话摘要 activation `useful`）同样按“未失败”计；**verified usefulness / 摘要 `verifiedUseful` 仍只由 `pass` 提高**。由于不再有模型自报 `usedMemoryAtomIds`，atom 级“显式使用”证据现在只来自回答级连续性评估；无法由代码证明的使用不再写正反馈（相关测试改为断言无未经验证的反馈）。
- 验证：`pnpm run typecheck` 通过；`packages/harness` 719 项、`packages/runner` 358 项、`packages/app` 776 项、`test/core-agent-contracts` 全部通过；`packages/session` 一并通过。e2e/default-harness/verify 测试改为断言“VERIFY 不发出任何模型请求”，并把以模型 needs_replan 驱动的用例改写为由真实失败工具触发（草稿撤回与局部重规划仍被覆盖）。
- 本切片已知代价：简单 bounded-loop 工具任务现在记录为 `unverified`，因此不再为 atom verified usefulness、Skill 自动创建计数；这是方案允许的能力取舍，命中率与调用数收益按方案第 6 节在同一冻结负载上重测。

**极简执行与缓存 95% 方案 P1 收口（2026-09-20 15:05:00，进行中）**：在 P0+P1a（见下一条）之后删除 `runtime-awareness.ts` 的逐请求易变注入，P1 批次至此完成。

- 删除内容：精确时钟（local/tz/utc/started）、`elapsed`、`current_run_tools`/`recent_current_tools`、`previous_run`/`previous_run_tools`/`recent_previous_tools`，以及 `formatRuntimeClock`/`formatElapsedMilliseconds` 在该模块的使用。保留并在缓存边界后注入的只有会改变答案的 Runtime 事实：能力快照、能力探针、权限决定，以及任务状态与进度。
- 连带删除：`ctx.previousRun` 契约（`packages/types/src/agent.ts`、`packages/harness/src/context.ts`）与 runner 的末轮摘要读取；末轮摘要本身仍由 `execution-log.ts` 原子持久化（`readLatestForSession` 仍被写入路径与测试使用），供 UI/回放按需读取。显式时间需求改由既有 `session_status` 工具按需返回。
- 体积与稳定性收益（离线实测）：12 工具 + 能力快照的紧凑尾部块 **705 → 439 字符**（≈176 → ≈110 token，每次调用都不可缓存的部分）；同一 run 内重复请求的尾部块**字节一致**（旧实现包含逐请求刷新的时钟），因此尾部不再因时钟而逐次变化。历史样本每次未缓存 777.6 token 的构成中，这一块是可直接缩减的部分；真实命中率变化须按方案第 6 节在同一冻结负载上重测，本轮不宣告比例提升。
- 验证：`pnpm run typecheck` 通过；`packages/harness` + `packages/session` 726 项通过、`packages/runner` 358 项通过。`runtime-awareness.test.ts` 重写为锁定新契约（能力/任务事实、字节一致、无 elapsed/previous_run/工具统计、紧凑块 <500 字符），`stages/execute.test.ts`、`context.test.ts`、`runner.test.ts` 的旧断言同步为"不再注入上一轮执行摘要"。
- 尚未回答的取舍：能力快照目前仍在尾部逐请求重发（每个 run 内稳定、跨 run 变化）。把它移到稳定 system 头会让它进入可缓存前缀，是尾部继续缩小的下一项，属于方案 §3 上下文契约与 P2 单循环的范围。

**极简执行与缓存 95% 方案 P0+P1 落地（2026-09-20 14:35:00，进行中）**：按 `docs/taskbooks/lean-v2-cache-95-plan-taskbook-2026-09-20.md` 的首个实施批次执行，代码基于 `ff59df5`。

- P0 测量修正：`scripts/audit-cache-usage.mjs` 现在显式报告 usage 缺失（未上报 input/cached 的请求数、未上报 uncached 的请求数、usage 不完整的 run 数、无请求的 run 数、无输出 usage 的 run 数、无法解析的日志文件数）、每任务未缓存量（均值与 p50/p95）、总输入/输出 token、失败 run 与失败 trace 步骤、重试请求（按 `retryReason` 分组）与 Provider 尝试次数、`usage.promptTokens` 与请求侧缓存字段的对账差值；首个模型请求改名为 `time to first model request`，真实首个工具动作单独用 `toolInvocations[].proposedAt` 计量，没有工具调用时标 `unavailable`。测量口径固定为 `hit = sum(cached_input)/sum(input)`；任一请求或 run 的 usage 不完整时不给出 95% 结论，而是输出 `unavailable (incomplete usage)`，未知值绝不按 0 补齐。新增 `--json` 输出脱敏汇总。
- P0 历史样本复核（仅诊断，非当前提交基线）：`docs/taskbooks/lean-v2-cache-95-audit-baseline-2026-09-20.json`，40 run / 79 请求、input 226,680、cached 165,248、uncached 61,432、output 1,611、命中 72.899%、未缓存 1,535.8/run 与 777.6/请求；usage 完整，`usage.promptTokens` 与请求侧字段差值 0；新暴露的事实是 24 个请求带 `retryOf`（`duplicate` 19、`decode` 5）、2 个 trace 步骤 `ok:false`，而 run 状态全为 `ok`。
- P1 去重改写删除：`acceptUniqueUserFacingReply` 及其有界重写轮、`reply.ts` 的 `rewriteReply`、`ask_user.ts` / `execute/final-reply.ts` / `execute/runners.ts` 的改写分支、`recover/model-call.ts` 的 `rewriteAbortReason` 全部删除，统一为单一发布入口 `publishUserFacingReply`。跨回合重复措辞按原样发布；保留 Provider 来源校验（可用 `expectedModelRequestId` 固定证明）、空文案与未转义控制标记的 fail-closed、注册表异常不伪造文案。`FinalReplyReservation.allowDuplicate` 与 `user-facing-reply.ts` 的本地跨回合扫描一并删除。
- P1 结算闸门收敛：`ReplyFingerprintStore.reserveSettlement` 只以 settlement 身份为准——同一身份幂等（重启后可重放）、同一身份不同文案拒绝、不同身份同一文案允许；文本指纹索引改为只在缺失时追加，仍作为审计账本保留，`reserveAssistantReply` 旧语义不变。会话契约文档 `AGENTS.md` 与 `docs/principles/architecture-principles.md` 已同步为「同一 settlement 只能发布一次、不同回合允许相同措辞、不为此改写」。
- 验证：`pnpm run typecheck` 通过；`packages/harness` + `packages/session` 全量 736 项通过；`packages/runner` 全量 358 项通过。新增/改写测试覆盖重复问答按原样发布、空回复、注册表不可用、同一 settlement 不同文案拒绝、跨重启幂等、并发发布（同一 settlement 6 次并发全部为真且随后改文案被拒）。
- 已知未完成：`check:repo` 仍有 3 项失败，全部来自当时未跟踪的方案文件 `docs/taskbooks/lean-v2-cache-95-plan-taskbook-2026-09-20.md`（未被 `docs/README.md` 收录、含本机路径与账号、缺少秒级更新时间且文件名不符合 `docs/taskbooks` 的任务书命名规则）。**该问题已于 2026-09-21 解决**：文件按任务书规则改名、补齐二级时间戳、本机路径脱敏，并收录进 `docs/README.md`，3 项卫生失败全部消除。（P1 剩余项已于 2026-09-20 15:05 完成，见上一条。）

**dsh transcript 对齐决定与实施清单（2026-09-11 18:45:00，进行中）**：用户确认以官方 DeepSeek Harness（`D:\Deepseek Harness\node_modules\@deepseek-ai\dsh-*`，上游 github.com/deepseek-ai/deepseek-harness）为唯一对齐目标，next 路径逐项照做，shadow 不变。已授权：系统提示词（含 SOUL/USER/记忆片段）可**完整展示**给用户；thinking 在 next 路径默认开启（成本/延迟由用户接受）。

dsh 契约（源码确认，作为验收标准）：每轮行序为 系统提示词 → 上下文注入/跨会话召回/上下文压缩 → 思考 → 工具行（工具名+目标，点击打开 Input/Output 详情）→ 正文；轮次完成后折叠为「已思考 · N 次工具调用 · N 条消息」，由设置项「对话显示：Normal / Compact」控制；轮次页脚显示 用时、tok/s、本轮用量（提供方/模型、缓存命中、未缓存输入、缓存读取、缓存写入、输出、其中推理 tokens）。对应 locale key：`message.systemPrompt`/`message.think`/`message.contextInjection`/`message.contextRecall`/`message.compaction`/`message.turnProcess.*`/`message.ranFor`/`message.turnUsage.*`/`details.*`/`command.*`。

实施顺序：(1) 系统提示词行（harness 每 run 投影一次实际系统提示词，Renderer 折叠行）；(2) 工具详情面板改为 dsh 的 Input/Output 版式；(3) 完成轮次折叠摘要 + 「对话显示 Normal/Compact」设置；(4) 轮次用量页脚（含 tok/s、缓存命中、推理 tokens）；(5) 上下文注入/跨会话召回/压缩行（需先把记忆注入切成可展示投影，工作量最大）。本轮已完成其中前置项：next 路径 思考/工具/正文 顺序渲染、工具行与正文按到达顺序、thinking 默认开启（自动档不再强制 disabled）。

验证基线：完整发布门 `pnpm.cmd run verify:full` 通过（442 文件 3065 项通过 / 1 skipped，gate executed=5 / skipped=1，313,996.23 ms）；真实运行实测：自动档普通问答 53 个 reasoning chunk，工具任务 68 个。

**Next 路径 transcript 展示（2026-09-11 17:45:00，进行中）**：按要求让 next 的对话区输出按"思考 / 工具 / 正文"的生成顺序展示（shadow 不变）。改动分三层：

- Harness：`ToolStreamEvent` 新增 `model_reasoning` / `model_text`；`execute` 工具循环在 next 路径改用 `callModelChatStream`，把 Provider 的 `reasoning_content` 增量按 turn 发布成思考行，并在"该 turn 决定调用工具"时把该 turn 的正文作为一行 prose 发布。两行都做长度上限（思考 4 000 字符），发布失败只降级为无 transcript，不影响运行。transcript 由 `RunContext.streamModelTranscript` 开关控制，只有 `durableHarnessMode === 'next'` 时为真，legacy 路径的事件序列与展示完全不变（含回归断言）。
- 传输与归并：SSE 事件名直接透传；Renderer 的 `handleRunToolEvent` 把思考增量累积成每 turn 一行、把 prose 与 tool 行按到达顺序写入 `activity.transcript`（上限 400 行 / 8 000 字符），原有的 `tools`/`steps` 投影保持不动，完成态校正逻辑不受影响。
- 渲染：`AssistantTranscript` 按 transcript 顺序渲染（思考行可展开、prose 用 Markdown、工具行复用 `AgentToolRow`）；只有存在 transcript 时才替换原来的"步骤 → 工具 → 正文"三段式，legacy 与无 transcript 的运行保持原布局。

实测（隔离 next 实例，真实 DeepSeek）：`reasoning=high` 的一次工具任务返回 20 个 `model_reasoning` chunk，事件顺序为 `task_book → step_start → [思考增量] → [tool_start/tool_end] → [prose] → step_done → verification`，说明思考、工具、正文已按生成顺序到达前端。

**同时确认一个既有行为（非缺陷）**：推理档位为"自动"时，`resolveProviderReasoningRequest` 对 DeepSeek 显式发送 `thinking: { type: 'disabled' }`，Provider 不会返回 thinking，因此默认档位下不会出现思考行；选择中/高/ultra 档位才会出现。若要默认显示思考，需要产品侧决定是否改变自动档位的成本/延迟取舍。

验证：新增 harness 2 项（有/无开关的行为与事件顺序）、Renderer 归并 2 项（顺序与 legacy 不变）、渲染顺序 1 项；完整发布门 `pnpm.cmd run verify:full` 通过：442 个文件 3063 项通过 / 1 项 skipped，check:repo 33/33、workspace typecheck、App build、recovery 源检查均通过，gate executed=5 / skipped=1，耗时 323,244.49 ms。工具循环文件在下沉 transcript 逻辑到 `model-transcript.ts` 后保持在受控上限内。已知限制：transcript 目前是实时投影，刷新后历史回放只恢复步骤/工具/最终回复，不重建思考行。

**新 Harness 失败原因可见性修复（2026-09-11 17:15:00，进行中）**：A/B 实测发现 next 路径在失败时只显示内部代码。真实用例（Provider 401）在 UI 上显示成 `Runtime failed before publishing a final reply. Reason: durable_final_reply_terminal_without_settlement`，而执行日志里保存的是可操作的 `user-facing reply generation failed: Authentication Fails, Your api key: ****f138 is invalid`。根因有两层：(1) `runtimeFailureResult` 用固定句子覆盖了 Runtime 自己产生的失败文本；(2) `prepareAuthoritativeRunnerResult` / `prepareAuthoritativeExecutionLog` 在 durable 投影只能证明“没有任何 settlement”时，又用泛化句子覆盖了上一层的 reason。修复：把 Runtime 失败发布下沉到 `run-failure-result.ts`（`settleRuntimeFailureEvent` / `runtimeFailureResult` / `clearUnpublishedNextResult`），保留有界（512 字符）且非模型生成的失败原文；authoritative 回放路径在 replay 为 `unavailable` 时保留该原文，只把机器可读的 `runtimeStatus.reason` 留作内部状态。实时结果与历史回放因此显示同一原因，fail-closed 仍然不发布任何未结算的模型文案。新增 `run-failure-result.test.ts` 4 项与 Runner 端到端 1 项（模型抛错 → 用户可见 Authentication Fails、执行日志同样保留），聚焦回归通过。 同一轮还确认了一处部署边界：设置页保存的密钥密文由 Electron `safeStorage`（Windows DPAPI + 当前 Chromium profile 的 OSCrypt 密钥）加密，因此 `keys.json` 只在原 profile 内可解密——同一个密文在另一个 `--user-data-dir` 下解密失败，跨 profile/机器复制数据根必须重新录入密钥。数据根迁移本身不改 Chromium profile，所以不受影响；受影响的是本次为 A/B 测试新建的隔离实例。


**Harness 结算对账与前后端状态一致性修复（2026-09-11 16:37:11，进行中）**：按上一轮审查发现的五项缺口逐条修复，未发布，默认仍为 shadow。

1. 历史回放归属错误：`history-activity.ts` 原先把 run 的 settled reply 应用到所有关联消息，用户原话和中间工具消息都会显示成答案。现在只有归属该 run 的最终 assistant 消息（`finalize` 阶段或带 settlement）才接受权威回复；用户消息与执行中消息保持原文。
2. 统一结算投影：`loadExecutionLogsByRunId` 与诊断回放都改为经 `prepareAuthoritativeExecutionLog`，不再按“当前配置”判断旧 run 的模式；run 实际使用的 Harness 模式写入 `run_accepted` payload 与执行日志（`durableHarnessMode`），`durable-run-mode.ts` 优先读取该记录，缺失该字段但存在 durable 事实的旧 run 保守按 next 复核。崩溃后只剩用户输入、没有执行日志或 assistant 消息的 run 也会生成 Runtime 状态行，不再 404 或静默丢失。
3. 恢复对账读取授权：`reconcileEffect` 新增宿主 `authorizeRead`，Runner 经 `authorizeDurableEffectRead` 由 Main 重新计算容器边界与权限模式；`write` 工具在未授权时不再读取对账路径，授权缺失或拒绝一律保留 `unknown`，写目标缺失也从 `failed` 改为 `unknown`（文件可能被其他写入者删除，不能据此判定原 effect 未执行）。启动恢复没有交互批准通道，需要批准的模式保持 unknown 而不是自动放行。
4. 步骤与工具状态校正：`run-result-reducer` 不再在已有流式步骤时忽略最终结果，按 `stepId`/`callId` 用最终证据覆盖状态、`activeTools` 清零并结束未闭合工具；工具记录直接消费 `ToolInvocationRecord`（此前前端把 `toolName/status/outputSummary` 误声明为 `name/ok/output`，导致状态与输出错位）。
5. 待用户决定与暂停分离：新增 `waiting_user` 活动状态贯穿共享契约、实时归并、历史回放与任务进度标签，保留 Runtime 原因与 `runCheckpointId`；实时与历史对同一 run 显示一致，不再把“副作用结果未知”显示成普通暂停或加载后变成失败。

验证：新增/更新 13 个测试文件覆盖上述路径（历史归属、模式回滚、崩溃后无日志恢复、恢复读取授权与拒绝路径、工具记录错位、流式状态校正、等待用户决定前后端一致）；聚焦回归 105 项通过。最终工作树完整发布门 `pnpm.cmd run verify:full` 通过：441 个文件 3052 项通过 / 1 项 skipped，check:repo 33/33、workspace typecheck、App build 与 recovery 源检查均通过，gate executed=5 / skipped=1，耗时 302,064.77 ms。

剩余：真实 Provider 凭证下的双路径质量/成本对比与真实外部服务对账仍需外部输入；本轮未改真实渠道与发布决定。

**EffectIntentCreated 字段缺口并入同一决策（2026-09-11 04:52:00，阻塞）**：核对任务书 §6.3 与实现后确认一处明确缺口。任务书要求 `EffectIntentCreated` 包含「工具、参数摘要、权限结果、资源范围、幂等键、超时和 owner」；当前 `side-effect-ledger` 发出的 payload 只包含 `effectId`（即 idempotencyKey）、`idempotencyKey`、`toolName`、`inputHash`、`effectKind`，以及取得租约时的 `ownerId`/`leaseUntil` 和可选 `stepId`。缺的四项分两类：(1) 权限结果与超时在结构上晚于 intent——批准发生在 Tool Execution Service 调用期，超时也是调用期参数，因此它们应落在 settlement 或调用记录而不是 intent；(2) 参数摘要与资源范围属于"durable intent 允许携带什么"的同一脱敏边界问题——`resourceKeys` 已存在于 checkpoint 的 `SideEffectCheckpoint`，把它们与有界参数摘要写入事件语料等于扩大 durable event 载荷，这与上一条 A/B 决策是同一类取舍。因此该缺口并入同一次决策：选定 A（新增工具申报的脱敏对账 key / 摘要投影）时一并补齐这两项；选定 B 时改为在 settlement 或会话侧补记，intent 继续只存 `inputHash`。本轮不单方面扩大 durable 载荷，代码未改动。

**Harness 渠道发布契约核对与阻断判定（2026-09-11 04:44:00，阻塞）**：核对任务书「Renderer、CLI、Webhook 和其他渠道只消费同一个 settlement projection」。结论是已覆盖：`DefaultChannelManager.runAgent` 在 next 模式下先经 `prepareAuthoritativeRunnerResult`，未结算时 reply 置空；webhook 插件再用 `result.ok` 与 `finalReplySettlement.status` 双重把关，非 settled 不返回正文；shadow 路径保持 legacy `reply`。本轮还核对了 `verify:provider` 这条真实 Provider 门需要运行中的 Main 进程（当前无 `runtime/local-app-api.json` locator），因此它此刻会因为缺少 locator 失败而不是给出 Provider 结论；凭证本身的结论来自直接探针（401 `authentication_error`）。至此任务书阶段 0-7 均有实现与证据，唯一未完成的阶段 8 剩余要求全部依赖外部输入：(a) 有效 Provider 凭证，(b) 真实外部服务对账的 A/B 边界决策，(c) 真实渠道重连。本轮多次尝试寻找不依赖外部输入的实质工作（渠道发布契约、`'wx'` 同类写入模式审计、并发压力复跑）均无新发现，因此按 blocked 判定收敛，等待外部输入后继续。

**Harness 并发稳定性压力与同类模式审计（2026-09-11 04:30:00，进行中）**：为确认上一轮锁修复之外没有同类竞态，本轮做两类工作。(1) 压力跑：跨进程夹具集合（inbox 恢复、run-lease 恢复、effect-lease 恢复、event store 并发）5 轮全绿；event store 并发夹具单独 10 轮全绿；进程内并发 store 集合（run-checkpoint、cache-observation、session manager、durable inbox/run-lease/effect-lease store、checkpoint disposition）8 轮 × 73 项全绿；App 侧恢复/流式/运行时配置集合 6 轮 × 21 项全绿。(2) 同类模式审计：对仓库内所有 `open(...,'wx')` / `writeFile(..., { flag: 'wx' })` 用法逐一核对，除已修的 `lock.ts` 外全部是"唯一临时名 + rename"写法，不存在"先创建后写内容"的跨进程窗口；`reply-fingerprint-store` 的临时文件初始化在注册表锁内执行，因此也不受影响。结论：本类缺陷在仓库内只有一处，已修复并有 25 轮并发夹具证据。本轮未发现新缺陷，代码未改动。

**Harness 锁修复复验与压力证据（2026-09-11 04:18:00，进行中）**：在上一轮修复基础上再加一层同源防护：`acquireLock`/`tryAcquireLock` 创建锁后回读校验归属，若内容已不属于本次获取则视为冲突、重新轮询（`tryAcquireLock` 返回 null），避免"两个抢锁者都以为成功"。随后做压力复验：跨进程夹具集合（inbox/run-lease/effect-lease 恢复 + event store 并发）连续 5 轮全绿；event store 并发夹具单独再跑 10 轮全绿（累计修复后 25 轮无失败）。全量发布门 `pnpm.cmd run verify:full` 复跑 `passed`（5 executed / 1 skipped，383,189 ms），全仓 434 个文件、2,993 项通过、1 项 skipped；`check:repo` 33/33、workspace typecheck、App build、recovery 源检查均通过。

**Harness 跨进程文件锁真实缺陷修复（2026-09-11 04:06:00，进行中）**：一次 `verify:full` 在 `durable-event-store-concurrency` 上失败，报 `DurableEventStoreError: duplicate event cursor: 12`——两个 OS 进程算出同一个 cursor，说明那把锁没有真正互斥。根因在共享的 `acquireLock`（`@littlesheep/session`）：它用 `open(path, 'wx')` 创建锁文件**之后**才写入 PID 内容，在这段"文件已存在但内容为空"的窗口里，另一个进程的 `tryStealStaleLock` 读到空内容、`JSON.parse` 抛错、被当成"损坏锁"直接 `unlink` 抢走，于是两个进程同时持锁。修复：(1) 内容不可解析的锁只在超过 5 秒创建宽限期后才允许回收，新鲜的空锁视为"正在创建"；(2) 锁内容带唯一 token，release 只在文件仍属于本次获取时才删除，避免误删后来者刚建立的锁。新增 `packages/session/src/lock.test.ts` 4 项回归（不抢正在创建的锁、超过宽限后可回收、活进程锁不抢/死 PID 可抢、不删除后来者的锁）。修复后并发夹具连续 15 次全绿（修复前会间歇失败），全量发布门 `pnpm.cmd run verify:full` 复跑 `passed`（5 executed / 1 skipped，388,166 ms），全仓 434 个文件、2,993 项通过、1 项 skipped。该锁被 durable event store、inbox、run/effect lease、checkpoint store 和回复注册表共用，因此这是影响恢复正确性的实质修复。

**Harness 现场复核与发布就绪记录（2026-09-11 03:55:00，进行中）**：本轮现场复核关键外部阻塞：对 DeepSeek 端点重新做最小探针，仍返回 `401 authentication_error`（131 ms），确认凭证无效，真实 Provider usage/成本对账继续 blocked。同时把任务书 Stage 8 点名的"成本/延迟/请求数/质量/连续性/资源/回滚报告"落成独立交付物 [Harness 发布就绪与双路径对比记录 2026-09-11](../reference/harness-rollout-readiness-2026-09-11.md)，并在 `docs/README.md` 的"当前主线"登记：记录两条质量门证据（`verify:core` 3 executed / 3 skipped 13,308 ms；`verify:full` 5 executed / 1 skipped 372,639 ms，全仓 433 文件 2,988 项）、用户可见结算契约、双路径对比指标与缺证据语义、发布门 reason 集合、灰度与回滚契约，以及仍阻断的条目（真实 Provider 对账、外部服务对账 A/B 决策、真实渠道重连、真实成本/质量对比、资源成本）。资源成本明确标 `unavailable`，不声明未测数字。`check:repo` 33/33 通过（含新文档可达性与链接校验）。

**Harness 两条质量门与发布门逻辑核验（2026-09-11 03:42:00，进行中）**：任务书 §11 要求按影响范围运行 `verify:core` 或 `verify:full`；此前只有 `verify:full` 的当前树证据，本轮补跑 `pnpm.cmd run verify:core`，gate `passed`（3 executed / 3 skipped，13,308 ms，7 个文件 145 项，含 `test/core-agent-contracts.test.ts`）。同时核验 `buildCacheQualityReport` 的 `releaseGate` 逻辑：它覆盖 no_observations、provider_usage_incomplete、context/memory_cache_not_observed、unexplained_cache_miss、latency_unavailable、cache_entries_unreadable、provider_token_totals_incomplete、quality_continuity_not_observed、verification_failures_present，并且**无条件**附加 `real_provider_reconciliation_not_verified`，因此只要没有真实 Provider 对账证据，状态永远停留在 `blocked`，无法被本地夹具"刷成 ready"。这与任务书 CACHE-10「不得用 fake provider 的命中率替代发布结论」一致。

**Harness durable 失败关闭判定补测（2026-09-11 03:39:00，进行中）**：系统排查 harness 里"实现存在但无专门测试"的模块后，为三个决定失败关闭行为的核心文件补上边界单测，共 23 项。`durable-verification-codec`：合法记录读取、省略 failedStepIds 默认空、attempt 必须正整数、reasonLength 必须非负整数、verdict/source 枚举、reasonHash 必须小写 64 位摘要、failedStepIds 必须有界且元素为字符串（14 项）。`durable-kernel-guards`：completed/failed/interrupted 与"已结算 runtime_status"算终态，accepted/running/waiting_user 不算；audit closure 只在 run 已终态且该 effect/model 仍在 pending 列表时为真，非 pending id、非字符串 id、其它事件类型一律为假，未终态时永远为假（7 项）。`final-reply-identity`：同一规范化文案得到同一指纹、大小写与空白不影响、run 与指纹共同决定 settlementId（3 项）。全量发布门 `pnpm.cmd run verify:full` 复跑 `passed`（5 executed / 1 skipped，372,639 ms），全仓 433 个文件、2,988 项通过、1 项 skipped。

**Harness 用户可见回复契约锁定（2026-09-11 03:28:00，进行中）**：`user-facing-reply.ts` 是 AGENTS.md「不得用固定模板伪装成 Agent 回复」的执行点，此前没有专门的测试文件。本轮新增 7 项单测锁定契约：正常路径只返回 LLM 文案并记录 Provider provenance（rewriteCount=0）；注册表抛错 → `reply_registry_failed`；空文案 → `empty_model_reply`；缺 Provider provenance → `missing_model_request_provenance`；命中已发布文案时请求真实重生成并记 rewriteCount=1；连续重复超过上限（MAX_VISIBLE_REPLY_REWRITES=2）→ `duplicate_model_reply` 且不写 reply；重生成调用失败 → `rewrite_failed`；所有失败分支都断言 `ctx.reply`/`ctx.finalReplySettlement` 未被写入（即没有 Runtime 自造文案）。全量发布门 `pnpm.cmd run verify:full` 复跑 `passed`（5 executed / 1 skipped，379,469 ms），全仓 430 个文件、2,965 项通过、1 项 skipped。

**实测：现有持久层拿不到失败 run 的工具入参（2026-09-11 03:05:19，待决策）**：本轮尝试把「真实工具对账」直接建在既有持久数据上（不新增 durable 字段）：给 `EffectReconcileContext` 传入匹配到的工具入参、给内置 `write` 实现 `reconcileEffect` 做字节级内容核对、Runner 从会话 transcript 按 effect `inputHash` 反查工具调用。端到端夹具失败后实测确认两个事实：(1) 结算失败而中止的 run，会话 transcript 里只有 user 消息，assistant 的 tool-call（含入参）不会被持久化，因此 transcript 不是可用来源；(2) execution log 虽然存在（status=error、有 1 条 tool invocation），但只保留 `inputSummary`，不保留原始入参。结论：在不新增持久面、也不改变「失败 run 写不写 tool-call 消息」语义的前提下，`reconcileEffect` 拿不到任何可用于权威对账的入参。该轮试探性改动已全部撤回（`write.ts` 与 `write.test.ts` 已恢复到 HEAD 字节级一致；未新增 `toolInput` 字段、未导出 hash 辅助、Runner 未新增 transcript 反查）。仍待用户决策的两个方向：(A) 在 effect intent 里持久化工具自行申报的有界脱敏对账 key；(B) 在工具执行前把 tool-call 消息写入会话，使失败 run 也留下入参证据。两者都改变既有边界语义，因此不在本轮单方面实施；当前保守行为不变——无对账依据即 `unknown` 并请求用户决定。

**Harness 恢复中途崩溃的幂等证据（2026-09-11 02:50:00，进行中）**：补齐任务书故障注入里还没直接覆盖的边界——恢复过程本身被打断。新增真实文件用例：先用带故障注入的 store 让 `recoverRun` 在写下第一条恢复事实（`model_request_settled`）后抛错模拟进程死亡，再用全新 kernel/store 从同一目录继续恢复。证据显示崩溃后日志里该事实恰好一条、effect 结算为零条；第二次恢复只上报它真正新写的 `effect_marked_unknown` 与 `runtime_status_settled`（不再重复汇报已落盘的 model 事实），最终每类结算事件各恰好一条，projection 为 `waiting_user` 且无 pending，第三次恢复返回空 action。全量发布门 `pnpm.cmd run verify:full` 复跑 `passed`（5 executed / 1 skipped，370,801 ms），全仓 429 个文件、2,958 项通过、1 项 skipped。

**Harness profile 级灰度切换（2026-09-11 02:38:22，进行中）**：把 durable Harness 小范围灰度从「session / origin」细化到「行为 profile」，并保持既有优先级语义不变。`agents.defaults.durableHarnessProfileOverrides` 与 `createRunner` 的 `durableHarnessProfileOverrides` 接受 `general`/`coding` → `shadow`/`next` 映射；解析优先级为 session > origin > profile > 全局，所以已配置的 session/origin 覆盖行为完全不变，profile 只在两者都未命中时生效。选择 profile 作为更细粒度的原因：它在单个 run 内稳定，按它切换不会切割 stable prefix，符合 CACHE-04「不得为了切换而重建稳定段」的约束。同一能力已接入 Local App API `GET/POST /runtime`（非法值返回 400）以及 App/CLI 创建 Runner 的传参。新增 Runner 单测覆盖四级优先级、以及 profile override 驱动真实 run 走 next 且 global 默认仍为 shadow；新增 runtime API 校验夹具。全量发布门 `pnpm.cmd run verify:full` 复跑 `passed`（5 executed / 1 skipped，373,173 ms），全仓 429 个文件、2,957 项通过、1 项 skipped。

**Harness App 恢复失败隔离证据（2026-09-11 02:24:13，进行中）**：补齐回滚/恢复契约里"单个 run 失败不能拖垮启动恢复"的直接证据。`run-routes.test.ts` 新增两项：三个可恢复 run 中第二个的事件日志损坏时，另外两个仍按稳定顺序被恢复，损坏 run 只记录 `recovery failed for ...` 而不中断启动；`listRuns` 自身抛错时记录 `run recovery discovery failed`，启动照常完成且不触发任何 per-run 恢复。App main 72 个文件、275 项通过。全量发布门 `pnpm.cmd run verify:full` 复跑 `passed`（5 executed / 1 skipped，350,814 ms），全仓 429 个文件、2,955 项通过、1 项 skipped；`check:repo` 33/33、workspace typecheck、App build、recovery 源检查均通过。recovery 保留三条历史 warning，未改写为无告警。

**Harness 全量发布门复验（2026-09-11 02:16:24，进行中）**：加入 projection rebuild / cursor replay 证据后重跑 `pnpm.cmd run verify:full`，gate `passed`（5 executed / 1 skipped，379,768 ms）。`check:repo` 33/33、workspace typecheck、App build（`app-build-freshness` ok）、recovery 源检查均通过；全仓测试 429 个文件、2,953 项通过、1 项 skipped。recovery 仍保留三条历史 warning（runtime workspace 缺失、3 个抽样 runId 缺执行日志、layout 非默认 roots），未改写为无告警。

**Harness projection rebuild / cursor replay 证据（2026-09-11 02:09:28，进行中）**：补齐 H-OLD-01 与任务书"故障注入：projection rebuild"要求的直接证据。`durable-kernel.test.ts` 新增 27 项中的一项：用完整事件序列（accept/route/stage/model request/effect intent+settlement/verification/final reply/completion）验证 `rebuildProjection` 连续两次结果与 live projection 完全相等，并验证 `replayAfter(midCursor)` 恰好等于完整日志的 cursor 尾部。`durable-event-store-concurrency.test.ts` 新增真实文件用例：一个 kernel 写入 7 条事件后，换一个全新 kernel + 全新 store 实例从磁盘读回，`reduceDurableRunProjection(read)`、`rebuildProjection` 与 live projection 三者逐字段相等，cursor 为 1..7 且 `replayAfter(4)` 等于尾部三条。harness+runner 108 个文件、869 项通过；`typecheck`、`check:repo` 33/33、diff 门通过。

**待决策前置：durable effect 对账所需的最小入参投影（2026-09-11 02:03:56，阻塞于用户决策）**：本轮继续排查"真实外部服务对账客户端"时确认一个无法由实现单方面越过的前置。当前 `effect_intent_created` 只持久化 `effectId`、`idempotencyKey`、`toolName`、`inputHash`、`effectKind`、`resourceKeys` 与脱敏 owner/lease；除 `web_search`/`web_fetch` 这两个只读工具外，内置工具都没有 `persistence.projectInput`，因此恢复期的 `reconcileEffect` 拿不到任何可用于权威查询的信息。已有的 `projectInput` 是权限判定用的摘要投影（web_fetch 只保留 origin + hash），语义上也不足以做对账。要让 `reconcileEffect` 真正可用，必须新增一条"工具自行申报、有界且已脱敏的对账 key"持久化通道；这会扩大 durable event 的入参存储面，属于对 LLM-04 脱敏边界的实质扩展，因此不在本轮单方面实施。当前保守行为保持不变：无对账依据时 effect 结算为 `unknown` 并请求用户决定。可选方案与代价（A 新增 tool-declared reconcilerKey；B 保持现状、仅保留宿主/工具自带 hook；C 交由宿主在恢复时注入外部系统查询）已记录，待用户选择后再接线。

**Harness 全量发布门复验（2026-09-11 02:02:23，进行中）**：加入 CACHE-09 路径对比后重跑 `pnpm.cmd run verify:full`，gate `passed`（5 executed / 1 skipped，393,470 ms）。`check:repo` 33/33、workspace typecheck、App build（`app-build-freshness` ok）、recovery 源检查均通过；全仓测试 429 个文件、2,951 项通过、1 项 skipped。recovery 仍保留三条历史 warning（runtime workspace 缺失、3 个抽样 runId 缺执行日志、layout 非默认 roots），未改写为无告警。真实 Provider 对账、真实外部服务对账客户端和最终发布决定仍未完成。

**Harness CACHE-09 双路径对比报告（2026-09-11 01:54:52，进行中）**：新增 `compareHarnessPaths`，把同一夹具在 shadow/next/legacy/cutover 下的 `CacheQualityReport` 归一成每个路径的 requestCount、prompt/completion/reasoning/cached token、Provider 命中率、P50/P95/max 延迟、received/failure 率和 VERIFY passRate，并给出首尾两条路径的 delta。任何路径缺 usage、缺延迟或缺验证证据时，该指标保持 `undefined` 并进入 `incomplete`，不补零、不估算。为接入该能力，`buildCacheQualityReport` 及其报告类型也从 `@littlesheep/harness` 正式导出。新增 harness 单测（完整 delta、缺证据标 incomplete）与 Runner 端到端夹具：同一输入分别走 shadow/next，从真实 durable 投影与缓存观测生成两侧报告并对比，断言 request 数一致、prompt token 一致、release gate 仍为 `blocked`。harness+runner 108 个文件、867 项全部通过；`typecheck`、`check:repo` 33/33、diff 门通过。

**Harness 全量发布门复验（2026-09-11 01:46:27，进行中）**：修完临时文件竞争后重跑 `pnpm.cmd run verify:full`，gate `passed`（5 executed / 1 skipped，381,267 ms）。`check:repo` 33/33、workspace typecheck、App build（`app-build-freshness` ok）、recovery 源检查均通过；全仓测试 428 个文件、2,948 项通过、1 项 skipped，比上一轮多出的两项并发夹具已纳入门禁。之前偶发失败的 `measure-verification-baseline` 本轮连续两次全量运行均为绿，与临时文件并发竞争的判断一致。recovery 仍保留历史 warning（runtime workspace 缺失、3 个抽样 runId 缺执行日志、layout 非默认 roots），未改写为无告警。

**Harness durable store 临时文件竞争根治（2026-09-11 01:33:06，进行中）**：把上一轮在 event store 里发现的 `.tmp` 竞争推广排查，确认 inbox store 与 run-lease store 有同一缺陷（读取方把并发写入中的临时文件判成 `unexpected ... file` 并失败关闭）。本轮把 `writeJsonAtomically` 改为写方在 `finally` 里清理自己的临时文件，并新增共享 `isAtomicWriteTempFile` 识别器；三个 store 的读取路径统一跳过 in-flight 临时文件，未知文件名仍 corrupt。event store 里临时的孤儿清理特例已删除，逻辑收敛到一处。新增 inbox 与 run-lease 的回归：in-flight temp 被忽略、未知文件名仍失败关闭。harness+runner 107 个文件、864 项全部通过；`typecheck`、`check:repo` 33/33、diff 门通过。

**Harness 跨进程 event store 并发读修复（2026-09-11 01:24:52，进行中）**：新增真实双 OS 进程并发追加夹具时暴露一个真实缺陷：进程 A 正在原子重命名自己的事件文件时，进程 B 的 `readPartition` 会在目录扫描里看到那个 `.tmp`，把它判成 `unexpected event store file` 并失败关闭。现在读取路径识别 `writeJsonAtomically` 的 in-flight 临时文件命名并跳过它，权威日志仍然只由完整 `.json` 文件组成；未知文件名依旧失败关闭。同时加入有界孤儿清理：只删除「最终 cursor 已提交且 mtime 超过 1 小时」的临时文件，绝不打扰并发中的活写入。新增夹具：两个独立 vitest 子进程各向同一 session/run 追加 25 条事件，最终 50 条事件 cursor 1..50 连续无缺口、eventId 无重复、两侧各 25 条；另加"忽略 in-flight temp、但未知文件仍 corrupt"的回归。`durable-event-store.test.ts` 9 项、并发夹具 1 项通过；harness+runner 107 个文件、862 项通过，`typecheck` 与 `check:repo` 33/33 通过。

**Harness 并发恢复 action 去重（2026-09-11 01:09:15，进行中）**：修复一个真实缺陷：`recoverRun` 之前不区分 append outcome，重复或并发的恢复会把同一 model/effect/final-reply/runtime-status/run-completed action 重复上报，虽然事件本身因幂等键只落一条。现在统一走 `appendRecoveryEvent`，只有 `appended` 才算新 action，`duplicate` 不再重复上报，`conflict` 失败关闭。新增两项回归：并发两次 `recoverRun` 后，合并的 action 集合仍只有三个（model/effect/runtime-status）各一次，事件日志各只一条；随后第三次恢复返回空 action。`durable-kernel.test.ts` 26 项通过，恢复四件套 11 项通过，`typecheck` 与 `check:repo` 33/33 通过。

**Harness 全量发布门复验（2026-09-11 01:03:45，进行中）**：当前工作树重跑 `pnpm.cmd run verify:full`，gate 为 `passed`（5 executed / 1 skipped，544,393 ms）。`check:repo` 33/33、workspace typecheck、App build（`app-build-freshness` ok）与 recovery 源检查均通过；全仓测试 426 个文件、2,942 项通过、1 项 skipped。recovery 保留历史 warning：runtime workspace 路径缺失、3 个抽样 runId 缺执行日志、layout 使用非默认 roots；未改写为无告警。真实 Provider 对账、成本/回答质量对比、真实外部服务对账客户端和最终发布决定仍未完成。

**Harness 工具自对账 effect 结果（2026-09-11 00:52:53，进行中）**：AgentTool 新增可选 `reconcileEffect(effect, ctx)`，让能权威查询自身副作用的工具在崩溃恢复时返回 `succeeded/failed/unknown`；它只观察、绝不复做。Runner 恢复默认按 `effect.toolName` 在工具注册表里查找该钩子，宿主 `queryDurableEffectOutcome` 优先级更高，未注册或抛错时保持保守 `unknown` 并记 bounded warn 日志。新增 Runner 端到端夹具：工具经注册表安装、结算落盘失败、重启后由该工具的 reconciler 把 effect 结算为 `succeeded`（evidence `tool:reconciled`），工具零重放。`runner.test.ts` 60 项全部通过，`typecheck` 与 `check:repo` 33/33 通过。真实外部服务 API 客户端对接仍是后续工作。

**Harness 外部 effect 结果查询接生产 Runner（2026-09-11 00:43:21，进行中）**：`createRunner` 新增 `queryDurableEffectOutcome` 选项，生产恢复路径把它透传给 `createDurableRunRecovery`，所以宿主可以在 run/effect 两级租约接管后查询外部系统并给出权威 `succeeded/failed/unknown`；未配置时仍保持保守 `unknown`。内部重试恢复不再直接调用 kernel，而是复用同一 lease-aware 恢复适配器，避免绕过活动 owner 检查。新增 Runner 级端到端夹具：真实工具已执行且 settlement 落盘失败后重启，注入 `queryDurableEffectOutcome` 的 runner 在恢复中把该 effect 结算为 `succeeded` 并保留外部 evidence，工具不重放、未发布最终回复。`runner.test.ts` 59 项全部通过，`typecheck` 通过。真实外部系统 API 客户端接入仍是后续工作。

**Harness 外部 effect 结果查询恢复（2026-09-11 00:08:07，进行中）**：恢复路径新增可选的 `queryEffectOutcome` 回调。Kernel 在把 pending effect 结算为 `unknown` 前先请求宿主查询外部系统结果，只有宿主返回明确 `known` 且终态为 `succeeded/failed/unknown` 时才按该结果结算；查询不可用或抛错时保持保守 `unknown`，绝不重放 effect 或模型。恢复 action 现在记录实际终态，`effect_settled` 用于已确认结果，`effect_marked_unknown` 保留给无法对账的 effect。`createDurableRunRecovery` 把该回调透传给 kernel，并在 run/effect 两级租约均已接管后才执行查询。新增 kernel 已知结果/不可解析/查询抛错三项回归与 adapter 透传夹具。真实外部系统状态对账仍待把生产调用方接到具体工具/渠道。

**Harness durable effect owner/lease（2026-09-10 20:21:40，进行中）**：next Runner 现在为每个 effectful tool invocation 在 intent 前取得独立跨进程 lease，并以半租期 heartbeat 续租；intent/checkpoint 只保存 owner token 的 SHA-256 摘要和到期时间，租约文件只保存由 session/run/effect 派生的 effect key，不落工具参数、资源路径或原始 effect id。Tool Execution Service 返回后必须先用原 fencing token 再续租确认 owner，durable settlement 同时绑定 owner evidence；失去 owner 的 worker 会把本地 effect 保持为 `unknown`，不能提交成功 settlement。durable settlement 落盘后才释放 effect lease，Runner 收尾会先释放遗留 effect 再释放 run owner。新增 store fencing/reclaim、heartbeat/ownership-loss、并行 ledger 合并、checkpoint roundtrip、真实挂起工具 active→released，以及“子进程续租后被 `SIGKILL`、新进程等待到期以 attempts=2/new token 接管”的真实夹具。当前完整受影响回归为 104 个文件、850 项通过；workspace typecheck、`check:repo` 33/33 和 diff 门通过。effect lease 缺口已关闭；完整 Runner 在真实工具执行中被杀死后的外部状态查询/对账、真实渠道重连、真实 Provider usage/成本对比和最终发布决定仍未完成。

**Harness durable run lease（2026-09-10 19:43:41，进行中）**：next Harness 现在使用独立于 command inbox 的持久 run owner：生产 Runner 在 durable ingress 后 acquire 跨进程 lease，在整个模型/工具生命周期按半租期续租，终态收尾后 release；续租失败会触发 Runner abort，恢复 API 必须先取得同一 lease，活动 owner 存在时拒绝并发追加 recovery 事实。Local App 启动扫描会排除活动 run lease、合并过期 lease-only run，并以 inbox/run 两类最早到期点维护一个可取消 wake-up。新增 store acquire/reclaim/renew/release、heartbeat、kernel 失败释放、生产 run 活动 owner、App 到期恢复与“子进程至少续租一次后被 `SIGKILL`、新进程等待到期再以 attempts=2 接管”的真实夹具。完整 Harness + Runner + App recovery 回归为 99 个文件、837 项通过；workspace typecheck、`check:repo` 33/33 和 diff 门通过。run 级长任务 owner/续租缺口已关闭；effect 自身的 owner/lease、模型/effect 边界真实进程杀死和真实渠道重连仍未完成。

**Harness inbox OS-process kill recovery（2026-09-10 19:15:34，进行中）**：新增真实子进程 kill 夹具：独立 Vitest/Node 进程把 `run_accepted` command 持久化并领取后，由父测试执行 `SIGKILL`；新 store/kernel 实例等待原 lease 到期，重领并 materialize，最终 command 为 `completed`、attempts=2，event log 只有一个 `run_accepted`，不完整 run 由同一 durable projection 权威收口为 `waiting_user/run_incomplete_after_restart`。最终完整受影响集合为 Harness + Runner + App recovery 94 个文件、826 项通过；workspace/App typecheck、`check:repo` 33/33 与 diff 检查通过。该证据完成 ingress claim 边界的真实进程杀死验收；模型/effect 边界真实进程杀死仍待完成，长运行 run owner/续租已由后续 durable run lease 增量补齐。

**Harness inherited-claim wake-up（2026-09-10 15:21:22，进行中）**：关闭“应用重启时旧 worker 的 inbox claim 尚未到期，启动恢复无法领取且之后只能再重启一次”的恢复空窗。Durable inbox 现在严格分开可立即恢复的 queued/过期 claim 与仍受保护的活动 claim；后者会从 event-store 启动恢复集合排除，避免第二个应用进程把仍工作的 owner 错误结算成 `missing/waiting_user`。Local App 只维护一个可取消定时器，到期后仅重扫 inbox run，并继续由跨进程锁、claim token 与轮换 lease 决定唯一 owner，关闭 API 时取消 wake-up。新增 store 最早租约、活动 claim 列举和 RunRouter 到期重试夹具；Harness + Runner + 新 App 定向回归 93 个文件、824 项通过，workspace/App typecheck、`check:repo` 33/33 和 diff 检查通过。该增量仍不等于 run/effect 长执行租约；ingress claim 的真实子进程 kill 已由后续夹具补齐，真实渠道重连和真实 Provider 对账仍未完成。

**Harness ingress run ownership（2026-09-10 15:01:43，进行中）**：completed ingress 现在与本 worker 新 materialize 的 command 明确区分；第二个 next worker 看到相同 `run_accepted` 已完成时，会在模型或工具调用前失败关闭，不能借 event 幂等继续执行并重复副作用。真实共享 store 双 worker 夹具与内存 recorder 夹具均断言 event 只有一条；既有同 turn 并发合并和跨重启 request replay 保持通过。未结算 inbox run 枚举默认上限 256、硬上限 1024，避免启动返回无界身份集合。Harness + Runner 完整回归 92 个文件、822 项通过；workspace typecheck、`check:repo` 33/33 和 diff 检查通过。该门仍不替代真实子进程 kill 与长运行 effect lease 验收。

**Harness inbox startup discovery（2026-09-10 14:52:13，进行中）**：修复 command-only 崩溃态无法被启动扫描发现的缺口。Inbox 可枚举 `queued` 或租约已过期并重新排队的 command 所对应的唯一 run 身份；未到期 claim 不会触发并发 recovery。Local App 启动时与 event-store run 合并去重，`recoverRun` 先 materialize queued ingress，再执行 projection recovery。仅有 `run_accepted` 的不完整 run 会产生权威 `waiting_user/run_incomplete_after_restart`，不会静默消失或伪装完成。真实文件重启夹具、Runner effect recovery、App/Workspace typecheck 均通过；完整 Harness + Runner 基线仍为 92 个文件、820 项通过。真实子进程 kill 仍未覆盖；未到期 claim 的延后接管已由后续 lease wake-up 增量补齐。

**Harness inbox restart recovery（2026-09-10 14:44:45，进行中）**：新增真实文件存储重启夹具，覆盖 command-only 与 event-without-completion 两个崩溃点。前者在新 store/kernel 实例中 materialize 并完成；后者等待 claim 租约过期后由新实例重领，append 命中同一幂等 event，最终 event 数保持 1、command attempts 增至 2 且完成。Harness + Runner 完整回归为 92 个文件、820 项通过。该证据仍是同进程重建实例，不替代真实子进程 kill；真实子进程故障、run/effect 进程级租约、真实渠道重连和真实 Provider 对账继续未完成。

**Harness production durable inbox（2026-09-10 14:39:20，进行中）**：next Runner 的 `run_accepted` 与 `user_input_appended` ingress 现在先写入持久 command inbox，按精确 command 领取后才 materialize 到 append-only event store，并以同一 claim token 完成；内部 stage/model/effect/settlement 事实继续直接写 event store，避免把 inbox 错用成无界 event outbox。source 和显式 `occurredAt` 跨 inbox 保留，shadow 不增加 inbox 写入。生产 Runner 夹具核验两个 ingress command 与 event 一一对应且内部 route event 不进入 inbox；跨 run claim filter 保证一个 drain 不会顺带领取另一 run。inbox orchestration 已从 kernel 拆到独立 processor，`durable-kernel.ts` 回落到登记上限内。Harness + Runner 91 个文件、818 项通过；下一步仍需补齐进程杀死后的 pending/claimed command 接管、run/effect 进程级租约、真实渠道重连和真实 Provider 对账。

**Harness durable inbox claim fencing（2026-09-10 14:14:04，进行中）**：durable inbox 每次 claim 现在生成唯一 owner token；租约过期重领会轮换 token，旧 worker 无法再用相同 `commandId` 覆盖当前 owner 的 complete/fail。Kernel drain 会携带 token 结算，若处理期间失去租约则保留新 owner 的状态；version 1 历史已领取命令缺少 token 时继续兼容读取，重领后自动进入 fencing。新增 stale-worker 回归；Harness + Runner 91 个文件、817 项通过，Types/Harness/Runner typecheck、`check:repo` 33/33 和 `git diff --check` 通过。该增量只关闭 inbox claim ownership 竞态；run/effect 的其他进程级 crash/replay、真实渠道重连、真实 Provider 对账和最终发布决定仍未完成。

**Harness full release gate（2026-09-10 13:50:18，进行中）**：`pnpm.cmd run verify:full` 通过，包含 `check:repo` 33/33、全仓 411 个文件 2,898 项通过/1 项 skipped、workspace typecheck、Electron App build（Electron 36.9.5，output digest `07ab85548fdd69a79879c3f57e32f760dc586fb7a2a56653b6e9adc6e2ec9898`）和 recovery 源检查。gate 结果为 5 executed / 1 skipped，耗时 284,070.78 ms。recovery 仍保留历史 warning：迁移前登记的 runtime workspace 路径缺失、3 个抽样 runId 缺执行日志、layout 使用非默认 roots；未改写为无告警。实际 Provider 对账、真实渠道重连和最终发布决定仍未完成。

**Harness finalize transcript fail-closed（2026-09-10 13:42:33，进行中）**：新增真实 Runner 回归，令 assistant finalize 会话正文写入失败，发现并修复失败 Run 仍把未持久化模型文案写入 `result.reply` 的发布漏洞。next 路径现在只在形成 settled final reply 后发布文案；未形成 settlement 的失败/中断结果统一清空 reply、provenance、proposal 和 finalize 消息，Runtime status 使用 durable projection 的失败原因。结合 execution log、session summary、final-reply registry、durable event 失败夹具，FINALIZE 主要持久化分支均已 fail-closed。全仓当前工作树 411 个文件、2,898 项通过、1 项 skipped；`pnpm.cmd run typecheck` 和 `check:repo` 33/33 通过。真实渠道重连、实际 Provider 对账和更细粒度灰度仍未完成。

**Harness terminal effect recovery（2026-09-10 13:25:10，进行中）**：修复终态恢复缺口：当 effect settlement 落盘失败、Runner 已发布 `run_failed`/Runtime status 后，重启恢复仍会把 pending effect/model request 审计性结算为 `unknown`/`missing`，不再因终态提前返回；未知 effect 不会把已终态 Run 回退成第二个 `waiting_user`。新增 durable kernel 终态审计关闭夹具和真实 Runner + Tool Execution Service 的“工具已写入→settlement 落盘失败→重启恢复”端到端夹具，确认工具只执行一次、`unknownEffectIds` 保留且无成功文案。harness + runner 91 个文件、815 项通过；全仓当前工作树 411 个文件、2,897 项通过、1 项 skipped；`pnpm.cmd run typecheck` 和 `check:repo` 33/33 通过。其他进程级 effect crash/replay、真实 Webhook 重连和实际 Provider 对账仍未完成。

**Harness next memory injection（2026-09-09 14:38:30，进行中）**：D1 Atom 注入夹具已切到 next 路径，验证 Initially Selected Memory Atoms、Run Memory KnownState、working set 和 memory access ledger 在 next 下同样成立。Memory v3 集成 7/7 通过；runner 上一完整回归为 30 个文件 256/256。

**Harness next provider timeout（2026-09-09 14:35:30，进行中）**：新增 next 模式 Provider timeout 端到端回归，确认 model request 以 `timeout` 结算、durable projection 无 pending model request、run 记录 `run_failed` 且不误报完成。定向测试通过；runner 上一完整回归为 30 个文件 256/256。

**Harness next streaming usage（2026-09-09 14:33:30，进行中）**：新增 next + streaming + partial provider usage 端到端回归，确认 model response、model settlement、final reply settlement 和 run_completed 均正常，不因可选 usage 字段缺失失败。定向测试通过；runner 上一完整回归为 30 个文件 256/256。

**Harness cumulative full-suite gate（2026-09-09 14:32:25，进行中）**：最新全仓 `pnpm.cmd test` 通过 411 个文件、2,892 项、1 项 skipped；`pnpm.cmd typecheck` 和 `pnpm.cmd run check:repo` 33/33 通过。该基线包含 next 路径 provider usage 可选字段修复、Provider usage 完全缺失回归、端到端 cache-quality 报告、shadow/next 双路径对比和验证质量投影。实际 Provider 对账仍因 DeepSeek 401 凭证 blocked。

**Harness next missing usage regression（2026-09-09 14:25:30，进行中）**：补充 next 模式 Provider usage 完全缺失的回归夹具，确认所有模型请求仍以 `received/unavailable` 结算且 run 正常完成，不会因可选 usage 字段缺失触发 lifecycle 失败。定向测试通过；runner 上一完整回归为 30 个文件 256/256。

**Harness end-to-end cache quality report（2026-09-09 14:23:30，进行中）**：新增真实 Runner 两轮请求到 cache-quality 报告的端到端夹具，覆盖 Provider hit ratio、prompt/completion/cached token 总量和 received/failure outcome rate。该夹具发现并修复 Provider usage 缺 `cachedPromptTokens`/`reasoningTokens` 时 next 路径把 `undefined` 写入 durable event、导致 `finalize_model_lifecycle_failed` 的真实缺陷。runner 30 个文件 256/256、harness 61 个文件 553/553 通过。实际 Provider 对账仍因 DeepSeek 401 凭证 blocked。

**Harness shadow/next cost guard（2026-09-09 14:12:30，进行中）**：双路径对比加入 Context safety estimate 成本门：同一输入的 next prompt token 估算不得超过 shadow 的 1.5 倍，避免新 Harness 引入明显 Context 膨胀。定向夹具通过；runner 上一完整回归为 30 个文件 255/255，通过。实际 Provider 成本和完整质量对比仍未完成。

**Harness shadow/next tool comparison（2026-09-09 14:09:30，进行中）**：新增工具/副作用双路径夹具：同一写入任务在 shadow 与 next 下各执行一次工具、各产生一条回复和一个 succeeded side effect；next 有 stage transitions，shadow 无。该夹具发现并修复 VERIFY 通过时 `failedStepIds: undefined` 被 durable event JSON 校验拒绝、导致 next run 失败的真实缺陷。runner 30 个文件 255/255、harness 61 个文件 553/553 通过；全仓上一干净门为 411 个文件、2,888 项通过、1 项 skipped。代表性真实任务和完整成本对比仍未完成。

**Harness shadow/next comparison（2026-09-09 13:59:30，进行中）**：新增确定性双路径对比夹具：同一输入在 shadow 与 next 下都只产生一条回复和一次 final settlement；next 额外记录 `stage_transition_recorded`；request kind 与请求数一致；两条路径的 stable prefix 指纹不同，说明 cutover 不能共享 Provider 前缀缓存，成本必须按路径分别度量。runner 30 个文件 254/254 通过；全仓干净门仍为 411 个文件、2,888 项通过、1 项 skipped。代表性真实任务、工具/副作用差异和完整成本对比仍未完成。

**Harness verification quality projection（2026-09-09 13:49:30，进行中）**：durable `verification_recorded` 现在进入 `DurableRunProjection`，仅保留 attempt、verdict、source、reason hash/length 和 failed step ids；cache-quality 报告新增 pass/needs_replan/fail 计数与 passRate，缺失时标 `quality_continuity_not_observed`，存在 fail 时标 `verification_failures_present`。session durable projection 读取已拆到 `session-durable-projection.ts`，API 一次读取 model requests 和 verifications，避免重复扫描。最新全仓 `pnpm.cmd test` 411 个文件、2,888 项通过、1 项 skipped；`pnpm.cmd typecheck`、`pnpm.cmd run check:repo` 33/33 通过。实际 Provider 对账仍因 DeepSeek 401 凭证 blocked。

**Harness cumulative full-suite gate（2026-09-09 13:38:11，进行中）**：最新全仓 `pnpm.cmd test` 通过 411 个文件、2,886 项、1 项 skipped；`pnpm.cmd typecheck` 和 `pnpm.cmd run check:repo` 33/33 通过。该基线包含 webhook 重复投递、origin override、next 并发租约/重启重放、effect unknown 端到端和 CACHE-09 durable 报告增量。实际 Provider usage 对账仍因当前 DeepSeek 401 凭证保持 blocked。

**Harness webhook duplicate delivery（2026-09-09 13:29:30，进行中）**：新增 loopback Webhook 重复投递夹具：同一 `messageId` 只执行一次，不同 `messageId` 才新增执行，验证 `channel → Runner requestKey` 透传和幂等边界。webhook 2 个文件 32/32、plugins channel manager 29/29、全仓 typecheck 通过；真实外部 Webhook 重连仍未完成。

**Harness origin override run（2026-09-09 12:51:00，进行中）**：新增 origin override 的真实 run 夹具：`app` 来源走 next 并产生 settled final reply，`cli` 来源继续 shadow，全局默认保持不变。runner 30 个文件 253/253 通过；此前全仓干净门为 411 个文件、2,882 项通过、1 项 skipped。实际 Provider 对账仍因当前 DeepSeek 环境密钥 401 而 blocked。

**Harness real provider probe（2026-09-09 12:41:30，blocked）**：使用当前默认 DeepSeek 配置执行一次极小、无工具的 Provider 探针，Provider 返回 `401 Authentication Fails`，说明当前环境中的 `DEEPSEEK_API_KEY` 无效或过期。未保存 prompt、回复正文或密钥；CACHE-07 实际 Provider usage 对账继续保持 `blocked`，需要用户更新有效凭证后重跑。离线全仓门仍为 411 个文件、2,882 项通过、1 项 skipped；runner 30 个文件 252/252 通过。

**Harness next concurrent lease（2026-09-09 12:38:00，进行中）**：新增 `durableHarnessMode: 'next'` 并发同 turn 重试夹具，两个并发请求只形成一个 run、一次用户输入和一条回复。runner 30 个文件 252/252 通过；此前全仓干净门为 411 个文件、2,882 项通过、1 项 skipped。更细的 request kind 切换和实际 Provider 对账仍未完成。

**Harness next restart replay（2026-09-09 12:29:30，进行中）**：新增 `durableHarnessMode: 'next'` 的完成请求重启重放夹具：同 requestKey 重启后返回同一 run/reply，模型零调用，`finalReplySettlement` 保持 settled，用户输入只持久化一次。runner 30 个文件 251/251 通过；此前全仓干净门为 411 个文件、2,882 项通过、1 项 skipped。更细的 request kind 切换和实际 Provider 对账仍未完成。

**Harness cumulative full-suite gate（2026-09-09 12:22:04，进行中）**：修复 `memory-v3-bootstrap` 在 3-worker 负载下的 flaky：迁移测试超时提高到 90s，清理对 `EBUSY/EPERM/ENOTEMPTY` 做有界重试。全仓 `pnpm.cmd test` 411 个文件、2,882 项通过、1 项 skipped；`pnpm.cmd typecheck` 和 `pnpm.cmd run check:repo` 33/33 通过。该结果覆盖最近 CACHE-08/09、H-OLD-08 和 effect unknown 端到端增量；实际 Provider 对账、成本/回答质量对比和新 Harness 默认切换仍未完成。

**Harness effect unknown end-to-end（2026-09-09 12:08:30，进行中）**：新增真实 Tool Execution Service 端到端夹具：自定义写工具实际写入后抛错，验证工具只执行一次、side effect 结算为 `unknown`、durable projection 产生 `unknownEffectIds`，next 路径返回需要用户决定的 Runtime 错误而不是成功文案。runner 30 个文件 250/250 通过；此前 CACHE-09 增量 harness 61 个文件 551/551 仍通过。生产级 effect crash/replay 的其他进程崩溃/重连场景、实际 Provider 对账和新 Harness 默认切换仍未完成。

**Harness CACHE-09 durable latency report（2026-09-09 11:59:00，进行中）**：Runner `Infrastructure.loadSessionModelRequests` 按 session 读取最近 64 个 run 的 durable model request projection；`CacheObservationStore.report()` 现在只用授权 observation 的 requestId 计算延迟、取消和失败摘要，Local App API `GET /runtime/cache-quality` 显式透传。报告新增 Provider prompt/completion/reasoning/total/cached token 总量和 received/pending/aborted/failure 计数与比率；任一请求缺 usage 时只标 `provider_token_totals_incomplete`，不补零。新增 harness store/report 夹具验证跨 scope 请求不会进入 latency，新增 runner 夹具验证 session 级投影与 durable projection 一致。harness 61 个文件 551/551、runner 30 个文件 249/249、app cache-quality API 夹具和 app typecheck 通过。实际 Provider 对账、成本/回答质量对比和最终发布决定仍未完成。

**Harness CACHE-08 lifecycle wiring（2026-09-09 11:45:00，进行中）**：checkpoint resume 的首个模型请求现在在生产路径标记 `replayed`；runner continuation 夹具断言该原因出现。新增 runner 配置热重载夹具，验证同 session 换 profile 后首个观测记录 `system_policy_changed`。新增 harness 多工具乱序结果夹具，验证只改变 dynamic suffix、stable prefix 不变、无 invalidation reason 且序列化不含工具参数/结果；continuity repair 的修复请求由 `retryOf` 显式关联到首个 reply 请求。离线/fake provider 的 CACHE-08 请求形态矩阵已覆盖上述组合；harness 61 个文件 549/549、runner 30 个文件 248/248 通过。实际 Provider usage 对账和成本/质量对比仍受凭证与网络条件限制。

**Harness H-OLD-08 并发 Git checkpoint 串行化（2026-09-09 11:34:00，进行中）**：`ShadowGitRepository` 现在按解析后的 `gitDir` 在进程内共享 mutation 队列，并用 `@littlesheep/session` 的跨进程文件锁串行化同一仓库的初始化、add/commit/restore；同一 data root 下多个 coordinator/repository 实例不会再争抢 `index.lock`。runner 并发不同 session 夹具已恢复 versioning 并通过；snapshot 新增两个 coordinator 共享 data root 的并发 checkpoint 夹具和 mutation-lock 等待夹具。snapshot 24/24、runner 30 个文件 247/247、typecheck、`check:repo` 33/33 通过。全仓 410/411 文件通过；`memory-v3-bootstrap` 在 3-worker 负载下超时并触发 SQLite 临时目录 EBUSY，单独重跑 3/3 通过，未发现与本次 snapshot 改动相关的回归。H-OLD-08 已关闭，但 CACHE-08 至 CACHE-10、实际 Provider 对账、生产级 effect crash/replay 和新 Harness 默认切换仍未完成。

**Harness CACHE-08 并发 session 隔离（2026-09-09 09:51:31，进行中）**：新增 runner 夹具并发运行两个 session，验证各自 cache observation 的 scope partition 不同且互不包含对方 session id；夹具关闭 versioning 以隔离缓存行为。该测试同时发现并发 run 在同一 data root 同时执行 versioning Git checkpoint 会争抢 `index.lock`，已登记 H-OLD-08，尚未修复。runner 30 个文件 247 项通过，typecheck 通过。

**Harness CACHE-08 duplicate rewrite lineage（2026-09-09 09:49:50，进行中）**：扩展 runner 的 exact-reply rewrite 夹具，验证 durable model request 记录 `retryOf` 指向同一 run 的前一条请求，重写来源可审计。runner 30 个文件 246 项通过，typecheck 通过。

**Harness origin 覆盖 API（2026-09-09 01:56:25，进行中）**：Local App API `GET/POST /runtime` 新增 `durableHarnessOriginOverrides`，可读取和更新按请求来源的 shadow/next 覆盖；校验非空 origin、shadow/next 值和 256 条上限。app main 71 个文件 271 项通过，app typecheck 通过。

**Harness CACHE-08 5xx 生命周期（2026-09-09 01:54:36，进行中）**：在 model lifecycle 矩阵中加入 Provider 5xx 场景，验证其记录为 `status=failed`、`providerReachStatus=unknown`、`transportStatus=failed`、`usageStatus=unavailable`，且不生成伪造 provider usage。harness 61 个文件 548 项通过，typecheck 通过。

**Harness origin 级灰度（2026-09-09 01:53:26，进行中）**：新增 `agents.defaults.durableHarnessOriginOverrides`，Runner 解析有效模式时优先级为 session override > origin override > 全局；app/CLI 创建 Runner 时传入。新增 runner 夹具验证 `app → next`、`cli → shadow` 以及 session override 优先于 origin。runner/config/cli 35 个文件 321 项通过、1 项 skipped，typecheck 通过。

**Harness replay 使用 per-session 模式（2026-09-09 01:49:32，进行中）**：修正 Runner 内部 `prepareInternalAuthoritativeResult` 仍只看全局 `durableHarnessMode` 的遗漏；完成请求重放现在按 `result.durableHarnessMode` 或 session override 解析有效模式，per-session next 的重放会走 authoritative settlement。新增 runner 夹具验证全局 shadow + session override next 时重放返回 settled reply 且不调用模型。runner 30 个文件 245 项通过，typecheck 通过。

**Harness 渠道发布使用 per-run 模式（2026-09-09 01:45:51，进行中）**：修正 `DefaultChannelManager` 仍只看全局 `durableHarnessMode` 的遗漏；渠道发布现在使用 `result.durableHarnessMode ?? runner.durableHarnessMode`，per-session 灰度到 next 时会走 authoritative settlement。新增夹具验证全局 shadow + 单次 run next 时渠道只发布 settled reply。plugins 7 个文件 79 项通过，typecheck 通过。

**Harness CACHE-08 abort 生命周期（2026-09-09 01:43:50，进行中）**：新增 runner 夹具在 Provider 请求进行中中止，验证 durable model request 记录 `status=aborted`、`providerReachStatus=not_reached`、`usageStatus=unavailable`、`transportStatus=aborted`，cache observation 记录 `provider_request_aborted`，且不生成伪造 provider usage。runner 30 个文件 244 项通过，typecheck 通过。

**Harness 跨 run 缓存失效解释（2026-09-09 01:40:21，进行中）**：`CacheObservationStore.latest()` 返回 scope 内最近一条授权观测；Runner 在构建 RunContext 时读取并作为 `previousCacheObservation`，首次模型请求会与上一条跨 run 观测比较。新增 runner 夹具验证同一 session 从 model-a 切到 model-b 时首次请求产生 `model_changed`。harness 61 个文件 547 项、runner 30 个文件 243 项、app main 71 个文件 271 项通过，types/harness/runner typecheck 通过。

**Harness 累积回归复验（2026-09-09 01:33:49）**：对 `893e1b6`（含 CACHE-05/06/07/08/09 增量、effect 结算、per-session rollout、cache quality API/time window）运行全仓 `pnpm.cmd typecheck` 和 `pnpm.cmd test`；411 个测试文件、2,866 项通过、1 项 skipped，`check:repo` 33/33。该结果证明累积改动没有集成回归，但不改变各 CACHE/阶段完成门状态。

**Harness adapter_changed 失效原因（2026-09-09 01:27:09，进行中）**：`buildCacheObservation` 接受 Runtime 提供的 `adapter` 标识（默认 `llm-chat`），适配器变化现在产生 `adapter_changed`，并新增最小复现夹具；此前该枚举值不可达。harness 61 个文件 546 项通过，typecheck 通过。

**Harness CACHE-09 时间窗报告（2026-09-09 01:22:22，进行中）**：`CacheObservationStore.report()` 新增 `since`/`until` 时间窗过滤，只返回窗口内条目；Local App API `GET /runtime/cache-quality` 接受 ISO 时间或 epoch 毫秒，非法窗口返回 400。harness 61 个文件 545 项、app main 71 个文件 271 项通过，harness/app typecheck 通过。

**Harness next↔shadow 回滚演练（2026-09-09 01:20:14，进行中）**：新增同一 session 的 next → shadow → next 三回合夹具，验证回复顺序无重复、第一回合 durable settlement 与 run_completed 保持完整、第三回合重新走 authoritative settlement。runner 30 个文件 242 项通过，typecheck 通过。

**Harness per-session rollout API（2026-09-09 01:16:42，进行中）**：Local App API `GET/POST /runtime` 新增 `durableHarnessSessionOverrides`，可读取和更新 session 级 shadow/next 覆盖；校验非空 session id、shadow/next 值和 256 条上限，非法值返回 400。app main 71 个文件 271 项通过，app typecheck 通过。

**Harness CACHE-08 附件 manifest 缓存边界（2026-09-09 01:14:46，进行中）**：新增端到端夹具验证附件 manifest 只进入 dynamic suffix，不改变 stable-prefix fingerprint，也不产生 invalidation reason；序列化观测不含附件名或路径。harness 61 个文件 544 项通过，typecheck 通过。

**Harness per-session durable rollout（2026-09-09 01:13:24，进行中）**：新增 `agents.defaults.durableHarnessSessionOverrides`，Runner 按 session 解析有效 `shadow`/`next` 并写入 `RunnerResult.durableHarnessMode`；App/CLI 的 publication、session replay 和 execution-log replay 使用有效模式，未列出的 session 继续使用全局模式。runner 30 个文件 241 项、app main 71 个文件 271 项通过，config/runner/app/cli typecheck 通过。

**Harness durableHarnessMode kill switch（2026-09-09 01:07:29，进行中）**：`agents.defaults.durableHarnessMode` 新增 `shadow`/`next`，默认 `shadow`；Local App API `GET/POST /runtime` 可读取和校验切换，app 与 CLI 创建 Runner 时使用该配置，非法值返回 400。config 18 项、app main 71 个文件 271 项、CLI 相关测试通过，config/app/cli typecheck 通过。

**Harness CACHE-09/10 Local App API（2026-09-09 01:03:55，进行中）**：新增只读 `GET /runtime/cache-quality`，要求显式 `sessionId`、`workspace`、`permission`，使用 Runner 持有的 cache observation key 调用 scope-authorized `report()`；缺少 scope/key 时返回 `unavailable`，不泄露跨 scope 内容。新增 API 夹具验证 scope 透传和默认拒绝。app main 71 个文件 271 项通过，app typecheck 通过。

**Harness CACHE-09/10 报告接入观测存储（2026-09-09 01:01:00，进行中）**：`CacheObservationStore.report()` 在 session/workspace/permission/HMAC scope 授权后扫描观测，跨 scope 条目不会返回；损坏或嵌入 scope 不匹配的条目只把 gate 降级为 `cache_entries_unreadable`，不会当作命中。新增 3 项夹具覆盖双 scope 隔离、未授权 scope 默认拒绝和损坏条目降级。harness 61 个文件 543 项通过，typecheck 通过。

**Harness CACHE-09/10 质量报告基础（2026-09-09 00:59:28，进行中）**：新增 `buildCacheQualityReport`，分别汇总 Provider/Context/Memory 三套 ledger 的 status、token、hitRatio 和 reason，加上 invalidation reason 分布与 durable 延迟摘要；Provider hit ratio 只在完整 usage 下计算，release gate 只返回 `blocked`/`unavailable`，实际 Provider 对账未验证时永不 `ready`。harness 61 个文件 539 项通过，typecheck 通过。

**Harness 请求时间线与延迟摘要（2026-09-09 00:58:06，进行中）**：durable `model request` projection 新增 `startedAt`/`respondedAt`/`settledAt`（来自事件 envelope），并新增 `summarizeModelRequestLatency`：nearest-rank P50/P95/max 与 received/pending/aborted/failure 计数；缺失、非法或负时长计为 `unavailable`，不伪造延迟。harness 60 个文件 534 项、runner 30 个文件 240 项通过，types/harness/runner typecheck 通过。

**Harness CACHE-08 working-set 释放缓存边界（2026-09-09 00:53:52，进行中）**：新增端到端夹具验证释放 Atom 后系统消息移除该 Atom 正文，stable-prefix fingerprint 不变，dynamic suffix 变化，失效原因明确为 `memory_revision_changed`，序列化观测不含 Atom 正文。harness 59 个文件 529 项通过，typecheck 通过。

**Harness CACHE-08 记忆注入缓存边界（2026-09-09 00:52:43，进行中）**：新增端到端夹具验证 `injectMemoryKnownState` 注入的 KnownState 只改变 dynamic suffix，不改变 stable-prefix fingerprint；序列化观测不含 atom id 或 KnownState 正文。harness 59 个文件 528 项通过，typecheck 通过。

**Harness cancelled effect 结算（2026-09-09 00:50:02，进行中）**：补齐 `cancelled` 终态。effect intent 已耐久、但 Run 在工具调用前已中止时，工具零调用，effect 结算为 `cancelled`，checkpoint store 接受该状态，projection 只把 `in_progress`/`unknown` 视为 uncertain。execute 44 项、durable-kernel 18 项、runner 30 个文件 240 项通过，types/harness/runner typecheck 通过。

**Harness CACHE-08 工具结果/工具循环矩阵（2026-09-09 00:44:59，进行中）**：新增夹具验证工具调用与工具结果始终进入 dynamic suffix，两轮工具循环后 stable-prefix fingerprint 保持不变且无 invalidation reason，序列化不含工具参数或结果正文；工具 schema 增删仍按 `tool_schema_changed` 失效。harness 59 个文件 525 项通过，typecheck 通过。

**Harness effect 结算语义修正（2026-09-09 00:43:19，进行中）**：区分执行前拒绝与执行后结果不明。effect intent 已耐久、但 pre-effect checkpoint 失败时工具零调用，durable `effect_settled` 现在写入 `failed`（而不是 `unknown`），projection 不再进入 `unknownEffectIds`/`waiting_user`，run 可正常收尾；工具实际执行后返回非成功结果仍保持 `unknown`。execute 43 项、durable-kernel 17 项、runner 30 个文件 240 项通过，harness typecheck 通过。

**Harness CACHE-05 失效原因补全（2026-09-09 00:34:29，进行中）**：`manual_clear` 与 `replayed` 不再只是枚举值：`buildCacheObservation` 接受 Runtime 提供的 `manualClear`/`replayed` 标记，即使没有 previous observation 也会记录对应原因，并按稳定顺序生成 primary reason；新增最小复现夹具验证两个原因不改变 stable prefix 字节、可单独或同时出现。harness 59 个文件 522 项通过，typecheck 通过；生产端手动清理/重建调用方仍需接线。

**Harness CACHE-06 observation-store 隔离矩阵（2026-09-09 00:32:48，进行中）**：新增 2 session × 2 workspace × 3 权限共 12 个 scope 的完整隔离矩阵夹具，验证 partition digest 与 stable-prefix fingerprint 两两不同、并发写入和交叉读取不会返回其他 scope 的 observation、store 重启后隔离保持、嵌入 scope 被篡改的条目在命中前以 `scope_scope_mismatch` 拒绝，以及所有落盘文件不含 session、workspace 或用户正文。harness 59 个文件 520 项通过，typecheck 通过；CACHE-06 跨 Context/Atom/tool-result 的完整隔离仍需在 CACHE-08 请求形态矩阵中验证。

**Harness CACHE-07 本地/Provider 对账 durable 对齐（2026-09-09，进行中）**：durable `provider usage` projection 现在携带同一请求的本地精确 tokenizer 校准（`tokenizerId`、`localPromptTokens`、`differenceTokens`、`relativeDifference`、`status`），codec 会校验差值、相对差和 `status`/`reconciliation` 映射，拒绝缺少证据或自相矛盾的 payload。新增 8 项夹具覆盖 `exact_match`、`within_tolerance`、`mismatch` 和篡改拒绝，并验证 durable projection 与 Context snapshot 的 `localCalibration` 逐字段一致、事件流不含 prompt/正文。harness 58 个文件 515 项、runner+types 37 个文件 266 项、app main 70 个文件 270 项均通过；全量回归 407 个文件、2,832 项通过、1 项 skipped，`pnpm.cmd typecheck`、`pnpm.cmd run check:repo`（33/33）通过。该增量只完成离线本地/Provider 账本对齐，实际 Provider usage 对账、CACHE-08 至 CACHE-10、生产级 effect crash/replay、真实渠道重连和新 Harness 默认切换仍未完成。

**Harness durable settlement/replay 收尾增量（2026-09-05 12:21:57，冻结候选）**：next Harness 的 FINALIZE 现在先持久化审计事实，再由 Runner 统一完成 final-reply settlement；execution log、session transcript 和 conversation source 使用同一 settlement identity，启动恢复可修复“事件已落盘但注册表未结算”的中间态，无法证明结算时只保留 Runtime status。Local App 普通 POST/SSE 与 checkpoint resume SSE 在 Runtime status 路径会清掉临时流文本，历史/Context 投影过滤未结算 proposal；本轮定向回归 3 个相关文件、85 项通过，既有 API 流回归 4 个文件、94 项通过；全量回归 406 个测试文件、2,824 项通过、1 项 skipped，`pnpm.cmd typecheck`、`pnpm.cmd run check:repo` 和 Electron production build 均通过。缓存观测仍只是脱敏 observation store，不是 Context/Provider cache reuse；CACHE-06 至 CACHE-10、实际 Provider usage 对账、生产级 effect crash/replay、真实渠道重连和新 Harness 默认切换仍未完成，不能据此宣称缓存问题或 Harness 重构已解决。

**Harness/cache production observation path（2026-09-03 19:14:26，进行中）**：`CacheObservationStore` 已由 Runner infrastructure 创建并接入真实模型请求生命周期。prepared、Provider usage、Provider failure 和 terminal settlement 共享同一 request-bound、HMAC 脱敏 observation；settlement 等待 observation persistence，但持久化故障只记录 cache-quality warning，不改变 Provider 请求、工具执行或用户回复语义。真实 Runner 回归已验证 data-root 重启后查询、session/workspace/permission 隔离、Provider usage 缺失保持 `unavailable`、失败写入不阻断成功回复，以及磁盘内容不含 prompt、用户正文、工具参数或 Provider 原始 JSON。该 store 仍是观测存储，不是 Context cache reuse，也没有把 observation hit 伪装成 Context/Provider 命中；当前工作树完整门为 405 个测试文件、2,808 项通过、1 项 skipped，workspace typecheck、repo hygiene 33/33、Electron production build 和 `git diff --check` 均通过。CACHE-06 完整隔离、CACHE-07/08/09/10、实际 Provider usage 对账、effect crash/replay 和新 Harness 发布门仍未完成。

**Harness/cache 本轮耐久性与观测适配器增量（2026-09-03 17:37:00，进行中）**：effect intent/settlement 语义已收紧：intent 追加无法确认时工具零调用；工具返回后的 settlement 先于 post-effect checkpoint 持久化，checkpoint 失败不会把已确认副作用降级为 `unknown`；settlement 追加结果无法确认时不再补写可能冲突的第二个 settlement。新增 `CacheObservationStore`，只保存经过 codec 校验的脱敏 cache observation，按 session/workspace/permission/HMAC scope 隔离，支持重启、TTL、并发写入和跨 scope 回归；它仍是观测存储，不是 Context prompt payload 复用器，尚未接入真实 Runner/Context cache reuse。定向回归为 execute 42/42、cache observation/scope 17/17，Harness typecheck/build 通过。CACHE-06 完整安全夹具、CACHE-07/08/09/10、实际 Provider usage 对账、生产级 effect crash/replay 和新 Harness 发布切换门仍未完成，不能据此宣称 Harness/cache 重构完成。

**Harness/cache 观测增量（2026-09-03 17:42:56，进行中）**：修正 LS Context cache ledger 的发布语义：`prepareModelRequest()` 完成 Context 组装并不等于本地缓存命中或未命中；在 Context Engine 没有发出真实 cache observation event 前，`lsContext` 现在保持 `status=unavailable`、`reason=context_cache_event_not_observed`，Memory/Embedding ledger 同样保持 `unavailable`，不再用组装动作冒充 miss。模型请求快照和 durable `model_request_*` 事件新增显式 `retryOf` lineage，覆盖 JSON 解析重试、重复文案重写、连续性/引用修复和执行回复修复；重试 parent 在同一 run 内校验，Kernel 拒绝自指或未知 parent。单 worker 全量 `pnpm.cmd test -- --no-file-parallelism --maxWorkers=1` 通过 405 个测试文件、2,804 项测试，1 项 skipped；`pnpm.cmd typecheck`、`pnpm.cmd run check:repo`（33/33、28 个 project references）和 `git diff --check` 也通过。该增量只改善观测真实性与可回查性，不代表 CACHE-06 至 CACHE-10、实际 Provider usage、effect lifecycle 或新 Harness 发布切换门完成。

**新 Harness 统一发布边界复验（2026-09-03 11:48:20，进行中）**：`durableHarnessMode=next` 已在 Runner 暴露统一的 authoritative publication adapter；Local App 普通 POST/SSE、checkpoint resume SSE、CLI、ChannelManager 以及通用 `/runs/:id` replay 都只使用 durable final-reply settlement，未结算 proposal 或 execution-log 临时文本会降级为 Runtime status。历史重建要求 transcript settlement 与 execution-log settlement identity 一致后才恢复文本，legacy/shadow 路径保持兼容。新增 API、历史和 Runner 回归后，当前工作树 `pnpm.cmd typecheck`、`pnpm.cmd run check:repo`（33/33、28 个 project references）和 `pnpm.cmd test`（404 个文件、2,795 passed、1 skipped）均通过。该增量仍不等于 Harness 重构完成；effect intent/settlement、真实渠道重连、CACHE-06 至 CACHE-10、实际 Provider usage 与发布切换门继续保持进行中。

**旧 Harness 用户证据夹具（2026-09-02 18:42:00）**：用户提供的真实对话记录显示，连续询问“你能调用网络了吗/现在呢/你查询过了/基于事实因此你需要查询”时，旧 Harness 将内部“思考”、`轻量任务 · 1 步`、目标、验收标准、完成和“验证通过”直接投影到对话区；同一能力清单跨时间重复注入；用户要求实际查询后没有可回查的权威工具事件，却出现了仿佛真实 Runtime 错误的自然语言；用户表示已给权限，也没有形成可验证的权限状态变更。该证据不证明当时网络实际可用或不可用，但证明输出分层、事实来源、权限状态、重复去重和能力缓存失效存在 Harness 级缺口。固定复现与修复门见[新 Harness 重建与 Prompt Cache 收敛任务书](../taskbooks/harness-rebuild-and-cache-taskbook-2026-09-02.md)。

**旧 Harness 冻结与新 Harness 缓存专项（2026-09-02，冻结准备）**：本工作树包含上一阶段的 UI、网络检索、Memory v3、权限、Runtime 连续性和 Harness 变更；本次冻结只保存已经实现的源码、测试与正式文档，发布暂存目录、构建输出和一次性调试脚本不进入版本基线。旧 Harness 当前仍是围绕可变 `RunContext` 的多阶段循环，普通 checkpoint 主要在 `harness.run()` 返回后统一生成；流式 delta、执行最终回复、VERIFY `final_delta` 和 Renderer 归并仍存在多条用户可见输出路径，历史工具时间有近似计算，FINALIZE 会话持久化失败也未必阻止运行被报告成功。这些问题在冻结时作为已知缺陷保留，旧实现只作为可回滚路径，不宣称已经修复。

**缓存根因当前未定**：`@littlesheep/llm` 已能解析 Provider 返回的 `prompt_cache_hit_tokens`/`cached_tokens`，但当前没有脱敏的请求前缀指纹和可比较的真实命中基线。Prompt boundary marker 只是装配约定；不同 stage 使用不同 system prompt，memory root index 仍可能位于稳定段，`prepareModelRequest()` 还会按运行态追加 Memory KnownState、runtime awareness、工具 schema 与阶段约束，因此不能把低命中率归因于单一 Context 模块。Provider prompt cache、LS 本地 Context cache 和 Memory/Embedding cache 必须分开报告；新 Harness 任务书将以实际 Provider usage、稳定前缀设计、确定性序列化、显式失效原因和跨 session/workspace/权限域安全隔离作为 P0 验收，不以缺失指标时的估算冒充命中率。

**实时网络检索专项当前网络与发布门复验（2026-09-02，实施中）**：默认 `system` DNS 当前将 `example.com` 解析到 `198.18.0.73`，即 `198.18.0.0/15` 保留基准测试网段；Runtime 必须在 HTTP 前继续以 `blocked/web_ssrf_blocked` 拒绝，不能放宽 SSRF、TLS、IP pinning 或 redirect 复核。显式、固定的 `cloudflare_doh` 解析模式已在同一机器通过独立 `verify:web-fetch`：HTTP 200、`readability`、`externalUntrusted=true`、未截断、Runtime citation 和 `completeness=complete`。这证明受控匿名 public-fetch 路径当前可用，但不替代同一持有 Tavily key 进程的真实 Tavily search -> 规范结果 fetch -> citation，也不替代真实网页 evidence 驱动的 LLM 回复。当前 Codex 进程没有 Tavily key；执行 DoH Provider smoke 在 Provider 请求前安全 `setup/skipped`，没有消耗额度。专项离线发布门本轮串行通过：`verify:web-release` 的 Provider/Tavily 边界 19/19、渠道/loopback Webhook 31/31、LLM boundary 1/1、live verifier boundary 3/3、迁移/回退及 240 个构建文本文件零敏感命中均通过。实际 Provider 端到端、正式渠道、签名最终包和干净 Windows 生命周期仍是发布阻断，不能标记为 ready。

**实时网络检索专项当前复验（历史记录：2026-09-01 23:22:48，实施中）**：当前工作树重新通过 `verify:web-release`（Provider/Tavily 19/19、渠道 projection/loopback Webhook 31/31、LLM boundary 1/1、live verifier boundary 3/3、迁移/回退、240 个构建文本文件零敏感命中）、`check:repo`（33/33）和 `verify:web-performance`（48 次隔离迭代、P95 0.35ms、heap delta 1,025,128 bytes、Provider 48、HTTP 1、缓存命中 47）。当时 `verify:web-fetch` 在 system DNS 下短暂通过 HTTP 200、readability、`externalUntrusted`、Runtime citation 和 complete evidence；显式 `cloudflare_doh` 当时在 HTTP 前返回 `blocked/web_dns_check_failed`。这些都是历史网络瞬态，当前应以本页顶部的 2026-09-02 记录为准。DeepSeek API 实测 V4 Flash 对合成 partial/truncated、rate-limit、fetch-timeout、disabled evidence 的生产 final reply 复验通过；Electron 状态连续性串行复验通过，恢复草稿、会话/项目折叠、侧栏 249、文件导航 286、浏览器设置页、原生窗口和聊天底部 137px 间距。期间并行触发两个 App build 曾造成一次构建输出短暂不可见，串行复验已排除该构建竞态。当前进程没有 Tavily key，故尚不能复验真实 Tavily 搜索结果 fetch/citation 或网页 evidence LLM；QQ、飞书、Telegram、外部反向代理 Webhook、签名最终包和干净 Windows 生命周期仍未完成，专项继续保持实施中。

**实时网络检索专项渠道投影收口（2026-09-01 22:46:00，实施中）**：修复共享文本来源 formatter 未显示 `fetchedAt`、且 `citationCount=0` 的 disabled/unconfigured/rate-limit evidence 被静默丢弃的问题。CLI、Webhook 和其他文本渠道现在显示来源抓取时间，或在没有来源时显示脱敏的失败状态，不暴露网页正文、原始 query 或 `web_*` 内部错误码。新增真实本机 Webhook 组合验收，经过临时 binding store、`DefaultChannelManager`、loopback `WebhookChannelPlugin` 与 HTTP POST 验证 `RunnerResult.webEvidence` 的来源/时间/partial/truncated/blocked/citation 投影。`verify:web-channel-boundary` 31/31、补充渠道集合 61/61、相关 package typecheck 和更新后的 `verify:web-release` 已通过。该结果不使用外网或第三方账号；QQ、飞书、Telegram、外部反向代理 Webhook、签名包、干净 Windows 以及真实 Tavily→fetch→citation→LLM 仍未完成，专项继续保持实施中。

**实时网络检索专项参数转发修复（2026-09-01 22:30:00，实施中）**：修复 `verify-web-live-llm-evidence.mjs` 对 pnpm 转发分隔符位置的错误假设；当 package script 固定追加 `--require-live` 后，`pnpm.cmd run verify:web-live-llm-evidence -- --dns-resolver=cloudflare_doh` 现在可正确解析并在缺少 Tavily key 时返回预期的脱敏 `status=skipped`，不再返回 `unexpected_failure`。新增测试后 live verifier boundary 为 3/3，`verify:web-release` 重新通过（Provider/Tavily 19/19、LLM boundary 1/1、live boundary 3/3、迁移回退、构建产物扫描）。当前 PowerShell 没有 Tavily key，固定 Cloudflare DoH 仍在 DNS 阶段失败；真实 Tavily search→fetch→citation、真实网页 evidence LLM、正式渠道、签名包和干净 Windows 生命周期仍未完成，专项继续保持实施中。

**实时网络检索专项全量门复验（2026-09-01 21:40:00，实施中）**：当前工作树执行 `pnpm.cmd run verify:full` 已通过 389 个测试文件、2,654 项测试通过、1 项 skipped；workspace TypeScript 构建、App production build 和 recovery 均通过。Recovery 仍保留 3 个历史 sampled runId 缺失 execution log、以及用户布局快照包含非默认外部 root 两类 warning；没有证据表明它们属于 Web run，未把 warning 改写为无告警。随后 `pnpm.cmd run verify:web-performance` 通过 48 次隔离迭代，P95 1.07 ms、heap delta 1,070,304 bytes、Provider calls 48、HTTP calls 1、cache hits 47，外部网络请求为 0。真实 Tavily search→fetch→citation、真实网页 evidence LLM、正式渠道、签名包和干净 Windows 生命周期仍未完成，专项继续保持实施中。

**实时网络检索专项最新复验（2026-09-01 21:14:05，实施中）**：当前进程没有 `TAVILY_API_KEY`/`LS_TAVILY_API_KEY`；活动用户数据根的脱敏配置为 `web.enabled=true`、`defaultProvider=null`、`providers=[]`、`dnsResolver=system`，没有从数据根读取或复制密钥。显式执行 `pnpm.cmd run verify:web-provider -- --dns-resolver=cloudflare_doh --require-live` 在 Provider 请求前安全返回 `setup/skipped`，没有消耗 Tavily 配额；独立 `pnpm.cmd run verify:web-fetch -- --dns-resolver=cloudflare_doh` 在 HTTP 前返回 `blocked/web_dns_check_failed`。固定 Cloudflare DoH 路径在当前网络不可达，本机仍有 Vortex helper/TUN 代理环境。该结果属于外部网络前置条件阻断，不是 Tavily auth 或 SSRF 逻辑故障；不得通过降低 TLS/SSRF/IP pinning、修改 hosts、固定目标 IP 或接受任意代理/resolver 绕过。真实 Tavily search→fetch→citation、真实网页 evidence LLM、正式渠道、签名包和干净 Windows 生命周期仍未完成，专项继续保持实施中。

**实时网络检索专项最新复验（2026-09-01 20:45:00，实施中）**：将 Main-owned Provider 检查的状态、并发 Promise 合并和 generation 失效校验提取到 `packages/app/src/main/local-app-api/web-provider-check.ts`；Web 配置或 Runner 热替换后，旧检查结果不会重新发布为当前 `ready`，Runtime 路由不再重复写回过期结果。新增竞态回归后，Provider/UI 定向测试为 10/10，Web 相关定向集合为 7 个文件、54/54；`check:repo` 通过 33/33 和 28 个 TypeScript project references，App typecheck、App production build、`verify:web-release` 和 `git diff --check` 均通过。`verify:full` 随后通过 389 个测试文件、2654 项通过、1 项 skipped，workspace build、App build 和 recovery 通过；`verify:web-performance` 通过 48 次隔离迭代（P95 0.85ms、heap delta 1,053,808 bytes、Provider 48 次、HTTP 1 次、缓存命中 47 次）；DeepSeek API 实测 V4 Flash 的 `execute_final_reply` evidence 门四场景通过，但外部 Web 请求为 0，不替代真实 Tavily evidence 联调。修复 CDP 默认 execution context 握手后，Electron 状态连续性串行通过，恢复草稿、会话/项目折叠、侧栏 249、文件导航 286、浏览器设置页、原生窗口和聊天底部 137px 间距。当前进程严格执行 `pnpm.cmd run verify:web-provider -- --require-live` 在 Provider 请求前因 Tavily key 不存在安全返回 `setup/skipped`，没有新增实际 Provider 请求；用户终端此前已取得真实 Tavily search 证据，但默认 DNS 下搜索结果关联 fetch 仍被正确阻断为 `web_ssrf_blocked`。真实 Tavily search→fetch→citation、真实网页 evidence LLM、Provider 真实失败状态、正式渠道、签名最终包和干净 Windows 安装/升级/卸载仍是发布阻断，专项继续保持实施中。

**实时网络检索专项当前网络复核（2026-09-01 21:02:00，实施中）**：实际用户数据根只含 `DEEPSEEK_API_KEY`，`web.enabled=true` 但没有默认 Tavily provider，故此前 Tavily search 的成功证据来自用户终端的临时环境变量，不是当前 LS 持久化配置。当前进程使用 Cloudflare DoH 的严格 Provider smoke 在无 key 时安全 `setup/skipped`；独立 public fetch 则在 HTTP 前以 `web_dns_check_failed` 失败。只读诊断表明固定 Cloudflare DoH IP `1.1.1.1:443` 不可达，直接 DoH HTTPS 请求出现 TLS 连接失败，Windows 代理仍登记为 `127.0.0.1:7897`。这属于当前网络路径阻断，不得通过降低 TLS/SSRF/IP pinning、固定 IP、修改 hosts 或接受任意 proxy/resolver 解决。需要在可直连固定 DoH 的可信网络，或恢复真实公网解析的代理/TUN 模式后，以隔离 Tavily key 重跑 search→fetch→citation。

**实时网络检索专项配置入口与显式检查复验（2026-09-01，实施中）**：检查实际用户数据根发现 Web 配置虽为 `enabled=true`，但 `web.providers=[]`、没有 `defaultProvider`，密钥库只有 `DEEPSEEK_API_KEY`；原有网络设置页无法真正完成 Tavily 装配。本轮新增 Main-owned `/config/web-provider` 路由和网络设置页 Tavily 输入，密钥进入 Electron `safeStorage`，配置只保存 `$TAVILY_API_KEY`，保存后热重建 Runner 且不自动开启网络；另新增固定 `/runtime/web/provider-check` 路由，只有用户主动检查且网络已启用时才执行一次最小 Tavily 搜索，成功才显示当前运行时 `ready`，配置变化/Runner 重建/重启后清除检查状态。配置辅助逻辑、keychain、Tavily、Provider smoke、设置状态和 provider-check 共 5 个测试文件 35/35 通过；App typecheck、`build:app`、`check:repo` 33/33 和 `git diff --check` 通过。当前没有向实际用户数据根注入 key，也没有宣称真实 Tavily search->fetch->citation 已完成；正式渠道、签名最终包和干净 Windows 生命周期仍是发布阻断项。

本文件是项目进度的正式来源。状态只根据当前源码、测试和构建结果维护；旧的阶段报告不再作为进度依据。当前实现若处于未完成重构或质量检查失败状态，必须明确写成“进行中”，不能沿用最近一次绿色基线冒充当前状态。

**最新复跑覆盖（2026-08-04 09:31:50）**：当前提交的实际 Electron 进程 + DeepSeek API 三工具矩阵为 `glob 630 + 379 = 1,009`、`grep 646 + 333 = 979`、`read 632 + 292 = 924` Prompt Token，每项均为 2 次 API、1 次工具、`exact_match`、工作区哈希不变、结构 VERIFY 通过。同次复跑的跨重启续答为 1 + 1 次 API、Prompt `974 / 1,286`、最终 `supported`；后台九场景恢复任务为 2 次 API、`write/read` 各一次、耗时 `6.863s`、权威 Provider usage 为 prompt `5,477` / completion `934` / total `6,411`。这些点值会随运行时间和 LLM 输出小幅波动；持续回归契约以 `2 API / 1 tool` 和总 Prompt 不超过 `1,200` 为准。表格中带时间的旧点值保留为可复现历史快照，不代替这一段当前证据。

**本轮仓库与桌面复验（2026-08-04 10:09:20）**：仓库卫生 `33/33`、27 包 TypeScript 检查、Electron 生产构建与恢复源检查通过；全量测试为 263 个文件、`1865 passed / 1 skipped`。隔离数据根的实际 Electron 进程 七场景再次通过，共 14 次确定性 Provider 请求，覆盖跨重启回答连续性、活动任务 SSE、关闭到托盘并恢复、暂停/继续、暂停后强制终止与 Checkpoint 续跑、运行时模型热重载和中断 Checkpoint；最终回答连续性为 `supported`，来源为 `recent_history`。

**Git 审阅模块复验（2026-08-04 14:24:22，界面与性能契约于 2026-08-14 更新）**：稳定工作树上的历史全量测试为 272 个文件全部通过，`1900 passed / 1 skipped`；本轮工作区/Git/字体定向回归为 16 个文件、76 项全部通过，仓库卫生 `33/33`、App TypeScript 检查、Electron 生产构建、构建新鲜度与 `git diff --check` 通过。隔离数据根的实际 Electron 进程 已验收 staged/unstaged/untracked 分层、稀疏目录树、目录聚合统计、双行号红绿 diff、rename/delete/binary、分支 upstream 与 ahead/behind、手动刷新、文件工作台精确路径、窄面板与全屏切换。审阅与普通文件查看统一为 Monaco 主区加右侧共享导航，支持持久化单列/双列；代码查看、编辑和 Git Diff 共享 `13px` 字号与 `23px` 行高，Markdown、Office 和图片预览保持独立。可见且展开的普通文件导航在 React 挂载前加入同一个有界根目录请求，审阅页或折叠状态不扫描目录；最新隔离验收的文件树冷/热为 `347.8/23.2 ms`，Monaco 首次着色为 `399.2 ms`，审阅树冷/热为 `645.9/31 ms`，隐藏 5 秒 CPU/I/O 为 `15.6 ms/0 bytes`，所有既定预算通过。旧“更改/现场”子页切换已删除，任务恢复现场仍由独立 Runtime 恢复控制面提供；完整构建和实机数字以拓展工作区性能任务书为准。

**实时网络检索专项（2026-08-30 20:44:08，实施中）**：`web_search`、`web_fetch`、可替换 SearchProvider、匿名受控 HTTP(S) 读取、SSRF/DNS/重定向/资源限制、引用与有界证据投影、Memory-first 协同、设置/API/UI/CLI/渠道 formatter 已完成代码和离线验收。公共网络只读与本地记忆查询均属 safe read，免除逐次批准；这不免除显式网络启用、最小化 query 外发、敏感查询策略、配额、审计、SSRF 硬规则，且浏览器、登录态、验证码、写入与执行仍沿用独立审批。已通过配置迁移/回退、关闭后零 Provider 请求、历史 checkpoint 兼容、构建产物泄露扫描、供应链快照、Runtime 性能基线、Electron 状态连续性和离线渠道投影门；历史 `https://example.com/` 匿名 public-fetch smoke 曾通过。当前环境复验时系统 DNS 将该域名解析为保留的 `198.18.0.82`，Runtime 在 HTTP 前正确返回 `blocked/web_ssrf_blocked`，故当前环境不能重新证明安全公共 fetch，且不得通过放宽 SSRF/DNS 规则伪造通过。public-fetch smoke 现允许一个最多 4,096 字符的 `--url=https://<public-anonymous-page>/` 替代输入，未知参数在网络初始化前失败且不回显；该输入仍完整受 URL/DNS/IP/redirect/资源上限控制，不是绕过入口。新增的 smoke 输出/参数边界和 Tavily 401/403/429/500 映射回归 16/16、`verify:web-release`（含该回归、迁移/回退和构建目录扫描）与仓库卫生 33/33 已通过；两条 smoke 只投影 origin、长度/hash、citation metadata 和白名单稳定错误，不暴露完整 URL、原始错误、query 或凭证。`DefaultChannelManager` 另有 manager 级回归验证真实 `RunnerResult.webEvidence` 到渠道消息的来源/partial/truncated/blocked 安全投影；DeepSeek API 实测 Pro 还通过生产最终回复对合成 partial/truncated、限流、超时、关闭 evidence 的隔离验收，期间发现并修复 `errorKinds` 进入模型提示的泄露路径。此前 `verify:full` 通过（378 个测试文件、2610 项通过、1 项 skipped），同时通过性能、Electron UI、依赖审计和构建目录扫描；recovery 有少量 sampled execution log 缺失和非默认 workspace root warning，但未使 gate 失败。当前没有 Tavily 测试 key，且当前 DNS 不满足 public-fetch smoke；真实 Tavily search/citation、真实 Tavily evidence 驱动的端到端 LLM 回复、QQ/飞书/Telegram/Webhook 正式通道、签名最终安装包以及干净 Windows 安装/升级/卸载尚未完成。发布脚本的共享 staging 竞态已修复为发布锁、唯一 staging、临时 builder 配置和本地 prepared Electron runtime，并通过发布脚本单测与锁冲突快速路径验证；当前 release 候选已扫描通过（659 个文件、14363 个 `app.asar` 归档条目、0 个敏感命中），但安装器仍未签名，不能替代正式包。专项不得标为 `ready` 或发布。详见[实时网络检索与安全读取任务书](../taskbooks/web-search-and-safe-retrieval-taskbook-2026-08-28.md)和[发布清单](../reference/web-retrieval-release-checklist-2026-08-29.md)。

**实时网络检索专项补充（2026-08-30 21:47:49）**：上段“当前没有 Tavily 测试 key”的运行环境描述已不再适用。用户终端的测试 key 已严格验证一次真实 Tavily search：关闭网络零请求通过，1 次 Provider 请求返回 3 个非缓存、非 partial 的归一化结果。搜索结果关联 fetch 随后被当前 DNS/SSRF 环境以 `web_ssrf_blocked` 正确阻断；因此 Provider 认证与搜索已获证据，但 search-result fetch、Runtime citation、真实 Tavily evidence 驱动的端到端 LLM 回复、正式渠道、签名最终安装包和干净 Windows 验收仍未完成，专项继续为“实施中”。本轮 `verify:full` 为 385 个测试文件全部通过、2630 项通过、1 项跳过；其间发现并修复桌面启动标题栏颜色与最大化恢复就绪时序的两处不一致，当前 `verify:web-release` 也通过 17 项 Provider/public-fetch 边界、1 项 LLM verifier 边界、迁移/回退与 238 个 build 文本文件的零敏感命中扫描。

**实时网络检索专项最新复验（2026-09-01 11:25:27，实施中）**：当前稳定工作树的 `pnpm.cmd run verify:full` 已通过，结果为 387 个测试文件、2642 项通过、1 项跳过，仓库卫生 33/33、28 个 workspace TypeScript 项目、App build 和 recovery 均通过；全量门运行前后 5 个 UI 文件指纹未变化。随后串行通过 `verify:web-release`（18 项 Provider/public-fetch 边界、1 项 LLM verifier 边界、迁移/回退、238 个构建文本文件四类敏感命中为 0）、`verify:web-performance`（48 次隔离迭代，P95 0.31ms，heap delta 1,095,592 bytes，HTTP 读取 1 次、缓存命中 47 次）、`verify:electron-ui-state-continuity`（草稿、折叠状态、侧栏/文件导航宽度、设置页、原生窗口和 137px 聊天底部阅读间距恢复）以及 `verify:web-llm-evidence`（DeepSeek API 实测 V4 Flash 对合成 partial/truncated、rate-limit、fetch-timeout、disabled Runtime evidence 四场景）。Electron 连续性夹具已与 120ms resize settle 契约对齐，并显式派发用户滚动事件，仍要求最终锚点误差不超过 1px。当前 Codex 进程没有 Tavily、渠道或代码签名凭证，只有 DeepSeek key；用户终端已证明 Tavily search，但当前 DNS 将公开域名动态改写到保留的 `198.18.0.0/15` 网段（本轮为 `198.18.0.132`，此前为 `198.18.0.82`），因此真实搜索结果 public fetch/citation 仍被正确阻断为 `web_ssrf_blocked`。不得放宽 SSRF、使用 hosts/固定 IP/代理绕过。真实 Tavily + 网页 evidence 的端到端 LLM、Provider 真实失败状态、QQ/飞书/Telegram/Webhook 正式发送接收、签名最终包和干净 Windows 安装/升级/卸载仍是发布阻断，专项不能标记为 `ready`。

**实时网络检索专项 DNS 诊断补充（2026-09-01 11:53:55，实施中）**：用户第二次严格运行 `verify:web-provider -- --require-live` 仍得到 Tavily search 通过、`public-fetch-and-citation` 在 HTTP 前以 `web_ssrf_blocked` 阻断。只读系统检查确认 Windows 系统代理为 `127.0.0.1:7897`，监听进程为 `com.vortex.helper`；活动 `Meta Tunnel` 使用 `198.18.0.1` 作为 DNS，抽样公共域名全部映射到 `198.18.0.x`。因此 Tavily API key 已配置并可用，剩余失败是 Vortex TUN/Fake-IP 与严格 SSRF/IP pinning 的兼容问题。隔离原型通过固定可信 HTTPS DNS 端点取得真实公网地址后，继续执行现有公网 IP 校验、TLS SNI/Host 与地址锁定请求，获得 HTTP 200；该结果只登记为显式 trusted-DoH 兼容方向的可行性证据，不进入生产实现，也不替代真实 Tavily search→fetch→citation 验收。当前不得重复消耗 Tavily 配额；应先临时关闭 Fake-IP 或切换到返回真实公网地址的 real-IP/redir-host 等价模式，确认 DNS 正常后再复验。若正式实现 DoH fallback，必须新增明确配置与隐私披露，并保持固定 resolver、响应上限、超时/取消、全部 A/AAAA 校验、redirect 重检和 `198.18.0.0/15` hard deny。

**实时网络检索专项 smoke 配额保护（2026-09-01 12:16:31，实施中）**：严格 Provider smoke 已在真实 Tavily search 前加入 `public-fetch-preflight`。该步骤复用生产 `validatePublicUrl` 的域名、DNS 和公网 IP policy，只做解析检查，不发页面 HTTP、不生成 citation，也不占用 Provider 请求。当前 Fake-IP 环境使用无效占位 key 的复验结果为 `stage=public-fetch-preflight`、`blocked/web_ssrf_blocked`、`providerRequests=0`；随后 `verify:web-release` 全门通过，包括 Provider/public-fetch 边界 18/18、LLM verifier 边界 1/1、迁移/回退和 238 个构建文本文件零敏感命中扫描；脚本语法和仓库卫生 33/33 也通过。正常 DNS 环境仍继续原有真实 Tavily search、搜索首条规范 URL fetch 和 Runtime citation 验证，因此此优化只防止已知坏环境浪费配额，不降低发布门。

**实时网络检索专项显式 DoH 复验（2026-09-01 15:09:31，实施中）**：补齐 smoke 参数边界回归后，显式 `cloudflare_doh` 模式和任意 resolver endpoint 拒绝均有测试证据。当前默认 `system` DNS 在 Fake-IP 环境中仍将 `example.com` 解析到 `198.18.0.132`，`pnpm.cmd run verify:web-fetch` 在 HTTP 前正确返回 `blocked/web_ssrf_blocked`；使用 `pnpm.cmd run verify:web-fetch -- --dns-resolver=cloudflare_doh` 则真实通过 HTTP 200、readability 抽取、`externalUntrusted=true`、未截断、Runtime citation 和 complete evidence。该模式是显式固定 Cloudflare DoH endpoint/IP 的生产配置，继续执行 A/AAAA、响应大小、事务、超时/取消、TTL、公网 IP、TLS SNI/Host、IP pinning 和 redirect 检查，不是静默 fallback，也不接受调用方 endpoint。当前 Codex 进程无 Tavily key，故真实 Tavily search→fetch→citation 仍需在拥有测试 key 的用户终端执行 DoH 版本；正式渠道、签名最终包和干净 Windows 安装/升级/卸载仍是发布阻断。

**实时网络检索专项本轮收口复验（2026-09-01 16:51:16，实施中）**：修正了 `control-surface-style.test.ts` 中已删除的 `.settings-sidebar::before` 断言，以及 Electron 连续性脚本中对 keep-mounted Settings presence 的错误卸载假设；同时修正 ChatView resize repair 对陈旧 sticky 状态的误判，并让新的用户滚动取消旧 timer。相关 UI 定向回归 28/28、实际 Electron 进程 状态连续性通过，结果为 composer draft、conversation/project 折叠、侧栏 249、文件导航 286、浏览器设置页、原生窗口和聊天底部 137px 阅读间距均恢复。随后最新 `verify:full` 通过 389 个测试文件、2649 项通过、1 项 skipped；`verify:web-release`、`verify:web-performance`（48 次隔离迭代、P95 0.45ms、heap delta 1,027,064 bytes、HTTP 1 次、缓存命中 47 次）、DeepSeek API 实测 V4 Flash 合成 evidence 四场景和依赖门也通过。当前进程没有 Tavily、正式渠道或代码签名凭证；因此真实 Tavily search→fetch→citation、正式渠道、签名包和干净 Windows 发布仍未完成，专项继续保持实施中。

## 总体判断

LittleSheep 当前是一个**可运行的本地 Agent alpha 原型**：核心状态机、任务执行、索引优先记忆、版本化会话摘要、桌面聊天界面、拓展工作区和可选外部渠道已经形成完整工程骨架。实际 Electron 进程 进程生命周期、跨重启会话与 Checkpoint 恢复已经形成可重复验收基线；DeepSeek API 实测 的 6 分钟持续任务诊断门、多轮摘要字段连续性、一次主动断线恢复和正式 2 小时持续负载门已经通过。正式门运行 `7200s`，完成 `1441` 个采样，进度缺测 `0`、资源预算违规 `0`，后半程 RSS、Heap、Electron 工作集、句柄和请求趋势均在预算内，最终资源状态回到空闲基线。

它还不是可直接宣称“生产就绪”的发行版。当前 DeepSeek 活动模型的基础 chat、continuity、tool 和 abort 已真实通过；DeepSeek V4 官方 tokenizer 与普通直接回答请求的最终 framing、本地精确账本和同请求 Provider usage 已完成零差值对账。Flash 的普通请求、工具 schema、单工具续轮、仅历史工具消息和多工具乱序结果已在 disabled/high/max 三档完成 `15/15` 次实际 Provider 校准，全部为 `exact_match`；Pro 普通请求继续保持精确，Pro 工具协议在独立校准完成前默认拒绝，不外推 Flash 结论。OpenAI/GLM 尚无经过同等验证的本地精确计数器，未配置时更不能冒充已校准。隔离数据根验收已通过实际 Electron 进程 启动、关闭到托盘、强制终止、重启和 Checkpoint 续跑；2026-08-03 又用DeepSeek API 实测 验证了完整退出重启后的最终回答连续性、两步 `write -> read` 任务在后台控制下的完整交付、4 个活动 run 与双 Checkpoint 的短时压力、摘要压缩深度按 `1 -> 2 -> 3 -> 3` 有界滚动后仅依赖 `session_summary` 的五字段最终回答连续性、第一次续答请求被主动断开后零额外 Provider Token 的重试恢复，以及单次 6 分钟和正式 2 小时的持续任务。正式门同时覆盖活动任务 SSE、同进程暂停/继续、配置与模型热重载、关闭到托盘、强制终止、重启恢复不重放、中断和彻底退出；最终记忆连续性为 `supported`。尚未闭环的是非字段事实的普遍连续性、外部系统副作用、MCP、安装包发布和完整用户场景。

**当前阶段**：Memory v3 阶段 0-26、统一 Tool Execution Service、工具调用级与 TaskBook 步骤级有界并行、shadow Git 检查点、退出冻结、前台实时 Provider API 表达来源/去重校验、回答级记忆连续性判断、会话摘要精确字段保真、直接续答的一次有界连续性纠偏、运行时事件安全边界与 Renderer 生产入口、TaskBookPatch、Runner 检查点续跑、应用启动恢复控制面、活动任务快照与控制、托盘、三档关闭策略、逻辑容器权限校验和 LS 开发环境版本管理均已有工程基线。语义活动 `respond / execute / clarify`、直接回应紧凑 Prompt、有界历史、选择性上一轮摘要、显式工具提议、结构验证、无进展熔断和工具循环后续请求紧凑化已通过完整质量检查及实际 Electron 进程 Runner 验收。用户明确点名且可证明为新鲜、自包含的单个 builtin `glob / grep / read` 请求继续使用 `decide_explicit_tool`；用户没有点名工具、但目标可证明为新鲜、自包含、无附件、无续接、无实际记忆介入且只需当前工作区只读检查时，DECIDE 由 LLM 在同一只读工具集中选择一个最小工具并提交有界参数提议，Runtime 重验名称、schema、路径、权限和副作用后直接执行。两条路径均为 `DECIDE -> Runtime tool -> execute_final_reply` 两次模型请求，并保留工具证据、SSE、结构 VERIFY 与调用审计；多工具、写入、执行、附件、续接、实际记忆介入、恢复态和边界不明任务仍进入完整路径。普通直接回答不增加连续性模型调用；只有明确续接且首个实时回答被本地证据判为 `discontinuous` 时，才允许一次实时 API 纠偏，纠偏仍断档则不发布。Flash 工具协议 `15/15` 校准已完成；下一主线是验证非字段事实、真实外部副作用和长期真实用户负载，再按实际启用范围推进 Pro/其他 Provider 校准，并仅在安全契约不退化时继续缩短 Prompt。**

- 后端继续使用连续、可衰减且无固定层数的 activation score；任务相关度、scope、证据和认识状态先于 activation。前端只显示带滞回的高/中/低三层汇总，不把三层写回后端。
- 正式数据根已有 40 个业务 Atom、5 个内部 scope root、11 个资源、45 条本地 512 维向量；Catalog schema v9、TaskBook 二次注入、KnownState、working set、关系调和和版本化摘要链路已完成隔离质量检查。
- 阶段 19 已把最终 VERIFY、TaskExecution、Provider token 和两次运行时资源采样纳入只读报告。2026-07-29 重新读取 46/46 个执行日志：15 个有记忆访问、0 个有 KnownState、0 个报告显式 Atom 使用、12 个有 Provider usage、1 个有最终 VERIFY、10 个有资源采样。只有 Provider usage 达到单项门槛，整体仍为 `insufficient`，因此不调整 activation 参数。
- 阶段 20 已退役 Memory v2 的 archive 摘要写入、旧 vector 装饰写入和 CLI archive adapter；既有 archive/vector 数据保持原样，只读兼容路径不能创建摘要、向量或 Atom。阶段 20 当时的验收基线为 180 个文件、1317 passed、1 skipped。2026-08-04 当前工作树为 272 个测试文件、1900 passed、1 skipped；仓库卫生 33/33、全量测试、27 包 typecheck、Electron build、恢复源检查、Flash 工具协议 `15/15`、DeepSeek API 实测 显式单只读与自主 `glob / grep / read` 矩阵、确定性七场景、后台九场景、跨重启回答连续性、多轮五字段摘要续答、三级压缩深度、主动断线恢复、120 秒诊断门、正式 2 小时持续任务和 Git 审阅隔离桌面验收均已通过。
- 阶段 21 已把版本化会话摘要覆盖的 source run 与 daily Atom 对齐，完成有界、确定性的一对一提升：每次最多扫描 256、处理 8 个候选，先提交 project/long-term/experience T2 目标，再按 expected revision 归档源；写入或归档失败保留 daily 源，整个维护流程不增加 LLM 调用。
- 阶段 22 已把重复 Atom 合并接入独立调和校验：模型只可引用本轮已 adopted、未冲突且 revision 匹配的 KnownState Atom；Runtime 再校验 scope、parent、认识边界、语义锚点和冲突/替代关系。单轮最多 2 个提案、每项最多 4 个 source，部分失败保留未提交 source 并支持幂等重试；阶段 22 本身不开放任意内容重写或层级重组，后续层级能力由阶段 23 单独治理。
- 阶段 23 已把显式关系驱动的叶子 Atom 跨 parent 调整接入独立层级校验：单轮最多 1 项，只接受本轮 adopted 的当前 D2/D3 Atom 与目标 parent，并要求同 scope、active/resolved 且有证据的 `belongs-to`/`derived-from` 正向关系。Runtime 负责叶子、revision、关系强度、提交、恢复和审计；超额提案明确拒绝，不静默丢弃。非叶子子树移动由阶段 26 的独立协议治理。
- 阶段 24 已把同一陈述的内容澄清接入独立修订校验：单轮最多 1 项，只接受本轮 adopted、当前 revision、未冲突、未截断的完整 D3 Atom，并要求当前 run 的通过验证证据。Runtime 只允许 title/summary/content/retrievalKeys 的澄清、规范化和去冗余，独立校验语义保留与硬锚点；来源、证据、实体/关系、层级、认识状态和生命周期不变。
- 阶段 25 已把事实纠正/冲突替代接入独立 correction 校验：单轮最多 1 项，只能引用本轮完整 D3、当前 revision 的两个既有 Atom，并要求通过的 VERIFY、Runtime evidence、同 branch/scope/parent/statement kind 边界、足够权威的 replacement，以及方向正确且已 resolved 的 `replaces`/`conflicts-with` 关系。提交只把旧 Atom 标记为 superseded 并指向 replacement，保留旧正文、来源、证据和历史；响应丢失后可由管理读取恢复并返回 noop。跨陈述扩写仍未开放，非叶子移动由阶段 26 独立治理。
- 阶段 26 已把有证据约束的非叶子子树重组接入独立 subtree 校验：单轮最多 1 项，只接受本轮完整 D3、当前 revision 的非叶子根与目标 parent，并要求同 branch/scope、通过 VERIFY/evidence、方向正确的 active/resolved 有证据关系和最多 128 个 active descendants。Runtime 只移动根 `parentId`，后代父链、revision、正文和来源不变；真实 V3 Backend 已覆盖 Catalog 有界计数、投影记录、重启和响应丢失 noop 恢复。实际 Provider 提案质量和超大子树治理仍待验收。
- 前台 Agent 自然语言已经建立实时 API 来源与持久化去重校验：每条新的 REPLY、ASK_USER、RECOVER 或 TaskBook 最终交付都必须在当次 run 中实时调用当前 Provider API，由 LLM 现场生成并携带绑定 `modelRequestId`、request index、provider 和 model 的 `ReplyProvenance`；这不是候选文案生成或 Runtime 选稿。`FINALIZE` 回查不到真实请求时直接拒绝。API 返回在发布前进入会话级 SHA-256 注册表并原子占用规范化指纹；完全重复时最多重新实时调用两次当前 Provider API。空回复、注册表失败、模型失败或重新生成耗尽只留下 Runtime 错误/状态，Renderer 不生成固定 Agent 文案，也不存在模板库或预置文案库。
- FINALIZE 已增加回答级记忆连续性评估：本地评估实际发布且可由 `ReplyProvenance` 回查的 LLM 回答，与真实进入本轮因果模型调用链的 active/adopted Atom、版本化会话摘要和近期跨轮对话之间的独立锚点，并把 `supported / discontinuous / uncertain / not_applicable / unavailable`、Context 可观测性、来源、命中 Atom 和诊断写入 `AgentResult` 与执行日志。当前输入自身的词只证明回答贴合本轮；TaskBook 中由记忆介入后补出的细节仍可形成承接证据。任务续接和“你还记得上次的代号/颜色吗”这类直接记忆追问都会进入显式连续性门；明确追问多个历史字段时，最终回答必须逐项答出对应旧值，只有复述附带限制、漏答任一核心字段、答错、用否定句提到旧值、明确说不记得或要求用户重新提供，均不能算连续。即使所有旧值都在回答中出现，只要回答同时明确声称无法回忆，状态也必须是 `discontinuous`，且不得登记历史、摘要或 Atom 为已承接来源。字段旧值按“近期可观察消息 → 已进入调用链的版本化会话摘要 → 已采用且仍 active 的记忆”逐项解析；会话摘要只有 Runtime 精确保真封套中的字段可承担逐值验收，模型概率摘要正文不能自行升级为精确事实。Markdown 的加粗标签、反引号和表格只视为展示结构，不再让正确回答产生假阴性；`executionCount / 执行次数`、`ticks`、`completed`、短数字和布尔值也必须按标签和值精确对应，无关位置出现相同数字不能补足错误字段，每个成功字段至少贡献一项独立证据。纯记忆追问不会因此注入无关的上一轮工具耗时。只有 `supported` 可通过续答连续性门，`discontinuous`、`uncertain` 和 `unavailable` 都不能被 UI、Runtime 或验收脚本描述为“记忆连续”。Context Engine 已裁掉的来源、缺少请求快照的来源、释放/排除/冲突 Atom 均不计命中；执行中由 `memory_tree` 展开的 Atom 只有在对应工具结果确实进入后续模型请求时才可计入。回答实际采用的 Atom 或摘要只形成有界 routing/activation 反馈，不提高事实 confidence 或 verified usefulness，也不增加 Provider 调用。最新定向回归覆盖最终回答、Runtime 摘要隔离和记忆反馈；完整质量检查数字见下方验证表。确定性验收 Provider 的七场景 Electron 门仍通过；DeepSeek API 实测 隔离验收中，单会话最终回答准确复述 `background-proof.txt` 与 `deepseek-background-anchor-7319`。最新并行压力门又证明两条隔离会话在重启恢复后分别准确复述自己的文件名和验收码，均没有调用工具且判定 `supported`、`matchedSources=[recent_history]`。同日摘要压缩验收进一步证明：原始旧消息不进入重启后的回答请求，最终回答仍逐项给出代号和颜色，状态为 `supported` 且唯一来源为 `session_summary`；120 秒持续任务后的跨模型追问也准确给出验收代号与 `executionCount=1`，并判定为 `supported`。仅内部保存、Checkpoint、摘要正文或关键词碰巧命中不能通过。
- REPLY 发布前新增一次有界连续性纠偏：本地纯函数先对首个实时 Provider 回答和本轮真实可见历史做同一套回答级评估；状态不是 `discontinuous` 时原样进入唯一性注册和发布，不增加调用。只有明确续接且回答遗漏、否定或冲突于可见旧值时，才携带原始请求、可见历史和首稿追加一次 `reply` API；纠偏仍为 `discontinuous` 时抛出 `continuity_repair_failed`，不占用错误文案指纹、不发布伪连续回答。该机制不替代 FINALIZE 的最终审计，也不对普通回答、`not_applicable` 或仅 `uncertain` 的候选无条件加一次调用。当前真实跨重启回答门中首轮与续答均一次请求即通过，Prompt 分别为 `974` 和 `1,286`，续答为 `supported`、来源为 `recent_history`，证明正常路径没有额外 API 成本。
- 2026-07-31 的真实前端 Runner 验收中，显式单步 `glob` 仍使用 3 次模型请求、总耗时 `13.666s`、Provider usage 累计 `16,316` tokens；2026-08-03 03:45:44 的第一版两调用基线为 `5.642s`。当前实现进一步把可证明自包含的内置单 `glob / grep / read` 决策拆为 `decide_explicit_tool`：模型只返回 `input` 或澄清对象，工具名由 Runtime 锁定并展开为既有 TaskBook；最终回答只有在 trivial 单步骤、builtin 来源、无审批、无副作用、未清洗/截断，且 TaskBook、步骤结果、工具结果和权威调用记录的 `callId` 完整一致时才使用紧凑 Context。2026-08-04 05:16:17 的最新真实 `glob` 验收为 `decide_explicit_tool -> Runtime glob -> execute_final_reply`，随后通过 structural VERIFY；2 次 DeepSeek API、1 次工具，本次耗时 `2.201s`；DECIDE prompt `417`、最终回答 prompt `379`、全程 prompt `796`、Provider total `837`，两次本地 tokenizer 均为 `exact_match`。单次耗时只作运行记录，不与旧样本比较速度；Prompt 成本相对上一版 `559/462/1,021` 已继续下降。完整工具 schema、权限、路径边界、工具来源、副作用、调用审计和结构验证均保留；同名插件/run-scoped 工具、多工具、写入、执行、附件、历史指代、记忆介入、恢复态、调用审计不一致或参数不完整时自动回退完整路径。
- 2026-08-04 09:31:50 的最新自主只读矩阵不要求用户点名工具：DECIDE 在 builtin `glob / grep / read` 中选择一个工具，同时给出满足有界 JSON Schema 的参数、步骤摘要和验收标准；Runtime 再校验工具来源、schema、路径、权限与只读副作用并直接执行。三项真实路径均为 `decide -> Runtime tool -> execute_final_reply`，随后通过 structural VERIFY；固定 2 次DeepSeek API 实测 API、1 次工具，Provider 工具协议请求数为 0。`glob` DECIDE/final prompt 为 `630/379`、合计 `1,009`；`grep` 为 `646/333`、合计 `979`；`read` 为 `632/292`、合计 `924`。六次请求的本地 tokenizer 都与 Provider usage `exact_match`，工作区哈希前后一致；回归上限保持为 DECIDE `750`、最终回答 `450`、总 Prompt `1,200`。只有 `excluded` 的记忆候选不会误阻断紧凑路径；`adopted/conflicted`、活动 working set、摘要、附件、历史指代、运行时事件、恢复态或写入/执行语义都会默认拒绝并回退完整 Context。该路径仍保留权限、工具 schema、真实工具结果、SSE、结构 VERIFY 和权威调用记录；直接提议无法安全采用时默认拒绝或回退既有工具循环，不猜参数。
- 2026-08-02 23:10:30 工具循环完成第一轮请求紧凑化：首轮仍保留最多 8 条有界历史和必需附件 manifest；首次工具结果之后，后续模型请求只保留最近 2 条历史、附件 manifest、当前用户消息、系统/步骤契约以及已产生的工具证据。没有删除工具 schema、权限判断或工具结果。旧的DeepSeek API 实测 两步 `write -> read` 基线需要 7 次模型请求，恢复任务耗时 `14.391s`；完成任务与记忆追问合计 Provider total `26,481`。2026-08-03 最新最终代码验收把用户明确点名的 `write/read` 分成两个 TaskBook `toolProposal`，Runtime 逐步校验并直接执行，恢复任务只保留 `decide -> execute_final_reply` 两次模型请求，耗时 `6.651s`；任务与记忆追问合计 Provider prompt `6,024`、completion `900`、total `6,924`。固定场景中总量下降约 73.9%，但该数字只用于同一验收场景的前后基线，不外推为所有任务的节省比例。
- 同日运行中 Main 对 `deepseek/deepseek-v4-flash` 完成四项脱敏真实校准：chat `872ms`，精确回复 `OK`；continuity `1,140ms`，正确采用最新值且未重复追问；tool `1,680ms`，只调用一次探针工具并正常收尾；abort `389ms`，在收到流式 chunk 后中断并返回 `AbortError`。当前 DeepSeek 凭证因此已被实测为有效；后续两步后台任务、短时并行压力、6 分钟和正式 2 小时持续任务又验证了真实副作用、暂停/中断、强制终止、并行重启续跑、热重载、回答连续性与资源回落。OpenAI/GLM 和达到调参门槛的真实用户负载仍未完成。
- 2026-08-01 已接入 DeepSeek V4 官方固定 revision tokenizer 资源和普通消息、thinking、工具定义的最终请求 framing。资源按固定大小与 SHA-256 下载后原子校验，计数使用真实 token id 数量；普通 `/run`、紧凑单只读工具与有界多工具提议路径均按请求形态对账。2026-08-04 的 Flash Provider 工具协议矩阵进一步覆盖普通请求、tool schema、单工具续轮、仅历史工具消息和多工具乱序结果，在 disabled/high/max 三档共 `15/15` 次真实请求零差值；最新显式与自主单工具请求也逐请求 `exact_match`。最新摘要续答最终 prompt 为本地 `1263`、Provider `1265`，状态 `within_tolerance`，不得写成零差值。Pro 普通请求保持精确，Pro 工具协议在模型专用校准完成前默认拒绝；OpenAI/GLM 继续明确为 unavailable，旧会话没有历史最终载荷时显示“本会话尚无本地计数”而不伪造数字。
- 统一 Tool Execution Service 已迁入 `@littlesheep/tools`：内置、插件和 run-scoped 工具共享查找、schema 校验、权限与单次批准、超时/中断、资源冲突调度、结果清洗、事件和有界 `ToolInvocationRecord`。`tools.invocationTimeoutMs` 默认 120 秒、配置范围 1 秒到 24 小时，并继续受 run 总超时约束；超时或中断后先传播取消信号并给工具 1.5 秒有界清理窗口，忽略中断的插件不会无限阻塞。内置 `exec` 对 stdout/stderr 分别保留最多 64 KiB 首尾证据，记录原始长度和截断状态，并在 Windows 终止整个进程树、等待 `close` 或执行有界强制收尾。Harness 只保留模型循环、TaskBook 编排和副作用检查点生命周期；Execution Log 优先持久化权威调用记录，旧日志才使用消息推断兼容路径。
- TaskBook 步骤级有界并行已接通：DECIDE 可为步骤声明 `serial/parallel`、前置依赖、资源读写集合与副作用；Runtime 默认并发 2、硬上限 4，串行步骤形成屏障，缺少完整契约、需审批、容器外资源、未知/外部副作用或冲突路径自动退回串行。每个并行分支有独立取消信号，分支内工具并发固定为 1；结果与消息按 TaskBook 顺序稳定归并，恢复时已完成兄弟分支不重做。完全访问模式下，来源为内置且未处于恢复态的显式单次 `exec` 可由 Runtime 直接执行；模型漏写副作用时保守推导为 `external`，显式冲突声明仍拒绝。每个 wave 完成后先持久化步骤完成状态，再消费暂停/中断事件，因此用户在工具运行中请求暂停时不会丢失已完成证据或提前生成最终回答。`RunCheckpoint` 同时有界保存最多 4 个活动步骤，旧 `currentStepId` 保持兼容。
- 运行时任务事件已接入 Renderer 生产入口：活动 run 中的输入会追加到当前任务而不是误开第二个 run；普通消息、设置变化和工作区文件保存分别发送有稳定身份的事件。只有 `accepted` 或 `duplicate` 会清空输入，`expired`、`conflict`、`rejected`、队列满和网络失败会保留用户输入并显示 Runtime 状态；响应丢失重试复用同一事件 id 与去重键。停止和追加任务保持独立，所有临时状态提示共用一个可清理计时器。
- 应用启动恢复控制面已接通：Main 启动时把上一进程遗留的 `resuming` 租约转换为可审计的 `interrupted`，并允许新 run 原子重新领取；Local App API 提供有界列表、详情、放弃和 SSE 续跑入口。Renderer 启动时按渐进式披露显示未完成任务，可查看现场、补充澄清、继续、停止或放弃；恢复完成后强制重载对应会话。完整 Context、工具输入和敏感正文不会进入列表响应，不确定外部副作用、模型不匹配和不可恢复附件仍由 Runner 拒绝。
- 活动任务后台控制面已接通：Runner 持有独立于 Renderer SSE 的中断信号，并提供有界活动快照、进度订阅及暂停、继续、中断；暂停在安全边界生成 `paused` 检查点，历史与重启恢复明确显示“已暂停”。Main 聚合当前与最多 4 个仍持有活动任务的退役 Runner，空闲后释放；Local App API 提供活动任务列表、`active_runs` SSE 与控制路由。设置页“应用与后台”可配置始终后台、仅活动任务时后台和始终退出三档策略，并以渐进式披露展示真实活动任务、步骤、进度、来源和运行标识；页面卸载会中止流、请求和重连计时器，Main 监听器有硬上限并在断连时释放。托盘最多展示 6 个任务，可显示应用、暂停/继续、中断和彻底退出；只有托盘成功创建时才允许隐藏窗口。2026-07-30 的真实窗口冒烟已验证设置入口、三档策略切换与恢复、同步状态、空任务态、手动刷新和全局前进/返回。2026-08-03 的隔离DeepSeek API 实测 验收进一步覆盖活动任务 SSE、关闭到托盘继续运行、暂停检查点、强制终止后恢复、运行时 profile 热重载、两步 `write -> read` 副作用、回答级记忆连续、中断检查点和彻底退出；同日短时并行压力覆盖 SSE 反复断开重连、4 个活动 run、双 Checkpoint 恢复和监听器/资源回落，正式 2 小时门又覆盖长时间 SSE、托盘后台、热重载、暂停/继续/中断、强制终止、恢复和彻底退出。真实网络断线、外部系统副作用和更长期真实用户负载仍待验收。
- 最新短时并行复跑继续通过活动 run、热重载、暂停/中断、双 Checkpoint 恢复、恢复不重复工具、双会话回答级记忆连续性和资源释放验收；Provider total 为 `20,389`。结束后 active run 与 retired Runner 均回到 0，activity source 与 listener 均回到 1。2026-08-03 09:04:52 的上一轮详细压力基线为 Provider total `26,344`，只保留在对应任务书作为历史证据，不再冒充当前数字。短时并行门不替代正式小时门；后者现已独立通过。两者都不替代真实断网或外部系统副作用验收。
- 2026-07-30 以同一专项回归复核后台连续性：20 个测试文件、83 项全部通过，覆盖窗口关闭策略、活动任务快照与控制、SSE、Renderer 状态归并、检查点租约释放与重新领取、重启续跑不重复原始输入、外部副作用拒绝、步骤/工具有界调度和监听器生命周期。该时间点只证明本地契约连续；实际 Electron 进程 生命周期缺口已由 2026-08-02 的隔离七场景验收补齐，但DeepSeek API 实测 长任务和真实外部副作用仍不由此替代。

## 能力总览

| 能力域 | 状态 | 当前结论 | 主要位置 |
| --- | --- | --- | --- |
| 架构治理 | 仓库基元化阶段 0-7 已完成 | 27 个 package 与指定领域目录均有所有权 README；关键组合入口已收敛为 facade。`check:repo` 自动校验文档、模块和 TypeScript references；单进程 `tsc -b`、受影响包传播和 changed/core/full 三级验证已接通，避免依赖方读取旧声明并降低日常反馈成本 | `docs/reference/repository-guide.md`、`docs/reference/module-split-map.md`、`scripts/workspace-projects.mjs`、`scripts/run-affected-verification.mjs` |
| LLM 调用契约与记忆提交 | 已实现工程闭环 | 每次模型请求解析独立 `LlmCallContract`，声明 purpose、Context、决策、输出、工具、记忆和预算；每轮有独立模型调用计数与硬上限；`CAPTURE` 默认按真实持久化状态确定性记录，`EVOLVE` 自适应调用。用户可见 Agent 自然语言必须在当次 run 中实时调用 Provider API，由 LLM 结合 `SOUL.md`/profile 现场生成，并通过 `ReplyProvenance` 绑定真实 model request；完全重复时最多重新实时调用两次 API，失败只返回 Runtime 状态。UI 状态与机器事实由 Runtime 固定提供，`FINALIZE` 禁止新增模型调用，只校验和持久化既有 API 回复。模型描述 statement/source，Runtime 独立决定 epistemic status 与 authority | `packages/types/src/runtime-contracts.ts`、`packages/types/src/message.ts`、`packages/harness/src/llm-call-contracts/`、`model-observability.ts`、`user-facing-reply.ts`、`stages/ask_user.ts`、`stages/capture.ts`、`stages/execute/final-reply.ts` |
| Context Engine | 主要数据链、调用契约与直接回应/工具续接瘦身已实现；DeepSeek V4 Flash 普通请求和工具协议精确计数已闭环，Pro 工具协议与其他 Provider 待补齐 | 支持确定性候选、来源 segment、契约过滤、阶段软预算、真实模型窗口硬上限、版本化 Summary Memory、附件清单优先、按需附件工具、Provider usage 绑定和双账本 UI。DeepSeek V4 Flash 使用官方固定 revision tokenizer 与 Provider 校准后的最终 framing；普通请求、工具 schema、单工具续轮、仅历史工具消息和多工具乱序结果在 disabled/high/max 三档共 `15/15` 次 `exact_match`。用户点名 builtin 单只读工具时，显式路径为 2 次 API、Prompt `796`；用户只表达只读目标时，自主路径由 LLM 选择一个 `glob/grep/read` 并给出参数，Runtime 直执行后再调用最终回复，固定 2 次 API、1 次工具，最新矩阵 Prompt 为 `glob 1,009 / grep 979 / read 924`，连续两轮范围为 `glob 1,005-1,009 / grep 977-979 / read 924`，回归上限 `750/450/1,200`。两条路径都保留权限、schema、工具证据和结构 VERIFY。Pro 普通请求保持 exact，Pro 工具协议与 OpenAI/GLM 未校准形态默认拒绝，不显示伪精确数字。正式 2 小时门已量化持续任务资源回落；下一步优先验证非字段事实和真实外部副作用，再按实际启用范围补齐 Pro/其他 Provider | `packages/context/src/engine.ts`、`context-engine/`、`packages/context/src/tokenizers/`、`packages/types/src/token-ledger.ts`、`packages/harness/src/context-candidates.ts`、`packages/harness/src/compact-autonomous-read-task.ts`、`packages/harness/src/stages/execute/direct-tool-proposal.ts`、`model-observability.ts` |
| 运行时事实注入 | 已按极简方案删除逐请求时钟/耗时/历史工具统计；按需查询与事件通道接续 | 缓存边界后只注入会改变答案的 Runtime 事实：能力快照/探针/权限决定与任务状态、进度。逐请求时钟、时区、run 开始时间、耗时、当前轮工具计时与上一轮执行摘要不再注入（`ctx.previousRun` 及 runner 的读取一并删除，末轮摘要仍由执行日志持久化供 UI/回放按需读取）。紧凑块实测 439 字符（12 工具 + 能力快照，旧尾巴为 705 字符），且同一 run 内重复请求字节一致；显式时间需求由 `session_status` 按需返回 | `packages/harness/src/runtime-awareness.ts`、`model-observability.ts`、`packages/runner/src/execution-log.ts`、`packages/tools/src/builtin/session_status.ts` |
| 应用数据根、默认 workplace 与附件生命周期 | 阶段 3 工程实现已完成 | 完整应用数据根默认名为 `.littlesheep`，但可通过环境、locator 和设置整体迁移；`workplace/` 只是未选择其他目录时的默认工作区子目录。粘贴/浏览器导入进入独立受管缓存，按 30 天、256 项、512 MiB 有界清理；workplace 使用可恢复的有界元数据索引，不读正文。设置页可登记完整数据根迁移，下一次启动会在任何写入者初始化前通过外部 locator、同级 staging、全文件 SHA-256 清单和活动元数据路径重绑定完成原子切换；源目录保留，失败继续使用旧目录，提交中断可恢复，回滚同样在下次启动生效。隔离测试已覆盖这些契约，尚未擅自搬迁正式用户数据 | `packages/branding/`、`packages/app/src/main/attachment-cache.ts`、`data-root-migration.ts`、`data-root-metadata.ts`、`packages/memory-tree/src/workspace-resource-index.ts` |
| 长会话压缩与 daily 提升 | 本地连续性门、首版提升、重复投影调和、叶子层级纠正、同陈述修订、事实纠正/冲突替代和非叶子子树重组校验已完成 | 原始 JSONL 不删除；摘要版本化、记录来源范围和最近 64 个 source run，支持增量合并，并在下一轮作为独立 `summary_memory` 介入。真实指代且近期消息缺少任务锚点时才回退摘要；压缩后只对明确覆盖、符合认识边界的 active daily Atom 做有界一对一提升，先写目标再归档源，失败保留源且不增加模型调用。重复投影合并、叶子跨 parent 调整、同陈述内容澄清、事实替代和有界子树移动都只允许模型提出、Runtime 校验和原子提交；实际 Provider 长会话、摘要生成失败、提案判断质量、跨陈述重写、超大子树治理和成本仍待验收 | `packages/session/src/compaction.ts`、`compaction-store.ts`、`packages/memory-tree/src/memory-consolidation.ts`、`memory-reconciliation.ts`、`memory-hierarchy.ts`、`memory-subtree.ts`、`memory-revision.ts`、`memory-correction.ts`、`packages/runner/src/runner.ts` |
| 确定性 Agent Runtime | 基础状态机与语义活动迁移已实现；活动路由已确定化 | Runtime 继续控制 `ENTER`、内部 stage、权限、工具、验证、恢复和收尾。活动路由由确定性规则完成、不消耗模型请求：命中会话规则走 `reply`，需要检索或未命中的请求进入主循环 `execute`，由模型选择直接回答或请求工具。内部 `classify` stage id、旧 `chat / problem / unclear` 会话与插件字段暂时保留兼容，不再作为新架构语义 | `packages/types/src/agent.ts`、`packages/classifier/`、`packages/harness/src/stages/classify.ts`、`packages/runner/` |
| 需求判断与任务书 | 已实现 | 支持澄清请求、复杂度判断、TaskBook、步骤验收和局部重规划；TaskBook 公共契约已与状态机/RunContext 分文件维护 | `packages/types/src/task.ts`、`packages/harness/src/stages/` |
| 工具统一执行与调用级并行 | 工程基线与超时收尾已完成 | `ToolExecutionService` 是工具查找、输入校验、权限/单次批准、超时、中断、执行、资源冲突调度、输出清洗、事件和有界调用记录的唯一宿主边界；内置、插件与 run-scoped 工具保留来源。默认调用超时 120 秒、可配置 1 秒到 24 小时，并继续受 run 总超时约束；取消后仅等待 1.5 秒有界清理。默认并发 4、硬上限 8；冲突或未知副作用串行，结果按原始调用顺序归并。`exec` 有界保留首尾输出并终止完整进程树。Harness 只拥有模型循环、步骤编排和副作用检查点钩子；网络权限、MCP 接入和更强授权 token 仍是后续扩展 | `packages/config/src/schema.ts`、`packages/tools/src/tool-execution-service.ts`、`tool-execution-{scheduler,control,records,result}.ts`、`packages/tools/src/builtin/exec.ts`、`packages/harness/src/stages/execute/tool-loop.ts`、`packages/runner/src/run-tools.ts` |
| 步骤级执行与恢复 | TaskBook 步骤级并行、真实两步恢复、双 Checkpoint 并行恢复、120 秒和正式 2 小时单工具持续恢复已通过 | 保留已完成步骤证据，失败或恢复时不重复执行已完成部分；步骤显式声明依赖、资源读写集合与副作用，Runtime 只并行无依赖、无冲突且权限明确的分支。默认并发 2、硬上限 4，串行步骤为屏障，分支取消独立，工具实际资源越过步骤封套时拒绝；消息、工具结果和执行证据按 TaskBook 顺序稳定归并。DeepSeek API 实测 已验证两个独立 `write -> read` 任务分别暂停/中断后可在进程重启后并行恢复；持续 `exec` 在工具完成后才应用暂停，重启续跑没有重放副作用，产物保持不变。真实网络中断和外部系统并行副作用仍待验收 | `packages/harness/src/stages/execute/task-{book,step}-runner.ts`、`task-step-scheduler.ts`、`execute/tool-loop.ts`、`packages/harness/src/checkpoint-resume.ts`、`packages/tools/src/tool-execution-service.ts`、`packages/runner/src/run-checkpoint.ts`、`scripts/verify-electron-deepseek-{background-task,parallel-load,sustained-load}.mjs` |
| 记忆树运行时协议 | 已实现基础闭环并通过相关性、动态工作集、多轮任务语义、关系路由与 TaskBook 调和门 | 根索引到分支索引再到展开/分支内深搜；D1 在 branch/scope 内先用 FTS 找精确候选，再补 80 个近期候选。首次 prime 最多选择 2 个 D2 Atom、预算 600 tokens；DECIDE 后的结构化 TaskBook 可再补最多 2 Atom/400 tokens，单 run 最多 4 次且重复 query 跳过。goal、验收标准和目标步骤分别评分，避免扁平长文本稀释相关性。高相关种子仍只做一次有界同 scope 关系扩展，D1 不调用向量；release 后真实请求删除对应正文，KnownState 同步排除，重新展开只恢复最新副本 | `packages/memory-tree/src/task-query.ts`、`memory-prime-selection.ts`、`memory-tree.ts`、`memory-service/run-coordinator.ts`、`packages/harness/src/memory-taskbook-refinement.ts`、`memory-context-working-set.ts` |
| Memory Service 与 Memory v3 | 正式 backend 已切换并完成数据、向量、规模、相关性、反馈演化、多轮任务语义、压缩连续性、关系选择、写入认识边界、关系调和、叶子层级重组、非叶子子树重组、同陈述内容修订、TaskBook 二次注入与跨缓存动态 activation 验收 | v3 使用对话原始来源、投影变更记录、Atom projection、run working set 四层模型。持久 Atom 与语义缓存共享连续、有界、惰性衰减的 activation 计算，但 namespace、TTL 和删除规则隔离；真实采用并产生任务价值才升温。任务相关度、scope、证据与认识状态始终先于 activation，冷 Atom 仍可由精确 FTS/索引找回。`InjectionTier` 继续表示稳定注入策略，不充当热度层级；结构与内容投影变化只能经显式 Runtime 校验提交，原始对话来源不改写 | `packages/types/src/activation.ts`、`packages/memory-tree/src/v3/activation.ts`、`memory-repository/v3-retrieval-activation.ts`、`memory-reconciliation.ts`、`memory-hierarchy.ts`、`memory-subtree.ts`、`memory-revision.ts`、`packages/session/src/compaction-store.ts` |
| 项目身份与路径重绑定 | 已实现基础闭环 | 新项目使用与路径无关的稳定 ID，旧路径派生 ID 原样保留；项目移动或重命名后可从侧边栏重新定位。持久化事务日志幂等迁移会话、归档、记忆 scope、项目投影、工作区文档资源、产物、终端活动、布局、导航状态和当前运行路径；路径冲突会拒绝提交 | `packages/app/src/main/project-index.ts`、`project-rebinding.ts`、`path-rebinding.ts`、`packages/memory-tree/src/memory-service.ts` |
| 用户记忆文件视图与 Runtime 治理 | 用户视图已收敛；Runtime v3 治理保留 | GUI 的“记忆树”只读取活动数据根中的六份记忆文件，当前仅 `SOUL.md` 可写；同时只读展示合并后的高/中/低三层 activation 计数。Atom、连续分数、内部阈值、关系、向量与来源明细不进入普通 Renderer，三层投影也不写回后端。Runtime 仍通过同一 Memory Repository、内部治理接口和迁移工具完成 D0-D3、连续 activation、移动/合并/失效/恢复、证据导出、Catalog 与本地 BGE 维护，不建立展示副本 | `packages/app/src/renderer/MemoryTreeView.tsx`、`packages/app/src/main/memory-files.ts`、`packages/app/src/main/local-app-api/memory-routes.ts`、`packages/memory-tree/`、`packages/prompt/src/sections.ts` |
| 执行记录与历史重放 | 已实现 | 已完成 run 的 TaskBook、步骤、权威 `ToolInvocationRecord`、验证、调用契约、Context 快照、记忆意图运行时判定、有界资源 ID 和两次粗粒度资源快照可持久化并重放；记录只保留输入哈希/键摘要和输出状态，不保存完整敏感输入输出。旧日志缺少统一记录时才从 tool message 推断兼容证据。执行日志负责历史重放，活动 run 的续跑另由版本化 `RunCheckpoint` 负责，两者不互相冒充 | `packages/runner/src/execution-log.ts`、`packages/tools/src/tool-execution-service.ts`、`packages/runner/src/runtime-resource-observation.ts`、`packages/app/src/renderer/TraceCard.tsx` |
| 数据/工作区版本与运行检查点 | 数据版本、应用启动恢复、隔离 Electron 跨重启与DeepSeek API 实测 两步副作用基线已闭环 | LS 数据根和用户工作区使用不污染已有 `.git` 的独立 shadow Git；写入前 preimage、run before/after manifest、同步回退、partial 诊断和退出 `shutdown-freeze` 已接通。`RunCheckpoint` 有界保存 TaskBook、步骤、事件、权限与副作用状态；Main 启动释放旧进程租约，Local App API 与 Renderer 提供发现、查看现场、补充信息、续跑、停止和放弃。隔离DeepSeek API 实测 已验证暂停 Checkpoint 在强制终止后恢复，原始用户指令不重复追加，`write` 副作用以 succeeded 账本跨恢复返回，随后 `read` 完成核对。Runner 仍拒绝不确定外部副作用、模型不匹配和不可恢复附件；并行副作用和外部系统副作用仍需独立验收 | `packages/snapshot/src/git-checkpoint.ts`、`git-checkpoint-files.ts`、`packages/runner/src/run-checkpoint-control.ts`、`run-checkpoint-controller.ts`、`packages/app/src/main/local-app-api/run-checkpoint-routes.ts`、`packages/app/src/renderer/runtime-recovery/`、`scripts/verify-electron-{runtime-continuity,deepseek-background-task}.mjs` |
| 桌面聊天与流式交互 | 已实现基础形态 | Local App API、SSE、Markdown、附件、审批和中断已接通；一轮 Agent 输出按思考摘要、执行过程、最终回答/成果渐进披露。活动 run 中可追加普通消息，设置变化与工作区文件保存也进入同一有界事件入口；结果按 accepted/duplicate/expired/conflict/rejected 显示 Runtime 状态，失败时保留输入并可幂等重试。Renderer 只显示通过 LLM 来源与重复检查的 Agent 文案。独立对话和项目对话均可从侧边栏原位重命名，Main 同步更新会话 metadata 与 UI 索引并在索引失败时回滚。Markdown 和成果链接单击进入拓展工作区预览，双击交给系统默认应用；网页预览进入有界导航历史 | `packages/app/src/main/local-app-api/session-routes.ts`、`packages/app/src/renderer/sidebar/session-row.tsx`、`packages/app/src/renderer/chat/`、`packages/app/src/renderer/runtime-events/`、`packages/app/src/renderer/workspace/`、`packages/app/src/renderer/Markdown.tsx` |
| 权限与行为模式分离 | 已实现基础闭环 | 通用/编程是独立行为 profile；完全访问/研究/受限是独立权限策略。活动完整应用数据根 `<data-root>`（默认 `.littlesheep`）是产品语义上的 LS Agent 容器，`workplace/` 是其默认工作区。从其他模式切换到完全访问时先显示红色风险确认；确认后容器内外及范围不明的读、写、改、删、执行均免逐次批准。研究仅对容器内读取免批准；受限所有操作都需批准。外部工作区自动索引在研究/受限模式下等待批准，完全访问直接继续。Agent 工具、内置终端、运行配置和步骤调度共享该语义；核心源码只读和危险命令硬拒绝仍高于模式。当前不是实际 Docker/OS 进程沙箱 | `packages/safety/src/permission-boundary.ts`、`packages/app/src/renderer/composer/mode-picker.tsx`、`packages/app/src/main/run-policy.ts`、`packages/app/src/main/local-app-api/terminal-permission.ts`、`packages/runner/src/run-config.ts`、`packages/prompt/src/profiles.ts` |
| 核心源码自修改保护 | 已实现内置工具硬闸 | Runner 从实际 workspace 标记自动发现 LS 核心源码根，并通过 ToolContext 传递只读边界；内置 `write`、`edit` 无条件拒绝核心源码路径，`exec` 在核心根内只允许保守只读诊断，完全访问与单次审批不能绕过。第三方本地插件仍属于用户显式完全信任边界，受控自我修改尚未开放 | `packages/runner/src/core-source-protection.ts`、`packages/tools/src/path-protection.ts`、`packages/tools/src/builtin/` |
| 拓展工作区 | 已实现基础形态；Git 审阅与内置浏览器已接通 | 审阅页以只读 Git 命令展示当前 staged、unstaged、untracked、rename、delete 和 binary 变化，提供稀疏变更树、文件/目录增删统计、分层双行号 diff、分支 upstream 与 ahead/behind 状态；刷新仅在审阅页可见时按 30 秒有界轮询，并支持焦点、手动刷新、保存触发与请求取消。文件树、标签、内置编辑器、Office/OpenDocument 有界只读预览、产物索引、PowerShell/PTY 终端和恢复快照也已接通。浏览器在 LS 内加载 HTTP(S)，提供独立的有界前进、后退和刷新 | `packages/app/src/renderer/workspace/`、`packages/app/src/main/local-app-api/workspace-git-*.ts`、`packages/app/src/renderer/app-shell/workspace-dock-view.tsx`、`packages/app/src/main/workspace-office-preview.ts` |
| 开发环境与工具链管理 | 已实现管理基础；运行时分发未完成 | 设置页可查看 Node、Python、Java/JDK、Go、Rust、C/C++、.NET、Ruby、PHP、Git 和 PowerShell 的检测状态，保存精确或系列版本偏好，导入已解压工具链并移除 LS 管理版本。Electron 内置 Node 随应用提供；其他工具链当前通过安全导入进入 `<data-root>/toolchains/`。终端优先使用已验证的 LS 版本，系统环境只作可解释降级，宿主 `PATH` 不被修改 | `packages/app/src/renderer/settings/development-environments.tsx`、`packages/app/src/main/development-environments.ts`、`development-environment-definitions.ts`、`development-environment-files.ts`、`packages/app/src/main/local-app-api/development-environment-routes.ts` |
| 模型供应商配置 | 已实现配置层 | OpenAI、DeepSeek、GLM 预置；只有配置了可用密钥的供应商/模型应进入选择范围 | `packages/config/`、`packages/app/src/main/keychain.ts` |
| 插件运行时 | 已实现基础闭环 | 插件发现、manifest 校验、启停、错误隔离、本地代码信任和 Runner 工具迁移已接通；当前支持 `channel`、`tool` 和声明式 `skill` 贡献。插件 Skill 使用 owner-scoped 来源和稳定资源 ID，随插件启停、移除、路径变化及 Runner 重建同步 | `packages/plugins/`、`packages/skills/`、`packages/memory-tree/src/memory-service.ts` |
| 外部渠道 | 已插件化基础形态 | Webhook、Telegram、飞书、QQ Bot 是可选渠道插件，只负责消息进出；没有配置时不加载实现 | `packages/channels/`、`packages/plugins/` |
| 技能系统与经验库 | 已实现基础形态，治理待补 | Skill 已区分 builtin、user、external、plugin 来源，支持 active/disabled/shadowed 与 owner-scoped 插件同步；创建时会拒绝同名覆盖。尚未实现语义去重、合并方案、冲突/回滚、基于验证收益的停用/归档/删除策略和用户可审查治理队列 | `packages/skills/`、`packages/experience/`、`packages/memory-tree/src/memory-service/skill-resources.ts` |
| Runtime 连续执行 | 隔离实际 Electron 进程 生命周期、跨重启、DeepSeek API 实测 两步后台任务、短时并行压力、120 秒诊断门和正式 2 小时门已完成 | 已有 `AbortSignal`、统一工具超时/清理、步骤级局部恢复、工具调用级与 TaskBook 步骤级有界并行、有界 `RuntimeEventQueue`、活动 run ingress、暂停/继续/即时中断、可恢复暂停检查点、Runner 显式续跑、应用启动恢复、当前/退役 Runner 聚合、托盘、三档关闭策略和设置页“应用与后台”。活动列表由真实 SSE 事件驱动同步，断连后有界重连；普通追加消息、设置和工作区事件由 Renderer 生产。实际 Electron 进程 + DeepSeek API 已覆盖 4 个活动 run、关闭到托盘、暂停/继续/中断、强制终止、双 Checkpoint 恢复、profile 热重载、两步副作用、持续单次副作用、双会话及跨模型回答级记忆连续、SSE listener 释放、句柄与内存回落；正式 2 小时门的后半程资源趋势也在预算内。真实网络抖动、外部系统副作用和更长期真实用户负载仍待验收 | `packages/runner/src/active-run-{registry,activity}.ts`、`run-abort-control.ts`、`run-checkpoint-*.ts`、`packages/app/src/main/desktop-shell.ts`、`tray-controller.ts`、`run-activity-monitor.ts`、`desktop-acceptance-snapshot.ts`、`local-app-api/application-lifecycle-routes.ts`、`packages/app/src/renderer/settings/application-background.tsx`、`packages/app/src/renderer/runtime-recovery/`、`scripts/verify-electron-{runtime-continuity,deepseek-background-task,deepseek-parallel-load,deepseek-sustained-load}.mjs` |

### 本轮权限边界收口

本轮把“LS 是一个容器”的产品概念落成可验证的逻辑边界：容器根来自活动完整数据根，而不是 `workplace`；用户选定的外部项目不会自动改变容器根。`describeToolAccess` 统一识别 `inside`、`outside` 和 `unknown`，并对绝对路径、相对越界、符号链接、动态 Shell 和外部命令采取保守策略。Tool Execution Service 在工具调用前执行宿主权限与单次批准判定，内置工具在实际读写前再检查一次，终端在创建会话和提交命令前由 Main 再检查一次。研究和受限模式下，外部或未知工作区的自动索引会在获批前暂停；完全访问完成一次显著风险确认后直接继续。用户主动的 UI 选择、预览和保存不与 Agent 授权混用。当前没有把宿主进程伪装成 Docker 沙箱；真正的 OS/Docker 隔离仍是后续安全增强方向。

上述外部或未知范围的逐次批准与自动索引暂停只适用于研究和受限模式；完全访问在用户完成一次显著风险确认后，对普通宿主访问免逐次批准。核心源码只读和危险命令硬拒绝仍独立生效。

本轮新增/更新的定向证据包括：逻辑容器路径与三档矩阵、完全访问一次风险确认后的免逐次批准、研究/受限的动态与越界命令审批、终端会话和命令审批、编辑工具在获批前不探测未授权路径，以及 Runner 外部工作区自动索引延迟校验。以上验证数字已由本轮实际命令输出刷新。

## 当前验证结果

当前工作树的核心门、全量测试、类型、构建、仓库卫生和恢复源检查均通过，工程质量检查为绿色。真实供应商冒烟仍是独立验收门，不能因本地质量检查通过就宣称三家 Provider 已完成校准。

| 检查 | 当前工作树结果 | 证据命令 |
| --- | --- | --- |
| 仓库卫生 | 通过：33 项通过，0 项失败 | `pnpm.cmd run check:repo` |
| 开发快速门 | 本轮未单独执行；核心门和全量测试提供更广覆盖 | `pnpm.cmd run verify:changed` |
| 核心 Agent 门 | 本轮由全量测试、仓库卫生与全工作区 typecheck 覆盖，未额外重复执行聚合脚本 | `pnpm.cmd run verify:core` |
| 全量测试 | 通过：272 个测试文件全部通过；测试项为 1900 passed、1 skipped，共 1901 项。新增覆盖 Git 状态解析、staged/unstaged/untracked 分层、rename/delete/binary、过滤器与 Git 可执行文件劫持防护、路径边界、取消传播、文件/输出/行数上限及 Renderer 变更树模型；既有自主只读 DECIDE、回答连续性、统一 SSE、Checkpoint、工具超时与清理、权限审批和布局稳定性测试继续通过 | `pnpm.cmd test`、`packages/app/src/main/local-app-api/workspace-git-*.test.ts`、`packages/app/src/main/local-app-api/workspace-review-boundary.test.ts`、`packages/app/src/renderer/workspace/review-model.test.ts`、其余 workspace 测试 |
| 全工作区类型检查 | 通过：27 个 workspace package 的 project references 完整通过 | `pnpm.cmd run typecheck` |
| 全工作区构建 | 通过：类型图与 Electron main/preload/renderer 完整构建 | `pnpm.cmd run build` |
| 开发环境定向回归 | 通过：开发环境管理与 Local App API 共 2 个测试文件，7 项全部通过；导入、精确版本、系列版本、激活、移除和取消选择均有覆盖，App typecheck 已通过 | `packages/app/src/main/development-environments.test.ts`、`development-environment-api.test.ts` |
| Memory v2 写入路径退役 | 通过：旧 archive 摘要、Vector 装饰器和 CLI archive adapter 已删除；真实 CLI 子进程在损坏配置、无 API key 的隔离环境中于 branding/config/Provider/Runner 之前返回退出码 2，数据目录哈希前后一致。旧 archive/vector 只保留显式只读兼容，正式用户数据未改写 | `packages/cli/src/cli.test.ts`、`scripts/check-repository-hygiene.mjs`、`pnpm.cmd --filter @littlesheep/cli... run build`、`node packages/cli/dist/bin.js memory archive --force` |
| Memory v3 正式迁移与向量验收 | 通过：V2 源 2 个文件、40 个业务节点、11 个资源与源 manifest 保持不变；正式 backend/config 为 v3，Catalog 含 45 个 atom、45 条 BGE 512 维向量，integrity 为 `ok`；重启、恢复源和实际向量查询通过 | `node scripts/verify-memory-v3-migration-readiness.mjs --data-dir=<data-root>`、Local App API、只读 Catalog 检查 |
| Memory Catalog schema 兼容 | 通过：正式 v7 Catalog 先在一致性备份后幂等升级到 v8，本轮桌面启动再增量升级到 v9；45 个 atom、45 条 ready 向量和 `memory-atom` namespace 保持完整，45 条记录均具有 activation score/update time，`integrity_check=ok`。activation/routing-only 变化不触发语义向量重建 | `packages/memory-tree/src/v3/catalog.test.ts`、桌面启动与只读 Catalog 检查 |
| Memory v3 运行时规模 soak | 通过：默认档为 120 个基础 atom、96 次 run、双阶段各 128 条反馈；增强档为 500 个基础 atom、256 次 run、双阶段各 256 条反馈。增强档最终含 501 个 atom 文件、530 条投影变更记录、500 个 active ready 向量，单批不超过 16，Catalog 删除重建与崩溃恢复通过；目标 Atom 在 release 后让位、验证有用后恢复首位，关系 relevance 变化参与排序且不触发向量重算；ledger 保留 16 条、最近反馈 id 保留 64 条，峰值 RSS 约 213 MiB，低于 384 MiB 门槛 | `node scripts/verify-memory-v3-soak.mjs`、`node scripts/verify-memory-v3-soak.mjs --atoms=500 --runs=256 --feedback-events=256` |
| Memory v3 真实 BGE soak | 通过：只读校验活动数据根中 24,451,050 字节固定 BGE 资产，在隔离数据根写入 256 个基础 atom。模型暂不可用时保留 256 个 pending 且零 Embed 调用；恢复后完成索引。语义更新注入一次瞬时失败后在同一 maintenance drain 内恢复。最终 256 个 active 512 维向量全部 ready，0 pending、0 failed；Catalog 灾难重建、4 次重启、128 次 run、离线零网络请求和 pipeline dispose 均通过。最大批次 16，峰值 RSS 约 349 MiB，低于 512 MiB 门槛 | `pnpm.cmd run verify:memory-v3-bge-soak` |
| Memory v3 运行时相关性 | 通过：16 个隔离 Atom、11 个 D1 案例和 10 个 branch-scoped deep-search 案例使用正式 BGE q8 资产运行。D1 Recall@1/2 `1.0/1.0`、正/负例通过率 `1.0/1.0`、多余 Atom `0`、query Embedding `0`；深搜 Recall@1/3 `0.7/0.9`、MRR `0.7833`、scope leak `0`、query Embedding `10/10`。运行阶段零网络尝试，临时数据根已清理；一个较长英文改写未进入前 5，作为默认 BGE 的可见边界保留 | `pnpm.cmd run verify:memory-v3-relevance`、`scripts/lib/memory-v3-relevance-fixtures.mjs`、`packages/memory-tree/src/task-relevance.test.ts`、`memory-tree.test.ts`、`src/v3/catalog.test.ts` |
| Memory v3 动态工作集与反馈演化 | 通过：正式 BGE q8、3 个隔离 Atom 和真实 Runner 请求链验证 initial admit、release、readmit、KnownState/ledger 一致与重启保持。32 次历史 release 后 routing relevance 为 `0.0294`，一年后回归 `0.4717`，routing-only useful 后 `0.5790`，结构性 verified useful 后 `0.6500`；即时负反馈让中性对照优先，衰减和新证据后目标恢复首位。未进入 active Context 的冲突候选生成 0 条反馈；正文、confidence、embedding hash 不变。重启后 vector deep search 命中目标，1 次请求只生成 1 次 query Embedding，零网络尝试，RSS 约 186 MiB | `pnpm.cmd run verify:memory-v3-evolution`、`packages/harness/src/memory-context-working-set.test.ts`、`packages/runner/src/memory-v3.integration.test.ts`、`packages/memory-tree/src/memory-repository/v3-backend.test.ts` |
| Memory v3 多轮任务语义 | 通过：正式 BGE q8、11 个隔离 Atom、8 个 D1 和 2 个 branch-scoped deep-search 案例覆盖中英文指代、LS 方案引用、硬排除与替代、负向约束保留、任务转向、自足指示词、无历史指代、项目 A/B scope 和缓存否定。D1 `8/8`、深搜 `2/2`；D1 query Embedding `0`，深搜 query Embedding `2/2`，被排除正文、多余 Atom、scope leak、网络尝试均为 `0`。深搜在明确相关性断层处停止，不再为填满 limit 注入噪声；阶段 9 Recall 指标保持不变，平均 tokens 从 `530.7` 降至 `495.3`。RSS 约 179 MiB | `pnpm.cmd run verify:memory-v3-intent-routing`、`packages/memory-tree/src/task-query.test.ts`、`task-relevance.test.ts`、`memory-prime-relevance.test.ts`、`memory-repository/v3-retrieval-materializer.test.ts`、`scripts/lib/memory-v3-intent-routing-fixtures.mjs` |
| Memory v3 压缩后任务连续性 | 通过：正式 BGE q8、8 个隔离 Atom、7 个案例在 Repository 重启前后各执行一次。中文/英文摘要回退、最近明确目标优先、任务转向、旧方案排除与新方案选择、session A/B 隔离和无摘要模糊“继续”均通过，共 `14/14`；D1 query Embedding `0`、网络尝试 `0`。初始 working set 只保留最强 task-relevance 簇，弱相关高治理优先级候选仍留在索引而不自动注入。阶段 9、11 复跑保持原指标，RSS 约 182 MiB | `pnpm.cmd run verify:memory-v3-compaction-continuity`、`scripts/lib/memory-v3-compaction-continuity-fixtures.mjs`、`packages/memory-tree/src/task-query.test.ts`、`memory-tree.test.ts`、`packages/runner/src/memory-v3.integration.test.ts` |
| Memory v3 关系引导选择 | 通过：20 个 Atom、20 个实体、13 条关系和 7 个固定案例在 Repository 重启前后共 `14/14`。必要依赖、替代方向、冲突双向、项目/会话隔离均正确；`similar-to`、过期、归档、争议、低置信和无独立任务价值的关系候选不扩散。关系路径候选 12 次，scope leak、多余 Atom、D1 query Embedding 与网络尝试均为 `0`；首次 working set 重启前后均以 319 tokens 注入种子与必要依赖 | `pnpm.cmd run verify:memory-v3-relationship-routing`、`packages/memory-tree/src/v3/catalog-relation-routing.ts`、`memory-prime-selection.test.ts`、`memory-repository/v3-backend.test.ts` |
| Memory v3 写入认识边界 | 通过：模型只描述 domain、statement kind、asserted source 和 topics；Runtime 依据对话原始来源、成功工具证据与 VERIFY 独立决定 reported/corroborated/unverified 和 authority。伪工具来源会连同不可信 id/label 一起降级；建议与假设不能因高 confidence 或通过 VERIFY 变成事实。EVOLVE/CAPTURE 写入、D3 检查与关闭重启保持通过；旧 daily 原文追加蒸馏 API 已删除并由仓库卫生门防回流。专项 3 个文件、15 项通过 | `pnpm.cmd run verify:memory-v3-epistemic-writes`、`packages/harness/src/stages/memory-epistemic-policy.ts`、`packages/harness/src/stages/memory-stage-prompts.ts`、`packages/runner/src/memory-v3.integration.test.ts` |
| Memory v3 Atom 相关性与关系调和 | 通过：EVOLVE/CAPTURE 最多接受 12 个实体 hints 与 16 条关系 hints；模型只描述实体和端点，Runtime 独立决定关系认识状态。关系先 proposed，Atom 提交并引用且证据门满足后才激活；失败提交不泄漏，启动最多补偿 1,000 条中断激活。专项 3 个测试文件 `17/17`；可信替代路线 strength `0.855` 且 active，未验证建议保持 proposed，scope leak `0`、网络请求 `0`，重启前后候选与路线一致，Catalog integrity `ok` | `pnpm.cmd run verify:memory-v3-atom-reconciliation`、`packages/memory-tree/src/memory-repository/v3-write-graph-projection.ts`、`v3-write-graph-policy.ts`、`v3-write-graph-activation.ts` |
| Memory v3 TaskBook 二次注入调和 | 通过：模糊原始请求的前两次模型调用未提前加载目标 Atom；DECIDE 形成结构化 TaskBook 后，EXECUTE 收到目标 Atom，VERIFY 显式引用并保持 adopted。goal、success criteria、步骤和 acceptance criteria 独立评分；单次最多 2 Atom/400 tokens，单 run 最多 4 次，相同规范化 query 跳过。隔离验收记录 4 个分支检查，记忆消耗 553/3200 tokens，网络请求 `0`；5 个定向测试文件 35 项通过 | `pnpm.cmd run verify:memory-v3-taskbook-refinement`、`packages/harness/src/memory-taskbook-refinement.ts`、`packages/memory-tree/src/memory-service/run-coordinator.ts`、`packages/runner/src/memory-v3.integration.test.ts` |
| Memory v3 动态 Atom 激活层级 | 工程验收通过：后端连续 activation、Catalog v9 投影、持久/缓存隔离、惰性衰减、有界证据、D1 热区、冷 Atom 精确召回、摘要真实使用反馈和前端三层只读汇总已接通。共享跟踪器让刷新使用真实滞回，状态随当前条目有界替换且重启清空。专项 11 个测试文件 `62/62`；长期实际负载仍待观察 | `pnpm.cmd run verify:memory-v3-activation`、[原子记忆与内置向量目录任务书](../taskbooks/memory-atom-vector-catalog-taskbook-2026-07-17.md)、`packages/types/src/activation.ts`、`packages/types/src/activation-projection.ts`、`packages/session/src/compaction-store.ts` |
| Memory v3 实际负载观测 | 观测工程验收通过，校准门未通过：2026-07-29 只读报告检查正式数据根 46/46 份执行日志，0 拒绝、0 投影截断；15 个 run 有记忆访问，0 个有 KnownState，1 个有最终 VERIFY，0 个报告显式 Atom 使用，12 个有权威 Provider usage，10 个有资源采样。Memory 访问共使用 5,880/48,000 tokens；Provider 共报告 prompt 75,958、completion 17,742、reasoning 15,187、cached prompt 21,504，Memory/Provider prompt 比率 0.0632。默认五项门槛为 20/10/10/20/20，目前只有 Provider usage 达标，状态仍为 `insufficient`，禁止据此调参 | `pnpm.cmd run report:memory-v3-workload`、`packages/runner/src/memory-workload-observability.ts`、`packages/runner/src/runtime-resource-observation.ts` |
| Memory v3 Provider 与回答连续性 | 本地结构门、确定性 Electron 七场景门、DeepSeek API 实测 跨重启回答门、两步后台任务追问、双会话并行恢复追问、多轮多次压缩和正式 2 小时持续任务门均通过。真实压缩链按 `1 -> 2 -> 3 -> 3` 保持三级上限，五个精确字段在仅依赖 `session_summary` 的续答中全部恢复；第一次续答请求被主动断开后以零额外 Provider Token 恢复。FINALIZE 从真实发布回答反查其 Provider 请求与 ContextSnapshot，只把回答实际承接的 active/adopted Atom、版本化摘要、近期跨轮对话和已进入后续请求的记忆工具结果计为连续；当前输入重复、已裁剪来源或 released/excluded/conflicted Atom 不计入。直接 REPLY 在发布前先执行同一纯本地判断，只有首稿为 `discontinuous` 才允许一次实时 API 纠偏，纠偏仍断档则默认拒绝；普通回答不增加调用。09:31 的最新真实跨重启复跑中，首轮与续答各 1 次 API，Prompt 为 `974/1,286` 且都为 `exact_match`，最终回答为 `supported`、来源为 `recent_history`，没有触发纠偏。多轮摘要门仍共转发 8 次 Provider 请求，4 次回答和 4 次压缩合计 Provider total `8,005`；注入的第一次断线请求未到达 Provider，最终续答 prompt 本地/Provider 为 `1263/1265`，校准状态 `within_tolerance`。Flash 工具协议另有 `15/15 exact_match` 的独立校准门，不能外推。仍未完成的是非字段事实的普遍连续性、Pro 工具协议、EVOLVE/CAPTURE 提案质量和外部系统副作用验收 | `packages/harness/src/stages/reply/continuity-repair.ts`、`reply.test.ts`、`continuation-intent.ts`、`response-continuity-{text,targets,evidence,types}.ts`、`session-summary-fidelity-text.ts`、`response-continuity.ts`、`packages/harness/src/stages/finalize.ts`、`packages/runner/src/session-summary-fidelity.ts`、`session-continuity.ts`、`scripts/verify-electron-{runtime-continuity,deepseek-reply-continuity,deepseek-compaction-continuity,deepseek-background-task,deepseek-parallel-load,sustained-load}.mjs` |
| DeepSeek API 实测 显式与自主单只读工具 | 通过：用户点名工具时走 `decide_explicit_tool`，只表达目标时由 DECIDE 在 builtin `glob / grep / read` 中自主选择；有界多工具/写入仍走完整 `decide` | 显式路径只让模型返回 `input` 或澄清对象，Runtime 锁定工具名并展开任务书；最新显式 `glob` 为 2 次 API、1 次工具，DECIDE/final prompt `417/379`、全程 `796`、Provider total `826`。09:31 的自主矩阵让 DECIDE 同时返回工具、参数、简短步骤与验收标准，Runtime 重验后直执行；`glob / grep / read` 均固定 2 次 API、1 次对应工具，Prompt 分别为 `1,009 / 979 / 924`，六次请求全部 `exact_match`，回归上限为 `750/450/1,200`。两条路径都要求 builtin 来源、无审批、无写入/外部副作用、未清洗/截断，并由 Runtime 重验 schema、路径、权限、工具证据、完整 SSE、结构 VERIFY 和调用审计；附件、历史指代、实际记忆介入、恢复、插件同名工具、写入/执行或边界不明任务回退完整流程。耗时和 completion 随实际 Provider 波动，只把 Prompt 与调用数作为效率回归基线 | `pnpm.cmd run verify:electron-deepseek-single-tool`、`pnpm.cmd run verify:electron-deepseek-autonomous-read-matrix`、`packages/harness/src/compact-{explicit-tool-decision,autonomous-read-task}.ts`、`compact-read-only-result.ts`、`stages/execute/direct-tool-proposal.ts` |
| 实际 Electron 进程 Runtime 连续性 | 通过：7 个场景全部完成 | 使用隔离数据根、实际 Electron 进程 进程和确定性验收 Provider，覆盖跨重启回答连续、活动任务 SSE、关闭到托盘并恢复、暂停/继续、暂停 Checkpoint 后强制终止与恢复、运行中模型热切换、中断并生成可恢复 Checkpoint。最终恢复回答判定 `supported`，`matchedSources=recent_history`，`historyAnchorCount=17`，共 14 次 Provider 请求；正式用户数据未被读写 | `pnpm.cmd run verify:electron-continuity`、`scripts/verify-electron-runtime-continuity.mjs`、`scripts/lib/electron-acceptance-provider.mjs` |
| DeepSeek API 实测 后台两步任务 | 通过：9 个真实场景全部完成 | 隔离数据根和实际 Electron 进程/DeepSeek 覆盖活动任务 SSE、关闭到托盘继续运行、运行时 profile 热重载、暂停检查点、强制终止、重启续跑、两步 `write -> read` 副作用、回答级记忆追问、中断检查点和彻底退出。TaskBook/执行均为 2 步，`write` 与 `read` 各成功 1 次且无需批准；恢复任务严格只有 `decide -> execute_final_reply` 两次模型调用、最新耗时 `6.863s`。本轮共尝试 6 个请求，其中 3 个已完成请求具有权威 usage，合计 Provider prompt `5,477`、completion `934`、total `6,411`，逐请求本地 prompt 全部 `exact_match`；中断分支的 3 个未完成请求不伪造 Provider usage。文件名与验收代号均命中近期历史，连续性为 `supported`、`matchedSources=recent_history`，漏答、错答、否定或明确失忆仍默认拒绝；隔离数据已清理 | `pnpm.cmd run verify:electron-deepseek-background-task`、`scripts/verify-electron-deepseek-background-task.mjs`、`packages/harness/src/response-continuity-{text,targets,evidence}.ts` |
| 实际 Electron 进程 + DeepSeek API 并行压力 | 通过：活动 run、热重载、托盘后台、暂停/中断、强制终止、双 Checkpoint 并行恢复、恢复不重复工具、双会话回答级连续性和彻底退出均完成 | 最新复跑 Provider total `20,389`；两条恢复后的记忆回答均为 `supported`，结束后 active run/retired Runner 为 `0/0`，source/listener 为 `1/1`。2026-08-03 09:04:52 的 10 场景详细证据、文件哈希/大小/mtime、资源预算和请求拆分保留在连续性任务书，作为历史可复现基线 | `pnpm.cmd run verify:electron-deepseek-parallel-load`、`scripts/verify-electron-deepseek-parallel-load.mjs`、`scripts/lib/delayed-http-proxy.mjs` |
| 实际 Electron 进程 + DeepSeek API 分钟级持续任务 | 通过：默认 120 秒、每秒一个进度 tick 的单次内置 `exec` 只执行 1 次，生成 `120` 个 ticks 和完成证明；执行前只有一次 `decide`。最新验收在同一 Electron 进程内先请求暂停并观察 `pause_requested`，再继续并恢复 `running`，随后再次暂停；三个事件都在工具完成、步骤状态和副作用证据持久化后的安全边界应用并生成 Checkpoint，没有杀死工具或提前请求最终回答。强制终止并重启后续跑没有重放副作用，产物哈希、大小与 mtime 保持不变；随后切换模型进行记忆追问，LS 最终回答准确给出验收代号和 `executionCount=1`，连续性为 `supported`、来源为 `recent_history`。121 次资源采样无违规，结束后活动任务、旧 Runner、监听器和事件源回到空闲基线；此前同场景的详细 RSS/句柄样本仍保留为历史证据。该门证明分钟级持续工作、同进程暂停/继续与有界回收，不替代断网或外部系统副作用验收 | `pnpm.cmd run verify:electron-deepseek-sustained-load`、`scripts/verify-electron-deepseek-sustained-load.mjs` |
| 实际 Electron 进程 + DeepSeek API 正式小时级持续任务 | 通过：隔离数据根中持续 `7200s`，完成 `1441` 个资源采样，进度缺测 `0`、资源预算违规 `0`；后半程 RSS、Heap、Electron 工作集、私有工作集、句柄和请求趋势均在预算内，最终资源状态回到空闲基线，回答级连续性为 `supported`，隔离数据已清理 | `pnpm.cmd run verify:electron-deepseek-hours`、正式验收日志 |
| 应用恢复源检查 | 通过；现有数据根、默认 workplace、会话、执行日志目录、资源索引、终端活动和布局均可读取；仍保留部分旧 run 缺执行日志与可选 workspace artifact 索引缺失的诊断警告 | `pnpm.cmd run verify:app-recovery` |
| 桌面快捷方式 | 已刷新并验证：`<Desktop>\LittleSheep.lnk` 指向当前构建准备的 `LittleSheep.exe`；从快捷方式启动后主窗口标题为 `LittleSheep`，进程响应正常 | `scripts/refresh-desktop-shortcut.ps1`、PowerShell 进程窗口检查 |

供应商校准已收敛为运行中 Main 的脱敏接口：脚本只读取启动令牌和 loopback locator，不再另起 Electron 或复制密钥。接口覆盖最小聊天、continuity、工具调用、`reasoning_content` 续接、流式中断和 usage 对账；2026-07-31 运行中 Main 对当前 DeepSeek 模型的四项校准已全部通过。该结论只覆盖当前已配置 provider/model；mock 仍只证明本地结构链路，不代替长任务和 Memory 提案质量验收。

## 能力明细

### Agent 核心

- 语义活动已完成从旧 `chat / problem / unclear` 向 `respond / execute / clarify` 的迁移；规则快速路径、LLM fallback、Context 装配和回归质量检查均使用新语义。旧类型只供旧会话、检查点与插件字段兼容，不再作为新产品活动。
- 缺少关键路径、权限或不可逆操作确认时使用结构化 `ClarificationRequest`，不把不确定性伪装成普通错误。
- 复杂任务可以生成目标、步骤、工具、产物和验收标准组成的 TaskBook；简单任务保持轻量。
- EXECUTE、VERIFY 和 RECOVER 以步骤为边界保存证据，支持局部重规划和有限重试。
- 运行事件包含步骤、工具、验证和最终回复，UI 可以实时展示，历史也能重建同一过程。
- 每次模型调用使用独立契约；工具、输出预算和 Context 来源越权会在请求发送前默认拒绝。

### 记忆与持续能力

- 根索引、分支索引、节点展开和同分支深搜构成默认检索路径。
- 未命中索引时不会默认跨树或直接把向量召回塞入上下文。
- 分支和单次 run 有预算、去重、来源记录和安全封套。
- 目标架构要求在已导航分支和当前作用域内，让经验证且任务相关的高价值记忆优先介入；访问频率本身不提升可信度，错误、冲突和过期结果必须产生可审计负反馈。长期无验证收益的可选记忆降低注入权重，但不自动降低 confidence，T0、安全规则和当前用户约束不参与普通衰减。
- DECIDE、EXECUTE、VERIFY 和 FINALIZE 已共享版本化 run 级 `KnownState` 事实链，明确区分已采用、已排除、冲突和重新激活的信息；Harness 只注入有界状态元数据，不复制记忆正文。
- 各阶段会从 `KnownState` 派生有界 active evidence set：当前无用、重复、被替代或过期信息可退出后续 LLM 请求，必要时重新激活；注入记忆携带层级、作用域、来源、confidence、importance、新鲜度、冲突状态、披露级别和实际 token 使用。
- v3 已冻结 User、Agent Self、Task/Project/Session、Experience、Knowledge domain 与 D0-D3 契约，并已通过同一 facade 接管正式 Runner、工具和生产 UI 路径。
- v3 已登记 user/project/file/session/task/skill/tool/rule/concept 等稳定实体和有向关系，并投影 atom 对实体/关系的引用；归档、删除或物理清理前会检查直接引用和入/出边。名称、路径、共现与向量相似只作为候选关联，不自动证明同一实体、所有权或因果关系。
- v3 已把关系从“已有候选排序信号”升级为受控候选发现路径：只从高任务相关种子做一次同 branch/scope/subtree 扩展，按关系方向、状态、时间、权威、置信度、相关度和证据筛选；邻接 Atom 仍须独立通过任务相关度和预算。关系命中使用独立 `relation` 路径与结构化 route 证据，不能伪装为层级或向量命中。
- v3 已实现 `MemoryUpdateEvent`、持久 journal、幂等存储协调器、due index、启动补偿消费者与两类崩溃点重放；due 消费先持久捕获幂等 `time-due` 事件再确认。真实 Runtime 事件生产和后续归并属于连续执行阶段，v3 atom 管理 UI 属于 Memory v3 阶段 6。这里的“不失忆”仍指持久、可发现、可追溯、可恢复且相关时可取回，不是把全部记忆常驻 Prompt。
- v3 已将“对话原始来源”与内部“投影变更记录”拆开。正式 V3 Runner 从用户输入和对话区可见的回复、步骤、工具过程、验证与错误生成稳定来源记录；EVOLVE/CAPTURE 写 Atom 前先持久化其来源，Runner 在每轮结束补齐可见来源。来源捕获失败会延期投影写入，不会生成无法追溯的 Atom。迁移前的 V2 会话 JSONL 和 snapshot 继续保留为来源与回滚证据，不参与新写入。
- Atom 的 `sourceRefs` 只引用对话来源，工具、VERIFY 与外部佐证进入 `evidenceRefs`。自动去重不会因重复内容或模型给出更高 confidence 就覆盖正文；新验证证据或用户在自身目标、偏好、价值和决定范围内的权威来源才允许强化。合法父级变化保持稳定 id，合并保留来源 tombstone 与审计。
- v3 已接入分层使用反馈：VERIFY 显式声明且被 Runtime 核验为 active + adopted 的 Atom，只增加 routing usefulness；结构性 VERIFY，或 VERIFY 通过且有成功工具证据时，才增加 verified usefulness。单纯读取、重复出现、停留在 Context 和未验证 release 都不提高 confidence。release 只更新有界 routing feedback，旧影响随时间回归中性；有效关系 relevance 以批量聚合信号参与排序，并按当前 task relevance 向中性收缩，relation confidence 保持不变。
- v3 已接入真实本地 Transformers.js Embedding：模型资产固定 revision、大小和 SHA-256，产品运行禁用远程模型与框架缓存。BGE 平衡档与 multilingual E5 质量档均在阻断进程内网络后完成真实基准；向量不可用时层级和 FTS 保持工作。成功 atom 写入后会等待一次有界、并发合并的维护批次，失败不回滚 atom，shutdown 会释放本地模型 pipeline。
- v3 写入已经把用户/外界陈述分类为目标、偏好、报告观察、事实主张、建议/假设和决定/批准，并分别记录 epistemic status 与 authority scope。用户对自身意图和取舍具有权威，客观技术 claim 仍需证据；v2 原节点没有保存这些字段，安全迁移只按保守规则重建，不伪造旧元数据。
- 自动写入使用结构化意图，记录作用域、层级、来源 run、置信度和理由；普通用户通过记忆文件视图管理人格等高层资源，当前仅 `SOUL.md` 可直接编辑。Atom 治理保持 Runtime 内部可审计、可导出和可恢复，不在普通 GUI 中暴露。
- 模型提出的记忆操作与运行时提交权分离；无真实证据或低价值写入会拒绝，冲突/失效只进入有界审计记录。
- `PHILOSOPHY.md` 保存用户确认的长期理念，默认只在资源索引中出现，任务相关时才按预算展开正文。
- 长期记忆、项目记忆、经验和 daily 流水在概念上分开，避免把过程噪声全部变成长期记忆。
- 项目记忆完整权威数据保留在 LS 用户数据中；项目内私有投影需要显式启用并经过白名单过滤，共享导出使用独立、更严格的 Markdown 白名单。隔离数据根的实际 Electron 进程 验收已覆盖启用、Git 隐私提示、外部冲突、删除保护、覆盖确认和恢复同步。

### 桌面应用

- Electron 主进程内嵌 Runner；渲染器通过 loopback 随机端口的 Local App API 通信。
- Local App API 与外部渠道插件完全分离；没有外部渠道时应用仍可独立运行。
- 聊天支持流式回复、Markdown、代码块复制、附件、工作区选择、权限审批和中断。
- 公开思考轨迹默认直接可见，工具参数和大段原始输出可折叠；用户消息使用气泡，Agent 回复和工具过程使用无气泡时间线，并区分模型明确返回的公开摘要与真实执行过程，不展示私有思维链。
- 执行中优先显示当前步骤、实际选择/调用的工具和关键状态，命令与原始输出按需展开；任务结束后过程自动收拢，只保留最终回答与蓝色成果链接，失败和风险仍在默认层明确显示。
- Markdown 与成果链接采用统一激活协议：单击在拓展工作区打开文件或网页预览，双击取消单击并使用系统默认应用；不支持的协议默认拒绝。网页地址属于独立且有界的浏览器导航栈，不进入全局应用导航，应用重启后历史清空。
- 设置、会话、项目、归档、记忆树和拓展工作区共享统一的转场、浮层和折叠交互约束。
- 旧原型默认 workspace 会在启动时同时迁移配置、项目壳、会话归属和归档元数据；真实迁移验证保留了全部索引会话，10 份会话 JSONL 的 SHA-256 均未变化，第二次启动的配置、会话索引和项目索引哈希保持稳定。

### 插件扩展

- `PluginHost` 在 Runner 之后独立启动，核心不依赖任何外部渠道。
- 内置渠道通过动态加载接入；未配置对应渠道时不会 import 渠道实现。
- 本地插件只在用户明确打开“允许执行本地插件代码”后才会在 Electron 主进程中运行；该开关不是代码沙箱，启用即代表完全信任插件代码。
- 插件设置页显示来源、版本、能力、激活事件、权限声明、运行状态和发现错误；用户可启停和重新加载插件。

### 工程治理

- [文档决策入口](../README.md) 已成为唯一首要入口；正式文档按当前依据、稳定原则、执行任务书和工程参考四层渐进展开，根 README 不再平铺全部文件。
- [架构原则](../principles/architecture-principles.md) 已成为 LLM、Agent、Mode、Context、Memory、Tools、Workflow 和插件分工的规范性来源。
- [架构决策报告](architecture-decision-report.md) 已按当前源码记录模块成熟度、主要缺口、推荐顺序和待用户决策事项。
- 架构文档、项目状态、仓库目录、专项规范和任务书拥有独立职责，避免同一事实在多份报告中重复维护。
- 文档已明确区分目标架构、当前事实、演进建议和专项任务书；Context Engine 按“阶段 1 主要数据链、DeepSeek V4 Flash 普通请求与工具协议精确本地计数已实现，Pro 工具协议和其他 Provider 仍待收敛”记录，Tool Execution Service 按“本地工程基线完成、生态扩展待验收”记录，Mode Registry 仍不按已完成能力记录。
- [总基调、认知架构与仓库基元化任务书](../taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md) 已完成阶段 0-7；package/领域 README、稳定 facade、LLM Call Contract、记忆更新校验、理念资源和持续质量检查均已落地。

## 未完成方向

### P0：Memory v3 原子记忆与内置向量目录

已完成的隔离基础：

1. 语义 atom 契约、stable id/parent、domain、D0-D3、statement/epistemic/authority、实体/关系、证据封套和 KnownState 引用已冻结。
2. Atom Store 已实现分片文件、内容哈希、修订冲突、同作用域 parent/循环校验、损坏/孤儿隔离、轻量常驻 header 和按需正文读取；10,000 atom 重启扫描通过。
3. Conversation Source Store 以独立哈希文件保存用户输入和对话区可见信息，写入后没有 update/delete/prune API。Projection Mutation Record Store 继续沿用兼容 `raw-record*` 内部路径保存事件与 mutation；mutation 提交后另写 append-only commit receipt。Event/operation journal 与 Storage Coordinator 再执行有界恢复和幂等双提交。变更记录已写但 event 未写、merge 部分写入、atom 已写/catalog 未写等崩溃点均可恢复，journal 裁剪不删除投影变更记录或 receipt。
4. SQLite catalog 已实现 FTS、branch/scope/subtree 强制过滤、向量状态、访问/反馈有界账本、due index、实体/有向关系和数据库删除后流式重建。
5. Provider `/embeddings` 默认硬拒绝，测试确认未授权远程引擎零调用；访问次数不进入优先级。显式采用只能形成 routing 反馈，独立验证证据才能形成 verified usefulness，二者都不自动改变 confidence；普通衰减不改 confidence 或淘汰 T0。
6. 独立 `packages/embedding` 已实现显式模型 provision、完整性校验、本地加载、批处理与取消；BGE Recall@1/3 为 `0.7778/0.8889`，E5 为 `0.9444/1.0`，两者离线断言网络尝试均为 0。
7. `MemoryV3MaintenanceWorker` 已实现有界向量重建和 due 启动补偿，不使用常驻轮询；实体/关系生命周期已检查 atom 引用与入/出边，Catalog 的 Embedding 职责已拆为独立控制器。
8. `MemoryRepository` 已成为 v2/v3 稳定 facade；正式数据当前由 v3 接管。活动版本 locator 优先并默认拒绝，不能被旧实验标记或配置漂移绕过；v2 继续承担兼容、验证和受约束回滚来源。
9. 双后端 18 项契约覆盖根节点、读写、去重、层级、管理、资源、重启、并发、daily tier、冲突重绑定、恢复队列、项目路径重绑定和实验标记校验。
10. v3 写入先分类 domain、statement、epistemic、authority 和 actor；建议、事实、偏好与决定不会跨类别合并，资源与来源映射为稳定 user/project/file/session/task/skill/tool/rule/concept 实体。
11. Memory Service 与 Runner 已在正式 v3 根接管导航、证据定位和重启恢复；隔离路径另已验证 EVOLVE/CAPTURE。Catalog 删除后会先重建 graph，再重建带实体引用的 atom。
12. Graph、Ledger、Resource Store 首次初始化共享 Promise；Runner shutdown 释放 v3 SQLite，Git 真实仓库测试也具备显式子进程超时和 Windows 有界清理，降低句柄残留风险。
13. 阶段 4 已完成：迁移器直接只读原始 v2 文件，保存全量哈希 snapshot，在同卷 staging 中保留 node id、层级、资源、全部审计、恢复队列和迁移记录，并通过版本 locator、全量 validation hash、原子 rename、幂等恢复和受约束回滚提交。30 项迁移测试覆盖全部断电点、两类 ENOSPC、损坏/孤儿/重复数据、源变化、请求合并/取消、模型不可用、回滚后再迁移、运行中回滚预检和防丢失回滚；正式迁移已按同一协议完成。
14. 阶段 5 已完成：三类记忆工具共享 repository retrieval facade；v3 统一层级、作用域/子树过滤、FTS、本地向量、候选优先级、关系邻域、D0-D3 和访问账本。版本化 KnownState 贯穿 Harness 阶段，VERIFY 保持事实/建议/报告观察/未验证主张边界；默认 Provider Embedding 旁路已从 Runner 退役。
15. 新写入 atom 会在返回成功前触发有界本地向量维护；写入落在活动批次之后时会合并一个后续批次，模型不可用或维护失败不会回滚权威 atom，也不依赖无界轮询计时器。
16. 阶段 6 读取与迁移生命周期已完成：树接口只返回 D0/D1，节点 D2/D3 通过可取消请求按需展开；详情缓存限制为 24 条。Repository management facade 可检查 Catalog、atom、投影变更记录、Embedding、认识状态、证据和关系邻域；Memory Service 另外按 Atom `sourceRefs` 读取对话原始来源；迁移页可预检、确认登记、取消、重启执行、恢复和受约束回滚。
17. v3 atom 高级管理已完成：移动限制在同 branch/scope/scopeKey，合并要求相同认识类别、权威、断言者和解析状态，双 revision 先预检；来源 atom 保留 tombstone，合并不自动提高 confidence/usefulness，失效后退出检索并可精确恢复。
18. 单 atom D3 `.memory.json` 证据包导出继续由 Local App API 和内部维护控制面提供；普通 Renderer 已移除入口。真实 HTTP 测试覆盖参数校验、状态码、管理结果和文件输出。
19. Runner 首次业务请求已验证真实介入 D1 选中的 Atom；默认最多 2 个 D2 Atom、600 tokens，并执行 `0.25` 最低 task relevance 门，不达标时零注入且不凑配额。初始采用会立即同步到 Harness `KnownState`；`memory_tree release` 会同步移出真实后续请求与 KnownState，并允许之后重新加入。
20. Storage Coordinator 启动时分批协调投影变更记录、journal 与 catalog；能证明未执行或部分执行的记录才重放，能证明已投影的只补目录状态，含糊状态不猜测覆盖。
21. 隔离 `verify:memory-v3-soak` 默认档已通过：120 次初始写入形成 150 条投影变更记录与 121 个 atom，经历 4 次重启、journal 裁剪、projection-record-only 崩溃恢复、catalog 删除重建和 96 次 working-set run；120 个 active atom 的向量在重建后全部 ready，单批不超过 16，catalog integrity 为 `ok`，临时数据根执行后已删除。
22. 隔离 V3 Electron Atom 管理原型曾完成 65 个活动 atom、D2/D3、移动、失效/恢复和证据导出验收；2026-07-16 的产品边界决定已将该 Renderer 原型退役。相关治理能力与 API 保留为 Runtime/内部维护能力，普通 GUI 改为六份记忆文件视图且仅 `SOUL.md` 可写。
23. 正式 V2 数据先通过 `verify:memory-v3-readiness` 的只读预检和隔离副本完整演练，再完成真实迁移：2 个源文件共 164272 bytes，40 个业务节点与 11 个资源等价迁移；正式 V3 catalog 含 40 个业务 atom 和 5 个内部 scope root，integrity 为 `ok`；多次关闭重启后计数稳定，源 index/manifest 保持不变，临时副本已删除。
24. 回滚就绪检查已前移到运行中控制面：迁移 snapshot、当前 V2 manifest 与当前 V3 全量 validation 使用同一验证核心；安全时才允许写入 pending rollback。V2 源变化、V3 新写入或缺少活动 validator 都会在当前页面默认拒绝，且不会要求用户重启后再发现失败；启动路径保留独立二次校验以处理预检后竞态和旧 pending。
25. 本地向量资产控制面已接入迁移页与 `verify:memory-v3-readiness`：正式数据根的默认 BGE 四个固定文件已完成 24451050/24451050 字节与 SHA-256 校验。Electron 构建已把 Transformers.js 与 ONNX Node 运行时保持为外部依赖，避免误打包浏览器/WASM 后端；正式 Catalog 的 45 个 atom 均为 512 维 `ready` 向量，0 pending、0 failed。运行时写入/检索不会隐式联网。
26. `verify:memory-v3-readiness` 已把当前正式 V2 副本的迁移器与真实 Runner 串成连续链路：首次迁移无新增写入时可回滚；重新迁移后，Runner 成功持久化 2 条会话消息、EVOLVE 项目 atom 与 CAPTURE daily atom，关闭重启后按相同 ID 恢复，并完成索引导航、release 后 FTS 重新介入。V3 新权威写入使 `activeV3Unchanged=false`，回滚在 pending 登记前被拒绝；正式源哈希不变，临时副本已删除。
27. 当前工作树已补齐 Memory V3 来源与反馈链路：对话原始来源具有稳定 hash、冲突保护和有界 manifest；来源文件位于 `memory-tree/v3/conversation-sources/`，不会污染 V2 源 manifest，并被 V3 validation hash 覆盖，新增来源会关闭可能丢数据的回滚。Atom 导出包分开包含 `sourceRecords` 与 `projectionRecords`；完全相同 Atom 可在新增支持来源下调整合法父级，近义内容不再因更高模型 confidence 覆盖正文；验证反馈幂等更新 verified usefulness 和既有关系 relevance，不改变陈述或关系 confidence。
28. 阶段 7 已完成：Atom routing feedback 通过 Storage Coordinator、投影变更记录和 commit receipt 持久化，计数与最近反馈 id 均有硬上限；候选排序已拆分 task、routing 与 relationship relevance，关系信号按当前任务相关度向中性收缩。VERIFY 显式使用只更新 routing，独立验证证据才更新 verified usefulness。Catalog schema v8 使用独立语义 Embedding 哈希，纯反馈、层级、关系 relevance 和认识元数据变化保留 ready 向量，语义正文变化才进入重建队列；非 active Atom 删除向量并在恢复为 active 后重新排队。正式升级后 45 条旧向量均未重算或丢失。
29. 阶段 7 增强规模门已通过：500 个基础 atom、32 个带有效关系引用的 atom、256 次 working-set run 和双阶段共 512 条反馈在隔离数据根完成。关系 relevance 从 `0.94` 调整到 `0.68` 时候选分同步下降但 Embedding 调用数不变；目标 atom 经连续 release 后从首位降到对照 atom 之后，验证有用后重新回到首位。Catalog 灾难重建生成 500 个 active ready 向量，最大批次 16；run ledger 保留 16 条、Atom 最近反馈 id 保留 64 条，峰值 RSS 约 213 MiB。
30. 真实本地 BGE 规模与恢复门已通过：`verify:memory-v3-bge-soak` 使用活动数据根中已校验的固定 BGE 资产，只在系统临时目录生成 256 个基础 atom 和 286 条投影变更记录。首次维护前模拟模型不可用，256 个 pending 全部保留且没有调用 Embed；恢复后完成 512 维向量。语义更新阶段注入一次瞬时失败并在同一 drain 内回退成功。Catalog 删除重建后 256 个 active 向量全部 ready，零 pending/failed；全程阻断网络且实际网络尝试为 0，pipeline 在报告输出前完成 dispose，峰值 RSS 约 349 MiB。
31. 阶段 8 已完成本地 D1 相关性收敛：独立 task relevance 不再重复计算 confidence/importance；分支说明不再污染 Atom admission；branch/scope 内 FTS 可以找回近期 fallback 之外的精确旧 Atom；prime 检查每分支完整有界 D1 候选；D1 零 Embedding、向量仅限已导航分支 deep search。定向 4 个测试文件、33 项通过。
32. 阶段 9 已建立 Memory v3 专属运行时相关性门：D1 与 branch-scoped BGE deep search 分开测量，覆盖中英文、跨语言、冲突说法、近邻概念、项目作用域和无关负例。D1 正负例与误注入全部达标；争议说法不再压过当前有效规则；英文词项不做子串误匹配；10 次深搜只生成 10 次查询向量且零 scope 泄漏。固定门通过但保留一个英文长改写失败明细，不宣称默认 BGE 已达到完美跨语言召回。
33. 阶段 10 已建立动态 working set 与反馈演化门：Atom 输出使用显式边界，release 不再误删后续 Prompt 段，真实 Runner 请求验证正文退出和重新介入；KnownState 与 ledger 记录 adopted/excluded/reactivated。routing feedback 增加独立派生相关度和有效证据权重，旧影响随时间回归中性，新事件不会刷新并复活旧负反馈。记忆导航与 Skill 加载不算独立验证工具证据，未进入 active Context 或未被 VERIFY 使用的冲突候选不生成负反馈。正式 BGE 隔离门、重启和 vector deep search 已通过，正文、confidence 和向量哈希保持不变。
34. 阶段 11 已建立多轮任务语义门：`MemoryTaskQuery` 在当前请求自足时拒绝拼接历史，只有真实指代或 LS 方案引用才有界补充最近 2 条 user/assistant 文本；任务转向切断旧历史。D1、FTS 与分支内向量共用正向主题、硬排除和负向约束语义；完整 Atom 判定成为 D1 权威结果，兼容索引才做词法补判。正式 BGE 隔离门的 8 个 D1、2 个深搜案例全部通过，零 scope 泄漏、零网络尝试。
35. 阶段 12 已建立压缩后任务连续性门：Runner 把版本化会话摘要作为可选 `continuitySummary` 传入 Memory v3；只有真实指代且近期消息缺少任务锚点时才选取最多 4 段、1,000 字符摘要。当前请求、最近明确用户目标、任务转向和排除条件优先。初始注入在 `task relevance > 0.25` 后只保留最强相关簇，弱相关尾部不为填满上限进入 Context。正式 BGE 隔离门在重启前后 14/14 通过，并保持阶段 9、11 指标。
36. 阶段 13 已建立关系引导的一跳选择门：Runtime 只从已通过独立任务门的高相关种子出发，在同 branch/scope/subtree 内做有界、有方向、有证据的一跳发现；邻接 Atom 仍须独立通过任务价值、状态、证据和预算。7 个案例重启前后共 14/14，通过且零 scope 泄漏。
37. 阶段 14 已建立写入认识边界门：模型只能描述 statement kind、asserted source、domain 与 topics，Runtime 根据对话来源、成功工具证据和 VERIFY 决定认识状态与权威。旧 daily 原文追加蒸馏入口已删除，建议、用户陈述和工具事实不会被模型自行升级为已验证事实。
38. 阶段 15 已建立 Atom 相关性与关系调和门：有界实体/关系 hints 先经 Runtime 校验并以 proposed 持久化，只有 Atom 成功提交、引用关系且满足证据门后才激活；提交失败、中断补偿、跨 scope 拒绝、替代方向和未验证建议均有独立回归。专项 17/17，通过路线 strength 为 0.855，scope leak 与网络请求均为 0，重启前后结果一致。
39. 阶段 16 已建立 TaskBook 二次注入调和门：首次选择仍只使用原始请求；DECIDE 明确目标后，goal、验收标准与目标步骤作为独立加权锚点补充选择。新增 Context 与 working set、KnownState 和账本同步；重复检索不再把 adopted Atom 覆盖为 excluded，用户指令在自身权威范围内保持 adopted。隔离 Runner 验收确认目标 Atom 只在 TaskBook 明确后进入 EXECUTE，重复 query 跳过且零网络请求。

最近完成的工程阶段：

40. 阶段 17 已建立动态 Atom 激活层级：后端用连续、惰性衰减且不限制层数的 activation score 统一持久记忆和语义缓存的候选速度；真实采用且产生价值才升温，长期不用或无帮助逐步降温。该分数不改写语义 parent、事实 confidence 或 D0-D3，无关高频 Atom 不能越过任务门。前端只映射为带滞回的高/中/低三层只读汇总，不暴露 Atom 或原始分数。持久记忆和语义缓存共用有界投影跟踪器：只保留当前条目的上一层，刷新可防阈值抖动，移除条目即释放，重启自动清空。实现没有无界访问历史与全库常驻轮询；专项质量检查 `62/62` 通过。
41. 阶段 18 已建立实际负载只读观测基线：Runner 只聚合覆盖数、记忆访问、KnownState、VERIFY 显式使用、Provider usage 和 token 数据；命令行报告按修改时间有界选择日志，先脱敏投影再统计，不输出对话、回复、工具内容、路径或 Atom ID。正式 36 个 run 全部可读，但 20/10/10 三项默认校准门均未达到，因此只确认观测能力完成，不宣称 activation 已完成实际负载校准。
42. 阶段 19 已扩展实际负载质量、成本与资源观测：执行日志每轮只保留开始/结束两次粗粒度资源快照；报告增加最终 VERIFY、TaskExecution、Provider prompt/completion/cache/reasoning token、Memory/Provider prompt 比率和 RSS/heap 变化，并把旧日志缺字段保持为缺失。正式数据仍为 36/36 可读、0 拒绝、0 投影截断，0 个资源样本，五项校准门全部不足；“adopted 但未显式使用”只作为诊断代理，不等同误注入事实。
43. 阶段 20 已退役 Memory v2 的 archive 月/年摘要写入、旧 Vector 装饰写入和 CLI archive adapter。Memory Core 不再依赖 Config、LLM 或旧 Vector，CLI 不再引用 Vector project；旧类型和文件搜索只保留明确的只读兼容。卫生门禁止旧文件、主动符号和依赖回流；真实 CLI 子进程以退出码 2 在配置/Provider/用户数据加载前默认拒绝。阶段 20 验收时为 180 个文件、1317 passed、1 skipped；2026-07-31 当时工作树为 240 个文件、1650 passed、1 skipped，正式用户旧 archive/vector 文件仍未改写。
44. 阶段 21 已完成结构化 daily 一对一提升：压缩摘要只保留最近 64 个 source run，Repository 查询最多扫描 256 个候选、每批处理 8 个；Runtime 先写 project/long-term/experience T2 目标，再按 expected revision 归档源 Atom，失败保留源且不增加 LLM 调用。复杂多 Atom 语义合并仍必须先由模型提出结构化提案，再由 Runtime 校验提交。
45. 阶段 22 已完成模型提案的重复 Atom 合并校验：EVOLVE 使用独立 `reconciliations` 契约，普通 `merge` intent 不再旁路为写入；候选必须来自本轮 adopted KnownState，并通过 revision、scope、parent、认识边界、确定性语义锚点和冲突/替代关系检查。多 source 顺序复用原子 merge mutation；中途失败返回 partial，未提交 source 保持 active，重试识别已完成部分。协议与实现已拆为独立模块，定向 12/12 和全仓 typecheck 通过。
46. 阶段 23 已完成显式关系驱动的叶子 Atom 跨 parent 重组：EVOLVE 使用独立 `reparents` 契约，普通 `move` intent 只能延期审计；候选必须来自本轮 adopted 的当前 D2/D3 KnownState，并通过叶子、revision、branch/scope、关系方向、active/resolved、来源证据、confidence/relevance、提交和恢复检查。单轮最多 1 项，超额项写入 rejected 审计；真实 V3 Backend 回归确认 parent、Catalog、关系邻域、投影记录和重启后一致。非叶子子树由阶段 26 的独立协议治理。
47. 阶段 24 已完成有证据约束的同陈述 Atom 内容修订：EVOLVE 使用独立 `revisions` 契约，普通 `revise` intent 只能延期审计；候选必须来自本轮 adopted 的当前完整 D3 KnownState，并通过 VERIFY、Runtime evidence、revision、语义保留、硬锚点、长度、提交和恢复检查。单轮最多 1 项；真实 V3 Backend 回归确认 Atom、Catalog、投影记录、commit receipt 与重启一致，响应丢失后的重试返回 noop。
48. 阶段 25 已完成有证据约束的事实纠正/冲突替代：EVOLVE 使用独立 `corrections` 契约，普通 `conflict/invalidate` intent 只能延期审计；replacement 必须是本轮 adopted 的当前完整 D3，旧 Atom 可以 adopted 或 conflicted，但必须保持同 branch/scope/scopeKey/parent/statement kind。Runtime 验证通过的 VERIFY、来源权威、revision 和方向正确的 active/resolved `replaces`/`conflicts-with` 关系，只把旧 Atom 标记 superseded 并保留历史。真实 V3 Backend 回归确认管理读取、Catalog、投影记录、响应丢失恢复和 noop 重试一致。
49. 阶段 26 已完成有证据约束的非叶子子树重组：EVOLVE 使用独立 `subtreeMoves` v6 契约，普通 `move` intent 和叶子 `reparents` 均不能旁路。根与目标 parent 必须是本轮 adopted 的当前完整 D3，并通过 VERIFY、Runtime evidence、branch/scope、方向正确的 active/resolved 关系和最多 128 个 active descendants 的硬上限。真实 V3 Backend 回归确认只修改根 parent，后代父链/revision 不变，Catalog 有界计数、投影记录、重启和响应丢失 noop 恢复一致。

仍未完成：

1. 使用实际 Provider 完成正式 V3 会话、EVOLVE/CAPTURE 写入、模型对 `usedMemoryAtomIds` 的判断质量与长任务连续性验收；本地 activation、反馈演化和摘要使用证据门已通过，不能替代真实模型判断质量。
2. 在长期真实用户负载中继续观察 activation、BGE pipeline 的吞吐、Provider 成本、内存回落、半衰期和设备差异；先让只读报告达到至少 20 个 KnownState run、10 个显式使用 run、10 个 Provider usage run、20 个最终 VERIFY run 和 20 个资源样本，再进入参数校准评审。当前 46 个历史 run 的状态为 `insufficient`，不能用 256 Atom 的真实 BGE 隔离门、62 项 activation 专项或少量历史 token 替代数周真实使用数据。
3. 在正式使用场景继续验收索引导航、自动写入、关系长期演化、层级调整、内容澄清、事实替代、归档恢复和数据根整体迁移；daily 一对一提升、重复投影合并、叶子跨 parent、非叶子有界子树移动、同陈述修订和事实纠正/冲突替代校验已通过内部流程验收，实际 Provider 提案准确率、跨陈述重写和超大子树人工治理仍未完成，普通用户页面继续只展示记忆文件和三层汇总。
4. 在阶段 9、11、12 固定质量集之外继续扩充真实用户长尾表达、反讽、多重否定、跨数十轮指代、压缩摘要失配和更大作用域数据；现有门已能阻止基础误注入、旧历史污染、旧摘要复活和 scope 泄漏，但固定合成案例不能替代数周实际负载与高质量可选模型比较。

**验收标准**：断网时记忆可写、可导航、可检索；用户输入与对话区可见内容形成不可改写的对话原始来源；每次 Atom 变化具有投影变更记录与 commit receipt；atom 与数据库投影可从持久文件恢复；Atom 可在保留来源、证据、稳定 id 和审计的前提下去重、合并、调整层级、失效、恢复与重建；向量检索不能跨越未导航分支；所有 domain 使用同一 repository 并可从 D0/D1 渐进展开到 D2/D3；当前请求充足时不消费旧历史，真实指代只继承有界最近目标，任务转向不受旧话题污染，硬排除正文与方向一致的负向约束可正确区分；匹配作用域内经验证的高价值记忆稳定优先介入；即时 release 只改变当前 working set，跨 run 只留下有界 routing feedback且可重新介入；长期低收益可选记忆减少注入但强制信息不被误衰减；重复访问不会形成错误自增强；confidence、verified usefulness、routing/relationship relevance 与 importance/basePriority 分开治理；LLM 能获得所用记忆的必要来源、证据与 epistemic 元数据；用户目标/偏好在范围内受到尊重，客观 claim 不经验证不成为事实，建议被采纳也不改变其验证状态，错误建议不生成用户能力画像；每个执行阶段可追溯采用、排除和重新激活的 `KnownState` 版本与信息；事件在确认前持久化，重复处理幂等，崩溃、重启和关闭期间到期不会静默丢失；迁移可中断恢复和回滚且不丢节点。

### P0：持续维护与受控超限拆分

1. 仓库基元化阶段 0-7 已完成，后续由 33 项仓库卫生门持续保护，不再作为待实现功能重复规划。
2. 10 个超过 600 行的生产文件已登记所有者、暂缓原因、上限和 2026-08-15 复查日期；功能工作触及相应责任域时按拆分地图逐项收缩。
3. 新增核心协议必须有唯一权威来源；workspace 运行时依赖环、未公开深层 import 和未登记大型文件会直接使质量检查失败。

**验收标准**：新任务能从仓库指南和领域 README 定位所有者、入口与测试；跨模块契约只有一个权威来源；热点文件不再承接新领域职责；行为特征测试和全量质量检查保持通过。

### P0：核心模块契约收敛

1. 阶段 0 已完成：`ModeDefinition`、Context、附件、运行事件、TaskBookPatch、检查点、运行决议、模型请求、工具调用和执行证据的内部 v1 契约均已建立。
2. Runner 已生成深冻结的 `ResolvedRunConfig`；所有 Harness LLM 请求会解析并持久化独立 `LlmCallContract` 与有界快照；旧日志、会话、记忆和 workspace 恢复路径已有兼容测试。
3. 已按 [架构决策报告](architecture-decision-report.md) 新建并分域 Context Engine；来源 segment、版本化摘要、附件清单优先、按需附件工具、压缩阈值设置和双账本展示已接通。Provider reasoning/capability 契约回归已经修复，tokenizer 能力矩阵禁止计数器自行声明精确性；DeepSeek V4 普通请求的官方 tokenizer、最终请求 framing、本地精确 ledger 与 Provider usage 同请求对账已完成，含历史工具调用/结果的续轮保持 unavailable，其他 unavailable 模型继续使用不可展示的保守请求前预算保护。
4. 模型调用的输出上限、工具集合和 Context 来源已由契约统一限制；实际工具调用已收敛到统一 Tool Execution Service，并将来源、权限、超时、中断、清洗、事件和权威记录贯穿 Runner、Harness 与 Execution Log。下一缺口是让 MCP 和未来工具贡献点复用该服务，并补齐网络资源声明与更强授权 token。
5. 随新模块落地扩充现有依赖方向检查，继续阻止 App、渠道和插件内部实现反向进入 Harness/Runner 核心。

**验收标准**：每个跨模块职责只有一个所有者；Context 来源和 token 口径可追溯；Behavior Mode 与 Permission Policy 保持正交；内置、插件及未来 MCP 工具能够共享同一执行契约；全量回归保持通过。

### P0：真实能力验收

1. DeepSeek 已完成真实最小对话、continuity、工具调用、中断、普通直接回答本地 token 对账、Flash 工具协议 `15/15 exact_match` 和跨重启最终回答连续性；Pro 工具协议仍待模型专用 Provider 校准。OpenAI/GLM 只在用户实际配置并进入选择范围后执行同等测试，未配置状态不视为产品故障。
2. 隔离数据根中的实际 Electron 进程 + DeepSeek API 已验证活动 run 跨重启、暂停/中断 Checkpoint 强制终止后续跑、profile 热重载、两步 TaskBook、真实 `write/read` 副作用账本、4 个活动 run、双 Checkpoint 并行恢复、回答级记忆连续性、Token 精确对账、短时资源回落，以及单次 120 秒和正式 2 小时 `exec` 的安全暂停、重启不重放和句柄/内存回落；下一步验证真实网络中断、外部系统副作用和更长期真实用户负载。
3. 根据各供应商具体模型文档补齐 reasoning 参数、上下文上限和 usage 字段映射；不能用本地估算冒充真实 token usage。

**阻塞条件**：扩展到 OpenAI/GLM 时，需要用户在设置中提供对应可用密钥并接受真实请求成本；DeepSeek 普通回答不受凭证或 tokenizer 阻塞，工具续轮 exact 计数仍需基于实际 Provider usage 校准。

**验收标准**：每个供应商都能完成一次真实请求；失败、中断、工具审批和历史恢复结果可解释且不损坏用户数据。

### P0：Context、运行连续性与数据边界

1. provider/model tokenizer 能力分类已经完成：DeepSeek V4 Flash/Pro 声明为 `exact`，并且只有能力记录、请求格式与运行时 `counterId` 一致时才生成精确账本；OpenAI/GLM 及未验证模型保持 `unavailable`。DeepSeek V4 已通过应用内同请求 `968 = 968` 对账；unavailable 模型继续使用复用最终 Chat Completions 载荷的保守估算完成请求前防溢出，该估算固定为不可展示。下一步只按实际启用范围增加模型专用计数器与校准证据。
2. 有界队列、Local App API ingress、安全决策边界、确定性 `TaskBookPatch`、延迟事件重规划和 Renderer 生产入口已经接通；普通追加消息、设置变化与工作区文件保存都使用稳定事件身份并显示可解释结果。TaskBook 步骤也已按显式依赖、资源与副作用契约实现默认 2、硬上限 4 的有界并行；缺失或不安全契约保守串行，实际资源越界由统一工具服务拒绝。
3. 版本化 `RunCheckpoint`、原子 store、disposition/controller、Runner 显式续跑、幂等副作用拒绝、有界恢复校验、应用启动发现以及恢复/放弃/查看现场控制面已经实现；检查点可同时记录最多 4 个活动步骤。隔离 Electron 已证明强制终止后可以恢复且不会重复追加原始输入；下一步验收实际 Provider、并行外部副作用与可恢复故障语义。
4. T0-T3 基础注册表、v1→v2 版本化迁移、统一 Memory Service、Summary Memory、run-scoped 附件、运行时事件账本登记端口，以及项目记忆“用户数据权威源 / 项目内私有投影 / 可共享导出”三层契约与控制面已实现。项目稳定 ID、旧 ID 兼容和可恢复路径重绑定也已完成；`RuntimeEventQueue`、`TaskBookPatch`、Renderer 生产/反馈、启动恢复控制面、TaskBook 步骤级并行、活动任务控制、托盘、三档关闭策略和设置页后台控制已有工程基线，隔离 Electron 跨重启、DeepSeek API 实测 两步副作用、短时并行压力、120 秒与正式 2 小时持续任务、回答级连续性门已完成；当前缺口是外部系统副作用和真实网络故障验收。
5. 附件缓存、workplace 有界资源索引和可回滚完整数据根迁移已进入独立、索引驱动的数据生命周期。数据根迁移由外部 locator 登记，设置页只登记目标并明确要求重启；启动阶段在 Runner、Local App API 和插件宿主创建前暂停结构性写入，复制到目标同级 staging，跳过符号链接/junction，以流式 SHA-256 清单校验全部普通文件，只重绑定活动元数据中原本位于旧数据根内的路径，再原子提交。源目录保留，校验失败继续使用旧目录，提交后 locator 切换前中断可恢复，回滚在下次启动切回前一个仍存在的数据根。当前完成的是隔离临时目录工程验收，不代表已替用户迁移正式数据。
6. 后台任务已配套托盘、状态提示、暂停/继续/中断、彻底退出、三档关闭策略和设置页活动列表；列表使用 `active_runs` SSE 实时同步，并保留手动快照刷新作为校准入口。隔离实际 Electron 进程 + DeepSeek API 已验证关闭到托盘继续运行、活动任务 SSE、暂停/继续/中断、强制终止、并行重启续跑、profile 热重载、SSE 反复断开重连后的 listener 释放、120 秒与正式 2 小时持续任务后的资源回落和彻底退出；下一步验证托盘不可用时默认拒绝、真实网络断线和更长期真实用户负载。

**当前事实**：Harness 已把模型请求映射为显式 Context 候选并交给 `@littlesheep/context` 准备。完整执行路径继续把基础策略、记忆根索引、bootstrap、输出约束、Workflow/TaskBook、profile 和 reasoning 独立登记；已收敛的 `respond` 路径使用紧凑 Prompt，只保留回答所需的身份、能力名、`USER.md`、受限记忆索引、相关摘要/Atom、最近历史和输出约束。DeepSeek V4 Flash 普通请求与 Provider 工具协议的本地精确账本都在发送前生成，Provider usage 绑定同一快照并用于校准；工具协议当前只覆盖 Flash，Pro 工具请求继续默认拒绝 exact。用户未点名工具的自包含只读目标由 LLM 在 builtin `glob / grep / read` 中选择，紧凑 Context 不带历史和未采用记忆；只有 `excluded` 候选不会阻断，实际采用/冲突记忆、working set、附件、续接或恢复态都会回退完整 Context。直接续答在首个 Provider 回答后执行一次纯本地连续性检查；只有明确断档才追加一次修正请求，正常回答与普通任务不增加调用。UI 只在来源可证明时显示本地精确装配，并分行显示 Provider 实测与差异。unavailable 请求只使用 `displayable: false` 的保守安全估算防溢出，不向用户冒充真实 token；旧会话没有可复现的历史最终载荷时只显示尚无本地计数。当前 DECIDE 输出上限为 1400，直接 REPLY、连续性修正与重复改写上限为 1200；这些值仍是 stage 局部预算，尚未由 Provider capability 统一解析。

版本化 Summary Memory、附件清单优先与按需正文工具、T0 根索引、项目记忆投影、稳定项目 ID、路径重绑定、统一 `MemoryService`、数据根迁移和压缩阈值设置继续沿既有工程基线工作。统一 Tool Execution Service、工具调用级与 TaskBook 步骤级有界并行、自包含单只读工具的 `decide_explicit_tool`、完全访问下受限内置 `exec` 直接提议、完整显式多工具提议路径、运行中事件安全消费、确定性 TaskBookPatch、Renderer 事件生产/反馈入口、Runner 显式续跑、应用启动恢复、活动任务控制、托盘、三档关闭策略和设置页后台控制入口已经实现。2026-08-04 的仓库卫生、全量测试、27 包 workspace typecheck、Electron build、恢复源检查、DeepSeek API 实测 单工具和多轮五字段摘要回答均已通过；2026-08-03 已完成两步后台副作用、跨重启回答、短时并行压力、120 秒诊断门和正式 2 小时持续任务验收。最终全量数字以本文件验证表为准。恢复检查仍明确报告部分旧 run 缺执行日志与可选 workspace artifact 索引缺失。这些证据仍不等于非字段事实、外部系统副作用、其他 Provider 矩阵或生产发布已就绪。

**验收标准**：每项 Context 可追溯且不超预算；未知 tokenizer 不显示伪精确 token；追加要求不重做已完成副作用；活动 run 可在重启后从检查点恢复；所有循环有界；用户数据迁移可验证、可回滚；后台运行始终可见、可终止。

### P1：长会话与记忆质量

1. `packages/session/src/compaction.ts` 已实现非破坏式、版本化和可增量合并的 Summary Memory；阶段 12 已证明压缩后“继续”类请求能在重启前后从版本化摘要恢复任务锚点，且不会压过当前明确目标、任务转向或 scope。下一步仍需实际 Provider 长会话、模型摘要失败、摘要失配、工具副作用恢复和成本场景验收。
2. 旧 `packages/memory-core/src/distill.ts`、archive 月/年摘要写入、Vector 装饰写入和 CLI archive adapter 已在阶段 14/20 退役，仓库卫生门阻止其回流。阶段 21 已完成结构化 daily 一对一提升；阶段 22 已开放受限的 duplicate-projection 合并，阶段 23 已开放受限的叶子跨 parent 重组，阶段 24 已开放受限的 same-claim-refinement，阶段 25 已开放受限的 evidence-backed correction/conflict replacement，阶段 26 已开放受限的非叶子 subtree move。模型只能提出本轮 KnownState 内的结构化方案，Runtime 负责证据、语义/关系边界、规模上限、审计、原子提交和恢复。下一步评估实际 Provider 提案质量、跨陈述重写和超大子树人工治理。
3. 对旧用户数据中缺少执行日志、缺少可选 workspace artifact 索引的情况制定只读诊断和渐进治理；workplace 资源索引在下一次真实 run 时按需创建，不为消除警告而提前扫描或改写用户文件。
4. 实体/关系 catalog、自动关系投影、提交后激活、启动补偿和冲突/替代调和已完成阶段 15 质量检查。下一步在实际 Provider 与持续用户负载中验证 Runtime 是否仍能以最少且足够的 Atom 完成本轮任务，并持续保持零 scope 泄漏、可解释采用/排除、执行中可释放/重入和重启一致性。Skill 合并仍先给出可审查方案，低收益 Skill 优先停用或归档，删除必须经过引用检查、保留期与恢复验证。

**验收标准**：长会话压缩后仍能沿记忆树恢复关键事实、任务约束和来源；压缩过程可追溯、可失败回退，不制造孤立记忆。

### P1：拓展工作区与渠道场景

1. 在真实项目中连续验收文件树、标签、编辑冲突、终端 PTY、权限模式、产物索引和重启恢复。
2. 使用真实渠道凭证验收消息插入 Agent 和回复回传；渠道异常不能影响本地 UI 核心。
3. 在已有 PTY/ConPTY 基础上，决定是否开放受控的原始键盘直通与交互式程序；同时完善发布环境下的原生模块装载/回退，并单独评估重度 IDE 能力。
4. 拓展工作区中的浏览器已完成基础真实能力：HTTP(S) webview、内部链接/新窗口回收、独立前进/后退/刷新和 50 条 URL 历史已接通；仍需在真实网络、重定向、登录态和重启场景中持续验收。侧边聊天仍是占位工作面。

**验收标准**：主对话区、拓展工作区和侧边栏相互独立；应用重启后布局、标签、会话和产物状态符合持久化约定。

### P1：开发环境正式分发

- 设置页的版本偏好、导入、移除和终端优先路径已经形成基础闭环，但当前只有 Electron 内置 Node 随应用提供，其他运行时仍需要用户准备并导入已解压目录。
- 后续必须先完成官方来源锁定、SHA-256/签名校验、取消与恢复、低磁盘空间和损坏包清理，再决定哪些运行时随安装包提供、哪些按需下载。
- Windows 真实工具链目录布局和原生可执行文件导入矩阵仍需人工验收；不能把 Linux 定向测试替代 Windows 分发证据。

**验收标准**：用户能在设置页选择并验证目标版本；终端在重启后继续使用同一受管版本；下载、升级、取消、恢复和卸载不会损坏用户数据根或遗留半成品工具链。

### P1：发布与安装

- 当前只有源码构建和本地快捷方式流程，尚未完成签名安装包、升级、卸载、原生依赖分发和发布回滚流程。

**验收标准**：在干净 Windows 环境安装、启动、升级和卸载；用户数据与应用版本升级解耦且不丢失。

### P2：MCP 与生态扩展

- MCP 客户端当前尚未实现，原空骨架包已移除。需要先明确服务器生命周期、权限、工具命名冲突、超时、日志和用户批准策略，再从接入统一 Tool Execution Service 的稳定 adapter 开始实现。

**验收标准**：MCP 工具遵守与内置工具相同的权限、清洗、超时、执行记录和恢复契约。

### P2：插件生态扩展

- 插件 API v1 当前接通 `channel`、`tool` 和声明式 `skill`。供应商、记忆分支、工作区、自动化和 renderer UI 仍是规划中的扩展位，不能通过增加 manifest 字符串冒充已实现。
- 后续每个扩展位都要单独定义宿主接口、权限边界、持久化目录、启停/升级/失败恢复语义和 UI 管理入口，再升级 API 版本。
- 还需要补充插件安装、版本兼容、签名/来源提示和卸载流程；目前以用户数据目录发现和手动放置为主。

## 推荐后续顺序

1. 保持当前 DeepSeek chat、continuity、tool、abort、跨重启最终回答连续性、一次有界断档纠偏、Flash 普通请求与工具协议 `15/15 exact_match`、显式单工具 Prompt `796` 和自主 `glob / grep / read` 的 `2 API / 1 tool / 1,200 total prompt` 契约为回归门；最新采样为 `1,009 / 979 / 924`。下一步先扩展非字段事实和外部系统副作用的回答级验收，再按实际启用范围为 Pro/其他 Provider 建立独立校准。自主路径只在权限、schema、工具证据、结构 VERIFY 和实时最终回复均保留时继续缩短。只有 OpenAI/GLM 实际配置并进入用户选择范围后，才为其执行同等真实校准和模型专用 tokenizer 验证。远程 Embedding 不纳入默认路径。
2. 在正式 V3 上验收真实会话写入、索引导航、验证反馈、本地向量持续维护和应用重启连续性，并继续积累 KnownState、显式 Atom 使用、最终 VERIFY 和资源样本。
3. 在已完成的统一 Tool Execution Service 上补齐网络资源声明、授权 token 与 MCP adapter 验收，但不再建立第二条工具执行路径。
4. 保持已完成的 RuntimeEventQueue、安全边界、TaskBookPatch、Renderer 事件生产、TaskBook 步骤级并行、Runner 续跑、应用启动恢复、活动任务 SSE、设置页“应用与后台”、托盘、三档关闭策略、shadow Git 检查点、隔离 Electron 跨重启、DeepSeek API 实测 两步任务、短时并行压力、120 秒诊断门和正式 2 小时持续任务质量检查；下一阶段验收真实网络中断、外部系统副作用和更长期真实用户负载，之后再推进开发环境正式分发、Mode Registry、插件 API v2 与 MCP。

## 维护规则

- 本文件只记录当前事实和可复现证据；完成一项能力必须同时更新测试、构建证据和本文件。
- 每次更新当前状态时记录精确到秒的验证时间，并区分“最近一次绿色基线”“当前工作树结果”和“历史专项验收”；三者不能互相替代。
- 任何“已完成”都要说明范围：基础形态、配置层、连接器层和真实场景验收不能混为一谈。
- 不把用户密钥、用户会话、记忆树或工作区文件复制到仓库；运行时数据只在用户数据目录中维护。
- 顶层分工见 [architecture-principles.md](../principles/architecture-principles.md)，当前架构评估和决策点见 [architecture-decision-report.md](architecture-decision-report.md)，目录和模块归属见 [repository-guide.md](../reference/repository-guide.md)，插件边界见 [plugin-development.md](../reference/plugin-development.md)。
- 当前先行仓库整理和认知契约见 [总基调、认知架构与仓库基元化任务书 2026-07-15](../taskbooks/foundation-cognition-repository-taskbook-2026-07-15.md)。
- Memory v3 的原子文件、层级、内置向量目录、三层视图、动态注入、压缩连续性和迁移边界见 [原子记忆与内置向量目录任务书 2026-07-17](../taskbooks/memory-atom-vector-catalog-taskbook-2026-07-17.md)。
- 核心能力细节见 [核心 Agent 能力任务书 2026-07-13](../taskbooks/core-agent-capability-taskbook-2026-07-13.md)，拓展工作区细节见 [拓展工作区任务书 2026-07-12](../taskbooks/extension-workspace-taskbook-2026-07-12.md)。
- Context、记忆分级、附件、运行中重入、有界并行、检查点和后台连续执行的专项计划见 [Agent Runtime 连续性任务书 2026-07-14](../taskbooks/agent-runtime-continuity-taskbook-2026-07-14.md)。
- 本轮工具并行、shadow Git、退出冻结、LLM 调用收敛和前台人格表达边界见 [Agent Runtime 效率与版本化连续性任务书 2026-07-17](../taskbooks/agent-runtime-efficiency-versioning-taskbook-2026-07-17.md)。
- 开发环境版本管理、工具链导入、终端优先路径和后续运行时分发边界见 [开发环境管理任务书 2026-07-19](../taskbooks/development-environment-taskbook-2026-07-19.md)。
