# Built-in Tools

这里保存 LS 随核心发布的受控工具实现。

最后更新：2026-09-23 21:20:00

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
- `read.ts` 通过单个文件句柄取出字节、大小与 mtime，因此三者描述同一份版本；读取成功后它会把这版原始字节的 sha256 与**模型实际看到的行范围**登记进 `ToolContext.observation`。只有未被清洗、未被截断且范围非空的交付才算观察：二进制预览、读取失败、审批拒绝、截断或改写过的内容都不登记，模型需要重读。带 `offset`/`limit` 的读取登记为 `partial` 并记录可见行区间。
- `write.ts` / `edit.ts` 在授权之后、durable checkpoint **之前**校验观察，并在同路径互斥区内**紧邻写入前**用同一份字节复核一次：覆盖已有文件要求 `coverage: 'full'` 的观察，`edit` 只要求被替换的行落在已观察范围内。序列固定为授权与路径复核 → 观察/版本校验 → checkpoint → 锁定内复核 → 写入 → 结算；观察缺失、过期、不可支持或范围不足时返回 `ok: false`（**不抛异常**，否则副作用会结算成 `unknown` 并阻塞恢复），文件保持原样，`meta.errorKind` 记录 `observation_missing` / `observation_stale` / `observation_unsupported` / `target_exists`。目标不存在时不要求观察，改用 `flag: 'wx'` 独占创建：并发创建者会得到 `target_exists` 而不是被静默覆盖。写入成功或结局不明后旧观察一律失效，因此下一次修改必须重读。
- `document_create` 首版只创建新文件：目标已存在时返回 `target_exists` 并保持原文件不变，不为了覆盖二进制文档扩展观察协议。它用 `resolveToolPath` 做路径复核，并把 create-only 保证下沉到 `@littlesheep/documents` 的写盘入口（独占创建），因此"检查不存在 → 覆盖写"的竞态窗口不存在。
- `exec.ts` 用同一组常量既启动进程也披露解释器：`describeExecutionShell()` 返回实际 spawn 的 `powershell.exe -NoProfile -Command`（Windows）或 `/bin/sh -c`（Unix），供 Runtime facts 与工具目录描述生成模型可见契约。披露值不会与执行值漂移，也不读 TOOLS.md；Windows 明确说明它是 Windows PowerShell 而非 PowerShell 7（`pwsh`），并给出 PowerShell 的分隔符、`Get-ChildItem`/`Test-Path` 与含空格路径的引用方式，不把 cmd 的 `&&` 或 Bash 语法当作默认语法；Unix 说明是 POSIX sh 而非 bash。工具描述同时说明"每次调用一条命令、相同成功调用会被拒为重放"，并指向 `glob`/`grep`/`read`——模型在烧掉一轮之前就知道该用哪个入口。
- 受保护根内的读/写分界在 `../path-protection.ts`：单条 `Test-Path`（存在性）与 `Get-ChildItem`/`dir`（列举）等窄形态可执行，写入类与任何组合语法被拒；`exec.ts`、`write.ts`、`edit.ts`、`document-create.ts` 的拒绝共用 `coreSourceReadOnlyMessage()` 并声明 `meta.errorKind: 'core_source_read_only'`，主循环据此按权威边界停手而不是让模型换工具试探。
- `exec.ts` 把不透明命令的失效做在观察端口上：审批通过后、进程启动前 `suspend()`（期间不登记新观察，已有观察也不得授权写入），结算时 `invalidateAll()` 清空该会话的全部观察——**不依赖只读启发式**，命令名不是"没有写入"的证据。只有确认进程已关闭才解除冻结；进程可能仍在写时保持冻结直到 `close`。非零退出、超时、取消都按"可能已改动"处理；命令未真正启动（审批拒绝、spawn 失败）时不清空观察。因此 `exec` 之后模型通常要重读一次文件，这是任务书接受的代价。
- `request_user_input` 不做 IO：它把缺失事实的问题交给 Runtime 发布为本轮回复，并留下一个有界的等待事实。
- 网络工具只通过每轮注入的 `WebRetrievalRuntime` 执行：`web_search` 只能使用 Runtime 选定的 Provider，`web_fetch` 只能匿名读取已校验的公共 HTTP(S) URL。它们不接收 endpoint、method、header、Cookie、Authorization、body、proxy 或输出路径；搜索/网页内容一律是 `external_untrusted`，持久化边界只接受 `WebEvidenceProjection`。
- 网络关闭、Provider 未配置、敏感 query、私网/危险 URL、超时、取消和 citation 不一致必须默认拒绝或保留 partial/blocked 状态，不能由工具隐式 fallback 到 HTML scraping、浏览器或长期 Memory 写入。
- 禁止工具自行持久化审批或绕过 Registry/Wrapper；测试与实现同目录。
