// 真实 Electron 文件预览回归：冷启动首次载入、已预热编辑器、跨格式切换与磁盘内容一致。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, delay } from './lib/electron-cdp-harness.mjs'

const output = process.argv.find(arg=>arg.startsWith('--out='))?.slice(6) || await mkdtemp(join(tmpdir(),'ls-file-preview-evidence-'))
await mkdir(output,{recursive:true})
const h = createElectronHarness({ startTimeoutMs: 90_000 })
const root = await mkdtemp(join(tmpdir(), 'ls-file-preview-'))
const dataDir = join(root, 'data'), chromiumDir = join(root, 'chromium'), workspace = join(dataDir, 'workplace')
const fixtures = {
 'README.md':'# Markdown preview sentinel\n',
 'app.ts':'export const previewSentinel = 42;\n',
 'app.js':'const previewSentinel = 42;\n',
 'main.py':'preview_sentinel = 42\n',
 'package.json':'{ "previewSentinel": 42 }\n',
 'config.yaml':'previewSentinel: 42\n',
 'config.toml':'previewSentinel = 42\n',
 'script.ps1':'Write-Output "previewSentinel"\n',
 'note.txt':'text preview sentinel\n',
 'LICENSE':'generic preview sentinel\n',
 'page.html':'<!doctype html><html><body><h1>HTML preview sentinel</h1></body></html>',
 'empty.txt':'',
 'style.css':'.previewSentinel { color: red; }\n',
 'query.sql':'SELECT previewSentinel FROM test;\n',
 'build.bat':'echo previewSentinel\n',
 'photo.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>',
};
const names=Object.keys(fixtures);
let electron, client
const report = { fixture: 'isolated real Electron preview content regression', output, checks: {} }
const evaluate = code => client.evaluate(code)
async function frame(name, selector) {
  const rect = selector ? await evaluate(`(() => {const element=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.getBoundingClientRect().width>0);const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()`) : undefined
  const shot = await client.send('Page.captureScreenshot', { format:'png', fromSurface:true, ...(rect ? {clip:rect} : {}) })
  await writeFile(join(output,name+'.png'),Buffer.from(shot.data,'base64'))
}
try {
  await h.assertBuildFresh()
  await Promise.all([mkdir(workspace,{recursive:true}),mkdir(chromiumDir,{recursive:true})])
  for (const name of ['docs','packages','scripts','skills']) await mkdir(join(workspace,name))
  await Promise.all(names.map(name => writeFile(join(workspace,name),fixtures[name])))
  await writeFile(join(workspace,'docs','guide.md'),'# Guide\n')
  await writeFile(join(dataDir,'config.json'),JSON.stringify({version:1,providers:[],agents:{defaults:{workspace,model:'',reasoning:'auto',profile:'general',timeoutSeconds:60,maxRecoveryAttempts:1}}}))
  const debuggingPort = await h.reservePort()
  electron = await h.startElectron({dataDir,chromiumDir,debuggingPort,logPath:join(root,'electron.log')})
  const locator = await h.waitForLocator(dataDir,electron.pid)
  await h.waitForDesktop(locator)
  await h.desktopAction(locator,'resize',{width:1280,height:1000})
  await h.desktopAction(locator,'show')
  client = await h.connectRenderer(debuggingPort)
  await evaluate(`(() => {
    const values = {
      'littlesheep.ui.workspacePanelCollapsed':'false',
      'littlesheep.ui.workspacePanelFullscreen':'true',
      'littlesheep.ui.workspacePanelTab':'files',
      'littlesheep.ui.workspacePanelOpenTabs':JSON.stringify(['files']),
      'littlesheep.ui.workspaceFileNavigatorCollapsed':'false',
      'littlesheep.ui.workspaceSessionLayouts':JSON.stringify({__draft__:{collapsed:false,fullscreen:true,activeTab:'files',openTabs:['files'],openRequest:null,fileNavigatorCollapsed:false,expandedPaths:[],drafts:{},browserTabs:[]}})
    };
    for(const [key,value] of Object.entries(values))localStorage.setItem(key,value);
  })()`)
  await client.send('Page.reload',{ignoreCache:true})
  await client.send('Runtime.enable');await client.send('Log.enable');
  await h.waitFor(()=>evaluate(`document.querySelectorAll('.workspace-tree-row.file').length===${names.length}||null`),30_000,'fixture file tree')
  // The persisted layout is hydrated from Main; open a file through the actual UI after hydration.
  await delay(600)
  await evaluate(`[...document.querySelectorAll('.workspace-tree-row.file')].find(row=>row.textContent.trim()==='README.md').click()`)
  await h.waitFor(()=>evaluate(`document.querySelector('.workspace-tab-strip .file-glyph-markdown image')!==null||null`),15_000,'opened file tab format mark')
  await evaluate(`document.querySelector('button[aria-label="全屏展开工作区"]')?.click()`)
  await delay(600)
  report.checks.previews=[];
  for (const name of names) {
    await evaluate(`[...document.querySelectorAll('.workspace-tree-row.file')].find(row=>row.textContent.trim()===${JSON.stringify(name)}).click()`);
    await h.waitFor(()=>evaluate(`!!document.querySelector('.workspace-tab-view.active .workspace-preview-body')||null`),10_000,'active preview body');
    if (!['README.md','page.html','photo.svg'].includes(name)) {
      await h.waitFor(()=>evaluate(`!!document.querySelector('.workspace-tab-view.active .monaco-editor')||null`),15_000,'code editor mount');
    }
    await delay(800);
    const state=await evaluate(`(() => {
      const pane=document.querySelector('.workspace-tab-view.active .workspace-preview-pane') || document.querySelector('.workspace-tab-view.active');
      const body=pane?.querySelector('.workspace-preview-body');
      const editor=body?.querySelector('.monaco-editor'); const img=body?.querySelector('.workspace-preview-media img');const frame=body?.querySelector('iframe');
      return {body:body?.innerText,editor:!!editor,editorHeight:editor?.getBoundingClientRect().height,lines:[...body?.querySelectorAll('.view-line')||[]].map(x=>x.textContent),image:img?{complete:img.complete,width:img.naturalWidth,src:img.src}:null,frame:frame?.src};
    })()`);
    const api=await h.fetchJson(locator,'/workspace/preview?root='+encodeURIComponent(workspace)+'&path='+encodeURIComponent(join(workspace,name)));
    assert.ok(api.ok,name+' preview API failed');
    if(api.body.kind==='text') {
      assert.ok(state.editor,name+' missing editor');
      assert.ok(state.editorHeight>100,name+' collapsed editor');
      const expected=fixtures[name].trim().replace(/\s+/g,'');
      const actual=state.lines.join('\n').replace(/\s+/g,'');
      assert.equal(actual,expected,name+' preview content differs from disk');
    } else if(api.body.kind==='markdown') assert.ok(state.body.includes('Markdown preview sentinel'));
    else if(api.body.kind==='image') assert.equal(state.image?.width,100);
    else if(api.body.kind==='html') { assert.ok(state.frame?.startsWith('http://127.0.0.1:'));assert.ok((await (await fetch(state.frame)).text()).includes('HTML preview sentinel')); }
    report.checks.previews.push({name,kind:api.body.kind,state});
    await frame('preview-'+name.replace(/[^a-z0-9]/gi,'_'));
  }
  // An intentional empty draft is valid: fixing stale empty callbacks must not replace user edits.
  const openFile = name => evaluate(`[...document.querySelectorAll('.workspace-tree-row.file')].find(row=>row.textContent.trim()===${JSON.stringify(name)}).click()`)
  await openFile('app.js')
  await delay(250)
  await evaluate(`[...document.querySelectorAll('.workspace-tab-view.active button')].find(x=>x.textContent.trim()==='编辑').click()`)
  await delay(250)
  await h.waitFor(()=>evaluate(`!!document.querySelector('.workspace-tab-view.active .monaco-editor .native-edit-context, .workspace-tab-view.active .monaco-editor textarea.inputarea')||null`),5000,'Monaco input area')
  await client.send('Page.bringToFront')
  await evaluate(`document.querySelector('.workspace-tab-view.active .monaco-editor .native-edit-context, .workspace-tab-view.active .monaco-editor textarea.inputarea').focus()`)
  await client.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2})
  await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2})
  await client.send('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
  await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8})
  const emptyDraft = () => evaluate(`(() => {const view=document.querySelector('.workspace-tab-view.active');return !!view?.querySelector('.monaco-editor') && [...view.querySelectorAll('.view-line')].every(x=>!x.textContent.trim())})()`)
  await h.waitFor(emptyDraft,5000,'intentional empty draft')
  await openFile('app.ts');await delay(250);await openFile('app.js');await delay(350)
  assert.ok(await emptyDraft(),'switching files replaced an intentional empty draft')
  await delay(600)
  await client.send('Page.reload',{ignoreCache:true})
  await h.waitFor(emptyDraft,15_000,'empty draft after reload')
  await delay(600)
  assert.ok(await emptyDraft(),'loaded preview replaced an intentional empty draft')
  const disk = await h.fetchJson(locator,'/workspace/preview?root='+encodeURIComponent(workspace)+'&path='+encodeURIComponent(join(workspace,'app.js')))
  assert.equal(disk.body.content,fixtures['app.js'],'editing a draft modified the source file')
  report.checks.intentionalEmptyDraftSurvivesSwitchAndReload=true
  report.consoleErrors=client.events.filter(x=>x.method==='Runtime.exceptionThrown');
  assert.deepEqual(report.consoleErrors,[],'uncaught Renderer errors')
  report.status='passed'
} catch(error) {
  report.status='failed';report.error=error.stack
  if(client){report.page=await evaluate(`({text:document.body.innerText.slice(0,4000),rows:document.querySelectorAll('.workspace-tree-row').length})`).catch(()=>null);await frame('file-preview-failure').catch(()=>{})}
  throw error
} finally {
  await writeFile(join(output,'file-preview-validation.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({status:report.status,temp:root,previews:report.checks.previews?.map(x=>({name:x.name,kind:x.kind,state:x.state})),consoleErrors:report.consoleErrors,error:report.error},null,2))
  client?.close();await h.forceTerminate(electron)
}
