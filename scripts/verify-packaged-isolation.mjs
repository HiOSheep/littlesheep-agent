// Packaged-product isolation acceptance for the Windows release (taskbook SL-04).
//
// The plain-language question this gate answers: *does what we ship actually work when nothing
// from the checkout is available to it?* Every other desktop gate drives `packages/app` through
// the development Electron and resolves dependencies from the repository's `node_modules`. This
// one only ever starts the unpacked release produced by `pnpm run package:win` (see
// `scripts/lib/release-artifacts.mjs` for where that is) against a data root under the OS temp
// area, so the answer cannot come from the checkout by accident.
//
// It checks the four capabilities that depend on files the bundler keeps *outside* `out`:
//
//   1. execution readiness — the Runner published inside the packaged main process;
//   2. node-pty terminal   — a real session runs a command that writes a marker file, and the
//                            session reports the `pty` backend rather than the `spawn` fallback;
//   3. documents           — PDF, Word and spreadsheet create-then-read through the document
//                            runtime that lives inside `app.asar`, with the packaged executable
//                            used as a plain Node process (`ELECTRON_RUN_AS_NODE`);
//   4. local embedding     — the fixed BGE model is provisioned on first use into the isolated
//                            data root, then loaded from disk twice with remote models disabled.
//
// Usage:
//   node scripts/verify-packaged-isolation.mjs [--data-root=<dir>] [--skip-embedding-provision] [--keep]
//
// `--data-root` reuses a prepared data root instead of a fresh temporary one — the way to check the
// embedding half when the model host is unreachable from this machine (see the gate's own `limits`).
// `--skip-embedding-provision` reports the embedding step as not attempted instead of downloading
// ~24.5 MB from the model host; it is for offline re-runs, not for calling the step verified.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { packagedExecutablePath, packagedResourcesPath, releaseRoot } from './lib/release-artifacts.mjs'
import { runArtifactsRoot } from './lib/run-artifacts.mjs'

const EMBEDDING_MARKER = '打包隔离验收：本地向量模型复用。'
const TERMINAL_MARKER_TEXT = 'packaged-node-pty-ok'
const MODEL_ID = 'bge-small-zh-v1.5'
const MODEL_REVISION = '75c43b069aac4d136ba6bc1122f995fedcfd2781'
const MODEL_REPOSITORY = 'Xenova/bge-small-zh-v1.5'
const READINESS_TIMEOUT_MS = 90_000
const PROVISION_TIMEOUT_MS = 15 * 60_000

function readOption(name) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? undefined : found.slice(prefix.length)
}

const skipEmbeddingProvision = process.argv.includes('--skip-embedding-provision')
const keepRoot = process.argv.includes('--keep')
const providedDataRoot = readOption('data-root')

const executable = packagedExecutablePath()
const resourcesRoot = packagedResourcesPath()
const harness = createElectronHarness({
  startTimeoutMs: 90_000,
  actionTimeoutMs: 30_000,
  packagedExecutable: executable,
})

