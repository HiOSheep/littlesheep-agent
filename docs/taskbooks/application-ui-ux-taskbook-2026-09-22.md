# 应用层 UI / UX 优化与统一任务书 2026-09-22

最后更新：2026-09-26 11:10:01

## 1. 本文件当前只记录未完成部分

本任务书 2026-09-22 建立时共 31 项。2026-09-26 复核后：**23 项整项退役**（UX-01～UX-15、UX-18、UX-21、UX-23、UX-24、UX-26、UX-29），**10 项未完成条目里的剩余部分**转成下方 UX-32～UX-39 共 8 条待办；已完成项的实现范围、逐次实测数字、被证伪的假设与更正过的错误结论都在 git 历史里（`git log --follow -- docs/taskbooks/application-ui-ux-taskbook-2026-09-22.md`），本文件不再复述，也不再保留它们的复选框。

退役依据是各任务自己的实施记录与门禁脚本，不是本轮的新验收。以下事实在退役时被逐项重查过，其中若干条与退役前的旧记录不一致，此后以本节的表述为准（旧记录的错误一并说明，避免下一个人重新踩）：

- **UX-29 旧记录写"本机没有安装 Git Bash"，这是错的。** 本机 `D:\Git\bin\bash.exe` 确实存在且是真 Git Bash（5.2.37 msys），只是 `gitBashCandidates` 只查 4 个 Program Files 类根和 `PATH\<entry>\bash.exe`，而 `PATH` 里只有 `D:\Git\cmd`（没有 `bash.exe`）、`D:\Git\bin` 不在 PATH，于是探测把已安装的 Git Bash 报成"未找到"，配置提示还建议去安装。这是**探测假阴性缺陷**，已登记为 UX-32。
- **UX-29 旧记录与两处 README 写"未知或不可用的 shellId 一律拒绝"，实现不是这样。** `packages/app/src/main/local-app-api/terminal-routes.ts:66-74` 对未知/不可用 id 静默改用默认 Shell，且这条替换路径在界面上没有提示。已登记为 UX-32。
- **UX-28 旧记录写差异层上限"每层 8 MB"，措辞不准。** `MAX_GIT_DIFF_TOTAL_BYTES` 是**整个文件跨层共享**（`packages/app/src/main/local-app-api/workspace-git-review.ts:372` 按层数均分），staged + unstaged 并存时每层实际只有 4 MB。这是记录口径问题，不是实现缺陷，不改代码。
- **UX-27 门自己的 limits 与实现矛盾。** `scripts/verify-review-refresh-errors.mjs:1506` 仍写"本门不做 HEAD/index 一致性校验"，而第 2 条实现（`workspace-git-review-consistency.ts`）已在 `072db6dc` 落地，该行由更早的 `68e698b5` 引入、之后没同步。同时全文 **0 处** `unstable` 断言。已登记为 UX-35。
- **UX-18 旧记录写"审阅侧栏定位缺陷：Diff 标题按钮与审阅导航落在同一矩形、指针点不到"。** 这是**门自己注入模板字符串时的转义 bug**造成的假象（`\s` 在模板字面量里退化成 `s`，把文本里所有字母 s 抹掉），同批共修掉两处门缺陷；视图本身没有省略标签。修后按文件名逐一比对通过。
- **UX-25 旧记录写"第 3 条完成并勾选"，与门里的实际断言不符。** 静态预览的磁盘/草稿走查确实驱动了界面，但算出的 12 个观察值（`savedToDisk`、`previewAfterSave`、`conflictStatus`、`deletedNotice` 等，`scripts/verify-html-preview-baseline.mjs:2052-2118`）**既不断言也不进门输出**，"保存成功后刷新 / 保存失败保留草稿 / 外部更改与删除提示"三类因此在证据上仍开着。已登记为 UX-34。
- **UX-25 的字体一项只有引用层证据。** 门自述隐藏窗口下 Chromium 不会真的发起字体请求（`document.fonts` 恒为 `unloaded`），所以只证明了 `@font-face` 源码已指向回环服务，没有"字体文件真的被取回"的测量。随 UX-34 一起收口。
- **UX-16 旧记录写"第 3 条只有单元测试"，低估了已有证据。** `scripts/verify-transport-retry-feedback.mjs:372-375` 已在真实窗口断言紧凑模式下的**失败**一类（含 `.agent-transcript-attention`）。缺的是另外几类（权限拒绝、未验证、部分完成、待用户）与"部分完成"到底指哪个真实 UI 状态。
- **UX-27 第 3 条旧记录写"取消需要一个用户可见入口或作用域切换"，属产品判断，不是缺夹具。** 工作区根切换、被取代请求的中止都已接线；缺的是决定与第二根夹具。

