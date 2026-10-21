# RCD R4-B 三维评测契约 V2 受控运行报告

**批次：** `r4b-offline-2026-10-21`　**契约版本：** `2.0.0`　**证据层级：** `A_runtime_deterministic`

> 本报告由 `node scripts/eval-v2.mjs --report` 从不可变记录重新生成。受控 scripted Provider 的结果不代表真实模型能力；本批次**未执行任何真实付费 Provider 请求**。

## 有效样本与统计口径

| 维度 | 分母 ID | n | 通过 | 失败 | 排除（不计入分母） |
|---|---|---:|---:|---:|---|
| Goal 完成率 | A_runtime_deterministic:goal | 20 | 20 | 0 | — |
| Contract 遵循率 | A_runtime_deterministic:contract | 5 | 5 | 0 | not_applicable=15 |
| Mechanism 已触发成功率 | A_runtime_deterministic:mechanism | 5 | 5 | 0 | not_exercised=15 |

`not_exercised`、`unverified`、`not_applicable` 与 `blocked` 只作为排除项单列，不计入任何成功或失败分母；每个指标 n 即其有效样本数。`populationClaim` 在全部分母上固定为 false，不据此作模型能力结论。

## 分任务指标

| 任务 | 维度 | 分母 ID | n | 通过 | 失败 |
|---|---|---|---:|---:|---:|
| DELIV-01-G | goal | A_runtime_deterministic:goal:DELIV-01-G | 5 | 5 | 0 |
| DELIV-01-G | contract | A_runtime_deterministic:contract:DELIV-01-G | 0 | 0 | 0 |
| DELIV-01-G | mechanism | A_runtime_deterministic:mechanism:DELIV-01-G | 0 | 0 | 0 |
| DELIV-01-R | goal | A_runtime_deterministic:goal:DELIV-01-R | 5 | 5 | 0 |
| DELIV-01-R | contract | A_runtime_deterministic:contract:DELIV-01-R | 0 | 0 | 0 |
| DELIV-01-R | mechanism | A_runtime_deterministic:mechanism:DELIV-01-R | 5 | 5 | 0 |
| FILE-02-G | goal | A_runtime_deterministic:goal:FILE-02-G | 5 | 5 | 0 |
| FILE-02-G | contract | A_runtime_deterministic:contract:FILE-02-G | 0 | 0 | 0 |
| FILE-02-G | mechanism | A_runtime_deterministic:mechanism:FILE-02-G | 0 | 0 | 0 |
| FILE-02-S | goal | A_runtime_deterministic:goal:FILE-02-S | 5 | 5 | 0 |
| FILE-02-S | contract | A_runtime_deterministic:contract:FILE-02-S | 5 | 5 | 0 |
| FILE-02-S | mechanism | A_runtime_deterministic:mechanism:FILE-02-S | 0 | 0 | 0 |

## 逐次 V2 记录

| 记录 ID | 任务 | trial | Goal | Contract | Mechanism | 逻辑请求 | 物理请求 | 工具执行 | 已结算 Effect | 可信度 | 清理 |
|---|---|---:|---|---|---|---:|---:|---:|---:|---|---|
| v2:r4b-offline-2026-10-21:DELIV-01-G:trial:1 | DELIV-01-G | 1 | passed | not_applicable | not_exercised | 2 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-G:trial:2 | DELIV-01-G | 2 | passed | not_applicable | not_exercised | 2 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-G:trial:3 | DELIV-01-G | 3 | passed | not_applicable | not_exercised | 2 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-G:trial:4 | DELIV-01-G | 4 | passed | not_applicable | not_exercised | 2 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-G:trial:5 | DELIV-01-G | 5 | passed | not_applicable | not_exercised | 2 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-R:trial:1 | DELIV-01-R | 1 | passed | not_applicable | passed | 3 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-R:trial:2 | DELIV-01-R | 2 | passed | not_applicable | passed | 3 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-R:trial:3 | DELIV-01-R | 3 | passed | not_applicable | passed | 3 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-R:trial:4 | DELIV-01-R | 4 | passed | not_applicable | passed | 3 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:DELIV-01-R:trial:5 | DELIV-01-R | 5 | passed | not_applicable | passed | 3 | 0 | 1 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-G:trial:1 | FILE-02-G | 1 | passed | not_applicable | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-G:trial:2 | FILE-02-G | 2 | passed | not_applicable | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-G:trial:3 | FILE-02-G | 3 | passed | not_applicable | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-G:trial:4 | FILE-02-G | 4 | passed | not_applicable | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-G:trial:5 | FILE-02-G | 5 | passed | not_applicable | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-S:trial:1 | FILE-02-S | 1 | passed | passed | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-S:trial:2 | FILE-02-S | 2 | passed | passed | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-S:trial:3 | FILE-02-S | 3 | passed | passed | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-S:trial:4 | FILE-02-S | 4 | passed | passed | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |
| v2:r4b-offline-2026-10-21:FILE-02-S:trial:5 | FILE-02-S | 5 | passed | passed | not_exercised | 3 | 0 | 2 | 1 | direct_evidence | ok |

