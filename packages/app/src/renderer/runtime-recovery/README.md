# Renderer 启动恢复

本目录负责发现未完成 run、展示安静的恢复入口、查看诊断并请求续跑或放弃。恢复资格、副作用结算与 checkpoint 真相由 Runtime／Main 决定。

## 边界

- 只有 Runner readiness 到达后才开始发现 checkpoint；发现失败不能显示成“没有待恢复任务”。
- 列表重试只重新扫描，不重复执行已结算操作。续跑身份保持稳定，避免不确定传输造成重复提交。
- 失败信息、可恢复状态与诊断计数来自 Main projection；Renderer 不推断磁盘内容，也不改写 Runtime 原因。
- 恢复弹窗遵守共享模态层焦点规则；Escape 表示稍后处理，不代表放弃任务。

checkpoint 与 API 边界由 Runner／Main owner 文档维护。本地状态和请求 identity 使用同目录测试；五种桌面恢复状态由 `verify:recovery-states` 覆盖。
