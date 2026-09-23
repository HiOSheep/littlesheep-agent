# 桌面冷启动体验与加载策略优化任务书 2026-09-23

最后更新：2026-09-23 11:12:00

## 1. 目标与当前状态

目标：统一冷启动页、标题栏和原生窗口按钮的视觉表现，缩短用户等待，并让用户尽早输入、浏览和操作窗口。采用“界面先可用，运行能力分阶段就绪”的策略。

状态：已完成源码检查与任务拆解，尚未实施本任务书中的优化，也未完成真实冷启动测量。下列任务全部待验收，不能据此声称已经提速。

本任务书是桌面启动专项，不替代全局开发顺序。与[应用层 UI / UX 优化任务书](application-ui-ux-taskbook-2026-09-22.md)共享恢复反馈、草稿保护和真实窗口验收要求，避免重复实现。

## 2. 已确认事实与待验证问题

| 项目 | 源码检查结论 | 定位 |
| --- | --- | --- |
| 启动视觉 | 启动页正文采用半透明背景与模糊；原生按钮覆盖区域使用不透明 `#101010`；窗口同时启用 acrylic 材质。背景策略不一致，与截图中的区域割裂相符，最终合成效果仍需实机验证。 | `packages/app/src/main/desktop-startup-page.ts`、`desktop-shell.ts` |
| 界面加载顺序 | 数据准备、记忆迁移检查、Runner、项目/会话/归档索引和 Local App API 初始化后，才加载正式 Renderer。 | `packages/app/src/main/index.ts` |
| 就绪通信 | preload 在加载时读取 `LITTLESHEEP_API_PORT`，未设置时使用 `0`；提前挂载正式界面需要同步改造该契约。 | `packages/app/src/preload/index.ts` |
| 本地 API 依赖 | `startLocalAppApiServer` 当前要求已创建的 Runner，提前提供界面数据不能只调整调用顺序。 | `packages/app/src/main/local-app-api-server.ts` |
| 已有优化 | 插件宿主启动已经异步化；Monaco 核心与语言已有按需加载，不重复建设。 | `main/index.ts`、`renderer/workspace/code-editor.tsx` |
| 已有计时 | `LITTLESHEEP_BOOTSTRAP_TIMING=1` 可启用主进程阶段计时，但“调用显示窗口”不等于真实首帧，尚缺完整交互可用指标。 | `packages/app/src/main/bootstrap-timing.ts` |

待测量：静态模块加载、Runner 内部初始化、索引准备、Renderer 解析与首屏渲染各自占比。不能仅凭串行调用就认定某一模块是主要瓶颈，也不预先承诺提速秒数。

## 3. 体验与实施约束

1. 窗口尽早展示稳定的标题栏、侧栏布局和输入区；输入草稿不依赖 Runner 完成初始化。
2. 会话数据可读后允许浏览；运行环境未就绪时，仅依赖执行能力的操作受限，并显示真实状态。首版不引入隐式排队发送，避免用户不知情地延后执行。
3. 就绪后原地启用能力，不整页刷新、不覆盖输入、不重置焦点、不强制切换用户正在查看的会话。
4. 数据根与记忆迁移、权限校验、持久化一致性仍是相关读写及执行的前置条件；界面提前出现不能绕过这些约束。
5. 保留原生最小化、最大化和关闭按钮及窗口缩放行为。窗口材质变更需实机验证；不为追求透明效果重新引入已知的绘制兼容问题。
6. 后台初始化必须限并发、可取消、可观测。调用异步函数不等于 CPU 工作已经离开主线程。
7. 安全恢复保持静默，需用户介入的事项保留入口。恢复结果归属原会话，不争夺用户当前焦点，也不重复执行已完成操作。
8. 失败、超时和重试状态由 Runtime 提供；不用虚假百分比、固定等待时间或永久加载动画掩盖失败。
9. 优先修改桌面组合根和界面依赖。若涉及 Runner，先证明瓶颈并保持内核行为不变；不得借启动优化重设计 Harness。

