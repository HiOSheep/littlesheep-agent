# Renderer 输入栏
最后更新：2026-09-22 12:41:58

这里负责用户输入、附件、工作区上下文、权限模式、模型/推理选择和上下文占用展示。

- `add-menu.tsx`、`message-files.tsx`、`workspace-chip.tsx`：输入辅助控件、附件预览与消息正文装配。
- `mode-picker.tsx`：三档权限模式选择，以及切到完全访问时的危险确认。
- `runtime-picker.tsx`、`context-usage-indicator.tsx`：模型与推理档位选择、上下文占用展示。
- `input-size.ts`、`focus-routing.ts`：输入框高度同步和输入焦点归属判定。

模型能力和权限策略来自 shared/runtime 配置；这里不保存密钥，不自行执行文件或工具操作。
