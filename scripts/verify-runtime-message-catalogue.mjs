// Gate for the Runtime message catalogue (audit #18, architecture candidate A1).
//
// The defect this gate exists for: after a crash recovery, a Chinese interface showed
// `Runtime is waiting for user action; no final reply was published. Reason: model_response_missing`
// in the answer slot — an English Runtime sentence with an internal settlement code inside it,
// built by a hardcoded literal at `packages/runner/src/authoritative-reply.ts`. The fix is a very
// thin catalogue (`packages/runner/src/runtime-messages.ts`): the sentence the Runtime used to
// print is the key, the Chinese sentence the reader gets is the value, and an entry that is missing
// falls back to the original text. No locale switching, no i18n framework, no translated logs.
//
// What this gate proves, through the real publication boundary (no window): for every terminal
// Runtime status the Runner can publish without a settled final reply, and for the fail-closed
// settlement path, the string a reader would see
//   1. is one of the catalogue's Chinese sentences (i.e. it was *not* passed through untranslated),
//   2. contains no internal reason code, and
//   3. is not an English sentence.
// It also scans the modules that own user-facing Runtime text for the two leak shapes the fix
// removed: a `Reason: <code>` suffix and a reason interpolated into user-facing text. Diagnostics
// (log lines, `console`, the execution log) are exempt: the code is supposed to live there.
//
// The pre-fix text is reproducible here, not reconstructed by hand: `--show-prefix` prints, for
// every entry, the sentence the Runtime published before the catalogue, and the gate publishes
// those by running `runtimeUserSentence(sentence, {})` — the same fallback function the production
// path calls, with the catalogue forced empty. (A `--before-fix` run of the *old* bundle is not
// possible after a rebuild; this forced override is the "say which" of the two options, and the
// pre-fix window evidence is the recorded O1 report, see `limits` below.)
//
// The window half of the acceptance lives in `scripts/verify-transcript-state-visibility.mjs`
// (category 8: a real kill + same-root restart, then the recovered `waiting_user` turn in both
// display modes), which now requires the Chinese sentence and rejects the reason code.
//
// Usage:
//   node scripts/verify-runtime-message-catalogue.mjs [--show-prefix] [--out=<dir>]
//
// Requires `packages/runner/dist` to be newer than its sources:
//   pnpm run ensure:workspace-build -- --package=@littlesheep/runner

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runArtifact } from './lib/run-artifacts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = resolve(readOption('out', runArtifact('runtime-message-catalogue')))
const showPrefix = process.argv.includes('--show-prefix')

/** Import one built Runner module (an absolute Windows path is not a URL the ESM loader accepts). */
const importRunnerDist = (name) => import(pathToFileURL(join(repoRoot, 'packages/runner/dist', name)).href)

/** A reason code shaped like every real one, so a leak cannot hide behind a realistic value. */
const SENTINEL_REASON = 'ls_catalogue_sentinel_reason'
/** The three terminal statuses the publication boundary can settle without a final reply. */
const STATUSES = ['waiting_user', 'interrupted', 'failed']
/** The forced override: the catalogue as it was before A1 — empty, so every lookup falls back. */
const NO_CATALOGUE = Object.freeze({})

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

function createRecorder() {
  const observations = []
  const failures = []
  const assertions = []
  let checks = 0
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      checks += 1
      const ok = Boolean(condition)
      assertions.push({ check, ok, detail })
      if (!ok) failures.push({ check, detail })
      return ok
    },
    failures,
    observations,
    assertions,
    count: () => checks,
  }
}

const hasHan = (value) => /\p{Script=Han}/u.test(value)
const hasReasonCode = (value) => /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/u.test(value)
const isEnglishSentence = (value) => !hasHan(value) && /[A-Za-z]{3,}\s+[A-Za-z]{3,}/u.test(value)

function runtimeResult(overrides = {}) {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'ok',
    reply: 'temporary model reply',
    messages: [],
    trace: [],
    durationMs: 1,
    ...overrides,
  }
}

function executionLog(overrides = {}) {
  return {
    runId: 'run-1',
    durableHarnessMode: 'next',
    sessionId: 'session-1',
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    status: 'ok',
    model: 'test/model',
    inboundText: 'input',
    reply: 'temporary model reply',
    trace: [],
    toolCalls: [],
    durationMs: 1,
    ...overrides,
  }
}

