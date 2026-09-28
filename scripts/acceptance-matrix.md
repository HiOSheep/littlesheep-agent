# 验收脚本场景矩阵（SL-05）

最后更新：2026-09-28 20:47:00

本文件是整仓瘦身收口工作中 SL-05 的第一件交付物（任务书已退役，结果见[项目状态](../docs/decision/project-status.md)同名小节）：**先建立“场景—独有断言—证据层级—所属入口”表，再动手合并**。它记录的是改动前的取证（大脚本逐场景、其余脚本按共享形状聚类），以及改动后每条独有断言的去向。

口径：

- **证据层级**：`real Electron`（启动真实应用进程）、`real model`（真实 Provider 调用）、`fixture`（确定性本地夹具/桩，不启动应用）、`static`（只读文件或正则）。
- **所属入口**：根 `package.json` 里调用它的脚本名；`none` 表示没有任何入口或文档引用它（下面单独列）。
- 行数按 `ReadAllLines` 口径（文件末尾无换行的最后一行也计入）。
- 本表不重复各门自己的 `limits`；门的“证明不了什么”以该脚本输出中的 `limits` 为准。

## 0. `real Electron` 里还有一层：原生命中（2026-09-28）

`real Electron` 这一层的下方还有一层过滤器：**窗口自己的 `WM_NCHITTEST`**。渲染器把 `-webkit-app-region` 的盒子发布为窗口的 draggable region，Windows 在那里把落在拖拽区上的真实按下变成 caption 交互，页面根本收不到。2026-09-28 实测：在“真实点击无效”的构建上，`document.elementFromPoint` 与 CDP 合成点击**全部通过**，所以这两项都不构成“用户点得到”的证据。

这段判定现在是共享库 `scripts/lib/native-hit-test.mjs`：按窗口句柄给出每个点位的 `WM_NCHITTEST`，并分类为 `client`（`HTCLIENT`，送达页面）/ `caption`（`HTCAPTION`，窗口拖拽面）/ `caption-button`（原生标题栏按钮）/ `other`。原属 `verify-window-layout.mjs` 的内联探针已改为调用它，门的断言与行为不变。**约定**：任何涉及窗口 chrome、拖动区、窗口顶边或顶栏控件的改动，必须用 `assertClientHits` 断言受影响的控件是原生 `HTCLIENT`；`elementFromPoint` 与 CDP 点击只能作为补充证据。判别力由 `scripts/probe-native-hit-test.mjs` 每次启动真实窗口自检——同一断言在正常状态通过、在被注入拖动区后失败。用法、坐标换算与平台边界见 `scripts/README.md` 的同名约定一节。

这条判定还有一个**测量前提**：窗口必须是操作系统仍在合成的那一个。隐藏窗口、或已被整体移出所有显示器的窗口没有可观测的 draggable region，`WM_NCHITTEST` 会在整条 chrome 行上一律回答 `HTCLIENT`（2026-09-28 实测：停放窗口后标题栏中心是 `HTCLIENT`，移回屏内同一个点变回 `HTCAPTION`，渲染器的盒子全程没变）。所以**"`real Electron` + 停放窗口"**这一组合下的原生断言读数不可信——它可能因为与 chrome 契约无关的原因通过或失败；`verify-window-layout.mjs` 因此改为把窗口显示出来做原生那一半，并在退出前恢复可见状态。

## 1. 三个大型脚本

### 1.1 `scripts/verify-html-preview-baseline.mjs`（2,951 行，本轮未改动）

入口：`pnpm run verify:html-preview-baseline`（`ensure:app-build` 之后启动；`--app=packaged` 变体直接驱动 `release/win-unpacked/LittleSheep.exe`）。

