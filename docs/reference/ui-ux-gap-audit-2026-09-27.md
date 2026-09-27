# 产品级 UI/UX 差距审计 2026-09-27（按用户可感知程度排序）

最后更新：2026-09-28 01:15:20

本文件是"低于成熟桌面 AI 工具正常体验水平"问题的**唯一排序清单**，由四组并行的界面区域审计产出后合并去重。它的用途是决定**先修什么**，不是罗列所有可改之处。

## 方法与硬约束

- **证据必须标注种类**：`窗口` = 真实 Electron 窗口观察到（含截图/DOM 文本）｜`源码` = 读代码得到 ｜ `推断` = 由前两者推理，未经实测。三者不得混写。
- **已解决的基础交互默认不创新**（用户 2026-09-27 硬约束）：先说出 Linear / Cursor / Claude / ChatGPT / VS Code 在该场景的既有做法，再指出 LS 偏离在哪里。**偏离且更差的**才是 P0/P1；**只是长得不一样的**最多 P2，默认不做。
- **等级**：**P0** = 破坏核心回路或让用户失去信任；**P1** = 明显低于水准、每场会话都会被注意到；**P2** = 打磨。
- **明确排除**：新增架构能力、猜测性视觉重做、纯口味偏好、以及**收益说不成用户可见结果**的改动。需要新架构的标 `out of scope`。
- 每项修复完成后必须用**真实 Electron 或对应门禁**证明改善，并在本表"修复状态"列写明证据。

## 已确认的发现（按感知程度排序）

| # | 级别 | 症状（用户可见） | 证据 | 既有约定（LS 偏离处） | 最小修法 | 修复状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **1** | **P0** | **未配置模型时发送仍可点，发出后 run 永不结束**：界面写着"还没有配置模型"，却在 +75 s 仍"正在工作 · 1m 14s"、0 字符、无报错、不结算 | `窗口`（1.5→75 s 采样 + 截图）＋`源码`：`composer-view.tsx:276` 只 gate 就绪与空草稿；Runtime 报 `model: "openai/gpt-5.6"` 而三个供应商 `hasKey:false`（`defaults.ts:7-39,164,173-188`、`runner/infra.ts:176-194`）→ 投给无法应答的供应商 | ChatGPT / Cursor / VS Code **拒绝提交**并指向模型设置；没有人会把请求发给未配置的供应商 | 用 Runtime 自身的可用性事实禁用发送与空态文案（沿用已有"配置模型"原因）；**不加队列/重试/运行时能力** | 修复中（真实窗口复现 + 反例"配好供应商仍能发送"待证据） |
| **2** | **P1** | **启动后直接打字无反应，必须先点输入框**：就绪时 `document.activeElement` 为 `BODY`，真实按键不插入字符；显式 `focus()` 后同样按键即可输入 | `窗口` ＋`源码`：`composer-view.tsx:170-173` 是唯一焦点路径，启动与新会话均不聚焦 | ChatGPT / Claude / Cursor / VS Code **启动即聚焦输入框**，新会话同样聚焦 | 启动可交互时与新会话时聚焦 composer；不得抢弹窗/审批焦点，也不得覆盖用户已移走的焦点 | 修复中（需"不点击可输入" + "弹窗打开时焦点不被抢"两条证据） |
| **3** | **P1** | **渲染器加载前的启动失败是死路**：只渲染"无法启动"+ 原始报错，**零控件**；Main 已标 `retryable: true`，但重试控件只存在于按定义未挂载的 React 通知里 | `窗口` ＋`源码`：`index.ts:551-559`、`runtime-readiness-notice.tsx:57` | VS Code 失败页给 Reload；Slack / Notion 给 Retry | 在启动页加**一个**重试控件，复用已有重试路径，不新增 IPC 面 | 修复中（需强制走该失败路径并证明重试生效） |

## 待并入（四组审计的其余三组）

| 区域 | 状态 |
| --- | --- |
| 阅读与流式对话（滚动锚定、流式结算、代码/表格、工具行、复制反馈、超长会话） | 审计中，已索取 top-3 |
| 输入区与交互回路（输入法、停止键、草稿、选择器、焦点返回、窄窗口） | 审计中，已索取 top-3 |
| 设置 + 工作区 + 浮层（可发现性、保存/生效状态、危险操作、审阅/终端/浏览器、审批与通知） | 审计中，已索取 top-3 |

