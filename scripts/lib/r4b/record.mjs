// Build a validated V2 record from one controlled-run observation.
//
// This is the single projection point between the adapter observation and the
// immutable record: it attaches product/evaluator provenance, derives execution
// counters and credibility, and refuses to emit a record that violates the
// contract invariants (the validator throws with structured errors).
import {
  CONTRACT_VERSION, SCHEMA_VERSION, sha256Text, validateEvaluationRecord,
} from './contract.mjs';

export function buildRecord({
  loaded, task, trial, batchId, observation, gitState, evaluatorFingerprint,
  contractSha256, taskSuiteSha256, command, variant = null, faultMode = null,
}) {
  if (!observation || typeof observation !== 'object') throw new Error('V2 observation is required');
  if (observation.taskId !== task.id) throw new Error(`Observation taskId ${String(observation.taskId)} does not match ${task.id}`);
  const obs = observation.observation ?? {};
  const runtime = obs.runtime ?? {};
  const cleanup = obs.cleanup ?? { attempted: true, succeeded: false, residuals: ['missing cleanup evidence'] };
  const infrastructureStatus = cleanup.succeeded === true
    ? (runtime.infrastructureStatus ?? 'executed')
    : 'harness_error';
  const dimensions = structuredClone(obs.dimensions ?? {});
  if (cleanup.succeeded !== true) {
    for (const name of ['goal', 'contract']) {
      if (dimensions[name] && dimensions[name].status !== 'not_applicable') {
        dimensions[name] = { ...dimensions[name], status: 'unverified', rejectionReasons: [], missingFields: ['cleanup_failed'] };
      }
    }
    if (dimensions.mechanism) dimensions.mechanism = { ...dimensions.mechanism, status: 'unverified', missingFields: ['cleanup_failed'] };
  }
  const missingFields = [];
  for (const name of ['goal', 'contract', 'mechanism']) {
    for (const field of dimensions[name]?.missingFields ?? []) missingFields.push(`${name}.${field}`);
  }
  const usage = obs.providerUsage ?? {
    status: 'unavailable', inputTokens: null, outputTokens: null, cachedInputTokens: null,
    source: null, reason: 'scripted provider has no authoritative billing or usage receipt',
  };
  const record = {
    schemaVersion: SCHEMA_VERSION,
    contractVersion: CONTRACT_VERSION,
    recordId: `${'v2'}:${batchId}:${task.id}:trial:${trial}`,
    batchId,
    taskId: task.id,
    taskVersion: task.version,
    trial,
    evidenceTier: 'A_runtime_deterministic',
    ancestry: task.ancestry,
    product: {
      sha: gitState.sha,
      treeFingerprint: gitState.treeFingerprint,
      dirty: gitState.dirty === true,
      sourceDirty: gitState.sourceDirty === true,
      dirtyPaths: [...(gitState.dirtyPaths ?? [])],
    },
    evaluator: {
      fingerprint: evaluatorFingerprint,
      contractSha256,
      taskSuiteSha256,
      command,
    },
    modelConfig: obs.modelConfig ?? { providerId: 'scripted', simulated: true, wireModelId: null, apiProtocol: null, parameters: {} },
    userGoal: { text: task.userInput, textSha256: sha256Text(task.userInput), constraintVersion: CONTRACT_VERSION },
    dimensions,
    legacyOracle: null,
    providerUsage: usage,
    execution: {
      infrastructureStatus,
      startedAt: runtime.startedAt ?? new Date().toISOString(),
      endedAt: runtime.endedAt ?? new Date().toISOString(),
      durationMs: Number.isFinite(runtime.durationMs) ? runtime.durationMs : 0,
      requests: {
        logical: Number.isInteger(runtime.modelRequests) ? runtime.modelRequests : 0,
        physical: 0,
        retries: 0,
        blocked: 0,
        budget: 0,
      },
      tokens: { requestedMax: null, effectiveMax: null, observedInput: null, observedOutput: null },
      tooling: {
        proposals: Number.isInteger(runtime.toolProposals) ? runtime.toolProposals : null,
        executed: Number.isInteger(runtime.toolExecutions) ? runtime.toolExecutions : null,
        denied: Number.isInteger(runtime.deniedToolCalls) ? runtime.deniedToolCalls : 0,
        failed: Number.isInteger(runtime.failedToolCalls) ? runtime.failedToolCalls : 0,
      },
      effects: {
        settled: Number.isInteger(runtime.settledEffects) ? runtime.settledEffects : null,
        duplicateSuccessful: Number.isInteger(obs.duplicateSuccessfulEffects) ? obs.duplicateSuccessfulEffects : 0,
        unknown: 0,
      },
    },
    safety: obs.safety ?? { networkPolicy: 'denied', agentNetworkRequests: null, forbiddenRequests: 0, credentialsRedacted: true },
    credibility: {
      level: cleanup.succeeded === true && missingFields.length === 0 ? 'direct_evidence' : 'partial_evidence',
      missingFields,
    },
    cleanup,
    batchVariant: variant,
    faultMode,
    taskDefinitionSha256: task.taskDefinitionSha256 ?? null,
    suiteSha256: loaded.suiteSha256,
    oracleDetails: Object.fromEntries(['goal', 'contract', 'mechanism'].map((name) => [name, dimensions[name] ?? null])),
  };
  const validation = validateEvaluationRecord(record, { task, expectedFingerprint: evaluatorFingerprint });
  if (!validation.valid) {
    const error = new Error(`Built record is invalid: ${validation.errors.map((item) => `${item.code}@${item.path}`).join(', ')}`);
    error.code = 'V2_RECORD_INVALID';
    error.errors = validation.errors;
    throw error;
  }
  return record;
}