| 场景 | 独有断言（别处没有的） | 证据层级 |
| --- | --- | --- |
| 静态页 / Canvas 小游戏 / 多文件夹具在三种入口下测量（装机 Chrome 或 Edge 回环 HTTP = 参照实现、LS 文件预览 `iframe sandbox="" srcdoc`、LS 浏览器标签 `webview` 来宾） | 三个入口各自的标题/文本、`styleSheets` 数量、`body`/`canvas` 计算色、canvas 非空像素、子资源请求清单、脚本数与首个控制台错误；栅格化后的 DOM 与计算样式断言 | real Electron + 真实 Chrome/Edge（回环服务由脚本自己起） |
| HTML 工具条“运行 / 停止” | Main 有界 loopback 服务返回的 URL 与浏览器标签一致；页面真的能玩（真实输入改变计分）；guest 无 LS bridge、无 Node 集成；穿越与错误 token 被拒；多文件资源 CSS/module/JSON/SVG 都 200；停止后 URL 立即拒连 | real Electron |
| 韧性与诊断 | 死循环夹具（先标记“已就绪”再 `while (true)`）与 `Page.crash` 之后主界面仍以毫秒级应答；`error-page.html` 夹具的“脚本报错 1 · 资源失败 2”工具栏读数与页面原文 | real Electron（故障注入） |
| 草稿与磁盘版本四类走向 | 保存后预览换成已保存文档且草稿转 clean、外部改写可“重新加载磁盘版本”、409 保留草稿并显示服务端原句、删除是失败色且文件回来后不再说“已删除” | real Electron |
| 同一份 Git 更改的四处比对 | 真实 Git 仓库在 CLI、Local App API 与审阅标签三处的同一份 Diff；真实终端会话记录 Shell 名称、后端、cwd、版本与编码 | real Electron + 真实 git CLI + 真实终端 |
| 地址栏与开发环境 | 裸回环地址被读成 `http`（guest 与标签 URL 都是 `http://`）；`GET /workspace/preview-server` 没有为这个地址起任何服务；`/development-environments` 只列 LS 自己的工具链 | real Electron |
| 字体边界 | 只断言 `@font-face` 源被改写到回环服务（隐藏窗口下 Chromium 不发起字体请求，`document.fonts` 恒 `unloaded`） | real Electron（记录，不是断言） |

### 1.2 `scripts/verify-electron-ui-state-continuity.mjs`（2,198 行 → 2,031 行）

入口：`pnpm run verify:electron-ui-state-continuity`。

| 场景 | 独有断言 | 证据层级 |
| --- | --- | --- |
| 可观测活动流（`verifyObservableActivityStream`） | 本地请求与真实模型反馈各自在窗口内可见、流式片段长度落在 `≥6 且 <30` 的窗口、结算文本与持久化 settlement 一致 | real Electron + 确定性 Provider（fixture 模型） |
| 精简有界执行（`verifyLeanBoundedExecution`） | 空转录起步、单循环里的工具调用与最终答复 | real Electron + fixture 模型 |
| 阅读位置（`verifyChatReadingPosition`） | 底部贴底读者在视口高度变化后仍 `gap ≤ 1`；**正在阅读的读者其消息在屏幕上不动**（宽度回流漂移只记录不判定）；`回到最新` 出现、可用、淡出；“保留 gap”被断言为缺陷 | real Electron |
| 文件导航宽度（`verifyFileNavigatorResize`） | 拖拽改变 `aria-valuenow`、越过阈值折叠、从轨道重开恢复**原宽度** | real Electron |
| 退出→重启恢复（第一轮 `quit` 握手） | 损坏的 `ui/desktop-window.json` 必须被真实退出时的原生窗口状态替换；重启后草稿（`draftRestored`）、会话/项目折叠、侧栏宽度、设置路由、文件标签与浏览器标签、终端 0 会话全部还原 | real Electron（真实进程退出与重启） |
| 第二个工作区根归属（`verifyWorkspaceRootOwnership`） | 非活动根 `GET /workspace/review` 返回 **403**、活动根 200；B 的文件树只列 B 的文件与嵌套目录；切根后终端 0 会话；B 内新建会话后再次重启仍回到 A 并保留各自草稿 | real Electron（真实进程重启 + 取消/归属边界） |
| 原生窗口几何（`assertWindowState`） | 退出时持久化的 bounds 与退出前 `window.outerWidth/Height` 在 12 px 容差内 | real Electron（当前实测 14 px，见 §4） |

