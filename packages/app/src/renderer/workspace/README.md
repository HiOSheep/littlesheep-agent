# Renderer Workspace

Workspace 呈现文件／目录、预览、Git review、浏览器标签和用户控制的终端。Main 与领域服务拥有文件系统访问、执行和路径授权。

## 资源与权限边界

- 除非路径位于应用数据根内，用户选择的项目或目录仍是外部资源。选择用于显示不等于允许 Agent 扫描或执行。
- 研究与受限模式须先取得相应批准，才能自动读取外部或范围不明资源。完全访问遵循用户显式确认后的策略；Main 仍执行硬拒绝。
- Renderer 通过 Local App API 请求文件和终端能力；不使用 Node 文件 API，也不把界面选中的路径当作授权。
- Main 重新检查 Agent shell 操作。用户自行打开和输入的交互终端属于用户操作，不弹 Agent 审批。

## 文件编辑与 review

- 完整、未清洗的文件读取才可建立观察版本；partial、truncated、二进制预览或清洗后的读取不能授权覆盖。
- 修改已有文件前，Main 复核已观察的内容哈希。其他操作者已改文件时返回 stale／missing observation 并保留用户草稿。
- 保存与 review 响应有界且明确标记失败或截断。保存失败不能清空草稿。
- Git review 是仓库快照，不是单个脏文件的原子快照；opaque revision 和不稳定读取状态须保留，不得夸大一致性。
- Monaco 在文件查看、编辑和 Git review 之间共享；模型、预览与浏览器历史需有界。
- Monaco 与仍运行的 xterm 实例订阅应用外观变化并更新主题／字号，不因切换主题重建文件模型或终端会话；原始文档与 HTML 预览内容不强制反色。
- 产物列表用共享状态视图区分加载、空结果和读取失败；失败状态的重试调用现有刷新动作。

## 预览与验证

静态 HTML 使用 sandbox frame，不执行页面 JavaScript。相对资源只经 Main 的有界 loopback preview service 和路径检查提供。运行页面是单独的显式操作，使用隔离 guest，不自动启动项目脚本。

观察与写入使用 `verify:file-consistency-faults`、`verify:desktop-file-consistency`；预览使用 `verify:html-preview-baseline`；Git 刷新使用 `verify:review-refresh-errors`；工作区与交互终端使用 `verify:conversation-workspace-scenarios`。这些入口证明不同边界。
