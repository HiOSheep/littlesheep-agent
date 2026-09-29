# Renderer Settings

Settings 呈现 Main 提供的配置与工具。它拥有页面导航和临时表单状态；Main 拥有持久值、密钥、Provider 检查和运行时效果。

## 契约

- 页面 id 是持久导航值。重组分类时保留现有 id，或提供明确迁移。
- 各页面用共享状态视图区分加载、成功但为空、不可用和失败。数据源允许时，刷新失败应保留仍可用的旧值。
- 区分草稿、已保存和当前生效状态。Provider 编辑的敏感草稿只留在内存，不进入日志或搜索索引。
- 设置搜索只索引安全、可见的字段标签和值，支持键盘移动、选择、焦点转移和 Escape 返回。密钥、cookie 和私有草稿永不索引。
- 禁用操作同时显示与禁用原因相同事实来源的说明。
- Token Usage 展示 Main 提供的有界每日用量 projection；不通过累加可见消息重算，并区分空、缺失、未来、partial 与真实零值。
- 共享视觉角色和圆角材质见 `ui/README.md`。

局部导航、搜索与 reducer 由设置测试覆盖；真实窗口入口包括 `verify:model-provider-ui`、`verify:settings-navigation-terminology`、`verify:skills-catalog-states` 和 `verify:channel-entry-states`。用量聚合与隐私边界由 Main 测试覆盖。
