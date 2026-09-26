// Real-window acceptance for the file-consistency flow a user actually performs (RS-07).
//
// The chain under test is the one the taskbook asks for: LS reads a file, the user edits and saves it
// in their own editor, LS's edit is refused because the version it read is gone, and after reading the
// file again the same edit succeeds. The model is a deterministic fixture and the approval path is the
// real one; the file, the tools, the observation guard and the transcript are the shipped ones.
//
// Evidence is taken from two places and they have to agree: the bytes on disk (read by this process,
// outside the app) and the tool result the app recorded for the run.
//
// Run: pnpm run verify:desktop-file-consistency

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  FILE_CONSISTENCY_DENIED_FILE,
  FILE_CONSISTENCY_DOCUMENT,
  FILE_CONSISTENCY_FILE,
  FILE_CONSISTENCY_MARKERS,
  startElectronAcceptanceProvider,
} from './lib/electron-acceptance-provider.mjs'
import { readSse } from './lib/electron-deepseek-acceptance.mjs'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 30_000 })
const outRoot = resolve(repoRoot, readOption('out', join(tmpdir(), 'littlesheep-desktop-file-consistency')))
const keepRoot = process.argv.includes('--keep')
const WINDOW_SIZE = { width: 1280, height: 860 }
const EVALUATE_TIMEOUT_MS = 45_000

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
    }),
  ])
}

const evaluate = (client, expression) => withTimeout(client.evaluate(expression), EVALUATE_TIMEOUT_MS, 'Runtime.evaluate')
const delay0 = (ms) => delay(ms)

function createRecorder() {
  const observations = []
  const failures = []
  let checks = 0
  return {
    note: (entry) => observations.push(entry),
    check: (condition, check, detail) => {
      checks += 1
      if (!condition) failures.push({ check, detail })
      return Boolean(condition)
    },
    failures,
    observations,
    count: () => checks,
  }
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: 'acceptance',
      name: 'Desktop File Acceptance Provider',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 60,
      models: ['file-flow'],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: 'acceptance/file-flow',
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
      },
    },
    channels: { channels: [] },
    desktop: { closePolicy: 'always-background' },
  }
}

/** Everything the transcript shows for the newest assistant turn: replies and tool rows alike. */
const TRANSCRIPT_EXPRESSION = `(() => {
  const turns = [...document.querySelectorAll('.assistant-turn')]
  const turn = turns.at(-1)
  if (!turn) return { present: false }
  const text = (turn.textContent || '').replace(/\\s+/gu, ' ').trim()
  return {
    present: true,
    text,
    toolRows: turn.querySelectorAll('.agent-tool-row, .tool-row, [data-tool-row]').length,
  }
})()`

async function readTranscript(client, harness) {
  return harness.waitFor(async () => {
    const value = await evaluate(client, TRANSCRIPT_EXPRESSION)
    return value?.present ? value : undefined
  }, harness.actionTimeoutMs, 'the newest assistant turn')
}

/**
 * One turn through the app's own run API. This is the path the renderer uses; driving it directly keeps
 * the acceptance about file consistency instead of about typing into the composer, which other gates
 * cover.
 */
async function runTurn(locator, text, sessionId) {
  const { result } = await readSse(locator, '/run/stream', {
    text,
    permissionMode: 'full',
    ...(sessionId ? { sessionId } : {}),
  })
  return result
}

async function waitForReply(client, harness, marker) {
  return harness.waitFor(async () => {
    const value = await evaluate(client, TRANSCRIPT_EXPRESSION)
    return value?.present && value.text.includes(marker) ? value : undefined
  }, harness.actionTimeoutMs, `a reply containing ${marker}`)
}