各条退役时通过的门（都是真实 Electron 窗口或真实进程，除标注外 `failures: []`）：

| 任务 | 验收门 |
| --- | --- |
| UX-01 | `pnpm run verify:composer-ime-submit` |
| UX-02/03 | `pnpm run verify:deletion-confirmation`、`pnpm run verify:composer-stop-append` |
| UX-04 | `pnpm run verify:skills-catalog-states` |
| UX-05 | `pnpm run verify:recovery-states` |
| UX-06/07 | `pnpm run verify:provider-editor-draft`、`pnpm run verify:keyboard-modal-focus` |
| UX-08/10 | `pnpm run verify:channel-entry-states` |
| UX-09 | `pnpm run verify:async-feedback` |
| UX-11 | `pnpm run verify:no-model-config-loop` |
| UX-12/13 | `pnpm run verify:settings-navigation-terminology` |
| UX-14 | `pnpm run verify:shared-ui-roles` |
| UX-15 | `pnpm run verify:narrow-high-dpi-forms` |
| UX-18 | `pnpm run verify:review-navigator-width` |
| UX-21 | `pnpm run verify:retry-feedback`、`pnpm run verify:local-stream-disconnect` |
| UX-23 | `pnpm run verify:code-wrap-control` |
| UX-24～UX-28 | `pnpm run verify:html-preview-baseline`、`pnpm run verify:review-refresh-errors`、`pnpm run verify:conversation-workspace-scenarios`、`pnpm run verify:electron-ui-state-continuity`，以及 `packages/app/src/main/local-app-api/` 下的真实仓库集成测试（UX-24、UX-26 整项退役；UX-25/27/28 已完成的部分退役，剩余部分见 UX-34 与 UX-35） |

## 2. 仍未完成的清单

| ID | 优先级 | 任务 | 来源 | 规模 |
| --- | --- | --- | --- | --- |
| UX-32 | P1 | 修 Git Bash 探测假阴性与 unknown shellId 语义 | UX-29 第 3 条 + 本轮复核 | S |
| UX-33 | P1 | 钉住紧凑模式五类状态在真实窗口的可见性 | UX-16 第 3 条 | M |
| UX-34 | P1 | 把静态预览的磁盘/草稿走查升为断言，并闭合字体一项 | UX-25 第 3 条 | S |
| UX-35 | P1 | 审阅一致性：当前文件事实、门的过期结论与 unstable 断言 | UX-27 第 2 条 | M |
| UX-36 | P1 | 补齐 320 条上限的可达性语义与逐键基准 | UX-17 第 2、4 条 + 本轮复核 | M |
| UX-37 | P1 | 终端的会话上限、标签生命周期与降级可见性 | UX-30 全 5 条 | M |
| UX-38 | P2 | 对话区定位与可读性的剩余验收面 | UX-19、UX-20、UX-22 | L |
| UX-39 | P1 | 端到端交付门：小游戏 → 运行 → 审查，及打包版 | UX-31 全 5 条 | L |

统一完成标准、证据分级与实机要求沿用本任务书原第 5 节，未改动：每项必须填写实际实现范围、验证方式、通过结果与**未覆盖项**，完成前保持未勾选；未覆盖项要如实登记，**不允许**用"环境依赖"把条目勾上；颜色/间距调整不添加只复述实现的测试；交互验收一律使用隔离测试数据根，不操作真实归档、真实项目目录或真实密钥。

## 3. 可执行任务

### UX-32｜Git Bash 探测假阴性与 unknown shellId 语义

**两处都已核实（源码 + 本机只读探测），不是待定位问题。**

**问题 ①：探测漏掉非默认安装根。** `gitBashCandidates`（[workspace-shell-discovery.ts:116-134](../../packages/app/src/main/workspace-shell-discovery.ts)）只在 `ProgramFiles` / `ProgramW6432` / `ProgramFiles(x86)` / `LOCALAPPDATA\Programs` 下找 `Git\bin\bash.exe`，再加 `PATH\<entry>\bash.exe`。本机 Git 装在 `D:\Git`：PATH 里只有 `D:\Git\cmd`（该目录没有 `bash.exe`），`D:\Git\bin` 不在 PATH，于是已安装的 Git Bash 被报成"未找到"，`configHint` 还建议去装 Git。对照：`C:\Windows\System32\bash.exe`（WSL 启动器）被 `isGitBashPath` 正确拒绝。

