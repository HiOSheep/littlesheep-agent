# RCD S1B-F — 受控 Shell 合法重执行

## 结论

在保留 Runner effect identity、checkpoint 恢复与 unknown 阻断的前提下，Runtime 现在区分了两类情况：同一调用的恢复仍命中原副作用账本身份；新的 Shell 执行只有在经过 Main 当前策略与权限检查后，才获得新的账本身份。

F01 在独立临时 workspace 中通过：相同命令、参数和 cwd 第一次读取 `v1`，受控文件修改为 `v2` 后，经新的 Main 一次性授权再次启动真实本地进程并读取 `v2`。F02、F04、F05、F06 的保护用例也通过。受控测试不等于真实 Electron 验收。

## 身份、审批与账本语义

- Main 每次 Shell 授权都为冻结的执行计划生成新的 invocation identity。模型参数和 Renderer 提供的 call ID 不能生成或伪造该身份。
- 新调用仍要通过现有 Shell hard deny、策略作用域、环境/工作区复核和一次性 grant 消费。普通一次性授权不被扩展为重复授权；同一命令再次执行需要新的有效审批。
- Main 的精确重复授权绑定一条经 Main 校验的原始命令和执行计划，并绑定 shell、cwd、workspace、session、permission、environment、timeout 和 user；授权最多消费 20 次，30 分钟失效。超过次数、绑定变化或拒绝后都不能复用。它不构成全局 Shell 自动执行权限，也不提供 OS 隔离。
- 已成功的 exec 在新的授权 identity 下使用新的 effect key；旧结算保留。相同 call ID 仍是重复调用。`planned`、`in_progress` 或 `unknown` 的相同输入会先阻断，因此创建新 call ID 或新授权不能静默重放未结算副作用。
- 成功回执丢失后的 Runner 恢复使用原 effect identity，不启动第二个进程。unknown 仍需要后续可信核实或人工处置；本批没有增加自动重试。
- 反复无进展仍受 ToolExecutionService 的重复输入上限与 Harness loop budget 约束。

本次只调整副作用账本对新调用身份的识别。没有按资源哈希授予授权，也没有用 Shell 命令名称/内容分类作为 OS 隔离保证。

## 场景结果

| 场景 | 结果 | 执行证据 |
|---|---|---|
| F01 / 历史 B01 | 通过 | 同一输入哈希与命令两次实际启动；文件 `v1 → v2` 后第二次观察到 `v2`；两次使用不同 Main 授权及 effect identity。 |
| B02 | 通过 | 状态未变化时第二次调用只有在重新获得一次性授权后才执行。 |
| F02 | 正确阻断 | 一次性授权只消费一次；第二个 call ID 不能复用，进程启动计数仍为 1。 |
| F03 | 通过 | Main 对完全匹配的 `node check.mjs` 精确命令授予有界重复权；两次真实进程运行仅出现一次授权请求，产生独立 effect identity。存储单测覆盖 20 次上限、绑定及失效。 |
| B03 / F04 | 通过 | 成功 effect 保持原身份；Runner 恢复不产生第二次副作用或重复结算。 |
| B04 / X01 | 正确阻断 | 受控异常发生在真实临时文件副作用之后、结算之前；状态保留为 unknown，恢复不重放。此项不是 OS 进程崩溃测试。 |
| F05 | 正确阻断 | unknown 状态下使用新 call ID 与新 Shell 授权仍不启动第二个进程，日志与 ledger 保留单次实际副作用。 |
| B05 | 正确阻断 | 用户拒绝与预先取消不启动对应 Shell 副作用；一次性批准不扩大到第二个命令。 |
| F06 | 通过 | 重复无进展调用被现有 Runtime 重复调用上限约束，且不超过 loop budget。 |

S1B-F 机器账本逐项保留测试状态和证据摘要；S0-F 核心回归账本单独生成。此前 S1B 与 S0-F 历史报告不覆盖。

## 回归与限制

受控本地 Shell 命令、Main 授权适配器和 Runner 恢复测试覆盖了本批契约；S1B-F 可复现套件包含 82 个测试断言，均已通过。没有调用真实付费 Provider、公网服务或真实 Electron UI，因此不能将结果解释为真实用户任务成功率。真实 OS 崩溃时 shell 子进程的终止时序、外部副作用核实和跨主机授权恢复仍未由本批验证；授权仍是 Main 进程内存状态，不会在重启后复用。

运行账本：

- [S1B-F Shell 重执行机器账本](rcd-s1b-f-shell-reexecution-2026-10-16.json)
- [S1B-F S0-F 核心回归](rcd-s1b-f-core-regression-2026-10-16.json)
- 可复现入口：`node scripts/rcd-s1b-f.mjs`
