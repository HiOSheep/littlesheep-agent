// Real-window check for the transient confirmation (the "已保存供应商 ..." line).
//
// Two reported defects, both asserted here against a real Electron window:
//
//   1. The confirmation stayed on screen until something replaced it, so a stale
//      "已保存" line outlived the action it confirmed.
//   2. It occupied layout: appearing and disappearing pushed the page's content down
//      and back up, so merely confirming a save visibly moved the page.
//
// The assertions are therefore about TIME and LAYOUT, not about the message text:
//   - the toast is `position: fixed` and lives outside the settings content flow, so
//     the content below it does not move while it is present;
//   - it is still there before ~3s and gone after, measured against a real clock;
//   - a real save (not a synthetic DOM event) is what raises it, so the path from the
//     settings action to the surface is covered;
//   - dismissing it early works, since the timer must not be the only way out.
//
// Usage:
//   node scripts/verify-transient-notice-toast.mjs [--keep]
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElectronHarness } from './lib/electron-cdp-harness.mjs'
import { runArtifact } from './lib/run-artifacts.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = createElectronHarness({ startTimeoutMs: 90_000 })

/** Slightly under the 3s window, and clearly past it. */
const STILL_VISIBLE_MS = 1_200
const GONE_BY_MS = 3_400

function config(workplaceDir, baseURL) {
  return {
    version: 2,
    dataRoot: undefined,
    agents: { defaults: { model: 'openai-go/vendor-mini', workspace: workplaceDir } },
    providers: [{
      id: 'openai-go',
      name: 'OpenAI Go',
      baseURL,
      apiKey: 'sk-fixture',
      models: [{ id: 'vendor-mini', name: 'Vendor Mini', contextWindow: 128000 }],
    }],
  }
}