**问题 ②：unknown / 不可用的 shellId 不是拒绝，而是静默换默认。** [terminal-routes.ts:66-74](../../packages/app/src/main/local-app-api/terminal-routes.ts) 回退到 `defaultWorkspaceShellProfile`，渲染侧只在**挂载时**对"保存的偏好失效"给提示（[terminal-shell-choice.ts:35-54](../../packages/app/src/renderer/workspace/terminal-shell-choice.ts)），运行中被换掉没有提示；而旧任务书记录与 [main/README.md:86](../../packages/app/src/main/README.md)、[local-app-api/README.md:105](../../packages/app/src/main/local-app-api/README.md) 都写"一律拒绝"——三处措辞与实现不一致。

- [ ] 修 `gitBashCandidates`：从 PATH 上的 `git.exe` 反推安装根（`<root>\bin\bash.exe`、`<root>\usr\bin\bash.exe`），必要时补 `GIT_INSTALL_ROOT` 与注册表；解析结果仍必须过 `isGitBashPath`。补一条"非默认安装根（如 `D:\Git`）也要找到"的单测。
- [ ] 把 [workspace-shell-discovery.test.ts:137-154](../../packages/app/src/main/workspace-shell-discovery.test.ts) 的"本机真实探测"从"只查不变量（可用项有 executable、不可用项有 reason）"升级为对本机可判定事实的断言——否则假阴性永远绿灯。
- [ ] 加 Git Bash 实机验收（对齐已有的 WSL 那份 [workspace-terminal-wsl-acceptance.test.ts](../../packages/app/src/main/local-app-api/workspace-terminal-wsl-acceptance.test.ts)）：`BASH_VERSION`、`--login -i` 下的 cwd 等于工作区、`LANG`/`TERM`、中文输出、多行粘贴、含空格与中文的路径。
- [ ] 决定 unknown / 不可用 shellId 的语义并实现：**要么**真的拒绝（400 + 渲染侧可见提示），**要么**把"已改用默认 Shell"作为可见 notice 返回并在终端头部显示；同步修上面三处 README/记录措辞，并补相应单测。
- [ ] 未覆盖项如实登记：Bash 侧"提示符按 Shell 分支"目前既无实现也无证据；[workspace-terminal-wsl-acceptance.test.ts:4-6](../../packages/app/src/main/local-app-api/workspace-terminal-wsl-acceptance.test.ts) 的头部注释仍写"本机起不来 WSL"（与 19:30 的更正相反，测试逻辑已按状态判定，仅注释过期）；[workspace-shell-discovery.ts:358](../../packages/app/src/main/workspace-shell-discovery.ts) 的"PowerShell 7 优先"注释与数组实际顺序不符（行为本身正确）。

**验收**：在本机（Git Bash 在 `D:\Git`）下拉里出现真实的 Git Bash 项；启动它后 `BASH_VERSION`、`pwd`、`LANG`/`TERM`、中文与粘贴均正确；未知 id 的行为在界面与 README 上一致且可解释。

### UX-33｜紧凑模式五类状态的真实窗口可见性

**问题**：任务书原 UX-16 第 3 条要求"普通/紧凑显示均保留失败、权限拒绝、未验证、部分完成和待用户事项"。实现侧已具备——`transcriptEntryNeedsAttention` / `compactTranscriptEntries` / `activityAttentionLine`（[activity-visibility.ts](../../packages/app/src/renderer/chat/activity-visibility.ts)）配合 [assistant-turn.tsx](../../packages/app/src/renderer/chat/assistant-turn.tsx) 的紧凑渲染——但真实窗口只断言过**失败**一类（[verify-transport-retry-feedback.mjs:372-375](../../scripts/verify-transport-retry-feedback.mjs)），其余四类只有纯函数单测；`scripts/verify-conversation-workspace-scenarios.mjs:1439` 自己声明不测这一段。

- [ ] 在真实窗口构造五类状态 × 普通/紧凑各一次，断言未完成/失败行与 `.agent-transcript-attention` 的文案，并各留一张截图。
- [ ] **先明确"部分完成"指哪一个真实 UI 状态**：`ActivityStatus` 里没有 partial 分支，现有 `partial` 只用于 usage 完整性（"用量统计不完整"）。若确定没有对应的活动状态，就把这一句改写成真实存在的状态（例如"步骤未全部完成"），不要为清单虚构一个状态。
- [ ] "待用户"必须用真实可产生的形态：Runtime 已不再写 `waiting_user`（见 [verify-recovery-states.mjs:23-28](../../scripts/verify-recovery-states.mjs) 的记录），需要先确定当前会用哪条路径表达"等用户决定"。
- [ ] 顺带把跨重启的**会话级**现场（未保存草稿、浏览器标签、展开的目录）纳入 [verify-electron-ui-state-continuity.mjs](../../scripts/verify-electron-ui-state-continuity.mjs)：该门目前只断言导航宽度与布局，不覆盖会话级现场。
- [ ] 更新过时数字：`verify:conversation-workspace-scenarios` 在加入终端断言后已有 48 处断言点，旧记录的"40 项断言"不再准确。

