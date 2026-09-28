// Ledger and hashing primitives for the runtime-autonomy / sandbox-boundary experiment.
//
// EV-00 owns this file. It exists so that every experiment run can be traced back to one version,
// input, configuration, authorization, command and evidence path, and so that the per-run record
// carries the minimum field set the taskbook's section 8 asks for:
//
//   batchId, caseId, arm, trial, runId, sourceHash, promptHash, configHash, authorizationRef,
//   requestedBackend, actualBackend, injection, targetTriggered, outcome, artifactChecks,
//   interventions, refusals[{callId, reason, expectedDecision}], usage, retries, elapsedMs,
//   sandboxChecks, evidenceRefs, limitations
//
// Nothing here reads a credential value: `redactConfig` replaces every secret-shaped field with a
// marker and `configDigest` hashes the redacted projection, so a digest can be published while the
// configuration it identifies stays local.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

/** The section-8 minimum per-run ledger field set. `assertLedgerRecord` enforces presence. */
export const LEDGER_REQUIRED_FIELDS = Object.freeze([
  'batchId', 'caseId', 'arm', 'trial', 'runId', 'sourceHash', 'promptHash', 'configHash',
  'authorizationRef', 'requestedBackend', 'actualBackend', 'injection', 'targetTriggered',
  'outcome', 'artifactChecks', 'interventions', 'refusals', 'usage', 'retries', 'elapsedMs',
  'sandboxChecks', 'evidenceRefs', 'limitations',
]);

const SECRET_KEY_PATTERN = /(api[-_]?key|token|secret|password|credential|authorization|cookie)/iu;

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

/** Stable JSON: object keys sorted, so two equal configurations hash equally. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Replace every secret-shaped value with a marker; the shape is kept so the digest is still specific. */
export function redactConfig(value) {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? '<redacted>' : redactConfig(entry);
    }
    return output;
  }
  return value;
}

/** Digest of the effective configuration. Secrets are redacted first, so this is publishable. */
export function configDigest(config) {
  return sha256(stableStringify(redactConfig(config)));
}

/**
 * Hash of the source tree the experiment actually executed.
 *
 * `dist` is what the runner imports, so a source-only hash would not identify the bytes that ran. The
 * digest therefore covers every package `src` file (path + content) *and* the built entry points the
 * runner resolves, which is what makes an A run distinguishable from a B run.
 */
export function sourceDigest(repoRoot, options = {}) {
  const roots = options.roots ?? [
    'packages/harness/src',
    'packages/tools/src',
    'packages/runner/src',
    'packages/safety/src',
    'packages/types/src',
    'packages/config/src',
  ];
  const distFiles = options.distFiles ?? [
    'packages/harness/dist/index.js',
    'packages/tools/dist/index.js',
    'packages/runner/dist/runner.js',
    'packages/safety/dist/index.js',
    'packages/types/dist/index.js',
  ];
  const hash = createHash('sha256');
  const files = [];
  for (const root of roots) {
    const absolute = join(repoRoot, root);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
      const path = join(entry.parentPath ?? absolute, entry.name);
      files.push(relative(repoRoot, path).replaceAll('\\', '/'));
    }
  }
  files.sort();
  for (const file of files) {
    hash.update(file).update('\0').update(readFileSync(join(repoRoot, file))).update('\0');
  }
  const dist = {};
  for (const file of distFiles) {
    const absolute = join(repoRoot, file);
    if (!existsSync(absolute)) continue;
    dist[file] = sha256File(absolute);
    hash.update(`dist:${file}`).update('\0').update(dist[file]).update('\0');
  }
  return { digest: hash.digest('hex'), fileCount: files.length, dist };
}

/**
 * What the run actually loaded, not just what was edited.
 *
 * RA-01 requires the frozen input to cover the built artefacts **and their transitive modules**: hashing a
 * fixed list of five dist entry points cannot distinguish two trees whose loaded code differs, because the
 * entry points import dozens of chunks. This walks the real ESM import graph from the entry points the
 * runner resolves, so the digest changes when any loaded byte changes.
 *
 * It also reports whether `src` and `dist` agree, so a batch taken while a patch was applied to source but
 * not rebuilt can be rejected instead of being reported under a source hash it never executed.
 */
export function buildManifest(repoRoot, options = {}) {
  const entries = options.entries ?? [
    'packages/runner/dist/runner.js',
    'packages/harness/dist/index.js',
    'packages/tools/dist/index.js',
    'packages/safety/dist/index.js',
    'packages/types/dist/index.js',
    'packages/llm/dist/index.js',
  ];
  const seen = new Set();
  const missing = [];
  const walk = (relPath) => {
    if (seen.has(relPath)) return;
    const absolute = join(repoRoot, relPath);
    if (!existsSync(absolute)) { missing.push(relPath); return; }
    seen.add(relPath);
    const source = readFileSync(absolute, 'utf8');
    // Static ESM imports and re-exports, which is how this repository's dist is wired.
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]/gu)) {
      const target = relPath.slice(0, relPath.lastIndexOf('/') + 1) + match[1];
      walk(target.replace(/\/\.\//gu, '/'));
    }
  };
  for (const entry of entries) walk(entry);
  const modules = [...seen].sort();
  const hash = createHash('sha256');
  for (const module of modules) {
    hash.update(module).update('\0').update(readFileSync(join(repoRoot, module))).update('\0');
  }
  const lockfile = existsSync(join(repoRoot, 'pnpm-lock.yaml')) ? sha256File(join(repoRoot, 'pnpm-lock.yaml')) : null;
  const fixtureFiles = (options.fixtures ?? [])
    .filter((file) => existsSync(join(repoRoot, file)))
    .map((file) => ({ file, sha256: sha256File(join(repoRoot, file)) }));
  return {
    digest: hash.digest('hex'),
    moduleCount: modules.length,
    modules,
    missing,
    lockfile,
    fixtures: fixtureFiles,
    configHash: options.config ? configDigest(options.config) : null,
  };
}