## 已知但尚未验收的相邻项（来自前端任务书，不重复计为本次发现）

- **O1 / S1 / V1 / V3** 代码已落地（`1f161ee4`、`505682c6`、`8419c890`、`ba485fc1`），但**均未完成实机验收**，各自缺口见任务书台账。
- **`verify:electron-ui-state-continuity` 既有红灯**：`assertWindowState` 的 `expected 1115, received 1101`（±12px 原生窗口几何），判定为**既有**、非本批引入；残留缺口是"在干净检出（`ui-baseline-2026-09-27`）上复跑一次"以形成同口径对照。

## 本轮在途状态与交接（2026-09-27 23:5x，round 19/20）

本节的用途：**未提交的工作不许变成来历不明**。会话可能在任意轮次结束；下列内容都在工作区里、尚未提交，接手者据此判断它们是什么、证据缺什么、谁在做。

### 在途工作包（工作区未提交，全部属于对应包的进度）

| 区域 | 文件（示例） | 包 / 负责人 | 交付时要什么证据 |
| --- | --- | --- | --- |
| **O5 跨日用量聚合契约**（任务书 O5） | `packages/runner/src/provider-usage-daily-*.ts`、`packages/app/src/main/local-app-api/usage-routes.ts`、`packages/app/src/shared/local-app-api-routes.ts`、`packages/runner/src/durable-event-store.ts`、相关 README 与拆分地图行 | O5 工作包 | 分叉/重放/重试**只计一次**的测试（构造真实形状）；"没有事件的一天"与"用量为零的一天"可区分；有界响应；回填可取消可续接不重复计数；仅凭事件可重建聚合 |
| **P0 未配置模型仍可发送**（本文件表内 #1） | 预计落在 `packages/app/src/renderer/app-shell/composer-view.tsx` 与运行时可用性判定 | P0 修复包（前一个包静默死亡，已重派） | ①全新数据根 + 无 key：真实窗口显示**拒绝发送且带可见原因**，并证明**没有 run 被启动**；②配好供应商时发送**仍正常** |
| **O1 结果与异常层级**（任务书 O1，代码已提交 `1f161ee4`） | `packages/app/src/renderer/chat/**`、`scripts/verify-transcript-state-visibility.mjs` | O1 工作包（已恢复运行） | 真实窗口下四类组合取证：整体完成但局部失败、非 `pass` 结论、等待决定、手动收起过程（两种模式） |

### 仍在运行、尚未交回的审计

阅读与流式对话（B）、输入区与交互回路（C）、设置 + 工作区 + 浮层（D）三组已要求给出 top-3 临时结论，**截至本轮尚未回**。它们回来后按同一格式并入上表，并按"是否偏离既有约定且更差"重新裁定等级。

### 流程教训（值得保留）

- 我给一个工作包同时派三项修复，它**启动后静默失败**且在工作区里没有任何痕迹；我上一轮把"没有落笔"解释成"在复现问题"，那是**假设而非观测**。现在改为按可观测事实判断（能否发消息、有无文件写入），并且**一个包只做一项 P0/P1**、要求增量交付。
- 跨工作包清理 %TEMP% 时误删他人 scratch 目录：审计之间不要共享可写临时目录，各自 `mkdtemp` 并容忍其消失。

## 本轮结束时的状态（2026-09-28，round 20/20）

### 结论：本目标**未完成**，不标完成

- **排序清单本身已交付** ✓：本文件表内 P0×1 + P1×2，全部来自**真实窗口观察** ✓，每条都写明偏离的既有约定与最小修法 ✓。
- **但修复未验收** ✗：P0 的修复包在会话末期才重派，**没有任何实机证据**回传 ✓ → 表内状态保持"修复中" ✓，不改成"已修复" ✗。
- **三组审计（阅读流式 / 输入回路 / 设置+工作区+浮层）未交回** ✗ —— 因此清单**不完整** ✓：它覆盖了首次运行与启动这条链路 ✓，其余三个区域仍是"待并入" ✓。任何"LS 的 UI/UX 问题已扫完"的说法都与事实不符 ✗。

### 下一手第一步（按顺序）