### 证据与拒绝原因

- `v2:r4b-offline-2026-10-21:DELIV-01-G:trial:1`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-G:trial:2`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-G:trial:3`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-G:trial:4`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-G:trial:5`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-R:trial:1`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`invocation://write-invalid:validation_failed:input_validation, invocation://write-corrected:succeeded`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-R:trial:2`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`invocation://write-invalid:validation_failed:input_validation, invocation://write-corrected:succeeded`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-R:trial:3`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`invocation://write-invalid:validation_failed:input_validation, invocation://write-corrected:succeeded`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-R:trial:4`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`invocation://write-invalid:validation_failed:input_validation, invocation://write-corrected:succeeded`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:DELIV-01-R:trial:5`
  - goal: evidence=`workspace://result.txt#sha256=69188ece3b5874fdca30429af10e9c357002ac68e48883f29d825d51501664b0`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`invocation://write-invalid:validation_failed:input_validation, invocation://write-corrected:succeeded`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-G:trial:1`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-G:trial:2`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-G:trial:3`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-G:trial:4`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-G:trial:5`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`—`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-S:trial:1`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-S:trial:2`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-S:trial:3`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-S:trial:4`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`
- `v2:r4b-offline-2026-10-21:FILE-02-S:trial:5`
  - goal: evidence=`workspace://inventory.csv#sha256=b659f4f9aa5d678b77f96c0de402a18230e7fd35c0e64575ff53a35d01be33ce, workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - contract: evidence=`workspace://inventory-summary.json#sha256=f75a4789388817c96111fe9b2e38e6bdf07534dd000d3d69b55e039e7ff84984`; rejection=`—`; missing=`—`
  - mechanism: evidence=`—`; rejection=`—`; missing=`—`
  - provenance: product=`71fcb594221f7c100485179a66d4b39058d66047`, evaluator=`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`, taskVersion=`2.0.0`

## 历史结果（原契约，只读展示）

历史分母单独记为 `legacy-frozen-s3b`，**不映射**到 V2 三维度，也不进入上方任何 V2 指标。受控历史记录 8 条，真实模型尝试 6 条。

| 来源 | task | trial | 原 Oracle 结果 | 物理请求 | 备注 |
|---|---|---:|---|---:|---|
| controlled | CODE-01 | 1 | passed | 0 | legacy-display-only |
| controlled | FILE-02 | 1 | passed | 0 | legacy-display-only |
| controlled | DELIV-01 | 1 | passed | 0 | legacy-display-only |
| controlled | MULTI-01 | 1 | partially_completed | 0 | legacy-display-only |
| controlled | RETR-01 | 1 | passed | 0 | legacy-display-only |
| controlled | LONG-01 | 1 | passed | 0 | legacy-display-only |
| controlled | LONG-02 | 1 | passed | 0 | legacy-display-only |
| controlled | DELIV-02 | 1 | failed | 0 | legacy-display-only |
| real-deepseek | CODE-01 | 1 | failed | 8 | 错误模型 ID（历史 16 次失败请求，不计入 V2 分母） |
| real-deepseek | FILE-02 | 1 | failed | 8 | 错误模型 ID（历史 16 次失败请求，不计入 V2 分母） |
| real-deepseek | DELIV-01 | 1 | failed | 2 | valid-model attempt |
| real-deepseek | MULTI-01 | 1 | passed | 3 | valid-model attempt |
| real-deepseek | CODE-01 | 2 | passed | 4 | valid-model attempt |
| real-deepseek | FILE-02 | 2 | failed | 4 | valid-model attempt |

历史错误模型 ID 的物理请求合计：**16**；这些请求在历史账本中保留，但**不进入任何 V2 trial 分母**。历史结果与 V2 结果的失败归因分类器版本不同，不直接比较、不相加。

## 环境、安全与清理

- 产品 SHA：`71fcb594221f7c100485179a66d4b39058d66047`
- 评测器指纹：`56d97aae41769b99441c96a0cf1b9582bfd20526503ce5621cf824071d5748c4`
- 记录数：20；清理失败：0
- Provider：全部记录为 simulated scripted Provider（`yes`）；真实 Provider 用量与费用保持 `unavailable`，没有由 token 推断费用。
- 安全：Agent 网络策略 denied、无凭据写入记录、无真实 Provider 请求。

## 明确未运行

- 真实付费 Provider / 真实模型评测（本批次不授权、不执行）。
- Electron GUI 真实显示器验收（需桌面会话，不属于本契约）。
- WSL 终端专项验收（host-only opt-in 入口，不属于本契约）。
- Linux/macOS 跨平台构建与打包验收。

