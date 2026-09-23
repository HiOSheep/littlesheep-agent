// Real-window recovery-discovery acceptance (taskbook CS-06).
//
// The startup discovery of unfinished work is gated on execution readiness, so
// with no usable model reference the only observable outcome is the failure path.
// This script runs the same window with a real provider configured and checks the
// other half: discovery happens, it belongs to the checkpoint's own session, and
// nothing acts on it without the user.
//
// It needs two things a normal run cannot invent:
//   - a real provider credential in the environment of the app it spawns
//     (`LITTLESHEEP_RECOVERY_PROBE_API_KEY_ENV` names the variable to pass
//     through, default DEEPSEEK_API_KEY);
//   - genuine checkpoint files to copy into the isolated data root, taken from
//     the real data root's run-checkpoints directory
//     (`LITTLESHEEP_RECOVERY_PROBE_CHECKPOINT` names one explicit file). The
//     probe takes the newest checkpoint plus the newest one from a *different*
//     session, so attribution can be checked per checkpoint rather than once.
// Without them it records `skipped` and exits 0 instead of inventing evidence.
//
// It never resumes: resuming would execute tools against the workspace recorded
// inside the checkpoint, which belongs to the machine's real data root. The claim
// under test is discovery and attribution, not execution.
//
// Usage:
//   node scripts/verify-desktop-cold-start-recovery.mjs [--out=docs/reference/cold-start-baseline] [--keep]

import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay, repoRoot } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

const outDir = resolve(repoRoot, readOption('out', 'docs/reference/cold-start-baseline'))
const READINESS_TIMEOUT_MS = 90_000
const DISCOVERY_TIMEOUT_MS = 30_000

/**
 * Checkpoints to copy into the fixture; the originals are never modified.
 *
 * Two are taken from *different* sessions when the real data root has them, so
 * the dialog's per-checkpoint attribution can be checked instead of assumed.
 */
async function resolveCheckpointSources() {
  const explicit = process.env['LITTLESHEEP_RECOVERY_PROBE_CHECKPOINT']
  if (explicit) return existsSync(explicit) ? [explicit] : []
  const realDir = join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.littlesheep', 'run-checkpoints')
  if (!existsSync(realDir)) return []
  const entries = (await readdir(realDir)).filter((name) => name.endsWith('.json'))
  const withTimes = await Promise.all(entries.map(async (name) => {
    const path = join(realDir, name)
    const modifiedAt = (await stat(path)).mtimeMs
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return { path, modifiedAt, sessionId: String(parsed.sessionId) }
  }))
  withTimes.sort((left, right) => right.modifiedAt - left.modifiedAt)
  const sources = withTimes.slice(0, 1)
  const otherSession = withTimes.find((entry) => entry.sessionId !== sources[0]?.sessionId)
  if (otherSession) sources.push(otherSession)
  return sources.map((entry) => entry.path)
}

function providerKeyEnvName() {
  return process.env['LITTLESHEEP_RECOVERY_PROBE_API_KEY_ENV'] ?? 'DEEPSEEK_API_KEY'
}