const checks = []
function record(ok, name, detail) {
  checks.push({ ok, name, detail })
  console.log(`[packaged-isolation] ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

async function main() {
  if (!existsSync(executable)) {
    throw new Error(`The packaged executable is missing: ${executable}. Run \`pnpm run package:win\` first.`)
  }
  if (!existsSync(join(resourcesRoot, 'app.asar'))) {
    throw new Error(`The packaged app.asar is missing under ${resourcesRoot}.`)
  }

  // Scratch goes to the shared run-artefacts root (`scripts/lib/run-artifacts.mjs`, default
  // `<os temp>/littlesheep-run-artifacts/`), never into the checkout: the data root, the Chromium
  // profile, the Electron log and the generated helper scripts all live under it.
  await mkdir(runArtifactsRoot, { recursive: true })
  const scratchRoot = providedDataRoot === undefined
    ? await mkdtemp(join(runArtifactsRoot, 'packaged-isolation-'))
    : resolve(providedDataRoot)
  const root = scratchRoot
  const dataDir = providedDataRoot === undefined ? join(root, 'data') : root
  const workplaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const terminalMarker = join(root, 'terminal-marker.txt')
  let electron
  let locator
  const ledger = {
    check: 'packaged-isolation',
    releaseRoot,
    packagedExecutable: executable,
    dataRoot: dataDir,
    reusedDataRoot: providedDataRoot !== undefined,
    dataRootInsideCheckout: dataDir.toLowerCase().includes('repositories\\littlesheep'),
    scratchOutsideCheckout: !root.toLowerCase().includes('repositories\\littlesheep'),
    terminal: null,
    documents: null,
    embedding: null,
  }

  try {
    await mkdir(workplaceDir, { recursive: true })
    await mkdir(chromiumDir, { recursive: true })

    // --- 1. readiness ------------------------------------------------------------------------
    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      // No provider is configured: readiness must not depend on one, and the checks below use the
      // packaged artifact's own runtime rather than a model.
      extraEnv: { DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined },
    })
    locator = await harness.waitForLocator(dataDir, electron.pid)
    ledger.locator = { host: locator.host, port: locator.port }
    await harness.waitForDesktop(locator)

    const readiness = await harness.waitFor(async () => {
      const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
      if (!response?.ok) return undefined
      return response.body?.state === 'starting' ? undefined : response.body
    }, READINESS_TIMEOUT_MS, 'execution readiness')
    record(readiness.state === 'ready', 'execution readiness reached', {
      state: readiness.state,
      phase: readiness.phase,
      reason: readiness.reason ?? null,
    })
    ledger.readiness = readiness

    // --- 2. node-pty terminal ----------------------------------------------------------------
    const shells = await harness.fetchJson(locator, '/workspace/terminal/shells')
    const shellProfiles = shells.body?.shells ?? []
    record(shells.ok && Array.isArray(shellProfiles), 'terminal Shell discovery answered', {
      count: Array.isArray(shellProfiles) ? shellProfiles.length : null,
    })

    const created = await harness.fetchJson(locator, '/workspace/terminal/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: workplaceDir, cols: 120, rows: 30 }),
    })
    const session = created.body
    record(created.ok && typeof session?.sessionId === 'string', 'terminal session created', {
      status: created.status,
      sessionId: session?.sessionId ?? null,
      shell: session?.shell ?? null,
      backend: session?.backend ?? null,
      cwd: session?.cwd ?? null,
    })
    if (typeof session?.sessionId === 'string') {
      const inputPath = `/workspace/terminal/session/${encodeURIComponent(session.sessionId)}/input`
      // PowerShell's own cmdlet: the discovered default Shell on this platform is a PowerShell PTY,
      // and `Set-Content` does not depend on how the redirect parses. The shell that answered is
      // recorded in the ledger, so a different default shell shows up as a named failure rather
      // than as a silent pass.
      const command = `Set-Content -LiteralPath '${terminalMarker.replaceAll("'", "''")}' -Value '${TERMINAL_MARKER_TEXT}'`
      let markerText
      let accepted = 0
      for (let attempt = 0; attempt < 3 && markerText === undefined; attempt += 1) {
        // The PTY is created before the shell has finished starting, so the first attempt also
        // serves as the wait; a retry covers a shell that was still initialising.
        await harness.delay(attempt === 0 ? 3_000 : 2_000)
        const written = await harness.fetchJson(locator, inputPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: `${command}\r` }),
        })
        if (written.ok) accepted += 1
        markerText = await harness.waitFor(async () => {
          const content = await readFile(terminalMarker, 'utf8').catch(() => undefined)
          return content?.includes(TERMINAL_MARKER_TEXT) ? content : undefined
        }, 15_000, 'terminal marker file').catch(() => undefined)
      }
      record(accepted > 0, 'terminal accepted the command', { acceptedAttempts: accepted })
      record(markerText !== undefined, 'terminal command ran on the machine', {
        marker: terminalMarker,
        content: markerText ?? null,
      })
      ledger.terminal = {
        shell: session.shell,
        backend: session.backend,
        cwd: session.cwd,
        markerWritten: markerText !== undefined,
      }
      await harness.fetchJson(locator, `/workspace/terminal/session/${encodeURIComponent(session.sessionId)}`, {
        method: 'DELETE',
      }).catch(() => undefined)
    }

    // --- 3. documents inside the packaged artifact -------------------------------------------
    const documentScript = join(root, 'packaged-documents.cjs')
    await writeFile(documentScript, documentsHelperSource(root), 'utf8')
    const documents = await runPackagedNode(documentScript)
    record(documents?.ok === true, 'PDF / Word / spreadsheet create+read inside the package', documents)
    ledger.documents = documents

    // --- 4. local embedding ------------------------------------------------------------------
    if (skipEmbeddingProvision) {
      const status = await harness.fetchJson(locator, '/memory/tree/embedding-model')
      record(false, 'local embedding (not attempted: --skip-embedding-provision)', { status: status.body })
      ledger.embedding = { attempted: false, reason: '--skip-embedding-provision' }
    } else {
      const embedding = await runEmbeddingCheck(locator, root, dataDir)
      record(embedding.ok === true, 'local embedding provisioned once and reused from disk', embedding.summary)
      ledger.embedding = embedding
    }
  } finally {
    if (electron) {
      await harness.forceTerminate(electron).catch(() => undefined)
      await harness.waitForExit(electron, 20_000).catch(() => undefined)
    }
    if (keepRoot || providedDataRoot !== undefined) {
      console.log(`[packaged-isolation] kept ${root}`)
    } else {
      await harness.removeTemporaryRoot(root).catch(() => undefined)
    }
  }

  const ok = checks.every((check) => check.ok)
  console.log(JSON.stringify({
    ...ledger,
    ok,
    checks,
    limits: [
      'The packaged app is started with an isolated data root; it does not prove behaviour against a pre-existing user data root or an upgrade from an older one.',
      'The document check runs the packaged executable as a plain Node process and requires the bundled document runtime chunk from `app.asar`. That is the same code the packaged main process loads, but it bypasses the Agent tool layer that normally calls it.',
      'The terminal check records which Shell answered; the command it sends is PowerShell syntax, because that is the default Shell this platform discovers.',
      'The embedding check reports whether the model was already in the data root or requested from the model host. Node\'s `fetch` cannot reach the model host from some networks (see `--data-root`), and a failed download is reported as a failed step, not as "verified".',
      'Rendering of Monaco, Mermaid and the HTML preview is not asserted here; `verify-html-preview-baseline --app=packaged` covers the preview surfaces against the same packaged artifact.',
    ],
  }, null, 2))
  if (!ok) process.exitCode = 1
}

