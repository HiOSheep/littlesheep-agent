// Real-window acceptance for the third answer to closing a dirty workspace file tab
// (settings/workspace/overlay audit, P1 item 9).
//
// The defect this gate pins down: clicking ✕ on a dirty file tab raised the *permission*
// prompt 「允许保存工作区文件？」, whose three answers (拒绝 / 本对话允许 / 仅本次) all speak
// about permission to write. Denying it left the tab open and dirty with nothing said, and
// no surface anywhere offered to give the draft up — the user could save or stay stuck.
//
// What the gate drives and asserts, in one real window against an isolated data root:
//   1. a workspace file is opened, switched to edit mode, typed into, and shows as dirty;
//   2. ✕ raises the unchanged permission prompt (exactly its three answers, no discard
//      action smuggled into the permission dialog);
//   3. 拒绝 keeps the tab open and dirty, writes nothing, and now states the refusal on
//      the tab strip with a visible 放弃修改 action;
//   4. 继续编辑 dismisses that notice without closing anything;
//   5. 放弃修改 closes the tab, drops the draft (reopening the file shows the disk text
//      again, without the typed marker) and still writes nothing;
//   6. the approved path is unchanged: 仅本次 writes the file and closes the tab.
//
// Usage:
//   node scripts/verify-workspace-file-close-discard.mjs [--keep]

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000, actionTimeoutMs: 20_000 })

const WINDOW_SIZE = { width: 1280, height: 840 }
const NOTES_NAME = 'NOTES.txt'
const NOTES_START = 'audit p1 fixture line one\n'
const DISCARD_MARKER = 'discard this draft'
const KEEP_MARKER = 'keep this on disk'
const PROVIDER_ID = 'acceptance-gw'
const MODEL_ID = 'slow-a'
/** The permission prompt is a contract this change must not touch. */
const SAVE_APPROVAL_HEADING = '允许保存工作区文件？'
const PERMISSION_ANSWERS = ['拒绝', '本对话允许', '仅本次']
const DISCARD_ACTION = '放弃修改'
const KEEP_EDITING_ACTION = '继续编辑'

/**
 * Everything this gate decides from. Read in one evaluation so a check never mixes
 * two different renders, and read the notice's real geometry so "visible" is not
 * inferred from the DOM alone.
 */
const SURFACE_EXPRESSION = `(() => {
  const text = (selector) => {
    const node = document.querySelector(selector);
    return node ? (node.textContent || '').trim() : null;
  };
  const tabs = [...document.querySelectorAll('.workspace-active-item')].map((tab) => ({
    label: (tab.querySelector('.workspace-active-label-text')?.textContent || '').trim() || null,
    dirty: tab.classList.contains('file-dirty'),
    active: tab.classList.contains('active'),
    closeLabel: tab.querySelector('.workspace-active-close')?.getAttribute('aria-label') ?? null,
  }));
  const refusalNode = document.querySelector('.workspace-file-close-refusal');
  const refusalBox = refusalNode ? refusalNode.getBoundingClientRect() : null;
  const refusalStyle = refusalNode ? getComputedStyle(refusalNode) : null;
  const approvalNode = document.querySelector('.approval-prompt');
  return {
    tabs,
    tabCount: tabs.length,
    dirtyTabCount: tabs.filter((tab) => tab.dirty).length,
    notesTab: tabs.find((tab) => (tab.label || '').includes(${JSON.stringify(NOTES_NAME)})) ?? null,
    refusal: refusalNode ? {
      message: (refusalNode.querySelector('.workspace-file-close-refusal-message')?.textContent || '').trim(),
      actions: [...refusalNode.querySelectorAll('.workspace-file-close-refusal-action')]
        .map((node) => (node.textContent || '').trim()),
      role: refusalNode.getAttribute('role'),
      tone: refusalNode.getAttribute('data-tone'),
      visible: Boolean(refusalStyle)
        && refusalStyle.display !== 'none'
        && refusalStyle.visibility !== 'hidden'
        && Boolean(refusalBox)
        && refusalBox.width > 0
        && refusalBox.height > 0,
      box: refusalBox ? { width: Math.round(refusalBox.width), height: Math.round(refusalBox.height) } : null,
    } : null,
    approval: approvalNode ? {
      heading: text('.approval-prompt h2'),
      buttons: [...approvalNode.querySelectorAll('.approval-action')].map((node) => (node.textContent || '').trim()),
    } : null,
    editorVisible: Boolean(document.querySelector('.workspace-editor-monaco')),
    editorReadOnly: document.querySelector('.workspace-editor-monaco .monaco-editor')?.classList.contains('workspace-monaco-readonly')
      ?? document.querySelector('textarea.inputarea')?.readOnly
      ?? null,
    editorText: (document.querySelector('.workspace-editor-monaco .view-lines')?.textContent ?? '')
      .replace(/\u00a0/gu, ' ')
      .slice(0, 240),
    textButtons: [...document.querySelectorAll('.workspace-files-text-btn')].map((node) => (node.textContent || '').trim()),
    navigatorNames: [...document.querySelectorAll('.workspace-tree-row.file .workspace-tree-name')]
      .map((node) => (node.textContent || '').trim()),
    composerError: text('.composer-error'),
  };
})()`

