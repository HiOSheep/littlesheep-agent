# OpenCode VS Code 对标记录（2026-08-13）

最后更新：2026-08-13 21:44:48

## 结论先行

本次核对的 OpenCode 仓库是 [anomalyco/opencode](https://github.com/anomalyco/opencode)，默认分支为 `dev`，对标源码 commit 为 `cc4b45612974f735ddec46009ede07729511fba4`，仓库许可证为 MIT。

OpenCode 的 VS Code 扩展不是第二个 IDE。已安装的 `sst-dev.opencode-0.0.13` 扩展包约 10.8 KB，只包含一个终端/HTTP 桥接：复用 VS Code 原生终端、文件树、编辑器、语法服务和行号，把当前文件或选区转换为 `@relative/path#Lstart-end` 后注入 OpenCode TUI。它没有 Webview、Monaco、自己的文件树或 Diff 渲染器。

LS 当前的“内置 VS Code 模块”是 LS 自有 Electron 工作区中的 Monaco 工作台，不是 VS Code Extension Host。两者不能按同一产品形态直接复制；本记录只吸收能改善 LS 等待时间、内存和审阅交互的设计。

## 能力差异

| 领域 | OpenCode / VS Code 做法 | LS 当前实现 | 判断 |
| --- | --- | --- | --- |
| 编辑器来源 | VS Code 原生编辑器和语言服务 | 共享 Monaco，代码查看、编辑、Git Diff 统一 | LS 应保持 Monaco，不引入第二套编辑器 |
| 文件树 | 目录按需 list；模型层预构建 children；迭代 flatten；TanStack virtual 只挂载可视行，稳定 28px 行高、overscan 10 | 目录有 128 条、5 秒 stale-while-revalidate 缓存，但展开后递归挂载全部行 | 大仓库虚拟化是后续高优先级选项 |
| 文件内容 | 40 条、总计 20 MiB 的 byte-aware LRU；活动文件可 keep；视图状态另有有界缓存并在淘汰时 dispose | 之前只有目录/Git 快照缓存；文件正文按标签重新请求 | 已加入 LS 文件预览 byte-LRU 和跨挂载恢复 |
| Git 审阅 | 先取得文件列表；当前选中文件缺 patch 时再加载详情；请求带 version；按文件路径保持预览实例 | 快照/Diff 分离、Main revision 隔离和 Monaco Diff | 已补 Diff 20 MiB 字节预算、请求取消、Main 快照复用和 Diff 并发上限 |
| 审阅交互 | 文件过滤、上下键导航、Enter 打开、侧栏开关/宽度持久化、Diff 样式/展开模式、行级评论 | 红绿 Monaco Diff、分层 staged/unstaged/untracked、与文件查看一致的右侧导航、单列/双列按钮和基本树刷新 | 已加入临时过滤、键盘导航、共享导航外壳和持久化单列/双列模式；宽度沿用工作区导航状态，评论留待产品选择 |
| 状态边界 | 侧栏开关/宽度/展开模式持久化；过滤条件刻意不持久化，避免刷新后隐藏文件 | LS 工作区布局和标签持久化，审阅过滤此前不存在 | 过滤按临时态加入；不写入工作区持久化快照 |
| 更新机制 | 应用层通过事件/资源更新，避免无意义全量刷新 | LS 以可见性、焦点、文件变更和 30 秒兜底刷新 Git | 保留现有低后台占用策略，暂不引入复杂全局事件总线 |
| 体积 | 扩展约 10 KB，几乎无额外运行时 | Monaco 运行时和 worker 资产是主要体积 | 不复制 OpenCode Desktop、Solid 状态层或 SDK |

## 本轮已直接加入 LS

### 1. 文件预览 byte-aware LRU

`file-preview-cache.ts` 使用共享 `bounded-byte-lru.ts`，默认最多 40 个预览、估算总量 20 MiB、TTL 5 秒。文件标签重新挂载时先显示缓存正文，随后后台校准；同一路径并发读取合并。保存成功会把新预览写入缓存；如果早先的读取请求晚到，不得覆盖保存结果。

这解决的是“切换到刚看过的文件仍先出现白色/读取占位”的确定性缺口，不改变文件读取权限或正文上限。

### 2. Git Diff 字节预算

`review-cache.ts` 继续保留 32 条 Diff 上限和 revision key，并新增默认 20 MiB 的估算字节上限。大 Diff 会优先淘汰最老的已完成项；正在进行的请求不被强行中断，当前快照与 Diff 的版本隔离不变。

### 3. Monaco 模型和面板切换稳定性

普通文件现在使用由工作区/路径派生的稳定 `inmemory://` 模型路径并保存视图状态。共享 `monaco-model-cache.ts` 对模型实行最多 40 条、估算 20 MiB 的有界 LRU，只淘汰没有活动编辑器引用的模型；面板移除了 `key={activeTab}` 的整面强制重建，减少切换时重复创建编辑器表面；Monaco 仍按需加载，未增加语言服务 worker。

### 4. 审阅过滤和键盘导航

审阅工具栏增加临时路径/状态过滤。过滤输入支持 `ArrowUp`、`ArrowDown`、`Enter` 和 `Escape`；过滤后的树保留必要的目录祖先，统计只显示当前筛选结果。过滤条件不持久化，刷新后不会意外隐藏文件。

### 5. Main 审阅快照和 Diff 请求边界

Main 进程现在全局最多保留 8 个工作区的快照，每条使用 5 秒短 TTL；同一路径并发扫描合并，Diff 请求必须携带快照返回的 opaque `revision`。版本更新或快照淘汰时，旧 Diff 会被取消并以 409 让 Renderer 重新获取快照；同时最多运行 2 个 Diff Git 任务。这样选中文件不会再次触发完整 status/numstat 扫描，也不会因快速切换积累后台 Git 进程。

## 尚未直接引入的能力

### 大规模文件树虚拟化

这是 OpenCode 对大仓库体验最重要的结构性优势，但会改动 LS 当前递归树的键盘、展开、筛选和可访问性实现。建议下一阶段先建立 1,000/10,000 行展开基准，再选择自实现固定行虚拟化或引入轻量现有库；不要为了一个列表引入完整 Solid 运行时。

### 审阅侧栏尺寸、Diff 样式与展开模式

OpenCode 持久化侧栏开关、宽度和展开模式，但过滤仍是临时态。LS 已把审阅导航接入普通文件导航的共享折叠状态，并在 Diff 标题行提供单列/双列显式切换；偏好以 `WORKSPACE_REVIEW_SIDE_BY_SIDE_KEY` 保存，默认双列。仍可后续补审阅侧栏独立宽度和行级评论，但不能重新引入第二套目录扫描或活动页面。

### 行级评论

OpenCode 的评论依赖会话、行范围、焦点和持久化协议。LS 当前审阅是只读 Git 工作区，没有评论存储和 Runtime 合约；直接复制 UI 会制造无后端的假交互，因此暂缓。

### 真正的 LS VS Code 扩展

若目标是获得 VS Code 原生语言服务和文件树的零额外加载，应另建一个 MIT/自有许可边界清晰的 VS Code SDK 项目，采用 OpenCode 的“薄终端桥 + 当前文件引用”路线。它与 LS 内置 Monaco 工作台是两个产品面，不能通过把 OpenCode Desktop 前端嵌入 LS 来替代。

## 版权与复用

- OpenCode 仓库和 VS Code SDK 在本次核对位置标注 MIT；若以后直接复制具体源码，必须保留 MIT 文本、版权声明、来源路径和 commit。
- OpenCode Desktop 的 UI、图标、字体、Solid 状态层和服务端协议不能因为仓库整体 MIT 就自动视为适合整体搬入；每个资源和依赖仍需单独核对许可证与体积。
- 本轮实现是 LS 自己的 TypeScript/React/Monaco 代码，没有复制 OpenCode 源文件或引入其依赖。

## 证据来源

- VS Code SDK：[sdks/vscode/src/extension.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/sdks/vscode/src/extension.ts)
- 文件树模型与虚拟化：[file-tree-v2-model.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/src/components/file-tree-v2-model.ts)、[file-tree-v2.tsx](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/src/components/file-tree-v2.tsx)
- 内容/视图缓存：[content-cache.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/src/context/file/content-cache.ts)、[view-cache.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/src/context/file/view-cache.ts)、[scoped-cache.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/src/utils/scoped-cache.ts)
- 审阅面板与状态：[review-panel-v2.tsx](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/src/pages/session/v2/review-panel-v2.tsx)、[review-panel-v2-state.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/src/pages/session/v2/review-panel-v2-state.ts)
- 回归/缩放测试：[review-pane-scaling-benchmark.spec.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/e2e/performance/timeline/review-pane-scaling-benchmark.spec.ts)、[review-tab-switch.spec.ts](https://github.com/anomalyco/opencode/blob/cc4b45612974f735ddec46009ede07729511fba4/packages/app/e2e/regression/review-tab-switch.spec.ts)