function replayRunner(replay) {
  return { durableHarnessMode: 'next', replayDurableFinalReply: replay }
}

/** Every module whose `dist` must be newer than its `src` for this gate to mean anything. */
const REQUIRED_DIST = [
  ['runtime-messages.js', 'runtime-messages.ts'],
  ['authoritative-reply.js', 'authoritative-reply.ts'],
  ['run-failure-result.js', 'run-failure-result.ts'],
]

async function assertRunnerDistFresh() {
  const stale = []
  for (const [output, source] of REQUIRED_DIST) {
    const outputPath = join(repoRoot, 'packages/runner/dist', output)
    const sourcePath = join(repoRoot, 'packages/runner/src', source)
    const [outputInfo, sourceInfo] = await Promise.all([
      stat(outputPath).catch(() => undefined),
      stat(sourcePath).catch(() => undefined),
    ])
    if (!outputInfo) stale.push(`${output}: not built`)
    else if (sourceInfo && outputInfo.mtimeMs < sourceInfo.mtimeMs) stale.push(`${output}: older than ${source}`)
  }
  return stale
}

/**
 * The leak shapes, scanned over the modules that own user-facing Runtime text. Each rule is narrow
 * on purpose: this gate must fail for the defect it was written for, not for every English string in
 * the package (internal errors, rejected Runtime events and log lines are none of its business).
 */