**验收**：五类状态在两种显示模式下都能在窗口里读到，且每一类都有截图与断言；无法构造的那一类要写明原因，不用单测替代。

### UX-34｜静态预览的磁盘/草稿断言与字体证据

**问题**：静态 HTML 预览的"磁盘版本 vs 未保存草稿"走查（[verify-html-preview-baseline.mjs:2052-2118](../../scripts/verify-html-preview-baseline.mjs)）算出了 12 个观察值，但**没有任何 `recorder.check` / `recorder.note` 引用它们**——保存成功后刷新、保存失败（409）保留草稿、外部改写与删除提示的出现与消失，这三类只驱动了界面，既不判定也不进门的输出。实现本身在（[preview-disk-state.ts](../../packages/app/src/renderer/workspace/preview-disk-state.ts)、[use-workspace-disk-watch.ts](../../packages/app/src/renderer/workspace/use-workspace-disk-watch.ts)、[preview-disk-notice.tsx](../../packages/app/src/renderer/workspace/preview-disk-notice.tsx)），缺的是证据。

- [ ] 把 `:2052-2118` 已有的 `savedToDisk` / `saveStatus` / `draftAfterSave` / `previewAfterSave` / `reloadedMarkup` / `clearedAfterReload` / `conflictStatus` / `draftAfterConflict` / `deletedNotice` / `noticeAfterRestore` 接成断言（至少四条 `check`）：保存成功后预览换成已保存版本且草稿转 clean；409 后草稿仍 dirty 且状态栏显示服务端原文；"重新加载磁盘版本"后帧内容变成磁盘那版且提示消失；删除时是失败色提示、文件恢复后不再说"已删除"。
- [ ] 字体一项按已有边界收口：门里写明"隐藏窗口下 Chromium 不发起字体请求（`document.fonts` 恒 `unloaded`）"，因此只断言 `@font-face` 源被改写到回环服务；若要有"字体真的被取回"的测量，需要上屏（`park-offscreen` 能力已存在，见 [desktop-acceptance-actions.ts](../../packages/app/src/main/desktop-acceptance-actions.ts)），否则把这一句如实降级为未覆盖。
- [ ] 不重做已有覆盖：`快速切换 A/B/C 各显示自己的文件`（`:2150-2154`）、`草稿进会话存储且预览渲染草稿`（`:1086-1095`）、失败资源的计数/原因/重试（`:1520-1531`）都已断言。

**验收**：上述四类各自有断言且门 `failures: []`；字体一句要么有上屏测量，要么在门的 limits 里明确写成未覆盖。

### UX-35｜审阅一致性：当前文件事实、门口径与 unstable 断言

**问题 ①（实现缺口）**：`readConsistentReview`（[workspace-git-review-consistency.ts](../../packages/app/src/main/local-app-api/workspace-git-review-consistency.ts)）的指纹是 `HEAD` + `.git/index` 的 mtime/size + **同参数**的 `status --porcelain -z`。三个事实都是集合级的：已修改文件的 porcelain 恒为 ` M path`，**内容再改一次不改变该输出**，HEAD 不变，`.git/index` 也不会被写回（`GIT_OPTIONAL_LOCKS=0`，[workspace-git-command.ts:37](../../packages/app/src/main/local-app-api/workspace-git-command.ts)）。因此"读取期间保存一个本来就已经脏的文件"这一类变化检测不到——正是任务书点名的"**当前文件**等必要事实"。竞态测试注入的是"新落地的未跟踪文件"（[workspace-git-review-race.test.ts:70](../../packages/app/src/main/local-app-api/workspace-git-review-race.test.ts)），属于会改变 status 输出的那一类。

**问题 ②（证据与口径矛盾）**：[verify-review-refresh-errors.mjs:1506](../../scripts/verify-review-refresh-errors.mjs) 仍写"本门不做 HEAD/index 一致性校验"，与已落地的实现相反；全文 0 处 `unstable` 断言，而 `unstable: true` 与"仓库在读取期间仍在变化"的 warning 已经实现（[review-refresh-notice.ts:90-95](../../packages/app/src/renderer/workspace/review-refresh-notice.ts)）。

- [ ] 二选一并写清：**(a)** 把选中/改动文件的内容级事实（mtime+size 或内容 hash）纳入指纹，覆盖"读期间保存同一文件"；**(b)** 接受"HEAD + index + status"为设计边界，在 `workspace-git-review-consistency.ts` 的注释、对应 README 与本任务书里显式记为已知边界。不要留一句模糊的"已建立一致性校验"。
- [ ] 修正 [verify-review-refresh-errors.mjs:1506](../../scripts/verify-review-refresh-errors.mjs) 的过期结论，并在已有的 churn 步骤补一条 `unstable` 通知断言（夹具已存在，成本很低）。
- [ ] 补一条"连续 409 / 持续变化时有界终止并提示"的断言：主进程侧 409 有单测（[workspace-git-review-cache.test.ts:40-56](../../packages/app/src/main/local-app-api/workspace-git-review-cache.test.ts)），渲染器 409 分支（[review.tsx:249-252](../../packages/app/src/renderer/workspace/review.tsx)）无测试也无走查。

