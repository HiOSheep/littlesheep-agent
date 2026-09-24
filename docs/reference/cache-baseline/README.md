# Cache request-shape comparison: pre-fix vs post-fix

最后更新：2026-09-24 22:07:26

本目录记录"系统提示词与请求前缀精简"任务书的结构基线与前后对比。除本文件外，`latest.md`
由探针在每次 harness 测试运行时重新生成（同样只含字符数、共享前缀与工具目录摘要，
不含提示词正文、会话内容或密钥）；需要冻结某次对比时把 `latest.md` 复制成
`baseline-<freeze>.md` 并在此登记。

Produced by the same probe (`packages/harness/src/probe/baseline.test.ts`) against
two checkouts, with the same frozen loads, model name, tool set and compaction
configuration:

| Report | Freeze |
| --- | --- |
| [`pre-fix-cd6cabc.md`](pre-fix-cd6cabc.md) | `cd6cabc`, the commit before this work started |

Both records carry the same frozen loads. The probe runs inside the harness suite and
writes only `latest.md`, re-labelling it with the current commit; the per-load JSON dumps
it used to write had no reader and were removed on 2026-09-24. Measurements that change are
the ones worth reading — and the turn-1 character counts have moved since the freeze above
(see the current reading in [`latest.md`](latest.md)), while the shared-prefix and
stable-head numbers below are the ones that converged. `baseline-git-0af62a7.md` was
retired on 2026-09-24: this README already records that its shared-prefix reading counted
bytes that matched by accident, so it was a refuted post-fix copy rather than evidence.

## 长任务批次历史（机器可读账本保留，逐批叙述已退役）

冻结清单与长任务的每次真实运行都由 `scripts/run-real-long-task.mjs` 驱动、`scripts/report-real-long-task-baseline.mjs` 聚合。**逐批的 `.md` 渲染已在 2026-09-24 退役**（它们只是各自 `.json` 的表格渲染，原文见 git 历史），批次结论集中在这里；`.json` 全部保留——它们是 gate 的输入，且冷启动/重建/尾部三类未缓存分解是从当时保留的临时数据根重算出来的，临时目录清掉后这些 JSON 是唯一副本。

| 批次（账本） | 平均 H_ui | 唯一事实 |
| --- | ---: | --- |
| [改动前 `real-long-task-baseline-2026-09-22.json`](real-long-task-baseline-2026-09-22.json) | 73.4% | 唯一的改动前真实 Provider 账本；功能失败 4/12 |
| [任务区间回放后 `…-post-lt02-2026-09-22.json`](real-long-task-baseline-post-lt02-2026-09-22.json) | 84.2% | 首次把重建未缓存降到 0（5/12）；功能失败 4/12→1/12 |
| [回放与压缩修复后 `…-after-replay-fixes-2026-09-22.json`](real-long-task-baseline-after-replay-fixes-2026-09-22.json) | 86.0% | 唯一带"排除 provider 矛盾后"敏感性列的批次（4/12 矛盾） |
| [强制收尾修复后 `…-forced-final-fix-2026-09-22.json`](real-long-task-baseline-forced-final-fix-2026-09-22.json) | 88.1% | 最干净的一批：产物验收 12/12、0 矛盾、重建合计 2,276（10/12 为零） |
| [任务区间不可淘汰后 `…-pinned-interval-2026-09-22.json`](real-long-task-baseline-pinned-interval-2026-09-22.json) | 87.1% | **当前冻结清单回归集**（验收门的默认输入之一）；产物 12/12、0 矛盾 |
| [L1 长任务 `long-interval-task-L1-2026-09-22.json`](long-interval-task-L1-2026-09-22.json) | 99.13% / 99.21% | **当前红线证据**（验收门的另一默认输入）：第 16 回合起节点全部 ≥95% |
| [L1 第 14 回合重启 `…-L1-restart-2026-09-22.json`](long-interval-task-L1-restart-2026-09-22.json) | 98.99% | 唯一的进程重启连续性测量（重启不损失前缀） |
| [L1 空闲 45 分钟 `…-L1-idle-pause-2026-09-22.json`](long-interval-task-L1-idle-pause-2026-09-22.json) | 99.05% | 唯一的缓存有效期测量（结论为"至少 45 分钟内有效"） |

口径、禁止做法与判定入口见[缓存 95% 验收规程](../cache-95-acceptance.md)；聚合账本表头的"达标 0/N"是不加豁免的严格读法、"存在功能失败"会把 provider 未回答的尝试计入，读表前先看该规程的说明。

## What the probe measures

Per request, from the request the client actually sends:

- `chars` — bytes of the serialized message array;
- `shared prefix (chars)` — how much of the previous request in the same load is
  literally repeated at the start of this one, i.e. how much of a prefix cache
  could be reused;
- `stable head` — bytes of the first system message above the cache boundary
  marker;
- `catalog` — advertised tool names plus a digest of their schemas.

**It never calls a Provider.** These are structural character counts. They are
not token counts, not cost, and not cache-hit evidence.

## Results

### Load A: one session, local → web → local

