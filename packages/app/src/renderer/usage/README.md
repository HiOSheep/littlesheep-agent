# Renderer 用量展示

Token 用量页只读 Main 持久化的 Provider 日用量 projection，不自行统计、归日或补造服务端能力。

## 数据语义

- 页面按日展示 API 返回的总量／输入／输出，并可按有记录的 Provider 和模型筛选；总量、活跃天数和峰值直接使用响应汇总。
- `empty`（无调用记录）、`recorded` 且值为零、`partial`（有调用但 usage 不全）、`future` 与 projection 中缺失的日期是不同事实，界面不得合并成零。
- 时区、覆盖范围、未完成回填和身份列表截断均来自响应；Renderer 展示这些限制，不根据本机日期自行推断。
- 仅在消费 API 允许的天数和身份数范围内请求；Renderer 不读取会话全文、密钥或隐藏模型数据。

页面与导航由 Settings 组合；API 类型由 shared／types 和 Main usage route 所有。局部热力图与导航行为由相邻测试覆盖，服务聚合和隐私边界由 Main 测试验证。
