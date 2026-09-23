# @littlesheep/app

最后更新：2026-09-23 22:30:00

LittleSheep 的 Electron 桌面应用。Agent Runner、记忆、工具、会话和可选渠道在主进程中装配；React renderer 通过 loopback Local App API 与主进程通信。

- **冷启动三段式**：窗口早于执行能力出现。①数据根迁移、用户布局、keychain、config、Memory v3（顺序是任何写入者的前置条件）；②UI 索引 + Local App API 监听 + 窗口加载渲染器；③Runner 与 RunRouter 建成后发布执行就绪。可选插件宿主在就绪之后异步加载，不阻塞执行能力。
- **首屏按需加载**：Monaco、mermaid 与 `react-syntax-highlighter` 都不得进入入口 chunk。完整 Prism 构建单独求值约 380 ms，改为按需后入口 chunk −936 KB、真实首帧早约 148 ms（成对实测见 `docs/reference/cold-start-baseline/`）。**入口字节数在本应用里不是首帧的可靠代理**：Markdown 解析管线整条按需（−400 KB）与 dompurify 按需（−49 KB）都实测无收益并已回退，新增加载态前必须用成对实测证明收益。
- **就绪是唯一事实**：`src/shared/runtime-readiness-{contracts,ipc}.ts` 定义载荷与通道，`src/main/runtime-readiness.ts` 拥有状态，renderer 经 `src/renderer/runtime-readiness/` 消费。未就绪时 metadata 路由照常应答、Runner 依赖路由以 503 `runtime-not-ready` 失败关闭；具体边界见 `src/main/local-app-api/README.md`。
- **启动计时**：`LITTLESHEEP_BOOTSTRAP_TIMING=1` 时主进程、Runner 基础设施与 renderer 自报首帧输出同一格式的 `[bootstrap-timing]` 阶段标；五时间点基线与回归护栏见 `docs/reference/cold-start-baseline/`。Runner 侧的 durable 存储并行初始化后，该阶段墙钟 36–40 ms → 10–13 ms、Runner 构建 114–116 → 99–101 ms（净约 14 ms，属阶段级收益，不声称首次可执行变快）。
- **启动失败页可取证**：`src/main/desktop-acceptance-actions.ts` 只在 `LITTLESHEEP_ELECTRON_ACCEPTANCE=1` 时装配隔离验收动作（`/application/acceptance` 的 `resize` / `startup-error` 等），后者把真实失败文案交给生产同一份 `showStartupError` 文档，使 CS-02 能对"启动失败"这一无法靠等待到达的状态取像素证据；生产运行不挂载这些动作。
- **会话累计缓存命中**：composer 的上下文指示器除窗口占用外，还显示**本会话累计**的缓存命中率与 `缓存读取 / 输入` 原值。该值由主进程 `buildSessionContextUsageRecord` 按会话汇总每次 run 的 provider 用量（`cachedPromptTokens / promptTokens`，**含冷启动**、不含压缩等分离调用），与验收账本、`check:cache-acceptance` 用的是同一组字段与同一公式；`requestsWithoutUsage > 0` 时明确标注"usage 未上报"，不把局部读数当成完整读数。展示层四舍五入，判定层一律用精确值。

## 应用层交互基线

以下规则跨 Renderer 领域生效，细节与类名归属见 `src/renderer/` 各目录 README：

- 输入确认：Enter 发送、Shift+Enter 换行、输入法组词确认候选不触发提交，由 `renderer/ui/enter-confirm.ts` 单独拥有；视图不得自行判断 Enter。
- 键盘层级：`renderer/ui/modal-layer.ts` / `modal-surface.ts` 决定 Escape 属于最上层、模态对话框的 Tab 约束与焦点归还；平铺编辑页只用页面级作用域，不捕获 Tab。
- 异步反馈：`renderer/ui/feedback.ts` / `feedback-notice.tsx` 是唯一结构，色调来自结果字段而不是解析文案；失败留在发起操作处、可重试、长错误折叠呈现。设置页的写操作必须把结果带回本页，包括 `applyRuntimePatchReporting` 返回的 Runtime 失败文本。
- 不可逆操作：永久删除先经 `renderer/ui/danger-confirm.tsx` 确认，影响文案由 `renderer/deletion-impact.ts` 按真实 API 行为生成；可恢复的归档恢复保持单次点击。
- 显示密度：紧凑模式只折叠无需关注的行，失败、权限拒绝、未验证、部分完成与待用户事项必须继续可见（`renderer/chat/activity-visibility.ts`）。
- 视觉角色：危险文本、通知几何与控件高度使用 `03-shell-sidebar.css` 中的角色 token，同类控件不得重新写回字面值；`ui-state-consistency.test.ts` 直接测量样式源。

真实窗口验收（最小窗口、系统缩放、输入法、失败注入与场景连续性）仍是未完成项，逐项脚本见 `docs/taskbooks/application-ui-ux-taskbook-2026-09-22.md`。

## 开发

从仓库根目录执行：

```powershell
pnpm install
pnpm --filter @littlesheep/app dev
```