## 4. 任务总表

优先级仅表示本专项实施顺序：P0 为基线与视觉基础，P1 为交互和加载路径，P2 为最终回归收口；不覆盖全局正确性问题的优先级。

| 状态 | ID | 优先级 | 任务 | 前置依赖 |
| --- | --- | --- | --- | --- |
| [ ] | CS-01 | P0 | 建立可重复的启动基线 | 无 |
| [ ] | CS-02 | P0 | 统一启动页、标题栏与按钮区域视觉 | 无；使用 CS-01 记录前后表现 |
| [ ] | CS-03 | P1 | 提前呈现可交互界面并建立就绪契约 | CS-01 |
| [ ] | CS-04 | P1 | 缩短首次可执行的关键路径 | CS-01；与 CS-03 对齐能力边界 |
| [ ] | CS-05 | P1 | 减少首屏依赖及后台资源争用 | CS-01；与 CS-03 对齐页面加载 |
| [ ] | CS-06 | P1 | 保护续接、草稿和初始化失败体验 | CS-03；贯穿 CS-04、CS-05 |
| [ ] | CS-07 | P2 | 完成真实 Electron 启动回归与文档收口 | CS-01～CS-06 |

## 5. 可执行任务与验收

### CS-01｜建立可重复的启动基线

- [ ] 记录进程启动、真实首帧、输入区可用、当前会话可读、首次可执行五个时间点，并注明各时钟来源与关联方式。
- [ ] 在已有计时基础上细分主要阶段，覆盖首条主进程业务日志之前的模块加载时间以及 Renderer 首次挂载。
- [ ] 分别测量开发版与打包版；区分进程冷启动、系统重启后的首次启动、重复启动，不把热缓存样本称为完全冷启动。
- [ ] 使用隔离数据覆盖空数据、普通数据量、大历史会话与待恢复任务，记录机器、版本、数据规模、运行次数和耗时分布。
- [ ] 基于基线为五项指标确定验收预算；保留逐次原始数据，样本不足时不声称获得稳定的高分位统计。

验收：能重复定位耗时所在阶段；计时不包含密钥与用户正文；启动画面出现、界面可操作和任务可执行被分别度量。

### CS-02｜统一启动视觉

- [ ] 为启动页、标题栏、原生按钮覆盖区和正式界面交接定义一致的底色、标题栏高度及材质策略，优先验证统一实色方案。
- [ ] 保留小羊品牌元素，使其位置和尺寸不因交接发生明显跳动；避免大范围明暗闪烁。
- [ ] 检查正常、失焦、最大化、还原、最小化恢复以及错误页状态。
- [ ] 在明暗桌面背景和 100% / 125% / 150% / 200% 缩放下截图对比，检查按钮区域接缝、边框和拖动区域。

验收：启动页与按钮区域无明显色块断层；原生窗口行为正常；进入正式界面无白闪、黑闪或明显布局跳变。真实 Electron 截图是完成依据，不能仅以 CSS 或 HTML 测试代替。

### CS-03｜提前呈现可交互界面

- [ ] 拆分轻量界面挂载与完整业务初始化，保留最小失败兜底页。
- [ ] 为界面、数据读取、运行执行定义最少必要的就绪状态与失败状态；避免新增通用调度框架。
- [ ] 改造 preload 的固定端口快照：提供受控状态查询与就绪通知，订阅后可补读当前状态，防止错过通知；卸载时释放订阅。
- [ ] 将仅需本地元数据的读取与 Runner 依赖隔离；迁移期间禁止访问尚不一致的数据。Main 继续校验接口及权限。
- [ ] 等待期间允许草稿输入和窗口操作；就绪后原地启用发送。未就绪时不可向端口 `0` 发请求，不得假报已发送。

验收：慢初始化期间可连续输入，草稿和焦点在就绪交接后保持不变；会话数据按真实就绪状态显示；不通过整页导航实现业务能力启用。