| Request | pre-fix chars | post-fix chars | pre-fix shared | post-fix shared | pre-fix catalog | post-fix catalog |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| turn 1 (local) | 6019 | 6885 | - | - | read+doc | read+web+doc |
| turn 2 (web) | 6159 | 7002 | 2311 (0.384) | **3574 (0.519)** | +web | same |
| turn 3 (local) | 5965 | 6831 | 2311 (0.375) | **3574 (0.510)** | read+doc | same |

- The catalog changed on every turn before (three different schemas); it is now
  one catalog across all three turns.
- The reusable prefix per turn grew 1.5× (2311 → 3574), and — more importantly —
  it is now a genuine prefix extension: the difference between two turns is the
  turn's own text plus the below-boundary sections the prompt declares, not a
  rewrite.
- Cost: each request is ~800 characters larger, because the Web schemas are now
  always advertised and the below-boundary sections travel as their own messages
  instead of being folded into the system message. That is the deliberate trade
  SP-05 and SP-02 ask for.

### Load B: one tool loop, four rounds

| Request | pre-fix chars | post-fix chars | pre-fix shared | post-fix shared |
| --- | ---: | ---: | ---: | ---: |
| round 1 | 6308 | 7174 | - | - |
| round 2 | 6606 | 7472 | 5870 (0.931) | **7174 (1.000)** |
| round 3 | 6904 | 7770 | 6168 (0.934) | **7472 (1.000)** |
| round 4 | 7202 | 8068 | 6466 (0.937) | **7770 (1.000)** |

- Before: every round diverged 438 characters in — at the Runtime tail, which was
  re-appended at a new position each round. Reuse ratio was stuck near 0.93 and
  the divergence point never moved.
- After: reuse ratio is exactly 1.000; each round repeats the whole previous
  request and only appends. The first divergence is now the newly appended
  content, which is the only thing that can differ.
- Cost: requests are ~800 characters larger on rounds 2–4, from the fixed catalog
  and from the below-boundary sections travelling as their own messages.

### Load C: a conversational turn and a tool turn

| Request | pre-fix chars | post-fix chars | pre-fix shared | post-fix shared | pre-fix stable head | post-fix stable head |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tool turn | 6014 | 6880 | - | - | 3430 | 3444 |
| chat turn | 3737 | 5371 | 360 (0.060) | **3557 (0.517)** | 1916 | **3444** |

- Before: the chat path rendered a different Core Flow variant and a different
  memory index paragraph, so it shared only 360 characters with the tool path —
  the identity line. Its stable head was 1916 characters against the tool path's
  3430.
- After: both paths render the same stable head and share 3557 characters. In both
  the system message *is* the stable head: there is no boundary marker inside it,
  because the boundary is where it stops.

## Converged numbers

| Metric | pre-fix | post-fix |
| --- | ---: | ---: |
| Load A reusable prefix per turn | 2311 | 3574 |
| Load B tool-round reuse ratio | 0.93 | 1.000 |
| Load C chat/tool shared prefix | 360 | 3557 |
| Stable head (all loads) | 3430 | 3444 |
| Distinct tool catalogs in load A | 3 | 1 |
| Compaction request Runtime-facts block | 355 chars | 0 |
| System message that was the prompt's own stable half | no (4058 vs 2323) | **yes (2323 = 2323)** |

The reusable-prefix figure for load A is lower than an earlier reading took it to
be (5,585) because that reading counted bytes that only matched by accident: the
system message then contained the prompt's below-boundary sections, so the
"shared prefix" included text the prompt itself says belongs below the boundary.
With the boundary honoured, the request is a true prefix-extension and the
system message is exactly the sections above the boundary. The trade is honest:
fewer matching bytes, and the bytes that match are the ones the design says are
stable.

## What this does not show

- **No hit rate.** Nothing here contacts a Provider, so no cache-hit percentage
  is claimed and the 95% acceptance target is not asserted. A Provider's cache
  depends on its own state as well as prefix stability.
  Real Provider readings now exist separately, from two live frozen loads run
  through the app (`scripts/verify-harness-path-comparison.mjs`, audited with
  `scripts/audit-cache-usage.mjs`): 78.098% / 78.182% overall on a shared
  20-task conversation session, 83.690% / 84.523% on continuous tool work, and
  62.827% / 63.228% with compaction enabled. They were recorded under the deleted
  shadow/next dual drive, so they describe that implementation only; the current
  criterion and readings are in
  [`../cache-95-acceptance.md`](../cache-95-acceptance.md) ("现行实测") and
  [`../../decision/project-status.md`](../../decision/project-status.md), and none
  of the three reaches 95%.
- **No usage completeness.** The probe's requests have no Provider usage, so the
  usage-completeness dimension SP-08 asks for is recorded as `unavailable` rather
  than reported as zero.
- **Only two freezes.** The comparison is between one pre-fix commit and one
  post-fix commit on a synthetic frozen load. It is evidence that the structural
  defects named in the taskbook are repaired; it is not a measurement of a real
  session. The later re-pins are the same measurement at a newer commit, not
  additional evidence.
- **Cost is not net-negative.** The fixed catalog makes requests larger, and
  honouring the boundary turns below-boundary sections into their own messages
  rather than folding them into the system message. Whether that pays off depends
  on how many turn-to-turn prefix bytes it recovers, which only a real long
  session can measure.
