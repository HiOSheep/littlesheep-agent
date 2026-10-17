# 脚本与验证入口

`node scripts/verify-context-inspector.mjs` 用隔离数据根与本地 HTTP Provider 启动真实 Electron，检查圆环／键盘入口、缺失与 partial、计数账本、会话切换、返回焦点／草稿／滚动及运行中任务保留。截图和 `result.json` 默认写入系统临时目录，`--out=<绝对路径>` 可指定；5000/5100 等本地和 Provider 数字是显式 UI 夹具，不代表外部模型实报校准。验收不读取个人日志或记忆。

`package.json` 是可运行命令的唯一清单。本页说明入口如何选择，以及少数不能从命令名看出的验证边界。

`node scripts/s3a-eval.mjs --suite` 校验固定的 12 项 S3A 任务定义；`--audit` 输出 RCD 24 项定义的适配器/Oracle 层级审计；`--task=<ID>` 运行单项受控 Runner/Harness 任务，`--run` 运行本批有适配器的任务。结果分开记录评测基础设施状态与外部 Oracle 判定。当前 A 层使用 scripted Provider，不代表真实模型任务完成率，也没有真实 Provider 用量或费用。

## 常用入口

- `pnpm check:repo`：仓库卫生、文档导航、生成物、依赖方向与 TypeScript 项目引用检查。
- `pnpm verify:task -- --files=<path>`：按改动路径选择局部测试与类型检查。
- `pnpm verify:changed`、`pnpm verify:core`、`pnpm verify:full`：本地变更、核心和全量验证编排；各自覆盖面以 `package.json` 和执行摘要为准。
- `pnpm run ensure:app-build` / `pnpm run assert:app-build`：分别准备或只检查 Electron 构建新鲜度。真实窗口门通常先准备构建；基线检查工具通常要求构建已新鲜。
- `pnpm run check:cache-acceptance`：执行当前缓存验收规则。
- `pnpm run package:win` / `pnpm run package:win-installer`：生成 Windows 发布产物。
- `pnpm run verify:packaged-runtime-manifest`：核对 Windows 发布包里的 Electron 原生运行时清单，并在同主机目标上 smoke-load 原生模块；仍需真实桌面与完整功能验收。
- `scripts/prepare-littlesheep-runtime.mjs` 按 Electron 安装包的 `path.txt` 定位运行时；macOS 原样使用 `Electron.app`，不平铺或改名其内部二进制。macOS/Linux 打包与启动仍需对应主机实测。

Provider、Memory、文件一致性、Electron、桌面启动和工作区专项均由 `package.json` 中对应的 `verify:*` / `measure:*` 命令提供。验证选择应跟随受影响的契约和失败后果；构建、源码检查与真实窗口、真实 Provider、发布包证据不是同一层。

## Electron 验收约定

`pnpm run verify:conversation-timeline` 用真实 Electron 与本地 HTTP Provider 验证连续正文／工具顺序、不撤回已显示正文、缺失工作区的初始化、原生创建／读取／编辑无重复审批，以及重载后正文不丢失或重复。报告和截图保存在输出的临时目录；不代表外部模型任务质量或 Shell 隔离验收。

产品窗口验收应使用隔离数据根、确定性夹具，并将日志、截图和临时报告写到系统临时产物目录；不得读取用户会话或密钥。报告只证明其实际执行的断言。

`pnpm run verify:context-menus` 检查真实右键触发、原生编辑、会话／项目／消息／文件／标签菜单、键盘导航、重命名焦点和弹窗层级；报告与截图写入临时目录，`--out=<绝对路径>` 可指定输出。复制粘贴验收前物化备份系统剪贴板，结束时恢复，不读取个人应用数据。

`node scripts/verify-appearance-settings.mjs` 验证外观设置的真实点击、颜色对比拒绝、字号与减少动态效果保存、刷新恢复、深浅模式及窄窗口可用性，截图保存到系统临时目录。

`pnpm run verify:desktop-permission-v2` 通过真实 Renderer 和本地确定性 Provider 检查权限预设、对话持久化、审批／拒绝、文件边界、Shell 单次审批与降权恢复。检查点场景由 Runner 生成真实中断现场，再使用仍受支持的旧版 `waiting_user` 形态验证 Renderer 恢复；它不改变 durable 恢复机制。该门不验证 OS 级 Shell 沙箱。

`node scripts/verify-posix-shell-authorization.mjs` 在 Linux 或 WSL 上使用真实 `/bin/sh` 和编译后的 ToolExecutionService 验证有限清单的逐 invocation 授权、命令篡改拒绝、硬拒绝和凭据不进入输出；它不替代 Windows Electron Renderer 验收，也不证明 Shell 被 OS 隔离。

`node scripts/verify-void-ring.mjs` 在最新桌面构建中验证品牌动效：空白对话与启动页的真实像素变化、本地 SSE 夹具经 Runtime 驱动的加载/思考/完成状态、深浅主题下的透明外部与不透明球体、减少动态效果的透明静态回退以及图标与输入框的布局间距。它使用隔离数据根，不访问用户会话或真实 Provider。

`node scripts/verify-file-preview-content.mjs` 使用隔离文件和真实 Electron，在编辑器首次加载及预热后逐个打开代码、配置、普通文本、Markdown、HTML 和图片。文本断言核对界面实际内容与磁盘一致，空文件允许为空；还通过真实键盘输入核对用户主动清空的草稿在切换和重新加载后保留。`--out=<绝对路径>` 可指定截图和报告位置，默认写入系统临时目录。