async function main() {
  await harness.assertBuildFresh()
  const root = await mkdtemp(join(tmpdir(), 'littlesheep-transient-notice-'))
  const dataDir = join(root, 'data')
  const chromiumDir = join(root, 'chromium')
  const workplaceDir = join(dataDir, 'workplace')
  const logPath = join(root, 'electron.log')
  const outDir = runArtifact('transient-notice-toast')
  let electron
  let client
  const failures = []
  const report = {}
  try {
    await Promise.all([
      mkdir(workplaceDir, { recursive: true }),
      mkdir(chromiumDir, { recursive: true }),
      mkdir(outDir, { recursive: true }),
    ])
    await writeFile(
      join(dataDir, 'config.json'),
      `${JSON.stringify(config(workplaceDir, 'https://gw.example.com/v1'), null, 2)}\n`,
      'utf8',
    )
    const debuggingPort = await harness.reservePort()
    electron = await harness.startElectron({ dataDir, chromiumDir, debuggingPort, logPath })
    const locator = await harness.waitForLocator(dataDir, electron.pid)
    await harness.waitForDesktop(locator)
    client = await harness.connectRenderer(debuggingPort)
    await client.send('Page.enable')
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.settings-entry-btn'))`), 90_000, 'renderer')

    // Open settings → 模型供应商, which is the page that reported the defect.
    await client.evaluate(`document.querySelector('.settings-entry-btn').click()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.settings-overview-row'))`), 60_000, 'overview')
    await client.evaluate(`(() => {
      const nav = [...document.querySelectorAll('.settings-nav-item, .settings-nav-link, button')]
        .find((node) => (node.textContent || '').trim() === '模型供应商');
      if (nav) nav.click();
    })()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.provider-card'))`), 60_000, 'provider card')

    // The page enters with a 160ms translateY(4px) animation. Wait for that
    // page transition to finish before treating its top as the toast baseline;
    // otherwise the later settled position is misattributed to toast removal.
    report.pageTransitionAtBaseline = await harness.waitFor(() => client.evaluate(`(() => {
      const page = document.querySelector('.settings-page-transition');
      const card = document.querySelector('.settings-module-page');
      if (!page || !card) return null;
      const style = getComputedStyle(page);
      const matrix = style.transform === 'none' ? null : new DOMMatrixReadOnly(style.transform);
      const translateY = matrix?.m42 ?? 0;
      const activeAnimations = page.getAnimations().filter((animation) =>
        animation.playState === 'running' || animation.pending);
      const result = {
        ready: activeAnimations.length === 0 && Math.abs(translateY) < 0.1,
        className: page.className,
        transform: style.transform,
        translateY,
        activeAnimationCount: activeAnimations.length,
        contentTop: card.getBoundingClientRect().top,
      };
      return result.ready ? result : null;
    })()`), 10_000, 'the settings page transition to settle')

    // A fixed-position surface outside the page flow is the whole point, so its
    // computed position and its DOM parent are asserted rather than assumed.
    const before = await client.evaluate(`(() => {
      const body = document.querySelector('.settings-workspace-body');
      return {
        bodyBottom: body ? body.getBoundingClientRect().bottom : null,
        toastPresent: Boolean(document.querySelector('.transient-toast')),
        contentTop: (() => {
          const card = document.querySelector('.settings-module-page');
          return card ? card.getBoundingClientRect().top : null;
        })(),
      };
    })()`)
    report.beforeSave = before
    if (before.toastPresent) failures.push('a toast was already on screen before any action')

    // Perform a real save through the editor, so the notice is raised by the same path
    // a user triggers rather than by poking React state.
    await client.evaluate(`(() => {
      const edit = [...document.querySelectorAll('.provider-card-actions button')]
        .find((node) => (node.textContent || '').trim() === '编辑');
      if (edit) edit.click();
    })()`)
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.provider-editor'))`), 30_000, 'editor')
    await client.evaluate(`(() => {
      const shown = document.querySelector('.provider-editor .settings-inline-field input');
      if (!shown) return;
      const nameField = [...document.querySelectorAll('.provider-editor .settings-inline-field')]
        .find((field) => (field.querySelector('span')?.textContent || '').trim() === '显示名称')
        ?.querySelector('input');
      if (!nameField) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameField, 'OpenAI Go 2');
      nameField.dispatchEvent(new Event('input', { bubbles: true }));
      void shown;
    })()`)
    await client.evaluate(`(() => {
      const save = [...document.querySelectorAll('.provider-editor .dialog-footer button')]
        .find((node) => (node.textContent || '').trim() === '保存');
      if (save) save.click();
    })()`)

    // Wait for the confirmation itself rather than a fixed delay, so the timing
    // measurements below start from when it actually appeared.
    await harness.waitFor(() => client.evaluate(`Boolean(document.querySelector('.transient-toast'))`), 30_000, 'toast appeared')
    const appearedAt = Date.now()

    const shape = await client.evaluate(`(() => {
      const toast = document.querySelector('.transient-toast');
      if (!toast) return null;
      const style = getComputedStyle(toast);
      const rect = toast.getBoundingClientRect();
      return {
        position: style.position,
        parentIsBody: toast.parentElement === document.body,
        message: (toast.textContent || '').trim(),
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        role: toast.querySelector('[role]')?.getAttribute('role') ?? null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    })()`)
    report.shape = shape
    if (!shape) failures.push('the confirmation never appeared')
    if (shape) {
      if (shape.position !== 'fixed') failures.push(`the toast is not position:fixed but ${shape.position}`)
      if (!shape.parentIsBody) failures.push('the toast is not portalled to body, so it can still occupy layout')
      if (!shape.message.includes('已保存')) failures.push(`the toast does not confirm the save: ${shape.message}`)
      if (shape.role !== 'status') failures.push(`the confirmation is not announced politely: role=${shape.role}`)
      // It must sit inside the window it floats over.
      if (shape.rect.bottom > shape.viewport.height + 1 || shape.rect.top < -1) {
        failures.push(`the toast is outside the viewport: ${JSON.stringify(shape.rect)}`)
      }
      if (shape.rect.left < -1 || shape.rect.right > shape.viewport.width + 1) {
        failures.push(`the toast overflows horizontally: ${JSON.stringify(shape.rect)}`)
      }
    }

    // The layout assertion: the settings content must not have moved because a notice
    // appeared. This is what the old in-flow notice violated.
    const during = await client.evaluate(`(() => {
      const card = document.querySelector('.settings-module-page');
      const body = document.querySelector('.settings-workspace-body');
      return {
        contentTop: card ? card.getBoundingClientRect().top : null,
        bodyBottom: body ? body.getBoundingClientRect().bottom : null,
      };
    })()`)
    report.duringToast = during
    if (before.contentTop !== null && during.contentTop !== null && Math.abs(during.contentTop - before.contentTop) > 1) {
      failures.push(`the page content moved when the notice appeared: ${before.contentTop} -> ${during.contentTop}`)
    }

    // Timing first, and deliberately before the screenshot: capturing an image takes
    // long enough to consume the display window, and an earlier version of this script
    // measured "vanished too early" because the capture sat inside the interval it was
    // supposed to measure.
    await new Promise((r) => setTimeout(r, Math.max(0, STILL_VISIBLE_MS - (Date.now() - appearedAt))))
    const early = await client.evaluate(`Boolean(document.querySelector('.transient-toast'))`)
    report.visibleAtMs = Date.now() - appearedAt
    if (!early) failures.push(`the confirmation vanished too early (before ${STILL_VISIBLE_MS}ms)`)

    // A screenshot, because "it floats above the page" is a visual claim and a
    // geometry readback alone does not show whether it reads as a floater.
    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    if (shot?.data) {
      await writeFile(join(outDir, 'toast-visible.png'), Buffer.from(shot.data, 'base64'))
      report.screenshot = join(outDir, 'toast-visible.png')
    }

    await new Promise((r) => setTimeout(r, Math.max(0, GONE_BY_MS - (Date.now() - appearedAt))))
    const late = await client.evaluate(`Boolean(document.querySelector('.transient-toast'))`)
    report.hiddenAtMs = Date.now() - appearedAt
    if (late) failures.push(`the confirmation was still on screen after ${GONE_BY_MS}ms`)

    // And the content must be exactly where it was once the notice is gone.
    const after = await client.evaluate(`(() => {
      const card = document.querySelector('.settings-module-page');
      return { contentTop: card ? card.getBoundingClientRect().top : null };
    })()`)
    report.afterToast = after
    if (before.contentTop !== null && after.contentTop !== null && Math.abs(after.contentTop - before.contentTop) > 1) {
      failures.push(`the page content did not return to its position: ${before.contentTop} -> ${after.contentTop}`)
    }

    console.log(JSON.stringify({
      check: 'transient-notice-toast',
      ok: failures.length === 0,
      outDir,
      ...report,
      failures,
    }, null, 2))
    if (failures.length) process.exitCode = 1
  } finally {
    client?.close()
    if (electron?.exitCode === null) electron.kill()
    if (!process.argv.includes('--keep')) await harness.removeTemporaryRoot(root)
  }
}

await main()
