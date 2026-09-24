# 桌面冷启动基线 2026-09-23（CS-01）

最后更新：2026-09-24 14:17:40

本文件记录冷启动任务书 CS-01 的第一次完整基线。原始逐次样本见同目录
[机器可读账本](desktop-cold-start-baseline-2026-09-23.json)（由
`scripts/measure-desktop-cold-start.mjs` 生成，不含密钥、用户正文或路径正文）。

## 环境与口径

| 项目 | 值 |
| --- | --- |
| 机器 | win32 x64，Windows 10.0.26200，AMD Ryzen 9 7945HX（32 逻辑核），15.7 GB 内存 |
| Electron | 36.9.5（`packages/app/runtime/electron-v36.9.5-win32-x64` 已验证运行时） |
| 应用构建 | `packages/app/out`，输入摘要 `12b2d53c98be86f2d4585b9f86904149c43eeb393eda63ace0e7a49fdbeeba59` |
| 样本 | 每个 profile 5 次，共 20 次，0 次失败；每次样本只启动 1 次，因此下表是**首次启动**数字（稳态数字见"首次启动与稳态启动"一节） |
| 数据根 | 每次全新隔离目录；`empty` 不写 config，其余写无密钥的 fixture config（含本地不可达 provider，使执行能力能真正就绪） |
| 计时开关 | `LITTLESHEEP_BOOTSTRAP_TIMING=1` |

五个时间点及其时钟来源：

| 指标 | 含义 | 时钟来源 |
| --- | --- | --- |
| `spawnToMainModuleMs` | 进程启动 → 组合根主模块求值完成（含首条业务日志之前的模块加载） | 子进程 `process.uptime()` |
| `rendererFirstFrameMs` | 渲染器导航开始 → 真实首帧 | 渲染器 `performance.now()`，由渲染器自报 |
| `processCreateToFirstFrameMs` | 进程启动 → 真实首帧 | 上者的主进程到达时刻（`process.uptime()`） |
| `sessionReadableMs` | 输入可用 → 当前会话在侧栏可读 | 渲染器 `performance.now()` |
| `executionReadyMs` | 进程启动 → `/runtime/readiness` 报告 `ready` | 父进程墙钟，减去 `process.uptime()` 反推的进程创建点 |

执行准备的子阶段（`runner-infra-*`、`execution-ready`）由 `packages/runner/src/infra.ts` 与组合根在同一 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 开关下产出，格式与主进程阶段一致，因此可以放进同一份账本做拆解。

`firstContentfulPaintMs`（`performance.timeOrigin + fcp` 的绝对墙钟）只作为首帧自报值的交叉校验，不进入汇总表。

**冷启动口径的诚实边界**：每次重复使用全新数据根，因此数据布局是冷的；但应用包已被上一次重复读过，操作系统文件缓存是热的。此处不声称"完全冷启动"，也没有样本覆盖系统重启后的首次启动。

## 汇总（毫秒，n=5，格式为 最小–中位–最大）

| 指标 | empty | normal | large | recovery |
| --- | ---: | ---: | ---: | ---: |
| 进程启动 → 主模块加载完成 | 204–209–215 | 199–205–221 | 198–203–214 | 200–207–211 |
| 渲染器导航 → 真实首帧 | 110–118–286 | 148–285–291 | 154–279–296 | 135–287–356 |
| 进程启动 → 真实首帧 | 1286–1318–1420 | 1313–1402–1420 | 1344–1421–1435 | 1281–1417–1641 |
| 输入区可输入 | 351–389–409 | 371–374–407 | 407–418–460 | 371–393–420 |
| 当前会话可读 | —（无会话） | 376–378–416 | 418–434–478 | 376–403–509 |
| 首次可执行 | 1878–1891–1953 | 1662–1800–1808 | 1699–1831–1855 | 1609–1808–2063 |
| 首次发送准备耗时 | 13.3–13.6–17.1 | 17.6–18.6–21.4 | 29.2–30.8–33.7 | 16.9–17.4–18.8 |

## 从基线读出的可执行结论

1. **执行就绪是首个可执行时间的决定项**：会话规模从 0 涨到 200 条（large），输入可用只从 389 涨到 418 ms、首次可执行只从 1891 涨到 1831 ms（中位数互有高低，差异小于样本波动）。UI 索引不是瓶颈。
2. **首帧之前的固定开销集中在主模块求值**：约 205 ms，占总"进程启动 → 首帧"（约 1.3–1.4 s）的 15%。即使把全部主进程业务逻辑削掉，收益上限也只有这个量级。
3. **"进程启动 → 执行就绪"约 750 ms，其中执行准备占 171 ms**（n=15 中位；见下节预算）。要让"首次可执行"更早，只能改 Runner 构建与 RunRouter 创建这两段，而它们受"迁移与一致性优先"约束，不能简单并行化。
4. **首次发送准备耗时 13–34 ms**，说明启动等待没有被转移到用户点击发送之后；large profile 偏高是会话切换读历史所致。
5. **恢复档案没有额外代价**：recovery 的中位数与 normal 同量级，说明检查点发现不构成启动瓶颈。

结论：CS-04 的优化目标应集中在"执行准备"（`startExecution` 内部），而不是 UI 索引或首屏依赖；CS-05 的静态导入链在实测中只占约 205 ms 的一部分，先不做无证据的拆分。

## CS-04 执行准备预算（n=15，normal）

`execution-start` → `execution-ready` 的中位跨度为 **170.7 ms**（min 164.6 / max 186.4），拆解如下（子阶段由 `packages/runner/src/infra.ts` 的 opt-in 计时标产出，与组合根共用 `[bootstrap-timing]` 格式）：

| 段 | 中位（ms） | 说明 |
| --- | ---: | --- |
| Runner 构建合计（`execution-start` → `runner-ready`） | 121.0 | 内含下列子阶段 |
| ├ 可观测性存储（cache observation key + store） | 4.1 | |
| ├ durable harness 基础设施 | 55.2 | 当前最大单项 |
| ├ run checkpoint disposition / store | 1.4 | |
| ├ embedding（仅 v3 后端；本基线为 v2，未启用） | 0.2 | |
| ├ memory repository 初始化 + 恢复队列 | 10.8 | |
| ├ bootstrap 文件加载（`loadBootstrapFiles`） | 30.5 | 第二项 |
| ├ skill loader + 资源同步 | 15.4 | |
| └ 其余装配（harness/registry/compaction） | ~3 | |
| RunRouter 创建 + 附件缓存初始化 | 50.1 | `server.setRunner()` 内 |
| 插件宿主（动态导入 + 启动） | 2.8 | 已移出就绪路径 |

该表的 durable harness 行是粗粒度标点（`observability-ready` → `durable-ready`，含区间内的其他构造）。后续加了四个 opt-in 子阶段标把四个存储分开，同一口径下的阶段墙钟为 36–40 ms，其中 events 2.4–3.2 / inbox 9.0–11.4 / run leases 9.6–11.2 / effect leases 11.4–15.6 ms（中位，n=6–10）；两批数字来自不同批次，不用来互相做差值，配对结论见下节 ③。

