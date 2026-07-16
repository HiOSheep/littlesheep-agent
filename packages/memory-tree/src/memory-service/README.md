# Memory Service 内部边界

本目录实现 `MemoryService` 背后的作用域协调器，不直接成为新的公开入口。

- `run-coordinator.ts`：run 开始/结束、运行级资源登记与失效。
- `source-feedback.ts`：对话原始来源持久化，以及由 VERIFY/工具证据约束的 Atom 使用反馈。
- `summary-resources.ts`、`attachment-resources.ts`、`runtime-event-resources.ts`：会话摘要、附件和事件账本的独立生命周期。
- `bootstrap-resources.ts`、`skill-resources.ts`：用户数据中的身份/规则/理念文档和 Skill 所有权同步；`PHILOSOPHY.md` 只注册到资源索引，不作为常驻 Prompt bootstrap。
- `workspace-documents.ts`、`workspace-index-resources.ts`：正式文档目录与有界文件元数据索引。
- `resource-management.ts`：用户可管理资源的约束、恢复和重新定位。
- `project-coordinator.ts`：项目路径重绑定和项目记忆投影生命周期。
- `resource-resolver.ts`：按资源来源把正文解析委托给唯一所有者。

外部消费者继续使用 `../memory-service.ts`。新增资源种类必须明确 authority、privacy、scope、生命周期所有者和正文解析边界；不得把资源登记等同于默认注入正文。资源注册与按预算展开由 `../memory-service.test.ts` 验证。