### CS-04｜缩短首次可执行路径

- [ ] 依据 CS-01 列出初始化依赖图，区分执行必需、当前页面必需和非必要维护工作。
- [ ] 检查 Runner 中版本管理、检查点、记忆仓库、恢复队列与 Skill 资源等初始化成本，仅调整测得有收益且依赖允许的部分。
- [ ] 数据迁移、持久化一致性和权限前置检查保持顺序；只对互不依赖的准备工作使用有限并行。
- [ ] 可后移的维护使用单次初始化与共享进行中结果，防止首次访问、后台预热和重试同时启动同一工作。
- [ ] 同时记录首次发送的准备耗时，防止将原有启动等待全部转移到用户点击发送之后。

验收：首次可执行与首次发送指标符合 CS-01 确定的预算；迁移失败不放行执行；无重复初始化、数据库竞争或已结算副作用重放。

### CS-05｜减少首屏依赖与资源争用

- [ ] 测量首屏依赖和解析成本，检查设置页、终端、预览、Git 等静态导入链；未打开的功能按需加载。
- [ ] 保留现有 Monaco 懒加载；加载失败有局部重试，不使整个应用不可用。
- [ ] 优先加载当前会话和可见列表；若引入只读缓存，明确数据归属、失效和更新规则，不复制第二份权威存储。
- [ ] 对后台 I/O 限并发、长列表分批处理；仅在测量确认 CPU 阻塞后引入 Worker 或独立进程。
- [ ] 在后台工作进行时测量输入延迟、滚动及窗口拖动表现；用户关闭应用后及时停止待执行工作。

验收：首屏不等待未使用功能；后台初始化不导致明显输入和窗口卡顿；按需加载不会使首次使用长期无反馈。

### CS-06｜保护续接与故障体验

- [ ] 恢复发现等待所需依赖就绪，再自动处理可安全续接且不需用户输入的检查点。
- [ ] 恢复结果回写原会话；用户已切换会话或开始输入时，不自动抢回页面、不覆盖草稿。
- [ ] 为初始化失败、超时、局部能力失败提供真实状态与有界重试；避免永久停留在品牌页。
- [ ] 重试复用已完成证据，避免重复迁移、重复恢复、重复发送和重复发布回复。
- [ ] 验证启动期间关闭、最小化、重新激活与重试并发，不出现窗口复活、资源泄漏或已销毁窗口访问。

验收：安全恢复不弹出阻断对话框；需介入事项仍可找到；局部故障不破坏已可用的输入和浏览；失败不会被表达为成功。

### CS-07｜真实回归与文档收口

- [ ] 执行打包版与开发版的启动回归，覆盖大历史会话、离线、无模型配置、待恢复任务和迁移失败。
- [ ] 覆盖启动中输入、切换会话、关闭窗口，以及各 DPI、最大化和窗口交接场景。
- [ ] 对涉及就绪竞态、幂等初始化、恢复归属和失败重试的逻辑运行针对性测试，并完成仓库要求的检查。
- [ ] 保存前后耗时、配置、样本量及截图/录像；区分真实改进、样本波动和未验证场景。
- [ ] 修改行为或依赖时同步更新对应 package / 领域 README，并按系统时钟填写更新时间；同一变更提交中包含实现与说明。
- [ ] 完成后将稳定事实归入常驻文档，再按文档生命周期规则退役任务书。

验收：CS-01～CS-06 的证据齐备，真实窗口交互无回归；无法验证的场景保持未勾选并说明缺口，不以单元测试替代实机结论。

## 6. 执行顺序与记录方式

建议分三批：第一批完成 CS-01、CS-02；第二批完成 CS-03 并同步落实 CS-06 的交互保护；第三批根据测量执行 CS-04、CS-05，最后完成 CS-07。

