/** Export the user's original sphere photograph, preserving its black matte. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const sharp=require(process.env.SHARP_MODULE??path.join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp'));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=await fs.readFile(path.join(root,'icon/void_ring_reference.png'));
// A single uniform framing transform moves sphere and corona together.
const referenceSize=1254,referenceCenter=[617,627],referenceRadius=251;
const scale=310/(referenceRadius/referenceSize*1024),width=1024*scale,x=480-referenceCenter[0]/referenceSize*1024*scale,y=530-referenceCenter[1]/referenceSize*1024*scale;
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><image href="data:image/png;base64,${source.toString('base64')}" x="${x}" y="${y}" width="${width}" height="${width}"/></svg>`;
const original=await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
const rgba=Buffer.alloc(1024*1024*4);
let maxError=0;
for(let py=0;py<1024;py++)for(let px=0;px<1024;px++){
 const i=(py*1024+px)*3,j=(py*1024+px)*4;
 const inside=Math.hypot(px-480,py-530)<=308;
 const signal=Math.max(original[i],original[i+1],original[i+2]);
 const alpha=inside?255:signal>3?signal:0;
 rgba[j+3]=alpha;
 for(let ch=0;ch<3;ch++){
  rgba[j+ch]=alpha?Math.min(255,Math.round(original[i+ch]*255/alpha)):0;
  maxError=Math.max(maxError,Math.abs(Math.round(rgba[j+ch]*alpha/255)-original[i+ch]));
 }
}
await sharp(rgba,{raw:{width:1024,height:1024,channels:4}}).png().toFile(path.join(root,'icon/sphere_motion_source.png'));
await sharp(original,{raw:{width:1024,height:1024,channels:3}}).png().toFile(path.join(root,'qa/sphere_framing_reference.png'));
await fs.writeFile(path.join(root,'qa/sphere_source_validation.json'),JSON.stringify({source:'User original mother image, without generative redrawing',framing:{scale,center:[480,530],radius:310},blackMatteRecompositionMaxChannelError:maxError,emptyBackgroundNoiseFloor:3,opaqueForegroundSphere:true,emptyBackgroundTransparent:true},null,2));
if(maxError>3)throw new Error('Export changed the original sphere lighting beyond the black-background noise floor');
console.log('Sphere lighting preserved on black; maximum channel error:',maxError);