**验收**：指纹的覆盖范围有明确文字结论；门里能读到 `unstable` 的断言；409 分支在门上可达。

### UX-36｜320 条上限的可达性语义与逐键基准

**问题**：UX-17 的基准已完成，结论是"现在不做虚拟化"：Main 的 `listWorkspaceDirectory` 读整个目录、排序后只保留 `MAX_WORKSPACE_DIR_ENTRIES = 320` 条（[workspace-file-service.ts:14](../../packages/app/src/main/local-app-api/workspace-file-service.ts)），首行 ≤ 96 ms、滚动零长帧，10,000 条目录的成本被上限封顶。真正的瓶颈被改判为**上限的可达性**：

- 筛选是在**已被截断的列表**上做的（[workspace-tree-rows.tsx:25-58](../../packages/app/src/renderer/workspace/workspace-tree-rows.tsx) 直接 `includes` 已加载的 `entries`；筛选框只 setState，不发请求），所以排在前 320 之外的条目既不在树里也搜不到（实测 `zzz-beyond-cap.txt` 两个目录都未命中）。
- 没命中时的文案是"没有匹配的文件。"（[file-navigator.tsx:312](../../packages/app/src/renderer/workspace/file-navigator.tsx)），把"被上限挡住"说成"真的没有"。

- [ ] 做产品取舍并实施其一：**(a)** 筛选下推 Main（过滤后再切片，并能回答"命中项在上限之外"）；**(b)** 提高上限并同时引入窗口化——合成数据显示纯布局阈值约在 2,000 行。两者都要修 `:312` 的误导文案。
- [ ] 若动上限：门里的 320/321 常量与 [workspace-tree-rows.tsx:7](../../packages/app/src/renderer/workspace/workspace-tree-rows.tsx) 的提示同步更新，并重跑 [verify-workspace-large-directory.mjs](../../scripts/verify-workspace-large-directory.mjs)。
- [ ] 补两类缺的基准/走查：**筛选逐键延迟**（现只测单次输入后的稳定时间）与**320 行上的键盘导航**（无脚本；工作区树的行是 `button.workspace-tree-row`，行名是它的子节点）。
- [ ] 明确不做的事：不引入完整 Solid 运行时、第二套目录扫描或新的活动页；仓库里确实没有 `virtualiz` / `useVirtualizer` / `overscan` 的任何代码。

**验收**：被上限挡掉的条目在界面上有正确说法（或能被筛到）；上限变化时门与提示同步；逐键延迟与键盘走查有数字。

### UX-37｜终端的会话上限、标签生命周期与降级可见性

UX-30 的 5 条全部未勾选。已具备的部分：渲染侧会话模型（8 标签 / 64 KB 回放 / **只在 ready 时放行输入**，[terminal-sessions.ts](../../packages/app/src/renderer/workspace/terminal-sessions.ts)）、Main 侧多会话管理（16 会话 / 512 KB 回放 / 超限 429 / 退出后 30 秒移除，[terminal-session.ts](../../packages/app/src/main/local-app-api/terminal-session.ts)）、真实窗口证据（[verify-conversation-workspace-scenarios.mjs:446-609](../../scripts/verify-conversation-workspace-scenarios.mjs)：面板起来、下拉列出真实 Shell、单会话不显示标签条、"新建"多一个标签且原会话状态不变、标记文件 `a1`/`b1`/`a2` 证明输入路由）。以下是逐条核实后仍缺的部分：