### 1.3 `scripts/verify-workspace-performance.mjs`（2,181 行 → 2,106 行）

入口：`pnpm run verify:workspace-performance`（`assert:app-build` 之后启动，不做重建）。本轮改动只涉及**实现来源**（PNG 解码与 `numeric` 改为共享），场景与预算一条未动。

| 场景 | 独有断言 | 证据层级 |
| --- | --- | --- |
| 启动与首个可见帧 | 进程→locator ≤ 15 s、locator→窗口可见 ≤ 10 s、工作区首帧冷 ≤ 1.5 s | real Electron（真实耗时预算） |
| 文件树 / 审阅树 / Diff | 冷 ≤ 500 ms、暖 ≤ 100 ms、审阅树冷 ≤ 1.5 s、审阅 Diff 冷 ≤ 1.5 s；stale-while-revalidate 下旧树可见 ≤ 100 ms 且 `workspaceDirectoryCacheTtlMs` 之后重取 | real Electron（预算） |
| Monaco | 冷就绪 ≤ 4 s、暖 ≤ 250 ms、冷着色 ≤ 4.5 s、暖着色 ≤ 500 ms、暖墨迹 ≤ 500 ms；像素级“有墨迹”判定（真实截图 → 直方图 → 主色距离阈值） | real Electron（预算 + 像素断言） |
| 审阅编辑区契约 | 单列删除边距、行评论（新增按钮几何、发布、删除行内联评论点）、导航器运动帧稳定性、布局稳定性、双列/单列偏好持久化 | real Electron |
| 字体契约 | `evaluateFontContract` + `fontFamilyContainsSameStack`（同一字体栈不被改写） | real Electron |
| 隐藏进程成本 | 窗口隐藏 5 s 内 CPU ≤ 250 ms、IO ≤ 1 MiB（`LITTLESHEEP_IDLE_BASELINE=1` 时另跑诊断输出） | real Electron（预算） |

## 2. 其余脚本按共享形状聚类

| 聚类 | 成员（入口） | 真正重复的逻辑（改动前） |
| --- | --- | --- |
| A. 真实窗口验收，共用 `lib/electron-cdp-harness.mjs` | ~35 个 `verify-*.mjs`（每个都有自己的 `verify:*` 入口） | 无重复的进程启动/CDP：已共用 harness；各自仍重复实现 `captureScreenshot`（6 份）与 `reloadRenderer`（7 份），且这两类的失败策略/成功判据各不相同 |
| B. 真实窗口验收，但自带一份启动器/CDP 栈 | `verify-electron-ui-state-continuity`、`verify-workspace-performance`、`verify-model-provider-ui`、`verify-panel-collapse-release`、`debug-sidebar-corner`、`verify-electron-runtime-continuity`、`verify-conversation-execution-reliability`、`verify-electron-deepseek-reply-continuity`、`verify-harness-path-comparison` | 同一套 `startElectron` + `reservePort` + `waitForLocator` + `desktopAction` + `waitFor` + `waitForExit` + `CdpClient`（+ `taskkill`）在 9 个脚本里各抄一遍；本次把前五个并入 harness（见 §3），后四个保留（理由见 §4） |
| C. 真实模型 / SSE 验收 | `verify-electron-deepseek-*`（6 个入口）、`verify-memory-live-model`、`verify-ledger-reexecution-live`、`verify-harness-path-comparison`（live） | `lib/electron-deepseek-acceptance.mjs` 已经是它们共用的“无 CDP、走 Local App API `/run/stream`”验收面——与 A/B 的 CDP 面**不是**同一套语义（它要求 `windowVisible`、不注入调试端口），因此没有并入 harness |
| D. 进程内夹具验收（不启动应用） | `verify-memory-v3-*`、`verify-file-consistency-faults`、`verify-legacy-data-root-upgrade`、`verify-web-*`、`verify-app-recovery-sources` 等 | 夹具各自独立；共享的是被测包本身，无跨脚本重复实现 |
| E. 门与账本 | `run-verification-gate.mjs`（`verify:changed/core/full`）、`run-task-verification.mjs`（`verify:task`）、`run-affected-verification.mjs`（`test:changed`）、`measure-verification-baseline.mjs` | 已共用 `lib/affected-verification-*.mjs` 与 `lib/session-cache-ledger.mjs` |
| F. 构建与指纹 | `ensure-app-build.mjs`、`ensure-workspace-artifacts.mjs`、`run-verified-electron.mjs`、`package-windows-release.mjs`、`prepare-littlesheep-runtime.mjs`、`sync-desktop-shortcut.mjs`、`verify-launch-staleness.mjs`（启动链路的回归门：`.lnk` 必须指向启动器，且构建无法核对到当前时必须拒绝启动） | 已共用 `lib/app-build-fingerprint.mjs`、`lib/electron-runtime.mjs`、`lib/workspace-artifact-fingerprint.mjs`、`lib/pnpm-invocation.mjs` |
| G. 离线诊断（读执行日志） | `audit-cache-usage.mjs`（`audit:cache`）、`analyze-cache-shapes.mjs`、`analyze-prompt-cache.mjs`、`report-memory-v3-workload.mjs`（`report:memory-v3-workload`）、`report-real-long-task-baseline.mjs`、`report-renderer-chunks.mjs` | 三个根目录一次性诊断脚本已被本表 §5 处理 |

