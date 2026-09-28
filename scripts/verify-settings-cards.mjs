// Exercises the production settings cards and value menus in an isolated Electron window.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'

const harness = createElectronHarness({ startTimeoutMs: 90_000 })
await harness.assertBuildFresh()
const root = await mkdtemp(join(tmpdir(), 'littlesheep-settings-cards-'))
const dataDir = join(root, 'data')
await mkdir(join(dataDir, 'workplace'), { recursive: true })
await writeFile(join(dataDir, 'config.json'), JSON.stringify({ version: 1, providers: [], agents: { defaults: { workspace: join(dataDir, 'workplace'), model: '', harness: 'core-flow' } }, desktop: { closePolicy: 'always-background' } }))
const debuggingPort = await harness.reservePort()
const child = await harness.startElectron({ dataDir, chromiumDir: join(root, 'chromium'), debuggingPort, logPath: join(root, 'electron.log') })
let client, locator
let status = 'failed'
const checks = []
async function click(selector, label) {
  const point = await client.evaluate(`(() => {
    const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>${label ? `el.textContent.trim()===${JSON.stringify(label)}` : 'true'});
    if(!element) throw Error('Missing control'); element.scrollIntoView({block:'nearest'});
    const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    return {x,y,reachable:element.contains(document.elementFromPoint(x,y))};
  })()`)
  assert(point.reachable, `${selector} ${label ?? ''} must be reachable`)
  await client.send('Input.dispatchMouseEvent', { type:'mousePressed', x:point.x, y:point.y, button:'left', clickCount:1 })
  await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:point.x, y:point.y, button:'left', clickCount:1 })
  await delay(150)
}
async function key(key, code = key) {
  await client.send('Input.dispatchKeyEvent', { type:'keyDown', key, code, windowsVirtualKeyCode:{Escape:27,ArrowDown:40,ArrowUp:38,Enter:13,Tab:9,End:35,Home:36}[key] })
  await client.send('Input.dispatchKeyEvent', { type:'keyUp', key, code })
  await delay(150)
}
async function page(label) {
  await click('.settings-nav-item', label)
  await harness.waitFor(() => client.evaluate(`document.querySelector('.settings-workspace-body h2')?.textContent === ${JSON.stringify(label)}`), 10_000, label)
  await delay(400)
}
async function screenshot(name) {
  const shot = await client.send('Page.captureScreenshot', { format:'png', captureBeyondViewport:false })
  await writeFile(join(root, `${name}.png`), Buffer.from(shot.data, 'base64'))
}
async function menuFacts() {
  return client.evaluate(`(() => {const el=document.querySelector('.settings-select-menu'); if(!el)return null; const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width, viewport:{width:innerWidth,height:innerHeight},radius:s.borderRadius,blur:s.backdropFilter,selected:el.querySelector('[aria-checked="true"]')?.textContent.trim(),focused:document.activeElement?.textContent.trim(),count:el.querySelectorAll('button').length,portalled:el.parentElement===document.body};})()`)
}
try {
  locator = await harness.waitForLocator(dataDir, child.pid)
  client = await harness.connectRenderer(debuggingPort)
  await harness.desktopAction(locator, 'park-offscreen')
  await harness.desktopAction(locator, 'resize', { width:1280, height:900 })
  await harness.waitFor(() => client.evaluate('!!document.querySelector(".settings-entry-btn")'), 30_000)
  if (!await client.evaluate('document.querySelector(".window-shell").classList.contains("settings-open")')) await click('.settings-entry-btn')
  await delay(650)
  await page('界面')
  const card = await client.evaluate(`(() => {const el=document.querySelector('.settings-card'),s=getComputedStyle(el);return {radius:s.borderRadius,border:s.borderTopWidth,overflow:el.scrollWidth>el.clientWidth};})()`)
  assert.equal(card.radius,'18px'); assert.ok(card.border === '1px' || /^0\.\d+px$/.test(card.border), settings card border must be a hairline; computed  (a 1px border computes as 0.666667px at 1.5 display scale)); assert.equal(card.overflow,false)
  await click('.settings-select')
  let menu = await menuFacts()
  assert(menu.portalled); assert.equal(menu.count,2); assert.equal(menu.selected,'普通'); assert.equal(menu.focused,'普通')
  await screenshot('appearance-menu')
  await key('ArrowDown'); await key('Enter')
  assert.equal(await menuFacts(),null)
  assert.equal(await client.evaluate('document.querySelector(".settings-select").textContent.trim()'),'紧凑')
  assert(await client.evaluate('document.activeElement === document.querySelector(".settings-select")'))
  await client.send('Page.reload')
  await harness.waitFor(() => client.evaluate('document.querySelector(".settings-select")?.textContent.trim()==="紧凑"'), 20_000, 'saved display preference')
  await click('.settings-select'); await key('Escape')
  assert.equal(await menuFacts(),null)
  assert(await client.evaluate('document.querySelector(".window-shell").classList.contains("settings-open")'))
  await click('.settings-select'); await click('.settings-module-heading h2')
  assert.equal(await menuFacts(),null)
  checks.push({ name:'appearance-card-keyboard-persistence-dismiss',card,status:'passed' })
  await page('应用与后台')
  await click('.settings-select')
  assert.equal((await menuFacts()).count,3)
  await key('Escape')
  await page('Agent 行为')
  await click('.settings-select')
  assert((await menuFacts()).count>1)
  await key('Escape')
  await page('网络检索')
  await harness.waitFor(() => client.evaluate('document.querySelectorAll(".settings-select").length===4'), 20_000, 'web settings')
  await client.evaluate('document.querySelector(".settings-workspace-body").scrollTop=0')
  await screenshot('web-settings')
  await click('.settings-select[aria-label="公开读取模式"]')
  await screenshot('web-settings-menu')
  menu=await menuFacts(); assert.equal(menu.count,3)
  await key('Escape')
  for(const width of [800,1280]) {
    await harness.desktopAction(locator,'resize',{width,height:600})
    await delay(400)
    await click('.settings-select[aria-label="浏览器后备"]')
    menu=await menuFacts()
    assert(menu.x>=0&&menu.y>=0&&menu.right<=menu.viewport.width+1&&menu.bottom<=menu.viewport.height+1)
    assert(menu.portalled)
    await screenshot(`menu-${width}`)
    await key('Tab')
    assert.equal(await menuFacts(),null)
    checks.push({name:`viewport-${width}`,menu,status:'passed'})
  }
  await harness.desktopAction(locator,'resize',{width:1280,height:900})
  for(const label of ['存储与数据','内置浏览器','模型供应商','开发环境','设置总览']) {
    // The overview label may differ; other routes are stable page identities.
    if(label==='设置总览') continue
    await page(label)
    assert.equal(await client.evaluate('document.querySelector(".settings-workspace-body").scrollWidth > document.querySelector(".settings-workspace-body").clientWidth'),false)
    await screenshot(label)
  }
  status='passed'
} finally {
  await writeFile(join(root,'results.json'),JSON.stringify({status,checks},null,2))
  client?.close()
  if(locator) await harness.desktopAction(locator,'quit').catch(()=>{})
  if(child.exitCode===null) await harness.waitForExit(child,10_000).catch(()=>child.kill())
  console.log(JSON.stringify({root,status,checks},null,2))
}