- [ ] **会话上限的拒绝不可见且会泄漏**：`open()` 先在 Main 建会话再 dispatch（[use-terminal-sessions.ts:87-104](../../packages/app/src/renderer/workspace/use-terminal-sessions.ts)），reducer 在第 9 个时才拒绝且只写 `state.notice`（[terminal-sessions.ts:71-76](../../packages/app/src/renderer/workspace/terminal-sessions.ts)），而渲染侧从不读它（[terminal.tsx](../../packages/app/src/renderer/workspace/terminal.tsx) 只用 `tabs`/`activeId`）→ 多出一个没有标签、也关不掉的终端进程。修法：判定前移到创建之前，或创建后立刻关掉；拒绝要给可见提示。
- [ ] **关闭终端标签只清理活动会话**：`terminal.tsx` 的卸载清理只 `sessions.close(activeSessionRef.current)`，其余标签只是 abort 了流（[use-terminal-sessions.ts:72-75](../../packages/app/src/renderer/workspace/use-terminal-sessions.ts)），Main 里的进程继续跑，标签状态丢失。改成 `closeAll()`，并把"隐藏面板 = 保活 / 关闭终端 = 清理"写成文案；`closeAll` 目前只有单测。
- [ ] **切标签可能误输入**：`onActiveChange` 不重置输入队列（`terminal.tsx:83-93` 只重置 xterm），合并 8 ms 后才取当前会话 id（[terminal-input-controller.ts:52-90](../../packages/app/src/renderer/workspace/terminal-input-controller.ts)）→ 切换瞬间排队的字节会写进**新**标签。在 `onActiveChange` 里 reset，并补一条行为测试。
- [ ] **PTY / fallback 的能力差异不可见**：只有标题后缀 `· PTY` / `· fallback`（`terminal.tsx:479`），中断按钮仍写"发送 Ctrl+C"（[terminal-toolbar.tsx:34](../../packages/app/src/renderer/workspace/terminal-toolbar.tsx)），而 Windows fallback 实际是 `taskkill /T /F`（[terminal-process.ts:279-286](../../packages/app/src/main/local-app-api/terminal-process.ts)）——与"不能笼统承诺与 PTY Ctrl+C 等价"直接冲突。把差异做成可见状态并改掉措辞。
- [ ] **多 Shell 历史没有来源标注**：`TerminalActivityRecord` 没有 shell/source 字段（[workspace-contracts.ts:69](../../packages/app/src/shared/workspace-contracts.ts)、[terminal-activity-index.ts:13-17](../../packages/app/src/main/terminal-activity-index.ts)），列表只有命令 + 状态 + 时长；要么加字段并标注，要么明确记为不支持。
- [ ] **"重启后保留配置/元数据并标记已结束"完全没有实现**：标签只在内存 `useReducer` 里，`localStorage` 只存 Shell 偏好，重启后是零标签。决定做或不做，并写进 README 与任务书；不改行为就不要在界面上暗示。
- [ ] 清理与登记：`nextTerminalTabShell`（[terminal-sessions.ts:133-143](../../packages/app/src/renderer/workspace/terminal-sessions.ts)）没有任何生产调用点（死代码）；[workspace-terminal-sessions.test.ts:38-43](../../packages/app/src/main/local-app-api/workspace-terminal-sessions.test.ts) 的两个会话用的是**同一个** profile，与文件头"started with different shells"不符；未跟踪脚本 `scripts/verify-workspace-terminal.mjs` 尚未在 `package.json` 注册。
- [ ] 未覆盖项如实登记：退出应用清理链（`index.ts` → `local-app-api-server.ts` → `terminal-routes.ts`）只有代码没有窗口证据；ANSI 与中文**输入**、断线重连、退出/重启后无残留服务、无未捕获 ConPTY 异常均无证据。

**验收**：达到上限时界面有可见拒绝且 Main 无孤儿会话；关闭终端标签后该面板所有会话都被清理（含窗口级证据）；切标签不再能把输入送进另一个会话；fallback 的限制在界面上可读；重启行为有明确结论。

### UX-38｜对话区定位与可读性的剩余验收面

汇集 UX-19、UX-20、UX-22 三条里**尚未取证**的部分；三者的实现与已测数字见 git 历史，不要重做。

**需要你先定的一件事**：会话切回时应**恢复上次阅读位置**，还是继续**跳到最新消息**（当前行为是无条件贴底，[use-chat-scroll-controller.ts:191-202](../../packages/app/src/renderer/chat/use-chat-scroll-controller.ts)，且会话现场结构体里没有滚动位置字段）。若选恢复位置，需要持久化 `{messageKey, offset}` 并区分"草稿会话转正"与"历史前插"两种非切换情形；若选跳到最新，就把门里现在只记录不判定的那一步（`verify-chat-reading-scenarios.mjs` 的"切换会话与返回"）升为断言并写进 README。