## 3. 本次合并（每条独有断言的新归属）

| 改动 | 重复实现 → 归属 | 独有断言去向 |
| --- | --- | --- |
| `lib/electron-cdp-harness.mjs` 增补 `waitForExit`，`extraEnv` 的值 `undefined` 表示“本次运行删除该环境变量” | 8 份私有 `waitForExit`、`verify-model-provider-ui` 的 4 行 `delete env[...]` 循环 → 一处 | 无断言，只有进程生命周期原语；契约与 `lib/electron-deepseek-acceptance.mjs` 的既有导出一致（返回退出码、超时不杀进程） |
| `verify-electron-ui-state-continuity.mjs` 并入 harness | 私有 `startElectron`、`connectRenderer`（CDP 目标发现）、`reservePort`、`waitForLocator`、`desktopAction`、`fetchJson`、`waitFor`、`waitForExit`、`CdpClient`（含执行上下文跟踪）、`settle` → harness | §1.2 全部场景与断言留在原文件；`connectRenderer` 只保留本门自己的一句要求（`.composer textarea` + `.sidebar-resizer` 就绪）并在其中显式 `Page.enable` |
| `verify-workspace-performance.mjs` 并入共享解码与 `numeric` | 私有 PNG 解码器（`decodePngInk` 内联的 IHDR/IDAT/反滤波/`pixelRgba`，约 90 行）→ `lib/png-pixels.mjs` 的 `decodePng` + 新增导出 `pixelRgbaAt`；私有 `numeric` → harness 导出 | 墨迹判定策略（直方图、主色、`distance ≥ 30`、`hasInk` 阈值）留在本门，因为它才是断言 |
| `verify-model-provider-ui.mjs` 并入 harness | 私有 `startElectron`、`connectRenderer`、`reservePort`、`waitForExit`、`waitFor`、`CdpClient` → harness；“环境里不能有 Provider 密钥”改为 `extraEnv: { NAME: undefined }` | 设置页卡片/编辑器几何、reveal 淡入后再测量、丢弃后密钥不落盘等断言全部留在原文件 |
| `verify-panel-collapse-release.mjs`、`debug-sidebar-corner.mjs` 并入 harness | 各自的 `reservePort`、`waitFor`、`waitForExit`、`CdpClient`、`spawn` 启动 → harness | 侧边栏/工作区面板“释放向外”运动断言、角落与设置过渡诊断输出留在原文件 |
| `scripts/analyze-cache-shapes.mjs` 增加“reply 请求头部条目（id 与字符数）”一节 | 根目录 `head-sections.mjs` 的独有读数 → 这个仍在维护的诊断入口 | 条目过滤正则与打印格式原样保留；改为报告**最新**一个含 reply 调用的 run（旧脚本取 `readdir` 顺序里的第一个，带有随机性） |
| 退役根目录 `head-sections.mjs`、`ts-keys.mjs`、`tool-keys.mjs` | 见 §5 | `head-sections` 的读数已并入上一行；`ts-keys`/`tool-keys` 的“打印第一批键名”由 `packages/runner/src/execution-log.ts` 的类型契约与 `execution-log.test.ts` 的键断言覆盖 |

