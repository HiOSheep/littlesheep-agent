# Renderer 输入栏
最后更新：2026-09-26 20:10:21

这里负责用户输入、附件、工作区上下文、权限模式、模型/推理选择和上下文占用展示。

- `add-menu.tsx`、`message-files.tsx`、`workspace-chip.tsx`：输入辅助控件、附件预览与消息正文装配。
- `mode-picker.tsx`：三档权限模式选择，以及切到完全访问时的危险确认。
- `runtime-picker.tsx`、`context-usage-indicator.tsx`：模型与推理档位选择、上下文占用展示。
- `runtime-availability.ts`：无可用模型时的唯一状态来源。区分“配置读取中”“读取失败（可重试）”“还没有配置（给出配置入口）”“已保存但不可用（缺密钥或缺模型条目）”“供应商可用但还没选模型（`no-selection`）”，并用设置页同一个 `isConfiguredProvider` 判定“已配置”，因此选择器与供应商页不会对同一份配置给出不同结论；`runtime-picker.tsx` 的空菜单据此显示“配置模型 / 检查供应商配置 / 重试读取”，并保留当前草稿不动。**`no-selection` 与 `unusable` 必须分开**：供应商已保存、密钥和模型条目都在、只是还没选模型时，选择器要说“还没有选择模型”并指向菜单里的模型列表；说成“可能缺少 API 密钥，或没有填写模型条目”会把用户送回设置页去改一份本来正确的配置（UX-11 实机验收发现并修掉）。
- `context-usage-indicator.tsx` 的弹层同时给出上下文占用与会话累计缓存命中（`formatSessionCache`）；usage 未上报的请求会在文案里标注，不把局部读数当成完整读数。
- `input-size.ts`、`focus-routing.ts`：输入框高度同步和输入焦点归属判定。
- 发送入口的可用性：`app-shell/composer-view.tsx` 同时参考 Runtime 就绪事实（`runtime-readiness/use-runtime-readiness`）。窗口早于 Runner 出现，未就绪时发送必须在原地禁用并使用 Runtime 给出的原因，草稿与焦点不变；不得只凭“草稿非空”就放出可点击的发送入口。

输入栏的 Enter、Shift+Enter 与输入法组词规则位于 `../ui/enter-confirm.ts`，由 `app-shell/composer-view.tsx` 使用；不要在这里或视图中另写 Enter 判断。

**输入栏弹出的面板与输入框同一种材质**：`styles/06-composer.css` 里有一条共享规则，把 `.add-menu-panel`、`.model-picker-panel`（权限选择器是它的一个变体）、`.runtime-menu-shell .runtime-picker-panel` 与其 `.runtime-submenu` 统一成 `background: var(--composer-surface)`（`rgba(32, 32, 32, 0.75)`）+ `backdrop-filter: blur(18px) saturate(135%)` + `border: 0`，也就是输入框原来的半透明磨砂玻璃、且不带描边。各面板的几何、圆角与阴影仍归自己所有，**材质只在这一处声明**——新增输入栏弹层时把它加进那条共享规则的选列表，不要在面板体里另写背景或边框。真实窗口实测（2026-09-26）：四个面板与 `.composer` 的计算值都是 `rgba(32, 32, 32, 0.75)` + `blur(18px) saturate(1.35)` + `border-width: 0px`；面板圆角 10px、输入框 14px 保持不变。

模型能力和权限策略来自 shared/runtime 配置；这里不保存密钥，不自行执行文件或工具操作。
