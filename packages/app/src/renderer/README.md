# Electron Renderer

Renderer 负责聊天、导航、设置、记忆树、归档和拓展工作区的可视交互。

## 入口与所有权

- `main.tsx`：React 挂载。
- `App.tsx`：当前兼容组合壳，后续按领域抽取，不再接收无关新逻辑。
- `api.ts`：当前 Local App API 兼容客户端，后续按领域拆分。
- `TraceCard.tsx`、`MemoryTreeView.tsx`、`ArchiveManager.tsx`、`Settings.tsx`：已有领域视图。

Renderer 拥有临时 UI 状态和交互编排，不拥有会话、记忆、项目、密钥或工作区文件的权威数据。

## 依赖与禁止事项

- 只能通过 `api.ts` 或后续领域客户端访问主进程能力。
- 禁止直接使用 Node.js、读写用户数据、复制主进程索引或自行执行工具。
- 动画、浮层、导航和渐进式披露遵守 `docs/ui-interaction-guidelines.md`。

## 测试与修改定位

- 纯状态、历史、布局和 Context 展示测试与实现同目录。
- 视觉或交互变更还需构建、刷新桌面快捷方式并进行真实窗口验收。