function readOption(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((argument) => argument.startsWith(prefix))
  return found === undefined ? fallback : found.slice(prefix.length)
}

function createRecorder() {
  const observations = []
  const assertions = []
  const failures = []
  return {
    note: (entry) => observations.push(entry),
    /** One row per assertion, so the report states every claim separately. */
    check: (condition, check, detail) => {
      const passed = Boolean(condition)
      assertions.push({ assertion: check, passed, detail: detail ?? null })
      if (!passed) failures.push({ check, detail })
      return passed
    },
    assertions,
    failures,
    observations,
  }
}

function buildConfig(workspaceDir, providerBaseURL) {
  return {
    version: 1,
    providers: [{
      id: PROVIDER_ID,
      name: '验收网关',
      baseURL: providerBaseURL,
      apiKey: 'acceptance-key',
      timeoutSeconds: 10,
      models: [{ id: MODEL_ID }],
    }],
    agents: {
      defaults: {
        workspace: workspaceDir,
        model: `${PROVIDER_ID}/${MODEL_ID}`,
        reasoning: 'auto',
        profile: 'general',
        timeoutSeconds: 60,
        maxRecoveryAttempts: 1,
        contextCompressionThresholdRatio: 0.8,
      },
    },
    desktop: { closePolicy: 'always-background' },
    plugins: { disabled: [], extraDirs: [], allowLocalCode: false },
  }
}

/**
 * One file tab plus the review tab, so the file navigator stays available after the
 * file tab closes and the file can be reopened in the same window.
 */
function seedPreferencesExpression(workspaceDir) {
  const filePath = join(workspaceDir, NOTES_NAME)
  const fileTab = `file:${encodeURIComponent(workspaceDir)}|${encodeURIComponent(filePath)}`
  const layout = {
    collapsed: false,
    fullscreen: true,
    activeTab: fileTab,
    openTabs: [fileTab, 'review'],
    openRequest: { root: workspaceDir, path: filePath },
    fileNavigatorCollapsed: false,
    fileNavigatorWidth: 214,
    reviewNavigatorWidth: 214,
    expandedPaths: [],
    drafts: {},
    browserTabs: [],
  }
  const preferences = {
    'littlesheep.ui.workspacePanelCollapsed': 'false',
    'littlesheep.ui.workspacePanelFullscreen': 'true',
    'littlesheep.ui.workspacePanelTab': fileTab,
    'littlesheep.ui.workspacePanelOpenTabs': JSON.stringify([fileTab, 'review']),
    'littlesheep.ui.workspacePanelOpenRoot': workspaceDir,
    'littlesheep.ui.workspacePanelOpenPath': filePath,
    'littlesheep.ui.workspaceFileNavigatorCollapsed': 'false',
    'littlesheep.ui.workspaceSessionLayouts': JSON.stringify({ __draft__: layout }),
  }
  return `(() => {
    const values = ${JSON.stringify(preferences)};
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    return true;
  })()`
}

async function readSurface(client) {
  return client.evaluate(SURFACE_EXPRESSION)
}