- [ ] 顶部/中部/底部三种起始位置的系统走查（现在只有"最顶部"这一强场景，已经证明按 key 追踪的位移 ≤ 1 px）。
- [ ] 普通/紧凑模式、窄窗口与高 DPI 下 `.chat-jump-to-latest` 的可达性（`elementFromPoint` 命中自身、不与输入栏相交、浮在实测的 `--composer-overlay-height` 之上）。
- [ ] 录屏：任务书要求"修复前后记录 scrollTop、可见消息键及截图/视频"，`scripts/` 目录目前**没有任何录制能力**。要么新增，要么在验收口径里明确以逐帧 DOM 采样替代。
- [ ] **把流式样式稳定性从"证据"升级为断言**：`verify-chat-streaming-rendering.mjs` 已有逐帧样式记录器，但 `styleChanges` / `colorChanges` 只打印。改成"每类块在整个流式过程中只允许一个样式签名"即可回归"不变色"。
- [ ] 剪贴板：复制出来的文本要与持久化 settlement 一致（现在只有 `message-meta.tsx` 与 `Markdown.tsx` 的复制实现和源码字符串断言）。
- [ ] 普通/紧凑模式与重开会话下的流式一致性（同一夹具即可）。
- [ ] 对话区的键盘全流程（Tab 顺序、Escape 分层、焦点返回）——现有 `verify:keyboard-modal-focus` 只覆盖模态层（UX-07）。
- [ ] 把 `.web-sources`（来源/引用）纳入可读性取样（对比度、字号、溢出、可复制）；为长工具结果写断言（默认折叠、摘要长度上限、展开后的限高与滚动）。
- [ ] 125%/150%/200% 系统缩放的可读性复核（现在只有 DPR 2 与 800×660 最小窗口）。
- [ ] 如实记录一条**无法复现**的边界：用户报告的"流式文字变色"在固定输入下逐帧只有一个样式签名，未能复现；继续追需要复现输入（推理/工具混合输出、更长代码块的高亮 chunk 到达时机、主题/缩放切换瞬间）或用户录屏。不要据猜测改样式。

**验收**：上一段"需要你先定的一件事"有结论；样式稳定性、剪贴板一致性、来源可读性各有断言；录屏或替代口径写明；无法复现的那一条明确写成边界，并写清需要什么输入才能继续。

### UX-39｜端到端交付门：小游戏 → 运行 → 审查，及打包版

UX-31 的 5 条全部未执行。已有门覆盖了其中大部分**零件**，缺的是串联、开发服务路径、第二个工作区与打包版：

- 已有：小游戏真运行 + 真实输入计分、重开一局、改 `level.json` 后"重新加载"生效、多文件 ES module / 外部 CSS / 图片 / JSON、脚本错误与资源失败诊断、死循环与 guest 崩溃下主界面仍可用（[verify-html-preview-baseline.mjs](../../scripts/verify-html-preview-baseline.mjs)）；Git CLI / API / UI 三方对账；**从 Diff 返回源文件**（[verify-review-refresh-errors.mjs 的"从 Diff 返回源文件"步骤](../../scripts/verify-review-refresh-errors.mjs)）；终端面板与双会话现场（[verify-conversation-workspace-scenarios.mjs](../../scripts/verify-conversation-workspace-scenarios.mjs)）。

- [ ] 第 1 条：在**同一个**夹具上按顺序走完——改游戏自身的 **CSS / JS** → 重载看见修改（现在唯一改过的是 `level.json` 这份数据）→ 进 Git 审查看差异 → 从 Diff 返回源文件；保留"用户原例 vs 合成夹具"的证据区别（用户原例至今没有拿到）。
- [ ] 第 2 条：**先定产品范围**——是否提供"手动启动一个用户项目服务并打开 localhost URL"的入口。现状是 [development-environments.ts](../../packages/app/src/main/development-environments.ts) 只管 LS 自有运行时，唯一"起服务 + 开 URL"是 LS 自己的有界静态服务；地址栏还会把裸 `localhost:5173` 补成 **https**（[browser-history.ts:203-213](../../packages/app/src/renderer/workspace/browser-history.ts)），真 dev server 必须手打 scheme。定了范围再写门：启动 → 打开 → 改文件热更新 → 停服务显示可理解错误 → 重启成功；"不自动替用户执行项目脚本"要有实现才谈得上验证。
- [ ] 第 3 条：加**第二个工作区根**，做跨工作区/跨会话切换 + 退出重开，断言 HTML / 浏览器 / Git / 终端的归属不串（现有门都是单工作区；`verify-electron-ui-state-continuity` 里没有终端断言）。guest 读不到另一个工作区与 LS 配置这一层可复用 UX-26 的证据。
- [ ] 第 4 条：给核心路径加 `--app=packaged` 变体（现有 `--app=packaged` 只在[冷启动视觉门](../../scripts/verify-desktop-cold-start-visuals.mjs)里用过），记录构建指纹、实际 Shell 路径/版本、测试输入、截图、资源与控制台摘要；缺哪类 Shell 就列未覆盖，不用 mock 算作实机通过。安装包实机与干净机器首启目前明确未验证（见[冷启动基线](../reference/cold-start-baseline/README.md)）。
- [ ] 第 5 条：注册 `verify:workspace-terminal` 及新门命令（`scripts/verify-workspace-terminal.mjs` 目前未跟踪也未注册），并同步受影响 README（各 README 的时间戳在 2026-09-26 已更新过，只差命令登记）。