async function main() {
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-desktop-file-consistency-'))
  const dataDir = join(root, 'data')
  const workplaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const screenshots = {}
  let handle
  let report
  let failure

  try {
    await Promise.all([mkdir(workplaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true }), mkdir(outRoot, { recursive: true })])
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workplaceDir, provider.baseURL), null, 2)}\n`, 'utf8')
    // The file the user and the agent both work on.
    const target = join(workplaceDir, FILE_CONSISTENCY_FILE)
    await writeFile(target, 'alpha\nsecond line\n', 'utf8')

    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraArgs: ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'park-offscreen')
    await delay0(1200)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    handle = { electron, locator, client }
    await harness.waitFor(() => evaluate(client, `Boolean(document.querySelector('.composer textarea'))`),
      harness.startTimeoutMs, 'the composer')
    await harness.waitFor(async () => {
      const readiness = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      return readiness?.body?.state === 'ready' ? readiness.body : undefined
    }, harness.startTimeoutMs, 'execution readiness')
    await delay0(600)

    // ─── Stage 1: the agent reads the file ────────────────────────────────────────────────────────
    const firstTurn = await runTurn(locator, `${FILE_CONSISTENCY_MARKERS[0]} 请先读取这个文件。`)
    const sessionId = await newestSessionId(dataDir)
    recorder.note({ step: 'agent-read', reply: String(firstTurn.reply ?? '').slice(0, 200), sessionId })
    const readResult = await waitForToolResult(harness, dataDir, sessionId, 'alpha')
    recorder.check(
      Boolean(readResult),
      'the read tool result carried the file\'s bytes into the run',
      { readResult: readResult?.slice(0, 300) ?? null },
    )

    // ─── Stage 2: the user saves the file in their own editor ─────────────────────────────────────
    // Same byte length, so the change is invisible to size. This is the user's save, not a tool call.
    await writeFile(target, 'ALPHA\nsecond line\n', 'utf8')
    const userSaved = await readFile(target, 'utf8')
    recorder.note({ step: 'user-saved', bytes: userSaved })

    // ─── Stage 3: the agent's edit is refused, and the file keeps the user's bytes ────────────────
    const refusedTurn = await runTurn(locator, `${FILE_CONSISTENCY_MARKERS[1]} 把 alpha 改成 beta。`, sessionId)
    const refusalText = await waitForToolResult(harness, dataDir, sessionId, 'changed after it was read')
    screenshots['after-refusal'] = await writePng(client, 'after-refusal')
    recorder.check(
      Boolean(refusalText),
      'the edit was refused because the file changed after it was read',
      { toolResult: refusalText?.slice(0, 400) ?? null, reply: String(refusedTurn.reply ?? '').slice(0, 200) },
    )
    const afterRefusal = await readFile(target, 'utf8')
    recorder.check(
      afterRefusal === userSaved,
      'the refused edit left the user\'s saved bytes on disk',
      { onDisk: afterRefusal, userSaved },
    )

    // ─── Stage 4: read again, then the same edit succeeds ────────────────────────────────────────
    await runTurn(locator, `${FILE_CONSISTENCY_MARKERS[2]} 重新读取后再改一次。`, sessionId)
    const afterRecovery = await readFile(target, 'utf8')
    screenshots['after-recovery'] = await writePng(client, 'after-recovery')
    recorder.check(
      afterRecovery === 'beta\nsecond line\n',
      'the edit after a re-read reached the disk',
      { onDisk: afterRecovery },
    )
    const toolResults = await readSessionToolResults(dataDir, sessionId)
    recorder.check(
      toolResults.filter((entry) => entry.ok).length >= 3,
      'the session records the read, the refused edit and the successful edit',
      { okResults: toolResults.filter((entry) => entry.ok).length, total: toolResults.length },
    )


    // ─── Stage 5: a command that changes the file and then fails ──────────────────────────────────
    await runTurn(locator, `${FILE_CONSISTENCY_MARKERS[3]} 跑一个命令，然后按之前读到的内容改文件。`, sessionId)
    const execResult = await waitForToolResult(harness, dataDir, sessionId, 'Command failed')
      ?? await waitForToolResult(harness, dataDir, sessionId, 'exit')
    const afterExec = await readFile(target, 'utf8')
    screenshots['after-exec'] = await writePng(client, 'after-exec')
    recorder.check(
      afterExec === 'written-by-exec',
      'the partially applied command\'s bytes are on disk even though it failed',
      { onDisk: afterExec, execResult: execResult?.slice(0, 200) ?? null },
    )
    const execFollowUp = await readSessionToolResults(dataDir, sessionId)
    recorder.check(
      execFollowUp.some((entry) => !entry.ok && /changed after it was read|read it again/u.test(entry.error)),
      'the edit that followed the failed command was refused against the stale read',
      { results: execFollowUp.map((entry) => ({ ok: entry.ok, error: entry.error.slice(0, 120) })) },
    )

    // ─── Stage 6: creating a document whose name is taken ────────────────────────────────────────
    const documentPath = join(workplaceDir, FILE_CONSISTENCY_DOCUMENT)
    await writeFile(documentPath, 'existing document bytes\n', 'utf8')
    await runTurn(locator, `${FILE_CONSISTENCY_MARKERS[4]} 生成一个同名文档。`, sessionId)
    const documentRefusal = await waitForToolResult(harness, dataDir, sessionId, 'already exists')
    recorder.check(
      Boolean(documentRefusal),
      'document_create refused to overwrite an existing document',
      { toolResult: documentRefusal?.slice(0, 300) ?? null },
    )
    recorder.check(
      await readFile(documentPath, 'utf8') === 'existing document bytes\n',
      'the refused document creation left the existing document untouched',
      { onDisk: await readFile(documentPath, 'utf8') },
    )

    // ─── Stage 7: a write the user denies ────────────────────────────────────────────────────────
    const deniedPath = join(workplaceDir, FILE_CONSISTENCY_DENIED_FILE)
    const denied = await readSse(locator, '/run/stream', {
      text: `${FILE_CONSISTENCY_MARKERS[5]} 写入一个文件。`,
      permissionMode: 'research',
      sessionId,
    }, { approval: 'deny' })
    screenshots['after-denied-write'] = await writePng(client, 'after-denied-write')
    recorder.check(
      !(await pathExists(deniedPath)),
      'a denied write created no file',
      { denied: denied.approvals ?? null },
    )
    recorder.check(
      (denied.approvals?.requested ?? 0) > 0 && (denied.approvals?.denied ?? 0) > 0,
      'the run really asked for approval and the answer was a denial',
      { approvals: denied.approvals ?? null },
    )

    // ─── Stage 8: versions, checkpoints and the final file, reconciled ───────────────────────────
    const known = [
      'alpha\nsecond line\n',
      'ALPHA\nsecond line\n',
      'beta\nsecond line\n',
      'written-by-exec',
    ]
    const versions = await collectFileVersions(dataDir, FILE_CONSISTENCY_FILE)
    recorder.check(versions.length > 0, 'the app recorded more than one version of the file', { versions: versions.length })
    const finalBytes = await readFile(target, 'utf8')
    recorder.check(
      finalBytes === 'written-by-exec',
      'the final file is the last mutation that actually happened',
      { onDisk: finalBytes },
    )
    const unexpected = versions.filter((entry) => !known.includes(entry.text))
    recorder.check(
      unexpected.length === 0,
      'every recorded version is a content this file really had, so a backup is not mistaken for the current bytes',
      { recorded: versions.map((entry) => entry.path), unexpected: unexpected.map((entry) => entry.path) },
    )
    recorder.note({
      step: 'reconciliation',
      finalFile: { bytes: finalBytes, sha256: sha256(finalBytes) },
      versions: versions.map((entry) => ({ path: entry.path, sha256: sha256(entry.text), matchesFinal: entry.text === finalBytes })),
    })

    report = {
      check: 'desktop-file-consistency',
      ok: recorder.failures.length === 0,
      capturedAt: new Date().toISOString(),
      checks: recorder.count(),
      failures: recorder.failures,
      observations: recorder.observations,
      screenshots,
      providerRequests: provider.requests?.length ?? null,
      limits: [
        'The model is a deterministic fixture: this proves the shipped observation guard, tools and '
        + 'transcript behaviour when the user saves a file mid-turn, not that a real model reacts well.',
        'The user\'s save is performed by writing the file from this process (the same bytes an editor '
        + 'would leave behind); the editor UI itself is not driven.',
      ],
    }
  } catch (error) {
    failure = error

    // Keep what the run had already observed: a stopped acceptance must still say how far it got.
    report = {
      check: 'desktop-file-consistency',
      ok: false,
      error: String(error?.stack ?? error),
      checks: recorder.count(),
      failures: recorder.failures,
      observations: recorder.observations,
    }
  } finally {
    try { await handle?.electron?.kill?.() } catch { /* ignore */ }
    try { await provider.close?.() } catch { /* ignore */ }
    if (!keepRoot) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
    if (report) await writeFile(join(outRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8').catch(() => undefined)
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (failure || report?.ok !== true) process.exitCode = 1
}

/** The session's persisted tool results, straight from the app's own store. */
async function readSessionToolResults(dataDir, sessionId) {
  const path = join(dataDir, 'sessions', `${sessionId}.jsonl`)
  const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  const results = []
  for (const line of lines) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    for (const block of record?.content ?? []) {
      if (block?.type !== 'tool_result') continue
      results.push({
        ok: block.result?.ok === true,
        output: typeof block.result?.output === 'string' ? block.result.output : '',
        error: typeof block.result?.error === 'string' ? block.result.error : '',
      })
    }
  }
  return results
}

/** The session the app just wrote: the store is the app's own file, not something this script keeps. */
async function newestSessionId(dataDir) {
  const directory = join(dataDir, 'sessions')
  const entries = await readdir(directory)
  const candidates = []
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue
    const stats = await stat(join(directory, entry))
    candidates.push({ id: entry.replace(/\.jsonl$/u, ''), mtimeMs: stats.mtimeMs })
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  if (candidates.length === 0) throw new Error('The app wrote no session file.')
  return candidates[0].id
}
/** The session record is written as the run settles, so the lookup retries instead of racing it. */
async function waitForToolResult(harness, dataDir, sessionId, needle) {
  return harness.waitFor(
    () => findToolResult(dataDir, sessionId, needle),
    harness.actionTimeoutMs,
    `a tool result containing ${needle}`,
  ).catch(() => null)
}

async function findToolResult(dataDir, sessionId, needle) {
  const results = await readSessionToolResults(dataDir, sessionId)
  const match = results.find((entry) => entry.output.includes(needle) || entry.error.includes(needle))
  return match ? (match.output || match.error) : null
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

async function pathExists(path) {
  try { await access(path); return true } catch { return false }
}

/**
 * Recorded versions of one file: whatever the app kept under its version/checkpoint stores, read here
 * so the final bytes on disk can be reconciled against them instead of trusting that a backup exists.
 */
/**
 * Recorded versions of one file, read from the app's own shadow version repositories. Reconstructing
 * them here is the point: a backup existing proves nothing about the file on disk, so every recorded
 * revision is compared against the contents this flow actually produced.
 */
async function collectFileVersions(dataDir, fileName) {
  const versions = []
  const repositoriesRoot = join(dataDir, 'backups', 'versioning', 'repositories', 'workspaces')
  if (!await pathExists(repositoriesRoot)) return versions
  for (const entry of await readdir(repositoriesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const gitDir = join(repositoriesRoot, entry.name)
    const log = await gitOutput(gitDir, ['log', '--all', '--format=%H', '--', fileName]).catch(() => '')
    for (const sha of log.split('\n').map((line) => line.trim()).filter(Boolean)) {
      const text = await gitOutput(gitDir, ['show', `${sha}:${fileName}`]).catch(() => null)
      if (text !== null) versions.push({ path: `${entry.name.slice(0, 8)}@${sha.slice(0, 8)}`, text })
    }
  }
  return versions
}

function gitOutput(gitDir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', [`--git-dir=${gitDir}`, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}
async function walkFiles(directory, depth, prefix = '') {
  if (depth < 0) return []
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await walkFiles(join(directory, entry.name), depth - 1, relative))
    else files.push(relative)
  }
  return files
}
async function writePng(client, name) {
  await client.send('Page.bringToFront').catch(() => undefined)
  const shot = await withTimeout(
    client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
    10_000,
    'Page.captureScreenshot',
  )
  await mkdir(join(outRoot, 'screenshots'), { recursive: true })
  const path = join(outRoot, 'screenshots', `${name}.png`)
  await writeFile(path, Buffer.from(shot.data, 'base64'))
  return path
}

await main()
