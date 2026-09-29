# @littlesheep/memory-tree

Memory Tree 拥有索引式长期记忆、实体边界、证据来源和受控持久化变更。公开入口为 `src/index.ts`。UI 是只读 projection；durable 修改由 Runtime 工具与 package API 管理。

## 检索

每个 run 从有界根索引开始，按“根索引 → 分支索引 → 展开”导航。只有同一分支索引仍不足时才可深搜；向量只在该深搜边界提名候选，不能决定实体、事实、纠正目标或合并。

检索须受作用域、预算、去重和来源约束。不得默认注入全树正文或跨树向量搜索。名称、路径、共现和相似度有助导航，但不能证明实体相同。

## 持久写入

`memory_tree` 只读导航。添加 durable 事实唯一走经批准的 `memory_write`，每 run 最多四条，只接受：

- `user-request`：会话来源中必须有真实的记忆指令；
- `necessary`：说明用途，以及不保存会失去什么。

Runtime 核对来源是否存在且完整、作用域与幂等身份。清洗、截断或 external-untrusted 内容不能成为持久事实来源。

`memory_manage` 处理用户要求的遗忘与纠正。目标须存在于本轮导航记录且 revision 一致；纠正按“写替代、记关系、再 supersede”提交，部分失败如实记录停点。

相似度只能提名候选。值冲突、单侧否定或实体不相交时不得合并。会话压缩只生成摘要，不写长期记忆。

## 所有权与验证

活动应用数据根拥有 Memory 文件和内部索引。普通 GUI 仅展示权威记忆文件，且只有 `SOUL.md` 可直接编辑；Atom、关系、向量与审计状态属于 Runtime 内部。

仓库测试覆盖 schema、索引导航、作用域、revision 与幂等。`verify:memory-controlled-writes` 检查隔离根与真实存储路径；`verify:memory-live-model` 属于真实 Provider 证据。迁移与 Provider 连续性须使用隔离副本或明确提供的测试数据，不能使用用户实时记忆。