1. **验证 P0 修复**（表内 #1）：在全新数据根、无 provider key 的真实窗口里，确认发送控件**拒绝并显示原因**、且**没有 run 被启动**；再确认配好供应商后发送**仍正常**。拿到这两条证据才把状态改为"已修复"。
2. **收 B/C/D 三组的 top-3**（我已向它们索取 ✓）：并入本表时按"先点名既有约定、再说 LS 偏离、偏离且更差才 P0/P1"重新裁定 ✓，并**去重** ✓（"等待时没有进度感"这类现象会跨区域重复出现）✓。
3. 按本表从 P0 向下逐条修 ✓：一个包只做一项 ✓、要求增量交付 ✓、每条修完用真实 Electron 或对应门禁证明 ✓。
4. 相邻但不重复计的项：前端任务书 O1/S1/V1/V3 的实机验收缺口（见任务书台账）与 `verify:electron-ui-state-continuity` 的既有窗口几何红（`expected 1115, received 1101`，缺"干净检出复跑"对照）✓。

### 并发写作者的干扰（记录在案，不是我的改动）

本轮结束时 `check:repo` 为 **37/38** ✓，唯一失败来自**另一个 agent 在途的 sandbox 工作** ✗：`packages/harness/src/stages/execute/tool-loop.ts`（670 > 受控上限 660 ✓）与 `packages/tools/src/tool-execution-service.ts`（715 > 660 ✓），以及两条对应的拆分地图计数漂移 ✓。这两处**不在本次审计的范围内** ✓，我未触碰 ✓；接手者若看到门禁红，先确认是不是这两个文件 ✓，不要误判成本次扫描的产物 ✗。

### 写冲突与回收事件（2026-09-27 23:57，必须知道）

- **P0 的修复其实一直在被写** ✓：`packages/app/src/renderer/composer/{send-readiness.ts, send-block-notice.tsx, use-model-availability.ts, use-composer-focus.ts}`（新文件）＋ `app-shell/composer-view.tsx`、`composer/runtime-availability.ts`、`runtime-picker.tsx`、`app-shell/chat-view.tsx`、`use-app-controller.ts`、`app-controller-presence`、`composer/focus-routing.ts`、`sidebar/session-actions.ts` 的编辑，时间 23:51–23:55。**它同时覆盖了表内 #1（发送门禁）与 #2（焦点）** —— 设计与我给修复包的指令一致（`describeComposerSendReadiness(availability, executionReason)` → 阻断；发送禁用 + `aria-label` 原因；Enter 同样受门禁；`.composer-send-block` 可见提示）。
- **我一度误判它已死亡** ✗：给我的包发消息返回 `active teammate not found` ✓，我把这当成"包已死" ✓，实际上包在继续工作、只是**邮箱被回收** ✗。教训：`not found` 只说明**不可寻址** ✓，不等于**没在跑** ✗ —— 判断"有没有人在写"必须看**文件 mtime** ✓（本次正是靠它发现真相 ✓）。
- **另一份独立取证包（`ca2ee04e`）报了冲突并提议正确的分工** ✓：它不重复实现 ✗，改为**独立产证** ✓（全新根无 key → 拒绝 + 无 run 启动 + `/run/stream` 从未 POST + 覆盖 Enter；配好供应商 → 端到端仍可发送 ✓），并等树稳定（静默 5 分钟 + typecheck 干净 ✓）后再构建 ✓，以免两个并发构建互相覆盖 `packages/app/out` ✓。**它的判断与建议都对** ✓ —— 但我**无法回复它**（同样不可达 ✗），所以这条分工只保留在这里 ✓。
- **该修复批次当前是红的** ✗，因此**没有提交** ✓：`tsc -b` exit 0 ✓，但渲染器套件 2 项失败 ✗ —— `composer/control-surface-style.test.ts`（"reuses the workspace tab frame treatment across non-submit controls" ✗，疑与 V1/V3 的样式层改动交互 ✓）与 `composer/runtime-availability.test.ts`（"offers the action inside the empty picker menu instead of only a title" ✗，写者自己的新测试 ✓）。**红就是红** ✓：表内 #1/#2 状态保持"修复中" ✓。
- **命令可用性坑** ✗：末期某些 shell 里 `pnpm`/`pnpm.cmd` **不在 PATH** ✗，而我最初两次把"命令没跑起来"当成了"检查通过" ✗（`$out` 为空是报错造成的 ✗ 不是通过 ✓）。**正确做法**：用 `node node_modules/typescript/bin/tsc -b tsconfig.workspace.json --pretty false` 与 `node node_modules/vitest/vitest.mjs run <paths>` 直调 ✓，并以 **exit code** 判定 ✓ —— 上表结论即由这两条命令得出 ✓。

