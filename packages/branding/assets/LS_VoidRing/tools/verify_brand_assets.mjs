import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const deps=process.env.CODEX_ASSET_NODE_MODULES??path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const sharp=require(path.join(deps,'sharp'));
const {chromium}=require(path.join(deps,'playwright'));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'ls-void-ring-preview-'));
const report={date:'2026-10-02',static:[],motion:[],previewFps:30,previewFrames:216};
for(const folder of ['icon_sizes','icon_sizes_low_glow'])for(const n of [1024,512,256,128,64,32]) {
 const img=sharp(path.join(root,`icon/${folder}/${n}x${n}.png`));const {data,info}=await img.ensureAlpha().raw().toBuffer({resolveWithObject:true});
 assert.equal(info.width,n);assert.equal(info.height,n);
 assert.equal(data[3],0,'tile corner must be transparent');
 const cx=Math.round(n*480/1024),cy=Math.round(n*530/1024),off=(cy*n+cx)*4;
 assert.equal(data[off+3],255,'sphere center must be opaque');
 assert.ok(Math.max(...data.subarray(off,off+3))<24,'sphere center remains near-black, without erasing reflected light');
 if(n>=128){
  const rx=Math.round((480+.8*310*Math.cos(-20*Math.PI/180))*n/1024),ry=Math.round((530+.8*310*Math.sin(-20*Math.PI/180))*n/1024),ri=(ry*n+rx)*4;
  assert.ok(data[ri]>25&&data[ri]>data[ri+2],'warm reflected light must remain INSIDE the sphere, instead of a flat black disk');
 }
 const edge=(Math.round(n*.5)*n+Math.round(n*.05))*4;
 assert.deepEqual([...data.subarray(edge,edge+4)],[0,0,0,255],'tile background must be pure black');
 report.static.push({folder,size:n,dimensions:true,darkOpaqueSphere:true,blackBackground:true,transparentCorner:true});
}
const ico=await fs.readFile(path.resolve(root,'../../../app/resources/littlesheep.ico'));
assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),7);
report.icoSizes=Array.from({length:7},(_,i)=>ico[6+i*16]||256);assert.deepEqual(report.icoSizes,[16,24,32,48,64,128,256]);
assert.deepEqual(await fs.readFile(path.join(root,'icon/icon_master.png')),await fs.readFile(path.resolve(root,'../../../app/resources/littlesheep-icon.png')));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH??'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
 const page=await browser.newPage({viewport:{width:1200,height:1500},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(root,'preview.html')).href);await page.waitForFunction(()=>window.animationReady);
 await page.evaluate(()=>Object.values(window.animations).forEach(a=>a.pause()));
 const diff=async(a,b)=>{const ra=await sharp(a).raw().toBuffer(),rb=await sharp(b).raw().toBuffer();let sum=0;for(let i=0;i<ra.length;i++)sum+=Math.abs(ra[i]-rb[i]);return sum/ra.length;};
 for(const [name,total]of [['idle_breath',216],['loading_orbit',120],['thinking_pulse',192],['open_transition',25.2]]) {
  const json=JSON.parse(await fs.readFile(path.join(root,`motion/${name}.json`),'utf8'));
  assert.equal(json.fr,60);assert.equal(json.op,total);assert.ok(json.layers.length>0);assert.ok(json.assets.every(a=>a.p.startsWith('data:image/png;base64,')));
  const stage=page.locator('#'+name);assert.ok(await stage.locator('svg image').count()>=json.layers.length);
  await page.evaluate(n=>animations[n].goToAndStop(0,true),name);const first=await stage.screenshot();
  await page.evaluate(([n,t])=>animations[n].goToAndStop(t,true),[name,total/2]);const mid=await stage.screenshot();
  const change=await diff(first,mid);assert.ok(change>.01,name+' must visibly animate');
  const result={name,fps:60,durationMs:total/60*1000,lottieLoaded:true,midFrameDifference:change};
  if(name!=='open_transition') {
   await page.evaluate(([n,t])=>animations[n].goToAndStop(t,true),[name,total-.001]);result.loopSeamDifference=await diff(first,await stage.screenshot());
   await page.evaluate(n=>animations[n].goToAndStop(2,true),name);result.adjacentFrameDifference=await diff(first,await stage.screenshot());
   assert.ok(result.loopSeamDifference<Math.max(.1,result.adjacentFrameDifference*2),'loop seam must be no larger than normal adjacent-frame motion');
   const one=await sharp(first).removeAlpha().raw().toBuffer({resolveWithObject:true}),two=await sharp(mid).removeAlpha().raw().toBuffer();
   const width=one.info.width,height=one.info.height,art=Math.min(width,height),ox=(width-art)/2,oy=(height-art)/2;
   const bodyLayer=json.layers.find(l=>l.refId==='sphere');
   assert.ok(bodyLayer&&Object.values(bodyLayer.ks).every(v=>v.a===0),'black body geometry and transform must be static');
   const body=await sharp(path.join(root,'motion/sphere_foreground.png')).ensureAlpha().raw().toBuffer();
   for(const [x,y]of [[480,530],[700,530],[480,750]])assert.deepEqual([...body.subarray((y*1024+x)*4,(y*1024+x)*4+4)],[0,0,0,255]);
   const sums=[0,0,0,0],counts=[0,0,0,0];let innerSum=0,innerCount=0,rimSum=0,rimCount=0;
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const dx=(x-ox)*1024/art-480,dy=(y-oy)*1024/art-530,r=Math.hypot(dx,dy),i=(y*width+x)*3;
    const delta=(Math.abs(one.data[i]-two[i])+Math.abs(one.data[i+1]-two[i+1])+Math.abs(one.data[i+2]-two[i+2]))/3;
    if(r>230&&r<298){innerSum+=delta;innerCount++;}
    if(r>300&&r<332){rimSum+=delta;rimCount++;}
    if(r>340&&r<435){const sector=Math.abs(dx)>Math.abs(dy)?dx>0?0:2:dy>0?1:3;sums[sector]+=delta;counts[sector]++;}
   }
   result.blackBodyGeometryStationary=true;
   result.innerReflectionChange=innerSum/innerCount;assert.ok(result.innerReflectionChange>.05,'inner reflected light must animate');
   result.refractedRimChange=rimSum/rimCount;assert.ok(result.refractedRimChange>.05,'refracted rim must animate together with the halo');
   result.outerHaloChange=Object.fromEntries(['right','bottom','left','top'].map((key,i)=>[key,sums[i]/counts[i]]));
   assert.ok(Object.values(result.outerHaloChange).every(v=>v>.05),'the broad halo must move in all four directions, not just a bright edge arc');
  } else {
   await page.evaluate(([n,t])=>animations[n].goToAndStop(t,true),[name,total-.001]);
   const lastShot=await stage.screenshot();await fs.writeFile(path.join(root,'qa/open_transition_final.png'),lastShot);
   const meta=await sharp(lastShot).metadata();
   const last=await sharp(lastShot).extract({left:24,top:24,width:meta.width-48,height:meta.height-48}).removeAlpha().raw().toBuffer();result.finalMeanBrightness=[...last].reduce((a,b)=>a+b,0)/last.length;assert.ok(result.finalMeanBrightness<.1,'transition fades to background');
  }
  await fs.writeFile(path.join(root,`qa/${name}_mid.png`),mid);report.motion.push(result);
 }
 // Capture actual player output, with replay only in the demonstration timeline.
 await page.evaluate(()=>{window.idleFrames=[]});
 for(let i=0;i<216;i++) {
  await page.evaluate(seconds=>{
   for(const[name,a]of Object.entries(animations)) {
    const duration=VOID_RING_DATA[name].op;
    const frame=name==='open_transition'?Math.min((seconds%1.8)*60,duration-.001):(seconds*60)%duration;
    a.goToAndStop(frame,true);
   }
  },i/30);
  await page.locator('#motion-grid').screenshot({path:path.join(temp,String(i).padStart(3,'0')+'.png')});
  if(i<108)await page.locator('#idle_breath').screenshot({path:path.join(temp,'idle_'+String(i).padStart(3,'0')+'.png')});
 }
 await page.evaluate(()=>Object.values(animations).forEach(a=>a.goToAndStop(a.totalFrames/4,true)));
 await page.screenshot({path:path.join(root,'qa/browser_preview.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'mobile preview should not overflow');
 const reduced=await browser.newPage({viewport:{width:1200,height:1000},reducedMotion:'reduce'});await reduced.goto(pathToFileURL(path.join(root,'preview.html')).href);await reduced.waitForFunction(()=>window.animationReady);
 assert.ok(await reduced.evaluate(()=>Object.values(animations).every(a=>a.isPaused)));report.reducedMotion=true;
 // An actual 4 × 8 PNG frame atlas, with transparent exterior, from the player.
 await page.setViewportSize({width:1200,height:1000});
 await page.evaluate(()=>{document.querySelector('main').style.display='none';document.body.style.background='transparent';const host=document.createElement('div');host.id='atlas-player';Object.assign(host.style,{position:'fixed',left:'0',top:'0',width:'256px',height:'256px'});document.body.append(host)});
 const cells=[];let row=0;
 for(const name of ['idle_breath','loading_orbit','thinking_pulse','open_transition']) {
  await page.evaluate(n=>new Promise(resolve=>{window.atlasAnimation=lottie.loadAnimation({container:document.getElementById('atlas-player'),renderer:'svg',autoplay:false,loop:false,animationData:structuredClone(VOID_RING_DATA[n])});atlasAnimation.addEventListener('DOMLoaded',resolve)}),name);
  for(let col=0;col<8;col++) {
   await page.evaluate(([n,c])=>atlasAnimation.goToAndStop(c*VOID_RING_DATA[n].op/(n==='open_transition'?7:8),true),[name,col]);
   cells.push({input:await page.locator('#atlas-player').screenshot({omitBackground:true}),left:col*256,top:row*256});
  }
  await page.evaluate(()=>{atlasAnimation.destroy();document.getElementById('atlas-player').replaceChildren()});row++;
 }
 await sharp({create:{width:2048,height:1024,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(cells).png().toFile(path.join(root,'motion/motion_spec.png'));
 report.motionAtlas={width:2048,height:1024,rows:4,columns:8,cellSize:256,transparentExterior:true};
 assert.deepEqual(errors,[]);report.browserErrors=errors;
}finally{await browser.close();}
report.previewFrameDirectory=temp;
await fs.writeFile(path.join(root,'qa/validation.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