同一份样本的"进程启动 → 执行就绪"为 748.6 ms，构成为：进程启动 → `bootstrap-start` 290.7 ms（其中主模块求值约 209 ms，剩余约 80 ms 是 Electron 自身启动）、bootstrap 到就绪文件 53.2 ms、就绪文件到窗口初始化 18.5 ms、窗口初始化到执行就绪 170.9 ms。

结论：**Runner 构建与 RunRouter 创建合计约 171 ms，是唯一还有量级的执行准备成本**；其中 durable harness 与 bootstrap 文件加载是最大两项。durable harness 这一项已按"重叠独立工作"处理并取得阶段级收益（见下节 ③：阶段墙钟 36–40 ms → 10–13 ms，构建净收益约 14 ms）；bootstrap 文件加载的成本不在读取而在资源组写入，改成并发读取实测无收益（见下节 ④）。两项的剩余部分仍受"数据一致性优先"约束，要再压需要改这两条初始化路径本身，属于需要独立设计的工作。

补充测量（新增 `runner-infra-returned` 标点，n=3）：`buildInfrastructure` 覆盖了 Runner 构建的**全部**成本（111.9 / 127.8 / 123.9 ms，与 `runner-ready - execution-start` 的 112.1 / 128.0 / 124.1 ms 只差 0.2 ms），因此构建之后没有隐藏工作。同一批样本还显示 RunRouter 创建（`runner-ready` → `execution-ready` 约 123 / 95 / 104 ms）与渲染器加载（`renderer-load-started` 570–575 ms → `renderer-did-finish-load` 716–736 ms）在时间上重叠，所以执行准备对首帧的可见影响小于其绝对耗时。真正压在关键路径上的是渲染器自身的求值与绘制（首帧前的约 500–700 ms），而上一节已证明"减少入口字节"不是改善它的有效手段。

## 已试做的改动及其真实结论

**① 插件包改为仅在执行阶段动态导入**（新增 `packages/app/src/main/plugin-host-startup.ts`，主 bundle 2.80 MB → 2.76 MB）。

- 测前（同一脚本，empty，n=5）：主模块求值 197–212–216 ms，就绪文件 649–700–721 ms。
- 测后（empty，n=10）：主模块求值 199–206–220 ms，就绪文件 668–711–732 ms。

差异落在样本波动内，**不构成提速证据**。保留原因是语义正确（插件包在首条业务日志之前并不需要）。

**② 插件宿主移出执行就绪路径**（`readiness.ready()` 先发布，插件异步加载）。

- 更正：早先按 `plugin-host-ready - runner-ready` 读出的 ~50 ms 是**测量错误**——那一段其实包含 RunRouter 创建。用 `execution-ready` 标点分开后，插件动态导入 + `createPluginHost` 的真实代价是 **2.8 ms**（n=15，min 2.6 / max 3.4）。
- 因此该项**不是有意义的提速**；改动保留是因为它让"执行可用"不再等待可选能力，且与既有"插件宿主缺失时核心 API 仍可用"的契约一致。`executionReadyMs` 的 5 次对照（1771.2 → 1769.3 ms 中位）同样落在噪声内，不作为提速结论。

**③ durable harness 的四个存储改为并行初始化**（`packages/runner/src/durable-harness-infrastructure.ts`，保留）。

- 测前细分（新增四个 opt-in 子阶段标，normal，n=6）：events 2.4 / inbox 9.0 / run leases 9.6 / effect leases 15.6 ms（中位），四段严格串行相加。
- 四个存储各占自己目录下的锁文件，除父目录外不共享状态，因此可重叠。成对实测（normal，`--no-send`，每变体 8–10 次，两个变体各构建一次，并交换测量顺序以抵消时间漂移）：

| 指标（ms，中位） | 串行（两组） | 并行（三组） |
| --- | ---: | ---: |
| durable 阶段墙钟（`observability-ready` → `durable-ready`） | 39.8 / 35.8 | 12.8 / 10.1 / 12.1 |
| Runner 构建（`execution-start` → `runner-ready`） | 116.3 / 114.0 | 99.4 / 101.3 / 101.1 |
| 紧随其后的 bootstrap 文件注册 | 28.2 / 34.0 | 44.6 / 43.6 / 44.9 |
| 输入区可输入 | 298.2 / 292.8 | 294.6 / 303.5 / 293.2 |
| 当前会话可读 | 306.7 / 297.7 | 302.9 / 308.3 / 297.9 |

- 结论：durable 阶段 **36–40 ms → 10–13 ms**，Runner 构建 **114–116 ms → 99–101 ms**。下一个阶段（bootstrap 文件注册）吃掉了其中 10–16 ms，所以构建层面的净收益约 **14 ms**（已含这笔回吐）。渲染器侧两个时刻没有移出各自的波动区间，因此**只声明阶段级收益，不声明"首次可执行"变快**。保留理由：同样是这些工作，只是不再互相等待，失败语义不变（按声明顺序报告第一个失败，仍然在建模之前关闭 next 模式准入）。
- 失败语义的一处差异：串行版本在第一个存储失败后不再初始化后续存储；并行版本四个扫描都已启动，因此后续存储可能已完成自己的扫描（含过期认领重排的有界写入）。该写入幂等、限于自身目录，且失败的 run 无论如何都不会继续。

**④ bootstrap 文件读取改为并发（已测量并回滚）**。`BootstrapResourceCoordinator.load` 里六个引导文件原为逐个 `await readFile`，改为 `Promise.all` 后同一批测量（normal，n=8）显示该阶段 **43.6 → 44.9 ms**，没有变化。说明这段成本不在读取，而在随后的资源组写入；读取并发属于无收益改动，已回滚，不保留。

**⑤ bootstrap 文件注册的真实构成：一半是首次注册，稳态只剩读取（已用同一数据根的连续启动证实，不作为优化目标）**。

跨 profile 测量（empty / normal / large 各 3 次）显示该阶段 normal 27.9–41.3 ms、large 38.5–51.4 ms，**不随数据根规模增长**，因此不是"扫描整张资源注册表"的成本。同一数据根连续启动三次的对照（临时探针，同一 `LITTLESHEEP_DATA_DIR`、每次新建 chromium profile、以日志中的 `runner-ready` 作为同步点，两轮结果一致）：

| 启动次序 | `bootstrap-files-loaded`（ms） | 四个 durable 存储（ms） |
| --- | ---: | --- |
| 第 1 次（数据根为空） | 20.2 / 22.9 | 0.8 + 7.2 + 7.6 + 7.3 |
| 第 2 次 | 10.1 / 11.3 | 0.7 + 9.1 + 8.9 + 9.0 |
| 第 3 次 | 10.4 / 12.3 | 1.3 + 14.4 + 13.9 + 14.0 |

结论有两条：①该阶段的成本里约一半（10–12 ms）是**首次注册**——六条资源登记与账本事务必须落盘，`sameResourceRegistration` 忽略 `registeredAt`/`updatedAt`、`commitMutation` 在无增删改时提前返回，所以同一数据根的后续启动直接跳过写入；②durable 存储的扫描**不随冷热变化**（每次都要读自己的目录），因此并行化的收益是稳态收益，而注册写入的收益只发生一次。

