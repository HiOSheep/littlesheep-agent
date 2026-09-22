# 持久记忆写入路径任务书 2026-09-22

最后更新：2026-09-22 23:05:46

## 1. 为什么立项

当前实现的缺口已经被如实记录、但没有归属实现：**持久记忆的唯一写入方是压缩路径**（`runner-finalize` → `compactSessionAfterRun` → `memoryService.write`，经 `resolveMemoryWriteEpistemic` 判定认识状态），而压缩在“登记窗口远大于会话”的配置下不会触发——登记窗口 1M tokens、真实长会话提示词只有 20k–30k，压力线不会被触及，四次 28 回合会话（169–222 个请求）的压缩调用数为 **0**（见[项目状态](../decision/project-status.md#会话压缩与记忆写入)与[验收规程](../reference/cache-95-acceptance.md)）。模型也没有可调用的写入工具：`memory_tree` 只有 `root_index` / `branch_index` / `expand` / `deep_search` / `release` 五个只读动作。

也就是说：**在用户实际使用的配置下，LS 目前不会把任何东西写进持久记忆**。2026-09-21 的裁定是“维持现状、只记录缺口”，本文把该缺口从“记录”升级为“有归属的待决事项”。

**第一步不是写代码，是裁定**：要么决定实现一条与缓存无关的写入路径，要么正式接受“窗口远大于会话时长期不写入”并把它写进产品状态。裁定之前不开始实现。

## 2. 事实依据

| 事实 | 证据 |
| --- | --- |
| 压缩只在预算已知且达到真实压力时触发，消息条数阈值退化为兜底 | `packages/runner/src/runner-finalize.ts`、`packages/config/src/schema.ts` |
| 1M 登记窗口下压力线不触及，压缩调用为 0 | [项目状态](../decision/project-status.md#会话压缩与记忆写入)、[缓存 95% 验收规程](../reference/cache-95-acceptance.md) |
| 模型没有写入工具，`memory_tree` 五个动作全为只读 | `packages/memory-tree/src/memory-tool.ts` |
| 自动记忆演化与 CAPTURE 已删除，运行结束不再自动沉淀 | `AGENTS.md`「核心流程」、`packages/harness/src/lean-work-policy.ts` |
| 记忆意图闸门与其 owner 只服务旧记录读取 | `packages/harness/src/stages/`（`memory-intent-gate.ts` 已删除）、`docs/reference/core-flow-state-contract.md` |
| 把消息条数阈值塞回缓存路径会重新引入前缀重建成本 | 诊断运行实测 6 次压缩重付约 288k tokens（见[项目状态](../decision/project-status.md#会话压缩与记忆写入)） |

## 3. 可收缩范围与硬约束

**硬约束（不得为达成目标而放宽）**

1. 持久记忆的写入必须仍然经过认识状态判定（`resolveMemoryWriteEpistemic`），保留来源、理由、scope、tier 与 parent 的可追溯性。
2. HC-12 撤销语义与冲突/替代状态不得因为新增路径而失效；被撤销的内容不得借新路径复活。
3. 不重新引入第二套自动演化编排（merge/move/revise/correction 的模型编排已删除），也不恢复“运行结束自动沉淀”。
4. 不把消息条数阈值塞回缓存路径换取写入机会；缓存红线（第 16 回合起冻结节点 ≥95%）必须保持 met，判定入口 `pnpm run check:cache-acceptance`。
5. 记忆检索仍严格沿 `root index → branch index → expand`（必要时同分支 `deep_search`），新写入不得绕开索引确定 parent/scope。

**可收缩范围**

- 写入触发方式可以收缩为“明确用户指令”或“运行时显式触发”，不必覆盖全部隐式场景。
- 首版可以限定实体类型、scope 或 tier，先保证一条端到端可审计路径。

## 4. 任务

### MW-01｜用户裁定（必须最先完成，未裁定前不做实现）

- [ ] 给出三种选项各自的代价，交由用户选择：**(A)** 实现与缓存无关的写入路径（模型可调用工具或运行时显式触发）；**(B)** 正式接受当前配置下长期不写入，并把结论写进项目状态与 `AGENTS.md`；**(C)** 只实现“明确要求记住的事”这一最小子集，其余继续不写。
- [ ] 记录裁定日期、范围与不做项；裁定为 B 时，本任务书按“结论已定”退役，其余任务不再执行。

### MW-02｜写入入口与权限边界（依赖 MW-01=A 或 C）

- [ ] 确定写入入口形态：新增受限写入工具、或运行时显式触发点；给出为什么不能在既有只读 `memory_tree` 上放开的理由。
- [ ] 权限：写入进入统一 Tool Execution Service 的审批与记录边界；三档权限下的行为明确（研究/受限模式需批准，完全访问按既有风险确认），不得用提示词绕过。
- [ ] 证据：调用记录、RunContext 字段 owner、checkpoint/execution log 兼容性都要在同一次改动中确定，不新增第二套记忆状态。

### MW-03｜写入语义与不变量（依赖 MW-02）

- [ ] 写入必须沿索引确定 parent、scope、tier、来源与理由；同名/近义/共现不构成同一实体。
- [ ] 与压缩路径共用同一认识状态判定与审计结构，不允许两条写入路径产生不同 schema。
- [ ] 冲突、替代、撤销语义与既有 Repository 事务边界一致；失败不得留下半写入状态。

### MW-04｜缓存红线回归（依赖 MW-02/03）

- [ ] 证明新增写入路径不改动缓存边界之上的 system 提示与工具目录形状：工具目录变化必须只发生在会话区间之间，不得逐轮漂移。
- [ ] 运行 `pnpm run check:cache-acceptance` 保持 met，并给出至少一次真实长任务运行读数；不得用压缩阈值换取写入机会。
- [ ] 运行仓库卫生门与相关测试、typecheck、App 构建，按 Renderer 约定刷新桌面入口。

### MW-05｜验收与收口

- [ ] 验收场景：明确要求记住的事实被写入并在下一次会话召回；被撤销的事实不会被召回；不满足写入条件时如实不写，且用户可见“未写入”的原因，不伪装成功。
- [ ] 记忆写入失败、Provider 失败、权限拒绝、重启后恢复各一条证据。
- [ ] 收口时把稳定事实汇入项目状态、`AGENTS.md` 与 `packages/memory-tree/README.md`，本任务书按仓库规则退役。

## 5. 完成标准

- 每条任务给出实际实现范围、验证方式、通过结果与未覆盖项；完成前保持未勾选。
- 任何“已写入/已召回”的声明必须有真实运行的证据链（工具记录、执行日志、召回输出），不以单元测试替代端到端结论。
- 与缓存相关的结论必须同时给出 `pnpm run check:cache-acceptance` 的结果；不得用局部读数替代整体红线判定。
- 本任务书不改变当前开发主线顺序；它是独立排期的记忆写入专项。