/** Start the packaged executable as a plain Node process, so the check cannot borrow the checkout. */
function runPackagedNode(scriptPath, extraEnv = {}, timeoutMs = 300_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, [scriptPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolvePromise({ ok: false, error: `packaged Node run timed out after ${timeoutMs}ms`, stderr: tail(stderr) })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, error: error.message })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      const line = stdout.split(/\r?\n/u).reverse().find((entry) => entry.trim().startsWith('{'))
      if (code !== 0 || line === undefined) {
        resolvePromise({ ok: false, exitCode: code, stderr: tail(stderr), stdout: tail(stdout) })
        return
      }
      try {
        resolvePromise(JSON.parse(line))
      } catch (error) {
        resolvePromise({ ok: false, error: error.message, stdout: tail(stdout) })
      }
    })
  })
}

function tail(value, limit = 2_000) {
  return typeof value === 'string' ? value.slice(-limit) : value
}

/**
 * The document runtime has no HTTP route — documents are reached from the main process — so the
 * packaged executable is started as Node and the *bundled* chunk inside `app.asar` is required.
 * That is the same code the packaged main process loads; nothing here resolves from the checkout.
 */
function documentsHelperSource(root) {
  return `'use strict'
const { readdirSync, readFileSync } = require('node:fs')
const { rm } = require('node:fs/promises')
const { join } = require('node:path')

const chunksDir = ${JSON.stringify(join(resourcesRoot, 'app.asar', 'out', 'main', 'chunks'))}

async function main() {
  const runtime = findDocumentRuntime()
  const pdf = join(${JSON.stringify(root)}, 'packaged.pdf')
  const docx = join(${JSON.stringify(root)}, 'packaged.docx')
  const xlsx = join(${JSON.stringify(root)}, 'packaged.xlsx')

  await runtime.createDocument({
    filePath: pdf,
    format: 'pdf',
    title: '打包 PDF',
    blocks: [{ type: 'paragraph', text: '打包后的主进程可以生成并重新读取中文 PDF。' }],
  })
  await runtime.createDocument({
    filePath: docx,
    format: 'docx',
    title: '打包 Word',
    blocks: [{ type: 'paragraph', text: '打包后的 Word 正文提取正常。' }],
  })
  await runtime.createDocument({
    filePath: xlsx,
    format: 'xlsx',
    sheets: [{ name: '模型', rows: [['单价', '数量', '合计'], [12.5, 4, { formula: 'A2*B2', value: 50 }]] }],
  })

  const pdfRead = await runtime.extractDocument(pdf)
  const docxRead = await runtime.extractDocument(docx)
  const xlsxRead = await runtime.extractDocument(xlsx)
  const pdfText = /打包后的主进程可以生成并重新读取中文 PDF/u.test(pdfRead.text)
  const docxText = /打包后的 Word 正文提取正常/u.test(docxRead.text)
  const gridText = /12\\.5\\t4\\t50/u.test(xlsxRead.text)
  const result = {
    ok: pdfText && Number(pdfRead.metadata?.pageCount) === 1 && docxText && gridText,
    documentRuntime: runtime.__chunk,
    formats: {
      pdf: { bytes: readFileSync(pdf).length, pageCount: pdfRead.metadata?.pageCount ?? null, textMatched: pdfText },
      docx: { bytes: readFileSync(docx).length, textMatched: docxText },
      xlsx: { bytes: readFileSync(xlsx).length, gridMatched: gridText },
    },
  }
  await Promise.all([rm(pdf, { force: true }), rm(docx, { force: true }), rm(xlsx, { force: true })])
  console.log(JSON.stringify(result))
}

function findDocumentRuntime() {
  for (const name of readdirSync(chunksDir)) {
    if (!name.endsWith('.js')) continue
    const path = join(chunksDir, name)
    const source = readFileSync(path, 'utf8')
    if (source.includes('exports.createDocument = createDocument;')
      && source.includes('exports.extractDocument = extractDocument;')) {
      const loaded = require(path)
      loaded.__chunk = name
      return loaded
    }
  }
  throw new Error('no bundled document runtime chunk found in ' + chunksDir)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
`
}