### 00:32 状态更新（来自 chali 冲突报告包的实测，均已固化）

| 事实 | 数值 / 结论 | 意义 |
| --- | --- | --- |
| `tsc -b` | **exit 0**（00:24） | 类型层自洽 |
| 渲染器套件 | **exit 0，144 文件 / 821 项通过**（00:23） | ⚠️ **此前记录的 composer 2 项失败已消失** ✓ —— 表内 #1/#2 的**代码**现在是通过状态 ✓，但**实机验收证据仍未产出** ✗，故状态保持"修复中" ✓ |
| `check:repo` | **exit 1，恰好 1 项失败**：`公开文档和脚本不含本机路径或账号: scripts/lib/experiment-sandbox.mjs: <user>` | 这**不是**我此前预告的 `tool-loop.ts` / `tool-execution-service.ts` 超限 ✗（那两项此刻不存在 ✓，地图计数也一致 ✓）。**归属**：另一个 agent 的 sandbox 工作（他们的新脚本把用户机器路径写进了跟踪文件 ✗）。**未修** ✓：不属于本次审计范围，且是他们的在途文件 ✓；接手者应把它还给他们或直接删掉路径字面量 ✓ |
| 顶部条高度 | `DESKTOP_TITLEBAR_HEIGHT = 32`（`desktop-startup-page.ts:18`）✓、`titleBarOverlay.height = WINDOW_TITLEBAR_HEIGHT`（`desktop-shell.ts:288`）✓、CSS `--window-titlebar-height: 32px`（`03-shell-sidebar.css:132`）✓ —— **三处一致 32px** | 用户"顶部条高度与窗口控制按钮高度一致"的要求**在常量层面已经满足** ✓；**未测**的是真实窗口里原生控制按钮的像素高度 ✗（chali 实施包被要求补这一步 ✓）|

### chali 布局的重复实现冲突：按 (A) 处理

- 我先后派了两个 chali 包：第一个（早先那个）邮箱被回收 ✗，我误判为"已死" ✗ 于是重派了第二个 ✓；结果第一个**一直活着** ✓ 且已改到第 4 个文件 ✓（`app-view.tsx`、`global-titlebar.tsx`、`03-shell-sidebar.css`、`07-overlays-settings.css` ✓，方案与我给的任务书一致 ✓：新增 `WindowDragRegion` 覆盖侧栏上方的拖动带 ✓、`--settings-content-origin-y` 去掉 `-32px` 偏移 ✓、标题栏移入 `.app` 网格内 ✓）。
- 第二个包**正确地拒绝动手** ✓（第二个实现 = lost update ✗），并给出 (A)/(B)/(C) 三选 ✓。**我裁定 (A) 停手、交出方案与测量** ✓ —— 它交回的高度调查正是上表第 4 行 ✓。
- **教训（第二次同类）** ✗：`active teammate not found` **只表示不可寻址**，不代表没在跑 ✗。判断"有没有人在写"必须看**文件 mtime** ✓（这次又是靠 mtime 才确认第一个包活着 ✓）。以后派包前先查 mtime，再决定是否重派 ✓。

### chali 尚未完成的缺口（由冲突包指出，交给在跑的那个包）

侧栏上方左上角的拖动带是否真正覆盖 ✓、导航控件（折叠/前进后退）在新结构下的位置与可达性 ✓、残留的 32px 假设（`.settings-workspace { inset: 32px 0 0 }` ✓、`11-runtime-readiness.css` 的 `top: var(--window-titlebar-height)` ✓）、四个陷阱的逐项核验 ✓、真实窗口对照截图 ✓、README 与拆分地图同步 ✓。

### 构建争用阻塞了三条修复的实机取证（2026-09-28 00:45）

**观测**（node 直调 ✓，`pnpm` 在部分 shell 里不在 PATH ✓）：
- `node scripts/ensure-app-build.mjs --ensure` **失败** ✗；
- 三条门禁 `node scripts/verify-composer-send-gate.mjs` / `verify-composer-focus.mjs` / `verify-startup-failure-retry.mjs` **全部 exit=1** ✗，错误一致：`App build artifacts are stale (input-mismatch)` ✓。

**原因**：chali 布局写者正在持续修改 `packages/app/src/**` ✓，构建输入在构建过程中变化 ✓ → 构建守卫中止 ✓ → 依赖"构建新鲜"的真实窗口门禁**无法开跑** ✓。这与修复包自己的告警一致 ✓（"另一个 agent 每几分钟重建 `packages/app/out`，门禁会在任何断言之前因 stale build 失败" ✓）。

