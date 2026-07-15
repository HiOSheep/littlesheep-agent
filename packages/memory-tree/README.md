# @littlesheep/memory-tree

最后更新：2026-07-15 16:35:02

实现索引优先的记忆树、统一 Memory Service、T0-T3 资源注册、项目投影和资源生命周期。

## 职责与边界

- 公开入口是 `src/index.ts`；`memory-service.ts` 与 `memory-repository.ts` 是稳定门面，内部协调器分别位于 `memory-service/` 和 `memory-repository/`，`memory-tree.ts` 负责导航。
- `src/v3/` 是尚未接管正式运行路径的 Memory v3 隔离数据层：契约、原子文件、事件/操作 journal、SQLite catalog、Embedding 控制器、有界维护 worker、实体关系与引用治理、优先级和恢复协调器均在这里；v2→v3 适配与正式迁移尚未启用。
- 读取遵循根索引、分支索引、按需展开和分支内深搜；写入记录 parent、scope、tier、来源与理由。
- 禁止默认跨树向量召回、复制 UI 专用记忆，或让用户项目文件自动变成长期记忆。

## 依赖与数据

- 依赖 memory-core、安全和公共契约；Runner/Harness/App 只通过公开服务访问。
- 拥有记忆树仓库、资源注册表、审计、项目投影和工作区元数据索引，不拥有外部文件正文。

## 测试与修改定位

- 仓库、服务、树、项目投影、迁移和压力恢复测试均位于 `src/*.test.ts`。
- Memory v3 的隔离契约、10,000 atom 扫描、catalog 重建、离线向量批处理、due 补偿、关系引用治理、边界检索和故障重放测试位于 `src/v3/*.test.ts`。
- 修改持久格式时必须提供版本化迁移、回滚和重启恢复证据。
