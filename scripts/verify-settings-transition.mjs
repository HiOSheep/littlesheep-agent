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
await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1, providers: [], agents: { defaults: { workspace: join(dataDir, 'workplace'), model: '', harness: 'core-flow' } } }))
const port = await harness.reservePort()
const child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort: port, logPath: join(root, 'electron.log') })
let client
const checks = []
async function capture(name) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, name + '.png'), Buffer.from(data, 'base64'))
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
  await measure('.settings-sidebar-exit')
  assert(await client.evaluate(`document.querySelector('.composer textarea')===window.__settingsComposer && window.__settingsComposer.value==='设置切换后保留的草稿'`))
  // The existing reduced-motion contract applies to both CSS and presence completion.
  await client.evaluate(`document.documentElement.dataset.lsReducedMotion='true'`)
  const reducedOpen = await measure('.settings-entry-btn', 120)
  const reducedExit = await measure('.settings-sidebar-exit', 120)
  assert(reducedExit.some(frame => frame.ms < 100 && frame.hidden && !frame.returning))
  await capture('settings-returned')
  checks.push({ name: 'cold and warm entry, discrete rail handoff, short return, interruption, draft preservation and reduced motion', cold, returned, warm, reducedOpen, reducedExit })
  await writeFile(join(root, 'report.json'), JSON.stringify({ status: 'passed', checks }, null, 2))
  console.log(JSON.stringify({ status: 'passed', root, frames: checks.map(check => ({ cold: check.cold.length, exit: check.returned.length, warm: check.warm.length })) }))
} finally {
  client?.close()
  if (child.exitCode === null) await harness.forceTerminate(child)
}
