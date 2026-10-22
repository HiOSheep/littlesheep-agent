# LittleSheep 仓库持续优化报告（2026-10-23）

**范围：** 文档清理、死代码/重复设计移除、跨模块接口标准化、模块内聚与耦合优化。

**方法：** 每批先做只读审计（文档入链图、生产 import 图、契约消费者 grep、check:repo 基线），只提交有消费者证据或替代设计证据的改动；每批运行定向测试 + `typecheck` + `check:repo` + `verify:full`。未调用真实付费 Provider，未修改冻结 Oracle/历史账本，未自动推送。

## 1. 结果概览

| 指标 | 结果 |
|---|---|
| 优化提交 | 13 个（本地 `main`，相对 `origin/main`） |
| 文件变化 | 96 files changed，+392 / **-8,453** |
| 文档 | Markdown 76 → **61**；docs 文件 193 → **168** |
| 生产代码 | 删除约 3,300 行死代码/CSS/API 包装器；统一 6 类重复实现 |
| 冻结输入 | S3A/S3B/R4-B/R4-C/R4-D0 任务集、Oracle、账本、证据全部未改 |
| 门禁 | 每批定向测试通过；最终 `verify:full` 通过（见第 5 节） |

## 2. 批次清单

| # | 提交 | 内容 |
|---|---|---|
| 1 | `05fd750c` | 删除 25 个无当前引用的历史文档/账本（LCDA、S1B/S1C、S2A/S2B/S2C-C/I、VRS、旧任务书），更新三类索引 |
| 2 | `775df444` | 删除无入口的 RCD S1B 证据生成脚本（测试保留） |
| 3 | `3e8753f6` | 删除约 1,150 行零消费者 Harness 代码与重复/孤立脚本 |
| 4 | `ec725d3e` | 统一 6 处 model-ref 解析；修复嵌套模型 ID 被静默替换的真实缺陷 |
| 5 | `c4b935e7` | 显式 `retryable` 成为重试唯一权威；打破 composer 唯一运行时循环依赖 |
| 6 | `1d4bd0f4` | 删除未使用 renderer API 包装器；重复类型联合改为 canonical alias |
| 7 | `1bb8bdfc` | 9 处回复发布判定收敛为 `publishableReply` |
| 8 | `926adf75` | 删除 5 个无模块消费者的 terminal/chat 组件 |
| 9 | `2cb4dc22` | 删除被 append-only 设计取代的 memory 重写/过滤路径（~140 行） |
| 10 | `1d117bf7` | `RunResult` 从权威 `RunnerResult` 派生，删除 renderer 私有分叉 |
| 11 | `25813a6a` | 合并 checkpoint 两段恢复状态写入，仅保留刻意差异 |
| 12 | `773c2cbd` | 删除孤儿 checkpoint recovery 视图 + 534 行专属 CSS + stale 测试断言 |
| 13 | `0da75625` | 新增版本化脚本结果信封，统一未来机器输出接口 |

## 3. 删除/替换依据

- **零消费者**：`pickStepTools`/`pickPlanTools` 等 5 个导出、`renderStepGuidance`、`markSideEffectUnknown`、未使用 renderer API、未导入 terminal/chat 组件、checkpoint recovery 视图，均有 import grep 证据。
- **取代设计**：memory working-set 的“改写历史文本”路径被 `087cb018` 的 append-only 发布说明取代；旧路径只被自身测试引用。
- **重复实现**：model-ref 6 处、回复发布 9 处、重试判定 2 套、类型联合多处、checkpoint 恢复 2 份重复状态写入；全部收敛到单一权威。
- **文档**：无代码/测试引用、无被保留文档反向链接、不属于冻结基线；删除后可从 git 历史恢复。
- **保留**：被代码/测试/冻结哈希引用的协议、Schema、任务集、账本；被 project-status 引用的当前能力证据；principles/decision 当前契约。

## 4. 接口与内聚改进

| 问题 | 改进 |
|---|---|
| 嵌套 model ID 被 `split('/')` 截断，运行模型与 UI 不一致 | `parseModelRefParts` 统一解析，只有第一个 `/` 分隔 provider；新增回归测试 |
| 各渠道/CLI/renderer 各自推导可发布回复，next-mode 渠道丢 web-source | `publishableReply`：settled 才发布，provisional 发布空，legacy 才回退 `reply` |
| `RunResult` 是 `RunnerResult` 的手写分叉，新字段无法到达 renderer | 类型派生 + HTTP 边界显式窄化；收紧后暴露并修正无效测试夹具 |
| 重试分类有两套权威，空 retryable 集合仍可能重放 408/429 | 显式 `retryable` 标记优先；401/403 仍为 auth；4xx 回退 request |
| 恢复路径两份 8 组状态写入 | `restoreSharedCheckpointState` 共享；same-run 与 continuation 的差异显式保留 |
| 脚本输出 `{ok}/{check}/{report}` 互不兼容 | `{schemaVersion,kind,status,exitCode,data}` 信封 + 解析/断言 |
| 唯一运行时循环：artifact card ↔ file strip | `fileActionLabel` 移到叶子模块 |

## 5. 验证证据

- 各批定向测试：harness 14、reply consumers 316、renderer 30、recovery 200、types 47、envelope 3 等均通过。
- 每批 `pnpm run typecheck` exit 0；`pnpm run check:repo` ok（35 passed / 3 advisory / 0 failed）。
- `pnpm run verify:full` 多次通过，最终运行 `[gate] full passed`；批间还执行过独立全量 `vitest run --reporter=json`（1080 s，exit 0）确认测试集本身稳定。
- **已知环境抖动：** 本机长时间连续运行时，tinypool 偶尔报 `Worker exited unexpectedly`（全部用例已通过后 worker 崩溃），或 durable-runner 进程租约测试在满负载并行下冲突；单独运行相应测试均通过，重跑完整门禁通过。未通过删除/弱化测试规避。

## 6. 残余风险与未完成项

- **Provider usage** 仍有多种形状与两处字段级投影；合并需动持久化快照，未在本轮实施。
- **历史文档**（S3B P01/P04/P05/P06）中仍有对已删除文档的内联路径引用；不影响构建与链接检查，可在下一次文档清理时统一注释。
- **剩余孤立脚本/test-only micro hooks** 尚未删除：部分可能是人工诊断工具，需逐项确认用途后再清理。
- **`verify:full` 在本机的 worker 抖动**未根治；CI 托管环境此前 Full Gate 通过，本地重跑是当前规避方式。
- 未调用真实 Provider、未执行 Electron GUI/跨平台专项；这些不属于本次仓库结构优化范围。

## 7. 复现

```pwsh
git log --oneline origin/main..HEAD
pnpm run typecheck
pnpm run check:repo
pnpm run verify:full
```

所有改动保留在本地 `main`，未自动推送；冻结 Oracle、历史账本和 R4-B/C/D0 证据未修改。