每项完成时填写：改动文件、前后测量、验证环境、测试及实机证据、剩余缺口。实现完成但尚未实机验证时记录为“实现完成，待验收”，复选框保持未勾选。

方法参考：[Electron 官方性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)。其测量、延迟非必要初始化和避免阻塞主线程的建议用于指导实验，不替代本项目的实际测量。

## 7. 验收记录

最后更新：2026-09-23 11:12:00

### CS-01｜建立可重复的启动基线 —— 实现完成，部分待验收

- 改动文件：`scripts/measure-desktop-cold-start.mjs`（新）、`scripts/lib/electron-cdp-harness.mjs`（新，从 `verify-workspace-performance.mjs` 抽出共用）、`packages/app/src/main/bootstrap-timing.ts`、`packages/app/src/main/desktop-shell.ts`、`packages/app/src/renderer/main.tsx`、`packages/app/src/renderer/runtime-readiness/renderer-timing.ts`（新）、`packages/app/src/shared/runtime-readiness-ipc.ts`、`scripts/verify-workspace-performance.mjs`（改为复用公共库）。
- 五个时间点与时钟来源：见[桌面冷启动基线 2026-09-23](../reference/cold-start-baseline/README.md)。`spawnToMainModuleMs` 用子进程 `process.uptime()`——实测发现 Electron 的 `process.getCreationTime()` 不在同一时间轴（会把 195ms 记成 304ms），因此明确禁用。
- 前后测量：无对照版本；本次是当前实现的首个基线（20/20 成功，empty/normal/large/recovery 各 5 次），中位数与区间已记入上述基线文档与机器可读账本。
- 验证环境：win32 x64 / Windows 10.0.26200 / AMD Ryzen 9 7945HX / Electron 36.9.5 / 开发版构建（`packages/app/out`）。
- 测试及实机证据：真实 Electron 进程逐次采样；主进程阶段计时与渲染器自报首帧互相交叉校验。
- 剩余缺口：未覆盖系统重启后的完全冷启动、打包版样本与更高样本量；**未**据此声称稳定的高分位统计。第 5 项“为五项指标确定验收预算”仍待基于更多样本决定。

### CS-02｜统一启动视觉 —— 实现完成，待实机截图验收

- 改动文件：`packages/app/src/main/desktop-startup-page.ts`、`packages/app/src/main/desktop-shell.ts`、`desktop-startup-page.test.ts`、`desktop-shell.test.ts`、`packages/app/src/renderer/chat-layout-stability.test.ts`。
- 做法：启动页、`titleBarOverlay` 与渲染器 `.window-titlebar` 统一为不透明 `#101010`（共享常量 `DESKTOP_STARTUP_SURFACE` / `DESKTOP_TITLEBAR_HEIGHT`）；移除启动页的 `backdrop-filter` 与半透明 `rgba(16,16,16,0.72)`；移除叠在原生按钮区上的 `backgroundMaterial: 'acrylic'`。原生最小化/最大化/关闭/缩放/厚边框/阴影/圆角保持不变。
- 验证环境与证据：源码级断言已更新并通过；真实 Electron 启动可正常显示与拖动。
- 剩余缺口：**明暗桌面背景 × 100%/125%/150%/200% 缩放的截图对比、失焦/最大化/还原/最小化恢复/错误页状态尚未逐项拍摄**；CS-02 的复选框因此保持未勾选。

### CS-03｜提前呈现可交互界面 —— 实现完成，部分待验收