**结论**：表内 #1/#2/#3 的**代码已在树中** ✓（渲染器套件 **144 文件 / 821 项通过** ✓、`tsc -b` exit 0 ✓），且**两个独立实现的门禁在契约上一致** ✓（对方 `scripts/verify-composer-send-model-gate.mjs` 断言的 `.composer-send-block` in `.composer-right`、同一句 `aria-label`、禁用发送、草稿保留、无 run ✓ —— 与修复包产出的 DOM 完全一致 ✓）。但**实机验收证据仍为零** ✗ → 状态保持"修复中" ✓。

**下一手**：等 chali 写者停止改动 `packages/app/src/**`（mtime 静默 ~5 分钟 ✓）后，按顺序跑：
`node scripts/ensure-app-build.mjs --ensure` → `node scripts/verify-composer-send-gate.mjs` → `node scripts/verify-composer-focus.mjs` → `node scripts/verify-startup-failure-retry.mjs`；
另跑对方那条 `node scripts/verify-composer-send-model-gate.mjs` 作为**独立复核** ✓。**判定只看 exit code** ✓，不看"有没有报错行" ✗。

**`pnpm` 不在 PATH 这个坑，我今晚踩了三次** ✗：三次都表现为"输出为空" ✓ 而实际是命令根本没跑起来 ✓。**规则**：所有检查一律用 node 直调脚本 + `$LASTEXITCODE` 判定 ✓；`pnpm run X` 只用于确认入口存在 ✓，不用于判定结果 ✗。

### P0 的独立实证已到手（2026-09-28 00:5x）—— 表内 #1 的验收证据

由**独立取证包**的真实窗口门禁 `scripts/verify-composer-send-model-gate.mjs` 给出（与修复作者的门禁是**两个独立实现** ✓，二者在 DOM 契约上一致 ✓）：

**拒绝路径（全新数据根、三档预设均无 key、`/runtime` model 为默认值、readiness=ready）** ✓：
- 发送控件 **disabled** ✓；`aria-label`、行内 `.composer-send-block` 与首屏 `.empty-copy` **三处都带同一句原因**"还没有配置任何供应商；在 设置 → 模型供应商 里添加服务、密钥和模型。" ✓；
- **两种入口都被拒绝** ✓：指针点击控件 ✓ **与真实 CDP Enter（带草稿）** ✓；
- `/run/stream` 的页面 fetch 探针计数 = **0** ✓；`GET /application/active-runs` = **`[]`** ✓；**没有**用户消息、**没有**助手回合、**没有**停止控件 ✓；**草稿保留** ✓。
- 证据文件：`%TEMP%\littlesheep-run-artifacts\composer-send-model-gate\composer-send-model-gate.json` 与 `unconfigured-refusal.png` ✓。

**可用路径（配好 acceptance provider，model `acceptance/slow-a`）** ✓：发送可用 ✓ → 点击后 `POST /run/stream` **恰好 1 次** ✓ → **2 次** Provider 调用 ✓ → 结算出答案 ✓（"已完成 slow-a 的 glob 检查…验收回合 2。" ✓）→ 草稿清空 ✓、无报错 ✓、active runs `[]` ✓。另：既有门禁 `verify-composer-ime-submit.mjs` 仍 `ok:true` ✓（普通 Enter 在已配置根上**恰好发送一次** ✓）。

**结论**：表内 **#1 的两条验收证据（拒绝 + 可用路径）均已具备** ✓ —— 这是本次审计里**第一条达到完成标准**的项 ✓。剩余待办只有一处**回归修复**（见下 ✓）。

### #1 引入的真实回归（独立取证包发现，未擅自动手 ✓）

`node scripts/verify-desktop-cold-start-interaction.mjs` 现在 **FAIL** ✗，失败检查为"the readiness surfaces clear once execution is available"（脚本 :276 ✓）。机制：该场景用**无 config.json 的全新根** ✓，就绪后新的模型提示仍在屏上 ✓，而它渲染为 `<span className="composer-readiness-hint composer-send-block">` ✗ → 门禁探针 `document.querySelector('.composer-readiness-hint')` 命中它 ✓ 读到的不是 null ✗ → 同一个类名**在 DOM 里有两个含义** ✗。

