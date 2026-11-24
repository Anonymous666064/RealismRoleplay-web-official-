import { generateRealismMap, VERTS, HALF, CELL, GRID_RES } from '../src/ts/world/RealismMapData.ts';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const m = generateRealismMap(1337);
console.log(m.stats);
let lo=1e9,hi=-1e9; for (const h of m.heights){ if(h<lo)lo=h; if(h>hi)hi=h;}
console.log('height range', lo, hi);
const W = 1024, scale = 2048 / W;
const img = new Uint8Array(W*W*3);
function set(px:number,pz:number,c:number[]){ if(px<0||pz<0||px>=W||pz>=W)return; const o=(pz*W+px)*3; img[o]=c[0];img[o+1]=c[1];img[o+2]=c[2]; }
const roadCol:any = { highway:[60,60,64], avenue:[72,72,76], street:[85,85,88], rural:[90,86,80], runway:[50,50,54], taxiway:[95,95,92], apron:[150,150,146] };
for (let pz=0;pz<W;pz++) for (let px=0;px<W;px++){
  const x=-HALF+(px+0.5)*scale, z=-HALF+(pz+0.5)*scale;
  const h=m.heightAt(x,z);
  const gx=Math.min(GRID_RES,Math.round((x+HALF)/CELL)), gz=Math.min(GRID_RES,Math.round((z+HALF)/CELL));
  const o=(gz*VERTS+gx)*3;
  let c=[m.colors[o]*255,m.colors[o+1]*255,m.colors[o+2]*255];
  // hillshade
  const hx=m.heightAt(x+2,z)-m.heightAt(x-2,z), hz=m.heightAt(x,z+2)-m.heightAt(x,z-2);
  const shade = Math.max(0.55, Math.min(1.25, 1 + (-hx*0.6 - hz*0.6)/4*0.5));
  c=c.map(v=>Math.min(255,v*shade));
  const ld=((x-m.lake.x)/m.lake.rx)**2+((z-m.lake.z)/m.lake.rz)**2;
  if (h < 0) { const d=Math.min(1,-h/14); c=[40*(1-d)+20*d+60,120-40*d,170-30*d]; }
  else if (ld<1.3 && h < m.lake.level) c=[50,110,150];
  set(px,pz,c);
}
// roads
for (const r of m.roads){
  const col=roadCol[r.kind]||[80,80,80];
  for (let i=0;i<r.pts.length-1;i++){
    const a=r.pts[i],b=r.pts[i+1]; const len=Math.hypot(b.x-a.x,b.z-a.z); const n=Math.ceil(len/1);
    for(let k=0;k<=n;k++){ const x=a.x+(b.x-a.x)*k/n, z=a.z+(b.z-a.z)*k/n; const hw=r.width/2;
      for(let ox=-hw;ox<=hw;ox+=1) for(let oz=-hw;oz<=hw;oz+=1){ if(ox*ox+oz*oz>hw*hw)continue; set(Math.floor((x+ox+HALF)/scale),Math.floor((z+oz+HALF)/scale),col);} }
  }
}
for (const t of m.trees){ const px=Math.floor((t.x+HALF)/scale), pz=Math.floor((t.z+HALF)/scale); const c=t.type?[40,80,30]:[25,60,35]; set(px,pz,c); set(px+1,pz,c); set(px,pz+1,c);}
for (const b of m.buildings){
  const c=Math.cos(b.rot), s=Math.sin(b.rot);
  const col=b.tint.map((v:number)=>Math.floor(v*200));
  for(let lx=-b.w/2;lx<=b.w/2;lx+=0.8) for(let lz=-b.d/2;lz<=b.d/2;lz+=0.8){
    const x=b.x+lx*c+lz*s, z=b.z-lx*s+lz*c;
    const edge = Math.abs(lx)>b.w/2-1.2||Math.abs(lz)>b.d/2-1.2;
    set(Math.floor((x+HALF)/scale),Math.floor((z+HALF)/scale), edge?[30,30,30]:col);
  }
}
for (const s of m.scenarios) for (const p of s.spawns){ const px=Math.floor((p.x+HALF)/scale), pz=Math.floor((p.z+HALF)/scale); for(let a=-2;a<=2;a++)for(let b=-2;b<=2;b++) set(px+a,pz+b,p.type==='player'?[255,0,255]:[255,220,0]); }
// PNG
function crc32(buf:Uint8Array){let c,crc=0xffffffff;for(let n=0;n<buf.length;n++){c=(crc^buf[n])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=(crc>>>8)^c;}return (crc^0xffffffff)>>>0;}
function chunk(type:string,data:Uint8Array){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),Buffer.from(data)]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td));return Buffer.concat([len,td,crc]);}
const raw=Buffer.alloc((W*3+1)*W); for(let y=0;y<W;y++){raw[y*(W*3+1)]=0; Buffer.from(img.buffer,y*W*3,W*3).copy(raw,y*(W*3+1)+1);}
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(W,4); ihdr[8]=8; ihdr[9]=2;
writeFileSync(process.argv[2]||'map.png', Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',new Uint8Array(0))]));
console.log('written');
