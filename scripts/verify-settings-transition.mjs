// Verify settings enter/return timing and interruption in an isolated Electron profile.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness()
await harness.assertBuildFresh()
const root = await mkdtemp(join(tmpdir(), 'ls-settings-transition-'))
const dataDir = join(root, 'data')
await mkdir(join(dataDir, 'workplace'), { recursive: true })
// A valid model reference is required: an empty one fails execution readiness, and the
// resulting window-wide failure strip covers the settings rail's toolbar. The pointer exit
// below is a real hit-tested click, so the fixture must not leave a banner over the control
// it is measuring. No run is started here, so the provider never has to be reachable.
await writeFile(join(dataDir, 'config.json'), JSON.stringify({
  version: 1,
  providers: [{
    id: 'acceptance', name: 'Electron Acceptance', baseURL: 'http://127.0.0.1:9',
    apiKey: 'acceptance-key', models: ['unused-model'],
  }],
  agents: {
    defaults: {
      workspace: join(dataDir, 'workplace'),
      model: 'acceptance/unused-model',
      harness: 'core-flow',
    },
  },
}))
const port = await harness.reservePort()
const child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort: port, logPath: join(root, 'electron.log') })
let client
const checks = []
async function capture(name) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, name + '.png'), Buffer.from(data, 'base64'))
}
async function pressKey(key, shift = false) {
  const code = key === ' ' ? 'Space' : key
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code,
    windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : undefined,
    nativeVirtualKeyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : undefined,
    modifiers: shift ? 8 : 0,
    ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}),
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code,
    windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : undefined,
    nativeVirtualKeyCode: key === 'Enter' ? 13 : key === 'Tab' ? 9 : undefined,
    modifiers: shift ? 8 : 0,
  })
  await delay(150)
}
async function clickWithMouse(selector) {
  const point = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)})
    if (!(element instanceof HTMLElement)) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  assert(point, `missing mouse target ${selector}`)
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
}
async function measure(selector, duration = 500) {
  return client.evaluate(`(async () => {
    const frames=[], start=performance.now();
    const sample=()=>{
      const normal=document.querySelector('.primary-workspace .sidebar-surface');
      const text=document.querySelector('.primary-workspace .sidebar-contents');
      const rail=document.querySelector('.settings-sidebar-track');
      const nav=document.querySelector('.settings-sidebar-contents');
      const body=document.querySelector('.settings-workspace-body');
      const layer=document.querySelector('.settings-presence');
      const style=el=>el?getComputedStyle(el):null;
      const n=style(normal),t=style(text),r=style(rail),v=style(nav),b=style(body);
      frames.push({ms:performance.now()-start,normal:n?.display==='none'?0:Number(t?.opacity??0),
        settings:Number(r?.opacity??0)*Number(v?.opacity??0),body:Number(b?.opacity??0),
        width:rail?.getBoundingClientRect().width??normal?.getBoundingClientRect().width??0,hidden:layer?.classList.contains('presence-hidden'),
        inert:layer?.hasAttribute('inert'),returning:document.querySelector('.window-shell').classList.contains('settings-returning')});
    };
    document.querySelector(${JSON.stringify(selector)}).click();
    while(performance.now()-start<${duration}){await new Promise(requestAnimationFrame);sample()}
    return frames;
  })()`)
}
try {
  const locator = await harness.waitForLocator(dataDir, child.pid)
  await harness.desktopAction(locator, 'resize', { width: 1280, height: 900 })
  await harness.desktopAction(locator, 'show')
  client = await harness.connectRenderer(port)
  await client.send('Page.bringToFront')
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await harness.waitFor(() => client.evaluate('!!document.querySelector(".settings-entry-btn")'), 30000)
  await client.evaluate(`window.__settingsComposer=document.querySelector('.composer textarea');window.__settingsComposer.focus()`)
  await client.send('Input.insertText', { text: '设置切换后保留的草稿' })
  // Cold entry deliberately bypasses pointer prefetch; warm entry is measured separately.
  const cold = await measure('.settings-entry-btn')
  assert(cold.some(frame => frame.body > 0 && frame.body < 1), 'first lazy visit must fade too')
  assert(cold.every(frame => Math.max(frame.normal, frame.settings) > .9), 'cold entry must never leave the rail without labels')
  assert(cold.every(frame => !(frame.normal > .12 && frame.settings > .12)), 'cold entry must not stack the two rails')
  await harness.waitFor(() => client.evaluate('!!document.querySelector(".settings-sidebar-exit")'), 10000)
  await capture('settings-open')
  const returned = await measure('.settings-sidebar-exit')
  assert(returned.some(frame => frame.normal > .1 && frame.ms < 170), 'return text must not wait half a second')
  assert(returned.some(frame => frame.hidden && !frame.returning && frame.ms < 350), 'return must finish promptly')
  assert(returned.filter(frame => frame.ms < 180).every(frame => frame.inert), 'closing controls must not receive clicks')
  assert(returned.every(frame => !(frame.normal > .12 && frame.settings > .12)), 'sidebar labels must not stack')
  const warm = await measure('.settings-entry-btn')
  assert(warm.some(frame => frame.body > 0 && frame.body < 1), 'body must fade instead of jump')
  // The rail itself swaps discretely: the ordinary rail's labels and the settings
  // rail's labels are handed over in one style update. Measured 2026-10-15: an
  // entry fade on `.settings-sidebar-contents` painted three frames of an empty
  // rail and took 140ms to read as settings — the reported flicker.
  assert(warm.every(frame => Math.max(frame.normal, frame.settings) > .9), 'warm entry must never leave the rail without labels')
  assert(warm.every(frame => !(frame.normal > .12 && frame.settings > .12)), 'warm entry must not stack the two rails')
  assert(warm.every(frame => Math.abs(frame.width - warm.at(-1).width) < 1), 'sidebar width must stay fixed')
  // Reverse the transition twice before its completion; stale exit callbacks must be cancelled.
  await client.evaluate('document.querySelector(".settings-entry-btn").click()'); await delay(60)
  await client.evaluate('document.querySelector(".settings-entry-btn").click()'); await delay(60)
  await client.evaluate('document.querySelector(".settings-entry-btn").click()'); await delay(60)
  await client.evaluate('document.querySelector(".settings-entry-btn").click()'); await delay(320)
  assert(await client.evaluate('document.querySelector(".window-shell").classList.contains("settings-open") && document.querySelector(".settings-presence").classList.contains("presence-open") && !document.querySelector(".settings-presence").hasAttribute("inert")'))
  await client.evaluate(`document.querySelector('.settings-sidebar-exit').focus()`)
  await pressKey('Tab')
  await pressKey('Tab', true)
  const keyboardExitFocus = await client.evaluate(`(() => {
    const exit = document.querySelector('.settings-sidebar-exit')
    return { active: document.activeElement === exit, visible: exit.matches(':focus-visible') }
  })()`)
  assert.deepEqual(keyboardExitFocus, { active: true, visible: true }, 'the settings exit is held by keyboard focus before Enter')
  const focusEvents = await client.evaluate(`(() => {
    window.__settingsReturnFocusTrace = []
    for (const type of ['focusout', 'focusin']) {
      document.addEventListener(type, (event) => window.__settingsReturnFocusTrace.push({
        type,
        target: event.target?.className || event.target?.tagName,
        relatedTarget: event.relatedTarget?.className || event.relatedTarget?.tagName || null,
        settingsOpen: Boolean(document.querySelector('.window-shell.settings-open')),
        settingsHidden: document.querySelector('.settings-presence')?.classList.contains('presence-hidden') === true,
        active: document.activeElement?.className || document.activeElement?.tagName,
      }), true)
    }
    return true
  })()`)
  assert.equal(focusEvents, true)
  await pressKey('Enter')
  await harness.waitFor(() => client.evaluate(`document.querySelector('.settings-presence')?.classList.contains('presence-hidden') === true`), 10_000, 'settings exit to finish')
  const keyboardReturnFocus = await client.evaluate(`(() => ({
    settingsHidden: document.querySelector('.settings-presence')?.classList.contains('presence-hidden') === true,
    settingsInert: document.querySelector('.settings-presence')?.hasAttribute('inert') === true,
    activeIsComposer: document.activeElement === window.__settingsComposer,
    active: document.activeElement?.className || document.activeElement?.tagName,
    trace: window.__settingsReturnFocusTrace,
    draft: window.__settingsComposer?.value,
  }))()`)
  assert.equal(keyboardReturnFocus.settingsHidden, true)
  assert.equal(keyboardReturnFocus.settingsInert, true)
  assert.equal(keyboardReturnFocus.activeIsComposer, true, `keyboard return should restore composer focus: ${JSON.stringify(keyboardReturnFocus)}`)
  assert.equal(keyboardReturnFocus.draft, '设置切换后保留的草稿')
  const focusOutToDocument = keyboardReturnFocus.trace.findIndex(event => event.type === 'focusout'
    && event.target === 'settings-sidebar-exit' && event.active === 'BODY' && !event.settingsOpen)
  const focusIntoComposer = keyboardReturnFocus.trace.findIndex(event => event.type === 'focusin'
    && event.target === 'TEXTAREA' && !event.settingsOpen)
  assert(focusOutToDocument >= 0 && focusIntoComposer > focusOutToDocument,
    `focus must leave the inert settings control before returning to the composer: ${JSON.stringify(keyboardReturnFocus.trace)}`)
  checks.push({ name: 'keyboard settings return restores composer focus after exit and preserves draft', keyboardExitFocus, keyboardReturnFocus })
  assert(await client.evaluate(`document.querySelector('.composer textarea')===window.__settingsComposer && window.__settingsComposer.value==='设置切换后保留的草稿'`))
  // The existing reduced-motion contract applies to both CSS and presence completion.
  await client.evaluate(`document.documentElement.dataset.lsReducedMotion='true'`)
  const reducedOpen = await measure('.settings-entry-btn', 120)
  await clickWithMouse('.settings-sidebar-exit')
  await harness.waitFor(() => client.evaluate(`document.querySelector('.settings-presence')?.classList.contains('presence-hidden') === true`), 10_000, 'mouse settings exit to finish')
  const reducedExit = await client.evaluate(`[{ ms: 0, hidden: document.querySelector('.settings-presence')?.classList.contains('presence-hidden') === true, returning: document.querySelector('.window-shell')?.classList.contains('settings-returning') }]`)
  assert(reducedExit.some(frame => frame.ms < 100 && frame.hidden && !frame.returning))
  const mouseReturnFocus = await client.evaluate(`document.activeElement === window.__settingsComposer`)
  assert.equal(mouseReturnFocus, false, 'the mouse return must not take focus from the user')
  await capture('settings-returned')
  checks.push({ name: 'cold and warm entry, discrete rail handoff, short return, interruption, draft preservation and reduced motion', cold, returned, warm, reducedOpen, reducedExit })
  await writeFile(join(root, 'report.json'), JSON.stringify({ status: 'passed', checks }, null, 2))
  console.log(JSON.stringify({
    status: 'passed', root,
    checks: checks.map(check => check.name),
    frames: { cold: cold.length, exit: returned.length, warm: warm.length, reducedOpen: reducedOpen.length },
  }))
} finally {
  client?.close()
  if (child.exitCode === null) await harness.forceTerminate(child)
}