**验收**：第 1 条在一个门里按序走完并留下证据；第 2 条有明确的产品结论（做或不做）与对应验收；第 3、4 条有门与截图；dev/打包两条路径的未覆盖项单独列出。

## 4. 实施顺序与依赖

1. **先修探测与可见性缺陷**：UX-32（Git Bash 假阴性 + unknown shellId 语义）、UX-37 的前三项（上限泄漏、关闭标签清理、切标签误输入）——都是"用户会撞上但界面不会说"的一类。
2. **再把已有实现补成断言**：UX-34（静态预览的磁盘/草稿）、UX-35 的门与 409 一项、UX-38 的样式稳定性。这三项的共同点是**实现已经在、证据没接上**，成本低、收益是防止回流。
3. **需要产品判断的先定后做**：UX-36 的 (a)/(b) 取舍、UX-38 的"会话切回是否恢复阅读位置"、UX-39 第 2 条的开发服务范围、UX-37 的"重启后是否保留标签元数据"。这四项在定案前不要动代码。
4. **最后是组合验收**：UX-33 的五类状态矩阵、UX-38 的键盘/缩放/录屏、UX-39 的端到端与打包版。它们依赖前三步的实现稳定。

同一批次里若与其它任务书（如 [Harness 当前语义收口](harness-current-semantics-taskbook-2026-09-25.md)）的改动面重叠，沿用原任务编号与证据，不把同一条未完成事项登记到两处。

## 5. 验证门与命令

新增或扩展的门必须在 `package.json` 注册后写进这里，并同步所属领域的 README（含系统时钟的秒级时间戳）。

| 任务 | 门 |
| --- | --- |
| UX-32 | 扩展 `workspace-shell-discovery.test.ts`（含非默认安装根）+ 新增 Git Bash 实机验收，对齐 `workspace-terminal-wsl-acceptance.test.ts` |
| UX-33 | `pnpm run verify:transcript-state-visibility`（待建），或扩展 `pnpm run verify:transport-retry-feedback` / `pnpm run verify:conversation-workspace-scenarios` |
| UX-34 | `pnpm run verify:html-preview-baseline`（把已有观察值接成断言） |
| UX-35 | `pnpm run verify:review-refresh-errors`（改过期 limits + 补 `unstable` 与 409 断言）+ `workspace-git-review-consistency` / `workspace-git-review-race` 单测 |
| UX-36 | `pnpm run verify:workspace-large-directory`（上限变化后重跑）+ 新增筛选逐键与键盘导航走查 |
| UX-37 | `pnpm run verify:conversation-workspace-scenarios`（上限拒绝、关闭标签清理、切标签不误输入）+ 注册 `verify:workspace-terminal` |
| UX-38 | `pnpm run verify:chat-reading-scenarios` / `verify:chat-history-paging` / `verify:chat-streaming-rendering` / `verify:chat-output-readability` |
| UX-39 | `pnpm run verify:html-preview-baseline` + `verify:review-refresh-errors` 串联，及 `--app=packaged` 变体 |

## 6. 复核记录

本轮（2026-09-26）只做两件事：核对任务书与仓库的一致性、退役已完成部分。未改动产品代码、未新增或扩展门、未运行任何真实窗口验收。核对方式为只读源码审查（4 组并行核查，逐条给出文件与行号证据）、只读的本机 Shell 探测（`Test-Path` / `bash --version` / `wsl --list --quiet`）与 `git log`；门禁只跑了 `node scripts/check-repository-hygiene.mjs`。

- 退役项的文件、脚本、测试引用全部核对存在（链接与命令零失效）；已勾选项的实现文件、修复与测试都在位，没有发现"记录了但代码里不存在"或"修复被回退"的情况。
- `check:repo` 当时 **37 通过 / 1 失败**：`packages/app/src/renderer/workspace/terminal.tsx` 表内记 524 行、实测 530 行——工作树里有一处未提交的 UX-30 改动（把 `closeAll` 的触发点从卸载改为身份变化），行数随之增加。本轮只同步了[模块拆分地图](../reference/module-split-map.md)里的这一行计数与时间戳，未改动源码；同步后 `check:repo` **38/38** 通过。
- 工作树当时还有其它在途内容（`packages/app/src/renderer/workspace/terminal.tsx`、`docs/README.md`、`scripts/verify-conversation-workspace-scenarios.mjs` 的未提交改动，以及未跟踪的 `scripts/verify-workspace-terminal.mjs`、`scripts/lib/pnpm-shim.mjs`、`docs/taskbooks/harness-current-semantics-taskbook-2026-09-25.md`）。这些不属于本任务书，本文件不据此宣布任何结论。
