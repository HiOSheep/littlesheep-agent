// 品牌动效真实 Electron 验收：隔离数据、确定性本地 Provider、真实 Runtime 状态。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'

const require = createRequire(import.meta.url)
const sharp = require(process.env.SHARP_MODULE ?? join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'))
const h = createElectronHarness({ startTimeoutMs: 90_000 })
const root = await mkdtemp(join(tmpdir(), 'ls-void-ring-electron-'))
const dataDir = join(root, 'data'), chromiumDir = join(root, 'chromium'), workspace = join(dataDir, 'workplace')
const report = { fixture: 'isolated real Electron + deterministic local SSE provider', checks: {} }
const providerRequests=[]
let electron, client
const provider = createServer(async (req,res) => {
  let raw = '';for await (const part of req) raw += part
  if (req.url !== '/v1/chat/completions') { res.writeHead(404);res.end();return }
  const body = JSON.parse(raw)
  providerRequests.push({stream:body.stream,model:body.model})
  const text = '品牌动效验收已完成。'
  if (!body.stream) {
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'brand-fixture',object:'chat.completion',model:body.model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:64,completion_tokens:16,total_tokens:80}}));return
  }
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'})
  const event = (delta,finish_reason=null) => res.write(`data: ${JSON.stringify({id:'brand-fixture',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`)
  await delay(1800)
  for(let i=0;i<18;i++){event({reasoning_content:'正在核对已确认的内圈反光与外侧光晕。'});await delay(180)}
  event({content:text});event({},'stop');res.write('data: [DONE]\n\n');res.end()
})
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve))
const baseURL = `http://127.0.0.1:${provider.address().port}/v1`
const evaluate = expression => client.evaluate(expression)
const frame = async(name,selector) => {
  const rect = selector ? await evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`) : undefined
  const result = await client.send('Page.captureScreenshot',{format:'png',fromSurface:true,...(rect?{clip:rect}:{})})
  const png = Buffer.from(result.data,'base64');await writeFile(join(root,name+'.png'),png);return png
}
const diff = async(a,b) => {
  const x=await sharp(a).removeAlpha().raw().toBuffer(),y=await sharp(b).removeAlpha().raw().toBuffer();assert.equal(x.length,y.length)
  let total=0;for(let i=0;i<x.length;i++)total+=Math.abs(x[i]-y[i]);return total/x.length
}
const alpha = async selector => evaluate(`(() => {
  const host=document.querySelector(${JSON.stringify(selector)}),img=host.matches('img')?host:host.querySelector('img');
  const canvas=document.createElement('canvas');canvas.width=canvas.height=64;
  const context=canvas.getContext('2d');context.drawImage(img,0,0,64,64);
  return {cornerAlpha:context.getImageData(0,0,1,1).data[3],bodyAlpha:context.getImageData(30,33,1,1).data[3],background:getComputedStyle(host).backgroundColor};
})()`)
try {
  await h.assertBuildFresh()
  await Promise.all([mkdir(workspace,{recursive:true}),mkdir(chromiumDir,{recursive:true})])
  await writeFile(join(dataDir,'config.json'),JSON.stringify({version:1,providers:[{id:'acceptance',name:'Local fixture',baseURL,apiKey:'fixture-only',models:['brand']}],agents:{defaults:{workspace,model:'acceptance/brand',reasoning:'auto',profile:'general',timeoutSeconds:60,maxRecoveryAttempts:1,maxModelCallsPerRun:8}}}))
  const debuggingPort = await h.reservePort()
  electron = await h.startElectron({dataDir,chromiumDir,debuggingPort,logPath:join(root,'electron.log')})
  const locator = await h.waitForLocator(dataDir,electron.pid)
  await h.waitForDesktop(locator)
  await h.desktopAction(locator,'resize',{width:1280,height:900})
  await h.desktopAction(locator,'show')
  client = await h.connectRenderer(debuggingPort)
  await h.waitFor(()=>evaluate(`document.querySelector('.empty-hint .void-ring[data-motion="playing"] img')?.complete || null`),20_000,'idle brand animation')
  await delay(500)
  const a=await frame('idle-a','.empty-hint .void-ring');await delay(800);const b=await frame('idle-b','.empty-hint .void-ring')
  report.checks.idlePixelDifference=await diff(a,b);assert.ok(report.checks.idlePixelDifference>.05)
  report.checks.emptyHintClearOfComposer=await evaluate(`(() => {const a=document.querySelector('.empty-hint').getBoundingClientRect(),b=document.querySelector('.composer').getBoundingClientRect();return a.bottom<b.top&&a.top>=32})()`)
  assert.ok(report.checks.emptyHintClearOfComposer,'brand and empty hint must not overlap input or window chrome')
  await frame('empty-conversation')
  report.checks.surfaceAlpha=await alpha('.empty-hint .void-ring')
  assert.equal(report.checks.surfaceAlpha.cornerAlpha,0);assert.equal(report.checks.surfaceAlpha.bodyAlpha,255)
  assert.equal(report.checks.surfaceAlpha.background,'rgba(0, 0, 0, 0)')
  // Same real component against the application's light-theme surfaces.
  const theme=await evaluate(`document.documentElement.dataset.lsTheme`)
  await evaluate(`document.documentElement.dataset.lsTheme='light'`)
  await frame('empty-conversation-light')
  const lightAlpha=await alpha('.empty-hint .void-ring');assert.equal(lightAlpha.cornerAlpha,0);assert.equal(lightAlpha.bodyAlpha,255)
  report.checks.lightThemeTransparent=true
  await evaluate(`document.documentElement.dataset.lsTheme=${JSON.stringify(theme)}`)
  await client.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await h.waitFor(()=>evaluate(`document.querySelector('.empty-hint .void-ring')?.dataset.motion==='still'||null`),5000,'reduced motion')
  const stillA=await frame('reduced-a','.empty-hint .void-ring');await delay(250);const stillB=await frame('reduced-b','.empty-hint .void-ring')
  assert.equal(await diff(stillA,stillB),0);report.checks.reducedMotionStatic=true
  const stillAlpha=await alpha('.empty-hint .void-ring');assert.equal(stillAlpha.cornerAlpha,0);assert.equal(stillAlpha.bodyAlpha,255)
  report.checks.reducedMotionTransparent=true
  await client.send('Emulation.setEmulatedMedia',{features:[]})
  await h.waitFor(async()=>{const r=await h.fetchJson(locator,'/runtime/readiness');return r.body?.state==='ready'||null},60_000,'Runtime ready')
  await evaluate(`(() => {const t=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'请直接回复一句话，验收品牌动效。');t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`)
  await h.waitFor(()=>evaluate(`document.querySelector('.running-pill .void-ring[data-void-ring-state="loading"][data-motion="playing"]')!==null||null`),15_000,'Runtime loading icon')
  await frame('loading-task');report.checks.realLoadingState=true
  await h.waitFor(()=>evaluate(`document.querySelector('.running-pill .void-ring[data-void-ring-state="thinking"]')!==null&&document.querySelector('.agent-transcript-reasoning.running .void-ring[data-motion="playing"]')!==null||null`),20_000,'streaming reasoning icon')
  await frame('thinking-task');report.checks.realThinkingState=true
  const thinkingA=await frame('thinking-a','.running-pill .void-ring');await delay(450);const thinkingB=await frame('thinking-b','.running-pill .void-ring')
  report.checks.thinkingPixelDifference=await diff(thinkingA,thinkingB);assert.ok(report.checks.thinkingPixelDifference>.05)
  await h.waitFor(()=>evaluate(`document.querySelector('.assistant-turn.done')!==null&&document.querySelector('.running-pill .void-ring[data-void-ring-state="idle"]')!==null||null`),20_000,'settled idle')
  report.checks.completedReturnsToIdle=true
  // Show the actual independent Main startup document in the same Electron window.
  await h.desktopAction(locator,'startup-page')
  await h.waitFor(()=>evaluate(`document.querySelector('picture source')?.srcset.startsWith('data:image/webp;base64,')||null`),5000,'standalone startup motion')
  assert.ok(await evaluate(`document.querySelector('.startup-icon').currentSrc.startsWith('data:image/webp;base64,')`))
  const startupA=await frame('startup-a','.startup-icon');await delay(500);const startupB=await frame('startup-b','.startup-icon')
  report.checks.startupPixelDifference=await diff(startupA,startupB);assert.ok(report.checks.startupPixelDifference>.05)
  const startupAlpha=await alpha('.startup-icon');assert.equal(startupAlpha.cornerAlpha,0);assert.equal(startupAlpha.bodyAlpha,255)
  report.checks.startupTransparent=true
  await client.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await h.waitFor(()=>evaluate(`document.querySelector('.startup-icon').currentSrc.startsWith('data:image/png;base64,')||null`),5000,'startup reduced motion PNG')
  report.checks.startupReducedMotion=true
  const startupStill=await alpha('.startup-icon');assert.equal(startupStill.cornerAlpha,0);assert.equal(startupStill.bodyAlpha,255)
  report.checks.startupFallbackTransparent=true
  report.status='passed'
} catch(error) {
  report.status='failed';report.error=error.stack;report.providerRequests=providerRequests
  if(client){report.page=await evaluate(`({hidden:document.hidden,icons:[...document.querySelectorAll('.void-ring')].map(x=>({state:x.dataset.voidRingState,motion:x.dataset.motion,src:x.querySelector('img').currentSrc})),turns:[...document.querySelectorAll('.assistant-turn')].map(x=>x.className)})`).catch(()=>null);await frame('failure').catch(()=>{})}
  throw error
}
finally {
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({out:root,...report},null,2))
  client?.close();await h.forceTerminate(electron);await new Promise(resolve=>provider.close(resolve))
}
