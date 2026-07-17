// Projects execution logs into bounded, redacted Memory v3 workload signals.

const MAX_RECORDS_PER_RUN = 4_096;
const MAX_REFERENCES_PER_RUN = 4_096;
const MAX_VERIFICATIONS_PER_RUN = 512;
const MAX_ATOM_IDS_PER_RECORD = 1_024;
const MAX_CONTEXT_SNAPSHOTS_PER_RUN = 512;
const SAFE_ACCESS_ACTIONS = new Set(['root_index', 'branch_index', 'expand', 'deep_search', 'release']);
const SAFE_ACCESS_STATUSES = new Set(['ok', 'degraded', 'error']);
const SAFE_KNOWN_DECISIONS = new Set(['adopted', 'excluded', 'conflicted']);
const SAFE_TASK_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'blocked', 'partial']);

export function projectExecutionLog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value;
  let truncated = false;
  const memoryAccessRecords = boundedArray(raw.memoryAccess?.records, MAX_RECORDS_PER_RUN);
  const knownReferences = boundedArray(raw.memoryKnownState?.references, MAX_REFERENCES_PER_RUN);
  const verificationHistory = boundedArray(raw.verificationHistory, MAX_VERIFICATIONS_PER_RUN);
  const contextSnapshots = boundedArray(raw.contextSnapshots, MAX_CONTEXT_SNAPSHOTS_PER_RUN);
  truncated = memoryAccessRecords.truncated
    || knownReferences.truncated
    || verificationHistory.truncated
    || contextSnapshots.truncated;

  const log = {
    status: safeString(raw.status, 32) ?? 'other',
    taskExecution: raw.taskExecution && typeof raw.taskExecution === 'object'
      ? { status: safeTaskStatus(raw.taskExecution.status) }
      : undefined,
    memoryAccess: raw.memoryAccess && typeof raw.memoryAccess === 'object'
      ? {
          tokensUsed: finiteNonNegative(raw.memoryAccess.tokensUsed),
          totalTokenBudget: finiteNonNegative(raw.memoryAccess.totalTokenBudget),
          records: memoryAccessRecords.items.map((record) => {
            const atomIds = boundedAtomIds(record?.fragmentIds);
            if (atomIds.truncated) truncated = true;
            return {
              action: SAFE_ACCESS_ACTIONS.has(record?.action) ? record.action : 'other',
              status: SAFE_ACCESS_STATUSES.has(record?.status) ? record.status : 'other',
              fragmentIds: atomIds.items,
            };
          }),
        }
      : undefined,
    memoryKnownState: raw.memoryKnownState && typeof raw.memoryKnownState === 'object'
      ? {
          references: knownReferences.items.flatMap((reference) => {
            const atomId = safeAtomId(reference?.atomId);
            if (!atomId || !SAFE_KNOWN_DECISIONS.has(reference?.decision)) return [];
            return [{
              atomId,
              decision: reference.decision,
              reactivatedCount: finiteNonNegative(reference.reactivatedCount),
            }];
          }),
        }
      : undefined,
    verificationHistory: verificationHistory.items.map((verification) => {
      const atomIds = boundedAtomIds(verification?.usedMemoryAtomIds);
      if (atomIds.truncated) truncated = true;
      return {
        verdict: safeString(verification?.verdict, 32) ?? 'unknown',
        usedMemoryAtomIds: atomIds.items,
      };
    }),
    contextSnapshots: contextSnapshots.items.map((snapshot) => ({
      providerUsage: projectProviderUsage(snapshot?.providerUsage),
    })),
    runtimeResources: projectRuntimeResources(raw.runtimeResources),
  };
  return { truncated, log };
}

function projectProviderUsage(value) {
  if (!value || typeof value !== 'object' || value.source !== 'provider') return undefined;
  return {
    source: 'provider',
    promptTokens: finiteNonNegative(value.promptTokens),
    completionTokens: finiteNonNegative(value.completionTokens),
    cachedPromptTokens: finiteNonNegative(value.cachedPromptTokens),
    reasoningTokens: finiteNonNegative(value.reasoningTokens),
  };
}

function projectRuntimeResources(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return undefined;
  const device = value.device;
  const start = projectResourceSample(value.start);
  const end = projectResourceSample(value.end);
  if (!device || typeof device !== 'object' || !start || !end) return undefined;
  if (!isPositiveInteger(device.totalMemoryMiBBucket) || !isPositiveInteger(device.logicalCpuBucket)) return undefined;
  return {
    version: 1,
    device: {
      platform: safePlatform(device.platform),
      arch: safeLabel(device.arch),
      totalMemoryMiBBucket: device.totalMemoryMiBBucket,
      logicalCpuBucket: device.logicalCpuBucket,
    },
    start,
    end,
  };
}

function projectResourceSample(value) {
  if (!value || typeof value !== 'object') return undefined;
  return {
    rssBytes: finiteNonNegative(value.rssBytes),
    heapUsedBytes: finiteNonNegative(value.heapUsedBytes),
  };
}

function safeTaskStatus(value) {
  return SAFE_TASK_STATUSES.has(value) ? value : 'other';
}

function boundedArray(value, limit) {
  if (!Array.isArray(value)) return { items: [], truncated: false };
  return { items: value.slice(0, limit), truncated: value.length > limit };
}

function boundedAtomIds(value) {
  const bounded = boundedArray(value, MAX_ATOM_IDS_PER_RECORD);
  return {
    items: bounded.items.flatMap((candidate) => {
      const atomId = safeAtomId(candidate);
      return atomId ? [atomId] : [];
    }),
    truncated: bounded.truncated,
  };
}

function safeAtomId(value) {
  return safeString(value, 512);
}

function safeString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function safePlatform(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/iu.test(value) ? value.toLowerCase() : 'other';
}

function safeLabel(value) {
  return safePlatform(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