这同时校正了本基线的读法：**测量脚本每次使用新建的数据根，因此表里的数字是"首次启动"数字**；真实用户第二次启动的 bootstrap 注册阶段约为 10–12 ms，稳态总启动会比表里的略短。该阶段剩下的 10–12 ms 是六次文件读取、内容哈希与一次 no-op 变更，**不再作为优化目标**（读取并发已证伪，见 ④）。

## CS-05 首屏依赖：语法高亮改为按需加载（成对实测）

首屏依赖审计：渲染器入口 chunk 曾达 2.68 MB。Monaco 与 mermaid 已经是动态导入，但 `react-syntax-highlighter` 的完整 `Prism` 构建（300 个语言模块 + 47 套样式）被静态引入 `Markdown.tsx`，因此冷启动必须求值它——Node 下单独 import 该入口实测约 **380 ms**。

改动：`Markdown.tsx` 改为 `lazy(() => import('react-syntax-highlighter'))`，代码块在 chunk 到达前渲染等宽纯文本回退（复用同一批 class 与内联样式，避免布局跳动），到达后照常高亮；仍使用完整 `Prism`，语言覆盖不减。

成对实测（同一脚本、同一机器、同一 profile，各 5 次，改动前后各重新构建一次）：

| 指标（ms，中位） | 静态高亮（对照） | 按需加载 | 差值 |
| --- | ---: | ---: | ---: |
| 入口 chunk 体积 | 2,683,833 B | 1,747,429 B | −936 KB |
| 进程启动 → 真实首帧 | 1296.2 | 1148.1 | **−148.1** |
| 输入区可输入 | 380.9 | 303.4 | −77.5 |
| 当前会话可读 | 395.9 | 308.5 | −87.4 |
| 首次可执行 | 1750.7 | 1517.0 | −233.7 |

对照样本 `[1341.7, 1414.5, 1289.0, 1296.2, 1289.5]`，改动后 `[1145.0, 1147.2, 1172.6, 1153.0, 1148.1]`：两组不重叠，因此这一项**是有证据的提速**，而不是噪声。

## CS-05 首屏依赖：入口 chunk 的实际构成

源码级 import 阅读无法回答"谁占了入口 chunk"：Vite 会把所有静态可达模块提升进入口，只对动态导入分块。`scripts/report-renderer-chunks.mjs`（`node scripts/report-renderer-chunks.mjs`）用真实构建产出逐模块归属报告，输出 `renderer-module-report.json`。

最近一次实测（入口 `assets/index-DyJBQYWc.js`，1,728,325 字节，433 个模块）：

