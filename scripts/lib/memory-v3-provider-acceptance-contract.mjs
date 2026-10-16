import assert from 'node:assert/strict';

const RETIRED_STAGES = new Set(['decide', 'verify', 'evolve', 'capture']);

/** Validate a real run trace against the live seven-stage graph, without judging task completion. */
export function assertCurrentTrace(log, stageGraph) {
  const { isAllowedTransition, isCurrentStageName } = stageGraph;
  assert.equal(typeof isAllowedTransition, 'function', 'The current stage transition graph is required.');
  assert.equal(typeof isCurrentStageName, 'function', 'The current stage registry is required.');
  const trace = Array.isArray(log?.trace) ? log.trace : [];
  const names = trace.map((entry) => entry?.name);
  const rendered = names.map((name, index) => `${String(name)}:${trace[index]?.ok ? 'ok' : 'failed'}`).join('|') || 'none';
  assert(trace.length > 0, `The real Provider run has no stage trace; trace=${rendered}`);

  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (!isCurrentStageName(name)) {
      const kind = RETIRED_STAGES.has(name) ? 'retired' : 'unknown';
      assert.fail(`The real Provider run trace contains ${kind} stage '${String(name)}'; trace=${rendered}`);
    }
    if (index > 0) {
      const previous = names[index - 1];
      assert(isAllowedTransition(previous, name),
        `The real Provider run trace contains illegal transition '${previous}' -> '${name}'; trace=${rendered}`);
    }
  }

  assert.equal(names[0], 'enter', `The real Provider run did not start at ENTER; trace=${rendered}`);
  assert.equal(names.at(-1), 'finalize', `The real Provider run did not reach FINALIZE; trace=${rendered}`);
}

/** Which atoms both the run's memory ledger and KnownState admitted. */
export function admittedIntoContext(log, atomIds) {
  const accessRecords = log.memoryAccess?.records ?? [];
  const references = log.memoryKnownState?.references ?? [];
  const admittedAtomIds = atomIds.filter((atomId) => (
    accessRecords.some((record) => record.fragmentIds?.includes(atomId) && record.tokensUsed > 0)
    && references.some((reference) => reference.atomId === atomId && reference.decision === 'adopted')
  ));
  return {
    admittedAtomIds,
    stages: [...new Set(accessRecords
      .filter((record) => record.fragmentIds?.some((fragmentId) => admittedAtomIds.includes(fragmentId)))
      .map((record) => record.action))],
  };
}

/** Require durable memory to have been admitted into Context through both runtime evidence channels. */
export function assertMemoryEnteredContext(log, atomIds, phase) {
  const admitted = admittedIntoContext(log, atomIds);
  assert(admitted.admittedAtomIds.length > 0,
    `The ${phase} run admitted none of [${atomIds.join(', ')}] into memory context; `
    + `ledger=${describeAccessRecords(log.memoryAccess?.records ?? [])}; `
    + `knownState=${describeReferences(log.memoryKnownState?.references ?? [])}`);
  return admitted;
}

export function describeAccessRecords(records) {
  return records
    .map((record) => `${record.action}:${record.status}:${record.tokensUsed}:[${(record.fragmentIds ?? []).join(',')}]`)
    .join(' | ') || 'none';
}

function describeReferences(references) {
  return references.map((reference) => `${reference.atomId}:${reference.decision}`).join(' | ') || 'none';
}