## 4. 明确没动的部分与理由

- **9 个自带栈脚本里的后 4 个**（`verify-electron-runtime-continuity`、`verify-conversation-execution-reliability`、`verify-electron-deepseek-reply-continuity`、`verify-harness-path-comparison`）：它们的启动参数、探针与失败路径与 A/B 面不同（例如 `--inspect` 主进程调试端口、`taskkill` 强杀 + 断言退出码、live Provider 影子对比），本轮没有为这四个各跑一次真实 Electron 回归，因此只报告、不合并——**未验证的合并比不合并更贵**。
- **`captureScreenshot` 的 6 份实现**：三种失败策略（有预算→返回 `null`、无预算→抛错、捕获后写盘并返回路径）与不同的 `Page.captureScreenshot` 参数（`fromSurface`、`captureBeyondViewport`、`clip`）。要合并必须先引入一个“策略参数”，那正是任务书禁止的通用 DSL；留给下一轮按失败策略收敛。
- **`reloadRenderer` 的 7 份实现**：每份的“重新加载成功”判据不同（`timeOrigin` 变化、`readyState`、重连 CDP 目标），且都直接决定后续断言在哪个文档上执行。属于“看起来像、语义不同”。
- **`lib/electron-deepseek-acceptance.mjs`**：见 §2 聚类 C。
- **`verify-panel-collapse-release.mjs` / `debug-sidebar-corner.mjs` 的入口缺失**：两者都只有本文件与自身注释引用（`grep` 全仓、`package.json`、`vitest.config.ts`、docs 均无命中）。它们保有别处没有的断言（面板释放运动、角落/过渡诊断），因此**保留**，但“没有入口”本身是维护风险：本轮只把它们并入 harness 并记录在此，是否为它们补 `verify:*` 入口或并入相邻门需要协调者决定。补充事实：`scripts/debug-sidebar-corner.mjs` 还被 `.gitignore:74` 忽略、`git ls-files` 里没有它——它是本地调试工具而不是版本库内容，所以对它做的合并不出现在任何 diff 里（本轮仍然改它，因为任务范围写的是 `scripts/**.mjs`）。

## 5. 根目录三个诊断脚本的处置

| 脚本 | 行数 | 消费者搜索（改动前执行） | 处置 |
| --- | --- | --- | --- |
| `head-sections.mjs` | 17 | 全仓 `grep`（含 `packages/`、`scripts/`、`test/`、`docs/`、`*.yml/*.json/*.ps1`）只命中任务书第 93 行；根 `package.json` 无引用；`vitest.config.ts` 只收 `scripts/**/*.test.mjs` | 读数并入 `scripts/analyze-cache-shapes.mjs`，文件退役 |
| `ts-keys.mjs` | 15 | 同上，只命中任务书 | 退役：`trace` / `modelRequests` / `runtimeEventQueue` 的形状由 `packages/runner/src/execution-log.ts` 定义并在 `execution-log.test.ts` 中断言 |
| `tool-keys.mjs` | 12 | 同上，只命中任务书 | 退役：`toolCalls` / `toolInvocations` 的键与脱敏由 `execution-log.test.ts`（`toolCalls[0].call.name/input/result`、`inputHash`、不含原文）覆盖 |