`node scripts/verify-ui-refinement.mjs` 使用显示的隔离 Electron 与本地确定性 Provider，留存首页、长回复、分屏／全屏文件预览、设置各页、供应商弹窗和添加菜单的深浅主题截图。它断言窗口无整体横向溢出、实际窗口尺寸切换、大字号通过界面保存、Escape 关闭弹窗，以及 Renderer 无未捕获异常。`--out=<绝对路径>` 指定报告目录；美观程度仍需查看真实截图，不由源码断言替代。

涉及窗口顶栏、拖动区域或顶栏控件时，使用 `pnpm run verify:window-layout` 的原生命中检查。DOM 命中和 CDP 合成点击不能证明 Windows 原生鼠标按下会送到页面。共享探针在 `scripts/lib/native-hit-test.mjs`；自检入口为 `node scripts/probe-native-hit-test.mjs`，只验证探针能区分 `HTCLIENT` 与 `HTCAPTION`，不替代产品门。

原生命中检查要求窗口保持可见并由系统合成；停放到屏幕外或隐藏窗口会使拖动区结果失真。其他 UI 验收是否需要显示窗口，以相应门的断言为准。

`node scripts/verify-chat-reading-layout.mjs` 在显示的隔离 Electron 中验证对话区布局：输入前后保持底部位置且正文不被输入区遮盖，悬浮无提示框、点击打开用量／执行记录并用 Esc 返回焦点，运行过程默认收起，停止入口可用，目录合并问答、搜索及键盘跳转，窄窗口保留多行草稿且不溢出，失败折叠后仍有提示和重试。数据、截图和报告写入系统临时目录，不读取用户会话或真实 Provider。

`node scripts/verify-chat-navigation.mjs` 使用隔离历史对话和显示的 Electron，验证左侧刻度、悬停预览及离开收起、消息跳转、完整目录入口、标题单击编辑与保存／取消、刷新恢复，以及 320 像素聊天区中的弹层边界和横向溢出。无需 Provider，截图与报告写入系统临时目录。

`node scripts/verify-conversation-resources-motion.mjs` 在显示的隔离 Electron 中验收对话区右上角“对话文件与来源”面板：关闭时不挂载面板子树，打开后四边边框为 0、投影不含 1px 描边环且保留 12px/32px 阴影，面板停在容器右缘的静止位置并从右侧 24px 处滑入，关闭时先向右收回再由动画结束后卸载并交还焦点，退出动画期间重开只保留一个面板，窄聊天区不产生横向滚动条，开启减少动态效果时直接停在静止位置。数据、截图与报告写入系统临时目录，不读取用户会话或真实 Provider。

`pnpm run verify:settings-transition` 在显示的隔离 Electron 中验收设置页的进入与返回：冷进入在懒加载视图首帧前保留原侧栏并在同一帧完成换轨，热进入首帧即绘制设置轨，两次侧栏文字不得同时出现或同时缺失，返回文字不等半秒且关闭控件在退出期间不可点击，连续反转不残留过期回调，草稿保留，减少动态效果仍生效。数据与截图写入系统临时目录，不读取用户会话或真实 Provider。

## 脚本所有权

`node scripts/measure-session-history.mjs` 使用隔离的 240 条富文本历史与显示的 Electron，测量首次打开、缓存切换到绘制的时间，并检查更早内容分页后消息无重复、当前内容保留。数据与报告写入系统临时目录；耗时取决于本机和夹具，不代表所有用户对话。

- `check-repository-hygiene.mjs` 与相邻测试拥有仓库导航和结构门禁。
- `verify-*.mjs` / `measure-*.mjs` 拥有各自行为与测量的断言；实际输出记录在测试报告，不复制进本索引。
- `scripts/lib/` 放多个门共享的隔离 Electron、Provider、产物路径和原生命中探针。
- 自治实验脚本只服务对应活动任务书，不是产品发布门；预算、样本与结果保存在仓库外。
- `windows-sandbox-poc/` 是 P3-A 的 Windows 实验启动器；它只调用实验性 `processmodel.dll` 接口，不接入产品执行器。`pnpm run poc:windows-sandbox` 的结果必须按当前主机单独解释，不能当成生产隔离验收或自动审批依据。
- `scripts/ga04/` 是 GA-04「Agent 约束精简」配对试验的可复现实验定义（E3 隐藏 oracle、哨兵 seed／audit），**不是产品门禁**：不接入 `check:repo` 或 CI。哨兵审计只输出哈希与 pass-fail，永不回显哨兵内容；用法与它证明不了什么见 [scripts/ga04/README.md](ga04/README.md)。

机器检查 `docs/README.md` 的四类入口及分层导航。package README 由各 package 自己维护；普通私有源码、测试、样式和时间戳变化不触发 README 更新。

`verify-conversation-timeline.mjs` 使用隔离 Electron 和本地 Provider 验证工具前后文字保留、原生文件操作、历史重载及短详情不会误显跳到底部按钮。`verify-conversation-model-isolation.mjs` 验证会话切换、重载后的模型与草稿隔离，并检查实际 HTTP 模型请求和应用默认值。恢复播放按钮与权限降级续跑由 `verify-desktop-permission-v2.mjs` 覆盖。
