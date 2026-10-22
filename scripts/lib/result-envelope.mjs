// Shared machine-readable result envelope for evaluation and verification
// scripts. New scripts should emit one envelope instead of inventing another
// `{ ok }` / `{ check }` / `{ report }` shape. Existing v1 documents are not
// renamed or migrated by this helper; it only defines the forward contract.

export const RESULT_ENVELOPE_SCHEMA_VERSION = 1;

export const RESULT_ENVELOPE_STATUSES = Object.freeze(['passed', 'failed', 'blocked', 'skipped']);

const KINDS = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export function createResultEnvelope({ kind, status, exitCode, data, reason } = {}) {
  if (typeof kind !== 'string' || !KINDS.test(kind)) {
    throw new Error(`result-envelope: kind must match ${KINDS}`);
  }
  if (!RESULT_ENVELOPE_STATUSES.includes(status)) {
    throw new Error(`result-envelope: status must be one of ${RESULT_ENVELOPE_STATUSES.join(', ')}`);
  }
  const code = exitCode ?? (status === 'passed' || status === 'skipped' ? 0 : status === 'blocked' ? 2 : 1);
  if (!Number.isSafeInteger(code) || code < 0 || code > 255) {
    throw new Error('result-envelope: exitCode must be an integer 0..255');
  }
  return {
    schemaVersion: RESULT_ENVELOPE_SCHEMA_VERSION,
    kind,
    status,
    exitCode: code,
    ...(reason ? { reason } : {}),
    data: data ?? {},
  };
}

export function isResultEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && value.schemaVersion === RESULT_ENVELOPE_SCHEMA_VERSION
    && typeof value.kind === 'string' && RESULT_ENVELOPE_STATUSES.includes(value.status)
    && Number.isSafeInteger(value.exitCode);
}

export function parseResultEnvelope(text, { expectedKind } = {}) {
  let value;
  try {
    value = JSON.parse(String(text ?? '').trim());
  } catch {
    throw new Error('result-envelope: output is not valid JSON');
  }
  assertResultEnvelope(value, { expectedKind });
  return value;
}

export function assertResultEnvelope(value, { expectedKind } = {}) {
  if (!isResultEnvelope(value)) throw new Error('result-envelope: missing schemaVersion/kind/status/exitCode');
  if (expectedKind && value.kind !== expectedKind) {
    throw new Error(`result-envelope: expected kind "${expectedKind}", got "${value.kind}"`);
  }
  return value;
}
