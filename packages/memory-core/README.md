# @littlesheep/memory-core

提供文件型记忆的兼容存储、写入闸门、daily/长期层级、归档和旧来源适配。

## 职责与边界

- 公开入口是 `src/index.ts`；存储在 `store.ts`，写入在 `write-memory.ts`，归档在 `archive.ts`。
- 作为底层兼容基元被 Memory Service 使用，不负责树形导航 UI、项目投影或 Context 选择。
- 禁止新增绕过 `@littlesheep/memory-tree` 注册和审计的新主运行时写入路径。

## 依赖与数据

- 依赖配置、LLM、安全、向量和公共契约。
- 拥有其文件格式的原子写入与备份语义；用户可见权威索引由 Memory Service 协调。

## 测试与修改定位

- 存储、写入、向量装饰和归档测试与实现同目录。
- 旧 helper 变更必须验证迁移兼容，不能静默改写正式用户数据。
