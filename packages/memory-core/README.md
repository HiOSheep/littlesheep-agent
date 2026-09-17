# @littlesheep/memory-core

提供文件型记忆的兼容存储、写入安全策略和旧来源适配。

## 职责与边界

- 公开入口是 `src/index.ts`；兼容存储在 `store.ts`，旧工具写入安全检查在 `write-memory.ts`。
- 作为底层兼容基元被 Memory Service 使用，不负责树形导航 UI、项目投影或 Context 选择。
- 禁止新增绕过 `@littlesheep/memory-tree` 注册和审计的新主运行时写入路径。
- 旧 `daily -> MEMORY.md` 原文追加、月/年 Markdown 摘要和独立远程向量维护入口均已退役；未来 daily 提升或压缩只能生成结构化 Memory v3 写入提案，并经过来源、认识状态、去重、审计和恢复校验。

## 依赖与数据

- 依赖安全和公共契约，不拥有 Provider 调用或向量目录。
- 拥有其文件格式的原子写入与备份语义；用户可见权威索引由 Memory Service 协调。

## 测试与修改定位

- 存储与写入测试和实现同目录。
- 修改兼容层必须验证迁移边界，不能重新导出扁平追加、月/年摘要或独立向量 helper，也不能静默改写正式用户数据。