- 改动文件：`packages/app/src/main/index.ts`、`runtime-readiness.ts`（新）、`plugin-host-startup.ts`（新）、`local-app-api-server.ts`、`local-app-api/*`（`contracts.ts`、`http.ts`、`run-lifecycle-routes.ts`、`session-routes.ts`、`project-routes.ts`、`runtime-routes.ts`、`workspace-routes.ts`、`memory-routes.ts`、`run-routes.ts`、`run-checkpoint-routes.ts`、`provider-calibration-route.ts`）、`packages/app/src/preload/index.ts`、`packages/app/src/renderer/api/*`、`packages/app/src/renderer/App.tsx`、`packages/app/src/renderer/runtime-readiness/*`（新）、`packages/app/src/shared/runtime-readiness-{contracts,ipc}.ts`（新）。
- 做法：启动拆为三段（数据前置 → UI 索引与监听 → Runner 与就绪发布）；Local App API 在 Runner 之前监听，仅 Runner 依赖路由以 503 `runtime-not-ready` 失败关闭；preload 提供 `localApiBase()` / `getRuntimeReadiness()` / `onRuntimeReadiness()`，渲染器侧统一经 `localApiFetch` 在就绪前等待端口。
- 证据：真实 Electron 探针确认未就绪时 `/runtime/readiness`、`/sessions`、`/projects`、`/runtime`、`/application/acceptance` 均 200，`/state`、`/run`、`/run-checkpoints` 为 503，就绪后全部 200；`local-app-api-readiness.test.ts` 覆盖同一契约。
- 剩余缺口：慢初始化期间“连续输入、草稿与焦点在交接后不变”尚未做逐帧实机验证；“未就绪时不假报已发送”由 transport 等待与错误回灌路径保证，但未在真实 Provider 缺失场景下截图复现。

### CS-06｜保护续接与故障体验 —— 部分实现

- 已实现：启动恢复等执行就绪后才做检查点发现（`use-checkpoint-recovery.ts` + `runtime-readiness-state.ts`）；就绪状态经 `RuntimeReadinessNotice` 呈现真实阶段与原因，失败态可区分；`readiness.fail()` 带可重试标记。
- 验收记录：主进程与渲染器测试通过；恢复结果归属与“不抢焦点/不覆盖草稿”沿用既有实现，本轮未改动其归属逻辑。
- 剩余缺口：初始化失败/超时的有界重试入口、启动期间关闭/最小化/重新激活/重试并发的实机场景未验证。

### CS-04 / CS-05 / CS-07 —— 未实施

- 依据本次基线：执行准备（`startExecution` 内约 400 ms）是首个可执行时间的决定项，UI 索引与会话规模不是瓶颈；主模块求值约 205 ms，是首帧前固定开销的全部来源。
- CS-04 的下一步是拆分 `startExecution` 并测量 Runner 构建各段成本，且必须先证明收益、保持迁移与一致性顺序；CS-05 的下一步是先做静态导入链测量再决定是否拆包——现已试做的插件包延迟导入实测落在噪声内（199–220 ms vs 197–216 ms），**不作为提速结论**。
- CS-07 的截图矩阵、打包版回归与文档收口待前两项有了可对照的改动后再执行。

### CS-07 前置观察（不属于本专项改动）

`pnpm run verify:electron-ui-state-continuity` 当前失败，断言为 `bounded tool activity was not observable`。已在本次改动之前的提交 `df66ed9` 上复现同一失败（同一环境、重新构建后再跑），因此**不是**本专项引入的回归。该失败的实际含义是：真实 Electron 下该脚本没能在最近一轮渲染出 `glob` 工具行，需要独立排查（脚本期望、模型回合或渲染时序），不属于冷启动任务书范围，此处只记录事实，不据此判定本专项通过或失败。

### 文档同步

- 更新：`packages/app/README.md`、`packages/app/src/main/README.md`、`packages/app/src/preload/README.md`、`packages/app/src/renderer/README.md`、`packages/app/src/renderer/api/README.md`、`packages/app/src/renderer/app-shell/README.md`、`packages/app/src/renderer/runtime-recovery/README.md`、`packages/app/src/renderer/runtime-readiness/README.md`（新）、`packages/app/src/main/local-app-api/README.md`、`packages/app/src/shared/README.md`。
- 新增常驻参考：[桌面冷启动基线 2026-09-23](../reference/cold-start-baseline/README.md)，并由 `docs/README.md` 收录。