完整构建和桌面快捷方式刷新使用：

```powershell
pnpm --filter @littlesheep/app build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\refresh-desktop-shortcut.ps1
```

根目录的 `build-app.bat` 已把这两步集中到 `scripts/build-app.ps1`，并且不依赖固定仓库路径。构建前会由 `scripts/prepare-littlesheep-runtime.mjs` 在本机 Electron 安装目录生成同版本的 `LittleSheep.exe`；它是被 `.gitignore` 忽略的运行时副本，不进入 Git。应用构建输出位于 `packages/app/out/`，只保留在本机供 `LittleSheep.exe` 启动，不进入 Git。

## 运行边界

1. 主进程在 `src/main/index.ts` 先恢复待处理的数据根迁移或回滚，再初始化用户数据、配置、密钥、Runner、会话/项目索引和 Local App API。
2. `src/main/local-app-api-server.ts` 提供本地 UI、流式执行、设置、记忆树、项目、工作区、终端和开发环境接口。
3. `src/preload/` 只暴露 renderer 必需的桥接信息。
4. `src/renderer/` 负责聊天、侧边栏、设置、归档、记忆树、执行过程和拓展工作区。
5. Electron 主进程并列装配 Runner 与 `@littlesheep/plugins` 宿主；插件工具经校验后迁移进 Runner，插件 Skill 通过 owner-scoped 来源进入 SkillLoader 和记忆注册表，外部渠道以插件贡献形式接入且不是本地 UI 的必要依赖。插件 API v1 的边界和本地代码信任规则见 [插件开发说明](../../docs/reference/plugin-development.md)。

网络设置页的 Provider 检查是用户主动触发的 Main-owned 一次性搜索：只有当前已配置 Provider 的真实检查成功才显示 `ready`；检查结果只保存在当前运行时，配置变化、Runner 重建或重启后重新回到 `configured_unchecked`。启动过程不会为健康状态隐式联网。

### 权限容器

活动 `dataDir`（默认 `.littlesheep`）是 LS 的逻辑容器根，`workplaceDir` 是其默认工作区，不是完整应用数据根。Main 将 `dataDir` 传给 Runner、Agent 工具和终端路由，用于标记容器内、容器外及无法证明范围的访问。当前这不是实际 Docker/OS 进程隔离，Shell 仍由宿主系统启动；任何未来的系统沙箱都只能作为额外防线。

三档权限含义：完全访问启用时先进行一次红色风险确认，确认后容器内外及范围不明的读写改删和执行免逐次批准；研究仅对容器内读取免批准；受限所有操作都需批准。核心源码只读和危险命令硬拒绝高于这些模式。

用户主动选择外部工作区、预览文件或保存编辑内容属于用户发起的 UI 操作，不会把该路径纳入容器。Agent run 对外部或未知工作区仍由 Main 判定范围；研究/受限先等待批准，完全访问确认后直接继续。

## 数据所有权与禁止事项

- Main 进程拥有 Electron 生命周期和用户数据 adapter；Renderer 只拥有临时交互状态。
- 完整应用数据根由 branding、外部 locator 或 `LITTLESHEEP_DATA_DIR` 解析并可整体迁移；`<data-root>/workplace` 只是默认工作区，不是全部应用数据。
- 会话、记忆、项目、附件、工作区和插件数据各自由对应服务管理，UI 不维护第二份权威副本。
- 禁止让 Renderer 直接访问 Node.js 或用户数据，禁止让外部渠道成为本地 UI 启动条件。
- 禁止继续向 `App.tsx`、`local-app-api-server.ts` 和 `renderer/api.ts` 加入无关领域逻辑；兼容修改应服务于后续分域。

## 重要入口