/**
 * Do the sources and the built artefacts describe the same tree?
 *
 * A batch that runs a patched `src` against an unpatched `dist` measures nothing, and that is exactly the
 * mistake one round of this experiment made. The check is deliberately conservative: it compares the newest
 * source modification against the entry points' modification times, so it can only report "possibly stale"
 * — which is enough to refuse a batch rather than to certify it.
 */
export function sourceDistAgreement(repoRoot, packages = ['harness', 'tools', 'runner', 'safety', 'types', 'llm']) {
  const newestSource = { path: null, mtimeMs: 0 };
  for (const pkg of packages) {
    const dir = join(repoRoot, 'packages', pkg, 'src');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = join(entry.parentPath ?? dir, entry.name);
      const { mtimeMs } = statSync(path);
      if (mtimeMs > newestSource.mtimeMs) {
        newestSource.mtimeMs = mtimeMs;
        newestSource.path = relative(repoRoot, path).replaceAll('\\', '/');
      }
    }
  }
  const newestDist = { path: null, mtimeMs: 0 };
  for (const pkg of packages) {
    const dir = join(repoRoot, 'packages', pkg, 'dist');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const path = join(entry.parentPath ?? dir, entry.name);
      const { mtimeMs } = statSync(path);
      if (mtimeMs > newestDist.mtimeMs) {
        newestDist.mtimeMs = mtimeMs;
        newestDist.path = relative(repoRoot, path).replaceAll('\\', '/');
      }
    }
  }
  return {
    agree: newestSource.mtimeMs <= newestDist.mtimeMs,
    newestSource,
    newestDist,
    note: 'a source file newer than every built module means the batch may have run code the sources do not describe',
  };
}

/** Which arm the currently built tree represents, decided from facts rather than from a flag. */
export function armFingerprint(repoRoot) {
  const tracked = [
    'packages/harness/src/retrieval-intent.ts',
    'packages/harness/src/stages/execute/tool-failure-disposition.ts',
    'packages/harness/src/stages/execute/evidence-progress.ts',
    'packages/tools/src/tool-execution-service.ts',
    'packages/tools/src/builtin/exec.ts',
    'packages/harness/src/stages/execute/tool-loop.ts',
  ];
  const files = {};
  for (const file of tracked) {
    const absolute = join(repoRoot, file);
    files[file] = existsSync(absolute) ? sha256File(absolute) : null;
  }
  return { digest: sha256(stableStringify(files)), files };
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
}

export function appendJsonLine(path, value) {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
  return path;
}

export function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** Throws when a record is missing a field the taskbook requires a per-run ledger to carry. */
export function assertLedgerRecord(record) {
  const missing = LEDGER_REQUIRED_FIELDS.filter((field) => !(field in record));
  if (missing.length > 0) {
    throw new Error(`experiment ledger record is missing required fields: ${missing.join(', ')}`);
  }
  return record;
}

/**
 * The complete per-run record. Every caller goes through here so no run can be appended with a
 * missing field: the defaults are explicit "not applicable / not observed" values, never blanks.
 */
export function ledgerRecord(input) {
  const record = {
    batchId: input.batchId,
    caseId: input.caseId,
    arm: input.arm,
    trial: input.trial,
    runId: input.runId ?? null,
    sourceHash: input.sourceHash ?? null,
    promptHash: input.promptHash ?? null,
    configHash: input.configHash ?? null,
    authorizationRef: input.authorizationRef ?? 'none',
    requestedBackend: input.requestedBackend ?? 'host',
    actualBackend: input.actualBackend ?? 'host',
    injection: input.injection ?? null,
    targetTriggered: input.targetTriggered ?? 'unknown',
    outcome: input.outcome ?? 'unverified',
    artifactChecks: input.artifactChecks ?? [],
    interventions: input.interventions ?? [],
    refusals: input.refusals ?? [],
    usage: input.usage ?? { status: 'unavailable' },
    retries: input.retries ?? 0,
    elapsedMs: input.elapsedMs ?? 0,
    sandboxChecks: input.sandboxChecks ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
    limitations: input.limitations ?? [],
    // RA-01 additions: the frozen loaded-artefact digest and the provenance of the backend fact, so a
    // reader can tell "no sandbox ran" from "a sandbox ran and was reported".
    buildManifest: input.buildManifest ?? 'unknown',
    backendEvidence: input.backendEvidence ?? { source: 'none', note: 'no backend evidence was collected for this record' },
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    status: input.status ?? null,
    replyHash: input.replyHash ?? null,
    replyExcerpt: input.replyExcerpt ?? null,
    error: input.error ?? null,
    notes: input.notes ?? null,
  };
  return assertLedgerRecord(record);
}
