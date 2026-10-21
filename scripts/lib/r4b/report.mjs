// R4-B4 ledger assembly and human-readable report.
//
// The report shows two explicitly separated populations:
// - V2 controlled records (goal/contract/mechanism, denominator per dimension)
// - legacy S3A/S3B results read display-only from the frozen ledgers
// Legacy results are never mapped to V2 dimensions and never enter V2 rates.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CONTRACT_VERSION, REPO_ROOT, SUITE_ID } from './contract.mjs';
import { computeMetrics } from './metrics.mjs';
import { buildLedger, readRecords, REPORT_PATH } from './ledger.mjs';

export const LEGACY_CONTROLLED_PATH = 'docs/reference/rcd-s3b-controlled-baseline-2026-10-17.json';
export const LEGACY_REAL_BATCH_PATH = 'docs/reference/rcd-s3b-real-deepseek-batch-2026-10-17.json';

export function readLegacyDisplayRows({ repoRoot = REPO_ROOT } = {}) {
  const controlled = JSON.parse(readFileSync(join(repoRoot, LEGACY_CONTROLLED_PATH), 'utf8'));
  const controlledRows = (controlled.records ?? []).map((record) => ({
    recordId: record.recordId ?? null,
    taskId: record.taskId ?? null,
    trial: record.trial ?? null,
    evidenceTier: record.evidenceTier ?? 'A_runtime_deterministic',
    oracleResult: record.oracle?.result ?? 'unverified',
    oracleVersion: 'legacy-s3b-v1',
    logicalModelRequests: record.execution?.logicalModelRequests ?? null,
    physicalProviderRequests: record.execution?.physicalProviderRequests ?? null,
    displayOnly: true,
    mappedToDimensions: false,
  }));
  const batch = JSON.parse(readFileSync(join(repoRoot, LEGACY_REAL_BATCH_PATH), 'utf8'));
  const attempts = (batch.attempts ?? []).map((attempt) => {
    const sentModel = attempt.providerModelIdSent ?? null;
    return {
      recordId: null,
      taskId: attempt.taskId ?? null,
      trial: attempt.trial ?? null,
      evidenceTier: 'B_real_model',
      oracleResult: attempt.oracleResult ?? 'unverified',
      oracleVersion: 'legacy-s3b-v1',
      logicalModelRequests: attempt.logicalModelRequests ?? null,
      physicalProviderRequests: attempt.physicalProviderRequests ?? null,
      invalidModelId: typeof sentModel === 'string' && sentModel.includes('/'),
      infrastructureStatus: attempt.infrastructureStatus ?? null,
      displayOnly: true,
      mappedToDimensions: false,
    };
  });
  const validModelAttempts = attempts.filter((row) => !row.invalidModelId && row.infrastructureStatus === 'executed');
  const invalidModelAttempts = attempts.filter((row) => row.invalidModelId);
  return {
    controlledRows,
    attempts,
    validModelAttempts,
    invalidModelAttempts,
    invalidModelPhysicalRequests: invalidModelAttempts.reduce((sum, row) => sum + (row.physicalProviderRequests ?? 0), 0),
    controlledPath: LEGACY_CONTROLLED_PATH,
    realBatchPath: LEGACY_REAL_BATCH_PATH,
    mappedToDimensions: false,
  };
}

export function buildBatchLedger({ records, batchId, legacy }) {
  return buildLedger({
    records,
    batchId,
    suiteId: SUITE_ID,
    metrics: computeMetrics(records),
    legacy: {
      records: [...legacy.controlledRows, ...legacy.attempts],
      mappedToDimensions: false,
      denominatorId: 'legacy-frozen-s3b',
      note: 'Display-only legacy results. Never mapped to V2 goal/contract/mechanism and never added to V2 denominators.',
    },
  });
}

function dimensionCell(record, name) {
  const dimension = record.dimensions[name];
  if (!dimension) return 'missing';
  const suffix = dimension.rejectionReasons?.length ? `: ${dimension.rejectionReasons[0]}` : '';
  return `${dimension.status}${suffix}`;
}

