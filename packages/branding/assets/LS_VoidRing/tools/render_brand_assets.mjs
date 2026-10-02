/** One original sphere texture for icons/motion; pure-path SVG is a reference. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(process.env.SHARP_MODULE ?? path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp')); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sphereSource=await fs.readFile(path.join(root,'icon/sphere_motion_source.png')).catch(()=>null);
const appResources = path.resolve(root, '../../../app/resources');
const C = [480, 530], R = 310;
const sizes = [1024, 512, 256, 128, 64, 32];
const nativeSizes = [16, 24, 32, 48, 64, 128, 256];
const stops = [[0,'#fff0db',1],[28,'#fff4e5',1],[60,'#ffd0ae',.96],[88,'#e6ad9f',.75],[115,'#8874ae',.50],[145,'#454da8',.40],[180,'#2753d4',.48],[218,'#2863ff',.67],[242,'#5790ff',.9],[260,'#c9dcff',1],[283,'#f1eeff',1],[306,'#fff0ef',1],[333,'#fff0de',1],[360,'#fff0db',1]];
const num = n => Number(n.toFixed(3));
const point = a => [num(C[0]+R*Math.cos(a*Math.PI/180)),num(C[1]+R*Math.sin(a*Math.PI/180))];
function colorAt(a) {
  const i = stops.findIndex(s => s[0] >= a);
  const lo = stops[Math.max(0,i-1)], hi = stops[i];
  const t = hi[0] === lo[0] ? 0 : (a-lo[0])/(hi[0]-lo[0]);
  const channels = s => [1,3,5].map(j => parseInt(s.slice(j,j+2),16));
  const l = channels(lo[1]), h = channels(hi[1]);
  return ['#'+l.map((v,j)=>Math.round(v+(h[j]-v)*t).toString(16).padStart(2,'0')).join(''), lo[2]+(hi[2]-lo[2])*t];
}
function arcs(width) {
  let defs='', paths='';
  for(let a=0;a<360;a+=6) {
    const p=point(a),q=point(a+6),c=colorAt(a),d=colorAt(a+6);
    defs+=`<linearGradient id="g${a}" gradientUnits="userSpaceOnUse" x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}"><stop stop-color="${c[0]}" stop-opacity="${c[1]}"/><stop offset="1" stop-color="${d[0]}" stop-opacity="${d[1]}"/></linearGradient>`;
    paths+=`<path d="M${p} A${R},${R} 0 0 1 ${q}" stroke="url(#g${a})" stroke-width="${width}"/>`;
  }
  return [defs,paths];
}
function vectorReference({ tile=false, low=false, size=1024, highlight=null, auraOnly=false, transform='', opacity=1 }={}) {
  // At 32px use a ~0.8px rim, keeping the cobalt side present after sampling.
  const width = size<=64 ? 1024/size*.78 : size<=128 ? 1024/size*.64 : 2.8;
  const [gradients,ring]=arcs(width);
  const gain = low ? .5 : 1;
  const hp = highlight===null ? null : [point(highlight-17),point(highlight+17)];
  const hd = hp ? `M${hp[0]} A${R},${R} 0 0 1 ${hp[1]}` : '';
  const defs=`<defs>${gradients}
    <filter id="wide" x="-40%" y="-40%" width="180%" height="180%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="15"/></filter>
    <filter id="near" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="5"/></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="8"/></filter>
    <radialGradient id="blue"><stop stop-color="#356bff" stop-opacity=".96"/><stop offset=".5" stop-color="#3155ed" stop-opacity=".42"/><stop offset="1" stop-color="#1a39a2" stop-opacity="0"/></radialGradient>
    <radialGradient id="warm"><stop stop-color="#ffd1a8" stop-opacity=".9"/><stop offset=".45" stop-color="#fc9d7a" stop-opacity=".32"/><stop offset="1" stop-color="#ab6b8c" stop-opacity="0"/></radialGradient>
    <radialGradient id="shoulder"><stop stop-color="#283bc9" stop-opacity=".28"/><stop offset=".74" stop-color="#202b9a" stop-opacity=".13"/><stop offset="1" stop-color="#162266" stop-opacity="0"/></radialGradient>
    <radialGradient id="inner-amber" gradientUnits="userSpaceOnUse" cx="801" cy="470" r="280"><stop stop-color="#dc997b" stop-opacity=".48"/><stop offset=".28" stop-color="#a26756" stop-opacity=".28"/><stop offset=".7" stop-color="#563339" stop-opacity=".10"/><stop offset="1" stop-color="#1a101c" stop-opacity="0"/></radialGradient>
    <radialGradient id="inner-blue" gradientUnits="userSpaceOnUse" cx="571" cy="215" r="310"><stop stop-color="#709aff" stop-opacity=".38"/><stop offset=".22" stop-color="#345297" stop-opacity=".22"/><stop offset=".65" stop-color="#1f2849" stop-opacity=".07"/><stop offset="1" stop-color="#06070e" stop-opacity="0"/></radialGradient>
    <mask id="outside"><rect width="1024" height="1024" fill="white"/><circle cx="${C[0]}" cy="${C[1]}" r="${R-1}" fill="black"/></mask>
  </defs>`;
  let mark = highlight!==null ? `<g fill="none" stroke-linecap="round"><path d="${hd}" stroke="#508aff" stroke-width="13" opacity=".7" filter="url(#wide)"/><path d="${hd}" stroke="#89b3ff" stroke-width="6" opacity=".8" filter="url(#near)"/><path d="${hd}" stroke="#eff5ff" stroke-width="3.5"/></g>` : `
    <g opacity="${gain}" mask="url(#outside)">
      <ellipse cx="625" cy="378" rx="324" ry="300" fill="url(#shoulder)"/>
      <ellipse cx="548" cy="218" rx="244" ry="108" fill="url(#blue)"/>
      <ellipse cx="793" cy="519" rx="98" ry="230" fill="url(#warm)"/>
      <g fill="none" opacity=".9" filter="url(#wide)">${ring.replaceAll(`stroke-width="${width}"`,'stroke-width="22"')}</g>
      <g fill="none" opacity=".85" filter="url(#near)">${ring.replaceAll(`stroke-width="${width}"`,'stroke-width="6"')}</g>
    </g>
    ${auraOnly?'':`<circle cx="${C[0]}" cy="${C[1]}" r="${R-1.4}" fill="#000000"/><circle cx="${C[0]}" cy="${C[1]}" r="${R-1.4}" fill="url(#inner-blue)"/><circle cx="${C[0]}" cy="${C[1]}" r="${R-1.4}" fill="url(#inner-amber)"/><g fill="none">${ring}</g>`}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title"><title id="title">LittleSheep · Void Ring${low?' · low glow':''}</title>${defs}${tile?'<rect width="1024" height="1024" rx="204.8" fill="#000000"/>':''}<g transform="${transform}" opacity="${opacity}">${mark}</g></svg>`;
}
export function svg(options={}) {
  if(options.highlight!==undefined&&options.highlight!==null)return vectorReference(options);
  if(!sphereSource)throw new Error('Missing sphere_motion_source.png: the photographic sphere is the visual authority.');
  const {tile=false,low=false,auraOnly=false,transform='',opacity=1}=options;
  const url='data:image/png;base64,'+sphereSource.toString('base64');
  // Keep the actual sphere material. The SVG explicitly embeds its light texture;
  // recreating it as a uniform black circle is prohibited by the visual contract.
  const defs=`<defs><clipPath id="tile"><rect width="1024" height="1024" rx="204.8"/></clipPath><filter id="mask-soft"><feGaussianBlur stdDeviation="2"/></filter><mask id="outer"><rect width="1024" height="1024" fill="white"/><circle cx="${C[0]}" cy="${C[1]}" r="${R-2}" fill="black" filter="url(#mask-soft)"/></mask><mask id="inner"><circle cx="${C[0]}" cy="${C[1]}" r="${R-2}" fill="white" filter="url(#mask-soft)"/></mask><filter id="low" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope=".5"/><feFuncG type="linear" slope=".5"/><feFuncB type="linear" slope=".5"/></feComponentTransfer></filter></defs>`;
  const photo=low?`<image href="${url}" width="1024" height="1024" mask="url(#inner)"/><image href="${url}" width="1024" height="1024" filter="url(#low)" mask="url(#outer)"/>`:`<image href="${url}" width="1024" height="1024"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title"><title id="title">LittleSheep Void Ring / black sphere with reflected light</title><desc>Photo-faithful SVG with embedded sphere light texture; not a pure-path vector.</desc>${defs}${tile?'<rect width="1024" height="1024" rx="204.8" fill="#000000"/>':''}<g ${tile?'clip-path="url(#tile)"':''} transform="${transform}" opacity="${opacity}" ${auraOnly?'mask="url(#outer)"':''}>${photo}</g></svg>`;
}
const render = (source,size) => sharp(Buffer.from(source),{density:144}).resize(size,size).png().toBuffer();
const write = (name,data) => fs.writeFile(path.join(root,name),data);
function ico(images) {
  const header=Buffer.alloc(6+images.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);
  let offset=header.length;
  images.forEach(([size,buf],i)=>{const p=6+i*16;header[p]=header[p+1]=size===256?0:size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(buf.length,p+8);header.writeUInt32LE(offset,p+12);offset+=buf.length;});
  return Buffer.concat([header,...images.map(i=>i[1])]);
}
async function main() {
  for(const dir of ['icon/icon_sizes','icon/icon_sizes_low_glow','motion','qa']) await fs.mkdir(path.join(root,dir),{recursive:true});
  const master=await render(svg({tile:true}),1024);
  await write('icon/icon_master.svg',svg({tile:true}));await write('icon/icon_master.png',master);
  await write('icon/icon_vector_reference.svg',vectorReference({tile:true}));
  await write('icon/icon_low_glow.svg',svg({tile:true,low:true}));await write('icon/icon_low_glow.png',await render(svg({tile:true,low:true}),1024));
  const mark=await render(svg(),1024), aura=await render(svg({auraOnly:true}),1024);
  await write('motion/void_ring_mark.svg',svg());await write('motion/void_ring_mark.png',mark);
  await write('motion/corona.png',aura);
  for(const size of sizes) {
    await write(`icon/icon_sizes/${size}x${size}.png`,await render(svg({tile:true,size}),size));
    await write(`icon/icon_sizes_low_glow/${size}x${size}.png`,await render(svg({tile:true,size,low:true}),size));
  }
  const {generateFluidMotion}=await import('./render_fluid_motion.mjs');
  await generateFluidMotion();
  await fs.writeFile(path.join(appResources,'littlesheep-icon.png'),master);
  const native=[];for(const size of nativeSizes)native.push([size,await render(svg({tile:true,size}),size)]);
  const nativeIcon=ico(native);
  await fs.writeFile(path.join(appResources,'littlesheep.ico'),nativeIcon);
  await write('icon/void_ring.ico',nativeIcon);
  // Human review sheet: actual native sizes plus enlarged 32px nearest-neighbour view.
  const bg=Buffer.from('<svg width="1400" height="700"><rect width="1400" height="700" fill="#101014"/><g font-family="Segoe UI,Arial" fill="#e8e8ef"><text x="40" y="48" font-size="24">VOID RING / SVG MASTER + OPTICAL SIZES</text><text x="44" y="590" font-size="17">Standard glow</text><text x="400" y="590" font-size="17">Low glow</text><text x="794" y="92" font-size="15">128 · 64 · 32 / native pixels</text><text x="794" y="590" font-size="15">256 / native pixels</text><text x="1110" y="500" font-size="15">32px enlarged 6×</text></g></svg>');
  const composite=[{input:await sharp(master).resize(350).png().toBuffer(),left:24,top:160},{input:await render(svg({tile:true,low:true}),350),left:394,top:160}];
  let x=794;for(const size of [128,64,32]) {composite.push({input:await fs.readFile(path.join(root,`icon/icon_sizes/${size}x${size}.png`)),left:x,top:110});x+=size+20;}
  composite.push({input:await render(svg({tile:true,size:256}),256),left:794,top:250});
  composite.push({input:await sharp(await fs.readFile(path.join(root,'icon/icon_sizes/32x32.png'))).resize(192,192,{kernel:'nearest'}).png().toBuffer(),left:1110,top:280});
  await write('qa/static_review.png',await sharp(bg).composite(composite).png().toBuffer());
  console.log('Exported sphere-texture SVG masters, two PNG size sets, native ICO, four self-contained Lottie animations and SVG references.');
}
if(process.argv[1]===fileURLToPath(import.meta.url)) await main();