维护入口结论：三者都是 `@littlesheep` 提示词缓存/工具证据调查期的一次性脚本，从未挂到 `package.json`，也没有任何文档把它们当作入口；仍在维护的同类入口是 `pnpm run audit:cache`（`scripts/audit-cache-usage.mjs`，`docs/reference/cache-baseline/README.md` 引用）与 `scripts/analyze-cache-shapes.mjs` / `scripts/analyze-prompt-cache.mjs`（用法写在各自文件头：`node scripts/<name>.mjs <dataDir>`）。

## 6. 本轮实测（改动前后）

只统计本任务改动的文件；同一工作区还有并行 agent 的未提交改动（例如 `check-repository-hygiene.mjs` 同期 +64 行），因此**不把 `scripts/` 总量差当作本任务收益**。

| 文件 | 改动前 | 改动后 | 差值 |
| --- | ---: | ---: | ---: |
| `scripts/verify-electron-ui-state-continuity.mjs` | 2,198 | 2,031 | −167 |
| `scripts/verify-model-provider-ui.mjs` | 543 | 417 | −126 |
| `scripts/verify-panel-collapse-release.mjs` | 341 | 259 | −82 |
| `scripts/verify-workspace-performance.mjs` | 2,181 | 2,106 | −75 |
| 根目录 `head-sections.mjs` / `ts-keys.mjs` / `tool-keys.mjs` | 3 文件 / 44 行 | 退役 | −3 文件 / −44 行 |
| `scripts/analyze-cache-shapes.mjs`（承接 `head-sections` 读数） | 114 | 139 | +25 |
| `scripts/lib/electron-cdp-harness.mjs`（承接 8 份 `waitForExit` + 环境变量删除语义） | 390 | 419 | +29 |
| `scripts/lib/png-pixels.mjs`（新增 `pixelRgbaAt`） | 103 | 114 | +11 |
| **脚本净变化** | | | **−429 行 / −3 文件** |
| `scripts/acceptance-matrix.md`（本文件，新增文档，不计入脚本行数） | — | 147 | +147 |

重复实现数量（全仓 `scripts/**/*.mjs` 按签名计数，`lib/` 内共享实现也算一份）：

| 签名 | 改动前 | 改动后 | 说明 |
| --- | ---: | ---: | --- |
| `class CdpClient` | 5 个文件 | 1（`lib/electron-cdp-harness.mjs`） | 删掉 4 份私有 CDP 客户端 |
| `function reservePort` | 5 | 1 | 删掉 4 份 |
| `function waitForExit` | 8（全部私有） | 6（其中 1 份是 harness 的共享实现，私有剩 5） | 私有实现 8 → 5 |
| `function waitFor(` | 11（其中 7 份在验收脚本里） | 7（其中 3 份在验收脚本里） | 验收脚本私有实现 7 → 3 |
| `function startElectron` | 9（其中 6 份是真实启动实现） | 8（其中 3 份真实、2 份已变成对 harness 的一行包装） | 私有真实启动实现 6 → 3 |

## 7. 本轮验证记录