function statusTable(metric, label) {
  const excluded = Object.entries(metric.excluded ?? {}).map(([key, value]) => `${key}=${value}`).join(', ') || '—';
  return `| ${label} | ${metric.denominatorId} | ${metric.n} | ${metric.passed} | ${metric.failed} | ${excluded} |`;
}

export function renderReport({ ledger, legacy }) {
  const lines = [];
  lines.push('# RCD R4-B 三维评测契约 V2 受控运行报告');
  lines.push('');
  lines.push(`**批次：** \`${ledger.batchId}\`　**契约版本：** \`${CONTRACT_VERSION}\`　**证据层级：** \`${ledger.evidenceTier}\``);
  lines.push('');
  lines.push('> 本报告由 `node scripts/eval-v2.mjs --report` 从不可变记录重新生成。受控 scripted Provider 的结果不代表真实模型能力；本批次**未执行任何真实付费 Provider 请求**。');
  lines.push('');
  lines.push('## 有效样本与统计口径');
  lines.push('');
  lines.push('| 维度 | 分母 ID | n | 通过 | 失败 | 排除（不计入分母） |');
  lines.push('|---|---|---:|---:|---:|---|');
  lines.push(statusTable(ledger.metrics.goal, 'Goal 完成率'));
  lines.push(statusTable(ledger.metrics.contract, 'Contract 遵循率'));
  lines.push(statusTable(ledger.metrics.mechanism, 'Mechanism 已触发成功率'));
  lines.push('');
  lines.push('`not_exercised`、`unverified`、`not_applicable` 与 `blocked` 只作为排除项单列，不计入任何成功或失败分母；每个指标 n 即其有效样本数。`populationClaim` 在全部分母上固定为 false，不据此作模型能力结论。');
  lines.push('');
  lines.push('## 分任务指标');
  lines.push('');
  lines.push('| 任务 | 维度 | 分母 ID | n | 通过 | 失败 |');
  lines.push('|---|---|---|---:|---:|---:|');
  for (const [taskId, taskMetrics] of Object.entries(ledger.metrics.perTask)) {
    for (const name of ['goal', 'contract', 'mechanism']) {
      const metric = taskMetrics[name];
      lines.push(`| ${taskId} | ${name} | ${metric.denominatorId} | ${metric.n} | ${metric.passed} | ${metric.failed} |`);
    }
  }
  lines.push('');
  lines.push('## 逐次 V2 记录');
  lines.push('');
  lines.push('| 记录 ID | 任务 | trial | Goal | Contract | Mechanism | 逻辑请求 | 物理请求 | 工具执行 | 已结算 Effect | 可信度 | 清理 |');
  lines.push('|---|---|---:|---|---|---|---:|---:|---:|---:|---|---|');
  for (const record of ledger.records) {
    lines.push(`| ${record.recordId} | ${record.taskId} | ${record.trial} | ${dimensionCell(record, 'goal')} | ${dimensionCell(record, 'contract')} | ${dimensionCell(record, 'mechanism')} | ${record.execution.requests.logical} | ${record.execution.requests.physical} | ${record.execution.tooling.executed ?? 'null'} | ${record.execution.effects.settled ?? 'null'} | ${record.credibility.level} | ${record.cleanup.succeeded ? 'ok' : 'failed'} |`);
  }
  lines.push('');
  lines.push('### 证据与拒绝原因');
  lines.push('');
  for (const record of ledger.records) {
    lines.push(`- \`${record.recordId}\``);
    for (const name of ['goal', 'contract', 'mechanism']) {
      const dimension = record.dimensions[name];
      if (!dimension) continue;
      const evidence = (dimension.evidenceRefs ?? []).slice(0, 4).join(', ') || '—';
      const rejections = (dimension.rejectionReasons ?? []).join('；') || '—';
      const missing = (dimension.missingFields ?? []).join(', ') || '—';
      lines.push(`  - ${name}: evidence=\`${evidence}\`; rejection=\`${rejections}\`; missing=\`${missing}\``);
    }
    lines.push(`  - provenance: product=\`${record.product.sha}\`, evaluator=\`${record.evaluator.fingerprint}\`, taskVersion=\`${record.taskVersion}\``);
  }
  lines.push('');
  lines.push('## 历史结果（原契约，只读展示）');
  lines.push('');
  lines.push(`历史分母单独记为 \`legacy-frozen-s3b\`，**不映射**到 V2 三维度，也不进入上方任何 V2 指标。受控历史记录 ${legacy.controlledRows.length} 条，真实模型尝试 ${legacy.attempts.length} 条。`);
  lines.push('');
  lines.push('| 来源 | task | trial | 原 Oracle 结果 | 物理请求 | 备注 |');
  lines.push('|---|---|---:|---|---:|---|');
  for (const row of legacy.controlledRows) {
    lines.push(`| controlled | ${row.taskId} | ${row.trial} | ${row.oracleResult} | ${row.physicalProviderRequests ?? 'null'} | legacy-display-only |`);
  }
  for (const row of legacy.attempts) {
    const note = row.invalidModelId
      ? '错误模型 ID（历史 16 次失败请求，不计入 V2 分母）'
      : (row.infrastructureStatus === 'executed' ? 'valid-model attempt' : 'dispatch diagnostic');
    lines.push(`| real-deepseek | ${row.taskId} | ${row.trial ?? 'null'} | ${row.oracleResult} | ${row.physicalProviderRequests ?? 'null'} | ${note} |`);
  }
  lines.push('');
  lines.push(`历史错误模型 ID 的物理请求合计：**${legacy.invalidModelPhysicalRequests}**；这些请求在历史账本中保留，但**不进入任何 V2 trial 分母**。历史结果与 V2 结果的失败归因分类器版本不同，不直接比较、不相加。`);
  lines.push('');
  lines.push('## 环境、安全与清理');
  lines.push('');
  const uniqueProducts = [...new Set(ledger.records.map((record) => record.product.sha))];
  const uniqueEvaluators = [...new Set(ledger.records.map((record) => record.evaluator.fingerprint))];
  lines.push(`- 产品 SHA：${uniqueProducts.map((sha) => `\`${sha}\``).join(', ')}`);
  lines.push(`- 评测器指纹：${uniqueEvaluators.map((fingerprint) => `\`${fingerprint}\``).join(', ')}`);
  lines.push(`- 记录数：${ledger.records.length}；清理失败：${ledger.records.filter((record) => !record.cleanup.succeeded).length}`);
  lines.push(`- Provider：全部记录为 simulated scripted Provider（\`${ledger.records.every((record) => record.modelConfig.simulated) ? 'yes' : 'no'}\`）；真实 Provider 用量与费用保持 \`unavailable\`，没有由 token 推断费用。`);
  lines.push('- 安全：Agent 网络策略 denied、无凭据写入记录、无真实 Provider 请求。');
  lines.push('');
  lines.push('## 明确未运行');
  lines.push('');
  lines.push('- 真实付费 Provider / 真实模型评测（本批次不授权、不执行）。');
  lines.push('- Electron GUI 真实显示器验收（需桌面会话，不属于本契约）。');
  lines.push('- WSL 终端专项验收（host-only opt-in 入口，不属于本契约）。');
  lines.push('- Linux/macOS 跨平台构建与打包验收。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function writeReportFile({ path = REPORT_PATH, content, force = false, repoRoot = REPO_ROOT }) {
  const absolute = isAbsolute(path) ? path : join(repoRoot, path);
  if (!force && existsSync(absolute)) {
    const error = new Error(`REPORT_EXISTS: refusing to overwrite ${absolute}; use --force-report`);
    error.code = 'REPORT_EXISTS';
    throw error;
  }
  writeFileSync(absolute, content, 'utf8');
  return absolute;
}

export function readLedgerRecords({ repoRoot = REPO_ROOT, recordsDir, tasks, options = {} }) {
  return readRecords({ dir: resolve(repoRoot, recordsDir), tasks, options });
}
