import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
const harness = createElectronHarness({ startTimeoutMs: 90_000 })
await harness.assertBuildFresh()
const root = await mkdtemp(join(tmpdir(), 'ls-appearance-'))
const dataDir = join(root, 'data')
await mkdir(join(dataDir, 'workplace'), { recursive: true })
await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1, providers: [], agents: { defaults: { workspace: join(dataDir, 'workplace'), model: '', harness: 'core-flow' } }, desktop: { closePolicy: 'always-background' } }))
const debuggingPort = await harness.reservePort()
const child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort, logPath: join(root, 'electron.log') })
let client
const checks = []
async function click(selector) {
  const point = await client.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Missing '+${JSON.stringify(selector)}); el.scrollIntoView({block:'nearest'}); const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,reachable:el.contains(document.elementFromPoint(x,y))}; })()`)
  assert(point.reachable, `Unreachable ${selector}`)
  await client.send('Input.dispatchMouseEvent', {type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1})
  await client.send('Input.dispatchMouseEvent', {type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1})
  await delay(120)
}
async function key(key, code, windowsVirtualKeyCode, modifiers=0) {
  await client.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,modifiers})
  await client.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,modifiers})
}
async function edit(selector, value) {
  await click(selector)
  await key('a','KeyA',65,2)
  await client.send('Input.insertText',{text:value})
  await key('Enter','Enter',13)
  await delay(150)
}
async function screenshot(name) {
  const shot=await client.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})
  await writeFile(join(root,name+'.png'),Buffer.from(shot.data,'base64'))
}
const readSaved = () => client.evaluate('JSON.parse(localStorage.getItem("littlesheep.ui.appearance.v1"))')
try {
  const locator=await harness.waitForLocator(dataDir,child.pid)
  client=await harness.connectRenderer(debuggingPort)
  await harness.desktopAction(locator,'resize',{width:1280,height:1400})
  await harness.desktopAction(locator,'show')
  await harness.waitFor(()=>client.evaluate('!!document.querySelector(".settings-entry-btn")'),30000)
  await click('.settings-entry-btn')
  await harness.waitFor(()=>client.evaluate('!!document.querySelector(".settings-nav-item")'),10000)
  // Navigation groups have separate parents, so use the stable page button's actual index locally.
  await client.evaluate(`document.querySelectorAll('.settings-nav-item').forEach(el=>{if(el.textContent.trim()==='外观')el.setAttribute('data-appearance-test','true')})`)
  await click('[data-appearance-test]')
  await harness.waitFor(()=>client.evaluate('!!document.querySelector(".appearance-settings-page")'),10000)
  await click('.appearance-mode-option[aria-label="深色"]')
  assert.equal((await readSaved()).theme,'dark')
  await edit('input[aria-label="前景色颜色值"]','#EEEEEE')
  assert.equal((await readSaved()).colors.foreground,'#eeeeee')
  assert.equal(await client.evaluate('document.documentElement.style.getPropertyValue("--ls-custom-text")'),'#eeeeee')
  await edit('input[aria-label="前景色颜色值"]','#191B20')
  assert.equal((await readSaved()).colors.foreground,'#eeeeee')
  assert(await client.evaluate('document.querySelector("input[aria-label=前景色颜色值]").getAttribute("aria-invalid")==="true"'))
  await edit('input[aria-label="前景色颜色值"]','#EEEEEE')
  await edit('input[aria-label="界面字号"]','16')
  assert.equal((await readSaved()).interfaceFontSize,16)
  await edit('input[aria-label="界面字号"]','14')
  await click('.appearance-segments button:nth-child(3)')
  await click('input[aria-label="背景色颜色值"]')
  await key('a','KeyA',65,2)
  await client.send('Input.insertText',{text:'#343434'})
  await delay(60)
  const colorFrames = await client.evaluate(`(async () => {
    const root=document.documentElement;
    const samples=[getComputedStyle(root).getPropertyValue('--ls-custom-background').trim()];
    document.querySelector('input[aria-label="背景色颜色值"]').blur();
    for(let i=0;i<12;i++){await new Promise(resolve=>setTimeout(resolve,25));samples.push(getComputedStyle(root).getPropertyValue('--ls-custom-background').trim())}
    return samples;
  })()`)
  assert.equal((await readSaved()).colors.background,'#343434')
  assert(new Set(colorFrames).size >= 3, `Colors must interpolate through intermediate frames: ${JSON.stringify(colorFrames)}`)
  checks.push({name:'palette transition contains intermediate colors',colorFrames})
  await click('.appearance-segments button:nth-child(2)')
  assert.equal((await readSaved()).reducedMotion,'on')
  assert.equal(await client.evaluate('document.documentElement.dataset.lsReducedMotion'),'true')
  await edit('input[aria-label="背景色颜色值"]','#101010')
  await edit('input[aria-label="强调色颜色值"]','#4176E6')
  await click('button[aria-label="前景色颜色选择器"]')
  const pickerFacts = await client.evaluate(`(() => {
    const el=document.querySelector('.appearance-color-picker'),field=el.querySelector('.appearance-picker-field'),r=el.getBoundingClientRect();
    return {radius:getComputedStyle(el).borderRadius,fieldRadius:getComputedStyle(field).borderRadius,portalled:el.parentElement===document.body,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};
  })()`)
  assert.equal(pickerFacts.radius,'20px')
  assert.equal(pickerFacts.fieldRadius,'12px')
  assert(pickerFacts.portalled && pickerFacts.left>=0 && pickerFacts.top>=0 && pickerFacts.right<=pickerFacts.width && pickerFacts.bottom<=pickerFacts.height)
  await edit('input[aria-label="前景色 R"]','220')
  assert.equal((await readSaved()).colors.foreground,'#dceeee')
  await screenshot('appearance-rounded-picker')
  await key('Escape','Escape',27)
  assert.equal(await client.evaluate('!!document.querySelector(".appearance-color-picker")'),false)
  assert(await client.evaluate('document.activeElement===document.querySelector("button[aria-label=前景色颜色选择器]")'))
  await edit('input[aria-label="前景色颜色值"]','#EEEEEE')
  checks.push({name:'rounded color popup, RGB editing, viewport bounds and Escape focus return',pickerFacts})
  checks.push('mode, foreground, contrast rejection, font size and reduced motion applied')
  await client.send('Page.reload')
  await delay(800)
  await harness.waitFor(()=>client.evaluate('!!document.querySelector(".appearance-settings-page")'),20000)
  assert.equal(await client.evaluate('document.querySelector("input[aria-label=前景色颜色值]").value'),'#EEEEEE')
  assert.equal(await client.evaluate('document.documentElement.dataset.lsReducedMotion'),'true')
  checks.push('preferences survived renderer reload')
  await client.evaluate('document.querySelector(".settings-workspace-body").scrollTop=0')
  await screenshot('appearance-dark')
  await click('.appearance-mode-option[aria-label="浅色"]')
  await click('.settings-select[aria-label="主题配色"]')
  await click('.settings-select-menu button:first-child')
  await delay(180)
  assert.equal(await client.evaluate('document.documentElement.dataset.lsTheme'),'light')
  assert.equal((await readSaved()).palette,'neutral')
  await screenshot('appearance-light')
  await click('.appearance-mode-option[aria-label="深色"]')
  await click('.appearance-advanced > summary')
  assert.equal(await client.evaluate('document.querySelector(".appearance-advanced").open'),false)
  await click('.appearance-advanced > summary')
  await harness.desktopAction(locator,'resize',{width:800,height:700})
  await delay(250)
  assert.equal(await client.evaluate('document.querySelector(".settings-workspace-body").scrollWidth>document.querySelector(".settings-workspace-body").clientWidth'),false)
  assert(await client.evaluate('[...document.querySelectorAll(".appearance-mode-option")].every(el=>el.getBoundingClientRect().width>=82)'), 'Mode previews must not shrink in narrow settings panes')
  await click('.appearance-mode-option[aria-label="跟随系统"]')
  assert.equal((await readSaved()).theme,'system')
  await screenshot('appearance-narrow')
  checks.push('light preset, advanced disclosure, narrow viewport and system mode usable')
  console.log(JSON.stringify({status:'passed',root,checks},null,2))
} finally {
  client?.close()
  if(child.exitCode===null) await harness.forceTerminate(child)
}
