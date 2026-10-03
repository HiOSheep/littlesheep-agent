# Renderer Composer

Composer 管理草稿输入、焦点、模型选择展示和 run 提交交互。Main 校验模型、权限和 Runtime 就绪状态；发送按钮可用不等于已获得执行权限。

## 契约

- 草稿与附件属于当前会话。切换会话后恢复对应草稿，不得把未发送内容带入另一会话的模型请求。
- 发送按钮、键盘提交和空对话提示共用同一个 readiness 判定。没有可用模型或执行能力时，本地拒绝并说明原因，不发送 run 请求。
- 模型／Provider 选择和密钥由 Main 持久化。敏感值只留在宿主密钥存储，不进入日志、搜索索引或 UI 摘要。
- 保留 IME 组合语义：Enter 确认候选词时不得发送。模态、审批或用户正在编辑其他字段时，焦点管理不能抢走焦点。
- 权限模式是用户设置。Composer 可展示并请求变更，工具操作仍由 Runtime 授权。
- 输入区在空白与已有消息时都保持底部位置，并在布局中占据实际高度；正文视口随多行草稿收缩。就绪／模型阻塞原因位于独立状态行；控制行在窄列可换行，停止与发送入口保持可见。textarea 有可访问名称与 Enter／Shift+Enter 说明。
- 输入卡是一整块实心卡（`--chat-card-fill` + `--chat-card-elevation` + `--radius-composer-input`），不是玻璃层：它不再是任何弹层的 backdrop root，因此卡上弹出的选择器各自采样真实背景。卡面、控件行和行内选择器一起构成对话区的控制面。
- 底部控制行是同一组形状：每个控件都取 `--composer-control-surface-size` 的高度与 `--composer-control-radius` 的圆角；附加按钮是圆形主入口，取 `--radius-pill` 与静息 `--chat-hover-fill`。附加按钮画单一 SVG 加号，不再用两条 1px 伪元素拼十字。发送键是行内唯一的业务蓝实心圆形主操作（`--chat-business`），停止键用危险色角色。

定向测试覆盖提交就绪、草稿会话归属、焦点与模型可用性；Electron 入口为 `verify:composer-send-gate`、`verify:composer-focus`、`verify:composer-draft-scope`。源码测试不能证明真实 IME 行为。
