#!/usr/bin/env node
// RA-08 driver: run the two authorization shapes over one identical grant and compare them call by call.
//
// The comparison that matters is not the prompt count on its own. It is: fewer prompts **and** the same
// decisions. So the report prints both arms' allowed and refused sets as lists, and the row fails if they
// differ in either direction — a range that admits something the per-command arm refused is a regression,
// not a saving, and a range that refuses something the per-command arm allowed is not a drop-in either.
//
// Usage: node scripts/experiment-ra08-authorization.mjs [--json=<path>] [--revoke]
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, sha256, writeJson } from './lib/experiment-ledger.mjs';
import {
  authorizationSequence, createGrant, runAuthorizationArm,
} from './lib/experiment-authorization.mjs';

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const [key, value] = raw.slice(2).split('=');
    args[key] = value ?? true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const evidenceDir = args.evidence ?? process.env.LS_EXPERIMENT_EVIDENCE_DIR ?? 'D:\\littlesheep-evidence\\RASB-2026-09-27';
const root = ensureDir(join(evidenceDir, 'ra08-authorization'));
const workspace = ensureDir(join(root, 'ws'));
const auditPath = join(root, 'sandbox-audit.jsonl');
const toolchainPaths = (process.env.LS_EXPERIMENT_WSL_TOOLCHAIN ?? '')
  .split(';').map((entry) => entry.trim()).filter((entry) => entry.startsWith('/'));
const distro = process.env.LS_EXPERIMENT_WSL_DISTRO ?? 'Ubuntu-26.04';

const spec = { workspace, network: 'none', distro, toolchainPaths };
const grant = createGrant({ workspace, toolchainPaths, distro });

// ── run both arms over the same ordered sequence ────────────────────────────────────────────────────
async function runArm(mode) {
  await rm(join(root, `ws-${mode}`), { recursive: true, force: true });
  const armWorkspace = ensureDir(join(root, `ws-${mode}`));
  const armGrant = createGrant({ workspace: armWorkspace, toolchainPaths, distro });
  const armSpec = { workspace: armWorkspace, network: 'none', distro, toolchainPaths };
  const calls = authorizationSequence({ workspace: armWorkspace, spec: armSpec });
  // Revocation happens mid-sequence inside the arm, so the calls after it are judged against a revoked
  // grant in both arms rather than being re-checked afterwards in a separate pass.
  return runAuthorizationArm({
    mode,
    grant: armGrant,
    calls,
    scratch: root,
    workspace: armWorkspace,
    spec: armSpec,
    auditPath,
    revokeAtLabel: 'after-revocation',
  });
}
const perCommand = await runArm('per-command');
const range = await runArm('range');

// ── compare ─────────────────────────────────────────────────────────────────────────────────────────
const sameAllowed = JSON.stringify([...perCommand.allowedLabels].sort()) === JSON.stringify([...range.allowedLabels].sort());
const sameRefused = JSON.stringify([...perCommand.refusedLabels].sort()) === JSON.stringify([...range.refusedLabels].sort());
// Revocation is applied inside each arm, so the evidence is the decision recorded for that call.
const revokedRefused = (arm) => arm.decisions.some((entry) => entry.label === 'after-revocation' && entry.allowed === false);
const revokedRefusedBoth = revokedRefused(perCommand) && revokedRefused(range);

// Isolation evidence: every exec that ran must show the sandbox as its actual backend, or say unknown.
const audit = existsSync(auditPath)
  ? readFileSync(auditPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
const startedLines = audit.filter((entry) => entry.phase === 'started');
const isolation = {
  auditLines: audit.length,
  startedLines: startedLines.length,
  backends: [...new Set(startedLines.map((entry) => entry.actualBackend))],
  note: startedLines.length === 0
    ? 'no backend was selected for this run, so no isolation is claimed'
    : 'each started line names the pid and the argv the namespace received',
};

const checks = [
  {
    id: 'range-needs-fewer-prompts',
    pass: range.prompts < perCommand.prompts,
    detail: { perCommand: perCommand.prompts, range: range.prompts },
  },
  {
    id: 'same-set-allowed',
    pass: sameAllowed,
    detail: { perCommand: perCommand.allowedLabels, range: range.allowedLabels },
  },
  {
    id: 'same-set-refused',
    pass: sameRefused,
    detail: { perCommand: perCommand.refusedLabels, range: range.refusedLabels },
  },
  {
    id: 'revocation-rejudged-in-both-arms',
    pass: revokedRefusedBoth,
    detail: {
      perCommand: perCommand.decisions.filter((entry) => entry.label === 'after-revocation'),
      range: range.decisions.filter((entry) => entry.label === 'after-revocation'),
    },
  },
  {
    id: 'boundary-crossings-refused-in-range-arm',
    pass: range.refusedLabels.length >= 4,
    detail: { refused: range.refusedLabels },
  },
];

const payload = {
  mode: 'ra08-authorization',
  generatedAt: new Date().toISOString(),
  grant: { ...grant, workspace: '<per-arm>', paths: ['<per-arm>'] },
  arms: { perCommand, range },
  isolation,
  checks,
  outcome: checks.every((check) => check.pass) ? 'pass' : 'fail',
  limits: [
    'This is an experiment-layer grant validated by the harness approval callback, not a Main-side product contract; RA-08 asks for the latter and this does not substitute for it.',
    'The scope of the grant is one workspace, one tool, no network, with an expiry and a revocation flag.',
    'Prompt counts are structural (the callback was or was not reached), not a measurement of user effort.',
  ],
};
if (args.json) writeJson(args.json, payload);
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
process.exitCode = payload.outcome === 'pass' ? 0 : 1;
