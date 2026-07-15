# Renderer 输入栏

这里负责用户输入、附件、工作区上下文、权限模式、模型/推理选择和上下文占用展示。

- `add-menu.tsx`、`message-files.tsx`、`workspace-chip.tsx`：输入辅助控件。
- `mode-picker.tsx`、`runtime-picker.tsx`、`context-usage-indicator.tsx`：运行配置控件。
- `input-size.ts`：输入框高度同步。

模型能力和权限策略来自 shared/runtime 配置；这里不保存密钥，不自行执行文件或工具操作。