| 归属 | 入口内字节 | 说明 |
| --- | ---: | --- |
| react-dom | 133,319 | 首次渲染必需，不可后移 |
| Markdown 解析管线（micromark / mdast / hast / unified / vfile / remark-gfm） | 约 250,000（top-40 内已计 200,000+） | 只在渲染 Markdown 正文时需要 |
| renderer/workspace/*（top-40 内） | 181,455 | 右侧拓展工作区整棵树 |
| use-app-controller / assistant-turn / 图标等应用代码 | 约 120,000 | 壳必需 |
| dompurify（经 `workspace/preview-pane` → `html-preview`） | 121,812 | 只在预览 HTML 时使用 |
| react-syntax-highlighter 语言定义 | 0 | 已于上一轮按需加载 |

结论与下一步：入口里还剩两块**可后移**的大块——Markdown 解析管线与整个拓展工作区树。两者都需要先解耦才能安全后移（Markdown 需要把活动行用的轻量 `InlineMarkdown` 与完整解析器拆开；工作区需要把 `use-workspace-layout-controller` 持有的草稿/评论状态从树的导入路径上移走），因此各自需要独立设计与验证，不能顺手改。

**已被实测证伪的一项**：把 `WorkspaceHtmlPreview`（携带 dompurify）改为按需导入，入口 chunk 从 1,747,930 降到 1,678,860 字节（−49 KB），但成对实测没有收益——首次可执行中位 1536.7 → 1606.4 ms、真实首帧 1172.7 → 1214.7 ms（两组样本区间重叠，一次运行甚至更慢）。因为既没有测到收益又要引入加载态，该改动已回退。这也说明**入口字节数不是首帧的可靠代理**，后续按需加载必须以成对实测为准。

**第二项被证伪的尝试**：把整条 Markdown 解析管线（`react-markdown` + `remark-gfm` 及其全部传递依赖）改为按需导入，入口 chunk 从 1,747,930 降到 1,348,214 字节（**−400 KB，21%**），但成对实测同样没有收益：

| 指标（ms，中位，n=5） | 解析器随入口（对照） | 解析器按需 | 差值 |
| --- | ---: | ---: | ---: |
| 进程启动 → 真实首帧 | 1170.5 | 1177.5 | +7.0 |
| 输入区可输入 | 295.7 | 296.0 | +0.3 |
| 当前会话可读 | 303.8 | 300.3 | −3.5 |
| 首次可执行 | 1550.0 | 1595.7 | +45.7 |

样本区间完全重叠（首帧对照 `1137.7–1207.4` vs 按需 `1139.4–1192.5`），因此该改动同样已回退。

**结论（已写入任务书）**：入口体积在前端项目中通常是首屏的强代理，但在这个 Electron 应用里不成立——`file://` 加载不需要网络传输，且解析与执行与首帧准备并行。真正有效的那一项（语法高亮）之所以有效，是因为它在首帧前就被**同步求值**并占用主线程（Node 下单独 import 约 380 ms）。因此本专项后续只接受"成对实测有收益"的按需加载。

唯一保留的副产品：活动行用的单行标签改由 `inline-markdown.tsx` 的轻量扫描器渲染（支持 `**粗体**`、`*斜体*`、`` `代码` ``、`~~删除~~`，其余按字面输出），它让活动行既不必等解析器、也不把整条插件链拉进入口依赖图，并有独立测试覆盖。

## CS-02 真实窗口视觉证据

`scripts/verify-desktop-cold-start-visuals.mjs`（`pnpm run verify:desktop-cold-start`）在真实 Electron 窗口上驱动三种窗口宽度并逐像素检查，截图保存在 [`screenshots/`](screenshots/)，逐项结论见 `screenshots/cold-start-visuals.json`。

已核验：

- 三种宽度（1280×820、980×700、1580×900）下，渲染器标题栏整行、标题栏右段与正式界面背景都是同一实色，且标题栏下方 60 CSS px 内没有色阶断层——这正是 CS-02 要消除的接缝。
- **最大化与还原**同样逐像素核验（[`screenshots/renderer-maximized.png`](screenshots/renderer-maximized.png)、[`screenshots/renderer-restored.png`](screenshots/renderer-restored.png)）：最大化后 1920×1032，标题栏整行与背景仍是同一实色、标题栏下方无断层；还原回 1580×900 后同样成立。脚本还断言两次截图尺寸确实不同，避免把"动作没生效"当成通过。最大化是用户停留最久的状态，接缝在那里最容易暴露。
- 窗口背景与原生标题栏覆盖区使用同一 `#101010`（由本机无法从 DOM 读取的验收快照 `visual` 字段给出，`titlebarOverlayColor` / `backgroundColor` / `startupSurface` 三项逐一比对），原生标题栏高度 32 px 与渲染器行高一致。
- 三张截图里都能看到小羊品牌标记位于标题栏，交接后没有位置/尺寸跳变。

口径说明：`Page.captureScreenshot` 只截取 web contents，**原生最小化/最大化/关闭按钮不在这张图里**，它们的颜色由上面的验收快照字段核对。

启动失败页同样有实机像素证据。它无法靠等待到达（产品只在真实失败时渲染它），所以隔离验收运行经 `/application/acceptance` 的 `startup-error` 动作把一段真实失败文案交给**生产同一份** `showStartupError` 文档，再对窗口截图（[`screenshots/startup-error.png`](screenshots/startup-error.png)）。实测：标题栏行、左侧 12 CSS px 竖向通道整列、以及同高度的右侧通道都是 `#101010`（声明表面，整列只有一种颜色），底部半透明错误卡片与表面合成后为 `#090909`，并且屏幕上确实是传入的失败文案。该动作只在 `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` 的验收运行中挂载，生产运行不受影响。

启动页本身也有了像素证据（[`screenshots/startup-page.png`](screenshots/startup-page.png)）：`/application/acceptance` 的 `startup-page` 动作让窗口重新加载**生产同一份**启动文档（`loadStartupPage` 的同一个模板），随后截图。实测标题栏行与左右通道都是 `#101010`、通道整列只有一种颜色、品牌图标在位（中心像素 `#ccbfb3` 即图标本身）、且**没有**错误卡片。这条证据的边界必须说清楚：它证明的是启动页**长什么样**，不证明它在屏幕上停留的那约 90 ms——交接瞬间仍需人眼/高速拍摄，因此该复选框不因它而勾选。

尚未核验（需要人工在实机上逐项拍摄，本任务书对应复选框保持未勾选）：

- 启动页到渲染器的**交接瞬间**与窗口出现时刻（文档像素已由上一段覆盖；早先一次尝试性抓取拿到的是窗口尚未绘制文档时的表面色 `#121212`，因此脚本保留了"底色必须等于声明值"的防线，不把抓到的任意一帧当证据）。
- 失焦与最小化（最小化后窗口不参与截图，失焦只会改变原生按钮的激活态；两者都需要人眼确认，脚本不冒充）。
- 125% / 150% / 200% 显示缩放与明暗桌面背景。
- 打包版。

## CS-03 / CS-06 真实窗口交互证据

`scripts/verify-desktop-cold-start-interaction.mjs` 在真实窗口上验证"界面先可用"的交互契约，逐项观察见 `screenshots/cold-start-interaction.json`。最近一次运行的实测事实：

| 步骤 | 观察 |
| --- | --- |
| 调试器接入时 | `readiness.state = "starting"`，原因是 Runtime 自己给出的阶段文案 |
| 未就绪期间输入 | 草稿写入成功、焦点在输入框、**发送入口为 `disabled`**（就绪前发送被真实限制，不是靠 transport 静默排队） |
| 未就绪期间按 Enter | 草稿仍为 `冷启动草稿`，没有被当成已发送，也没有出现错误横幅 |
| 未就绪期间的屏幕事实 | 就绪提示可见且文案是 Runtime 自己给的「正在准备运行能力」，同一时刻发送入口仍为 `disabled`、草稿仍在输入框，`/runtime/readiness` 仍为 `starting` |
| 就绪后 | 草稿仍是 `冷启动草稿`、焦点仍在输入框、`#root` 未重挂载、`location` 未变化、就绪提示消失 |
| 关闭策略 | `trayAvailable: true`、`activeRunCount: 0`、`background-while-active` ⇒ 关闭最后一个窗口即退出（不是隐藏），因此"隐藏/恢复"需要活跃任务才可达，未在此脚本中冒充验证 |

这一步同时发现并修掉了一个真实回归：发送按钮原先只看草稿是否为空，未就绪时仍可点击，用户会以为已经发送。现在它由 Runtime 的就绪事实直接禁用，入口文案也换成同一真实原因。

**故意拉慢的初始化已被覆盖**：正常启动的未就绪窗口只有约 300 ms，短到无法在其中输入并读取提示。脚本因此通过 `LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS`（仅验收运行读取，上限 60 s）要求应用**推迟发布**就绪——Runner 照常构建，被拉长的只是渲染器看到的窗口，不是伪造的慢启动或失败启动。最近一次运行的实测窗口为 **8.1 s**（要求 ≥ 6 s），上面那批断言都在这段窗口内取得，并且脚本会断言窗口确实还开着（读到提示的那一刻 `/runtime/readiness` 仍必须是 `starting`），否则判为无效证据。`index.ts` 在延迟生效时打出 `acceptance-ready-delay` 阶段标，账本里不会把它误读成真实初始化变慢。

**该窗口内的会话切换也已覆盖，并因此发现并修掉一个真实缺陷**：在未就绪时打开另一段对话，原先会显示 `加载历史失败: Local app API error: 503`——历史由 Runner 提供，而该路由在 Runner 发布前按设计返回 503。窗口是刻意做成可交互的，把这种"暂时做不到"渲染成失败横幅与就绪契约矛盾。修法：`switchSession` 取历史前先 `await waitForExecutionReady()`（已就绪/已失败立即返回；就绪未知时立即返回，不影响单测与非 Electron 宿主），等待期间消息区保持加载态、就绪后对话自然出现；真正 `failed` 时给出的是 Runtime 的原因，而不是"加载历史失败"。修复后实测：未就绪期间 `会话 0 → 会话 1 → 会话 0` 往返成功、草稿全程仍在输入框、**没有错误横幅**、没有启动 run、`/runtime/readiness` 全程 `starting`，就绪后同样无错误横幅。同一轮记录的草稿事实：编辑器只有一个文本槽，草稿在往返后仍在（`draftSurvivedSwitch: true`，脚本无需重打）。

尚未核验：需要活跃任务才可达的隐藏/恢复周期。

### CS-06 恢复归属：真实模型配置下的实机取证

启动恢复的发现是**等执行就绪之后**才做的，所以没有可用模型引用时只能观察到失败路径（见上一版记录）。`scripts/verify-desktop-cold-start-recovery.mjs`（`pnpm run verify:desktop-cold-start-recovery`）补上了另一半：用**真实 Provider 凭据**（环境变量透传，凭据不写入数据根）让执行真正就绪，再把**真实检查点文件**复制进隔离数据根后观察。逐项事实见 [`cold-start-recovery.json`](cold-start-recovery.json)。最近一次运行（真实 DeepSeek 配置 + 两个来自不同会话的真实检查点）：

| 步骤 | 观察 |
| --- | --- |
| 执行就绪 | `state = "ready"`、`phase = "execution"`（这正是此前无法到达的前置条件） |
| 就绪后发现 | `/run-checkpoints` 返回 200，两个检查点都在，且各自保留**自己的** `sessionId`（`c33f8d40…` 与 `64990330…`），未被归到当前活动会话 |
| 界面入口 | `.checkpoint-recovery-trigger` 显示「待恢复任务 2」，草稿仍在输入框、焦点仍在输入框、**没有启动任何 run**（发现不等于执行） |
| 打开列表 | 对话框列出 2 项；选中项显示「可以继续 / 整理交付 / 9/23 10:47」，工作区为 `<user-home>\.littlesheep\workplace`，无阻塞项 |
| 切换选中 | 点第二项后摘要换成它自己的内容（工作区 `<repo>`、状态「需要处理」），即每个检查点各自归属 |
| 打开恢复后 | 草稿仍是「恢复探针草稿」、焦点仍在输入框、`activeRunCount = 0` |

口径与边界（同一文件里也写明）：

- **只验证发现与归属，不验证续接执行本身**。脚本不会点"继续"：恢复会在检查点记录的工作区里真正执行工具，而那属于本机真实数据根，需要用户决定。
- 第二个检查点因模型与夹具不同而显示「需要处理」，脚本把 `resumable: false` 如实记录，不因此判失败。
- 检查点文件按原样复制、未修改；夹具里为它们的会话 id 建了同名会话（没有对应历史），因此这验证的是"发现与归属"，不是"恢复后对话内容正确"。
- 证据文件中会话 id 只保留 8 位前缀，用户目录与仓库路径分别替换为 `<user-home>` / `<repo>`：仓库不收录会话 id 与本机路径（AGENTS.md 的仓库边界），而"两个检查点各自归属"仍可从不同前缀读出。
- 没有凭据时脚本会**跳过并说明原因**（`skipped: true`），不产生任何结论。

### CS-06 失败态：两个阶段的真实取证

`scripts/verify-desktop-cold-start-readiness-failure.mjs`（`pnpm run verify:desktop-cold-start-readiness-failure`）用**真实故障**（不是验收动作或桩）观察失败态，且不挂载验收面（`LITTLESHEEP_ELECTRON_ACCEPTANCE` 为空）。逐项事实见 [`cold-start-readiness-failure.json`](cold-start-readiness-failure.json)：

| 阶段 | 制造方式 | 用户实际看到的状态 |
| --- | --- | --- |
| ③ 执行准备失败 | config 指向 `missing-provider/missing-model`，没有任何 provider 声明它 | **保留活动外壳**：`.runtime-readiness-notice.failed` 逐字显示 `运行能力启动失败：runner: no provider "missing-provider" for model ref …`，`aria-live="assertive"`；发送入口 `disabled`；输入区仍在（改模型所需的设置仍可打开）；无错误横幅；未启动 run |
| ① 数据前置失败 | `config.json` 是非法 JSON，失败发生在渲染器加载之前 | **独立启动失败页**：`data:text/html` 文档、`无法启动` + 解析错误原文（含出错的 config 路径）、品牌图标在位、表面 `#101010` 整列单色、错误卡片已绘制（`cardPainted: true`） |

同一批测量还确认了失败时的接口契约：`/runtime/readiness` 返回 200 且 `state=failed`、`retryable=true`；元数据路由 `/sessions` 仍 200；Runner 依赖路由 `/run-checkpoints` 503 失败关闭（原因文案「The runtime is still starting; execution is not available yet.」）。

口径与边界：

- 只覆盖两种成因（未知模型引用、无法解析的 config）；其余成因共用同一批代码路径，但本轮没有采样。
- 截图证明的是页面像素，不测文档切换的时刻。
- 该批证据促成一处显式化改动：`desktop-shell.ts` 新增 `hasLoadedRenderer()`，`index.ts` 的 bootstrap 失败分支只在渲染器**尚未**接管时才切到独立失败页。此前同一位置无条件切换，实测结果是渲染器文档最终仍在屏上（③ 阶段），即"切过去又被接管"这一结果并未写在代码里；现在两个阶段的可见状态都是显式契约，并各有实机证据。

**同批覆盖了有界重试（CS-06 此前唯一的实现缺口）**：失败态现在带一个重试入口（`RuntimeReadinessNotice` 的 `.runtime-readiness-retry`，只在 `state=failed && retryable` 且预算未耗尽时出现），Main 侧由 `execution-retry.ts` 执行，**先重读 `config.json` 再重建执行阶段**——也就是"改好设置后不用重启"。实测（同一真实窗口）：

| 步骤 | 观察 |
| --- | --- |
| 配置仍然错误时点重试 | `/runtime/readiness` 仍 `failed`、`retryable: true`；提示仍逐字显示原因并继续提供重试入口；未启动 run |
| 把 `config.json` 改成可用配置后点重试 | `/runtime/readiness` 变为 **`ready`**、失败提示消失，`/run-checkpoints` 从 503 变为 **200**（Runner 依赖路由解锁） |

预算与并发由单元测试固定（`execution-retry.test.ts`：连续三次失败后拒绝并标记不可重试；成功一次即重置预算，使之后另一次失败仍有自己的机会；并发点击返回 `in-flight`；非 Error 抛出保留文本），渲染器侧的可重试判定由 `execution-retry-state.test.ts` 固定；窗口探针负责"真实失败 → 重试仍失败 → 修好后重试成功"这条端到端路径。两者分工写在证据文件的 `limits` 里。

**重试的并发也在窗口级确认**：同一时刻发出两次 `retryExecution()`，实测第一次 `accepted: true`（`attemptsUsed: 2`、`attemptsRemaining: 1`，并带真实失败原因），第二次 `accepted: false`、`refusedBecause: "in-flight"`——拒绝发生在 Main，而不是靠界面把按钮变灰；随后"修好配置后点重试"用掉最后一次预算并成功转为 `ready`。

### CS-03 / CS-06 启动期间的窗口生命周期

`verify-desktop-cold-start-interaction.mjs` 的窗口生命周期用例（同一脚本内第二次隔离启动，配置 `always-background` 使"隐藏"可达）在加宽的未就绪窗口内逐项确认：输入草稿后**关闭窗口**——进程存活、验收快照显示窗口确实不可见、`show` 回来后草稿与当前会话都没变、焦点仍在输入框；随后**最小化再还原**——输入区仍在、草稿仍在；最后就绪仍到达 `ready`，提示消失、草稿保留。结论：启动期间隐藏或最小化窗口不会重载渲染器，也不会丢用户已经输入的内容。最小化后的窗口不参与截图，因此这条只断言 DOM 状态，不冒充像素证据。

## 打包版冷启动（release/win-unpacked）

`--app=packaged` 让同一脚本驱动 `release/win-unpacked/LittleSheep.exe`（`pnpm run package:win` 产物，未签名）。逐次账本见 [`desktop-cold-start-packaged-2026-09-23.json`](desktop-cold-start-packaged-2026-09-23.json)（重新打包后的 18 次运行：empty / normal 各 3 个样本 × 3 次启动，全部成功并通过 `packagedBudgetsMs`）。

| 指标（ms，中位） | 开发版 empty（n=5） | 打包版 empty 冷（n=3） | 开发版 normal（n=5） | 打包版 normal 冷（n=3） | 打包版 normal 稳态（n=6） |
| --- | ---: | ---: | ---: | ---: | ---: |
| 进程启动 → 主模块加载 | 208.4 | 189.5 | 205.0 | 188.5 | 188.6 |
| 进程启动 → Local App API 就绪文件 | 896.4 | 870.1 | 875.1 | 879.6 | 867.9 |
| 进程启动 → 真实首帧 | 1317.9 | 1196.2 | 1402.1 | 1176.1 | 1145.8 |
| 输入区可输入 | 389.5 | 313.2 | 373.5 | 302.0 | 253.6 |
| 当前会话可读 | — | — | 378.3 | 307.2 | 277.5 |
| 首次可执行 | 1891.1 | 1976.1 | 1771.2 | 1444.5 | 1391.9 |

口径：开发版来自 20 次基线账本，打包版来自重新打包后的账本（每个样本第 1 次为冷启动，第 2–3 次为稳态）。差异多数在样本波动内，**不据此声称打包版更快或更慢**；可确认的是打包版没有量级回退，真实窗口、渲染器首帧与执行就绪三条路径都能走通。安装包（NSIS）实机安装、干净机器首次运行仍未验证。

**打包版视觉也已取证**（`node scripts/verify-desktop-cold-start-visuals.mjs --app=packaged`，结论见 [`screenshots/cold-start-visuals-packaged.json`](screenshots/cold-start-visuals-packaged.json)）：三种宽度、最大化/还原、启动页与启动失败页在打包版里全部通过，截图带 `-packaged` 后缀，不会覆盖开发版证据。**这一步发现并修掉一个只在打包产物里出现的真实缺陷**：启动页没有品牌标记（`hasIcon: false`，中心像素是背景色）——`app-icon.ts` 的候选路径只找 `<resourcesPath>/<file>`，而 electron-builder 把 `packages/app/resources/` 复制到 `<resourcesPath>/resources/`，于是打包后原生窗口图标与启动页图标都取不到；现在候选里补上这一层嵌套目录，并有单测固定（`app-icon.test.ts` 的 "finds the icon in the packaged nested resources directory"）。修复后打包版启动页中心像素为 `#ccbcb0`（图标本身），全部断言通过。

打包版的稳态另有一份早期样本（[`desktop-cold-start-packaged-warm-2026-09-23.json`](desktop-cold-start-packaged-warm-2026-09-23.json)，normal，3 个样本 × 3 次启动，重新打包前的产物）：当时冷启动中位 输入可用 288.5 / 当前会话可读 294.2 / 首次可执行 1456.1 / 首帧 1235.5 ms，稳态 298.4 / 304.9 / 1491.0 / 1247.1 ms，即稳态比那批冷启动慢 10–35 ms，但全部落在 `warmVsColdMs` 余量内，**没有出现"每次启动都重做首次工作"的回退**；bootstrap 资源注册同样是首次落盘（第 1 次 45.7–50.3 ms，之后 12.0–21.2 ms）。该文件保留的是重新打包前的读数，跨文件比较需注意产物差异。真正需要单独看的是**会话内第一次启动**：它读的是冷磁盘，实测出现 输入可用 829.1 / 当前会话可读 835.6 / 首次可执行 2167.8 / 首帧 1524.1 ms 的一次读数（该次账本已被同 label 重跑覆盖，数值记在 `budgets.json` 的 `packagedNote` 里），因此打包版有独立的一组上限（`packagedBudgetsMs`），不与开发版的紧上限混用。

## 首次启动与稳态启动（同一数据根，`--launches`）

`--launches=N` 让脚本对**同一个数据根**连续启动 N 次再进入下一个样本：第 1 次是冷启动，第 2–N 次是同一套安装的稳态启动（首次布局、bootstrap 资源注册、索引落盘都已经发生过）。两类的原始样本、汇总与护栏都分开记录，账本为 [`desktop-cold-start-warm-2026-09-23.json`](desktop-cold-start-warm-2026-09-23.json)（normal / recovery 各 3 个样本 × 3 次启动，`--no-send`）。

| 指标（ms，中位） | normal 冷启动（n=3） | normal 稳态（n=6） | recovery 冷启动（n=3） | recovery 稳态（n=6） |
| --- | ---: | ---: | ---: | ---: |
| 进程启动 → 主模块加载完成 | 198.3 | 200.7 | 196.8 | 202.6 |
| 进程启动 → 真实首帧 | 1082.7 | 1045.6 | 1083.3 | 1079.5 |
| 输入区可输入 | 295.6 | 285.3 | 318.0 | 292.9 |
| 当前会话可读 | 302.0 | 289.8 | 322.8 | 298.3 |
| 首次可执行 | 1291.6 | 1294.5 | 1312.6 | 1297.4 |

结论：**稳态启动在每个指标上等于或略快于冷启动**（normal 输入可用 295.6 → 285.3 ms、当前会话可读 302.0 → 289.8 ms；首次可执行 1291.6 → 1294.5 ms，差异 2.9 ms 落在噪声内），本批 30 项检查（含 10 项 `warm-vs-cold`）全部通过。唯一有量级的差异来自 bootstrap 资源注册：该阶段冷启动 38.8（normal）/ 42.2（recovery）ms，稳态 12.8 / 18.0 ms，因为六条资源登记与账本事务只在首次落盘（`sameResourceRegistration` 忽略时间戳，`commitMutation` 无增删改时提前返回）；durable 存储的扫描则每次都要读自己的目录，冷热一致。这也意味着**基线表里的数字是"首次启动"数字**，真实用户第二次启动会略短。

两处测量修正（都由本批样本发现）：

- `executionReadyMs` 曾依赖"先等到渲染器自报首帧，再开始轮询就绪"。二者改为**并发观测**：渲染器首帧报告有 15 s 等待上限，一旦该报告缺失（本批 18 次里出现 1 次），旧写法会把 15 s 计入"首次可执行"（实测出现 16415.4 ms 的假尖峰，而同一轮的 `execution-ready` 标点距 `runner-ready` 只有 98.5 ms）。修正后缺失会记为 `rendererFrameReported: false`，而不是变成一个巨大的数字。此前两份账本（baseline 20 次、packaged 6 次）没有缺失帧样本，因此历史数字不受影响。
- `budgets.json` 的 `warmVsColdMs` 最初按 profile 解析，实际是**按指标**给出余量；修正前它静默不生效（检查项数为 0）。现在每个 profile 都会产出 `*.warm-vs-cold.*` 检查项。

稳态口径仍有边界：这里只覆盖"同一台机器、同一次会话内连续启动"，不含系统重启后的首次启动、Windows 预读/休眠的影响，也不含打包版与不同缩放。

## 回归护栏（CS-01 第 5 项）

`budgets.json` 保存五个时间点的回归护栏。脚本在输出目录能找到它时按**观测最大值**判定，超出即以非零退出码结束；找不到时只记录基线、不做断言。**冷启动与稳态启动分别**对同一组上限判定，另有 `warmVsColdMs` 约束中位数差：稳态不得比首次启动慢超过该余量，用于发现"每次启动都重做首次工作"这类回退。

| 指标 | 护栏（ms） | 基线观测最大值（ms） | 稳态相对冷启动余量（ms） |
| --- | ---: | ---: | ---: |
| 进程启动 → 主模块加载完成 | 250 | 221 | 60 |
| 进程启动 → 真实首帧 | 1800 | 1435 | 250 |
| 输入区可输入 | 500 | 460 | 150 |
| 当前会话可读 | 550 | 509 | 150 |
| 首次可执行 | 2200 | 2063 | 250 |
| 首次发送准备耗时 | 50 | 37.9 | — |

口径说明：护栏取"基线最大值 ×约 1.3–1.5"并取整到 10 ms，用途是发现明显回退，**不是性能达标线**；n=5 不足以支撑高分位统计，因此脚本用最大值而不是百分位。`spawnToLocatorMs` 不设护栏：基线本身在 640–990 ms 之间波动，该量级内无法区分回退与噪声。打包版使用**独立的一组** `packagedBudgetsMs`（主模块 300 / 首帧 2100 / 输入可用 1100 / 会话可读 1100 / 首次可执行 2900 ms），因为它读的是完整解包树、会话内第一次启动是磁盘冷读；缺少该组时脚本回退到 `budgetsMs`，并在 `assertions.budgetSet` 里标明本次用的哪一组。

护栏对机器负载敏感，这一点必须写进口径：紧接 `pnpm run build:app` 之后的一次 `empty` 单跑出现 主模块 253.2（上限 250）与 首次可执行 2854.2（上限 2200），同一次运行的 `spawnToLocatorMs` 1140.2、首帧 1403.1 也整体偏高；在同一台机器稍后空闲重跑（2 个样本 × 2 次启动）全部通过，主模块 221–238、首次可执行 1509.9–1969.6。**因此护栏应在机器空闲时单独运行，并且不要紧跟构建**；它给出的非零退出码要先按这一条排除环境因素，再当作回退证据。

## 未覆盖与待验收

自动化部分到此为止：所有能由脚本在真实 Electron 里取证的条目都已落地并留下账本（五份证据文件：开发版视觉、打包版视觉、交互、恢复归属、失败态与重试）。以下只能在真实机器上由人完成，做完之前任务书对应复选框保持未勾选、任务书不退役：

- **系统重启后的完全冷启动**：本机所有样本都是热缓存重复，重启后的首次启动（含首次读二进制）无法自动化。
- **125% / 150% / 200% 显示缩放与明暗桌面背景**：需要人工在实机上逐项拍摄。CS-09 的脚本用 `Emulation.setDeviceMetricsOverride` 做了 DPR 1.25 / 1.5 / 2 的**代理**测量（这三档 DPR 下渲染器不溢出、阶段文字不与发送按钮重叠、不出现整窗条带），但代理只改设备像素比，不改窗口的 CSS 像素尺寸、原生标题栏/caption 按钮与字体度量，也不改 acrylic 合成——真实缩放下的观感仍以人眼为准。
- **失焦、最小化状态的观感与启动页→渲染器的交接瞬间**：最小化后窗口不参与截图（脚本只断言 DOM 状态），交接瞬间约 90 ms，需要人眼或高速拍摄。
- **安装包（NSIS）实机安装与干净机器首次运行**：会写系统（安装目录、开始菜单、卸载登记），需要用户授权。
- **真实续接执行**：现有证据到"发现 + 归属"为止；点"继续"会在检查点记录的真实工作区执行工具，需用户在自有数据上确认。
- 逐项改动的成对前后对比尚无稳定的统计功效：在 n=5 下 `executionReadyMs` 的最小–最大区间约 200 ms，小于该区间内的差异不构成证据。
- durable harness 与 bootstrap 文件注册两条路径已分别定论：前者改为并行初始化并取得阶段级净收益（约 14 ms），后者一半是首次注册（稳态不再支付）、另一半是读取与哈希，已明确不再作为优化目标。

## CS-08 右侧拓展工作区的可用性（进行中）

右侧面板"进入即可预览和操作"由 `scripts/measure-workspace-availability.mjs` 度量，指标是渲染器自己上报的两个封闭阶段（`renderer-workspace-entries` = 首个目录行被绘制；`renderer-workspace-preview` = 首个文件正文被绘制；占位与错误状态都不会发布），逐次样本见 [`desktop-workspace-availability-2026-09-24.json`](desktop-workspace-availability-2026-09-24.json)。

2026-09-24 第一次测量就找到阻塞缺陷：渲染器工作区客户端的 URL 模板字符串缺少 `${`，五个请求（`workspaceList`、`workspacePreview`、`workspaceLayout`、`workspaceArtifacts`、`terminalActivity`）实际发往 `http://127.0.0.1:<port>LOCAL_APP_API_ROUTES.…)}`，`fetch` 以 `TypeError: Failed to parse URL` 拒绝。**结果是右侧永远读不到目录与预览**，界面停在"文件夹暂时无法读取，请点击刷新重试。"，而同一路由直接调用返回 200——这类缺陷只在真实渲染器里出现，单测与直接 API 探针都看不到。修复后新增 `workspace-client-paths.test.ts` 断言客户端实际发出的路径。

修复后实测（同一数据根与 profile 的冷启动；账本现含 `warmup`、3 次冷启动、`click-to-preview` 与 `while-not-ready` 四类运行）：

| 指标（进程启动起算，n=3，0 失败） | 最小 / 中位 / 最大 |
| --- | --- |
| 首个目录行可见 | 1194.9 / **1202.0** / 1261.4 ms |
| 恢复的文件内容可见 | 1194.8 / **1201.8** / 1261.7 ms |
| 点击文件 → 预览可见 | 2.8 ms（单次实测，并确认 `renderer-workspace-preview` 标点发布） |
| 执行就绪（对照） | 691.7 / 748.1 / 775.2 ms |

目录与恢复的预览同帧出现，并且都**早于执行就绪**——右侧不等待 Runner。

一处被更正的中途结论：先前两次测量报告"布局恢复不通"，根因在测量脚本本身——预热阶段用强制结束进程收尾，而布局镜像 `<data-root>/workspace/layout.json` 只在**正常退出路径**上刷新，于是被测启动恢复的是更早的"只有审阅"快照。预热改走 `quit` 验收动作后同一构建三次冷启动全部恢复出正文。

Runner **未就绪期间**也已实测（探针的 `while-not-ready` 用例把未就绪窗口拉长到 6 s，并作为同一账本的一类运行留档）：读到目录行与点击文件时 `/runtime/readiness` 均为 `starting`，当时目录 4 行、正文 15210 字符可读（标点 1142.2 / 1142.0 ms），就绪到达后正文仍是 15210 字符——右侧不等待 Runner，也不在就绪交接时复位。同一次运行里 `while-not-ready` 的标点早于冷启动样本的标点，但它复用同一个已预热的数据根，因此只用于"未就绪即可用"这一条，不参与上面的冷启动中位数。

仍未完成：改选目录（系统目录选择对话框无法在无头环境驱动）、浏览器标签在未就绪期间的显式断言；**切换会话与关闭/恢复窗口已实测，并发现一处未修缺陷**（见下）。

### CS-08 补充：会话切换、竞争与窗口隐藏（含一处真实缺陷）

`scripts/verify-desktop-cold-start-interaction.mjs` 的工作区健壮性用例给两份夹具文件各带唯一标记，于是"面包屑说在显示哪个文件"与"正文实际是哪个文件"可以互校——迟到的旧响应覆盖新响应就会在这里露馅。逐项事实见 `screenshots/cold-start-interaction.json` 的 `workspace-preview-robustness` 一步（含 Main 的 `workspace/layout.json` 与渲染器镜像两组视图）：

| 场景 | 结果 |
| --- | --- |
| 就绪后在某会话打开文件 → 切走 → 切回（控制组） | 正文逐字恢复：面板已开、753 字符、标记一致；布局记入 `session:<该会话>=[review+file]` |
| 点第二个文件后立刻切走再切回（竞争） | 面板显示 `notes.md` 且正文是 notes 的标记——新响应胜出，没有串味 |
| 隐藏窗口再显示、以及就绪交接 | 正文一字不变 |
| 其他会话不继承当前文件 | 切过去的会话拿到自己的空桶（`collapsed` + 只有审阅标签），没有旧文件内容，也没有错误横幅、没有启动 run |
| **启动期间打开的文件（缺陷）** | 窗口此时是**草稿**会话，文件被记进 `__draft__=[review+file]`；用户点进任一会话后，启动时被高亮的那一行再点回来时是 `session:<id>=[review]`，**启动时打开的文件不再回来** |

缺陷的性质与不修的理由：启动期草稿布局在用户点进任何会话后没有被并入"当初高亮的那一段会话"，而 `adoptWorkspaceDraftSessionLayout` 只在草稿被赋予**新**会话 id 时迁移。修它先要定一条产品规则（启动期草稿布局该归属哪一段会话，或点进会话时是否应把草稿布局带过去），因此本次只记录、不改行为；该失败项**故意留在红**，失败文案即缺陷描述，不要读成 CS-09 的回归。

## CS-09 正常启动的阶段文字不再横跨整窗

启动提示拆成两个各管一件事的表面，事实仍只有一份（Main 的就绪状态与原因）：

- **正常启动**：`composer-readiness-hint` 把 Main 给的那句话就地显示在 `.composer-right` 里、发送按钮左侧，只在 `state === 'starting'` 出现，就绪即消失；必要时用省略号截断，但有 `7ch` 下限，不允许被压成零宽。渲染器不写自己的等待文案。
- **启动失败**：`runtime-readiness-notice` 独占整窗条带（标题栏下方、`aria-live="assertive"`），原因与 `retryable` 仍由 Main 决定，重试入口 `.runtime-readiness-retry` 不变。

实机取证见 `scripts/verify-desktop-readiness-placement.mjs`（新 npm 脚本 `verify:desktop-readiness-placement`，逐项事实 `cold-start-readiness-placement.json`，截图 `screenshots/readiness-*.png`）：

| 场景（真实窗口） | 观测 |
| --- | --- |
| 正常启动 ×3（1580×900） | 条带从未出现（`stripSeen: false`）；三次附加调试器时都已是 `ready`，因此这一档只证明正常路径没有回退，阶段文字本身的摆放由下一档测量 |
| 故意拉慢启动（仅验收用的就绪延迟 7 s，1580×900） | `/runtime/readiness` = `starting`，阶段文字 = Main 的原因「正在准备运行能力」，位于控制行内、窗口宽度的 **7.5%**，条带为 `null`；发送入口 `disabled` 且 `aria-label` 与原因一致；草稿与焦点保持；右侧预览正文 4398 字符可读 |
| 同一次启动缩到窗口下限 800×660 | 阶段文字 45 px（截断但不为零宽）、与发送按钮**不重叠**、`scrollWidth - innerWidth = 0`，条带仍为 `null`，预览未丢 |
| DPR 1.25 / 1.5 / 2（`Emulation.setDeviceMetricsOverride` 代理） | 无横向溢出、无与发送按钮的重叠、无整窗条带（阶段文字 82 px） |
| 就绪交接后 | 阶段文字与条带都为 `null`，发送入口恢复可用，草稿、焦点与预览都不变 |
| 启动失败（config 指向不存在的 provider） | 条带占满整行（`left/right = 0`，标题栏下方 32–62 px），文案 = Runtime 原因 + 重试入口；阶段文字为 `null` |

`scripts/verify-desktop-cold-start-interaction.mjs` 的同一条契约也已改到新表面并全部通过：加宽窗口内阶段文字在控制行内（宽度占比 0.075）、条带为 `null`、发送禁用、草稿保持；就绪后两个表面都消失。

边界与未覆盖：正常启动的未就绪窗口只有约 300 ms，调试器附加往往已经落在 `ready` 之后，所以"正常启动不长出全局条"由**同一状态的拉长版本**测量，而不是靠抢帧；显示缩放只做了 DPR 代理，而代理**只在设备像素比这一维**上近似真机——窗口的 CSS 像素尺寸、原生标题栏/caption 按钮与字体度量都不会跟着变，所以它证明的是"在这三档 DPR 下渲染无溢出、无重叠、无条带"，不证明真实 125%/150%/200% 缩放下的观感，那一项仍是人工验收。另外两处与本项无关、但在 800 px 窗口下顺带记录的现象：控制行本身已很拥挤（就绪后同样存在），右侧预览列在面板与文件树夹挤下会变成一行一个字——都属既有布局，未在本次改动范围内处理。

## 复现

```bash
pnpm run ensure:app-build
# 冷启动基线（每个样本一个新建数据根）
node scripts/measure-desktop-cold-start.mjs --samples=5 --label=baseline-2026-09-23
# 冷启动 + 稳态（同一数据根连续启动 3 次，并把两条护栏都跑一遍）
node scripts/measure-desktop-cold-start.mjs --profiles=normal,recovery --samples=3 --launches=3 --label=warm-2026-09-23 --no-send
# 打包版（同一脚本驱动 release/win-unpacked；需先 pnpm run package:win）
node scripts/measure-desktop-cold-start.mjs --app=packaged --profiles=normal,empty --samples=3 --launches=3 --label=packaged-2026-09-23 --no-send
# 真实窗口验收（开发版 / 打包版视觉、交互与窗口生命周期、失败态与重试）
pnpm run verify:desktop-cold-start
node scripts/verify-desktop-cold-start-visuals.mjs --app=packaged
pnpm run verify:desktop-cold-start-interaction
pnpm run verify:desktop-cold-start-readiness-failure
# 启动阶段文字的摆放（正常 / 拉慢 / 失败启动，窄窗与 DPR 代理）
pnpm run verify:desktop-readiness-placement
# 恢复归属（需要真实 Provider 凭据；无凭据时脚本跳过并说明原因）
$env:DEEPSEEK_API_KEY = '<credential>'
pnpm run verify:desktop-cold-start-recovery
```
