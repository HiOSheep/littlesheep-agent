# Renderer 运行选项
最后更新：2026-09-22 12:41:58

这里保存供设置页和输入栏共同使用的显示层选项元数据：`MODE_OPTIONS`（三档权限模式、风险等级与说明，`composer/mode-picker.tsx` 和 `ui/icons.tsx` 使用）、`PROFILE_OPTIONS`（Agent 行为 profile，`settings/agent-profile.tsx` 使用）和 `REASONING_OPTIONS`（推理档位，`composer/runtime-picker.tsx` 使用）。

它只负责显示文案，不替代 Main 的运行时配置校验，也不决定可用模型、权限判定或执行策略。