async function waitForSurface(client, predicate, timeoutMs, label) {
  return harness.waitFor(async () => {
    const surface = await readSurface(client)
    return predicate(surface) ? surface : undefined
  }, timeoutMs, label)
}

async function click(client, selector) {
  return client.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
}

async function clickByText(client, selector, text) {
  return client.evaluate(`(() => {
    const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((item) => (item.textContent || '').trim() === ${JSON.stringify(text)});
    if (!(node instanceof HTMLElement)) return false;
    node.click();
    return true;
  })()`)
}

/** Press the ✕ of the dirty file tab — never of the review tab next to it. */
async function clickDirtyTabClose(client) {
  return client.evaluate(`(() => {
    const tab = document.querySelector('.workspace-active-item.file-dirty');
    const button = tab ? tab.querySelector('.workspace-active-close') : null;
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`)
}

/** Open a file from the workspace navigator by its visible name. */
async function openFileFromNavigator(client, name) {
  return client.evaluate(`(() => {
    const row = [...document.querySelectorAll('.workspace-tree-row.file')]
      .find((item) => ((item.querySelector('.workspace-tree-name')?.textContent) || '').trim() === ${JSON.stringify(name)});
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`)
}

/**
 * Click into the real Monaco text area. Monaco 0.5x takes input through an
 * `EditContext`, so the gesture that works is a real click followed by text-carrying
 * key events (same recipe as verify-async-feedback).
 */
async function clickEditor(client) {
  const input = await harness.waitFor(async () => {
    const value = await client.evaluate(`(() => {
      const line = document.querySelector('.workspace-editor-monaco .monaco-editor .view-line');
      if (!(line instanceof HTMLElement)) return undefined;
      const box = line.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`)
    return value ?? undefined
  }, 30_000, 'the Monaco text area')
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: input.x, y: input.y, button: 'left', buttons: 1, clickCount: 1,
  })
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: input.x, y: input.y, button: 'left', buttons: 0, clickCount: 1,
  })
  await delay(300)
  return input
}

async function typeIntoEditor(client, text) {
  await clickEditor(client)
  await client.send('Input.insertText', { text })
  // Monaco applies the insertion on its own tick; reading the lines immediately would
  // miss it and the key-event fallback below would type the same text a second time.
  if (await waitForEditorText(client, text, 4_000)) return 'insertText'
  for (const character of text) {
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyDown', text: character, unmodifiedText: character, key: character,
    })
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: character })
    await delay(30)
  }
  return (await waitForEditorText(client, text, 4_000)) ? 'keyEvents' : 'failed'
}

async function waitForEditorText(client, text, timeoutMs) {
  try {
    await harness.waitFor(
      async () => ((await editorHasText(client, text)) ? true : undefined),
      timeoutMs,
      `the editor to show ${JSON.stringify(text)}`,
    )
    return true
  } catch {
    return false
  }
}

async function editorHasText(client, text) {
  const needle = text.replace(/\s+/gu, ' ').trim()
  return client.evaluate(`(() => {
    const content = (document.querySelector('.workspace-editor-monaco .view-lines')?.textContent ?? '')
      .replace(/\\u00a0/gu, ' ');
    return content.includes(${JSON.stringify(needle)});
  })()`)
}

async function switchToEditMode(client) {
  const clicked = await clickByText(client, '.workspace-files-text-btn', '编辑')
  if (!clicked) throw new Error('the file pane has no 编辑 control to switch to edit mode')
  return waitForSurface(client, (surface) => (surface.editorReadOnly === false ? surface : undefined), 15_000, 'the editor to become editable')
}

/** Deny the save approval and wait for the refusal answer the tab strip must now give. */
async function denySaveApproval(client, recorder, step) {
  const approval = await waitForSurface(
    client,
    (surface) => (surface.approval ? surface : undefined),
    20_000,
    'the workspace save approval prompt',
  )
  recorder.note({ step: `${step}-approval`, approval: approval.approval })
  recorder.check(
    approval.approval?.heading === SAVE_APPROVAL_HEADING,
    `${step}: the dirty close raises the save permission prompt`,
    approval.approval,
  )
  recorder.check(
    JSON.stringify(approval.approval?.buttons) === JSON.stringify(PERMISSION_ANSWERS),
    `${step}: the permission prompt keeps exactly its three answers and offers no discard`,
    approval.approval?.buttons,
  )
  await clickByText(client, '.approval-action', '拒绝')
  return waitForSurface(
    client,
    (surface) => (surface.refusal?.visible ? surface : undefined),
    20_000,
    'the refused-close notice on the tab strip',
  )
}

