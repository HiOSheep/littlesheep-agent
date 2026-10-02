// Isolated, shown Electron: layout/theme/typography evidence without user data.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider, LONG_MARKDOWN_END } from './lib/electron-acceptance-provider.mjs'

const out = resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || await mkdtemp(join(tmpdir(), 'ls-ui-evidence-')))
const root = await mkdtemp(join(tmpdir(), 'ls-ui-refinement-'))
const dataDir = join(root, 'data'), chromiumDir = join(root, 'chromium'), workspace = join(dataDir, 'workplace')
const h = createElectronHarness({ startTimeoutMs: 90_000 })
const report = { fixture: 'isolated shown Electron with deterministic local provider', scenes: [], checks: {} }
let electron, client, provider, locator
const evaluate = expression => client.evaluate(expression)
const clickText = (selector, text) => evaluate(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!el)throw Error('Missing control: '+${JSON.stringify(text)}); el.click(); })()`)
async function screenshot(name) {
  await delay(650)
  const scene = await evaluate(`(() => {
    const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
    return {viewport:{w:innerWidth,h:innerHeight},theme:document.documentElement.dataset.lsTheme,
      shellOverflow:document.documentElement.scrollWidth>innerWidth,
      composer:rect('.composer'),textarea:rect('.composer textarea'),settings:rect('.settings-workspace-body'),
      tree:rect('.workspace-shared-file-navigator'), font:getComputedStyle(document.querySelector('.composer textarea')).fontSize};
  })()`)
  assert.equal(scene.shellOverflow, false, name+' overflows the window')
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
  await writeFile(join(out, name+'.png'), Buffer.from(shot.data,'base64'))
  report.scenes.push({name,...scene})
}
async function resize(width,height) {
  await h.desktopAction(locator,'resize',{width,height})
  await h.waitFor(()=>evaluate(`innerWidth===${width}&&innerHeight===${height}||null`),15_000,'real window resize')
}
async function theme(value) {
  await evaluate(`document.documentElement.dataset.lsTheme=${JSON.stringify(value)}`)
}
try {
  await h.assertBuildFresh()
  await Promise.all([mkdir(out,{recursive:true}),mkdir(workspace,{recursive:true}),mkdir(chromiumDir,{recursive:true})])
  for (const name of ['docs','packages','scripts','skills']) await mkdir(join(workspace,name))
  await writeFile(join(workspace,'README.md'),'# LittleSheep\n\n专注想法，让执行自然发生。\n\n## 项目结构\n\n- 清晰的导航\n- 舒适的阅读\n- 可控的工作区\n')
  await writeFile(join(workspace,'package.json'),'{\n  "name": "littlesheep",\n  "version": "1.0.0",\n  "private": true\n}\n')
  await writeFile(join(workspace,'app.ts'),'export function welcome(name: string) {\n  return `Hello, ${name}`;\n}\n')
  provider = await startElectronAcceptanceProvider({ streamChunkDelayMs: 5, streamChunkCharacters: 180 })
  await writeFile(join(dataDir,'config.json'), JSON.stringify({version:1,providers:[{id:'acceptance',name:'Local visual fixture',baseURL:provider.baseURL,apiKey:'acceptance-key',models:['slow-a']}],agents:{defaults:{workspace,model:'acceptance/slow-a',reasoning:'auto',profile:'general',timeoutSeconds:120,maxRecoveryAttempts:1}}}))
  const debuggingPort = await h.reservePort()
  electron = await h.startElectron({dataDir,chromiumDir,debuggingPort,logPath:join(root,'electron.log')})
  locator = await h.waitForLocator(dataDir,electron.pid)
  await h.waitForDesktop(locator)
  await h.desktopAction(locator,'show')
  client = await h.connectRenderer(debuggingPort)
  await client.send('Runtime.enable'); await client.send('Log.enable')
  await h.waitFor(()=>evaluate(`!!document.querySelector('.composer textarea')||null`),30_000,'composer')
  await h.waitFor(async()=>{const r=await h.fetchJson(locator,'/runtime/readiness');return r.body?.state==='ready'||null},60_000,'runtime readiness')
  await resize(1280,900); await theme('dark'); await screenshot('home-dark')
  await theme('light'); await screenshot('home-light'); await theme('dark')
  await evaluate(`document.querySelector('button[aria-label="设置"]').click()`)
  await screenshot('settings-overview')
  await clickText('.settings-nav-item','界面'); await screenshot('settings-appearance')
  await clickText('.settings-nav-item','模型供应商'); await screenshot('settings-models')
  await clickText('.provider-add','＋ 添加自定义供应商')
  await h.waitFor(()=>evaluate(`!!document.querySelector('[role="dialog"][aria-label="添加自定义供应商"]')||null`),10_000,'provider editor dialog')
  assert.equal(await evaluate(`document.querySelectorAll('.provider-editor .dialog-error').length`),0,'pristine required fields are guidance, not errors')
  assert.equal(await evaluate(`document.querySelector('.provider-editor .save-btn').disabled`),true,'incomplete provider cannot be saved')
  await screenshot('provider-dialog')
  await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await h.waitFor(()=>evaluate(`!document.querySelector('[role="dialog"][aria-label="添加自定义供应商"]')||null`),10_000,'Escape dismisses provider dialog')
  await clickText('.provider-add','＋ 添加自定义供应商')
  await evaluate(`(() => {const el=document.querySelector('.provider-editor input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'invalid id');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await h.waitFor(()=>evaluate(`!!document.querySelector('.provider-editor .dialog-error')||null`),10_000,'invalid changed field is visibly explained')
  await screenshot('provider-invalid-field')
  await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await h.waitFor(()=>evaluate(`!!document.querySelector('.provider-editor-discard')||null`),10_000,'unsaved edits are protected')
  await screenshot('provider-unsaved-confirmation')
  await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await h.waitFor(()=>evaluate(`!document.querySelector('.provider-editor-discard')&&!!document.querySelector('.provider-editor')||null`),10_000,'Escape keeps unsaved editor open')
  await evaluate(`document.querySelector('.provider-editor button[aria-label="关闭"]').click()`)
  await h.waitFor(()=>evaluate(`!!document.querySelector('.provider-editor-discard')||null`),10_000,'discard confirmation reopens')
  await evaluate(`document.querySelector('.provider-editor-discard .danger-btn').click()`)
  await h.waitFor(()=>evaluate(`!document.querySelector('.provider-editor')||null`),10_000,'explicit discard closes editor')
  for(const [index,title] of ['总览','应用与后台','Agent 行为','Token 用量','网络检索','内置浏览器','插件','技能','外部渠道','开发环境','归档','记忆树'].entries()) {
    await clickText('.settings-nav-item',title)
    await screenshot('settings-page-'+index)
  }
  await clickText('.settings-nav-item','存储与数据'); await screenshot('settings-storage')
  await theme('light'); await screenshot('settings-light')
  await resize(900,700); await screenshot('settings-compact')
  // User font preferences remain effective at large type; scroll stays in the page.
  await clickText('.settings-nav-item','界面')
  await evaluate(`(() => {const el=document.querySelector('input[aria-label="界面字号"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'20');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await screenshot('settings-large-type')
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('littlesheep.ui.appearance.v1')).interfaceFontSize`),20,'font preference is persisted through the UI')
  await evaluate(`(() => {const el=document.querySelector('input[aria-label="界面字号"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'14');el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await evaluate(`document.querySelector('button[aria-label="退出设置页"]').click()`)
  await theme('dark'); await screenshot('home-compact'); await resize(1280,900)
  await evaluate(`document.querySelector('.add-menu-trigger').click()`)
  await screenshot('composer-add-menu')
  await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27})
  await resize(1600,1000); await screenshot('home-wide'); await resize(1280,900)
  await h.waitFor(async()=>{const r=await h.fetchJson(locator,'/runtime/readiness');return r.body?.state==='ready'||null},60_000,'runtime readiness')
  await evaluate(`(() => {const t=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'请输出这份验收文档：MARKDOWN-LONG-FIXTURE');t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
  await h.waitFor(()=>evaluate(`document.querySelector('.messages')?.textContent.includes(${JSON.stringify(LONG_MARKDOWN_END)})||null`),90_000,'settled local fixture reply')
  await screenshot('chat-dark')
  await evaluate(`document.querySelector('.messages').scrollTop=0`); await screenshot('chat-reading')
  await theme('light'); await screenshot('chat-light'); await theme('dark')
  await evaluate(`[...document.querySelectorAll('.workspace-tree-row.file')].find(x=>x.textContent.trim()==='package.json').click()`)
  await h.waitFor(()=>evaluate(`document.querySelector('.workspace-tab-view.active .view-line')?.textContent.includes('{')||null`),20_000,'file preview')
  await screenshot('workspace-split')
  await evaluate(`document.querySelector('button[aria-label="全屏展开工作区"]')?.click()`)
  await screenshot('workspace-fullscreen')
  await theme('light'); await screenshot('workspace-light')
  report.checks.uncaughtErrors = client.events.filter(e=>e.method==='Runtime.exceptionThrown')
  assert.equal(report.checks.uncaughtErrors.length,0,'uncaught renderer exceptions')
  report.status='passed'
} catch(error) {
  report.status='failed';report.error=error.stack
  if(client){report.page=await evaluate(`document.body.innerText.slice(0,5000)`).catch(()=>null);await screenshot('failure').catch(()=>{})}
  throw error
} finally {
  await mkdir(out,{recursive:true}); await writeFile(join(out,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({status:report.status,scenes:report.scenes.length,out,error:report.error}))
  client?.close();await h.forceTerminate(electron);await provider?.close()
}
