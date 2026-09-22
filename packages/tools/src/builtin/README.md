# Built-in Tools

这里保存 LS 随核心发布的受控工具实现。

最后更新：2026-09-22 12:43:39

## 分类

- 文件只读：`read.ts`、`grep.ts`、`glob.ts`。
- 文件修改：`write.ts`、`edit.ts`。
- 命令执行：`exec.ts`。
- 文档读写：`document-read.ts`、`document-create.ts`；格式处理委托给 `@littlesheep/documents`。
- 会话信息与澄清：`session_status.ts`、`request_user_input.ts`。
- 公开网络只读：`web_search.ts`、`web_fetch.ts` 与共享边界 `web-common.ts`。

## 边界与测试

- 记忆导航不在本目录：`memory_tree` 由 `@littlesheep/memory-tree` 的 index-first runtime 提供，只有 `root_index`、`branch_index`、`expand`、`deep_search`、`release` 五个只读动作。模型没有记忆写入工具，持久记忆只由会话压缩路径写入。
- 每个工具定义稳定名称、schema、权限等级、工作区约束、中断和有界输出；`document_read` 与 `document_create` 在执行前调用 `authorizeToolAccess`，写入还要先过核心源码只读根。
- `request_user_input` 不做 IO：它把缺失事实的问题交给 Runtime 发布为本轮回复，并留下一个有界的等待事实。
- 网络工具只通过每轮注入的 `WebRetrievalRuntime` 执行：`web_search` 只能使用 Runtime 选定的 Provider，`web_fetch` 只能匿名读取已校验的公共 HTTP(S) URL。它们不接收 endpoint、method、header、Cookie、Authorization、body、proxy 或输出路径；搜索/网页内容一律是 `external_untrusted`，持久化边界只接受 `WebEvidenceProjection`。
- 网络关闭、Provider 未配置、敏感 query、私网/危险 URL、超时、取消和 citation 不一致必须默认拒绝或保留 partial/blocked 状态，不能由工具隐式 fallback 到 HTML scraping、浏览器或长期 Memory 写入。
- 禁止工具自行持久化审批或绕过 Registry/Wrapper；测试与实现同目录。
