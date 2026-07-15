# Electron Renderer

Renderer 负责聊天、导航、设置、记忆树、归档和拓展工作区的可视交互。

## 入口与所有权

- `main.tsx`：React 挂载。
- `App.tsx`：7 行兼容入口，只装配 `app-shell` 控制器和视图。
- `app-shell/`：顶层视图、导航历史和控制器组合。
- `approval/`、`chat/`、`composer/`、`runtime/`、`settings/`、`sidebar/`、`ui/`、`workspace/`：按责任域拆分的 Renderer 实现。
- `api.ts`：21 行 Local App API 兼容 barrel；领域客户端位于 `api/`。
- `TraceCard.tsx`、`MemoryTreeView.tsx`、`ArchiveManager.tsx`、`Settings.tsx`：仍保留的独立领域视图；后续拆分必须保持兼容入口。

Renderer 拥有临时 UI 状态和交互编排，不拥有会话、记忆、项目、密钥或工作区文件的权威数据。

## 依赖与禁止事项

- 只能通过 `api.ts` 或后续领域客户端访问主进程能力。
- 禁止直接使用 Node.js、读写用户数据、复制主进程索引或自行执行工具。
- 动画、浮层、导航和渐进式披露遵守 `docs/principles/ui-interaction-guidelines.md`。

## 测试与修改定位

- 纯状态、历史、布局和 Context 展示测试与实现同目录；跨域行为优先添加 shared contract 或 controller 特征测试。
- 视觉或交互变更还需构建、刷新桌面快捷方式并进行真实窗口验收。