/** Provision the model through the product's own route, then load it from disk twice. */
async function runEmbeddingCheck(locator, root, dataDir) {
  const before = await harness.fetchJson(locator, '/memory/tree/embedding-model')
  const started = await harness.fetchJson(locator, '/memory/tree/embedding-model', { method: 'POST' })
  const provisioning = {
    // 'missing' means this run asked the product to download it; 'ready' means the data root
    // already carried verified files and the POST was a no-op.
    stateBeforeStart: before.body?.state ?? null,
    statusAfterStart: started.status,
    modelSource: before.body?.state === 'ready' ? 'already present in the data root' : 'requested from the model host',
  }
  record(started.status === 202 || started.ok, 'embedding model preparation answered', provisioning)

  const final = await harness.waitFor(async () => {
    const status = await harness.fetchJson(locator, '/memory/tree/embedding-model')
    if (!status.ok) return undefined
    if (status.body?.state === 'preparing') return undefined
    return status.body
  }, PROVISION_TIMEOUT_MS, 'embedding model preparation').catch((error) => ({ state: 'timeout', error: error.message }))
  record(final.state === 'ready', 'embedding model provisioned into the isolated data root', {
    state: final.state,
    ...(final.error === undefined ? {} : { error: final.error }),
  })

  // `localModelPath` is the *revision root* (`localEmbeddingModelRoot` in
  // `packages/embedding/src/model-assets.ts`); transformers appends the repository id itself.
  const revisionRoot = join(dataDir, 'models', 'embedding', MODEL_ID, MODEL_REVISION)
  const modelRoot = join(revisionRoot, ...MODEL_REPOSITORY.split('/'))
  const modelBytes = await directoryBytes(modelRoot)
  record(modelBytes > 0, 'model files are on disk under the isolated data root', { modelRoot, bytes: modelBytes })

  const scriptPath = join(root, 'packaged-embedding.cjs')
  await writeFile(scriptPath, embeddingHelperSource(revisionRoot), 'utf8')
  const first = await runPackagedNode(scriptPath, {}, 600_000)
  const second = await runPackagedNode(scriptPath, { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }, 600_000)

  const offlineDisabledRemote = second?.remoteModelsAllowed === false
  const sameVector = JSON.stringify(first?.sample) === JSON.stringify(second?.sample)
  return {
    ok: first?.ok === true && second?.ok === true && offlineDisabledRemote && sameVector,
    summary: {
      modelRoot,
      modelBytes,
      dimensions: first?.dimensions ?? null,
      firstVectorSample: first?.sample ?? null,
      secondVectorSample: second?.sample ?? null,
      sameVector,
      remoteModelsAllowed: second?.remoteModelsAllowed ?? null,
      offlineEnv: second?.offlineEnv ?? null,
    },
    provisioning,
  }
}

