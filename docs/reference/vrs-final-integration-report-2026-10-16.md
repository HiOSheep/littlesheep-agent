# VRS VERIFY 去留与最终集成报告

最后更新：2026-10-16

## 结论

VRS V0–V3 的已验收改动已集成到本地 `main`。独立 VERIFY Stage 已移除；Runtime 证据完整性检查由 EXECUTE 结算路径承担，证据缺口仍进入 RECOVER。历史 `verify` 阶段名和历史 verification 记录保留为读取兼容数据。新运行没有任务目标级验收依据时，不记录 acceptance `pass`。

## 集成基线与提交

集成前 `main` 为 `1593f925`，工作树干净，且是 V2A 指定提交 `56d7556a` 的直接父提交。VRS 依赖链为：

```text
1593f925 main
└── 56d7556a V2A 旧 VERIFY checkpoint 兼容测试
    └── 28667f84 V2B Evidence Settlement 与活动 Stage 移除
        └── df538aa4 V2C Memory、UI 与 VERIFY 残留清理
            └── 6938936c V2C 架构文档同步
                └── 256e9e0c 修正 RCD 测试适配器的退役 Stage stopReason
```

VRS 链以 fast-forward 集成，无 Runner、Harness 或公共类型冲突。RCD S2B `90811ce` 不在 `main` 的祖先链中，也没有随 V3 临时验证快照一并集成。未推送远端。

## 最终运行架构

- 当前活动 Stage 数量为 7：`enter`、`classify`、`execute`、`recover`、`reply`、`ask_user`、`finalize`。
- 正常执行路径为 `EXECUTE → FINALIZE`。Evidence Settlement 在回复发布前核对 invocation/result 完整性与身份、副作用身份及结算状态、权限拒绝、已知失败和 reply provenance。
- 证据完整只表示运行事实足以支持继续结算，不表示用户目标已验收。证据缺口走 `RECOVER`，不直接进入 `FINALIZE`。
- 旧 `currentStage=verify` checkpoint 经兼容恢复路径重新检查；缺少可信证据、存在 unknown 副作用或授权事实变化时 fail closed，不跳过检查进入 FINALIZE。
- 已结算副作用、unknown 状态、取消与等待用户事实继续由 Runner、RECOVER 和副作用账本拥有。历史 `verificationHistory`、事件、ExecutionLog、AgentResult/RunResult 字段及旧 StageName codec 保留读取兼容；旧 `pass` 不追溯改写。
- 新运行不因只读调用成功或 write/read 一致产生任务 acceptance `pass`。Memory Summary 与 workload 统计不把运行证据完整误报为任务已验证；活动 UI 不再显示虚假的 VERIFY 模型活动，历史记录仍可显示。
- `packages/harness/src/stages/verify.ts` 及其独立路由/任务状态实现已删除；旧 VERIFY LLM 合同、无消费者的 partial replan helper 与 context owner 已清理，没有建立第二套验证或重规划执行器。

## main 集成后回归

最终代码回归快照为 `256e9e0c`：

- VRS、Harness/Runner continuation、RECOVER、checkpoint、Memory、UI、Shell 授权和副作用恢复定向测试：26 个文件、283 项通过。
- 旧 VERIFY checkpoint 专项：6 项通过，覆盖 evidence gap、安全恢复、结算副作用不重放、unknown 不执行、授权重判、等待用户和取消。
- RCD S0 核心脚本：6/6 场景执行，0 基础设施失败，产品结果为 3 passed、2 correctly blocked、1 partially completed。结果记录使用 `execute_completed` 表示执行阶段完成，不再使用退役的 `stage_reached_verify`。
- 根 `pnpm run typecheck` 通过；`pnpm run check:repo` 为 35 项通过、3 项 advisory、0 项失败；集成差异及工作树 `git diff --check` 通过。

| RCD 场景 | main + VRS 结果 | 证据摘要 |
|---|---|---|
| C02 | passed | 错误参数未产生副作用，纠正参数执行成功。 |
| C08 | passed | 相同 Shell 命令在 fixture 状态变化后按当前授权机制重执行。 |
| R01 | passed | Web 检索只到达 loopback fixture。 |
| R02 | correctly blocked | 网络明确禁用时没有拒绝路径外发请求，允许控制请求成功。 |
| L01 | partially completed | 当前单段预算耗尽；持续执行仍由 RCD S2 承接。 |
| X01 | correctly blocked | 写入后结算前注入异常，副作用保持 unknown，没有重放。 |

V3 临时快照曾在 V2C 加已提交 RCD S2B `90811ce` 的独立合并验证树上运行；其六项结果同样为 3 passed、2 correctly blocked、1 partially completed。该结果属于 VRS + S2B 快照，不与上述最终 main + VRS 运行合并统计，也不代表 S2B 已集成。

## 未覆盖事项

- 没有执行真实 Electron 桌面、安装升级或 OS 进程崩溃验收，移交给现有工程发布验收门禁。X01 使用受控异常注入，不能当作 OS 崩溃验证。
- 没有测量修改前后的典型任务耗时、事件体积或 checkpoint 体积。当前 VERIFY 本身没有模型调用，因此不声称删除 Stage 节省模型 token。
- RCD 场景使用脚本 Provider 与受控 fixture，不代表真实 Provider 或外网任务验收。

## 最终 Git 状态

VRS 代码链集成后 HEAD 为 `6938936c`；VRS-F 测试报告语义修正确认为 `256e9e0c`，本报告的代码与 RCD 回归均以该提交为准。集成时 `origin/main` 为 `9ef15430`，没有推送远端。将本报告加入仓库只产生文档变更，不改变已验收代码快照。RCD S2B worktree 与其他专项工作树未由本次集成改动。
