import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDocument, extractDocument } from '../packages/documents/dist/index.js'
import {
  createIsolatedDeepSeekEnvironment,
  forceTerminate,
  repoRoot,
  startElectron,
  waitForDesktop,
  waitForLocator,
} from './lib/electron-deepseek-acceptance.mjs'

const controlDir = join(repoRoot, '.codex_tmp', 'continuity-p0-e2e')
const manifestPath = join(controlDir, 'live-environment.json')
const fixtureName = 'p0-conversation-continuity-source.pdf'
const model = 'deepseek-v4-flash'

let environment
let electron
let logFile

try {
  await mkdir(controlDir, { recursive: true })
  environment = await createIsolatedDeepSeekEnvironment({
    prefix: 'littlesheep-conversation-continuity-p0-',
    model,
    closePolicy: 'always-quit',
    maxModelCallsPerRun: 20,
    runTimeoutSeconds: 600,
    toolInvocationTimeoutMs: 180_000,
  })

  const fixturePath = join(environment.workplaceDir, fixtureName)
  await createDocument({
    filePath: fixturePath,
    format: 'pdf',
    title: 'LittleSheep Continuity Brief',
    subtitle: 'P0 acceptance fixture - English source',
    blocks: [
      {
        type: 'paragraph',
        text: 'OpenAI and DeepSeek are proper nouns. A TaskBook records the active goal, completed steps, and verification evidence.',
      },
      {
        type: 'heading',
        level: 2,
        text: 'Release rule',
      },
      {
        type: 'paragraph',
        text: 'Verify the translated PDF before declaring the conversation continuous. A resumed task must preserve its Checkpoint and must not repeat completed side effects.',
      },
      {
        type: 'table',
        headerRows: 1,
        rows: [
          ['Object', 'Requirement'],
          ['Checkpoint', 'Resume the original task'],
          ['Attachment', 'Verify cache identity and digest'],
          ['Final PDF', 'Open, read, and render every page'],
        ],
      },
    ],
  })
  const fixture = await extractDocument(fixturePath)
  if (fixture.metadata.pageCount !== 1 || !fixture.text.includes('LittleSheep Continuity Brief')) {
    throw new Error('P0 acceptance fixture failed its structural self-check')
  }

  const fixtureBytes = await readFile(fixturePath)
  const logPath = join(environment.root, 'electron.log')
  logFile = await open(logPath, 'a')
  electron = startElectron({
    dataDir: environment.dataDir,
    chromiumDir: environment.chromiumDir,
    stdio: ['ignore', logFile.fd, logFile.fd],
  })
  const locator = await waitForLocator(environment.dataDir, electron.pid)
  const desktop = await waitForDesktop(locator)

  const manifest = {
    check: 'electron-conversation-task-continuity-p0-prepare',
    preparedAt: new Date().toISOString(),
    root: environment.root,
    dataDir: environment.dataDir,
    chromiumDir: environment.chromiumDir,
    workplaceDir: environment.workplaceDir,
    fixture: {
      path: fixturePath,
      name: fixtureName,
      bytes: fixtureBytes.length,
      sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
      pageCount: fixture.metadata.pageCount,
      expectedTerms: ['LittleSheep', 'OpenAI', 'DeepSeek', 'TaskBook', 'Checkpoint'],
    },
    model,
    electronPid: electron.pid,
    desktop: {
      windowExists: desktop.windowExists,
      windowVisible: desktop.windowVisible,
    },
    logPath,
    locatorPath: join(environment.dataDir, 'runtime', 'local-app-api.json'),
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ ...manifest, manifestPath })}\n`)

  const exit = await new Promise((resolveExit, rejectExit) => {
    electron.once('exit', (code, signal) => resolveExit({ code, signal }))
    electron.once('error', rejectExit)
  })
  process.stdout.write(`${JSON.stringify({ check: 'electron-conversation-task-continuity-p0-exit', ...exit })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    check: 'electron-conversation-task-continuity-p0-prepare',
    ok: false,
    root: environment?.root,
    manifestPath,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  })}\n`)
  process.exitCode = 1
} finally {
  if (process.exitCode && electron?.exitCode === null) await forceTerminate(electron)
  await logFile?.close()
  if (environment && !existsSync(manifestPath)) {
    process.stderr.write(`Isolated evidence root preserved at ${environment.root}\n`)
  }
}