async function directoryBytes(dir) {
  let total = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) total += (await stat(full)).size
    }
  }
  await walk(dir)
  return total
}

/**
 * Loads the model through the same configuration the product uses
 * (`packages/embedding/src/local-transformers-engine.ts`): remote models disabled, filesystem
 * cache off, `localModelPath` pointing into the isolated data root.
 *
 * The module is resolved with the packaged app's *own* entry as the base, so `onnxruntime-common`
 * and `onnxruntime-node` are found through the archive exactly as the main process finds them.
 * Importing the physical `app.asar.unpacked/...` file directly would resolve its dependencies from
 * an unpacked directory that legitimately does not contain them.
 */
function embeddingHelperSource(revisionRoot) {
  const appEntry = join(resourcesRoot, 'app.asar', 'out', 'main', 'index.js')
  return `'use strict'
const { createRequire } = require('node:module')

async function main() {
  const appRequire = createRequire(${JSON.stringify(appEntry)})
  const runtime = appRequire('@huggingface/transformers')
  runtime.env.localModelPath = ${JSON.stringify(`${revisionRoot}/`)}
  runtime.env.allowLocalModels = true
  runtime.env.allowRemoteModels = false
  runtime.env.useFSCache = false
  const extractor = await runtime.pipeline('feature-extraction', ${JSON.stringify(MODEL_REPOSITORY)}, {
    dtype: 'q8',
    revision: ${JSON.stringify(MODEL_REVISION)},
  })
  const output = await extractor([${JSON.stringify(EMBEDDING_MARKER)}], { pooling: 'mean', normalize: true })
  const rows = typeof output.tolist === 'function' ? output.tolist() : output
  const vector = Array.isArray(rows[0]) ? rows[0] : rows
  await extractor.dispose?.()
  const sample = vector.slice(0, 4).map((value) => Number(value.toFixed(6)))
  const finite = vector.every((value) => Number.isFinite(value))
  console.log(JSON.stringify({
    ok: finite && vector.length > 0,
    dimensions: vector.length,
    sample,
    resolvedEntry: ${JSON.stringify(appEntry)},
    remoteModelsAllowed: runtime.env.allowRemoteModels,
    offlineEnv: process.env.HF_HUB_OFFLINE ?? null,
  }))
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
`
}

await main()
