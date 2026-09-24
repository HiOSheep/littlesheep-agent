# 桌面冷启动体验与加载策略优化任务书 2026-09-23

最后更新：2026-09-24 19:30:33

## 1. 目标与当前状态

目标：统一冷启动页、标题栏和原生窗口按钮的视觉表现，缩短用户等待，并让用户尽早输入、浏览和操作窗口。采用“界面先可用，运行能力分阶段就绪”的策略。

状态：阶段计时、Runner 就绪前挂载界面、就绪门和部分实机验收已有记录，详见本文件后部及[冷启动基线](../reference/cold-start-baseline/README.md)。2026-09-24 的真实数据复现表明：窗口先出现，但历史事件全量校验和旧任务恢复阻塞执行能力，且 Local App API 曾在每个请求前等待 RunRouter，导致会话切换、发送与右侧工作区都显得不可用。当前已实现路由隔离、按分区验证与后台兼容恢复，以及按选中会话加载；这些改动仍需完整真实窗口回归，不能仅凭构建和单元测试勾选 CS-07。

本任务书是桌面启动专项，不替代全局开发顺序。与[应用层 UI / UX 优化任务书](application-ui-ux-taskbook-2026-09-22.md)共享恢复反馈、草稿保护和真实窗口验收要求，避免重复实现。

## 2. 已确认事实与待验证问题

| 项目 | 源码检查结论 | 定位 |
| --- | --- | --- |
| 启动视觉 | 启动页和原生按钮覆盖区已统一为实色 `#101010`；正式界面正常准备时仍在标题栏下方显示横跨整窗的提示。 | `packages/app/src/main/desktop-startup-page.ts`、`desktop-shell.ts`、`renderer/styles/11-runtime-readiness.css` |
| 界面加载顺序 | 当前先显示独立启动页；数据根、记忆迁移、UI 索引与 Local App API 就绪后才加载正式 Renderer，Runner 之后才允许执行。右侧真正读取文件还须等待界面挂载、路径和目录/预览请求。 | `packages/app/src/main/index.ts` |
| 右侧能力加载 | 文件树和预览路由不依赖 Runner，但默认根路径取自 `/runtime`；组件随后恢复会话布局、请求目录或文件。必须度量“文件内容可见且可操作”的时间，不能用“面板已绘制”代替。 | `packages/app/src/renderer/workspace/use-workspace-layout-controller.ts`、`use-workspace-session-layouts.ts`、`packages/app/src/main/local-app-api/workspace-routes.ts` |
| 就绪通信 | preload 已提供动态本地接口地址和执行就绪通知；渲染器请求在监听端口可用前等待，不发送到端口 `0`。 | `packages/app/src/preload/index.ts`、`renderer/api/common.ts` |
| 本地 API 依赖 | Local App API 已可在 Runner 之前监听；工作区目录和文件预览使用配置及文件服务，Runner 依赖路由继续返回 503。 | `packages/app/src/main/local-app-api-server.ts`、`local-app-api/workspace-routes.ts` |
| 已有优化 | 插件宿主启动已经异步化；Monaco 核心与语言已有按需加载，不重复建设。 | `main/index.ts`、`renderer/workspace/code-editor.tsx` |
| 已有计时 | `LITTLESHEEP_BOOTSTRAP_TIMING=1` 已用于主进程、Runner 与 Renderer 首帧计时；现有基线没有“右侧首个目录条目”和“首个文件内容可见”两个指标。 | `packages/app/src/main/bootstrap-timing.ts`、`docs/reference/cold-start-baseline/` |

已有各启动阶段的实测拆解见[基线](../reference/cold-start-baseline/README.md)；新增重点是从进程启动到右侧真实可用的时间与失败路径。不能仅凭右侧壳体出现就认定已经可用，也不预先承诺提速秒数。

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

优先级仅表示本专项实施顺序：P0 为当前阻碍直接使用的体验与其基线，P1 为后续路径优化，P2 为最终回归收口；不覆盖全局正确性问题的优先级。以下复选框只有在所列真实窗口验收全部完成后才勾选，后部记录中的“实现完成”不等于验收完成。

| 状态 | ID | 优先级 | 任务 | 前置依赖 |
| --- | --- | --- | --- | --- |
| [ ] | CS-08 | P0 | 右侧拓展工作区进入即能预览和操作 | CS-01、CS-03；与 CS-07 共用实机验收 |
| [ ] | CS-09 | P0 | 正常加载信息不占据整窗顶部 | CS-02、CS-03；失败状态保留全局可见 |
| [ ] | CS-01 | P0 | 建立可重复的启动基线 | 无 |
| [ ] | CS-02 | P0 | 统一启动页、标题栏与按钮区域视觉 | 无；使用 CS-01 记录前后表现 |
| [ ] | CS-03 | P1 | 提前呈现可交互界面并建立就绪契约 | CS-01 |
| [ ] | CS-04 | P1 | 缩短首次可执行的关键路径 | CS-01；与 CS-03 对齐能力边界 |
| [ ] | CS-05 | P1 | 减少首屏依赖及后台资源争用 | CS-01；与 CS-03 对齐页面加载 |
| [ ] | CS-06 | P1 | 保护续接、草稿和初始化失败体验 | CS-03；贯穿 CS-04、CS-05 |
| [ ] | CS-07 | P2 | 完成真实 Electron 启动回归与文档收口 | CS-01～CS-06 |
| [ ] | CS-10 | P0 | 按选中会话加载与后台续载；新会话直接进入输入 | CS-03、CS-04；需真实窗口快速切换验收 |

### 2026-09-24 故障复现与修复进度

- 真实数据目录约有 399 个事件分区、13,769 个事件文件。修改前两次执行就绪分别约 55.7 秒与 84.5 秒；会话与 Runtime 请求在恢复期间一起超时。该样本只说明当前机器/当前数据根的瓶颈，不代表稳定分位数。
- 已在代码中拆开 Local App API 请求入口与 RunRouter 恢复；会话索引、Runtime 和工作区请求在恢复期立即应答，Run/Checkpoint 在路由未就绪时明确返回 503。真实数据下相关轻量接口约 1 秒已可用。
- 已将旧事件分区扫描改为后台兼容恢复；现代租约与收件箱中的待恢复任务仍在执行就绪前处理。事件分区在被读写或后台扫描时严格校验，损坏不能被当作成功恢复。
- 已实现会话列表只读索引、选中才加载首屏历史；切换离开不取消已开始的读取，内存缓存至多保留 6 个会话，更新后按会话时间戳失效；新会话不依赖旧历史。会话切换不再为旧工作区改写全局默认配置并重建 Runner。
- 2026-09-24 最新 Runner + App 构建在同一真实数据根的一次重复启动：Renderer 首帧约 1.30 秒、工作区目录条目约 1.17 秒、执行就绪约 5.67 秒；两段已存在会话的首屏历史接口分别约 29/34 毫秒。一次新会话真实模型发送返回 HTTP 200、状态 `ok`、有回复，约 4.68 秒，测试会话随后清理。相较修复前 55.7/84.5 秒的执行就绪有明显改善，但这些是少量重复启动样本，不能称为系统重启后的冷缓存分位数。
- 切换项目会话只覆盖当前视图的工作区；切回独立会话或新建会话恢复持久化默认工作区，避免发送落到上一项目。未选中会话不读取历史，已选中后切走的首屏读取继续在后台完成，返回时复用；相关竞争与失效由单元测试覆盖。最新真实窗口交互脚本 0 失败，覆盖未就绪时切换、文件/浏览器预览、草稿与焦点保持及就绪交接；但尚未在真实窗口量化缓存复用与后台扫描结束后的长时交互，安装包也未复验，CS-10/CS-07 暂不勾选。

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

