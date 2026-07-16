# @littlesheep/memory-tree

最后更新：2026-07-16 15:55:18

实现索引优先的记忆树、统一 Memory Service、T0-T3 资源注册、项目投影、Memory v3 数据层和资源生命周期。

## 职责与边界

- 公开入口是 `src/index.ts`；`memory-service.ts` 与 `memory-repository.ts` 是稳定门面，内部协调器分别位于 `memory-service/` 和 `memory-repository/`，`memory-tree.ts` 负责导航。
- `conversation-source-store.ts` 保存用户输入与对话区可见内容形成的对话原始来源；`src/v3/` 拥有 atom projections、投影变更记录、有界事件/操作 journal、SQLite catalog、FTS/向量、启动恢复协调、有界维护 worker、实体关系与引用治理。对话来源证明当时收到了或展示了什么；投影变更记录只负责幂等、恢复和审计；atom 是可治理投影。
- `src/memory-repository/v3-migration*.ts` 与 `repository-locator.ts` 负责隔离的 v2→v3 快照、映射、构建、校验、原子提交、恢复和回滚；运行中的 v3 backend 通过同一验证核心提供只读回滚就绪检查，只有 v2 源与 v3 当前状态均未变化时才允许登记重启回滚。它们不会自动迁移正式用户数据。
- 读取遵循根索引、分支索引、按需展开和分支内深搜；首次请求只选择有界 D2 working set，执行中可 release 当前 atom。写入先持久化 Atom 引用的对话原始来源，再写投影变更记录，并更新带 parent、scope、tier、`sourceRefs`、`evidenceRefs` 和认识状态的 atom 投影。
- 禁止默认跨树向量召回、复制 UI 专用记忆，或让用户项目文件自动变成长期记忆。

## 依赖与数据

- 依赖 memory-core、安全和公共契约；Runner、Harness 和 App 只通过公开服务访问。
- 拥有记忆树仓库、资源注册表、审计、项目投影和工作区元数据索引，不拥有外部文件正文。
- 正式配置仍默认使用 v2。v3 只允许在有效实验标记或活动迁移 locator 的数据根中打开；locator 存在时优先并失败关闭。

## 测试与修改定位

- 双后端行为契约位于 `src/memory-repository.contract.test.ts`。
- v2→v3 安全迁移、实时回滚预检与故障注入位于 `src/memory-repository/v3-migration.test.ts`；App validator 透传位于 `packages/app/src/main/memory-v3-migration-control.test.ts`。
- 对话原始来源不可改写测试位于 `src/conversation-source-store.test.ts`；Memory v3 的投影变更记录保留/孤儿恢复、10,000 atom 扫描、catalog 重建、离线向量批处理、due 补偿、关系引用治理、边界检索和故障重放测试位于 `src/v3/*.test.ts` 与 `src/memory-repository/v3-*.test.ts`。
- 修改持久格式时必须提供版本化迁移、回滚、重启恢复和防数据丢失证据。
