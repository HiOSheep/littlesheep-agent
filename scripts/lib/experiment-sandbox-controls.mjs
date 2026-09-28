// RA-07 controls for the sandbox matrix: the rows that decide whether the other rows mean anything.
//
// The review's point was that a protection which was never exercised proves nothing, and that a refusal
// whose cause is not isolated proves nothing either. Both controls here are built around that.
//
//   * `interopFixControl` runs the very same attack twice in the very same fixture with exactly one thing
//     changed — the `/init` mask is removed from the argv. If the proof file appears only in that variant,
//     the mask is what closed the channel rather than something incidental about the fixture. If the
//     unmasked arm also fails to produce it, the row reports `blocked`: an attack that never lands anywhere
//     is not evidence about the mask.
//
//   * `networkListenerControl` starts a listener inside the distro and asks two sandboxes to reach it. A
//     failed connection to a port nobody listens on proves nothing, which is what the previous row did.
//     Here one arm must fail, the other must succeed, and the listener's own accept log is the witness for
//     the success arm so a client-side error cannot be mistaken for a block.
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { distroPathOf } from './experiment-sandbox.mjs';

/** Take the product argv and remove exactly the `/init` mask, leaving everything else identical. */
export function buildArgvWithoutInteropMask(argv) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--ro-bind' && argv[index + 1] === '/dev/null' && argv[index + 2] === '/init') {
      index += 2;
      continue;
    }
    out.push(argv[index]);
  }
  return out;
}

/** Run one command line directly under a caller-supplied argv. */
export async function runRawArgv(run, argv, { timeoutMs = 60_000 } = {}) {
  // WSL_UTF8=1 is what makes wsl.exe emit UTF-8 instead of UTF-16LE; without it every diagnostic from
  // this arm arrives as interleaved NUL bytes and the control cannot say why it failed.
  process.env.WSL_UTF8 = '1';
  try {
    return await run('wsl.exe', argv, { timeoutMs });
  } finally {
    delete process.env.WSL_UTF8;
  }
}

function hasInteropMask(argv) {
  for (let index = 0; index < argv.length - 2; index += 1) {
    if (argv[index] === '--ro-bind' && argv[index + 1] === '/dev/null' && argv[index + 2] === '/init') return true;
  }
  return false;
}

/**
 * The interop fix control. `buildArgvFor(command)` must return the product's argv for that command, so the
 * only difference between the arms is the mask this module removes.
 */
export async function interopFixControl({ facts, run, buildArgvFor, workspace, proofWin }) {
  const staged = join(workspace, 'payload.exe');
  // This control stages its own payload: the interop row above removes the one it staged, and a control
  // that depends on another row's side effects reports locked for a reason that has nothing to do with
  // the protection it is meant to test.
  if (facts.windowsPeSource && existsSync(facts.windowsPeSource)) await copyFile(facts.windowsPeSource, staged);
  const attackCommand = `./payload.exe /c "echo PWNED > ${distroPathOf(proofWin)}" 2>&1; echo interop_exit=$?`;

  const arm = async (label, argv, expectation) => {
    await rm(proofWin, { force: true });
    if (!existsSync(staged)) {
      return { label, expectation, arrival: 'not-reached', observed: { holds: false, reason: 'the host did not stage the payload' } };
    }
    // The product argv already starts with -d <distro> -e bwrap; prepending another -d made wsl.exe try
    // to run -d as the program, which produced no output at all and made both arms look identical.
    const result = await runRawArgv(run, [...argv]);
    const proof = existsSync(proofWin);
    return {
      label,
      expectation,
      arrival: 'reached',
      observed: {
        holds: expectation === 'proof-file-absent' ? !proof : proof,
        proofFileExists: proof,
        proofFileContent: proof ? readFileSync(proofWin, 'utf8').trim().slice(0, 80) : null,
        output: String(result.stdout ?? '').slice(0, 200),
        hasInteropMask: hasInteropMask(argv),
      },
    };
  };

  let masked;
  let unmasked;
  try {
    const maskedArgv = await buildArgvFor(attackCommand);
    const unmaskedArgv = buildArgvWithoutInteropMask(maskedArgv);
    masked = await arm('masked', maskedArgv, 'proof-file-absent');
    unmasked = await arm('unmasked', unmaskedArgv, 'proof-file-present');
  } catch (error) {
    return {
      id: 'interop-fix-control',
      command: '(host stages the PE; the same attack runs with and without the /init mask)',
      expected: 'the mask is load-bearing: proof absent with it, present without it',
      arrival: 'not-reached',
      observed: { holds: false, reason: `the control could not be built: ${String(error?.message ?? error).slice(0, 200)}` },
      required: true,
      verdict: 'blocked',
    };
  } finally {
    await rm(staged, { force: true });
    await rm(proofWin, { force: true });
  }

  const bothLanded = masked.arrival === 'reached' && unmasked.arrival === 'reached';
  const holds = bothLanded && masked.observed.holds === true && unmasked.observed.holds === true;
  return {
    id: 'interop-fix-control',
    command: '(host stages the PE; the same attack runs with and without the /init mask)',
    expected: 'the mask is load-bearing: proof absent with it, present without it',
    arrival: bothLanded ? 'reached' : 'not-reached',
    observed: { holds, masked, unmasked, note: 'the two arms differ by exactly the `--ro-bind /dev/null /init` triple' },
    required: true,
    verdict: holds ? 'pass' : (bothLanded ? 'fail' : 'blocked'),
  };
}

