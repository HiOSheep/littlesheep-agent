# Built-in Tools

这里保存 LS 随核心发布的受控工具实现。

## 分类

- 文件只读：`read.ts`、`grep.ts`、`glob.ts`。
- 文件修改：`write.ts`、`edit.ts`。
- 命令执行：`exec.ts`。
- 记忆导航：`memory_search.ts`、`memory_deep_search.ts`。
- 会话信息：`session_status.ts`。

## 边界与测试

- 每个工具定义稳定名称、schema、权限等级、工作区约束、中断和有界输出。
- 记忆工具必须遵守索引优先；`deep_search` 只能在已导航分支内使用。
- 禁止工具自行持久化审批或绕过 Registry/Wrapper；测试与实现同目录。