**我的裁定：(a) 组件侧修** ✓ —— 给发送阻断提示**自己的类名** ✓ 并把它加进 `styles/06-composer.css` 里 `.composer-readiness-hint` 的样式规则 ✓，同步更新 runtime-readiness README 对该类的说明 ✓；**不采用** (b) 门禁侧绕过 ✗（那会把歧义留在 DOM 里 ✓，让下一个消费者继续猜 ✗）。门禁要求的判定：`verify-composer-send-model-gate` 与 `verify-desktop-cold-start-interaction` **两条都要 exit 0** ✓。

**待办**：实施 (a) 并复跑两条门禁 ✓ —— 原取证包在回复前被回收 ✗，作者包亦不可寻址 ✗，故此项留待下一手（改动前先看 `composer/**` 与 `06-composer.css` 的 mtime 是否静默 ✓）。

### 独立证人的完整报告（2026-09-28 01:0x）与剩余唯一回归

**修复本体（`547b4ec0`，作者为并发包 ✓）**：`send-readiness.ts:33-50` 的 `describeComposerSendReadiness({availability, executionReason})` → `blocked` ✓，原因复用**已有**文案（`executionReason ?? availability.detail` ✓，即 配置模型 / 检查供应商配置 / 重试读取 ✓，无新文案 ✓）；`composer-view.tsx:300-302` 禁用 + `aria-label` 带原因 ✓；`:221-228` **Enter 同样拒绝** ✓（堵住第二条进入死 run 的入口 ✓）；`:252-255` 控件行可见原因 ✓；`:99` 可用性只取一次 ✓ 并与 picker 共享 ✓；`send-block-notice.tsx:12-27` 行内句子 ✓；`chat-view.tsx:60-62` 首屏空态同一事实 ✓。

**实证（独立门禁 `verify-composer-send-model-gate.mjs`，`ok:true / failures:0` ✓，产物在仓库外 ✓）**：
- **前提从 Runtime 取得而非从 DOM 推断** ✓：`/runtime` → `model: "openai/gpt-5.6"`、三个供应商 `hasKey:false` ✓；`/runtime/readiness` → `ready` ✓ → **拒绝是因为模型事实，不是就绪门禁** ✓（这是关键区分 ✓）；
- 拒绝带可见原因 ✓（截图 `unconfigured-refusal.png` ✓ 显示真实窗口里控件旁的句子与变暗的发送键 ✓）；**两种入口都被拒** ✓（指针点击 + 真实 CDP Enter 带草稿 ✓）→ `POST /run/stream = 0` ✓、`active-runs = []` ✓、无消息/无回合/无停止键 ✓、**草稿保留** ✓；
- **可用路径不变** ✓：配好 acceptance provider 后发送可用 ✓ → `POST /run/stream` ×1 ✓ → **2 次** Provider 调用 ✓ → 结算出答案 ✓、草稿清空 ✓、无报错 ✓；既有门禁 `verify-composer-ime-submit` 仍 `ok:true` ✓（普通 Enter 恰好发送一次 ✓）。

**剩余唯一回归（已定位到行 ✓）**：`verify-desktop-cold-start-interaction.mjs` 在 `:276` 读取 `.composer-readiness-hint` 并期望 `null` ✓，但新提示渲染为 `class="composer-readiness-hint composer-send-block"` ✗ → 在该场景（全新根、无 `config.json`）里命中了模型句子 ✗ → 类名在 DOM 里**有两个含义** ✗。
**裁定 (a) 组件侧修** ✓：给提示**自己的类名** ✓，并把它加入 `packages/app/src/renderer/styles/11-runtime-readiness.css:10` 里 `.composer-readiness-hint` 的样式规则（**注意**：不是 `06-composer.css` ✓ —— 独立证人纠正了我先前给的路径 ✓），同步更新 runtime-readiness README ✓；**不采用**门禁侧绕过 ✗。判定：`verify-composer-send-model-gate` 与 `verify-desktop-cold-start-interaction` **两条都 exit 0** ✓。

**证人明确未验的一项** ✓：composer 的"loading 也算 blocked"是否会与"窗口刚出现就按 Enter"的门禁抢时序 ✓（它实测 `/runtime` 取一次约 2 s 后发送才可用 ✓）；它没有复跑全部真实窗口门禁 ✗，因为构建一直被并发编辑作废 ✓（`App build inputs changed while the build was running` ✓，3 次失败 ✓）→ 它的实证范围就是上面那条门禁 + `verify-composer-ime-submit` ✓，**如实标注** ✓。

