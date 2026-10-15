// Real Electron review of application-drawn icon families at their actual shared CSS weight.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness, repoRoot } from './lib/electron-cdp-harness.mjs'
import { startElectronAcceptanceProvider } from './lib/electron-acceptance-provider.mjs'

const harness=createElectronHarness()
const root=await mkdtemp(join(tmpdir(),'ls-iconography-'))
const appRequire=createRequire(join(repoRoot,'packages/app/package.json'))
const {build}=createRequire(appRequire.resolve('vite'))('esbuild')
const galleryPath=join(root,'gallery.cjs')
await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import * as icons from './src/renderer/ui/icons.tsx';
import * as message from './src/renderer/ui/message-icons.tsx';
import * as state from './src/renderer/ui/state-icons.tsx';
import * as browser from './src/renderer/ui/browser-icons.tsx';
import {ActivityGlyph} from './src/renderer/chat/activity-glyph.tsx';
const rows=Object.entries({...icons,...message,...state,...browser}).filter(([name,value])=>typeof value==='function'&&/Icon$/.test(name)).map(([name,value])=>({name,markup:renderToStaticMarkup(React.createElement(value,{}))}));
for(const id of ['review','artifacts','terminal','context','browser','sideChat'])rows.push({name:id,markup:renderToStaticMarkup(React.createElement(icons.WorkspaceFeatureIcon,{id}))});
for(const kind of ['reasoning','system','context_injection','cross_session_recall','context_compaction','pending'])rows.push({name:kind,markup:renderToStaticMarkup(React.createElement(ActivityGlyph,{kind}))});
export default rows;`,resolveDir:join(repoRoot,'packages/app'),sourcefile:'icon-gallery.tsx',loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.svg':'dataurl'},outfile:galleryPath,logLevel:'silent'})
const gallery=createRequire(import.meta.url)(galleryPath).default
const provider=await startElectronAcceptanceProvider()
const dataDir=join(root,'data'),chromiumDir=join(root,'chromium'),workspace=join(root,'workspace')
let electron,client
const report={ok:false,root,checks:[],screenshots:[]}
try {
  await harness.assertBuildFresh()
  await Promise.all([mkdir(dataDir),mkdir(chromiumDir),mkdir(workspace)])
  await writeFile(join(dataDir,'config.json'),JSON.stringify({version:1,providers:[{id:'acceptance',name:'Acceptance',baseURL:provider.baseURL,apiKey:'fixture',models:['slow-a']}],agents:{defaults:{model:'acceptance/slow-a',workspace}}}))
  const port=await harness.reservePort()
  electron=await harness.startElectron({dataDir,chromiumDir,debuggingPort:port,logPath:join(root,'electron.log')})
  const locator=await harness.waitForLocator(dataDir,electron.pid)
  await harness.waitForDesktop(locator)
  await harness.desktopAction(locator,'park-offscreen')
  await harness.desktopAction(locator,'resize',{width:1280,height:900})
  client=await harness.connectRenderer(port)
  await harness.waitFor(()=>client.evaluate(`!!document.querySelector('.composer textarea')`),60_000,'renderer')
  const screenshot=async name=>{const shot=await client.send('Page.captureScreenshot',{format:'png'});const path=join(root,name+'.png');await writeFile(path,Buffer.from(shot.data,'base64'));report.screenshots.push(path)}
  await screenshot('application')
  await client.evaluate(`(() => {const panel=document.createElement('section');panel.id='iconography-review';Object.assign(panel.style,{position:'fixed',left:'270px',right:'20px',top:'70px',bottom:'24px',overflow:'auto',zIndex:'3000',background:'var(--bg)',padding:'16px',display:'grid',gridTemplateColumns:'repeat(7,minmax(0,1fr))',gap:'8px',alignContent:'start'});for(const row of ${JSON.stringify(gallery)}){const cell=document.createElement('div');cell.dataset.icon=row.name;if(row.name==='ModeRiskIcon')cell.className='mode-option risk-low';Object.assign(cell.style,{height:'76px',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:'10px',borderRadius:'10px',background:'var(--surface)'});cell.innerHTML=row.markup;const svg=cell.querySelector('svg');if(svg){svg.style.width='20px';svg.style.height='20px'}const label=document.createElement('span');label.textContent=row.name;Object.assign(label.style,{fontSize:'10px',color:'var(--muted)',maxWidth:'100%',overflow:'hidden'});cell.append(label);panel.append(cell)}document.body.append(panel)})()`)
  for(const theme of ['dark','light']) {
    await client.evaluate(`document.documentElement.dataset.lsTheme=${JSON.stringify(theme)}`)
    for(const size of [16,20]) {
      await client.evaluate(`document.querySelectorAll('#iconography-review svg').forEach(svg=>{svg.style.width='${size}px';svg.style.height='${size}px'})`)
      const samples=await client.evaluate(`Array.from(document.querySelectorAll('#iconography-review svg :is(path,rect,circle,ellipse,line,polyline,polygon)')).flatMap(e=>{const s=getComputedStyle(e);return s.stroke==='none'?[]:[{icon:e.closest('[data-icon]').dataset.icon,stroke:s.strokeWidth,vector:s.vectorEffect}]})`)
      assert(samples.length>70,'gallery must cover the shared families')
      for(const sample of samples) {assert.equal(sample.stroke,'1.1px',JSON.stringify(sample));assert.equal(sample.vector,'non-scaling-stroke',JSON.stringify(sample))}
      report.checks.push(`${theme} ${size}px: ${samples.length} stroked shapes share 1.1px optical weight`)
    }
    await screenshot('icons-'+theme)
  }
  report.ok=true
} finally {
  client?.close()
  if(electron)await harness.forceTerminate(electron).catch(()=>undefined)
  await provider.close()
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
  process.stdout.write(JSON.stringify(report)+'\n')
}
