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
  electron = await h.startElectron({dataDir,chromiumDir,debuggingPort,logPath:join(root,'electron.log'),extraArgs:['--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']})
  const locator = await h.waitForLocator(dataDir,electron.pid)
  await h.waitForDesktop(locator)
  await h.desktopAction(locator,'resize',{width:1280,height:900})
  await h.desktopAction(locator,'park-offscreen')
  client = await h.connectRenderer(debuggingPort)
  await client.send('Page.bringToFront')
  // The still mark is painted immediately; the live canvas joins once the shader has drawn a frame.
  await h.waitFor(()=>evaluate(`(() => {const mark=document.querySelector('.empty-hint .void-ring img');return mark?.complete&&mark.naturalWidth>0||null})()`),20_000,'still mark')
  await h.waitFor(()=>evaluate(`document.querySelector('.empty-hint .void-ring[data-motion="playing"] canvas.void-ring-live')!==null||null`),20_000,'live idle ring')
  report.checks.liveRingStarts=true
  await delay(500)
  const a=await frame('idle-a','.void-ring-companion');await delay(800);const b=await frame('idle-b','.void-ring-companion')
  report.checks.idlePixelDifference=await diff(a,b);assert.ok(report.checks.idlePixelDifference>.05)
  report.checks.emptyHintClearOfComposer=await evaluate(`(() => {const a=document.querySelector('.empty-hint').getBoundingClientRect(),b=document.querySelector('.composer').getBoundingClientRect();return a.bottom<b.top&&a.top>=32})()`)
  assert.ok(report.checks.emptyHintClearOfComposer,'brand and empty hint must not overlap input or window chrome')
  await frame('empty-conversation')
  report.checks.surfaceAlpha=await alpha('.empty-hint .void-ring')
  assert.equal(report.checks.surfaceAlpha.cornerAlpha,0);assert.equal(report.checks.surfaceAlpha.bodyAlpha,255)
  assert.equal(report.checks.surfaceAlpha.background,'rgba(0, 0, 0, 0)')
  // Exercise the actual pointer and keyboard surface. The ring notices a pointer nearby, not only on top.
  const companion = await evaluate(`(() => {const r=document.querySelector('.void-ring-companion').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`)
  const bodyTransform = () => evaluate(`document.querySelector('.void-ring-body').style.transform`)
  const pointer = {x:companion.x+companion.width*1.6,y:companion.y+companion.height*.2}
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',...pointer})
  await h.waitFor(async()=>{const m=/translate\(([-\d.]+)px/.exec(await bodyTransform());return m&&parseFloat(m[1])>0.5||null},5000,'ring leans toward a nearby pointer')
  await delay(400);await frame('pointer-follow','.empty-hint')
  report.checks.pointerFollow=true
  const ringFrames = async (ms) => {const a=await frame('greet-a','.void-ring-companion');await delay(ms);return diff(a,await frame('greet-b','.void-ring-companion'))}
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:companion.x-400,y:companion.y})
  await delay(900)
  const quiet=await ringFrames(160)
  const onRing={x:companion.x+companion.width*.47,y:companion.y+companion.height*.52}
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',...onRing})
  await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...onRing,button:'left',clickCount:1})
  await h.waitFor(async()=>{const m=/scale\(([\d.]+)\)/.exec(await bodyTransform());return m&&parseFloat(m[1])<0.97||null},2000,'press squashes the ring')
  await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...onRing,button:'left',clickCount:1})
  const greeted=await ringFrames(160)
  await frame('greeting','.empty-hint')
  report.checks.greeting={quiet,greeted};assert.ok(greeted>quiet*3,'a greeting visibly answers')
  await client.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:companion.x-400,y:companion.y})
  await delay(1600)
  // The native button receives focus; Space and Enter use its standard click behavior.
  await evaluate(`document.querySelector('.void-ring-companion').focus()`)
  for(const [key,code,windowsVirtualKeyCode] of [['Enter','Enter',13],[' ','Space',32]]) {
    assert.ok(await evaluate(`document.activeElement.matches('.void-ring-companion')`),'greeting button owns keyboard focus')
    const before=await frame('key-a','.void-ring-companion')
    const text=key==='Enter'?'\r':' '
    await client.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode,nativeVirtualKeyCode:windowsVirtualKeyCode,text,unmodifiedText:text})
    await client.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,nativeVirtualKeyCode:windowsVirtualKeyCode})
    await delay(160)
    assert.ok(await diff(before,await frame('key-b','.void-ring-companion'))>quiet*3,'keyboard greeting '+code)
    await delay(1400)
  }
  report.checks.keyboardGreeting=true
  // Off screen the ring stops drawing entirely and drops its canvas.
  await evaluate(`document.querySelector('.void-ring-companion').style.visibility='hidden';document.querySelector('.void-ring-companion').style.position='fixed';document.querySelector('.void-ring-companion').style.top='-1000px'`)
  await h.waitFor(()=>evaluate(`document.querySelector('.void-ring-companion').dataset.motion==='still'&&!document.querySelector('.empty-hint .void-ring canvas')||null`),5000,'offscreen stop')
  report.checks.offscreenStops=true
  await evaluate(`document.querySelector('.void-ring-companion').removeAttribute('style');document.querySelector('.void-ring-companion').blur()`)
  await h.waitFor(()=>evaluate(`document.querySelector('.void-ring-companion').dataset.motion==='playing'||null`),5000,'onscreen resume')
  // Same real component against the application's light-theme surfaces.
  const theme=await evaluate(`document.documentElement.dataset.lsTheme`)
  await evaluate(`document.documentElement.dataset.lsTheme='light'`)
  await frame('empty-conversation-light')
  const lightAlpha=await alpha('.empty-hint .void-ring');assert.equal(lightAlpha.cornerAlpha,0);assert.equal(lightAlpha.bodyAlpha,255)
  report.checks.lightThemeTransparent=true
  await evaluate(`document.documentElement.dataset.lsTheme=${JSON.stringify(theme)}`)
  await client.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await h.waitFor(()=>evaluate(`document.querySelector('.empty-hint .void-ring')?.dataset.motion==='still'&&!document.querySelector('.empty-hint .void-ring canvas')||null`),5000,'reduced motion')
  await evaluate(`document.querySelector('.void-ring-companion').click()`)
  report.checks.reducedMotionInteractionStatic=true
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
  // Reopen through the real new-conversation action, sampling the very first frames: every frame must
  // already show the whole mark, either drawn by the live canvas (frame 0 is the mark) or by the PNG.
  await evaluate(`(() => {
    window.__newChatFrames=[];
    window.__newChatSamplingDone=false;
    const start=performance.now();
    function sample() {
      const ring=document.querySelector('.empty-hint .void-ring');
      if(ring) {
        const still=ring.querySelector('img.void-ring-still');
        const live=ring.querySelector('canvas.void-ring-live');window.__newChatFrames.push({ready:ring.dataset.motion==='playing'&&!!live&&live.width>0||!!still&&still.complete&&still.naturalWidth>0,stable:!!still&&getComputedStyle(still).transform==='none'&&getComputedStyle(still).opacity==='1'});
      }
      if(performance.now()-start<900) requestAnimationFrame(sample);
      else window.__newChatSamplingDone=true;
    }
    requestAnimationFrame(sample);
  })()`)
  const newChatButton=await evaluate(`(() => {const r=[...document.querySelectorAll('.sidebar-quick-nav button')].find(button=>button.textContent.includes('新对话')).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...newChatButton,button:'left',clickCount:1})
  await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...newChatButton,button:'left',clickCount:1})
  await h.waitFor(()=>evaluate(`window.__newChatSamplingDone||null`),5000,'new conversation first-frame samples')
  const newChatFrames=await evaluate(`window.__newChatFrames`)
  assert.ok(newChatFrames.length>=6,'sample the new conversation across multiple rendered frames')
  assert.ok(newChatFrames.every(frame=>frame.ready&&frame.stable),'every new-conversation frame shows the complete, full-size mark')
  report.checks.newConversationFirstFrames={samples:newChatFrames.length,stable:true}
  await frame('reopened-conversation')
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
  if(client){report.page=await evaluate(`({hidden:document.hidden,icons:[...document.querySelectorAll('.void-ring')].map(x=>({state:x.dataset.voidRingState,motion:x.dataset.motion,live:!!x.querySelector('canvas')})),turns:[...document.querySelectorAll('.assistant-turn')].map(x=>x.className)})`).catch(()=>null);await frame('failure').catch(()=>{})}
  throw error
}
finally {
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({out:root,...report},null,2))
  client?.close();await h.forceTerminate(electron);await new Promise(resolve=>provider.close(resolve))
}