/**
 * The network control, with a real listener. Returns one row; the caller supplies the two specs and an
 * `exec` that drives the real exec tool.
 */
export async function networkListenerControl({ scratch, facts, run, exec, sharedSpec, restrictedSpec }) {
  const listenerScript = join(scratch, 'listener.py');
  const acceptLog = join(scratch, 'listener-accept.log');
  const portFile = join(scratch, 'listener-port.txt');
  await writeFile(listenerScript, [
    'import socket, sys',
    's = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)',
    "s.bind(('127.0.0.1', 0)); s.listen(1)",
    'open(sys.argv[2], "w").write(str(s.getsockname()[1]))',
    's.settimeout(25)',
    'try:',
    '    s.accept()',
    '    open(sys.argv[1], "a").write("accepted\\n")',
    'except Exception as e:',
    '    open(sys.argv[1], "a").write("timeout:%s\\n" % type(e).__name__)',
  ].join('\n'), 'utf8');
  await rm(acceptLog, { force: true });
  await rm(portFile, { force: true });

  await run('wsl.exe', ['-d', facts.distro, '-e', 'bash', '-lc',
    `nohup python3 '${distroPathOf(listenerScript)}' '${distroPathOf(acceptLog)}' '${distroPathOf(portFile)}' >/dev/null 2>&1 & sleep 2; cat '${distroPathOf(portFile)}' 2>/dev/null`]);
  const port = Number((existsSync(portFile) ? readFileSync(portFile, 'utf8') : '').trim());
  if (!Number.isInteger(port) || port <= 0) {
    return {
      id: 'network-listener-control',
      command: '(controlled listener inside the distro)',
      expected: 'a real listener decides the network rows',
      arrival: 'not-reached',
      observed: { holds: false, reason: 'the controlled listener did not report a port' },
      required: true,
      verdict: 'blocked',
    };
  }

  const probe = `python3 -c "import socket;s=socket.socket();s.settimeout(6);s.connect(('127.0.0.1',${port}))" >/dev/null 2>&1 && echo LISTENER_REACHED || echo LISTENER_UNREACHABLE`;
  const restricted = await exec('network-restricted-to-listener', probe, {
    useSpec: restrictedSpec,
    expect: 'the sandbox with no shared network must not reach the listener',
    check: (outcome) => ({ holds: outcome.output.includes('LISTENER_UNREACHABLE'), excerpt: outcome.output.trim().slice(0, 80) }),
  });
  const shared = await exec('network-shared-to-listener', probe, {
    useSpec: sharedSpec,
    expect: 'the sandbox sharing the network must reach the listener',
    check: (outcome) => ({ holds: outcome.output.includes('LISTENER_REACHED'), excerpt: outcome.output.trim().slice(0, 80) }),
  });
  const accepted = (existsSync(acceptLog) ? readFileSync(acceptLog, 'utf8') : '').includes('accepted');
  const holds = restricted.output.includes('LISTENER_UNREACHABLE') && shared.output.includes('LISTENER_REACHED') && accepted;
  return {
    id: 'network-listener-control',
    command: `(controlled listener on 127.0.0.1:${port})`,
    expected: 'restricted cannot connect, shared can, and the listener itself saw the shared connection',
    arrival: 'reached',
    observed: {
      holds,
      port,
      restrictedReached: restricted.output.includes('LISTENER_REACHED'),
      sharedReached: shared.output.includes('LISTENER_REACHED'),
      listenerAccepted: accepted,
      acceptLog: existsSync(acceptLog) ? readFileSync(acceptLog, 'utf8').trim().slice(0, 80) : null,
    },
    required: true,
    verdict: holds ? 'pass' : 'fail',
  };
}
