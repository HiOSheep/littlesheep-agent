/** Coupled inner reflection, refracted rim and outer fluid light; black body is fixed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const sharp=require(process.env.SHARP_MODULE??path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'));
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const C=[480,530], R=310, SIZE=384, BAKE_FPS=30;
export const MOTION_STATES={idle_breath:{frames:216,loop:true},loading_orbit:{frames:120,loop:true},thinking_pulse:{frames:192,loop:true},open_transition:{frames:25.2,loop:false}};
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const smooth=x=>{x=clamp(x);return x*x*(3-2*x)};
const still=k=>({a:0,k});
const ease=(keys,mode='smooth')=>({a:1,k:keys.map(([t,s],i)=>({t,s:Array.isArray(s)?s:[s],...(i<keys.length-1?{o:{x:[mode==='linear'?.333:mode==='open'?.22:.42],y:[mode==='linear'?.333:mode==='open'?1:0]},i:{x:[mode==='linear'?.667:mode==='open'?.36:.58],y:[mode==='linear'?.667:1]}}:{})}))});
const layer=(ind,nm,refId,op,size=1024,ip=0)=>({ddd:0,ind,ty:2,nm,refId,sr:1,ks:{o:still(100),r:still(0),p:still([...C,0]),a:still([C[0]*size/1024,C[1]*size/1024,0]),s:still([102400/size,102400/size,100])},ao:0,ip,op,st:0,bm:0});
const asset=(id,png,size)=>({id,w:size,h:size,u:'',p:'data:image/png;base64,'+png.toString('base64'),e:1});
async function foreground() {
 return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="${C[0]}" cy="${C[1]}" r="${R}" fill="#000000"/></svg>`)).png().toBuffer();
}
function sample(data,x,y,ch) {
 x=clamp(x,0,511);y=clamp(y,0,511);
 const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,nx=Math.min(511,ix+1),ny=Math.min(511,iy+1);
 return (data[(iy*512+ix)*3+ch]*(1-fx)+data[(iy*512+nx)*3+ch]*fx)*(1-fy)+(data[(ny*512+ix)*3+ch]*(1-fx)+data[(ny*512+nx)*3+ch]*fx)*fy;
}
function haloFrame(name,phase,source) {
 const out=Buffer.alloc(SIZE*SIZE*4),w=phase*Math.PI*2;
 for(let py=0;py<SIZE;py++)for(let px=0;px<SIZE;px++) {
  const x=(px+.5)*1024/SIZE,y=(py+.5)*1024/SIZE,dx=x-C[0],dy=y-C[1],r=Math.hypot(dx,dy),a=Math.atan2(dy,dx),d=r-R;
  if(d>280)continue;
  const env=smooth(d/70)*Math.exp(-Math.pow(d/240,2)),inner=smooth(r/R);
  // Integer spatial/temporal harmonics guarantee a seamless return to phase zero.
  const wave=.52*Math.sin(3*a-w)+.30*Math.sin(5*a+2*w)+.18*Math.sin(2*a-3*w);
  // Light leads, the broad corona follows: a shared angular sway keeps the rim
  // attached while the radial phase lag gives the glow a soft trailing response.
  const lag=env*.72;
  let stretch,shift,turn,gain,ripple,sway;
  if(name==='idle_breath') {
   sway=.18*Math.sin(w)+.055*Math.sin(2*w+.4);
   stretch=1+.085*Math.sin(w-lag);
   shift=env*(22*Math.sin(w-lag)+32*wave);
   turn=sway+.13*env*Math.sin(2*a+w-lag);
   gain=.94+.13*Math.sin(w+.4-lag)+.16*wave*env;
   ripple=.038*(.72+.28*Math.sin(w-2*a-lag));
  } else if(name==='loading_orbit') {
   sway=-w+.24*Math.sin(w);
   stretch=1+.095*Math.sin(2*w+2*a-lag);
   shift=env*(28*wave+13*Math.sin(w+4*a-lag));
   turn=sway+.21*env*Math.sin(3*a-2*w-lag);
   gain=.97+.19*Math.sin(3*a-w-lag)*env;
   ripple=.05*(.7+.3*Math.sin(3*a-w-lag));
  } else {
   sway=.27*Math.sin(w)+.09*Math.sin(2*w-.5);
   stretch=1+.12*Math.sin(w-lag)+.045*Math.sin(2*w-lag);
   shift=env*(36*wave+18*Math.sin(2*w-2*a-lag));
   turn=sway+.22*env*Math.sin(w+2*a-lag);
   gain=.92+.17*Math.sin(w+.6-lag)+.12*Math.sin(2*w-.3-lag);
   ripple=.048*(.65+.35*Math.sin(2*w-a-lag));
  }
  const outerR=R+(d-shift)/stretch;
  const innerR=r*(1+.008*Math.sin(w)+.006*wave*inner);
  const innerTurn=sway+.035*Math.sin(2*a+w)*inner;
  const blend=smooth((r-(R-18))/64);
  const sr=innerR*(1-blend)+outerR*blend,sa=a+innerTurn*(1-blend)+turn*blend,sx=(C[0]+sr*Math.cos(sa))/2,sy=(C[1]+sr*Math.sin(sa))/2;
  const rippleCenter=R+53+25*wave+13*Math.sin(w-a);
  const fog=ripple*Math.exp(-Math.pow((r-rippleCenter)/43,2))*smooth(d/12);
  // Broad travelling reflection, never a separate particle or a flashing point.
  const caustic=(.5+.5*Math.cos(a+w+.5))**7;
  const rimGain=1+.16*caustic*Math.exp(-Math.pow(d/28,2));
  // Very faint liquid shoulders carry breathing to left/bottom as well as crown.
  const cool=.5+.5*Math.cos(a-3.55),blue=[48,105,255],warm=[255,157,121];
  const lightGain=r<R?1+(gain-1)*inner:gain;
  const rgb=[0,1,2].map(ch=>clamp(sample(source,sx,sy,ch)*lightGain*rimGain+255*fog*(blue[ch]*cool+warm[ch]*(1-cool))/255,0,255));
  const alpha=Math.max(...rgb),j=(py*SIZE+px)*4;
  if(alpha<.65)continue;
  out[j+3]=Math.round(alpha);
  for(let ch=0;ch<3;ch++)out[j+ch]=Math.round(rgb[ch]*255/alpha);
 }
 return out;
}
function document(name,assets,layers) {
 const config=MOTION_STATES[name];
 return {v:'5.12.2',fr:60,ip:0,op:config.frames,w:1024,h:1024,nm:'LS / living light / '+name,ddd:0,assets,layers,markers:[],meta:{generator:'LS periodic polar fluid field',loop:config.loop,durationMs:config.frames/60*1000,bakedHaloFps:BAKE_FPS,haloResolution:SIZE,foregroundResolution:1024,background:'#000000',motionModel:'coupled inner reflection, refracted rim and outer-corona fluid displacement',blackBodyStationary:name!=='open_transition'}};
}
function svgReference(name,body,halo) {
 const seconds=MOTION_STATES[name].frames/60;
 const photo='data:image/png;base64,'+body.toString('base64'),light='data:image/png;base64,'+halo.toString('base64');
 const flow=name==='loading_orbit'?'0 480 530;360 480 530':name==='thinking_pulse'?'-7 480 530;9 480 530;-7 480 530':'-2 480 530;3 480 530;-2 480 530';
 if(name==='open_transition')return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>Sphere and whole corona / open</title><g transform="translate(480 530)"><g class="open"><image href="${photo}" x="-480" y="-530" width="1024" height="1024"/><animateTransform attributeName="transform" type="scale" values=".24;1;6.4" keyTimes="0;.285714;1" calcMode="spline" keySplines=".22 1 .36 1;.22 1 .36 1" dur=".42s" fill="freeze"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;.714286;1" dur=".42s" fill="freeze"/></g></g><style>@media(prefers-reduced-motion:reduce){.open{transform:scale(1)!important;opacity:1!important}}</style></svg>`;
 return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><title>Living inner and outer light ${name} / SVG reference</title><defs><filter id="water" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".007 .012" numOctaves="2" seed="13" result="flow"/><feDisplacementMap in="SourceGraphic" in2="flow" scale="18" xChannelSelector="R" yChannelSelector="G"><animate attributeName="scale" values="12;42;12" dur="${seconds}s" repeatCount="indefinite"/></feDisplacementMap></filter></defs><image href="${photo}" width="1024" height="1024"/><g class="corona" filter="url(#water)"><image href="${light}" width="1024" height="1024"/><animateTransform attributeName="transform" type="rotate" values="${flow}" dur="${seconds}s" repeatCount="indefinite"/><animate attributeName="opacity" values=".78;1;.78" dur="${seconds}s" repeatCount="indefinite"/></g><style>@media(prefers-reduced-motion:reduce){.corona{filter:none!important;transform:none!important;opacity:1!important}}</style></svg>`;
}
export async function generateFluidMotion({referencesOnly=false}={}) {
 const source=await sharp(path.join(ROOT,'qa/sphere_framing_reference.png')).resize(512,512).removeAlpha().raw().toBuffer();
 const body=await foreground();await fs.writeFile(path.join(ROOT,'motion/sphere_foreground.png'),body);
 const mark=await fs.readFile(path.join(ROOT,'motion/void_ring_mark.png'));
 const fullRGB=await sharp(path.join(ROOT,'qa/sphere_framing_reference.png')).removeAlpha().raw().toBuffer();
 const lightRGBA=Buffer.alloc(1024*1024*4);
 for(let i=0;i<1024*1024;i++){const alpha=Math.max(fullRGB[i*3],fullRGB[i*3+1],fullRGB[i*3+2]);if(alpha<=3)continue;lightRGBA[i*4+3]=alpha;for(let ch=0;ch<3;ch++)lightRGBA[i*4+ch]=Math.round(fullRGB[i*3+ch]*255/alpha);}
 const staticHalo=await sharp(lightRGBA,{raw:{width:1024,height:1024,channels:4}}).png().toBuffer();
 await fs.writeFile(path.join(ROOT,'motion/illumination_reference.png'),staticHalo);
 const animations={};
 for(const name of ['idle_breath','loading_orbit','thinking_pulse']) {
  if(referencesOnly){await fs.writeFile(path.join(ROOT,`motion/${name}.svg`),svgReference(name,body,staticHalo));continue;}
  const total=MOTION_STATES[name].frames,count=total/2,assets=[asset('sphere',body,1024)],layers=[];
  const folder=path.join(ROOT,'motion/fluid_frames',name);await fs.mkdir(folder,{recursive:true});
  for(let i=0;i<count;i++) {
   const png=await sharp(haloFrame(name,i/count,source),{raw:{width:SIZE,height:SIZE,channels:4}}).png({compressionLevel:9}).toBuffer();
   await fs.writeFile(path.join(folder,String(i).padStart(3,'0')+'.png'),png);
   assets.push(asset('fluid_'+i,png,SIZE));layers.push(layer(i+2,'Inner and outer light / fluid sample '+i,'fluid_'+i,(i+1)*2,SIZE,i*2));
  }
  layers.push(layer(1,'Black sphere body / fixed geometry','sphere',total));
  animations[name]=document(name,assets,layers);
  await fs.writeFile(path.join(ROOT,`motion/${name}.svg`),svgReference(name,body,staticHalo));
  console.log('Rendered whole-corona flow:',name,count,'frames');
 }
 const openLayer=layer(1,'Sphere and complete corona / open','mark',25.2);
 openLayer.ks.s=ease([[0,[24,24,100]],[7.2,[100,100,100]],[25.2,[640,640,100]]],'open');
 openLayer.ks.o=ease([[0,100],[18,100],[25.2,0]],'linear');
 animations.open_transition=document('open_transition',[asset('mark',mark,1024)],[openLayer]);
 await fs.writeFile(path.join(ROOT,'motion/open_transition.svg'),svgReference('open_transition',mark,staticHalo));
 if(!referencesOnly){
  for(const[name,data]of Object.entries(animations))await fs.writeFile(path.join(ROOT,`motion/${name}.json`),JSON.stringify(data));
  await fs.writeFile(path.join(ROOT,'preview/animations.js'),'window.VOID_RING_DATA = '+JSON.stringify(animations)+';\n');
  await fs.writeFile(path.join(ROOT,'motion/fluid_manifest.json'),JSON.stringify({fps:BAKE_FPS,cellSize:SIZE,foreground:'sphere_foreground.png',states:Object.fromEntries(Object.entries(MOTION_STATES).map(([name,s])=>[name,{...s,durationMs:s.frames/60*1000}]))},null,2));
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url))await generateFluidMotion();
