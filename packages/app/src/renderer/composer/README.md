# Renderer 输入栏
最后更新：2026-09-22 23:39:50

这里负责用户输入、附件、工作区上下文、权限模式、模型/推理选择和上下文占用展示。

- `add-menu.tsx`、`message-files.tsx`、`workspace-chip.tsx`：输入辅助控件、附件预览与消息正文装配。
- `mode-picker.tsx`：三档权限模式选择，以及切到完全访问时的危险确认。
- `runtime-picker.tsx`、`context-usage-indicator.tsx`：模型与推理档位选择、上下文占用展示。
- `runtime-availability.ts`：无可用模型时的唯一状态来源。区分“配置读取中”“读取失败（可重试）”“还没有配置（给出配置入口）”“已保存但不可用（缺密钥或缺模型条目）”，并用设置页同一个 `isConfiguredProvider` 判定“已配置”，因此选择器与供应商页不会对同一份配置给出不同结论；`runtime-picker.tsx` 的空菜单据此显示“配置模型 / 检查供应商配置 / 重试读取”，并保留当前草稿不动。
- `context-usage-indicator.tsx` 的弹层同时给出上下文占用与会话累计缓存命中（`formatSessionCache`）；usage 未上报的请求会在文案里标注，不把局部读数当成完整读数。
- `input-size.ts`、`focus-routing.ts`：输入框高度同步和输入焦点归属判定。

输入栏的 Enter、Shift+Enter 与输入法组词规则位于 `../ui/enter-confirm.ts`，由 `app-shell/composer-view.tsx` 使用；不要在这里或视图中另写 Enter 判断。

模型能力和权限策略来自 shared/runtime 配置；这里不保存密钥，不自行执行文件或工具操作。