## 审计 B/C 结果（阅读/流式 + 输入/交互回路，2026-09-28 01:1x）

方法 ✓：7 次真实窗口运行（CDP + 确定性 provider ✓，脚本在 %TEMP% ✓，**未改动仓库任何文件** ✓）。**关键方法学发现** ✗：`park-offscreen` 的窗口**实测 0 个 scroll 事件** ✓ → 在那里测"用户上翻"毫无意义 ✓；首轮那个"应用把你拽回底部"的观感其实是该 artifact ✓，**不是缺陷** ✗（已作废 ✓）。最终 4 轮均在**可见窗口**上完成 ✓。

### 新增发现（按感知程度，插在本表 P1 区）

| # | 级别 | 症状（用户可见） | 证据 | 偏离的既有约定 / 自家契约 | 最小修法 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **4** | **P1** | **未发送的草稿（含附件芯片）会跟着你进入下一个对话** ✗：在全新对话里输入草稿 ✓ → 点侧栏另一个对话 ✓ → 转录切过去了（`.active` 在该行 ✓）但**输入框仍持有那段草稿且发送可用** ✗ → 按发送（或 Enter，因为焦点本来就在输入框）会把 A 对话的内容发到 B 对话 ✗ | `窗口`（两个构建 0:30 / 1:11 均复现 ✓）＋`源码`：`input`（`app-shell/use-app-controller.ts:80`、`setInput:238` ✓）与 `attachments`（`:85` ✓）是**全局单一状态** ✓；`switchSession`（`sidebar/session-actions.ts:179-198` ✓）与 `newSession`（`:131-151` ✓）都不碰它们 ✓；只在发送时清（`chat/run-actions.ts:132-133` ✓） | ChatGPT / Claude / Cursor / VS Code 的输入框**按会话归属** ✓。**更关键：LS 自己的持久化模型已经这么定义** ✓ —— `persistent-state.ts:83-88 restoreComposerDraft` 会比较 `composerSessionId` ✓，只是在运行时**从未被强制执行** ✗ | 在 controller 里按 `currentSession ?? 'draft'` 保存/恢复草稿与附件列表 ✓，并在 `switchSession` / `newSession` 中恢复 ✓；**保留** `persistent-state.ts` 现有的单条保存（整表持久化 out of scope ✗） | 已派修 |
| **5** | **P1** | **失败的回合没有重试入口** ✗：401 场景下回合显示失败 ✓、注意力行写"本轮未完成" ✓，但整个回合的按钮只有 `[过程触发器, 系统提示词, 自动换行, 复制代码, 复制消息]` ✗ —— **没有重试** ✓；草稿也没被放回输入框 ✓（`composerValue:""` ✓，因为只有渲染器侧抛异常才恢复 ✓ `chat/run-actions.ts:244` ✓），用户只能自己重打或复制自己的气泡再粘回去 ✗ | `窗口`（401 fixture ✓）＋`源码` | 四家产品都在失败回复上给 **Retry** ✓。**更关键：LS 自己的契约也要求有动作** ✓ —— `ui/state-view.ts:17-18,41` 规定 failure → `allowsAction:true` ✓、`ui/README.md:105` 写"原因 + 重试动作" ✓；而承载"本轮未完成"的注意力行是 `role="status"`（`chat/attention-row.tsx:22` ✓）**没有任何动作** ✗ —— 与之对照，就绪条、检查点恢复、审阅、HTML 预览、技能等**其他失败面都有重试** ✓ | 为 `activity.status === 'failed'` 渲染"重试"动作 ✓，用**已有**的发送路径重新派发 `activity.instruction`（字段已存在 ✓ `chat/run-actions.ts:147` ✓）；**从失败点续跑属 harness 职责 → out of scope** ✗ | 待派修 |
| **6** | **P2** | 你自己的消息**不能编辑重发** ✗（只有复制与分叉 ✓）—— 一个错字要么整段重打 ✗ 要么分叉整个对话（且不预填 ✗） | `窗口`＋`源码`：`chat/message-meta.tsx:42-66` ✓、`chat-view.tsx:140-165` ✓ | 四家都提供 **Edit** ✓ | 在用户气泡上给"编辑"动作 ✓，把文本放回输入框（VS Code Chat 语义 ✓，**不截断转录** ✓）；截断重发语义 out of scope ✗（需产品决定 ✓） | 待派修 |
| **7** | **P2** | 消息时间**只有时分、没有日期** ✗（`timestamp:"01:12"` / `dateTime:"2026-09-27T17:12:55Z"` / `title:null` ✓）→ 隔几天回来，每条都只说几点几分 ✗ | `窗口`＋`源码`：`chat/message-meta.tsx:70-75` 只格式化 HH:MM ✓，转录里也没有日期分隔 ✓ | ChatGPT 插日期分隔/相对日期 ✓；Linear 给旧条目日期 ✓ | 非今天的消息带上日期 ✓（或 `title` 给完整时间戳 ✓） | 待派修 |
| **8** | **P2** | **复制按钮在剪贴板被拒时静默失败** ✗：未聚焦窗口里两个按钮都停在 `data-copied="false"` ✓ 且无任何反馈 ✗；聚焦后同一按钮就正常翻转 ✓ 剪贴板内容也对 ✓ | `窗口`＋`源码`：`chat/message-meta.tsx:27-32` 捕获后**一声不响地返回** ✗；`Markdown.tsx:370-375` **根本不捕获** ✗（未处理拒绝 ✓） | 剪贴板动作要么确认要么说明失败 ✓ | 两个按钮各加一个失败态 ✓ | 待派修（频率低，排最后 ✓） |