| 路径 | 职责 |
| --- | --- |
| `src/main/index.ts` | Electron 主进程启动和退出；窗口、托盘、关闭策略和拖拽/退出前落盘 IPC 在 `src/main/desktop-shell.ts`。 |
| `src/main/local-app-api-server.ts` | Local App API、SSE、工作区和终端；长生命周期 SSE 由 `local-app-api/http.ts` 统一提供 15 秒心跳、512 KiB 单连接待写上限和清理。 |
| `src/main/desktop-acceptance-snapshot.ts` | 只读桌面验收快照；采样进程/Electron 内存、句柄、活动请求、Runner、活动源和监听器，用于验证资源是否回落。 |
| `src/main/attachment-cache.ts`、`attachments.ts` | 受管附件缓存、稳定索引、安全清理、按需解析和 run 所有权分类。 |
| `src/main/data-root-migration.ts`、`data-root-metadata.ts` | 外部 locator、启动期 staging 复制、SHA-256 清单校验、活动元数据路径重绑定、原子切换、中断恢复和回滚。 |
| `src/main/development-environment-definitions.ts`、`development-environment-files.ts`、`development-environments.ts` | LS 管理的运行时/工具链定义、版本检测、导入移除事务、Electron Node shim 和终端派生 PATH。 |
| `src/main/local-app-api/development-environment-routes.ts` | 开发环境状态、版本偏好、导入和移除接口。 |
| `src/main/memory-v3-migration-control.ts`、`memory-embedding-model-control.ts`、`local-app-api/memory-migration-routes.ts` | Memory v3 迁移预检与回滚判定、固定本地向量模型资产检查、显式准备、进度、取消和关闭中止。 |
| `../memory-tree/src/workspace-resource-index.ts`、`workspace-resource-scanner.ts` | 工作区相对路径元数据索引；通过 Runner/MemoryService 接入，正文仍由显式工作区工具读取。 |
| `src/main/keychain.ts` | API key 安全存储；网络设置页通过 Main-owned route 保存 Tavily 密钥，配置只保留 secret reference。 |
| `src/main/project-index.ts`、`project-rebinding.ts` | 稳定项目身份、路径冲突检查和可恢复跨索引重绑定。 |
| `src/main/local-app-api/session-routes.ts`、`src/renderer/sidebar/session-row.tsx` | 独立对话和项目对话共用的会话重命名契约、持久化回滚与侧边栏内联编辑。 |
| `src/main/workspace-*.ts` | 工作区布局、产物、文件路由和 shell。 |
| `src/renderer/App.tsx` | 主 UI 编排。 |
| `src/renderer/TraceCard.tsx` | 历史执行阶段（含历史 stage 名）与工具调用记录；不再渲染 TaskBook。 |
| `src/main/memory-files.ts`、`src/renderer/MemoryTreeView.tsx` | 用户记忆文件视图；只显示六份权威文件，后端仅允许编辑 `SOUL.md`，不暴露 Atom、关系或向量结构。 |
| `src/renderer/chat/assistant-turn.tsx`、`Markdown.tsx`、`workspace/browser.tsx` | 思考/执行/结果渐进披露与文件、网页链接的内置预览。 |
| `src/renderer/api.ts` | Local App API 客户端。 |
| `src/renderer/styles.css`、`src/renderer/styles/*.css` | 共享深灰视觉和交互规范；`styles.css` 只汇总 `00`–`10` 分域样式表。 |

拓展工作区关闭最后一个标签后保持展开，并显示审查、产物、终端、空白浏览器和侧边聊天快捷入口；面板只在用户明确折叠或拖过第二层阈值时收起。折叠后同时保留右上角固定入口和右侧全高悬浮感应入口。

应用表面圆角使用统一 token：普通表面为 `10px`，圆形和胶囊单独处理；输入栏使用 `12px`，与固定 `24px` 圆形发送键的实际半径一致。侧边栏与拓展工作区共用的折叠图标使用 `3px` 小圆角、`18 x 14` SVG 视口、半像素坐标和 `1px` 非缩放描边，分隔线只做整数位移动画，以保证高 DPI 与窗口缩放下的边缘清晰度。

## 开发环境管理

设置中的“开发环境”页面是版本管理入口。Electron 内置 Node 会随应用提供；其他常用运行时和工具链当前由用户选择已下载并解压的目录后导入到 `<data-root>/toolchains/`。页面保存的是目标版本偏好，真实生效版本必须经过可执行文件版本校验；版本系列（如 `3.12`）会选择已导入的最高匹配补丁版本。终端使用由 Main 派生的进程环境，优先放置已验证的 LS 工具链，不修改宿主进程的 `PATH`。

当前尚未实现官方运行时下载、签名/哈希清单和完整安装包分发；相关边界与当前待办以 [项目状态](../../docs/decision/project-status.md) 为准。

## 验证

从仓库根目录运行：

```powershell
pnpm.cmd --filter @littlesheep/app typecheck
pnpm.cmd --filter @littlesheep/app build
pnpm.cmd run verify:app-recovery
pnpm.cmd run verify:electron-deepseek-sustained-load
pnpm.cmd run verify:electron-deepseek-hours
```

涉及公共事件、持久化、权限或恢复时，还必须运行根目录的全量测试、typecheck 和 build。`verify:electron-deepseek-sustained-load` 使用隔离数据根和已配置的DeepSeek API 实测 凭证运行 diagnostic 门，默认 120 秒，也可在 15-1200 秒内显式配置；它验证暂停、恢复不重放、最终回答连续性和资源回落，但不是小时级稳定性证明。`verify:electron-deepseek-hours` 使用同一产品路径运行 formal 门，默认 2 小时、允许 1-6 小时，并额外检查最多 24 个资源窗口的后半程趋势；正式基线是否达成、当前数字与未完成项以 `docs/decision/project-status.md` 为准，本文件不另行断言。普通 Agent run 与 Checkpoint 续跑的观察 SSE 断开不会取消 Main 中的任务；终端主动命令仍保留断连取消语义。用户数据位置由 branding、外部 locator 或 `LITTLESHEEP_DATA_DIR` 解析；应用只在用户明确登记迁移后于下次启动执行，测试必须使用隔离临时目录。

常见修改位置：启动/退出看 `src/main/`，纯跨进程规则看 `src/shared/`，UI 与交互看 `src/renderer/`，最小桥接看 `src/preload/`。各目录的 README 是更细一层的所有权入口。
