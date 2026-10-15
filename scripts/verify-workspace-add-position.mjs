// Native geometry acceptance: add follows short tab lists and stays reachable on overflow.
import assert from 'node:assert/strict'
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createElectronHarness,delay} from './lib/electron-cdp-harness.mjs'
import {startElectronAcceptanceProvider} from './lib/electron-acceptance-provider.mjs'
const harness=createElectronHarness()
const root=await mkdtemp(join(tmpdir(),'ls-workspace-add-'))
const dataDir=join(root,'data'),chromiumDir=join(root,'chromium'),workspace=join(root,'workspace')
const provider=await startElectronAcceptanceProvider()
let electron,client
const report={ok:false,root,checks:[],measurements:{}}
try {
  await harness.assertBuildFresh()
  await Promise.all([mkdir(dataDir),mkdir(chromiumDir),mkdir(workspace)])
  const paths=Array.from({length:16},(_,i)=>join(workspace,`workspace-position-${i+1}.txt`))
  await Promise.all(paths.map(path=>writeFile(path,'tab position fixture\n')))
  await writeFile(join(dataDir,'config.json'),JSON.stringify({version:1,providers:[{id:'acceptance',name:'Acceptance',baseURL:provider.baseURL,apiKey:'fixture',models:['slow-a']}],agents:{defaults:{model:'acceptance/slow-a',workspace}}}))
  const port=await harness.reservePort()
  electron=await harness.startElectron({dataDir,chromiumDir,debuggingPort:port,logPath:join(root,'electron.log')})
  const locator=await harness.waitForLocator(dataDir,electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator,'park-offscreen')
  await harness.desktopAction(locator,'resize',{width:1280,height:840})
  client=await harness.connectRenderer(port)
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Page.bringToFront')
  const evaluate=code=>client.evaluate(code)
  await harness.waitFor(()=>evaluate(`!!document.querySelector('.composer textarea')`),60_000,'renderer')
  let seedScript
  const seed=async count=>{
    const tabs=paths.slice(0,count).map(path=>`file:${encodeURIComponent(workspace)}|${encodeURIComponent(path)}`)
    const layout={collapsed:false,fullscreen:true,activeTab:tabs[0],openTabs:tabs,openRequest:{root:workspace,path:paths[0]},fileNavigatorCollapsed:true,fileNavigatorWidth:214,reviewNavigatorWidth:214,expandedPaths:[],drafts:{},browserTabs:[]}
    const preferences={'littlesheep.ui.workspacePanelCollapsed':'false','littlesheep.ui.workspacePanelFullscreen':'true','littlesheep.ui.workspacePanelTab':tabs[0],'littlesheep.ui.workspacePanelOpenTabs':JSON.stringify(tabs),'littlesheep.ui.workspacePanelOpenRoot':workspace,'littlesheep.ui.workspacePanelOpenPath':paths[0],'littlesheep.ui.workspaceFileNavigatorCollapsed':'true','littlesheep.ui.workspaceSessionLayouts':JSON.stringify({__draft__:layout})}
    if(seedScript)await client.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:seedScript})
    const source=`Object.entries(${JSON.stringify(preferences)}).forEach(([k,v])=>localStorage.setItem(k,v))`
    seedScript=(await client.send('Page.addScriptToEvaluateOnNewDocument',{source})).identifier
    await evaluate(source)
    await client.send('Page.reload')
    await harness.waitFor(()=>evaluate(`document.querySelectorAll('.workspace-tab-strip .workspace-active-item').length===${count}`).catch(()=>false),45_000,'restored tabs')
    await delay(400)
  }
  const measure=()=>evaluate(`(()=>{const box=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};const strip=document.querySelector('.workspace-tab-strip');const tabs=[...strip.querySelectorAll('.workspace-active-item')];const add=document.querySelector('.workspace-add-trigger');const r=box(add);const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return {add:r,last:box(tabs.at(-1)),full:box(document.querySelector('.workspace-panel-actions')),overflow:strip.scrollWidth>strip.clientWidth+1,reachable:!!hit&&add.contains(hit),count:tabs.length}})()`)
  const screenshot=async name=>{const shot=await client.send('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(shot.data,'base64'))}
  await seed(1)
  const short=await measure();report.measurements.short=short
  assert.equal(short.overflow,false)
  assert(short.add.left-short.last.right>=0&&short.add.left-short.last.right<=8,JSON.stringify(short))
  assert(short.full.left-short.add.right>100,'short list must not pin add beside the window controls')
  assert(short.reachable)
  await screenshot('short-tabs')
  report.checks.push('short list places add immediately after the last tab')
  await seed(16)
  const full=await measure();report.measurements.full=full
  assert(full.overflow)
  assert(full.full.left-full.add.right>=0&&full.full.left-full.add.right<=8,JSON.stringify(full))
  assert(full.reachable)
  await evaluate(`document.querySelector('.workspace-tab-strip').scrollLeft=1e9`);await delay(150)
  const scrolled=await measure()
  assert.equal(scrolled.add.left,full.add.left,'scrolling tabs must not move the add control')
  assert(scrolled.reachable)
  await screenshot('overflow-tabs')
  await evaluate(`document.querySelector('.workspace-add-trigger').click()`)
  await harness.waitFor(async()=>{await client.send('Page.captureScreenshot',{format:'png'});return evaluate(`!!document.querySelector('.workspace-add-panel.visible')`)},20_000,'add menu')
  const menu=await evaluate(`(()=>{const r=document.querySelector('.workspace-add-panel').getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()`)
  assert(menu.left>=0&&menu.right<=menu.width)
  await evaluate(`document.querySelector('.workspace-add-trigger').click()`)
  report.checks.push('overflow pins add beside the window controls; scrolling does not move it; menu remains usable')
  await harness.desktopAction(locator,'resize',{width:900,height:840});await delay(400)
  const narrow=await measure();report.measurements.narrow=narrow
  assert(narrow.overflow&&narrow.reachable)
  assert(narrow.full.left-narrow.add.right<=8)
  report.checks.push('narrow window keeps add reachable without overlapping window controls')
  for(let i=0;i<15;i++)await evaluate(`document.querySelector('.workspace-tab-strip .workspace-active-item:last-child .workspace-active-close').click()`)
  await harness.waitFor(()=>evaluate(`document.querySelectorAll('.workspace-tab-strip .workspace-active-item').length===1`),20_000,'closed surplus tabs')
  await delay(400)
  const closed=await measure();report.measurements.closed=closed
  assert.equal(closed.overflow,false)
  assert(closed.add.left-closed.last.right>=0&&closed.add.left-closed.last.right<=8)
  assert(closed.reachable)
  report.checks.push('closing surplus tabs returns add to the last tab')
  report.ok=true
} finally {
  client?.close()
  if(electron)await harness.forceTerminate(electron).catch(()=>undefined)
  await provider.close()
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  process.stdout.write(JSON.stringify(report)+'\n')
}
