# @littlesheep/memory-tree

最后更新：2026-07-16 08:12:11

实现索引优先的记忆树、统一 Memory Service、T0-T3 资源注册、项目投影、Memory v3 数据层和资源生命周期。

## 职责与边界

- 公开入口是 `src/index.ts`；`memory-service.ts` 与 `memory-repository.ts` 是稳定门面，内部协调器分别位于 `memory-service/` 和 `memory-repository/`，`memory-tree.ts` 负责导航。
- `src/v3/` 拥有 Memory v3 的 immutable facts、atom projections、有界事件/操作 journal、SQLite catalog、FTS/向量、启动事实协调、有界维护 worker、实体关系与引用治理。事实是事件真相源，atom 是可治理投影，journal 只负责恢复。
- `src/memory-repository/v3-migration*.ts` 与 `repository-locator.ts` 负责隔离的 v2→v3 快照、映射、构建、校验、原子提交、恢复和回滚；它们不参与日常节点写入，也不会自动迁移正式用户数据。
- 读取遵循根索引、分支索引、按需展开和分支内深搜；首次请求只选择有界 D2 working set，执行中可 release 当前 atom。写入先捕获不可变事实，再更新带 parent、scope、tier、来源和认识状态的 atom 投影。
- 禁止默认跨树向量召回、复制 UI 专用记忆，或让用户项目文件自动变成长期记忆。

## 依赖与数据

- 依赖 memory-core、安全和公共契约；Runner、Harness 和 App 只通过公开服务访问。
- 拥有记忆树仓库、资源注册表、审计、项目投影和工作区元数据索引，不拥有外部文件正文。
- 正式配置仍默认使用 v2。v3 只允许在有效实验标记或活动迁移 locator 的数据根中打开；locator 存在时优先并失败关闭。

## 测试与修改定位

- 双后端行为契约位于 `src/memory-repository.contract.test.ts`。
- v2→v3 安全迁移与故障注入位于 `src/memory-repository/v3-migration.test.ts`。
- Memory v3 的 immutable fact 保留/孤儿恢复、10,000 atom 扫描、catalog 重建、离线向量批处理、due 补偿、关系引用治理、边界检索和故障重放测试位于 `src/v3/*.test.ts` 与 `src/memory-repository/v3-*.test.ts`。
- 修改持久格式时必须提供版本化迁移、回滚、重启恢复和防数据丢失证据。