async function main() {
  await harness.assertBuildFresh()
  const keep = process.argv.includes('--keep')
  const recorder = createRecorder()
  const provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 0, streamChunkCharacters: 200 })
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-file-close-discard-'))
  const dataDir = join(root, 'data')
  const workspaceDir = join(dataDir, 'workplace')
  const chromiumDir = join(root, 'chromium')
  const logPath = join(root, 'electron.log')
  let handle
  let diskAfterDiscard = ''
  let evidencePath = null
  try {
    await Promise.all([mkdir(workspaceDir, { recursive: true }), mkdir(chromiumDir, { recursive: true })])
    const notesPath = join(workspaceDir, NOTES_NAME)
    await writeFile(notesPath, NOTES_START, 'utf8')
    await writeFile(join(dataDir, 'config.json'), `${JSON.stringify(buildConfig(workspaceDir, provider.baseURL), null, 2)}\n`, 'utf8')

    const debuggingPort = await harness.reservePort()
    const electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    await harness.desktopAction(locator, 'resize', WINDOW_SIZE)
    const client = await harness.connectRenderer(debuggingPort)
    await client.send('Runtime.enable')
    await client.send('Page.enable')
    await harness.waitFor(
      () => client.evaluate(`document.querySelector('.composer textarea') instanceof HTMLTextAreaElement || null`),
      harness.startTimeoutMs,
      'composer textarea',
    )
    handle = { electron, locator, client }
    // The layout seed belongs in the pre-document script: a seed applied to the running
    // document can be overwritten by the app's own persistence flush while the page unloads.
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: seedPreferencesExpression(workspaceDir) })
    await client.evaluate(seedPreferencesExpression(workspaceDir))
    const previousTimeOrigin = await client.evaluate('performance.timeOrigin')
    await client.send('Page.reload', { ignoreCache: false })
    await harness.waitFor(async () => {
      const state = await client.evaluate(`(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin }))()`)
        .catch(() => undefined)
      return state && state.readyState === 'complete' && state.timeOrigin !== previousTimeOrigin ? true : undefined
    }, harness.actionTimeoutMs, 'renderer reload with the fixture layout')

    // --- 1. a dirty file tab in the real editor ---------------------------------
    const opened = await waitForSurface(
      client,
      (surface) => (surface.editorVisible && surface.editorReadOnly === true ? surface : undefined),
      30_000,
      'the seeded file tab to open read-only',
    )
    recorder.note({ step: 'file-opened', tabs: opened.tabs, editorReadOnly: opened.editorReadOnly, textButtons: opened.textButtons })
    recorder.check(
      opened.tabCount === 2 && Boolean(opened.notesTab),
      'the fixture opens with the file tab and the review tab',
      opened.tabs,
    )
    await switchToEditMode(client)
    const typingMode = await typeIntoEditor(client, DISCARD_MARKER)
    const dirty = await waitForSurface(
      client,
      (surface) => (surface.dirtyTabCount === 1 && surface.editorText.includes(DISCARD_MARKER) ? surface : undefined),
      20_000,
      'the file tab to become dirty',
    )
    const diskBefore = await readFile(notesPath, 'utf8')
    recorder.note({
      step: 'file-dirty',
      typingMode,
      tabs: dirty.tabs,
      editorText: dirty.editorText,
      disk: diskBefore,
    })
    recorder.check(dirty.notesTab?.dirty === true, 'the typed text marks the file tab dirty', dirty.notesTab)
    recorder.check(diskBefore === NOTES_START, 'an unsaved draft has not touched the disk yet', { disk: diskBefore })

    // --- 2. ✕ → permission prompt → 拒绝 keeps the tab and now says so -----------
    await clickDirtyTabClose(client)
    const refused = await denySaveApproval(client, recorder, 'close-denied')
    recorder.note({ step: 'close-denied', refusal: refused.refusal, tabs: refused.tabs, composerError: refused.composerError })
    recorder.check(
      refused.tabCount === 2 && refused.notesTab?.dirty === true,
      'denying the save keeps the dirty file tab open',
      { tabs: refused.tabs },
    )
    recorder.check(
      refused.refusal?.visible === true
        && refused.refusal.actions.includes(DISCARD_ACTION)
        && refused.refusal.actions.includes(KEEP_EDITING_ACTION),
      'the refusal is visible and offers a discard action',
      refused.refusal,
    )
    recorder.check(
      (refused.refusal?.message ?? '').includes(NOTES_NAME)
        && (refused.refusal?.message ?? '').includes('未保存的修改还在'),
      'the refusal names the file and states that the draft is still unsaved',
      { message: refused.refusal?.message },
    )
    recorder.check(
      refused.refusal?.role === 'status' && refused.refusal?.tone === 'warning',
      'the refusal uses the shared notice role and tone instead of prose the gate would parse',
      { role: refused.refusal?.role, tone: refused.refusal?.tone },
    )
    const diskAfterDeny = await readFile(notesPath, 'utf8')
    recorder.check(diskAfterDeny === NOTES_START, 'a denied approval writes nothing to disk', { disk: diskAfterDeny })
    recorder.check(
      refused.composerError === null,
      'the refusal stays in the workspace instead of the chat area',
      { composerError: refused.composerError },
    )

    // --- 3. 继续编辑 dismisses the answer without closing anything --------------
    await clickByText(client, '.workspace-file-close-refusal-action', KEEP_EDITING_ACTION)
    const keptEditing = await waitForSurface(
      client,
      (surface) => (surface.refusal === null ? surface : undefined),
      15_000,
      'the refusal notice to be dismissed',
    )
    recorder.note({ step: 'keep-editing', tabs: keptEditing.tabs, editorText: keptEditing.editorText })
    recorder.check(
      keptEditing.tabCount === 2 && keptEditing.notesTab?.dirty === true,
      '继续编辑 dismisses the notice and keeps the dirty tab open',
      { tabs: keptEditing.tabs },
    )
    recorder.check(
      (await readFile(notesPath, 'utf8')) === NOTES_START && keptEditing.editorText.includes(DISCARD_MARKER),
      'dismissing the notice keeps the draft and writes nothing',
      { editorText: keptEditing.editorText },
    )

    // --- 4. the answer is repeatable, then 放弃修改 closes and discards ----------
    await clickDirtyTabClose(client)
    const refusedAgain = await denySaveApproval(client, recorder, 'close-denied-again')
    recorder.check(
      refusedAgain.refusal?.visible === true && refusedAgain.refusal.actions.includes(DISCARD_ACTION),
      'a repeated refused close offers the discard answer again',
      refusedAgain.refusal,
    )
    await clickByText(client, '.workspace-file-close-refusal-action', DISCARD_ACTION)
    const discarded = await waitForSurface(
      client,
      (surface) => (surface.notesTab === null && surface.refusal === null ? surface : undefined),
      20_000,
      'the discarded file tab to close',
    )
    diskAfterDiscard = await readFile(notesPath, 'utf8')
    recorder.note({ step: 'discarded', tabs: discarded.tabs, disk: diskAfterDiscard })
    recorder.check(
      discarded.tabCount === 1 && discarded.dirtyTabCount === 0,
      '放弃修改 closes the tab instead of trapping the user',
      { tabs: discarded.tabs },
    )
    recorder.check(diskAfterDiscard === NOTES_START, '放弃修改 writes nothing to disk', { disk: diskAfterDiscard })

    // --- 5. the draft is really gone, not saved ---------------------------------
    const reopened = await openFileFromNavigator(client, NOTES_NAME)
    recorder.check(reopened === true, 'the reopened file is reachable from the navigator', { navigatorNames: discarded.navigatorNames })
    const reopenedSurface = await waitForSurface(
      client,
      // Wait for the discarded text to be *gone*: a stale Monaco model from the closed
      // tab also satisfies "shows the disk line", so only its absence proves the point.
      (surface) => (surface.editorVisible && !surface.editorText.includes(DISCARD_MARKER) ? surface : undefined),
      30_000,
      'the reopened file to show the disk version',
    )
    recorder.note({ step: 'reopened', editorText: reopenedSurface.editorText, tabs: reopenedSurface.tabs })
    recorder.check(
      !reopenedSurface.editorText.includes(DISCARD_MARKER)
        && reopenedSurface.editorText.includes('audit p1 fixture line one'),
      'reopening the file proves the discarded draft was dropped, not saved',
      { editorText: reopenedSurface.editorText, disk: diskAfterDiscard },
    )
    recorder.check(
      reopenedSurface.dirtyTabCount === 0,
      'the reopened file starts clean',
      { tabs: reopenedSurface.tabs },
    )

    // --- 6. the approved path still writes and closes ---------------------------
    await switchToEditMode(client)
    const secondTypingMode = await typeIntoEditor(client, KEEP_MARKER)
    await waitForSurface(
      client,
      (surface) => (surface.dirtyTabCount === 1 && surface.editorText.includes(KEEP_MARKER) ? surface : undefined),
      20_000,
      'the reopened file to become dirty',
    )
    await clickDirtyTabClose(client)
    const approval = await waitForSurface(
      client,
      (surface) => (surface.approval ? surface : undefined),
      20_000,
      'the save approval for the approved path',
    )
    recorder.note({ step: 'approved-approval', typingMode: secondTypingMode, approval: approval.approval })
    recorder.check(
      approval.approval?.heading === SAVE_APPROVAL_HEADING
        && JSON.stringify(approval.approval?.buttons) === JSON.stringify(PERMISSION_ANSWERS),
      'the approved path still asks the unchanged permission question',
      approval.approval,
    )
    await click(client, '.approval-action.primary')
    const approved = await waitForSurface(
      client,
      (surface) => (surface.notesTab === null ? surface : undefined),
      20_000,
      'the tab to close after the approved save',
    )
    const diskAfterApproval = await harness.waitFor(async () => {
      const content = await readFile(notesPath, 'utf8').catch(() => '')
      return content.includes(KEEP_MARKER) ? content : undefined
    }, 20_000, 'the approved save to reach the disk')
    recorder.note({ step: 'approved-close', tabs: approved.tabs, disk: diskAfterApproval })
    recorder.check(
      approved.tabCount === 1 && approved.dirtyTabCount === 0,
      '仅本次 closes the tab exactly as before',
      { tabs: approved.tabs },
    )
    recorder.check(
      diskAfterApproval.includes(KEEP_MARKER) && diskAfterApproval !== NOTES_START,
      '仅本次 writes the draft and closes — the approved path is unchanged',
      { disk: diskAfterApproval },
    )
  } catch (error) {
    recorder.check(false, 'the walkthrough completed without an unexpected failure', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : null,
    })
  } finally {
    handle?.client?.close()
    if (handle?.electron?.exitCode === null) await harness.forceTerminate(handle.electron)
    await provider.close().catch(() => undefined)
    if (!keep) await harness.removeTemporaryRoot(root)
  }

  const evidence = {
    check: 'workspace-file-close-discard',
    capturedAt: new Date().toISOString(),
    fixtureRoot: keep ? root : '<temporary root removed>',
    diskAfterDiscard,
    ok: recorder.failures.length === 0,
    assertions: recorder.assertions,
    observations: recorder.observations,
    failures: recorder.failures,
    limits: [
      'The window is driven over the debug protocol and stays off screen; "visible" is measured as a laid-out box with a non-hidden computed style, not as pixels on a monitor.',
      'The gate drives the real Monaco editor through CDP (click + text insertion), so a non-editable pane would fail loudly instead of passing quietly.',
      'Only the workspace-file save approval is exercised; the permission prompt itself is asserted to keep its three answers, and its behaviour for other actions is untouched.',
    ],
  }
  const directory = runArtifact('workspace-file-close-discard')
  await mkdir(directory, { recursive: true })
  evidencePath = join(directory, 'evidence.json')
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ ...evidence, evidencePath, option: readOption('keep', keep) }, null, 2))
  if (!evidence.ok) process.exitCode = 1
}

await main()
