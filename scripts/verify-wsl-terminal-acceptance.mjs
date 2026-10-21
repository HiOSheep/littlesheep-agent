#!/usr/bin/env node
// Dedicated platform acceptance for the WSL terminal path (UX-29 items 3/4,
// Bash side). The acceptance itself lives in
// `packages/app/src/main/local-app-api/workspace-terminal-wsl-acceptance.test.ts`
// and is opt-in there, so it never turns the portable full gate red for a host
// environment reason.
//
// This entry exists to make that platform coverage observable instead of
// silently skipped:
//
//   exit 0  acceptance ran on this host and passed
//   exit 1  acceptance ran and failed (a real finding, not an environment block)
//   exit 2  environment blocked before the acceptance could be exercised
//           (no WSL, stalled WSL, missing test runner). A block is recorded as
//           a block - it is never reported as a pass and never as a product
//           defect.
//
// The preflight is deliberately bounded: a healthy `wsl.exe bash -lc` probe
// returns in about 1-5 s on the development hosts, so 45 s is already an
// order-of-magnitude allowance. A probe that needs longer is a stalled WSL
// host, not a slow product path, and the generic suite cannot distinguish the
// two by itself.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PROBE_TIMEOUT_MS = 45_000
const ACCEPTANCE_FILE = 'packages/app/src/main/local-app-api/workspace-terminal-wsl-acceptance.test.ts'
const PROBE_MARKER = 'LS-WSL-PROBE'

function usage() {
  return [
    'Run the opt-in WSL terminal platform acceptance.',
    '',
    'Usage:',
    '  pnpm run verify:wsl-terminal',
    '  node scripts/verify-wsl-terminal-acceptance.mjs [--probe-timeout-ms=<n>] [--json] [--help]',
    '',
    'Exit codes: 0 acceptance passed; 1 acceptance failed; 2 environment blocked (not a pass).',
    '',
    'The generic `verify:full` gate records this acceptance as an opt-in skip; this',
    'command is the only entry that exercises it.',
  ].join('\n')
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS, json: false, help: false }
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--json') options.json = true
    else if (arg.startsWith('--probe-timeout-ms=')) {
      const parsed = Number(arg.slice('--probe-timeout-ms='.length))
      if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
        throw new Error('--probe-timeout-ms must be an integer from 1000 to 600000.')
      }
      options.probeTimeoutMs = parsed
    } else {
      throw new Error(`Unknown option: ${arg}. Use --help for usage.`)
    }
  }
  return options
}

function blocked(reason, detail, facts = {}) {
  return { status: 'blocked', reason, detail, facts }
}

function probeHost(probeTimeoutMs) {
  const startedAt = performance.now()
  const facts = { probeCommand: 'wsl.exe -e bash -lc', probeTimeoutMs }
  try {
    const stdout = execFileSync('wsl.exe', ['-e', 'bash', '-lc', `printf "${PROBE_MARKER}\\n"`], {
      encoding: 'utf8',
      timeout: probeTimeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const elapsedMs = Math.round(performance.now() - startedAt)
    Object.assign(facts, { probeLatencyMs: elapsedMs, probeExited: 0 })
    if (!String(stdout).includes(PROBE_MARKER)) {
      return blocked('wsl-probe-unexpected-output', `WSL returned output without ${PROBE_MARKER}.`, facts)
    }
    return { status: 'ok', facts }
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt)
    const timedOut = error?.code === 'ETIMEDOUT' || error?.signal === 'SIGTERM'
    Object.assign(facts, {
      probeLatencyMs: elapsedMs,
      probeExited: typeof error?.status === 'number' ? error.status : null,
      probeErrorCode: error?.code ?? null,
    })
    if (error?.code === 'ENOENT') {
      return blocked('wsl-unavailable', 'wsl.exe was not found on this host.', facts)
    }
    if (timedOut) {
      return blocked(
        'wsl-probe-timeout',
        `A trivial WSL command did not return within ${probeTimeoutMs} ms; this host's WSL/ConPTY stack is stalled, so the acceptance cannot be measured.`,
        facts,
      )
    }
    return blocked(
      'wsl-probe-failed',
      `A trivial WSL command failed (exit ${facts.probeExited ?? 'unknown'}, code ${facts.probeErrorCode ?? 'unknown'}): ${String(error?.stderr ?? error?.message ?? '').trim().slice(0, 400)}`,
      facts,
    )
  }
}

function runAcceptance({ facts }) {
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs')
  const factsWithRunner = { ...facts, acceptanceFile: ACCEPTANCE_FILE, vitestPath: vitest }
  if (!existsSync(vitest)) {
    return { status: 'blocked', reason: 'test-runner-unavailable', detail: `vitest entry not found: ${vitest}`, facts: factsWithRunner }
  }
  try {
    execFileSync(process.execPath, [vitest, 'run', ACCEPTANCE_FILE], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, LITTLESHEEP_WSL_TERMINAL_ACCEPTANCE: '1' },
      windowsHide: true,
    })
    return { status: 'passed', reason: null, detail: null, facts: factsWithRunner }
  } catch (error) {
    return {
      status: 'failed',
      reason: 'acceptance-failed',
      detail: `the WSL acceptance exited ${typeof error?.status === 'number' ? error.status : 'unknown'}; see the vitest output above`,
      facts: factsWithRunner,
    }
  }
}

function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`[wsl-terminal] ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
  if (options.help) {
    console.log(usage())
    return 0
  }

  const probe = probeHost(options.probeTimeoutMs)
  if (probe.status !== 'ok') {
    const summary = { schemaVersion: 1, check: 'wsl-terminal-acceptance', ...probe }
    if (options.json) console.log(JSON.stringify(summary, null, 2))
    else {
      console.error(`[wsl-terminal] environment blocked: ${probe.reason}`)
      console.error(`[wsl-terminal] ${probe.detail}`)
      if (probe.facts.probeLatencyMs !== undefined) console.error(`[wsl-terminal] probe latency: ${probe.facts.probeLatencyMs} ms (bound ${options.probeTimeoutMs} ms)`)
      console.error('[wsl-terminal] not a pass: the WSL terminal acceptance was not exercised on this host.')
    }
    return 2
  }

  const result = runAcceptance({ facts: probe.facts })
  const summary = { schemaVersion: 1, check: 'wsl-terminal-acceptance', ...result }
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
  } else if (result.status === 'passed') {
    console.log(`[wsl-terminal] acceptance passed (probe latency ${result.facts.probeLatencyMs} ms)`)
  } else if (result.status === 'failed') {
    console.error(`[wsl-terminal] acceptance failed: ${result.detail}`)
  } else {
    console.error(`[wsl-terminal] environment blocked: ${result.reason}`)
    console.error(`[wsl-terminal] ${result.detail}`)
  }
  if (result.status === 'passed') return 0
  if (result.status === 'failed') return 1
  return 2
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[wsl-terminal] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