全部为实测输出；没有跑到的项写“未测量”。

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 语法 | `node --check` 覆盖本任务改动的 8 个 .mjs | 全部 exit 0 |
| harness 原语 | 临时脚本：`waitForExit`（返回退出码 / 已退出立即返回 / 超时拒绝且**不杀进程**）、`waitFor` 的标签报错、harness 暴露的 24 个名字 | `HARNESS SMOKE: all checks passed` |
| PNG 解码等价 | 从 `git show HEAD` 抽出旧私有解码器，与新的 `png-pixels.mjs` 路径在 5 张真实 Chromium 截图（含 4 张高 DPI：1600×900 / 2132×1200 / 2560×1440）上比对 | `PNG DECODER EQUIVALENCE: all identical`（`sampledPixels`、`inkPixels`、`dominantColor`、`hasInk` 全等） |
| 真实 Electron：模型供应商门（**改动后通过**） | `node scripts/verify-model-provider-ui.mjs` | exit 0，`{"check":"model-provider-ui","ok":true}`；该门是新 `extraEnv: { 密钥: undefined }` 契约的唯一使用者，说明“环境里的 Provider 密钥不参与配置判定”仍然成立 |
| 真实 Electron：面板释放门（无入口，手工运行，**改动后通过**） | `node scripts/verify-panel-collapse-release.mjs` | exit 0，`{"check":"panel-collapse-release","ok":true,...}`；侧边栏与工作区面板“折叠时内容向外释放”的采样断言全过 |
| 真实 Electron：连续性门 | `node scripts/verify-electron-ui-state-continuity.mjs` | exit 1：跑完第一轮退出→重启握手后 `saved native window width differs: expected 1115, received 1101`（容差 12 px）。真实进程退出、locator 重建、CDP 重连、草稿恢复等步骤都已执行到 |
| 同上，HEAD 基线 | `git show HEAD:…` 复制成同目录基线脚本后运行，跑完即删 | exit 1：更早失败在 `verifyObservableActivityStream`（60 s 内流式片段恒为 `settled`、长度 0）→ **该门在本工作区改动前就是红的**，改动后的运行比基线走得更远 |
| 窗口几何归因 | 临时脚本用同一夹具分别以 harness 与旧私有 `spawn` 启动真实应用，读 `window.outerWidth` 后走 `acceptance quit` 握手比对持久化 bounds | 两条启动路径完全一致：live `{x:113,width:1115,height:708}`、saved `{x:120,width:1101,height:701}`（宽度差 14 px）→ **14 px 与启动路径无关**，是当前应用/夹具的既有偏差；没有用“把容差调大”来让门变绿 |
| 真实 Electron：工作区性能门 | `node scripts/verify-workspace-performance.mjs` | exit 1：`timed out waiting for inline deleted line comment add button geometry`（发生在 Monaco 墨迹测量之前，本任务改动的解码路径未被执行） |
| 同上，HEAD 基线 | 同目录基线副本 | exit 1：**同一断言、同一位置**（基线 931/867/104 行）→ 该门在本工作区改动前就是红的 |
| 调试角落工具（`git` 忽略、无入口，手工运行） | `node scripts/debug-sidebar-corner.mjs` | **挂起**（15 分钟未结束，已终止）：停在第一个 `Page.captureScreenshot({ fromSurface: true, captureBeyondViewport: false })`。归因实验（同一 harness 路径）：`{ format: 'png' }` 返回 58,668 字节，而带 `captureBeyondViewport: false` 的同一调用 15 s 超时 → 与本次合并无关（该调用本轮未被改动），但该工具在当前应用状态下**本来就不能跑完** |
| 门禁 | `pnpm run check:repo` | `Repository hygiene: ok (38 passed, 0 failed)`；`TypeScript project references: ok (28 packages)`。注意：同一工作区里另一个 agent 删除了**已跟踪**的 `scripts/verify-memory-v3-taskbook-refinement.mjs`（工作树已删、索引里还在），`check-repository-hygiene.mjs` 的 `checkCanonicalFiles` 会直接 `readFile` 该路径并以 ENOENT 崩溃——这是门禁自身的健壮性缺口，不是本任务的改动。为了证明本任务的门禁状态，本轮把该文件按 `git show HEAD:` 原样临时恢复、跑完门禁后再次删除（临时窗口内输出 38/38；工作树恢复为对方留下的 ` D` 状态）。 |

未测量（不声明）：`verify:html-preview-baseline`（本轮未改动该文件，没有为它跑真实 Electron 回归）；其余 30 余个 harness 门（未改动，未重跑）；`debug-sidebar-corner.mjs` 的端到端结果（被上面的既有挂起挡住，且该文件被 `.gitignore` 忽略、`git` 里没有基线可对比）。

关于 `package.json`：本轮**没有改动任何 npm script**（退役的三个根目录脚本本来就没有入口）。工作区里 `package.json` 的 4 行差异分别来自 `sync-desktop-shortcut` 的接线与 `verify:memory-v3-taskbook-refinement` 的移除，都不是本任务的改动。顺带发现：`scripts/verify-memory-v3-taskbook-refinement.mjs` 在入口被移除后变成了新的“无入口脚本”，需要它的 owner 决定补回入口还是退役。
