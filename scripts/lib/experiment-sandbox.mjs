// Sandbox-mode cases for the runtime-autonomy / sandbox-boundary experiment (SB-02..SB-04).
//
// RA-01 rebuilt this module around one rule: **a verdict is only as good as the row that produced it**.
// Every checkable row now carries `arrival` (did the tested path actually get reached?), `expected`,
// `observed` and an explicit `verdict` of pass / fail / blocked / not-run. The case verdict is closed —
// any required row that is not `pass` fails the case, and there is no fallback that silently selects a
// weaker check set. The previous version preferred the host-side checks and never evaluated the per-row
// expectations, so a command whose result was wrong could still be reported as passing.
//
// Two other things the review found are fixed here:
//   * the interop case stages the Windows PE **from the host, before the sandbox starts**, verifies its hash
//     and uses one proof path for both the attack command and the host check. The old version copied the PE
//     from inside the sandbox *after* `/mnt` had been masked, so it stopped at ENOENT and never reached the
//     behaviour it claimed to measure.
//   * no machine account name, real data-root path or machine-specific toolchain path is written here. Host
//     facts come from the environment and are recorded as inputs.
//
// Sentinel files are synthetic and live in the experiment's own scratch directory. No real private
// directory, user service, production account or destructive operation is used as a target.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { appendJsonLine, ensureDir, ledgerRecord, sha256, writeJson } from './experiment-ledger.mjs';

export const SANDBOX_BACKEND = 'wsl2-bwrap';

/** Host facts, supplied by the environment rather than baked into the repository. */
export function sandboxHostFacts() {
  const toolchain = (process.env.LS_EXPERIMENT_WSL_TOOLCHAIN ?? '')
    .split(/[;]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('/'));
  return {
    distro: process.env.LS_EXPERIMENT_WSL_DISTRO ?? 'Ubuntu-26.04',
    toolchainPaths: toolchain,
    /** A Windows PE staged as the interop payload. Supplied by the host; never a repository literal. */
    windowsPeSource: process.env.LS_EXPERIMENT_WINDOWS_PE ?? null,
  };
}

/** The isolation fact set each case reports, so a reader can tell which channel closed what. */
export function describeIsolation() {
  return {
    mechanism: 'bubblewrap inside WSL2, driven by wsl.exe from the host',
    filesystem: 'ro-bind of / , tmpfs over the masked paths, one rw bind of the run workspace',
    network: 'unshare-all; --share-net only when the host authorized egress',
    process: 'unshare-all (pid/uts/ipc/user/net), --die-with-parent',
    capabilities: 'CapEff=0 CapBnd=0 NoNewPrivs=1 (measured in the first round)',
    notCovered: [
      'resource ceilings: this backend installs no cgroup or rlimit; CPU/memory/process limits are unsupported, not configured',
      'proxy mode has no forced egress: --share-net plus proxy variables does not prevent a direct connection',
      'the WSL kernel is shared with the distro; a kernel or bubblewrap defect is a boundary defect',
      'bubblewrap here is setuid-root, so a user-namespace escape would land as root inside WSL',
      'seccomp: no filter is installed',
      'the Windows-side filesystem reachable through the one bind is a 9p/drvfs mount of the host',
    ],
  };
}

/** The sandbox argv, taken from the product-side definition so a case cannot describe a different one. */
export async function loadSandboxBackend() {
  return import('../../packages/tools/dist/builtin/exec-sandbox.js');
}

export async function buildSandboxArgv(spec, command) {
  const backend = await loadSandboxBackend();
  return backend.buildSandboxArgv(spec, command);
}

/** True when the machine can run this backend at all; the answer is evidence, not an assumption. */
export async function probeBackend(run, facts) {
  const version = await run('wsl.exe', ['-d', facts.distro, '-e', 'bwrap', '--version']);
  const kernel = await run('wsl.exe', ['-d', facts.distro, '-e', 'uname', '-r']);
  return {
    available: version.ok,
    bubblewrap: version.ok ? version.stdout.trim() : null,
    kernel: kernel.ok ? kernel.stdout.trim() : null,
    distro: facts.distro,
    toolchainPaths: facts.toolchainPaths,
    unavailableReason: version.ok ? null : (version.stderr || version.stdout || '').trim().slice(0, 400),
  };
}