验收：CS-01～CS-06、CS-08、CS-09 的证据齐备，真实窗口交互无回归；无法验证的场景保持未勾选并说明缺口，不以单元测试替代实机结论。

### CS-08｜右侧拓展工作区进入即能预览和操作

- [ ] 为“右侧真正可用”建立独立指标：进程启动 → 首个目录条目出现、进程启动 → 恢复的文件内容可见、点击文件 → 预览内容可见。由真实 Renderer DOM 与成功的 Local App API 响应共同确认，不把壳体绘制或请求发出当作完成。
- [ ] 在保留默认工作区、最近文件标签、展开目录和普通会话布局的隔离数据根中实测。分别覆盖首次启动和同一数据根的后续启动；记录目录规模、文件类型与预览大小。
- [ ] 检查 `runtime` 初值为空、默认根路径恢复、布局镜像读取、目录预热和文件预览请求的时间顺序。只有测得的关键等待才进一步调整，保持 Main 对当前真实根路径和目标路径的校验。
- [ ] 验证 Runner 尚未就绪时，目录、普通文件预览与浏览器标签能使用；发送和 Runner 依赖动作仍由原有就绪门管理。终端、Git、产物等各自依赖另列，不把“右侧已可用”泛化为全部功能已就绪。
- [ ] 验证启动中点击文件、切换会话、选择新目录、关闭/恢复窗口均不会把预览复位到空白，也不会把旧请求结果写进新会话。

验收：用户进入右侧后可以看到真实目录与文件内容并执行只读浏览；正常路径不等待 Runner，失效路径给出局部可恢复状态。前后耗时应配对测量并记录原始证据；未完成此项实机验收前不得声称“右侧即刻可用”。

### CS-09｜收敛正常启动提示的视觉占用

- [ ] 正常启动的阶段文字只在发送能力相关位置就近显示，不在标题栏下方横跨整窗；状态由 Main 的真实就绪事实提供。
- [ ] 启动失败和可重试状态保持明显可见；重试预算与失败原因仍由 Main 决定。
- [ ] 在正常、故意拉慢和故障启动中实拍，检查输入区焦点、草稿、右侧预览、窄窗和高缩放下的布局。

验收：正常启动没有占据视野的全局加载条；用户仍能理解何时可以发送；失败状态可见、可按既有规则重试。

### CS-10｜按选中会话加载与后台续载

- [ ] 未选中会话不读取首屏历史；只有选中后才发起该会话的读取，读取属于该会话本身——切走不取消，切回可复用进行中或已完成的结果；缓存按会话时间戳校验、总数有界（当前最多 6 个会话，消息条数仍受 `SESSION_HISTORY_MEMORY_MAX` 约束），陈旧响应不得写进当前视图。
- [ ] 新会话不依赖任何旧历史：新建会话直接进入可输入状态，首屏为空而不是上一段会话的内容，草稿与焦点不被抢占。
- [ ] 会话选择只改变**当前视图的有效工作区**与本次 run 的请求工作区，不得因此改写全局默认工作目录或重建 Runner；切回独立/新建会话恢复持久化默认工作区，避免发送落到上一项目。
- [ ] Local App API 的请求入口与 RunRouter 恢复解耦：元数据、Runtime、会话索引与工作区路由在恢复期立即应答；`/run`、`/run-stream`、`/run-checkpoints`（含子路径）、审批与应用生命周期在路由未就绪时明确返回 503，不静默排队、不假装成功。
- [ ] 历史事件分区扫描不阻塞执行就绪：现代租约与收件箱中需要恢复的工作仍在就绪前处理，历史分区只作后台兼容扫描；分区在被读写或扫描时严格校验，损坏分区必须报错，不能被当成"没有待恢复工作"。
- [ ] 在保留大量历史事件分区的真实或合成数据根上做真实窗口回归，记录进程启动 → 首帧、→ 工作区目录条目、→ 执行就绪，所选会话首屏历史的应答耗时与缓存复用；覆盖快速连续切换、后台扫描结束后继续交互，以及打包版复验。

验收：大历史数据根下执行就绪不再以分钟计，且恢复期间用户仍能切换会话并使用右侧工作区；按选中会话加载不产生跨会话串味或陈旧内容。耗时结论必须附数据根规模、样本量与原始账本；没有账本时只陈述观察值，不称分位数。

## 6. 执行顺序与记录方式

当前优先处理 **CS-10**（大历史数据根下的量化回归与账本）与 **CS-07**（打包版真实窗口与异常路径收口）；CS-08、CS-09 的自动化部分已完成并取证，剩余项都是人工或需真机条件，见下方验收记录。CS-04、CS-05 只在测得实际瓶颈时继续，并用 CS-01 的计时方法配对比较。此前 CS-02、CS-03、CS-06 已有实现及部分证据，剩余项目见下方验收记录。

每项完成时填写：改动文件、前后测量、验证环境、测试及实机证据、剩余缺口。实现完成但尚未实机验证时记录为“实现完成，待验收”，复选框保持未勾选。

