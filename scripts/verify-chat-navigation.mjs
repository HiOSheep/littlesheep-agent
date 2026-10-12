import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElectronHarness,delay } from './lib/electron-cdp-harness.mjs'
const harness=createElectronHarness()
await harness.assertBuildFresh()
const root=await mkdtemp(join(tmpdir(),'ls-chat-navigation-')),dataDir=join(root,'data'),id='navigation-fixture',title='长对话导航与名称编辑'
await mkdir(join(dataDir,'sessions'),{recursive:true})
await mkdir(join(dataDir,'workplace'),{recursive:true})
const now=Date.now(),lines=[JSON.stringify({type:'metadata',metadata:{title,model:'',createdAt:new Date(now-24000).toISOString(),updatedAt:new Date(now).toISOString(),messageCount:24}})]
for(let i=0;i<24;i++)lines.push(JSON.stringify({id:`nav-${i}`,role:i%2?'assistant':'user',sessionId:id,timestamp:new Date(now-24000+i*1000).toISOString(),content:[{type:'text',text:i%2?`第 ${Math.floor(i/2)+1} 轮结果与验证\n\n`+('这里是用于检查长对话跳转的独立测试内容。正文应保持可读，点击左侧刻度应定位到对应消息。\n\n').repeat(8):`第 ${Math.floor(i/2)+1} 个问题：检查导航、预览与阅读位置`}]}))
await writeFile(join(dataDir,'sessions',id+'.jsonl'),lines.join('\n')+'\n')
await writeFile(join(dataDir,'sessions.json'),JSON.stringify({sessions:[{id,title,createdAt:now-24000,lastMessageAt:now,scope:'standalone',mode:'research'}]}))
await writeFile(join(dataDir,'config.json'),JSON.stringify({version:1,providers:[],agents:{defaults:{workspace:join(dataDir,'workplace'),model:'',harness:'core-flow'}}}))
const port=await harness.reservePort(),child=await harness.startElectron({dataDir,chromiumDir:join(root,'chromium'),debuggingPort:port,logPath:join(root,'electron.log')})
let client
const checks=[]
async function point(selector){return client.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`)}
async function mouse(type,p){await client.send('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1})}
async function click(selector){const p=await point(selector);await mouse('mouseMoved',p);await mouse('mousePressed',p);await mouse('mouseReleased',p);await delay(120)}
async function key(key,code,windowsVirtualKeyCode){await client.send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode});await client.send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode});await delay(120)}
async function shot(name){const image=await client.send('Page.captureScreenshot',{format:'png'});await writeFile(join(root,name+'.png'),Buffer.from(image.data,'base64'))}
try{
 const locator=await harness.waitForLocator(dataDir,child.pid)
 await harness.desktopAction(locator,'resize',{width:1280,height:900});await harness.desktopAction(locator,'show')
 client=await harness.connectRenderer(port)
 await harness.waitFor(()=>client.evaluate('!!document.querySelector(".session-item")'),30000)
 await client.evaluate(`([...document.querySelectorAll('.session-item')].find(el=>el.textContent.includes(${JSON.stringify(title)}))).click()`)
 await harness.waitFor(()=>client.evaluate('document.querySelectorAll(".chat-turn-trigger").length===24'),20000)
 const rail=await client.evaluate(`(() => {const r=document.querySelector('.chat-turn-rail').getBoundingClientRect(),c=document.querySelector('.chat').getBoundingClientRect();return {left:r.left-c.left,width:r.width,count:document.querySelectorAll('.chat-turn-trigger').length}})()`)
 assert(rail.left>=0&&rail.left<=8&&rail.width<=36)
 await shot('chat-navigation-idle')
 await mouse('mouseMoved',await point('.chat-turn-trigger:nth-child(15)'));await delay(200)
 assert(await client.evaluate('!!document.querySelector(".chat-turn-panel")'))
 assert.equal(await client.evaluate('!!document.querySelector(".chat-turn-search")'),false)
 await shot('chat-navigation-hover')
 const panel=await client.evaluate(`(() => {const p=document.querySelector('.chat-turn-panel').getBoundingClientRect(),c=document.querySelector('.chat').getBoundingClientRect();return {left:p.left,right:p.right,chatLeft:c.left,chatRight:c.right,top:p.top,bottom:p.bottom,height:innerHeight}})()`)
 assert(panel.left>=panel.chatLeft&&panel.right<=panel.chatRight+1&&panel.top>=0&&panel.bottom<=panel.height)
 await mouse('mouseMoved',{x:1,y:1});await delay(200)
 assert.equal(await client.evaluate('!!document.querySelector(".chat-turn-panel")'),false)
 await click('.chat-turn-trigger:nth-child(9)');await delay(350)
 const jump=await client.evaluate(`(() => {const msg=document.querySelector('[data-message-key="nav-8"]').getBoundingClientRect(),view=document.querySelector('.messages').getBoundingClientRect();return {offset:msg.top-view.top,scroll:document.querySelector('.messages').scrollTop}})()`)
 assert(jump.scroll>0&&jump.offset>=0&&jump.offset<40)
 checks.push({name:'left marks, hover preview, dismissal and correct message jump',rail,panel,jump})
 await click('.chat-header .running-pill')
 assert(await client.evaluate('!!document.querySelector(".running-pill-rename-input")'))
 await client.send('Input.insertText',{text:'已修改的长对话名称'});await key('Enter','Enter',13)
 await harness.waitFor(()=>client.evaluate('document.querySelector(".chat-header .running-pill-title")?.textContent==="已修改的长对话名称"'),10000)
 await click('.chat-header .running-pill');await client.send('Input.insertText',{text:'不应保存的草稿'});await key('Escape','Escape',27)
 assert.equal(await client.evaluate('document.querySelector(".chat-header .running-pill-title").textContent'),'已修改的长对话名称')
 const stored=JSON.parse(await readFile(join(dataDir,'sessions.json'),'utf8'))
 assert.equal(stored.sessions.find(s=>s.id===id).title,'已修改的长对话名称')
 checks.push('single click rename, Enter persist and Escape cancel')
 await client.send('Page.reload');await delay(800)
 await harness.waitFor(()=>client.evaluate('document.querySelector(".chat-header .running-pill-title")?.textContent==="已修改的长对话名称"'),20000)
 await mouse('mouseMoved',await point('.chat-turn-trigger:nth-child(11)'));await delay(150);await click('.chat-turn-expand')
 assert(await client.evaluate('!!document.querySelector(".chat-turn-search")'))
 assert.equal(await client.evaluate('document.querySelectorAll(".chat-turn-entry").length'),12)
 await key('Escape','Escape',27)
 assert.equal(await client.evaluate('!!document.querySelector(".chat-turn-panel")'),false)
 checks.push('rename survives reload and full directory stays available')
 await harness.desktopAction(locator,'resize',{width:800,height:660});await delay(350)
 await client.evaluate("Object.assign(document.querySelector('.chat').style,{maxWidth:'320px',width:'320px',minWidth:'0'})");await delay(250)
 await mouse('mouseMoved',await point('.chat-turn-trigger:nth-child(11)'));await delay(200)
 assert.equal(await client.evaluate('document.querySelector(".messages").scrollWidth>document.querySelector(".messages").clientWidth'),false)
 const narrow=await client.evaluate(`(() => {const p=document.querySelector('.chat-turn-panel').getBoundingClientRect(),c=document.querySelector('.chat').getBoundingClientRect();return {right:p.right,chatRight:c.right,width:p.width}})()`)
 assert(narrow.right<=narrow.chatRight+1)
 await shot('chat-navigation-narrow');checks.push({name:'320px chat bounds and no horizontal transcript overflow',narrow})
 await writeFile(join(root,'report.json'),JSON.stringify({status:'passed',root,checks},null,2))
 console.log(JSON.stringify({status:'passed',root,checks},null,2))
}finally{client?.close();if(child.exitCode===null)await harness.forceTerminate(child)}