### 已核对为**正确**（列为"不要重复审计" ✓）

流式渐进增长 ✓、结算后两处哨兵都在（1016 字符 ✓ `streaming→settled` ✓ `aria-live="polite"` ✓）；**可见窗口下上翻不会被拽回底部** ✓（`scrollTop` 保持 0 ✓，max 从 423 增到 722 ✓，一次写入来自用户 ✓ 应用零写入 ✓），"有新内容，回到最新"入口出现并可回到底部 ✓；代码块有语言标签 + 换行开关（验证 off→on ✓、`overflow-x` auto→hidden ✓）+ 复制 ✓；推理行运行中展开、结束收起、**用户点击优先** ✓；工具行默认折叠且保持 `inert`+`aria-hidden` ✓；失败/验证事实挂在过程触发器上 ✓、注意力行在折叠面板之外 ✓；焦点：启动/新会话取焦点且有守卫 ✓、Esc 按层仲裁 ✓、弹层关闭后焦点回到触发元素 ✓；**输入法：组合期间 Enter 不发送、`compositionend`+Enter 才发送** ✓；运行中发送标注"补充当前任务" ✓；输入框长到 220px/30% 后滚动 ✓；分页每次 120 条 ✓；实时工具输出上游封顶 400 字符 ✓（`tool-execution-service.ts:524` ✓）→ 长会话不会无限堆行 ✓。

### 未能核对（如实列出 + 原因）

GFM 表格（无 fixture 渲染 ✓，只有源码事实 ✓）；跨会话切换的附件芯片（仅源码 ✓ —— 选择器是原生对话框 ✓ 合成粘贴不带路径 ✓）；**低于 800px 的窗口**（应用 `minWidth:800` ✓ `desktop-shell.ts:268` ✓，560/420 的请求被夹到 ~815 CSS px ✓ → 平板宽度布局**按设计不可达** ✓）；200 轮长会话（未构造 ✓，无虚拟化 ✓，但单轮 DOM 约 308 节点有界 ✓）；多产物回答（fixture 未产出 ✓）。滚动与剪贴板证据来自**可见窗口** ✓，最终确认基于 1:11 构建 ✓。

### 两处披露（重要）

1. 它曾执行 `taskkill /IM electron.exe /F` 清一个卡住的探针 ✗ → **杀掉了机器上所有 Electron 进程** ✗（另一个 agent 的窗口运行若在 0:40 前后死亡 ✓ 就是它 ✓）；
2. **测试完整性隐患** ✓（不是 UX 缺陷 ✓）：`.sidebar-section-action.sidebar-new-action` 被"新对话"与"新项目"**两个按钮共用** ✗（`conversation-section-view.tsx:91` ✓、`project-section.tsx:217` ✓）→ 随便 `querySelector` 会打开"新项目"对话框 ✗ → 后续写门禁的人必须按文本或位置区分 ✓。

**它建议的修复顺序** ✓：①每会话草稿+附件 ✓ ②失败回合重试 ✓ ③自己的消息可编辑重发 ✓ —— 与我的排序一致 ✓。