方法参考：[Electron 官方性能指南](https://www.electronjs.org/docs/latest/tutorial/performance)强调测量、延迟非必要初始化和避免阻塞主线程；[DeepSeek Harness 桌面端](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)在后端启动前加载打包 Web 入口，[VS Code](https://code.visualstudio.com/api/advanced-topics/extension-host)按使用时机激活非首屏能力。参考的是依赖分层与就绪契约，不能把别的产品仍在使用的全屏加载页当作本产品的体验目标。

## 7. 验收记录

最后更新：2026-09-24 19:30:33

### CS-01｜建立可重复的启动基线 —— 实现完成，部分待验收

- 改动文件：`scripts/measure-desktop-cold-start.mjs`（新）、`scripts/lib/electron-cdp-harness.mjs`（新，从 `verify-workspace-performance.mjs` 抽出共用）、`packages/app/src/main/bootstrap-timing.ts`、`packages/app/src/main/desktop-shell.ts`、`packages/app/src/renderer/main.tsx`、`packages/app/src/renderer/runtime-readiness/renderer-timing.ts`（新）、`packages/app/src/shared/runtime-readiness-ipc.ts`、`scripts/verify-workspace-performance.mjs`（改为复用公共库）。
- 五个时间点与时钟来源：见[桌面冷启动基线 2026-09-23](../reference/cold-start-baseline/README.md)。`spawnToMainModuleMs` 用子进程 `process.uptime()`——实测发现 Electron 的 `process.getCreationTime()` 不在同一时间轴（会把 195ms 记成 304ms），因此明确禁用。
- 前后测量：无对照版本；本次是当前实现的首个基线（20/20 成功，empty/normal/large/recovery 各 5 次），中位数与区间已记入上述基线文档与机器可读账本。
- 验证环境：win32 x64 / Windows 10.0.26200 / AMD Ryzen 9 7945HX / Electron 36.9.5 / 开发版构建（`packages/app/out`）。
- 测试及实机证据：真实 Electron 进程逐次采样；主进程阶段计时与渲染器自报首帧互相交叉校验。
- 剩余缺口：未覆盖系统重启后的完全冷启动、打包版样本与更高样本量；**未**据此声称稳定的高分位统计。
- 第 5 项验收预算已确定：`docs/reference/cold-start-baseline/budgets.json` 保存五个时间点的回归护栏，脚本在输出目录找到它时按观测最大值判定并给出非零退出码；口径与来源见基线文档的"回归护栏"一节。护栏是回退报警线，不是性能达标线。
- 第 5 项补充：预算现在同时约束**冷启动**（每次样本的第 1 次启动）与**稳态启动**（`--launches` 的第 2 次及以后），并新增 `warmVsColdMs` 中位数差护栏（稳态不得比首次启动慢超过余量）。稳态基线见[基线文档的对应一节](../reference/cold-start-baseline/README.md)，账本 `desktop-cold-start-warm-2026-09-23.json`（18 次启动，30 项检查全部通过）：normal 输入可用 295.6 → 285.3 ms、当前会话可读 302.0 → 289.8 ms、首次可执行 1291.6 → 1294.5 ms（差异落在噪声内）；bootstrap 资源注册冷启动 38.8 / 42.2 ms、稳态 12.8 / 18.0 ms。
- 本批同时修正两处测量缺陷：①`executionReadyMs` 原先等完渲染器首帧报告（15 s 上限）才开始轮询就绪，报告缺失时会把它记成"首次可执行"的一部分（实测出现 16415.4 ms 假尖峰，而同一轮 `execution-ready` 距 `runner-ready` 仅 98.5 ms），现改为并发观测并把缺失记为 `rendererFrameReported: false`；②`warmVsColdMs` 原先按 profile 解析导致静默不生效（检查项数为 0），现按指标解析并逐 profile 产出检查项。两份历史账本没有缺失帧样本，故不受 ① 影响。
- 护栏的环境敏感性也已记录：紧接 `build:app` 的一次 `empty` 单跑触发 主模块 253.2（上限 250）与 首次可执行 2854.2（上限 2200），同轮 `spawnToLocatorMs`/首帧同样偏高；稍后空闲重跑（2×2 次）全部通过（主模块 221–238、首次可执行 1509.9–1969.6）。结论已写入基线文档：护栏应在机器空闲时单独运行、不要紧跟构建，非零退出码先排除环境因素再当回退证据。

### CS-02｜统一启动视觉 —— 实现完成，实机证据已采一部分

- 改动文件：`packages/app/src/main/desktop-startup-page.ts`、`packages/app/src/main/desktop-shell.ts`、`desktop-startup-page.test.ts`、`desktop-shell.test.ts`、`packages/app/src/renderer/chat-layout-stability.test.ts`。
- 做法：启动页、`titleBarOverlay` 与渲染器 `.window-titlebar` 统一为不透明 `#101010`（共享常量 `DESKTOP_STARTUP_SURFACE` / `DESKTOP_TITLEBAR_HEIGHT`）；移除启动页的 `backdrop-filter` 与半透明 `rgba(16,16,16,0.72)`；移除叠在原生按钮区上的 `backgroundMaterial: 'acrylic'`。原生最小化/最大化/关闭/缩放/厚边框/阴影/圆角保持不变。
- 新增实机证据：`scripts/verify-desktop-cold-start-visuals.mjs`（`pnpm run verify:desktop-cold-start`）在三种窗口宽度下逐像素核对渲染器标题栏、标题栏右段与背景为同一实色且下方 60 CSS px 无断层；原生覆盖区与窗口背景的 `#101010` 由验收快照的 `visual` 字段核对；截图见 `docs/reference/cold-start-baseline/screenshots/`。
- 启动失败页也已取证：该页无法靠等待到达，脚本改用 `/application/acceptance` 的 `startup-error` 动作（`desktop-visual-acceptance.ts` 的 `showStartupErrorPageForAcceptance`，只在 `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` 时挂载）把真实失败文案交给生产同一份 `showStartupError` 文档，再截图 `screenshots/startup-error.png`。实测标题栏行、左侧竖向通道整列、右侧同高度通道都是 `#101010`，错误卡片与表面合成后为 `#090909`，屏幕上确实是传入的文案；三条断言已进入脚本门禁。
- 启动页本身也已取证：同一入口的 `startup-page` 动作让窗口重新加载生产同一份启动文档并截图 `screenshots/startup-page.png`（`loadStartupPage` 的同一个模板，异步加载用一个同步断言`.startup-icon` 与无错误卡片来确认文档确实是启动页）。实测标题栏行与左右通道都是 `#101010`、通道整列单色、品牌图标在位、无错误卡片；三条断言已进入脚本门禁。**边界**：这证明启动页的外观，不证明它停留的约 90 ms，因此交接瞬间仍留在未核验清单里，复选框不因它而勾选。
- 最大化与还原也已自动化（新增 `/application/acceptance` 的 `maximize` 动作 + `setWindowMaximizedForAcceptance`）：最大化后 1920×1032、还原回 1580×900，两态都满足"标题栏整行与背景同色、标题栏下方无断层"，并断言两态尺寸确实不同，避免把空操作当通过；截图 `renderer-maximized.png` / `renderer-restored.png`。
- **打包版视觉也已取证**（`node scripts/verify-desktop-cold-start-visuals.mjs --app=packaged`，结论 `screenshots/cold-start-visuals-packaged.json`，截图带 `-packaged` 后缀）：三种宽度、最大化/还原、启动页与启动失败页在打包产物里全部通过。该步发现并修掉一个**只在打包产物里出现**的真实缺陷：启动页没有品牌标记（`hasIcon: false`，中心像素是背景色）——`app-icon.ts` 的候选路径只找 `<resourcesPath>/<file>`，而 electron-builder 把 `packages/app/resources/` 放到 `<resourcesPath>/resources/`，因此打包后原生窗口图标与启动页图标都取不到；现在候选里补上这一层嵌套目录，并有单测固定（`app-icon.test.ts` "finds the icon in the packaged nested resources directory"）。修复后打包版启动页中心像素为图标本身（`#ccbcb0`），全部断言通过。
- 剩余缺口：启动页到渲染器的交接瞬间（文档像素已覆盖，时序未覆盖）、失焦与最小化（最小化不参与截图、失焦只改原生按钮激活态，两者需人眼确认）、125%/150%/200% 缩放、明暗桌面。**因此 CS-02 复选框保持未勾选。**

### CS-03｜提前呈现可交互界面 —— 实现完成，部分待验收

- 改动文件：`packages/app/src/main/index.ts`、`runtime-readiness.ts`（新）、`plugin-host-startup.ts`（新）、`local-app-api-server.ts`、`local-app-api/*`（`contracts.ts`、`http.ts`、`run-lifecycle-routes.ts`、`session-routes.ts`、`project-routes.ts`、`runtime-routes.ts`、`workspace-routes.ts`、`memory-routes.ts`、`run-routes.ts`、`run-checkpoint-routes.ts`、`provider-calibration-route.ts`）、`packages/app/src/preload/index.ts`、`packages/app/src/renderer/api/*`、`packages/app/src/renderer/App.tsx`、`packages/app/src/renderer/runtime-readiness/*`（新）、`packages/app/src/shared/runtime-readiness-{contracts,ipc}.ts`（新）。
- 做法：启动拆为三段（数据前置 → UI 索引与监听 → Runner 与就绪发布）；Local App API 在 Runner 之前监听，仅 Runner 依赖路由以 503 `runtime-not-ready` 失败关闭；preload 提供 `localApiBase()` / `getRuntimeReadiness()` / `onRuntimeReadiness()`，渲染器侧统一经 `localApiFetch` 在就绪前等待端口。
- 证据：真实 Electron 探针确认未就绪时 `/runtime/readiness`、`/sessions`、`/projects`、`/runtime`、`/application/acceptance` 均 200，`/state`、`/run`、`/run-checkpoints` 为 503，就绪后全部 200；`local-app-api-readiness.test.ts` 覆盖同一契约。
- 新增交互实机证据：`scripts/verify-desktop-cold-start-interaction.mjs` 在真实窗口上确认——未就绪期间可输入草稿且焦点留在输入框、**发送入口被禁用**、按 Enter 不会被当成已发送；就绪后草稿/焦点/`#root`/`location` 均不变、就绪提示消失、发送入口原地启用。逐项观察见 `docs/reference/cold-start-baseline/screenshots/cold-start-interaction.json`。
- 该验证同时发现并修掉两个真实回归：①发送按钮原先只判断草稿是否为空，未就绪时仍可点击；现在它由 Runtime 的就绪事实直接禁用，入口文案使用同一真实原因（`composer-view.tsx` + `control-surface-style.test.ts`）。②在未就绪窗口里打开另一段对话会显示 `加载历史失败: Local app API error: 503`（历史由 Runner 提供，未发布时本就该 503，却被渲染成失败横幅，与"窗口刻意可交互"矛盾）；现在 `switchSession` 取历史前先 `await waitForExecutionReady()`（`runtime-readiness-state.ts` 新增；就绪未知时立即返回，不影响单测与非 Electron 宿主），等待期间消息区保持加载态，真正 `failed` 时给出 Runtime 的原因。单元测试：`runtime-readiness-state.test.ts`（4 例，覆盖未知/已就绪/已失败/超时/转移）+ `session-actions.test.ts` 两例（先等就绪再取历史、失败态不报"加载历史失败"）。
- 恢复门的一次实测尝试：把真实检查点文件复制进隔离数据根后，未配置模型时执行能力为 `failed`，因此启动发现按设计**不执行**（`/run-checkpoints` 仍返回 503，界面无恢复入口、无自动弹窗）。这确认了"发现等依赖就绪"的失败路径，但**无法**验证"就绪后发现并归属原会话"。
- 故意拉慢的初始化现已覆盖（新增仅验收使用的 `LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS`，`desktop-acceptance-actions.ts` 读取并**上限 60 s**，`index.ts` 在发布就绪前 `await`，生效时打出 `acceptance-ready-delay` 阶段标）：正常启动的未就绪窗口只有约 300 ms，短到无法在其中输入并读提示，因此交互脚本要求应用**推迟发布**就绪——Runner 照常构建，被拉长的只是渲染器看到的窗口，不是伪造的慢启动或失败启动。最近一次运行窗口 **7.8 s**（要求 ≥ 6 s），在这段窗口内实测：就绪提示可见且文案为 Runtime 自己的「正在准备运行能力」、同一时刻发送入口仍 `disabled`、草稿仍在输入框、`/runtime/readiness` 仍为 `starting`、按 Enter 未被当成已发送且无错误横幅；就绪后草稿/焦点/页面均不变、提示消失。脚本会断言窗口确实还开着，否则该批证据判为无效。
- 未就绪期间的会话切换也已覆盖：在加宽窗口内 `会话 0 → 会话 1 → 会话 0` 往返成功，草稿全程仍在输入框、无错误横幅、未启动 run、`/runtime/readiness` 全程 `starting`，就绪后仍无错误横幅；草稿实际行为（单一文本槽，往返后仍在）如实记录为 `draftSurvivedSwitch`。
- 剩余缺口：需要活跃任务才可达的隐藏/恢复周期（关闭到后台只在有活跃任务时发生）。

### CS-06｜保护续接与故障体验 —— 实现完成，恢复归属已实机取证

- 已实现：启动恢复等执行就绪后才做检查点发现（`use-checkpoint-recovery.ts` + `runtime-readiness-state.ts`）；就绪状态经 `RuntimeReadinessNotice` 呈现真实阶段与原因，失败态可区分；`readiness.fail()` 带可重试标记。
- 验收记录：主进程与渲染器测试通过；恢复结果归属与“不抢焦点/不覆盖草稿”沿用既有实现，本轮未改动其归属逻辑。
- **恢复归属已实机取证**（新增 `scripts/verify-desktop-cold-start-recovery.mjs` + `pnpm run verify:desktop-cold-start-recovery`，逐项事实见 `docs/reference/cold-start-baseline/cold-start-recovery.json`）：用真实 Provider 凭据（环境变量透传，凭据不落盘）让执行真正到 `ready`，再把两个**真实**检查点文件（来自不同会话）复制进隔离数据根。实测：`/run-checkpoints` 返回 200 且两个检查点各自保留自己的 `sessionId`；界面入口显示「待恢复任务 2」，草稿与焦点不动、**未启动任何 run**；对话框列出两项，选中项显示「可以继续」及其自己的工作区，切换选中后摘要换成第二项自己的内容（归属逐个成立）；打开恢复后草稿、焦点不变，`activeRunCount` 仍为 0。
- 该探针的边界写在证据文件里：**不点"继续"**（恢复会在检查点记录的真实工作区里执行工具，属用户决定），因此它验证的是发现与归属，不是续接执行本身；第二个检查点因模型与夹具不同而显示「需要处理」，脚本如实记录 `resumable: false`；无凭据时脚本跳过并说明，不产生结论。
- **失败态也已用真实故障取证**（新增 `scripts/verify-desktop-cold-start-readiness-failure.mjs` + 同名 npm 脚本，证据 `docs/reference/cold-start-baseline/cold-start-readiness-failure.json`，**不挂载验收面**）：③ 执行准备失败（config 指向不存在的 provider）时**保留活动外壳**——`运行能力启动失败：runner: no provider …`、`aria-live="assertive"`、发送入口禁用、输入区仍在（改配置的设置可达）、无错误横幅、未启动 run；① 数据前置失败（config.json 非法 JSON）时落到**独立启动失败页**（含解析错误原文、品牌图标、`#101010` 表面与错误卡片）。同批确认失败时的接口契约：readiness 200 且 `state=failed`/`retryable=true`、`/sessions` 200、`/run-checkpoints` 503 失败关闭。
- 该批证据促成一处显式化改动：`desktop-shell.ts` 新增 `hasLoadedRenderer()`，bootstrap 失败分支只在渲染器尚未接管时才切到独立失败页；此前该分支无条件切换，而实测 ③ 阶段的最终可见状态是渲染器外壳（等于"切过去又被接管"），现在两个阶段的可见状态都是写在代码里的契约，并各有实机证据与 `desktop-shell.test.ts` 断言。
- **有界重试已实现并实机验证**（`execution-retry.ts` + `RUNTIME_RETRY_EXECUTION_CHANNEL` + preload `retryExecution()` + `RuntimeReadinessNotice` 的 `.runtime-readiness-retry` 入口）：失败态提供重试，Main **先重读 `config.json` 再重建执行阶段**；同一真实窗口内实测"配置仍错误时重试 → 仍 failed 且仍可重试"，随后"改好 config.json → 重试 → readiness 变 `ready`、失败提示消失、`/run-checkpoints` 从 503 变 200"。预算为连续 3 次失败（成功一次即重置，之后的另一次失败仍有自己的机会），并发点击由 Main 拒绝（`in-flight`）；规则各有单元测试（`execution-retry.test.ts` 5 例、`execution-retry-state.test.ts` 4 例），窗口探针覆盖端到端恢复路径。
- **启动期间的窗口生命周期与重试并发也已实机覆盖**：①交互脚本新增窗口生命周期用例（`always-background` 配置的第二次隔离启动）——加宽窗口内输入草稿 → 关闭窗口（进程存活、验收快照显示窗口不可见）→ `show` 回来后草稿/当前会话/焦点不变；再最小化 → 还原后输入区与草稿仍在；最终就绪仍到达 `ready`、提示消失、草稿保留。②失败态探针同时发两次 `retryExecution()`：第一次 `accepted: true`（`attemptsUsed: 2`、`attemptsRemaining: 1`），第二次 `accepted: false`、`refusedBecause: "in-flight"`——并发拒绝发生在 Main，而不是界面把按钮变灰；随后修好配置的那次重试（预算最后一次）成功转为 `ready`。
- 剩余缺口：**续接执行本身**（真正点"继续"并完成一次恢复）需要用户在真实数据根上决定；系统重启后的完全冷启动、125%/150%/200% 缩放与明暗桌面实拍、安装包实机仍需人工。

### CS-04｜缩短首次可执行路径 —— 预算已测量，改动待后续

- 改动文件：`packages/runner/src/infra.ts`（opt-in 子阶段计时标）、`packages/app/src/main/index.ts`（插件宿主移出就绪路径）、`packages/app/src/main/plugin-host-startup.ts`。
- 初始化依赖图与预算（normal，n=15）：`execution-start → execution-ready` 中位 **170.7 ms**，其中 Runner 构建 121.0 ms（durable harness 55.2、bootstrap 文件加载 30.5、skill 15.4、memory 10.8、可观测性 4.1、其余约 3）、RunRouter 创建 + 附件缓存初始化 50.1 ms、插件宿主 2.8 ms。其余启动构成见[基线文档](../reference/cold-start-baseline/README.md#cs-04-执行准备预算n15normal)。
- 已做的顺序调整：插件宿主从就绪路径移出（`readiness.ready()` 先发布）。实测该段只有 2.8 ms，因此**不构成有意义的提速**，保留原因是语义正确。
- 一处需要更正的早期读数：先前按 `plugin-host-ready - runner-ready` 得到的"插件约 50 ms"是测量错误，该区间实际包含 RunRouter 创建；已在基线文档中更正并说明。
- 未做且不应在没有独立设计的情况下做：bootstrap 文件加载的进一步压缩；迁移、持久化一致性与权限前置检查的顺序保持不变。
- 补充测量（新增 `runner-infra-returned` 标点，n=3）：`buildInfrastructure` 覆盖 Runner 构建的全部成本（111.9/127.8/123.9 ms，与 `runner-ready - execution-start` 仅差 0.2 ms），构建之后无隐藏工作；RunRouter 创建（约 95–123 ms）与渲染器加载在时间上重叠，因此执行准备对首帧的可见影响小于其绝对耗时。**压在关键路径上的主体是渲染器自身的求值与绘制（首帧前约 500–700 ms）**，而"减少入口字节"已被证明不是改善它的有效手段。
- durable harness 单独设计并落地（新增四个 opt-in 子阶段标 + `durable-harness-infrastructure.test.ts`）：四个存储各占自己目录下的锁文件、除父目录外不共享状态，因此改为并行初始化。配对实测（normal，每变体 8–10 次，两变体各重新构建，并交换测量顺序抵消漂移）：durable 阶段墙钟 **36–40 → 10–13 ms**，Runner 构建 **114–116 → 99–101 ms**；紧随其后的 bootstrap 文件注册从 28–34 ms 涨到 43–45 ms，吃回 10–16 ms，故构建层面净收益约 **14 ms**（已含回吐）。渲染器侧"输入可用/会话可读"没有移出波动区间，因此**只声明阶段级收益，不声明首次可执行变快**；失败语义不变（按声明顺序报告第一个失败并关闭 next 模式准入，差异是失败后其余存储已完成自身扫描，已在基线文档写明）。
- 同时被证伪并回滚的一项：`BootstrapResourceCoordinator.load` 的六个引导文件改为并发读取后，同一批测量该阶段 43.6 → 44.9 ms（无变化），说明这段成本在随后的资源组写入而非读取。
- bootstrap 文件注册已定论（同一数据根连续启动三次的临时对照，两轮一致）：第 1 次 20.2/22.9 ms、第 2 次 10.1/11.3 ms、第 3 次 10.4/12.3 ms。约一半是**首次注册**必须落盘（六条资源登记 + 账本事务；`sameResourceRegistration` 忽略时间戳、`commitMutation` 无变化时提前返回，所以同一数据根的后续启动跳过写入），剩下的 10–12 ms 是文件读取 + 内容哈希 + 一次 no-op 变更，**不再作为优化目标**（读取并发已证伪）。durable 存储的扫描不随冷热变化，所以并行化收益是稳态收益，而注册写入的收益只发生一次。该对照同时校正读法：测量脚本每次新建数据根，表里的数字是**首次启动**数字，真实用户第二次启动会比表里略短。
- 首次发送准备耗时（13–34 ms，与启动前的基线同量级）说明启动等待没有被转移到发送之后。
- 剩余缺口：预算已确定，Runner 构建已取得阶段级净收益（约 14 ms）但**未**在"首次可执行"上测出稳定改善；durable 与 bootstrap 两条初始化路径已分别定论（前者取收益、后者不再有目标），下一步需要新的方向而不是继续压这两段。

### CS-05｜减少首屏依赖与资源争用 —— 一项已完成并实测

- 首屏依赖审计：入口 chunk 曾 2.68 MB；Monaco 与 mermaid 已按需加载，但完整的 `react-syntax-highlighter` Prism 构建（300 个语言模块 + 47 套样式）被静态引入 `Markdown.tsx`，Node 下单独 import 实测约 380 ms。
- 已改动：`packages/app/src/renderer/Markdown.tsx` 改为 `lazy(() => import('react-syntax-highlighter'))`，代码块在高亮 chunk 到达前渲染等宽纯文本回退（复用相同 class 与内联样式，避免布局跳动），到达后照常高亮；仍用完整 `Prism`，语言覆盖不减。
- 成对实测（同机同 profile，各 5 次，改动前后各重新构建）：入口 chunk 2.68 MB → 1.75 MB（−936 KB）；进程启动 → 真实首帧 1296.2 → **1148.1 ms**；输入可用 380.9 → 303.4 ms；当前会话可读 395.9 → 308.5 ms；首次可执行 1750.7 → 1517.0 ms。两组样本不重叠，属有证据的提速。详见基线文档的 CS-05 一节。
- 已试做并被证伪：插件包延迟导入后主 bundle 2.80 → 2.76 MB，主模块求值 197–216 ms → 199–220 ms，落在噪声内，**不作为按需加载的收益证据**。
- 未做：设置页、终端、预览、Git 的静态导入链逐项测量与拆分；后台 I/O 限并发；Worker/独立进程（测量未显示 CPU 阻塞证据，暂不引入）。
- 入口归属已量化（`scripts/report-renderer-chunks.mjs` + `renderer-module-report.json`）：入口 1,728,325 字节 / 433 模块中，react-dom 133 KB（必需）、Markdown 解析管线约 250 KB、拓展工作区树（top-40 内）181 KB、dompurify 122 KB、语法高亮语言定义 0。剩余两块可后移的大块是 Markdown 解析管线与工作区树，两者都需要先解耦（Markdown 拆开活动行的轻量 `InlineMarkdown`；工作区把 `use-workspace-layout-controller` 的草稿/评论状态移出树的导入路径），各需独立设计与验证。
- 另一项被证伪的尝试：`WorkspaceHtmlPreview`（dompurify）按需导入使入口 −49 KB，但成对实测无收益（首次可执行 1536.7 → 1606.4 ms、首帧 1172.7 → 1214.7 ms，区间重叠），已回退。**入口字节数不是首帧的可靠代理**，后续按需加载一律以成对实测为准。
- 最大的一项也被证伪：把整条 Markdown 解析管线按需导入使入口 **−400 KB（21%）**，但成对实测首帧 1170.5 → 1177.5 ms、首次可执行 1550.0 → 1595.7 ms，样本区间完全重叠，同样已回退。原因：`file://` 加载不经网络，解析/执行与首帧准备并行；真正有效的语法高亮之所以有效，是因为它在首帧前被同步求值并占用主线程（Node 下约 380 ms）。**因此本专项此后只接受"成对实测有收益"的按需加载。**
- 保留的副产品：活动行单行标签改由 `inline-markdown.tsx` 的轻量扫描器渲染（`**粗体**`/`*斜体*`/`` `代码` ``/`~~删除~~`，其余字面输出），使活动行既不必等解析器、也不把整条插件链拉进入口依赖图，并有独立测试。
- 剩余缺口：输入延迟与窗口拖动在后台初始化期间的表现、按需加载首次使用的反馈（代码块回退→高亮的切换）尚未实机验证。

### CS-07｜真实回归与文档收口 —— 自动化部分完成，人工项待办

- 已运行：`pnpm run check:repo`、`pnpm run typecheck`、`pnpm exec vitest run packages/app/src`（当前 **193 文件 / 921 用例**）、`pnpm run build:app`、`pnpm run assert:app-build`、`pnpm run package:win`（未签名 `release/win-unpacked`，已按当前源码重新打包）、开发版冷启动采样（20 次基线 + 18 次冷/稳态）、打包版采样（重新打包后 18 次冷/稳态，另有重新打包前的 9 次稳态对照）、以及五份真实 Electron 证据账本：开发版视觉（7 张截图）、打包版视觉（7 张 `-packaged` 截图）、交互（含加宽窗口、会话切换、窗口生命周期）、恢复归属（真实 Provider + 真实检查点）、失败态与重试（两个失败阶段 + 重试恢复 + 并发拒绝）。
- 打包版与开发版对比见[基线文档](../reference/cold-start-baseline/README.md#打包版冷启动releasewin-unpacked)：多数差异在样本波动内，可确认打包版无量级回退。打包版另有独立护栏 `packagedBudgetsMs`（会话内首次启动是磁盘冷读，实测最慢一次 输入可用 829.1 / 首次可执行 2167.8 ms），不与开发版的紧上限混用。
- 已发现并记录一个**与本专项无关**的既有失败：`verify:electron-ui-state-continuity` 的 `bounded tool activity was not observable`，在改动前的 `df66ed9` 上可复现（见下节）。
- 本专项在验收过程中发现并修掉的真实缺陷（都只在真实窗口/打包产物里暴露）：未就绪窗口把 Runner 的 503 渲染成"加载历史失败"；打包版启动页与窗口图标因 `<resourcesPath>/resources` 未被搜索而缺失；`executionReadyMs` 把渲染器首帧等待超时计成"首次可执行"；`warmVsColdMs` 静默不生效。另有四处测量/验收脚本自身的缺陷（首帧缺失、截图抖动、会话簿记、并发观测变量作用域）在同批修复。

### 剩余验收清单（必须人工执行，自动化无法替代）

任务书里每一项能自动化的验收都已落地并留下账本；下面三类必须在真实机器上由人完成。逐项做完后勾选对应复选框，任务书才可按文档生命周期退役。

1. **视觉状态（需要人眼，含系统重启后的真冷启动）**
   - 先跑一次自动化基线：`pnpm run build:app`，然后 `pnpm run verify:desktop-cold-start`（三种宽度 + 最大化/还原 + 启动页 + 启动失败页）、`pnpm run verify:desktop-cold-start-visuals -- --app=packaged`（打包版同一批检查）与 `pnpm run verify:desktop-readiness-placement`（正常/拉慢/失败三档启动 + 窄窗 + DPR 代理，截图 `readiness-*.png`）。
   - 人工确认：①启动页→渲染器的**交接瞬间**有无可见跳变；②**失焦**时原生标题栏按钮的激活态与统一表面是否冲突；③**最小化/还原**后的观感；④**125% / 150% / 200%** 显示缩放下标题栏与原生按钮区是否仍无缝（脚本的 DPR 代理只覆盖渲染器布局，覆盖不到原生合成）；⑤**明/暗壁纸**下窗口边缘是否干净；⑥**系统重启后**的第一次启动（本机热缓存样本不能代表它）。
   - 参考图与逐项结论在 `docs/reference/cold-start-baseline/screenshots/`。
2. **打包与安装（需要授权，会写系统）**
   - `pnpm run package:win` 已产出未签名 `release/win-unpacked` 并做过冷/稳态与视觉采样；仍需：运行 NSIS 安装包 → 确认安装目录、开始菜单与卸载登记 → 在干净机器或干净用户下首次运行，确认数据根初始化、图标、启动页与就绪提示。
3. **真实续接执行（需要你的数据）**
   - 现有取证到"发现 + 归属"为止（`pnpm run verify:desktop-cold-start-recovery`，可用 `LITTLESHEEP_RECOVERY_PROBE_CHECKPOINT` 指定检查点做只读验证）。真正点"继续"会在检查点记录的真实工作区里执行工具，请在你自己确认的工作区上执行一次，核对恢复后的对话归属、产物与引用；这一步不做，任务书里对应的续接验收保持未勾选。


### CS-07 前置观察（不属于本专项改动）

`pnpm run verify:electron-ui-state-continuity` 当前失败，断言为 `bounded tool activity was not observable`。已在本次改动之前的提交 `df66ed9` 上复现同一失败（同一环境、重新构建后再跑），因此**不是**本专项引入的回归。该失败的实际含义是：真实 Electron 下该脚本没能在最近一轮渲染出 `glob` 工具行，需要独立排查（脚本期望、模型回合或渲染时序），不属于冷启动任务书范围，此处只记录事实，不据此判定本专项通过或失败。

### 文档同步

- 更新：`packages/app/README.md`、`packages/app/src/main/README.md`、`packages/app/src/preload/README.md`、`packages/app/src/renderer/README.md`、`packages/app/src/renderer/api/README.md`、`packages/app/src/renderer/app-shell/README.md`、`packages/app/src/renderer/runtime-recovery/README.md`、`packages/app/src/renderer/runtime-readiness/README.md`（新）、`packages/app/src/main/local-app-api/README.md`、`packages/app/src/shared/README.md`。
- 新增常驻参考：[桌面冷启动基线 2026-09-23](../reference/cold-start-baseline/README.md)，并由 `docs/README.md` 收录。

### CS-08｜右侧拓展工作区进入即能预览和操作 —— 定位到阻塞缺陷并修复，指标已建立（进行中）

- **指标已建立**（渲染器只上报封闭阶段名，仅在 `LITTLESHEEP_BOOTSTRAP_TIMING=1` 时产出）：`renderer-workspace-entries`（首个目录行被绘制后上报）、`renderer-workspace-preview`（首个文件正文被绘制后上报，占位/错误/空面板都**不会**发布）。两者与首帧共用同一渲染器时间轴，Main 记录到达时的 `processUptimeMs`。
- **配对测量脚本**：`scripts/measure-workspace-availability.mjs`（新）——同一数据根 + 同一 Chromium profile 的"预热一次 → 多次冷启动"结构，夹具含 60 个目录条目、Markdown 预览正文与 `docs/guide.md`；产物 `docs/reference/cold-start-baseline/desktop-workspace-availability-2026-09-24.json`（记录目录规模、预览大小与逐次原始样本）。
- **找到并修掉阻塞缺陷（真实缺陷，非体验偏好）**：渲染器的工作区客户端把 URL 写成 `` `LOCAL_APP_API_ROUTES.workspaceList)}?...` ``——模板字符串缺少 `${`，于是每个请求都是 `http://127.0.0.1:<port>LOCAL_APP_API_ROUTES.workspaceList)}?...`，`fetch` 直接以 `TypeError: Failed to parse URL` 拒绝。后果是**右侧永远读不到任何目录与任何文件预览**：目录树显示"文件夹暂时无法读取，请点击刷新重试。"，点刷新也不会再发请求（渲染器侧根本没有请求发出），而同一个路由被直接调用时返回 200。共 5 处同类错误：`workspaceList`、`workspacePreview`、`workspaceLayout`、`workspaceArtifacts`（`api/workspace-files.ts`）与 `terminalActivity`（`api/terminal.ts`）。
- 修复与回归护栏：五处模板字符串改正；新增 `packages/app/src/renderer/api/workspace-client-paths.test.ts`，断言客户端**实际发出的路径**以文档化路由开头、且不含 `LOCAL_APP_API_ROUTES` 字面量——这类"URL 拼错但类型通过"的缺陷从此由测试拦下。
- 修复后实测（同一夹具与脚本，n=3 冷启动，0 失败；账本含 `warmup`、3 次冷启动、`click-to-preview` 与 `while-not-ready`）：进程启动 → **首个目录行可见 1194.9 / 1202.0 / 1261.4 ms**，→ **恢复的文件内容可见 1194.8 / 1201.8 / 1261.7 ms**（两者同帧：恢复的预览与目录树一起出现），**点击文件 → 预览可见 2.8 ms**（并确认 `renderer-workspace-preview` 标点发布）；对照的执行就绪为 691.7 / 748.1 / 775.2 ms，即**目录与预览都早于执行就绪**，不等待 Runner。
- 一处需要更正的中间结论：先前两次测量报告"布局恢复路径不通"（活动标签停在"审阅"、预览未挂载），根因在**测量脚本**而不在产品——预热阶段用强制结束进程收尾，而持久布局镜像（`<data-root>/workspace/layout.json`）是在**正常退出路径**上刷新的，于是被测量的那次启动恢复的是更早的"只有审阅"快照。把预热改成走 `quit` 验收动作（等同用户关闭应用）后，同一个构建三次冷启动全部恢复出文件正文。这也解释了为什么独立诊断（等待更久、未强杀）当时就能复现恢复成功。
- **Runner 未就绪期间可用已实测**（探针新增 `while-not-ready` 用例，用仅验收的 `LITTLESHEEP_ACCEPTANCE_READY_DELAY_MS` 拉长窗口；该用例已作为同一账本的一类运行留档）：读取目录与点击文件时 `/runtime/readiness` 都是 **`starting`**，此刻目录行 4 条、文件正文 15210 字符已可读（标点 1142.2 / 1142.0 ms），就绪到达后正文仍是 15210 字符——**没有被就绪交接复位**。这直接支持"目录与普通文件预览不等待 Runner"。
- CS-08 仍未完成的部分：**改选目录**（走系统目录选择对话框，无法在无头环境驱动，需人工或改走可注入的选择器）。复选框保持未勾选。
- **未就绪期间的浏览器标签也已实测**（同一脚本的 `browser-tab-while-not-ready` 一步）：脚本自己在 127.0.0.1 上起一个带唯一标记的页面，在 `starting` 窗口里打开浏览器标签并提交地址，再用 webview 的 `getURL()`/`executeJavaScript()` 读回客体——`url: http://127.0.0.1:<port>/`、正文 = `MARKER-BROWSER-GUEST-PAGE`，读回时就绪仍是 `starting`；就绪交接后 URL 与正文一字不变。因此"目录、普通文件预览、浏览器标签在 Runner 就绪前可用"三项都有实机证据，且"右侧已可用"没有被泛化到终端/Git/产物。
- **切换会话与关闭/恢复窗口已实机取证，其中一处真实缺陷已定位并修复**：`scripts/verify-desktop-cold-start-interaction.mjs` 新增工作区健壮性用例（夹具两份文件各带唯一标记，用于互校"面板说在显示哪个文件"与"正文实际是哪个文件"），整份用例现在 **0 失败**：①启动期打开的文件随用户**进入的第一段会话**一起过去（753 字符、标记一致），草稿桶被清空；②再切到另一段会话不继承该文件、无错误横幅、不启动 run；③切回认领它的会话正文逐字恢复；④就绪后的同一往返、点第二个文件后立刻切换的竞争、隐藏/显示窗口、以及就绪交接全部保持正文不变。
- **缺陷的定位方式值得留档**：第一次按规则改动的尝试（把认领改成"会话未被动过期间持续认领"）**实机无效并已回滚**；真正原因由**应用内一次性追踪**给出——进入会话时 `switchSession` 先写入的桶并非空桶，而是带着切换时应用自己写入的一个 `expandedPaths` 对齐项（`{tabs:1, request:null, expanded:1, drafts:0}`），旧判据把"桶已存在"当作"这段会话有自己的布局"而放弃认领。修复改为只认**用户真正产生的内容**（默认标签之外的新标签、指向文件的 `openRequest`、未保存草稿、浏览器标签），规则落在新模块 `packages/app/src/renderer/workspace/layout-ownership.ts`（从 `workspace-persistence.ts` 拆出，使其留在 600 行硬上限内），单测 18 例；逐项实机事实与追踪原文见基线文档的 CS-08 补充一节。

### CS-09｜收敛正常启动提示的视觉占用 —— 实现完成，三档启动已实拍（进行中）

- **改动文件**：`packages/app/src/renderer/runtime-readiness/composer-readiness-hint.tsx`（新）、`runtime-readiness-notice.tsx`、`packages/app/src/renderer/app-shell/composer-view.tsx`、`packages/app/src/renderer/styles/11-runtime-readiness.css`、`packages/app/src/renderer/runtime-readiness/readiness-placement.test.ts`（新，7 例）。
- **做法**：把启动提示拆成两个各管一件事的表面，事实仍只有一份（Main 的就绪状态与原因）。**正常启动**由 `.composer-readiness-hint` 把 Main 给的那句话就地渲染在 `.composer-right` 内、发送按钮左侧，只在 `state === 'starting'` 出现，就绪即消失，不写渲染器自己的等待文案；**只有失败**才回到整窗条带 `runtime-readiness-notice`（`aria-live="assertive"` + 既有 `.runtime-readiness-retry` 重试入口），因此"失败与可重试状态保持可见"没有被削弱——它现在独占那条最显眼的表面。窄窗用省略号截断但保留 `7ch` 下限：被压成零宽等于没有提示，这正是本项要收敛的问题。
- **实机取证**：新增 `scripts/verify-desktop-readiness-placement.mjs`（`pnpm run verify:desktop-readiness-placement`，逐项事实 `docs/reference/cold-start-baseline/cold-start-readiness-placement.json`，截图 `screenshots/readiness-*.png`），三档启动都在真实窗口里驱动：
  - 正常启动 ×3（1580×900）：条带**从未出现**；三次附加调试器时都已 `ready`，所以这一档只证明正常路径没有回退，摆放本身由下一档测量（边界已写进证据文件的 `gaps`）。
  - 故意拉慢启动（仅验收用的就绪延迟 7 s，Runner 照常构建，被拉长的只是渲染器看到的窗口）：`/runtime/readiness` = `starting`，阶段文字 = Main 的原因「正在准备运行能力」，位于控制行内、占窗口宽度 **7.5%**，条带为 `null`，发送入口 `disabled` 且 `aria-label` 与原因一致，草稿与焦点保持，右侧预览正文 4398 字符可读。
  - 同一次启动缩到窗口下限 800×660：阶段文字 45 px（截断但不为零宽）、与发送按钮不重叠、`scrollWidth - innerWidth = 0`、条带为 `null`、预览未丢；DPR 1.25 / 1.5 / 2 的代理下同样无溢出、无重叠、无条带（该代理只改设备像素比，窗口 CSS 像素尺寸与原生合成不变，因此它不能替代真实缩放下的目视检查）。
  - 就绪交接后：两个表面都 `null`，发送恢复可用，草稿、焦点与预览不变。启动失败档：条带占满整行（`left/right = 0`，标题栏下方 32–62 px）且文案就是 Runtime 原因 + 重试入口，阶段文字为 `null`。
- 既有真实窗口脚本同步改到新表面并全部通过：`scripts/verify-desktop-cold-start-interaction.mjs` 现在断言"阶段文字在控制行内（宽度占比 0.075）、条带为 `null`、发送禁用、草稿保持"，就绪后两个表面都消失；失败档探针不变，仍然通过。
- 剩余缺口：**真实显示缩放**（125% / 150% / 200% 的 Windows 缩放与明暗桌面背景）仍是人工项，脚本只做了 DPR 代理；正常启动未就绪窗口只有约 300 ms，"正常启动不长出全局条"由同一状态的拉长版本测量。另在 800 px 窗口下顺带记录两处**既有**布局现象（与本项改动无关）：控制行本身已很拥挤（就绪后同样存在），右侧预览列在面板与文件树夹挤下一行只剩一个字。复选框保持未勾选。

### CS-10｜按选中会话加载与后台续载 —— 实现完成，真实数据只有观察值（进行中）

- **改动文件**：`packages/app/src/main/local-app-api-server.ts`（请求入口不再 await RunRouter 恢复：`activeRunRouter` + 世代号，重建时旧 router 停止，避免请求与恢复互相等待）、`local-app-api/run-lifecycle-routes.ts`（路由未就绪时 Run/Run-Stream/Run-Checkpoints/审批/生命周期明确 503）、`local-app-api/run-routes.ts`（`recoverDurableRuns` 拆成 `queue`/`events`/`all`：现代租约与收件箱在就绪前处理，历史事件分区只作后台兼容扫描；新增 `stopped` 提前返回）、`packages/runner/src/durable-event-store.ts`（启动不再全量列目录并逐个读取历史分区，校验下移到恢复扫描；自身分区的读写仍然严格校验）、`packages/app/src/renderer/sidebar/session-actions.ts`（按选中会话加载 + 会话历史缓存）、`packages/app/src/renderer/app-shell/runtime-actions.ts` 与 `use-app-controller.ts`（会话工作区与全局默认工作区分离）。
- **按选中会话加载的契约（源码确认）**：只有被选中的会话才发起首屏历史请求；该 promise 属于会话本身，切走不取消，切回可复用进行中或已完成的结果；缓存以会话 `lastMessageAt` 校验、最多 6 个会话，失败时把自身从缓存移除；`newSession` 清空选中工作区并恢复默认工作区；删除会话同时清缓存。会话切换只改当前视图的工作区，**不再** `updateRuntime` 落盘默认目录或重建 Runner。
- **单测证据（本次重跑：6 个文件 38 例全通过）**：`local-app-api-readiness.test.ts`(4)、`local-app-api/run-routes.test.ts`(5)、`packages/runner/src/durable-event-store.test.ts`(10)、`durable-harness-infrastructure.test.ts`(2)、`renderer/sidebar/session-actions.test.ts`(12)、`renderer/app-shell/runtime-actions.test.ts`(5)。
- **真实数据观察值（来自 2026-09-24 记录，仓库内暂无原始账本）**：真实数据根约 399 个事件分区 / 13,769 个事件文件；修复前两次执行就绪约 55.7 s 与 84.5 s；修复后一次重复启动：Renderer 首帧约 1.30 s、工作区目录条目约 1.17 s、执行就绪约 5.67 s，两段已有会话首屏历史 29 / 34 ms，一次新会话真实模型发送 HTTP 200 `ok` 且约 4.68 s。**这些数字目前只存在于本任务书**，因此只能算观察值，不能称为分位数；要变成常驻证据需要在真实或合成的大分区数据根上跑脚本并落账本（合成数据根可复现"恢复不阻塞元数据与工作区路由"的机制，但复现不了真实磁盘与真实历史的规模）。
- **既有真实窗口脚本**：`pnpm run verify:desktop-cold-start-interaction` 0 失败（未就绪时切换会话、普通文件与浏览器标签预览、草稿与焦点保持、就绪交接）；`pnpm run verify:desktop-cold-start-readiness-failure` 覆盖路由未就绪的 503 语义与有界重试。
- 剩余缺口：真实/合成大分区数据根上的**量化回归**（快速连续切换的缓存复用、后台扫描结束后的长时交互）、打包版复验、以及上面那批观察值缺少原始账本。复选框保持未勾选。
