// Deterministic V2 oracles for the four R4-B tasks.
//
// Each oracle reads its evidence from a workspace snapshot and invocation /
// effect facts passed in by the controlled adapter. Oracles never read the
// model's final reply and never accept an aggregate boolean: Goal, Contract
// and Mechanism are returned as independent dimension objects.
import { createHash } from 'node:crypto';
import { sha256Text } from './contract.mjs';

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

function ref(path, content) {
  return `workspace://${path}#sha256=${digest(content)}`;
}

function invocationRef(invocation, index) {
  const id = typeof invocation.callId === 'string' && invocation.callId.length > 0 ? invocation.callId : `call-${index + 1}`;
  return `invocation://${id}:${invocation.status}${invocation.errorKind ? `:${invocation.errorKind}` : ''}`;
}

function dimension(status, evidenceRefs, rejectionReasons = [], missingFields = [], extra = {}) {
  return { status, evidenceRefs, rejectionReasons, missingFields, ...extra };
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameFileSet(files, expected) {
  const actualSorted = [...new Set(files)].sort();
  const expectedSorted = [...expected].sort();
  return actualSorted.length === expectedSorted.length && actualSorted.every((file, index) => file === expectedSorted[index]);
}

function readJson(contents, path) {
  if (!Object.prototype.hasOwnProperty.call(contents, path)) return { ok: false, reason: `${path} is missing` };
  try {
    return { ok: true, value: JSON.parse(contents[path]) };
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
}

function evaluateItems(items, expectedItems, sortBy) {
  const reasons = [];
  if (!Array.isArray(items)) return { ok: false, reasons: ['items is not an array'] };
  const normalized = [];
  for (const [index, item] of items.entries()) {
    if (!isPlainObject(item)) {
      reasons.push(`items[${index}] is not an object`);
      continue;
    }
    const sku = item.sku;
    const qty = item.qty;
    if (typeof sku !== 'string' || sku.length === 0) reasons.push(`items[${index}].sku is not a non-empty string`);
    if (typeof qty !== 'number' || !Number.isFinite(qty)) reasons.push(`items[${index}].qty is not a finite number`);
    normalized.push({ sku, qty, index });
  }
  if (reasons.length > 0) return { ok: false, reasons };
  const actualSorted = [...normalized].sort((left, right) => String(left.sku).localeCompare(String(right.sku)));
  if (normalized.some((item, index) => item.sku !== actualSorted[index].sku)) {
    reasons.push(`${sortBy} order is not ascending`);
  }
  const expected = [...expectedItems].sort((left, right) => String(left[sortBy]).localeCompare(String(right[sortBy])));
  const actual = [...normalized].sort((left, right) => String(left[sortBy]).localeCompare(String(right[sortBy])));
  if (actual.length !== expected.length) reasons.push(`expected ${expected.length} items, found ${actual.length}`);
  for (const [index, item] of actual.entries()) {
    const wanted = expected[index];
    if (!wanted) continue;
    if (item.sku !== wanted.sku) reasons.push(`items[${index}].sku expected ${JSON.stringify(wanted.sku)}, found ${JSON.stringify(item.sku)}`);
    if (item.qty !== wanted.qty) reasons.push(`items[${index}].qty expected ${wanted.qty}, found ${String(item.qty)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Goal dimension for FILE-02-G / FILE-02-S: semantic data correctness only.
 * Multiple equivalent total-field spellings are accepted because the user asked
 * for the total quantity, not for one particular field name.
 */
export function evaluateFile02Goal({ task, files, contents }) {
  const rules = task.goalRules;
  const reasons = [];
  if (!sameFileSet(files, rules.requiredWorkspaceFiles)) {
    reasons.push(`workspace file set expected ${JSON.stringify([...rules.requiredWorkspaceFiles].sort())}, found ${JSON.stringify([...new Set(files)].sort())}`);
  }
  const parsed = readJson(contents, rules.outputFile);
  if (!parsed.ok) {
    reasons.push(parsed.reason);
    return dimension('failed', [], reasons, [], { expected: { total: rules.expectedTotal, items: rules.expectedItems }, actual: null });
  }
  const value = parsed.value;
  const evidence = [];
  if (!isPlainObject(value)) {
    reasons.push(`${rules.outputFile} is not a JSON object`);
  } else {
    const totalKeys = rules.acceptedTotalKeys.filter((key) => Object.prototype.hasOwnProperty.call(value, key));
    if (totalKeys.length === 0) {
      reasons.push(`no accepted total field ${JSON.stringify(rules.acceptedTotalKeys)} is present`);
    } else {
      const totals = totalKeys.map((key) => value[key]);
      if (totals.some((item) => typeof item !== 'number' || item !== rules.expectedTotal)) {
        reasons.push(`total quantity expected ${rules.expectedTotal}, found ${JSON.stringify(Object.fromEntries(totalKeys.map((key) => [key, value[key]])))}`);
      }
      if (new Set(totals.map(String)).size > 1) reasons.push('multiple total fields disagree');
    }
    const items = value[rules.itemsKey];
    if (items === undefined) {
      reasons.push(`items field ${JSON.stringify(rules.itemsKey)} is missing`);
    } else {
      const itemsResult = evaluateItems(items, rules.expectedItems, rules.sortBy);
      reasons.push(...itemsResult.reasons);
    }
  }
  for (const path of rules.requiredWorkspaceFiles) {
    if (Object.prototype.hasOwnProperty.call(contents, path)) evidence.push(ref(path, contents[path]));
  }
  return dimension(reasons.length === 0 ? 'passed' : 'failed', reasons.length === 0 ? evidence : [], reasons, [], {
    expected: { total: rules.expectedTotal, items: rules.expectedItems },
    actual: value,
    files: [...new Set(files)].sort(),
  });
}

/**
 * Contract dimension for FILE-02-S: strict adherence to the constraint that was
 * visible in the task text. It settles independently from the goal dimension.
 */
export function evaluateFile02Contract({ task, files, contents }) {
  const rules = task.goalRules;
  const contractRef = task.contract?.ref;
  const reasons = [];
  const parsed = readJson(contents, rules.outputFile);
  if (!parsed.ok) reasons.push(parsed.reason);
  const value = parsed.ok ? parsed.value : null;
  if (parsed.ok && (!isPlainObject(value) || Array.isArray(value))) reasons.push('top-level JSON value is not an object');
  if (isPlainObject(value)) {
    const keys = sortedKeys(value);
    if (JSON.stringify(keys) !== JSON.stringify(['items', 'total'])) {
      reasons.push(`top-level fields expected ["items","total"], found ${JSON.stringify(keys)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'total') || typeof value.total !== 'number' || value.total !== 5) {
      reasons.push('field "total" must be the number 5');
    }
    const items = value.items;
    if (!Array.isArray(items)) {
      reasons.push('field "items" must be an array');
    } else {
      if (items.length !== 2) reasons.push(`field "items" must contain 2 entries, found ${items.length}`);
      for (const [index, item] of items.entries()) {
        if (!isPlainObject(item)) {
          reasons.push(`items[${index}] is not an object`);
          continue;
        }
        const itemKeys = sortedKeys(item);
        if (JSON.stringify(itemKeys) !== JSON.stringify(['qty', 'sku'])) reasons.push(`items[${index}] fields expected ["qty","sku"], found ${JSON.stringify(itemKeys)}`);
        if (typeof item.sku !== 'string') reasons.push(`items[${index}].sku must be a string`);
        if (typeof item.qty !== 'number') reasons.push(`items[${index}].qty must be a number`);
      }
      const itemsResult = evaluateItems(items, rules.expectedItems, rules.sortBy);
      reasons.push(...itemsResult.reasons);
    }
  }
  const evidence = Object.prototype.hasOwnProperty.call(contents, rules.outputFile) ? [ref(rules.outputFile, contents[rules.outputFile])] : [];
  return dimension(reasons.length === 0 ? 'passed' : 'failed', reasons.length === 0 ? evidence : [], reasons, [], {
    constraintVisible: true,
    constraintRef: contractRef,
    contractVersion: task.contract?.version,
    expected: { total: 5, items: rules.expectedItems, additionalTopLevelFields: false },
    actual: value,
  });
}

/** Goal dimension for DELIV-01-G / DELIV-01-R: delivery correctness only. */
export function evaluateDeliv01Goal({ task, files, contents, successfulExecutions, duplicateSuccessfulEffects, toolName }) {
  const rules = task.goalRules;
  const reasons = [];
  const expectedFiles = [rules.outputFile];
  if (!sameFileSet(files, expectedFiles)) reasons.push(`workspace file set expected ${JSON.stringify(expectedFiles)}, found ${JSON.stringify([...new Set(files)].sort())}`);
  if (!Object.prototype.hasOwnProperty.call(contents, rules.outputFile)) {
    reasons.push(`${rules.outputFile} is missing`);
  } else if (contents[rules.outputFile] !== rules.expectedContent) {
    reasons.push(`${rules.outputFile} content mismatch`);
  }
  if (successfulExecutions !== rules.requiredSuccessfulExecutions) {
    reasons.push(`successful fixture executions expected ${rules.requiredSuccessfulExecutions}, found ${successfulExecutions}`);
  }
  if (rules.duplicateSuccessfulEffectsAllowed === false && duplicateSuccessfulEffects > 0) {
    reasons.push(`duplicate successful fixture effects: ${duplicateSuccessfulEffects}`);
  }
  if (toolName !== undefined && toolName !== rules.requiredTool) reasons.push(`expected tool ${rules.requiredTool}, found ${String(toolName)}`);
  const evidence = Object.prototype.hasOwnProperty.call(contents, rules.outputFile) ? [ref(rules.outputFile, contents[rules.outputFile])] : [];
  return dimension(reasons.length === 0 ? 'passed' : 'failed', reasons.length === 0 ? evidence : [], reasons, [], {
    expected: { file: rules.outputFile, content: rules.expectedContent, successfulExecutions: rules.requiredSuccessfulExecutions },
    successfulExecutions,
    duplicateSuccessfulEffects,
    files: [...new Set(files)].sort(),
  });
}

/**
 * Mechanism dimension for DELIV-01-R. It records whether the validation event
 * actually happened (not_exercised when it did not), whether recovery happened,
 * and never uses the final artifact as a precondition for the mechanism state.
 */
export function evaluateDeliv01Mechanism({ task, invocations, successfulExecutions, duplicateSuccessfulEffects, expectedTool = task.faultFixture?.tool }) {
  const toolInvocations = invocations.filter((invocation) => invocation.toolName === expectedTool);
  const validationFailures = toolInvocations.filter((invocation) => (
    invocation.status === 'validation_failed' && invocation.errorKind === 'input_validation'
  ));
  const blocked = toolInvocations.filter((invocation) => invocation.status === 'denied' || invocation.status === 'blocked');
  const evidenceRefs = toolInvocations.map((invocation, index) => invocationRef(invocation, index));
  if (blocked.length > 0 && validationFailures.length === 0) {
    return dimension('blocked', evidenceRefs, [], [], {
      triggered: true,
      blockReason: 'the fixture tool call was blocked by the permission or execution boundary',
      invocations: toolInvocations,
    });
  }
  if (validationFailures.length === 0) {
    return dimension('not_exercised', evidenceRefs, [], [], {
      triggered: false,
      observedFirstProposalSucceeded: toolInvocations.some((invocation) => invocation.status === 'succeeded'),
      invocations: toolInvocations,
    });
  }
  const reasons = [];
  const recoverySucceeded = successfulExecutions === 1;
  if (!recoverySucceeded) reasons.push(`corrected tool execution expected exactly 1 successful call, found ${successfulExecutions}`);
  if (duplicateSuccessfulEffects > 0) reasons.push(`duplicate successful fixture effects: ${duplicateSuccessfulEffects}`);
  return dimension(reasons.length === 0 ? 'passed' : 'failed', evidenceRefs, reasons, [], {
    triggered: true,
    validationFailures: validationFailures.length,
    recovered: reasons.length === 0,
    successfulExecutions,
    duplicateSuccessfulEffects,
    invocations: toolInvocations,
  });
}

function notApplicable() {
  return { status: 'not_applicable', evidenceRefs: [], rejectionReasons: [], missingFields: [] };
}

/**
 * Dispatch a complete workspace snapshot to the task's configured dimensions.
 * The adapter uses this single entry so tests and runs share one oracle source.
 */
export function evaluateTask(task, observation) {
  const dimensions = {};
  dimensions.goal = task.dimensions.goal
    ? evaluateGoalForTask(task, observation)
    : notApplicable();
  dimensions.contract = task.dimensions.contract
    ? evaluateContractForTask(task, observation)
    : notApplicable();
  dimensions.mechanism = task.dimensions.mechanism
    ? evaluateDeliv01Mechanism({
      task,
      invocations: observation.invocations ?? [],
      successfulExecutions: observation.successfulExecutions ?? 0,
      duplicateSuccessfulEffects: observation.duplicateSuccessfulEffects ?? 0,
    })
    : { status: 'not_exercised', triggered: false, evidenceRefs: [], rejectionReasons: [], missingFields: [] };
  return dimensions;
}

function evaluateGoalForTask(task, observation) {
  if (task.id.startsWith('FILE-02')) {
    return evaluateFile02Goal({ task, files: observation.files, contents: observation.contents });
  }
  if (task.id.startsWith('DELIV-01')) {
    return evaluateDeliv01Goal({
      task,
      files: observation.files,
      contents: observation.contents,
      successfulExecutions: observation.successfulExecutions ?? 0,
      duplicateSuccessfulEffects: observation.duplicateSuccessfulEffects ?? 0,
      toolName: task.goalRules.requiredTool,
    });
  }
  throw new Error(`No goal oracle for task ${task.id}`);
}

function evaluateContractForTask(task, observation) {
  if (task.id === 'FILE-02-S') {
    return evaluateFile02Contract({ task, files: observation.files, contents: observation.contents });
  }
  throw new Error(`No contract oracle for task ${task.id}`);
}

/** All dimensions unverified because the harness could not gather evidence. */
export function unverifiedDimensions(task, missingFields) {
  const dimensions = {};
  for (const name of ['goal', 'contract', 'mechanism']) {
    if (name === 'mechanism') {
      dimensions.mechanism = {
        status: 'unverified', triggered: false, evidenceRefs: [], rejectionReasons: [], missingFields: [...missingFields],
      };
    } else {
      dimensions[name] = { status: 'unverified', evidenceRefs: [], rejectionReasons: [], missingFields: [...missingFields] };
    }
  }
  if (!task.dimensions.contract) dimensions.contract = notApplicable();
  if (!task.dimensions.mechanism) dimensions.mechanism = { status: 'not_exercised', triggered: false, evidenceRefs: [], rejectionReasons: [], missingFields: [] };
  return dimensions;
}

/** Stable evidence digest for one workspace file. */
export function fileEvidence(path, content) {
  return { kind: 'file', path, sha256: sha256Text(content), bytes: Buffer.byteLength(content) };
}