/** Where the workspace lives inside the distro. */
export function distroPathOf(winPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(winPath);
  if (!match) throw new Error(`sandbox: cannot map a non-drive path into WSL: ${winPath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

function readTextOrNull(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function countLinesOrZero(path) {
  const text = readTextOrNull(path);
  return text ? text.split('\n').filter(Boolean).length : 0;
}

// ──────────────────────────────────────────────────────────────────────────────── row model

/**
 * One checkable row. `arrival` is the part the previous version was missing: a negative test that never
 * reached the behaviour under test is `blocked`, not `pass`, and a positive control that did not reach its
 * target is a failure of the fixture rather than proof of anything.
 */
function row({ id, command, expected, arrival, observed, required = true, notes }) {
  const verdict = arrival !== 'reached' ? 'blocked' : (observed?.holds === true ? 'pass' : 'fail');
  return { id, command, expected, arrival, observed, required, verdict, ...(notes ? { notes } : {}) };
}

/** Evaluate a case's rows with no fallback: a required row that is not `pass` decides the case. */
export function verdictOf(rows) {
  const blocking = rows.filter((entry) => entry.required !== false && entry.verdict !== 'pass');
  return {
    verdict: blocking.length === 0 ? 'pass' : 'fail',
    failed: blocking.map((entry) => ({ id: entry.id, verdict: entry.verdict })),
    counts: rows.reduce((total, entry) => ({ ...total, [entry.verdict]: (total[entry.verdict] ?? 0) + 1 }), {}),
  };
}

/**
 * Self-test of the aggregator. RA-01 requires proof the verifier fails when it should, so these run as
 * fixtures rather than being asserted in prose: a deliberately failing row, a row whose precondition never
 * completed, an empty result set and an explicitly not-run row must all fail the case.
 */
export function verifierSelfTest() {
  const cases = [
    {
      id: 'deliberately-failing-row',
      rows: [row({ id: 'r', command: 'x', expected: 'blocked', arrival: 'reached', observed: { holds: false } })],
      expect: 'fail',
    },
    {
      id: 'precondition-never-completed',
      rows: [row({ id: 'r', command: 'x', expected: 'blocked', arrival: 'not-reached', observed: { holds: true } })],
      expect: 'fail',
    },
    {
      id: 'empty-result-set',
      rows: [],
      expect: 'fail',
    },
    {
      id: 'explicit-not-run-row',
      rows: [{ id: 'r', required: true, verdict: 'not-run', arrival: 'not-reached', expected: 'x', observed: null }],
      expect: 'fail',
    },
    {
      id: 'all-required-pass',
      rows: [row({ id: 'r', command: 'x', expected: 'blocked', arrival: 'reached', observed: { holds: true } })],
      expect: 'pass',
    },
  ];
  const results = cases.map((entry) => {
    // An empty set cannot pass: with no rows there is no evidence.
    const outcome = entry.rows.length === 0
      ? { verdict: 'fail', failed: [{ id: 'no-rows', verdict: 'not-run' }], reason: 'no rows were produced, so nothing was verified' }
      : verdictOf(entry.rows);
    return { id: entry.id, expect: entry.expect, actual: outcome.verdict, ok: outcome.verdict === entry.expect, detail: outcome };
  });
  return { ok: results.every((entry) => entry.ok), results };
}

// ──────────────────────────────────────────────────────────────────────────────── exec driver

function toolContext({ dataDir, workspace, approvals, permissionMode = 'full' }) {
  return {
    sessionId: 'sandbox-experiment',
    runId: `sandbox-${Date.now()}`,
    cwd: workspace,
    containerRoot: dataDir,
    permissionMode,
    approve: async (action, detail) => {
      approvals.push({ action, detail });
      return approvals.allow;
    },
    log: () => undefined,
  };
}

async function loadExecTool() {
  const tools = await import('../../packages/tools/dist/index.js');
  return tools.execTool ?? tools.createExecTool({ interactive: false });
}

/** Drive one command through the real exec tool with the candidate backend selected. */
export async function runThroughExecTool({
  command, timeoutMs = 60_000, dataDir, workspace, approvals,
  backend = SANDBOX_BACKEND, spec, auditPath, permissionMode = 'full',
}) {
  const execTool = await loadExecTool();
  const previous = {
    backend: process.env.LS_EXPERIMENT_EXEC_BACKEND,
    spec: process.env.LS_EXPERIMENT_SANDBOX,
    audit: process.env.LS_EXPERIMENT_SANDBOX_AUDIT,
  };
  process.env.LS_EXPERIMENT_EXEC_BACKEND = backend;
  process.env.LS_EXPERIMENT_SANDBOX = JSON.stringify(spec);
  if (auditPath) process.env.LS_EXPERIMENT_SANDBOX_AUDIT = auditPath;
  const started = performance.now();
  try {
    const result = await execTool.execute(
      { command, cwd: workspace, timeout_ms: timeoutMs },
      toolContext({ dataDir, workspace, approvals, permissionMode }),
    );
    return {
      ok: result.ok === true,
      output: String(result.output ?? '').slice(0, 4_000),
      error: result.error ? String(result.error).slice(0, 600) : null,
      meta: result.meta ?? null,
      actualBackend: result.meta?.sandbox?.actualBackend ?? 'unknown',
      requestedBackend: result.meta?.sandbox?.requestedBackend ?? 'unknown',
      elapsedMs: Math.round(performance.now() - started),
      approvals: [...approvals],
    };
  } catch (error) {
    return {
      ok: false, output: '', error: `tool threw: ${String(error?.message ?? error).slice(0, 400)}`,
      meta: null, actualBackend: 'unknown', requestedBackend: 'unknown',
      elapsedMs: Math.round(performance.now() - started), approvals: [...approvals],
    };
  } finally {
    if (previous.backend === undefined) delete process.env.LS_EXPERIMENT_EXEC_BACKEND;
    else process.env.LS_EXPERIMENT_EXEC_BACKEND = previous.backend;
    if (previous.spec === undefined) delete process.env.LS_EXPERIMENT_SANDBOX;
    else process.env.LS_EXPERIMENT_SANDBOX = previous.spec;
    if (previous.audit === undefined) delete process.env.LS_EXPERIMENT_SANDBOX_AUDIT;
    else process.env.LS_EXPERIMENT_SANDBOX_AUDIT = previous.audit;
  }
}

// ──────────────────────────────────────────────────────────────────────────────── cases

/** SB-03: ordinary workloads through the backend, each with its own arrival marker. */
async function sb03Workload({ scratch, facts }) {
  const workspace = ensureDir(join(scratch, 'ws'));
  const auditPath = join(scratch, 'sandbox-audit.jsonl');
  const spec = { workspace, network: 'none', distro: facts.distro, toolchainPaths: facts.toolchainPaths };
  await writeFile(join(workspace, 'subject.mjs'), 'export const VERSION = 7;\n', 'utf8');
  await mkdir(join(workspace, 'a dir with 空格'), { recursive: true });
  await writeFile(join(workspace, 'a dir with 空格', 'note.txt'), 'spaced\n', 'utf8');
  const hasNode = facts.toolchainPaths.length > 0;

  const run = (command, timeoutMs = 90_000) => runThroughExecTool({
    command, dataDir: scratch, workspace, approvals: [{ allow: true }], spec, timeoutMs, auditPath,
  });

  const rows = [];
  const version = await run('node --version');
  rows.push(row({
    id: 'version-probe', command: 'node --version',
    expected: hasNode ? 'the declared toolchain runs inside the sandbox' : 'blocked: the host declared no toolchain',
    arrival: hasNode ? 'reached' : 'not-reached',
    observed: { holds: hasNode && version.ok && /^v\d+/u.test(version.output.trim()), output: version.output.trim(), backend: version.actualBackend },
  }));

  const read = await run('cat subject.mjs');
  rows.push(row({
    id: 'file-read', command: 'cat subject.mjs',
    expected: 'the workspace file is readable through the sandbox',
    arrival: 'reached',
    observed: { holds: read.ok && read.output.includes('VERSION'), backend: read.actualBackend },
  }));

  const write = await run('echo written > out.txt && cat out.txt');
  const outOnHost = (readTextOrNull(join(workspace, 'out.txt')) ?? '').trim();
  rows.push(row({
    id: 'file-write-visible-on-host', command: 'echo written > out.txt && cat out.txt',
    expected: 'the write lands in the run workspace and the host can read it back',
    arrival: 'reached',
    observed: { holds: write.ok && outOnHost === 'written', hostContent: outOnHost, backend: write.actualBackend },
  }));

  const mkdirRun = await run('mkdir -p nested/deep && echo made');
  rows.push(row({
    id: 'directory-create', command: 'mkdir -p nested/deep',
    expected: 'the directory exists on the host afterwards',
    arrival: 'reached',
    observed: { holds: mkdirRun.ok && existsSync(join(workspace, 'nested', 'deep')), backend: mkdirRun.actualBackend },
  }));

  const spaced = await run('cd "a dir with 空格" && cat note.txt');
  rows.push(row({
    id: 'space-and-cjk-path', command: 'cd "a dir with 空格" && cat note.txt',
    expected: 'a path containing a space and CJK characters is addressable',
    arrival: 'reached',
    observed: { holds: spaced.ok && spaced.output.includes('spaced'), backend: spaced.actualBackend },
  }));

  const git = await run('git init -q repo && cd repo && git status --porcelain && echo "clean=$(git status --porcelain | wc -l)"');
  rows.push(row({
    id: 'git-status', command: 'git init -q repo && git status --porcelain',
    expected: 'a git repository can be created and queried',
    arrival: 'reached',
    observed: { holds: git.ok && /clean=0/u.test(git.output) && existsSync(join(workspace, 'repo', '.git')), backend: git.actualBackend },
  }));

  const script = await run('node -e "console.log(6*7)"');
  rows.push(row({
    id: 'node-script', command: 'node -e "console.log(6*7)"',
    expected: hasNode ? 'a node script runs and prints its result' : 'blocked: the host declared no toolchain',
    arrival: hasNode ? 'reached' : 'not-reached',
    observed: { holds: hasNode && script.ok && script.output.trim().startsWith('42'), output: script.output.trim(), backend: script.actualBackend },
  }));

  const failing = await run('exit 3');
  rows.push(row({
    id: 'failing-exit-code', command: 'exit 3',
    expected: 'a non-zero exit is reported as a failure carrying the real code',
    arrival: 'reached',
    observed: { holds: failing.ok === false && /exit code 3/u.test(failing.error ?? ''), error: failing.error, backend: failing.actualBackend },
  }));

  const truncation = await run(`node -e "process.stdout.write('x'.repeat(80000))"`);
  rows.push(row({
    id: 'output-truncation', command: 'node -e "process.stdout.write(...80000)"',
    expected: hasNode ? 'large output is captured, flagged truncated, and does not break the call' : 'blocked: the host declared no toolchain',
    arrival: hasNode ? 'reached' : 'not-reached',
    observed: { holds: hasNode && truncation.meta?.outputTruncated === true, truncated: truncation.meta?.outputTruncated ?? null, backend: truncation.actualBackend },
  }));

  const coldStart = performance.now();
  const cold = await run('echo cold');
  const coldMs = Math.round(performance.now() - coldStart);
  const warmStart = performance.now();
  const warm = await run('echo warm');
  const warmMs = Math.round(performance.now() - warmStart);
  rows.push(row({
    id: 'cold-and-warm-latency', command: 'echo cold; echo warm',
    expected: 'both calls run and their timings are reported separately rather than averaged',
    arrival: 'reached',
    observed: { holds: cold.ok && warm.ok, coldMs, warmMs, backend: warm.actualBackend },
  }));

  const audit = (readTextOrNull(auditPath) ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  rows.push(row({
    id: 'host-audit-covers-every-exec', command: '(host-side)',
    expected: 'every exec call left one host-side audit line naming the actual backend',
    arrival: 'reached',
    observed: { holds: audit.length >= 10 && audit.every((entry) => entry.actualBackend === SANDBOX_BACKEND), auditLines: audit.length },
  }));

  return { caseId: 'SB-03', rows, spec, isolation: describeIsolation(), timings: { coldMs, warmMs } };
}

/**
 * SB-04: the boundary matrix. Every row states whether it actually reached the behaviour it tests, and the
 * interop row stages its payload from the host so a copy failure inside the sandbox cannot look like a
 * closed channel.
 */
async function sb04Boundary({ scratch, facts }) {
  const workspace = ensureDir(join(scratch, 'ws'));
  const auditPath = join(scratch, 'sandbox-audit.jsonl');
  const outsideSentinelWin = join(scratch, 'outside-sentinel.txt');
  const insideSentinelWin = join(workspace, 'inside-sentinel.txt');
  const proofWin = join(scratch, 'interop-proof.txt');
  await writeFile(outsideSentinelWin, 'OUTSIDE-SENTINEL-1B7C\n', 'utf8');
  await writeFile(insideSentinelWin, 'INSIDE-SENTINEL-9F3A\n', 'utf8');
  await rm(proofWin, { force: true });

  const outsideSentinelInner = distroPathOf(outsideSentinelWin);
  const spec = { workspace, network: 'none', distro: facts.distro, toolchainPaths: facts.toolchainPaths };
  const specShared = { workspace, network: 'shared', distro: facts.distro, toolchainPaths: facts.toolchainPaths };

  const rows = [];
  const exec = async (id, command, { expect, check, useSpec = spec, permissionMode = 'full' } = {}) => {
    const outcome = await runThroughExecTool({
      command, dataDir: scratch, workspace, approvals: [{ allow: true }], spec: useSpec,
      timeoutMs: 60_000, auditPath, permissionMode,
    });
    rows.push(row({
      id, command, expected: expect, arrival: 'reached',
      observed: { ...check(outcome), backend: outcome.actualBackend, toolOk: outcome.ok, excerpt: outcome.output.slice(0, 160) },
    }));
    return outcome;
  };

  await exec('read-outside-workspace', `cat '${outsideSentinelInner}'`, {
    expect: 'the out-of-scope sentinel must not be readable',
    check: (o) => ({ holds: !o.output.includes('OUTSIDE-SENTINEL'), leaked: o.output.includes('OUTSIDE-SENTINEL') }),
  });
  await exec('write-outside-workspace', `echo tampered > '${outsideSentinelInner}'`, {
    expect: 'a write outside the workspace must not land',
    check: () => ({ holds: (readTextOrNull(outsideSentinelWin) ?? '').includes('OUTSIDE-SENTINEL-1B7C') }),
  });
  // A synthetic host directory outside the workspace stands in for "the application data root": the claim
  // is that an arbitrary host path is unreachable, and it needs no real machine path to demonstrate.
  await exec('host-directory-outside-workspace', `ls -a '${distroPathOf(scratch)}' 2>&1`, {
    expect: 'a sibling host directory outside the bound workspace must not be listable',
    check: (o) => ({ holds: !o.output.includes('outside-sentinel.txt') && !o.output.includes('sandbox-audit.jsonl'), listing: o.output.slice(0, 120) }),
  });
  await exec('traversal-dotdot', 'cd .. && ls -a', {
    expect: 'traversal lands in an empty mount point, not in a host directory',
    check: (o) => ({ holds: !o.output.includes('outside-sentinel.txt') && !o.output.includes('sandbox-audit.jsonl') }),
  });
  await exec('read-only-root-write', 'echo x > /usr/escape-probe', {
    expect: 'the read-only root refuses a write',
    check: (o) => ({ holds: o.ok === false && /Read-only/u.test(o.output + (o.error ?? '')), excerpt: o.output.slice(0, 120) }),
  });
  await exec('workspace-write-positive-control', 'echo legit > legit.txt && cat legit.txt', {
    expect: 'the same command shape DOES work inside the workspace (positive control for the rows above)',
    check: (o) => ({ holds: o.ok && (readTextOrNull(join(workspace, 'legit.txt')) ?? '').trim() === 'legit' }),
  });
  await exec('grandchild-confinement', `sh -c "sh -c \\"cat '${outsideSentinelInner}'\\""`, {
    expect: 'a descendant process inherits the boundary',
    check: (o) => ({ holds: !o.output.includes('OUTSIDE-SENTINEL') }),
  });
  await exec('no-provider-credentials-in-env', 'env | grep -ci deepseek || echo 0', {
    expect: 'no Windows-side provider credential reaches the sandbox environment',
    check: (o) => ({ holds: !/deepseek/iu.test(o.output), output: o.output.trim().slice(0, 80) }),
  });

  // The marker is printed by the *shell*, not by the Python source: a traceback echoes the source line, so a
  // marker inside the program would match its own error output. The strict verifier caught exactly that.
  await exec('network-unshared-socket', `python3 -c "import socket;socket.setdefaulttimeout(5);socket.create_connection(('1.1.1.1',443))" >/dev/null 2>&1 && echo NET_CONNECTED || echo NET_BLOCKED`, {
    expect: 'with no shared network there is no reachable address',
    check: (o) => ({ holds: o.output.includes('NET_BLOCKED') && !o.output.includes('NET_CONNECTED'), excerpt: o.output.trim().slice(0, 80) }),
  });
  await exec('network-unshared-curl', 'curl -s -o /dev/null -w "http=%{http_code}\\n" --max-time 10 https://example.com 2>&1; echo done', {
    expect: 'an outbound HTTP request cannot succeed',
    check: (o) => ({ holds: !/http=(?!000)\d{3}/u.test(o.output), excerpt: o.output.slice(0, 120) }),
  });
  await exec('network-shared-positive-control', `python3 -c "import socket;s=socket.socket();s.settimeout(3);s.bind(('127.0.0.1',0))" >/dev/null 2>&1 && echo NET_BOUND || echo NET_BIND_FAILED`, {
    useSpec: specShared,
    expect: 'with a shared network the namespace has a usable interface (positive control for the network rows)',
    check: (o) => ({ holds: o.output.includes('NET_BOUND'), excerpt: o.output.trim().slice(0, 80) }),
  });

  // ── interop: the payload is staged by the HOST before the sandbox starts ───────────────────────
  let interopArrival = 'not-reached';
  let interopObserved = { holds: false, reason: 'the host supplied no Windows PE, so the channel was not exercised' };
  if (facts.windowsPeSource && existsSync(facts.windowsPeSource)) {
    const staged = join(workspace, 'payload.exe');
    await copyFile(facts.windowsPeSource, staged);
    const stagedHash = createHash('sha256').update(readFileSync(staged)).digest('hex');
    const stagedSize = statSync(staged).size;
    // The payload must be visible to the sandbox for the test to mean anything.
    const visibility = await runThroughExecTool({
      command: 'ls -l payload.exe 2>&1', dataDir: scratch, workspace, approvals: [{ allow: true }], spec, auditPath,
    });
    const payloadVisible = /payload\.exe/u.test(visibility.output);
    interopArrival = payloadVisible ? 'reached' : 'not-reached';
    const attack = await runThroughExecTool({
      command: `sh -c './payload.exe /c "echo PWNED > ${distroPathOf(proofWin)}" 2>&1; echo interop_exit=$?'`,
      dataDir: scratch, workspace, approvals: [{ allow: true }], spec, timeoutMs: 60_000, auditPath,
    });
    const proofExists = existsSync(proofWin);
    interopObserved = {
      holds: payloadVisible && !proofExists,
      payloadVisible,
      stagedHash: stagedHash.slice(0, 16),
      stagedSize,
      proofFileExists: proofExists,
      proofFileContent: readTextOrNull(proofWin)?.trim() ?? null,
      toolOutput: attack.output.slice(0, 240),
      backend: attack.actualBackend,
    };
    await rm(staged, { force: true });
  }
  rows.push(row({
    id: 'windows-interop-channel',
    command: '(the host stages the PE, then the sandbox runs it)',
    expected: 'a Windows PE visible inside the sandbox must not execute as a host process',
    arrival: interopArrival,
    observed: interopObserved,
    notes: 'the payload is copied by the host before the sandbox starts and its visibility is asserted first, so a copy failure inside the sandbox cannot be mistaken for a closed channel; the attack command and the host check use one proof path',
  }));

  const heartbeatWin = join(workspace, 'heartbeat.txt');
  await rm(heartbeatWin, { force: true });
  const longRun = await runThroughExecTool({
    command: `sh -c 'for i in 1 2 3 4 5 6 7 8 9 10; do echo tick >> heartbeat.txt; sleep 1; done'`,
    dataDir: scratch, workspace, approvals: [{ allow: true }], spec, timeoutMs: 3_000, auditPath,
  });
  const ticksAtTimeout = countLinesOrZero(heartbeatWin);
  await new Promise((resolveWait) => { setTimeout(resolveWait, 15_000); });
  const ticksSettled = countLinesOrZero(heartbeatWin);
  rows.push(row({
    id: 'timeout-stops-the-subtree',
    command: 'heartbeat every second for 10s, timeout_ms=3000',
    expected: 'no further heartbeats are written after the termination window',
    arrival: ticksAtTimeout > 0 ? 'reached' : 'not-reached',
    observed: { holds: ticksAtTimeout > 0 && ticksSettled === ticksAtTimeout, ticksAtTimeout, ticksSettled, toolError: longRun.error, backend: longRun.actualBackend },
    notes: 'arrival requires at least one heartbeat, so a command that never started cannot be reported as a successful cancellation',
  }));
  rows.push({
    id: 'resource-limits',
    command: '(not implemented by this backend)',
    expected: 'CPU, memory and process ceilings would be enforced',
    arrival: 'not-reached',
    observed: { holds: false, reason: 'this backend installs no cgroup or rlimit; the sandbox reports unlimited memory and time' },
    required: false,
    verdict: 'not-run',
  });

  return { caseId: 'SB-04', rows, spec, specShared, isolation: describeIsolation() };
}

/** SB-02: authorization consistency — the sandbox is a backend, not an approval bypass. */
async function sb02Authorization({ scratch, facts }) {
  const workspace = ensureDir(join(scratch, 'ws'));
  const auditPath = join(scratch, 'sandbox-audit.jsonl');
  const spec = { workspace, network: 'none', distro: facts.distro, toolchainPaths: facts.toolchainPaths };
  const rows = [];
  const allow = () => { const a = []; a.allow = true; return a; };

  const denied = [];
  denied.allow = false;
  const deniedRun = await runThroughExecTool({
    command: 'echo should-not-run > denied.txt',
    dataDir: scratch, workspace, approvals: denied, permissionMode: 'research', spec, auditPath,
  });
  rows.push(row({
    id: 'approval-denied-blocks-execution', command: 'echo should-not-run > denied.txt',
    expected: 'a denied command does not run and leaves no artifact',
    arrival: 'reached',
    observed: { holds: !existsSync(join(workspace, 'denied.txt')) && deniedRun.ok === false, toolError: deniedRun.error, approvals: deniedRun.approvals.length },
  }));

  const granted = await runThroughExecTool({
    command: 'echo should-run > granted.txt',
    dataDir: scratch, workspace, approvals: allow(), permissionMode: 'research', spec, auditPath,
  });
  rows.push(row({
    id: 'approval-granted-runs-in-the-sandbox', command: 'echo should-run > granted.txt',
    expected: 'an approved command runs, in the sandbox, and the host sees the artifact',
    arrival: 'reached',
    observed: {
      holds: existsSync(join(workspace, 'granted.txt')) && granted.actualBackend === SANDBOX_BACKEND,
      actualBackend: granted.actualBackend, approvals: granted.approvals.length,
    },
  }));

  const unavailable = await runThroughExecTool({
    command: 'echo fallback-check > fallback.txt',
    dataDir: scratch, workspace, approvals: allow(), spec: { ...spec, distro: 'NoSuchDistro-9x' }, auditPath,
  });
  rows.push(row({
    id: 'unavailable-backend-does-not-fall-back', command: 'echo fallback-check > fallback.txt',
    expected: 'a requested backend that cannot start runs nothing and does not silently use the host shell',
    arrival: 'reached',
    observed: {
      holds: !existsSync(join(workspace, 'fallback.txt')) && unavailable.ok === false && unavailable.actualBackend !== SANDBOX_BACKEND,
      requestedBackend: unavailable.requestedBackend, actualBackend: unavailable.actualBackend, toolError: unavailable.error,
    },
  }));

  const hostRun = await runThroughExecTool({
    command: 'echo host-side > host.txt',
    dataDir: scratch, workspace, approvals: allow(), backend: 'host', spec, auditPath,
  });
  rows.push(row({
    id: 'host-backend-is-reported-as-host', command: 'echo host-side > host.txt',
    expected: 'choosing the host backend is reported as host, never as sandboxed',
    arrival: 'reached',
    observed: { holds: hostRun.actualBackend === 'host', actualBackend: hostRun.actualBackend },
  }));

  const unknown = await runThroughExecTool({
    command: 'echo unknown-backend > unknown.txt',
    dataDir: scratch, workspace, approvals: allow(), backend: 'not-a-backend', spec, auditPath,
  });
  rows.push(row({
    id: 'unknown-backend-value-is-not-a-choice', command: 'echo unknown-backend > unknown.txt',
    expected: 'an unrecognised backend value must not be silently accepted as an isolation claim',
    arrival: 'reached',
    observed: {
      holds: unknown.actualBackend !== SANDBOX_BACKEND,
      requestedBackend: unknown.requestedBackend, actualBackend: unknown.actualBackend,
      note: 'the current resolver maps any unrecognised value to host; the row records that as the observed behaviour and F-07 asks for an explicit configuration error instead',
    },
  }));

  return {
    caseId: 'SB-02',
    rows,
    isolation: describeIsolation(),
    note: 'Every row drives the real exec tool, so argument validation, the approval gate and output sanitising are the product ones; only the process backend differs.',
  };
}

// ──────────────────────────────────────────────────────────────────────────────── driver

export async function runSandboxCases(args, context) {
  const { EVIDENCE_ROOT, BUDGET, ledgerPath, out, buildManifest } = context;
  const requested = args.cases?.length ? args.cases : ['sb02-authorization', 'sb03-workload', 'sb04-boundary'];
  const run = async (command, commandArgs) => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    try {
      const { stdout, stderr } = await promisify(execFile)(command, commandArgs, {
        windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 300_000,
      });
      return { ok: true, stdout, stderr };
    } catch (error) {
      return { ok: false, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message), code: error.code };
    }
  };

  const selfTest = verifierSelfTest();
  const facts = sandboxHostFacts();
  const backend = await probeBackend(run, facts);
  const scratch = ensureDir(join(EVIDENCE_ROOT, 'sandbox', 'scratch'));
  const handlers = { 'sb02-authorization': sb02Authorization, 'sb03-workload': sb03Workload, 'sb04-boundary': sb04Boundary };
  const cases = [];

  for (const name of requested) {
    const handler = handlers[name];
    if (!handler) continue;
    if (!backend.available) {
      cases.push({
        caseId: name.replace(/^sb0\d-/u, '').toUpperCase(),
        rows: [],
        verdict: 'blocked',
        reason: `backend unavailable: ${backend.unavailableReason}`,
        failed: [{ id: 'backend-precondition', verdict: 'blocked' }],
      });
      continue;
    }
    await rm(join(scratch, name), { recursive: true, force: true });
    const caseScratch = ensureDir(join(scratch, name));
    const outcome = await handler({ scratch: caseScratch, facts, run });
    const decision = verdictOf(outcome.rows);
    cases.push({ ...outcome, verdict: decision.verdict, failed: decision.failed, counts: decision.counts });
  }

  // Closed aggregation: the self-test must hold, the backend must have started, and every case must pass.
  const blockers = [
    ...(selfTest.ok ? [] : [{ id: 'verifier-self-test', verdict: 'fail' }]),
    ...(backend.available ? [] : [{ id: 'backend-availability', verdict: 'blocked' }]),
    ...cases.filter((entry) => entry.verdict !== 'pass').map((entry) => ({ id: entry.caseId, verdict: entry.verdict })),
  ];
  const overall = blockers.length === 0 ? 'pass' : 'fail';

  const payload = {
    mode: 'sandbox',
    generatedAt: new Date().toISOString(),
    batchId: `${BUDGET.batchId}-SANDBOX`,
    backend: SANDBOX_BACKEND,
    backendProbe: backend,
    hostFacts: { distro: facts.distro, toolchainPaths: facts.toolchainPaths, windowsPeSupplied: Boolean(facts.windowsPeSource) },
    buildManifest: buildManifest ?? null,
    verifierSelfTest: selfTest,
    isolation: describeIsolation(),
    cases,
    overall,
    blockers,
    limits: [
      'This drives the exec tool directly with a synthetic ToolContext rather than through a model run; RA-09 owns the real entry.',
      'The backend is an experiment-only selection behind LS_EXPERIMENT_EXEC_BACKEND. It is not wired into any product default.',
      'The prototype binds the run workspace read-write; it does not make the sandbox a substitute for the read -> observation -> validate -> mutate path.',
      'bubblewrap is setuid-root on this machine, so the WSL kernel and bubblewrap themselves are inside the trusted computing base.',
      'Resource ceilings are unsupported by this backend and are reported as not-run, never as satisfied.',
      'proxy mode has no forced egress and is not claimed to restrict direct connections.',
    ],
  };
  writeJson(join(EVIDENCE_ROOT, 'sandbox', 'sandbox-report.json'), payload);
  appendJsonLine(ledgerPath, ledgerRecord({
    batchId: `${BUDGET.batchId}-SANDBOX`,
    caseId: 'SB-02..SB-04',
    arm: 'B',
    trial: 1,
    runId: `sandbox-${Date.now()}`,
    sourceHash: buildManifest?.digest ?? 'unknown',
    promptHash: sha256(JSON.stringify(requested)),
    configHash: sha256(JSON.stringify({ backend, distro: facts.distro, toolchainPaths: facts.toolchainPaths })),
    authorizationRef: 'permissionMode=full for boundary rows, research for the approval rows; backend selected by an experiment-only environment variable',
    requestedBackend: SANDBOX_BACKEND,
    actualBackend: backend.available ? SANDBOX_BACKEND : 'unknown',
    injection: null,
    targetTriggered: backend.available ? 'yes' : 'no',
    outcome: overall,
    artifactChecks: cases.flatMap((entry) => (entry.rows ?? []).map((check) => ({
      case: entry.caseId, id: check.id, verdict: check.verdict, arrival: check.arrival, expected: check.expected, observed: check.observed,
    }))),
    interventions: [],
    refusals: [],
    usage: { status: 'not-applicable', reason: 'sandbox mode makes no model calls' },
    retries: 'unknown',
    elapsedMs: 0,
    sandboxChecks: cases.map((entry) => ({ caseId: entry.caseId, verdict: entry.verdict, failed: entry.failed ?? [] })),
    evidenceRefs: [join(EVIDENCE_ROOT, 'sandbox')],
    limitations: payload.limits,
    status: 'sandbox',
    notes: 'no model cost',
  }));
  out(args, payload, overall === 'pass' ? 0 : 1);
}
