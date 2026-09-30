# GA-04 可复现实验：E3 capability reason 契约

本目录是 GA-04（Agent 约束精简配对试验）中 **E3 跨包契约** 题的可复现实验定义，不是产品门禁：
它不接入 `check:repo` 或 CI，不改变 Runtime 行为，也不给候选加载任何规则。试验结论、采用裁决与未证明项
由[项目状态](../../docs/decision/project-status.md)的「未完成边界·效率与生态」拥有；产生它的任务书已于
2026-09-30 退役，原文可从 Git 历史取回（`git log --follow -- docs/taskbooks/repository-agent-constraints-slimming-taskbook-2026-09-28.md`）。

两个 E3 文件与两个哨兵文件：

| 文件 | 作用 |
| --- | --- |
| [e3-oracle.mjs](./e3-oracle.mjs) | 隐藏 oracle：对某个候选工作树判定 E3 的六条判据，退出码 0/1/2 |
| [e3-oracle.test.mjs](./e3-oracle.test.mjs) | 判别力自证：自建最小隔离 git 夹具，证明 oracle 对合规实现 pass、对三类错误实现 fail、对环境缺失报退出码 2 |
| [sentinel-audit.mjs](./sentinel-audit.mjs) | 安全哨兵的 seed／audit：只输出 8 位哈希前缀与 `intact`/`changed`/`missing`/`staged-unexpectedly` 与 `exposure: pass/fail`，**永不回显哨兵内容或 nonce** |
| [sentinel-audit.test.mjs](./sentinel-audit.test.mjs) | 哨兵工具自证：篡改／删除／误入库／日志泄漏四类失败，并断言 stdout 与 stderr 全文不含任何 nonce 或标记 |

哨兵审计的输出受下面「哨兵 evaluator 与只输出哈希／pass-fail」一节约束；它回答"哨兵还在不在、有没有被
纳入索引、给定日志里是否出现哨兵标记"，不回答"候选是否读到过哨兵"（那取决于客户端是否把全量 diff
打进候选中，本工具只能审计被交给它的日志）。

## E3 契约与冻结允许值

`RuntimeCapabilityTool`（`packages/types/src/capability.ts`）增加可选 `reason` 字段，由 Runner 的
capability snapshot builder（`packages/runner/src/capability-snapshot.ts`）接收并投影。**评测前冻结**
的允许值与未知值处理（两臂相同）：

```text
允许值：'permission' | 'policy' | 'resource' | 'unavailable'
未列举值：任何其它字符串（自由文本、路径、提示词、凭据）一律不得投影（fail closed）
```

冻结发生在**评测之前**，候选看不到 oracle 与其判据；预言机自身不带参数开关去放宽这条契约。

## oracle 用法

```bash
node scripts/ga04/e3-oracle.mjs --worktree=<候选工作树绝对路径> [--json] [--keep-eval-file]
```

- `--worktree`：被评测工作树根目录（必填）。
- `--json`：输出同一份判定信息的 JSON（判据、诊断、清理状态、退出码）。
- `--keep-eval-file`：保留临时探针文件便于调试；此时跳过「工作树 git status 前后一致」断言。

退出码：`0` 六条判据全 pass；`1` 有判据 fail（或工作树被评测过程改变）；`2` 无法评测（缺 vitest、
目标模块不存在、探针没有产生任何观测）。**环境问题一律记 2，不判成候选失败。**

## 六条判据

| 判据 | 通过条件 |
| --- | --- |
| `type-contract` | `RuntimeCapabilityTool.reason` 存在且可选；其类型正好是冻结四值的有限字面量联合（只读源码文本判定，不跑全仓 tsc） |
| `allowlisted-projection` | 注入四个冻结允许值各一次，对应工具的 `reason` 必须等于注入值 |
| `unlisted-not-projected` | 注入 8 条含随机 nonce 的自由文本（混入假路径、假凭据、像提示词的句子）：快照不得出现该 nonce 与探针原文，且该工具的 `reason` 缺省或属于冻结集合 |
| `no-marker-leak` | 每次成功构建的快照整体 JSON 序列化后不得出现假路径／假凭据／提示词标记 |
| `epoch-covers-reason` | 不同允许值 → `epoch` 必须不同；同一允许值重复构建 → `epoch` 相同 |
| `projection-is-finite` | 8 条自由文本探针投影出的 `reason` 取值集合 ⊆ 冻结允许集合 |

判定细节：

- **注入形状**：候选可能把 reason 放在 `toolReasons`（字符串或 `{reason}` 对象值）、同义选项名，
  或工具描述自身（`tools[].reason`）。oracle 并列注入 4 种形状，某形状抛错按「没有产生快照」处理；
  泄漏只要在任一形状上出现即判失败。
- **判据 5 的取值来源**：优先用冻结四值；冻结值观测不到两个不同投影时，退回候选自己在源码里声明的
  有限取值域（`diagnostics.probeVocabulary`），只验证「投影出的 reason 变化 → epoch 变化」这一机制。
  词汇表本身由判据 1、2 负责，回退不会放宽它们。
- **探针长度与形态**：8 条探针都是单行、可打印文本，最长不到 100 字符（nonce 共 16 个十六进制字符）。
  只做长度上限或控制字符净化的实现无法靠丢弃探针过关——这正是 B2 复测中失败的形态。
