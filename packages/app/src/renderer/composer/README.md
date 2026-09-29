# Renderer Composer

Composer 管理草稿输入、焦点、模型选择展示和 run 提交交互。Main 校验模型、权限和 Runtime 就绪状态；发送按钮可用不等于已获得执行权限。

## 契约

- 草稿与附件属于当前会话。切换会话后恢复对应草稿，不得把未发送内容带入另一会话的模型请求。
- 发送按钮、键盘提交和空对话提示共用同一个 readiness 判定。没有可用模型或执行能力时，本地拒绝并说明原因，不发送 run 请求。
- 模型／Provider 选择和密钥由 Main 持久化。敏感值只留在宿主密钥存储，不进入日志、搜索索引或 UI 摘要。
- 保留 IME 组合语义：Enter 确认候选词时不得发送。模态、审批或用户正在编辑其他字段时，焦点管理不能抢走焦点。
- 权限模式是用户设置。Composer 可展示并请求变更，工具操作仍由 Runtime 授权。

定向测试覆盖提交就绪、草稿会话归属、焦点与模型可用性；Electron 入口为 `verify:composer-send-gate`、`verify:composer-focus`、`verify:composer-draft-scope`。源码测试不能证明真实 IME 行为。
