# LittleSheep 架构优化报告（2026-10-23）

**范围：** 全仓架构审计与增量重构（Runner/Harness 控制流、持久化/恢复、Context/Prompt/Cache、渠道与权限、Renderer/API 契约、评测链）。
**方法：** 先做 3 个只读子系统审计（Core Execution、Context/Prompt/Cache、Surface/API/Permission），每批只做有消费者/行为证据的改动；每批跑定向测试 + `typecheck` + `check:repo` + `verify:full`。未调用真实付费 Provider，未修改冻结 Oracle/历史账本/证据，未自动推送。

## 1. 结果概览

| 指标 | 结果 |
|---|---|
| 架构提交 | 10 个（`d486a959..2d23ea6f`） |
| 文件变化 | 49 files changed，+615 / -650 |
| 修复的真实缺陷 | 3 个（渠道策略未执行、checkpoint 权限降级、发布门不一致） |
| 统一/删除的重复实现 | no-op 策略、惰性 history 启发式、缓存重复归一化、失败事件、恢复批写、publication gate、审批契约、stream 事件契约 |
| 治理 | `runner.ts` 回到 2595 行上限内（2593）；`run-routes.ts` 退出 600 行强制拆分队列 |
| 验证 | 每批定向测试 + `typecheck` + `check:repo`；最终 `verify:full` 通过 |

## 2. 批次清单

| # | 提交 | 改动 | 依据 |
|---|---|---|---|
| 1 | `0b8f04ad` | 删除 no-op `preferDirectModelOutput`；删除惰性 history priority/eviction-group 启发式；缓存请求只归一化一次、stable-prefix HMAC 只算一次 | 零消费者/无读取的 metadata；固定请求 observation 改动前后完整 JSON（含全部 fingerprint）字节一致 |
| 2 | `63096684` | `runtime_status_settled` 单一 appender；checkpoint 恢复状态合并为一次批写；删除 kernel 重复 `effect_settled` 校验；删除 `if (true && ...)` | 两处实现 eventId/idempotencyKey/payload 完全相同；恢复两批写同一 stage |
| 3 | `d1b7deb7` | 删除 test-only prompt/context/type 导出（`assembleSystemPrompt`、`projectContextSection`、clock formatters、`TokenLedger` 等）；复用 canonical `ContextReuseEvent` | 生产/脚本零引用；`ContextSnapshotItem.promptTokens` 被 app 读取，审计建议被 typecheck 否决并保留 |
| 4 | `91954997` | 拆出 `run-publication.ts` / `run-execution-fingerprint.ts` | `runner.ts` 2742 行超过登记的 2595 行上限；纯移动 + 计数更新 |
| 5 | `076da645` | 渠道 `dmPolicy`/`groupPolicy`/`pairing` 在 ChannelManager 入口真正执行 | 配置已存在但 `evaluatePolicy` 无生产调用；disabled 群仍回复 |
| 6 | `c97f1eb3` | checkpoint 持久化 V2 `permissionPreset`；续跑 `min(检查点, 当前会话)` 封顶 | 旧检查点只存 legacy mode，`workspace-write` 被保守降级为 `read-only` |
| 7 | `42c1591c` | 6 个适配器统一调用 `publishRunnerResult`，一次标记、不重复 replay | 6 份相同 mode 判断，其中一份多一个 `isResultAuthoritativePrepared` guard |
| 8 | `63235ebe` | `ToolStreamEvent` 穷尽 Record + `isToolStreamEventName` | renderer 手写 17 个事件名，新增 variant 会静默丢事件 |
| 9 | `ad6bde7d` | 审批请求字段收敛到 `shared/approval-contract.ts` | 同一线协议在 Main/API/Renderer 声明三次，boundary 可选性不一致 |
| 10 | `2d23ea6f` | publication 的 final-reply 与 task outcome 共用一次 durable projection | 同一不可变事件流被 replay 两次 |

## 3. 删除/替换依据

- **零消费者**：no-op policy、惰性 priority、test-only exports 均用全仓 grep（含 scripts）确认；不是“看起来没用”。
- **取代设计**：append-only memory 已在上一轮删除；本轮统一失败事实/恢复批写/publication gate，避免同一安全事实多实现。
- **行为证据**：缓存改动用固定请求 + 固定 scope key 的完整 observation JSON 对比；渠道策略与 checkpoint preset 用新增回归测试；publication gate 用 once-only replay + legacy pass-through 测试。
- **安全不变量**：权限只收紧不升级；publication 仍以 durable settled 为准；崩溃/恢复测试未改弱。
- **冻结输入**：S3A/S3B/R4-B/C/D0 任务集、Oracle、账本、证据未修改。

## 4. 验证证据

| 批次 | 定向验证 | 完整门禁 |
|---|---|---|
| A | harness 705/705；缓存 byte-diff | passed（重试一次 worker 崩溃后 923.6 s） |
| B | finalize/kernel/checkpoint 54/54（含 80 s 恢复） | passed 916 s |
| C | prompt/context/types 125 | passed 779 s |
| D | runner/continuation/segments 110（含 57 s 段） | passed 831 s |
| E | policies 52/52；channels/plugins/app-main 742 | passed 860 s |
| F | checkpoint API 12/12；build/validate 10/10 | passed 1090 s（先遇 ENOSPC，清理旧 temp 后通过） |
| G | authoritative 12/12；CLI/channel/API 178 | passed 856 s |
| H | renderer API/main stream 38 | passed 979 s（重试 worker 崩溃） |
| I | approval/API 60 | passed 1152 s |
| J | runner/authoritative/continuation/task-outcome 123 | passed 1080 s（两次 worker/环境失败后重试；独立全量 JSON 5145 tests / 0 failed） |

`typecheck` 每批 exit 0；`check:repo` 最终 35 passed / 3 advisory / 0 failed。

**已知环境问题：** 本机长时间连续跑测试时 tinypool 偶发 `Worker exited unexpectedly`，以及一次 D 盘写满（ENOSPC）。均已通过清理旧临时构建产物与重试解决；未删除/弱化测试规避。托管 CI 在本轮改动前通过，本轮尚未推送。

## 5. 残余风险与后续项

1. **CacheObservation 双持久化**：execution log + 独立 file store；`put` 触发全目录 prune，`latest`/`report` 扫描全部文件。需要先在真实数据根测 store 大小/每请求 IO，再决定增量索引或从 durable projection 派生。
2. **Durable projection 仍有多处 replay**：本轮把 publication 的 2 次降为 1 次；finalize 的 unsettled request 查询、outcome 记录仍会 replay。继续收敛需要把 projection 贯穿 run 尾部，并用 crash matrix 证明不会读到旧投影。
3. **`POST /run` 非流式路径**：仓库内仅 readiness 测试引用，renderer 客户端 `runAgent` 无导入者；但可能被外部自动化使用，删除前需确认。
4. **权限/审批谓词仍有重复**：`isPermissionPreset`/legacy guards 在 shared、safety、run-policy、run-support、runtime-routes 多处；统一需要先做全 6 个 id 的 golden decision matrix。
5. **`waiting_user`/`shadow` 兼容路径**：读取侧保留以兼容旧 checkpoint/记录，写入侧已无 shadow；是否退役需要产品与数据保留决定。
6. **本机完整门禁的 worker 抖动**未根治；托管 CI 是最终环境证据。

## 6. 复现

```pwsh
git log --oneline d486a959..HEAD
pnpm run typecheck
pnpm run check:repo
pnpm run verify:full
```

所有改动保留在本地 `main`，未推送；冻结 Oracle、历史账本和 R4-B/C/D0 证据未修改。