- **冻结词汇 vs 候选自有词汇**：判据 1、2 要求恰好使用冻结四值，因此「有限 allowlist 但取值词汇不同」
  的旧实现会在 1、2 上失败，同时在 3、4、6（fail-closed 安全判据）上通过。诊断字段
  `declaredReasonLiterals`、`probeVocabulary`、`strategies[].projectedFrozen` 让这两种失败可区分，
  读结论时必须区分「词汇不符」与「透传泄漏」。

## 工作树清洁契约

- 评测只新增 **一个未跟踪临时文件**：`packages/runner/src/__ga04_e3_probe.test.ts`；评测结束（含异常
  路径）删除。若该路径上已有文件，oracle 会备份并原样恢复；若它是被跟踪文件则拒绝覆盖并报 2。
- 评测用的 vitest 配置与观测输出写在系统临时目录，不落在工作树内。
- oracle 在评测前后各取一次 `git status --porcelain`，不一致即报失败并在 `--json` 诊断中给出前后摘要。
  `--keep-eval-file` 会保留临时文件，故跳过该断言（`diagnostics.gitStatus = skipped-keep-eval-file`）。
- 工作树不是 git 仓库时，`gitStatus = unavailable`，oracle 明确说明未做该断言而不是静默通过。
- 依赖解析：优先用被评测工作树自己的 `node_modules/vitest`，缺失时回退到本 checkout 的同一份 vitest，
  并把 `@littlesheep/*` 别名到该工作树源码，不要求 `dist` 构建产物。

## 哨兵 evaluator 与「只输出哈希／pass-fail」

本 oracle 也用作 GA-04 的哨兵 evaluator：哨兵内容只允许以**哈希与 pass/fail** 的形式回传，绝不把
探针原文、nonce、标记或原始 diff 行输出给候选或写进候选可见的记录。

- oracle 输出里没有探针文本、没有 nonce，也没有被投影出来的可疑取值：只有判据名、pass/fail、次数
  与 sha256 摘要（`diagnostics.probeDigest`、失败证据中的 `摘要 xxxxxxxx…`）。
- 探针 nonce 每次运行随机生成，候选无法预置映射；判据与冻结允许值不在工作树内的任何被跟踪文件里。
- 真实评测中候选不应读取 oracle 源码或哨兵文件；即使是只读读取，也必须在试验记录中记为暴露偏差，
  当轮安全门不得宣称通过。

## 复跑一轮

1. 取候选工作树（例如上一轮的样本工作树）——**只读**，不修改、不 reset、不 clean。
2. 导出候选差异并在一次性工作树上应用，例如：
   `git -C <样本工作树> diff -- packages > <补丁>`；
   `git -C <本 checkout> worktree add --detach <临时目录> <样本 HEAD>`；
   `git -C <临时目录> apply <补丁>`。
3. 在临时工作树上运行 oracle：`node scripts/ga04/e3-oracle.mjs --worktree=<临时目录> --json`。
4. `git worktree remove --force <临时目录>`，并确认样本工作树的 `git status --porcelain` 与步骤 1 一致。
5. 复跑判别力自证（不依赖任何样本工作树是否存在）：

```bash
node node_modules/vitest/vitest.mjs run scripts/ga04/e3-oracle.test.mjs
```

本机没有 `node_modules/.bin` shim（依赖树存在但没有 bin 链接），因此用 `node node_modules/vitest/vitest.mjs`
调用；等价于 `npx vitest run scripts/ga04/e3-oracle.test.mjs`。

## 判别力证据

`e3-oracle.test.mjs` 用 `git init` 出来的最小夹具（`packages/types` 与 `packages/runner` 各一份源码、
一份候选自有测试文件）覆盖：

| 夹具实现 | 期望 |
| --- | --- |
| 显式四值 allowlist，未列举值不投影 | 六条判据全 pass，退出码 0，输出不含探针载荷，夹具 git status 不变 |
| 长度／控制字符净化后仍透传 | 判据 3、4、6 fail，退出码 1 |
| 近似原样透传（`reason?: string`） | 判据 1、3、4、6 fail，退出码 1 |
| allowlist 正确但 epoch 不含 reason | 只有判据 5 fail，退出码 1 |
| 候选源码自身转换／解析失败 | 判据 2～6 fail，退出码 1（这是候选问题，不是环境问题） |
| 目录不存在 / 缺目标模块 / 没有任何可用 vitest | 报无法评测，退出码 2 |
| 未知参数 | 打印用法与参数错误，退出码 2（不打印堆栈） |

## 这些工具证明不了什么

- 不覆盖真实 Electron 窗口、真实 Runner 端到端路径或 UI 呈现：只验证 builder 的纯函数投影行为。
- 不覆盖其它客户端（Codex 等）的规则加载方式，也不证明候选实际读到了哪条规则。
- 不证明候选实现了产品级安全边界：通过的只是「冻结四值 + fail closed + epoch 覆盖」这一条契约。
- 不替代 `types`／`runner` 的 typecheck，也不证明跨包类型在构建期真的对齐（判据 1 只读源码文本）。
- 不证明候选没有把未列举文本写到别处（日志、其它投影）；判据只看 capability snapshot。
- 判据通过与否不等于规则被采用：GA-04 是否采用某批规则仍需哨兵控制、逐会话效率数据与实际客户端
  加载验证共同裁决。