const REASON_LEAK_RULES = [
  // The pre-fix shape of this finding: `... sentence. Reason: model_response_missing`.
  { name: '`Reason: <code>` suffix', pattern: /Reason:\s*\$\{/u },
  // The pre-fix shape of the app-side fallback: the internal status code appended to a sentence.
  { name: 'status reason interpolated into text', pattern: /\$\{[^}]*runtimeStatus[?.\w]*\breason\b/u },
]
/**
 * An English Runtime *status* sentence may only exist as a catalogue key or as an argument to the
 * catalogue lookup. (`Runtime event queue ...` style internal errors are not matched: they are not
 * status sentences, and this gate does not claim to translate diagnostics.)
 */
const ENGLISH_STATUS_SENTENCE = /['"`]Runtime (?:is|was|failed|interrupted|has|did|will)[^'"`\n]*['"`]/u
/** The publication helper whose first argument must never carry a bare reason code as `error`. */
const RESULT_ASSEMBLY_CALL = 'assembleResult('

/**
 * The first argument of every `name(...)` call in the file, as raw text.
 *
 * A whole-file regex cannot tell `assembleResult({ error: reason })` (a code published as the
 * user's explanation) from `stageResult: { error: reason }` inside an internal record, so the
 * argument is delimited by its own parentheses.
 */
function callArguments(text, name) {
  const arguments_ = []
  for (let index = text.indexOf(name); index !== -1; index = text.indexOf(name, index + name.length)) {
    let depth = 0
    let cursor = index + name.length - 1
    for (; cursor < text.length; cursor += 1) {
      const character = text[cursor]
      if (character === '(') depth += 1
      else if (character === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    arguments_.push({ index, text: text.slice(index + name.length, cursor + 1) })
  }
  return arguments_
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}


async function sourceFiles() {
  const runnerSrc = join(repoRoot, 'packages/runner/src')
  const names = await readdir(runnerSrc)
  const files = names
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'runtime-messages.ts')
    .map((name) => join(runnerSrc, name))
  // The history projection is the other place a Runtime status sentence is assembled for the
  // reader (`runActivityOutcome`), so its waiting fallback is scanned with the Runner's own.
  files.push(join(repoRoot, 'packages/app/src/shared/history-activity.ts'))
  return files
}

function scanSources(sources, catalogue) {
  const leaks = []
  const hardcodedSentences = []
  for (const { path, text } of sources) {
    const file = relative(repoRoot, path).replace(/\\/gu, '/')
    const at = (line) => `${file}:${line}`
    const lines = text.split(/\r?\n/u)
    for (const [index, line] of lines.entries()) {
      for (const rule of REASON_LEAK_RULES) {
        if (rule.pattern.test(line)) leaks.push({ where: at(index + 1), rule: rule.name, line: line.trim() })
      }
      const sentence = ENGLISH_STATUS_SENTENCE.exec(line)
      const literal = sentence?.[0].slice(1, -1)
      if (literal && catalogue[literal] === undefined && !line.includes('runtimeUserSentence(')) {
        hardcodedSentences.push({ where: at(index + 1), line: line.trim(), literal })
      }
    }
    for (const call of callArguments(text, RESULT_ASSEMBLY_CALL)) {
      if (!/error:\s*reason\b/u.test(call.text)) continue
      leaks.push({
        where: at(lineOf(text, call.index)),
        rule: 'settlement code published as the run error',
        line: call.text.split('\n').find((line) => /error:\s*reason\b/u.test(line))?.trim() ?? '',
      })
    }
  }
  return { leaks, hardcodedSentences }
}

async function main() {
  const recorder = createRecorder()
  const stale = await assertRunnerDistFresh()
  if (stale.length > 0) {
    console.error(
      'runtime message catalogue: packages/runner/dist is not current — run\n'
      + '  pnpm run ensure:workspace-build -- --package=@littlesheep/runner\n'
      + `stale: ${stale.join('; ')}`,
    )
    process.exitCode = 1
    return
  }

  const { RUNTIME_MESSAGE_CATALOGUE, runtimeUserSentence } = await importRunnerDist('runtime-messages.js')
  const { prepareAuthoritativeRunnerResult, prepareAuthoritativeExecutionLog } = await importRunnerDist('authoritative-reply.js')
  const { runtimeFailureResult } = await importRunnerDist('run-failure-result.js')

  const catalogue = Object.freeze({ ...RUNTIME_MESSAGE_CATALOGUE })
  const localized = new Set(Object.values(catalogue))

  // ---------------------------------------------------------------------
  // 1. The catalogue covers the sentences the Runner published before it existed, in Chinese.
  // ---------------------------------------------------------------------
  const entries = Object.entries(catalogue)
  recorder.note({ step: 'catalogue', entries: entries.map(([original, sentence]) => ({ original, sentence })) })
  recorder.check(entries.length > 0, 'the catalogue has entries', { entries: entries.length })
  for (const [original, sentence] of entries) {
    recorder.check(
      sentence !== original && hasHan(sentence) && !isEnglishSentence(sentence),
      `catalogued sentence is Chinese, not the original English: ${JSON.stringify(original)}`,
      { original, sentence },
    )
    recorder.check(
      !hasReasonCode(sentence) && !/Reason:/u.test(sentence),
      'a catalogued sentence carries no internal reason code',
      { sentence },
    )
  }

  // ---------------------------------------------------------------------
  // 2. The publication boundary: every terminal status, through both the run result and the
  //    execution-log replay the history projection reads.
  // ---------------------------------------------------------------------
  for (const status of STATUSES) {
    const replay = async () => ({
      kind: 'runtime_status',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 3,
      settlementId: `runtime-status-${status}`,
      status,
      reason: SENTINEL_REASON,
    })
    const prepared = await prepareAuthoritativeRunnerResult(replayRunner(replay), runtimeResult())
    const preparedLog = await prepareAuthoritativeExecutionLog(replayRunner(replay), executionLog())
    recorder.note({
      step: `status-${status}`,
      error: prepared.error ?? null,
      logError: preparedLog.error ?? null,
      runtimeStatus: prepared.runtimeStatus ?? null,
    })
    for (const [label, error] of [['run result', prepared.error], ['execution-log replay', preparedLog.error]]) {
      recorder.check(
        typeof error === 'string' && localized.has(error),
        `${status} via ${label}: the reader gets a catalogue sentence, not the untranslated original`,
        { status, label, error },
      )
      recorder.check(
        typeof error === 'string' && !error.includes(SENTINEL_REASON) && !hasReasonCode(error),
        `${status} via ${label}: no internal reason code in user-facing text`,
        { status, label, error },
      )
    }
    recorder.check(
      prepared.runtimeStatus?.reason === SENTINEL_REASON && preparedLog.runtimeStatus?.reason === SENTINEL_REASON,
      `${status}: the reason code is still recorded in the structured status (diagnostics)`,
      { status, reason: prepared.runtimeStatus?.reason ?? null },
    )
  }

  // ---------------------------------------------------------------------
  // 3. No settled reply and no Runtime failure text: the fail-closed path must not republish a
  //    settlement code as the user's explanation (it used to, via `runtimeStatus.reason`).
  // ---------------------------------------------------------------------
  const failClosed = await prepareAuthoritativeRunnerResult(
    replayRunner(async () => ({
      kind: 'unavailable',
      sessionId: 'session-1',
      runId: 'run-1',
      cursor: 4,
      status: 'failed',
      reason: 'terminal_without_settlement',
    })),
    runtimeResult({ status: 'error', reply: '', error: undefined }),
  )
  recorder.note({ step: 'fail-closed', error: failClosed.error ?? null, runtimeStatus: failClosed.runtimeStatus ?? null })
  recorder.check(
    typeof failClosed.error === 'string' && localized.has(failClosed.error),
    'fail-closed publication shows a catalogue sentence instead of an internal code',
    { error: failClosed.error },
  )
  recorder.check(
    typeof failClosed.error === 'string'
    && !failClosed.error.includes('durable_final_reply_terminal_without_settlement')
    && failClosed.runtimeStatus?.reason === 'durable_final_reply_terminal_without_settlement',
    'fail-closed publication keeps the code in the structured status only',
    { error: failClosed.error, runtimeStatus: failClosed.runtimeStatus ?? null },
  )

  // ---------------------------------------------------------------------
  // 4. The settled-failure publication (`runtimeFailureResult`) localizes its fallback and still
  //    keeps a Runtime-owned failure detail when there is one (that text is not a Runtime sentence).
  // ---------------------------------------------------------------------
  const noDetail = runtimeFailureResult(
    runtimeResult({ status: 'error', reply: '', error: undefined }),
    SENTINEL_REASON,
  )
  const withDetail = runtimeFailureResult(
    runtimeResult({ status: 'error', reply: '', error: 'user-facing reply generation failed: HTTP 401' }),
    SENTINEL_REASON,
  )
  recorder.note({ step: 'runtime-failure-result', noDetail: noDetail.error ?? null, withDetail: withDetail.error ?? null })
  recorder.check(
    typeof noDetail.error === 'string' && localized.has(noDetail.error) && noDetail.runtimeStatus?.reason === SENTINEL_REASON,
    'a failed settlement with no detail publishes the localized sentence and keeps the code structured',
    { error: noDetail.error, runtimeStatus: noDetail.runtimeStatus ?? null },
  )
  recorder.check(
    typeof withDetail.error === 'string' && withDetail.error.includes('HTTP 401'),
    'a Runtime-owned failure detail is still shown verbatim (it is not a Runtime sentence)',
    { error: withDetail.error },
  )

  // ---------------------------------------------------------------------
  // 5. Source scan: the two shapes the fix removed must not come back in the modules that own
  //    user-facing Runtime text.
  // ---------------------------------------------------------------------
  const sources = []
  for (const path of await sourceFiles()) {
    sources.push({ path, text: await readFile(path, 'utf8') })
  }
  const { leaks, hardcodedSentences } = scanSources(sources, catalogue)
  recorder.note({ step: 'source-scan', files: sources.length, leaks, hardcodedSentences })
  recorder.check(
    leaks.length === 0,
    'no reason code reaches user-facing text (a `Reason:` suffix, an interpolated status reason, a code as the run error)',
    { leaks },
  )
  recorder.check(
    hardcodedSentences.length === 0,
    'no English Runtime status sentence literal lives outside the catalogue',
    { hardcodedSentences },
  )

  // ---------------------------------------------------------------------
  // 6. The scan rules themselves are load-bearing: each one has to catch the exact pre-fix line
  //    this change removed, with the catalogue forced empty (the catalogue key is *why* the original
  //    literal is allowed to exist at all today).
  // ---------------------------------------------------------------------
  const preFixLines = [
    {
      where: 'packages/runner/src/authoritative-reply.ts:226',
      rule: '`Reason: <code>` suffix',
      line: 'return status.reason ? `${base} Reason: ${status.reason}` : base',
    },
    {
      where: 'packages/runner/src/run-failure-result.ts:47',
      rule: '`Reason: <code>` suffix',
      line: 'error: detail || `Runtime failed before publishing a final reply. Reason: ${reason}`,',
    },
    {
      where: 'packages/app/src/shared/history-activity.ts:209',
      rule: 'status reason interpolated into text',
      line: "? run.error || `需要用户决定后才能继续。${run.runtimeStatus?.reason ? ` ${run.runtimeStatus.reason}` : ''}`",
    },
    {
      where: 'packages/runner/src/runner.ts:912',
      rule: 'settlement code published as the run error',
      line: "const failure = assembleResult({ stage: 'finalize', next: 'exit', ok: false, error: reason, }, ctx)",
    },
  ]
  recorder.note({ step: 'scan-rule-self-test', preFixLines })
  for (const fixture of preFixLines) {
    const caught = fixture.rule === 'settlement code published as the run error'
      ? callArguments(fixture.line, RESULT_ASSEMBLY_CALL).some((call) => /error:\s*reason\b/u.test(call.text))
      : Boolean(REASON_LEAK_RULES.find((rule) => rule.name === fixture.rule)?.pattern.test(fixture.line))
    recorder.check(caught, `the scan rule catches the pre-fix line at ${fixture.where}`, fixture)
  }
  const preFixSentenceLiteral = "'Runtime is waiting for user action; no final reply was published.'"
  const sentenceMatch = ENGLISH_STATUS_SENTENCE.exec(preFixSentenceLiteral)
  recorder.check(
    Boolean(sentenceMatch) && NO_CATALOGUE[sentenceMatch[0].slice(1, -1)] === undefined,
    'with the catalogue forced empty, the pre-fix status sentence is caught as a hardcoded literal',
    { literal: preFixSentenceLiteral },
  )

  // ---------------------------------------------------------------------
  // 7. Pre-fix text, reproduced through the production fallback with the catalogue forced empty.
  // ---------------------------------------------------------------------
  const preFix = entries.map(([original, sentence]) => ({
    original,
    sentence,
    publishedWithoutCatalogue: runtimeUserSentence(original, NO_CATALOGUE),
  }))
  recorder.note({ step: 'pre-fix', preFix })
  for (const entry of preFix) {
    recorder.check(
      entry.publishedWithoutCatalogue === entry.original,
      `with the catalogue forced empty the pre-fix sentence is published again: ${JSON.stringify(entry.original)}`,
      entry,
    )
  }
  // The historical pre-fix sentence of this finding, as observed in the window (audit #18).
  const observedPreFix = 'Runtime is waiting for user action; no final reply was published.'
  recorder.check(
    preFix.some((entry) => entry.original === observedPreFix),
    'the sentence audit #18 observed in the window is a catalogue key (its entry is what changed)',
    { observedPreFix, keys: entries.map(([original]) => original) },
  )

  const evidence = {
    check: 'runtime-message-catalogue',
    capturedAt: new Date().toISOString(),
    runnerDist: REQUIRED_DIST.map(([output]) => `packages/runner/dist/${output}`),
    ok: recorder.failures.length === 0,
    checks: recorder.count(),
    assertions: recorder.assertions,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'This gate drives the Runner\'s publication boundary and scans sources; it does not open a window. The window half is `scripts/verify-transcript-state-visibility.mjs` category 8, which now requires the Chinese sentence in both display modes and rejects the reason code in any user-visible string it samples.',
      'User-facing English that the Runner only passes through from another layer is not covered here and is not part of this change: `packages/harness/src/stages/reply.ts` (2 sentences), `ask_user.ts`, `execute/main-loop.ts` (`user-facing ... generation failed: <provider text>`), and `packages/harness/src/durable-harness.ts` (`run paused/interrupted at a safe boundary`). They reach the same answer slot, but localizing them needs the catalogue in a layer the harness can import (the harness must not depend on the Runner), which is a larger change than A1 authorised.',
      'The source scan is bounded to the modules that own user-facing Runtime text (`packages/runner/src/*.ts` outside tests and the catalogue, plus `packages/app/src/shared/history-activity.ts`). It is a rule about shapes (a reason interpolation, a `Reason:` suffix, a bare `error: reason`), not a proof that every string in the repository is translated.',
      'The pre-fix text is reproduced through the production fallback with the catalogue forced empty. Running the *old bundle* for a before/after window comparison is not possible once the app bundle is rebuilt; the recorded pre-fix window evidence is the O1 report (`transcript-state-visibility/report.json`, `waiting-recovered-normal-strings`) and its screenshots.',
    ],
  }

  if (showPrefix) {
    console.log('Pre-fix sentences (what the Runtime published before the catalogue) and their replacements:')
    for (const entry of preFix) {
      console.log(`  pre-fix : ${entry.original}`)
      console.log(`  now     : ${entry.sentence}`)
    }
    console.log('')
  }
  console.log(JSON.stringify(evidence, null, 2))
  await mkdir(outRoot, { recursive: true })
  await writeFile(join(outRoot, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  if (!evidence.ok) process.exitCode = 1
}

await main()