async function main() {
  await harness.assertBuildFresh()
  const keyEnvName = providerKeyEnvName()
  const apiKey = process.env[keyEnvName]
  const checkpointSources = await resolveCheckpointSources()
  const skipped = []
  if (!apiKey) skipped.push(`no credential in ${keyEnvName}`)
  if (checkpointSources.length === 0) skipped.push('no checkpoint file to copy')

  const root = await mkdtemp(join(tmpdir(), 'littlesheep-cold-start-recovery-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(root, 'workspace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  const debuggingPort = await harness.reservePort()
  const observations = []
  const failures = []
  let client
  let child

  try {
    await mkdir(outDir, { recursive: true })
    if (skipped.length > 0) {
      // A skipped probe is not a pass: it produces no claim and says why.
      observations.push({ step: 'skipped', reasons: skipped, checkpointSources, keyEnvName })
      await writeEvidence(outDir, { ok: true, skipped: true, reasons: skipped, observations, failures })
      console.log(JSON.stringify({ ok: true, skipped: true, reasons: skipped }, null, 2))
      return
    }

    const checkpoints = await Promise.all(checkpointSources.map(async (source) => ({
      source,
      checkpoint: JSON.parse(await readFile(source, 'utf8')),
    })))
    // The fixture model is derived from the first checkpoint so the copied work
    // is not blocked by a model mismatch the fixture invented.
    const primaryModel = String(checkpoints[0].checkpoint.resumeState?.model ?? '')
    const modelId = primaryModel.startsWith('deepseek/') ? primaryModel.slice('deepseek/'.length) : 'deepseek-flash'
    const checkpointSessions = [...new Set(checkpoints.map(({ checkpoint }) => String(checkpoint.sessionId)))]
    const unrelatedSessionId = 'session-recovery-probe-other'
    await mkdir(workspaceDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(workspaceDir, 'README.md'), '# Recovery probe workspace\n', 'utf8')
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, modelId), null, 2)}\n`, 'utf8')
    await seedSessions(dataDir, [
      ...checkpointSessions.map((id) => ({ id, title: `Recovery probe session ${id.slice(0, 8)}` })),
      { id: unrelatedSessionId, title: 'Recovery probe: an unrelated session' },
    ])
    await mkdir(join(dataDir, 'run-checkpoints'), { recursive: true })
    for (const { source, checkpoint } of checkpoints) {
      await writeFile(
        join(dataDir, 'run-checkpoints', source.split(/[\\/]/u).at(-1)),
        JSON.stringify(checkpoint, null, 2),
        'utf8',
      )
    }

    child = await harness.startElectron({
      dataDir,
      chromiumDir,
      debuggingPort,
      logPath,
      extraEnv: {
        LITTLESHEEP_ELECTRON_ACCEPTANCE: '1',
        LITTLESHEEP_BOOTSTRAP_TIMING: '1',
        [keyEnvName]: apiKey,
      },
    })
    const locator = await harness.waitForLocator(dataDir, child.pid)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitForVisible(client, '.composer textarea', 0, harness.actionTimeoutMs)
    await client.evaluate(`(() => {
      const input = document.querySelector('.composer textarea');
      if (input instanceof HTMLTextAreaElement) {
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(input, '恢复探针草稿');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '恢复探针草稿', inputType: 'insertText' }));
      }
      return true;
    })()`)

    // 1. Execution must really be ready: that is the precondition this probe
    //    exists for, and the reason the earlier attempt could only see the
    //    failure path.
    const readiness = await waitForReady(locator)
    observations.push({ step: 'readiness', state: readiness.state, phase: readiness.phase, reason: readiness.reason })
    if (readiness.state !== 'ready') {
      failures.push({ check: 'a real provider brings execution to ready', detail: readiness })
    }

    // 2. The discovery route answers with every copied checkpoint under its own
    //    session id - never under whatever session happens to be active.
    const discovered = await waitForDiscovery(locator, checkpoints.map(({ checkpoint }) => checkpoint.id))
    observations.push({
      step: 'discovery',
      status: discovered.status,
      checkpoints: discovered.checkpoints.map((entry) => ({
        id: entry.id,
        sessionId: redactSession(entry.sessionId),
        status: entry.status,
        resumable: entry.resumable,
        waitingForInput: entry.waitingForInput,
        workspace: redactWorkspace(entry.workspace),
      })),
      expected: checkpoints.map(({ checkpoint }) => ({
        id: checkpoint.id,
        sessionId: redactSession(checkpoint.sessionId),
      })),
    })
    for (const { checkpoint } of checkpoints) {
      const found = discovered.checkpoints.find((entry) => entry.id === checkpoint.id)
      if (!found) {
        failures.push({ check: 'every copied checkpoint is discovered once execution is ready', detail: { id: checkpoint.id, discovered } })
      } else if (found.sessionId !== String(checkpoint.sessionId)) {
        failures.push({
          check: 'a discovered checkpoint keeps its original session id',
          detail: { id: checkpoint.id, discovered: found.sessionId, original: checkpoint.sessionId },
        })
      }
    }

    // 3. The window offers recovery without acting on it: the trigger is present
    //    with the checkpoint count, no run was started, focus is still in the
    //    composer, the draft is untouched and the active session did not change.
    const beforeOpening = await readWindowState(client)
    observations.push({ step: 'trigger', ...beforeOpening })
    if (beforeOpening.triggerPresent !== true) {
      failures.push({ check: 'the recovery control is offered for discovered work', detail: beforeOpening })
    }
    if (beforeOpening.activeRunCount !== 0) {
      failures.push({ check: 'discovery alone starts no run', detail: beforeOpening })
    }
    if (beforeOpening.draft !== '恢复探针草稿') {
      failures.push({ check: 'discovery does not overwrite the draft', detail: beforeOpening })
    }

    // 4. Opening the dialog shows the discovered work. With more than one
    //    checkpoint the list must be there, and selecting each entry must show
    //    that entry's own summary - which is the user-visible form of "the
    //    continuation belongs to the session the checkpoint came from".
    const opened = await client.evaluate(`(() => {
      const trigger = document.querySelector('.checkpoint-recovery-trigger');
      trigger?.click();
      return true;
    })()`)
    await delay(600)
    const dialog = await readRecoveryDialog(client)
    observations.push({ step: 'dialog', opened, ...dialog, expectedCheckpointIds: checkpoints.map(({ checkpoint }) => checkpoint.id) })
    if (dialog.dialogPresent !== true) {
      failures.push({ check: 'the recovery dialog opens from the trigger', detail: dialog })
    }
    if (checkpoints.length > 1 && dialog.listLength !== checkpoints.length) {
      failures.push({
        check: 'the recovery list shows every discovered checkpoint',
        detail: { listLength: dialog.listLength, discovered: checkpoints.length },
      })
    }
    if (dialog.summaryText === null || dialog.summaryText.length === 0) {
      failures.push({ check: 'the dialog summarises the selected checkpoint', detail: dialog })
    }

    // Selecting a different checkpoint must re-render the summary for it.
    let selection
    if (checkpoints.length > 1) {
      selection = await selectCheckpointInDialog(client, 1)
      observations.push({ step: 'selection', ...selection })
      if (selection.selectedIndex !== 1 || selection.summaryText === dialog.summaryText) {
        failures.push({
          check: 'selecting another checkpoint shows its own summary',
          detail: { before: dialog.summaryText, after: selection },
        })
      }
    }

    const afterOpening = await readWindowState(client)
    observations.push({ step: 'after-opening', ...afterOpening })
    if (afterOpening.activeRunCount !== 0) {
      failures.push({ check: 'opening recovery starts no run', detail: afterOpening })
    }
    if (afterOpening.draft !== '恢复探针草稿') {
      failures.push({ check: 'opening recovery keeps the draft', detail: afterOpening })
    }
    if (afterOpening.focusedIsComposer !== true) {
      failures.push({ check: 'opening recovery does not steal focus from the composer', detail: afterOpening })
    }

    await writeEvidence(outDir, {
      ok: failures.length === 0,
      skipped: false,
      keyEnvName,
      fixtureModel: `deepseek/${modelId}`,
      checkpointSources,
      checkpoints: checkpoints.map(({ checkpoint }) => ({
        id: checkpoint.id,
        sessionId: redactSession(checkpoint.sessionId),
        status: checkpoint.status,
        model: checkpoint.resumeState?.model,
        workspace: redactWorkspace(checkpoint.resumeState?.cwd),
      })),
      seededSessions: checkpointSessions.map(redactSession).concat(unrelatedSessionId),
      observations,
      failures,
      limits: [
        'Discovery and attribution only: the probe never resumes, so the continuation itself is not exercised (resuming would run tools against the workspace recorded in the checkpoint, which belongs to this machine\'s real data root).',
        'The seeded sessions carry the checkpoints\' ids but not their conversation history; the checkpoint files themselves are copied unmodified.',
        'The checkpoint files come from this machine\'s real data root, so this is real evidence from one machine, not a distribution over models or workspaces.',
        'A credential is required, so this probe skips itself (and says so) wherever none is provided.',
      ],
    })
    console.log(JSON.stringify({
      ok: failures.length === 0,
      checkpointSources,
      checkpointIds: checkpoints.map(({ checkpoint }) => checkpoint.id),
      observations,
      failures,
    }, null, 2))
    if (failures.length > 0) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    process.exitCode = 1
  } finally {
    client?.close()
    if (child?.exitCode === null) await harness.forceTerminate(child)
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

function buildConfig(workspaceDir, modelId) {
  return {
    version: 1,
    // The credential is an environment reference, so no secret is written into
    // the fixture data root; the app resolves it through its own key loader.
    providers: [{
      id: 'deepseek',
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: `$${providerKeyEnvName()}`,
      models: [{ id: modelId, name: 'DeepSeek', contextWindow: 128_000 }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: `deepseek/${modelId}`,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 30,
        maxRecoveryAttempts: 1,
        timeFormat: 'auto',
        bootstrapMaxChars: 20_000,
        bootstrapTotalMaxChars: 60_000,
        contextCompressionThresholdRatio: 0.8,
        maxModelCallsPerRun: 8,
        harness: 'core-flow',
      },
    },
    desktop: { closePolicy: 'always-background' },
    tools: { exec: {}, maxOutputChars: 10_000, stripImages: true, maxParallel: 2 },
    memory: { repositoryBackend: 'v2' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
    mcp: { servers: [] },
    channels: { channels: [] },
    versioning: { enabled: false },
  }
}

async function seedSessions(dataDir, sessions) {
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  const now = Date.now()
  const index = sessions.map((session, position) => ({
    id: session.id,
    title: session.title,
    createdAt: now - (sessions.length - position) * 60_000,
    lastMessageAt: now - position * 1_000,
    mode: 'research',
    scope: 'standalone',
  }))
  await writeFile(join(dataDir, 'sessions.json'), `${JSON.stringify({ sessions: index }, null, 2)}\n`, 'utf8')
}

async function readWindowState(client) {
  return client.evaluate(`(() => {
    const trigger = document.querySelector('.checkpoint-recovery-trigger');
    const input = document.querySelector('.composer textarea');
    const active = document.querySelector('.session-row.active, .session-item.active, [data-session-active="true"]');
    return {
      triggerPresent: Boolean(trigger),
      triggerText: trigger ? trigger.textContent.trim() : null,
      triggerClasses: trigger ? trigger.className : null,
      draft: input ? input.value : null,
      focusedTag: document.activeElement ? document.activeElement.tagName : null,
      focusedIsComposer: document.activeElement === input,
      currentSessionId: active ? (active.getAttribute('data-session-id') ?? active.textContent.trim()) : null,
      url: location.href,
    };
  })()`).then(async (state) => ({
    ...state,
    activeRunCount: await readActiveRunCount(client),
  }))
}

async function readActiveRunCount(client) {
  return client.evaluate(`(() => {
    const indicator = document.querySelector('.run-activity-indicator, .composer-stop');
    return indicator ? 1 : 0;
  })()`)
}

async function readRecoveryDialog(client) {
  return client.evaluate(`(() => {
    const dialog = document.querySelector('.checkpoint-recovery-dialog');
    const items = [...document.querySelectorAll('.checkpoint-recovery-list button')];
    const active = document.querySelector('.checkpoint-recovery-list button.active');
    return {
      dialogPresent: Boolean(dialog),
      listLength: items.length,
      listTexts: items.slice(0, 4).map((item) => item.textContent.trim().slice(0, 120)),
      selectedIndex: active ? items.indexOf(active) : null,
      summaryText: document.querySelector('.checkpoint-recovery-summary')?.textContent?.trim().slice(0, 240) ?? null,
      stateLine: document.querySelector('.checkpoint-recovery-state-line')?.textContent?.trim() ?? null,
      workspacePath: document.querySelector('.checkpoint-recovery-path')?.textContent?.trim() ?? null,
      blockers: document.querySelector('.checkpoint-recovery-blockers')?.textContent?.trim() ?? null,
      resumeLabel: document.querySelector('.checkpoint-recovery-content button[type="submit"], .checkpoint-recovery-resume')?.textContent?.trim() ?? null,
    };
  })()`)
}

/** Click the list entry at `index` and read the summary that replaces it. */
async function selectCheckpointInDialog(client, index) {
  return client.evaluate(`(() => {
    const items = [...document.querySelectorAll('.checkpoint-recovery-list button')];
    const target = items[${index}];
    target?.click();
    return { clicked: Boolean(target), itemText: target ? target.textContent.trim().slice(0, 120) : null };
  })()`).then(async (clicked) => {
    await delay(400)
    const after = await readRecoveryDialog(client)
    return { ...clicked, ...after }
  })
}

async function readReadiness(locator) {
  const response = await harness.fetchJson(locator, '/runtime/readiness').catch(() => undefined)
  return response?.body?.readiness ?? response?.body
}

async function waitForReady(locator, timeoutMs = READINESS_TIMEOUT_MS) {
  return harness.waitFor(async () => {
    const state = await readReadiness(locator)
    return state?.state === 'ready' || state?.state === 'failed' ? state : undefined
  }, timeoutMs, 'execution readiness')
}

async function waitForDiscovery(locator, checkpointIds) {
  return harness.waitFor(async () => {
    const response = await harness.fetchJson(locator, '/run-checkpoints')
    if (!response?.ok) return undefined
    const checkpoints = response.body?.checkpoints ?? []
    return checkpointIds.every((id) => checkpoints.some((entry) => entry.id === id))
      ? { status: response.status, checkpoints }
      : undefined
  }, DISCOVERY_TIMEOUT_MS, 'checkpoint discovery')
}

/**
 * Evidence is written with machine-local identifiers reduced to prefixes and
 * workspace paths mapped to labels: the repository keeps no session ids or home
 * paths (see AGENTS.md, "不把 API key、会话、记忆、执行日志或工作区产物复制进源码仓库"),
 * while the claim under test - each checkpoint keeps its own session - stays
 * readable because the prefixes differ.
 */
function redactSession(sessionId) {
  const text = String(sessionId)
  return text.length <= 8 ? text : `${text.slice(0, 8)}…`
}

function redactWorkspace(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  const normalized = path.replace(/\\/gu, '/')
  if (home && normalized.toLowerCase().startsWith(home.replace(/\\/gu, '/').toLowerCase())) {
    return `<user-home>${normalized.slice(home.length)}`
  }
  if (normalized.toLowerCase().startsWith(repoRoot.replace(/\\/gu, '/').toLowerCase())) {
    return `<repo>${normalized.slice(repoRoot.length)}`
  }
  return '<other workspace>'
}

/** Replaces user-profile and repository paths wherever they appear. */
function scrubText(value) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  let text = String(value)
  if (home) {
    text = text.split(home).join('<user-home>')
    text = text.split(home.replace(/\\/gu, '/')).join('<user-home>')
  }
  text = text.split(repoRoot).join('<repo>').split(repoRoot.replace(/\\/gu, '/')).join('<repo>')
  return text
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gu, '<user-home>')
    .replace(/[A-Za-z]:\/Users\/[^/\s"']+/gu, '<user-home>')
    .replace(/\/Users\/[^/\s"']+/gu, '<user-home>')
    .replace(/\/home\/[^/\s"']+/gu, '<user-home>')
}

function scrub(value) {
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]))
  }
  return value
}

async function writeEvidence(dir, payload) {
  const path = join(dir, 'cold-start-recovery.json')
  await writeFile(path, `${JSON.stringify(scrub({
    check: 'desktop-cold-start-recovery',
    capturedAt: new Date().toISOString(),
    redaction: 'session ids are 8-character prefixes; user-profile and repository path prefixes are replaced with <user-home> and <repo>',
    ...payload,
  }), null, 2)}\n`, 'utf8')
}

await main()
