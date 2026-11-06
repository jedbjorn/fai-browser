// Postprocess only the isolated capture. Never accepts a display, a device or a URL.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const dir = resolve(process.argv[2] ?? '');
assert.ok(dir.startsWith(join(root, 'artifacts/demo-capture-')), 'Only a demo capture directory is accepted');
const group = (await readFile('/proc/self/cgroup','utf8')).split('\n').find(s=>s.startsWith('0::'))?.slice(3);
assert.ok(group && group !== '/', 'Run export inside the memory-capped recording scope');
const cap = Number((await readFile(join('/sys/fs/cgroup',group,'memory.max'),'utf8')).trim());
assert.ok(Number.isFinite(cap) && cap <= 3000*1024*1024, 'MemoryMax must be at most 3000M');
const session = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
assert.ok(session.duration <= 90 && session.fixturePayments === 1);
const data = JSON.parse(await readFile(join(root, 'bench/tokens/results-real.json'), 'utf8'));
const sleep = ms => new Promise(done=>setTimeout(done,ms));
async function run(tool, args) {
  if(tool === 'ffmpeg') {
    for(;;) {
      const memory = execFileSync('free',['-m'],{encoding:'utf8'});process.stdout.write(memory);
      const available = Number(memory.split('\n').find(s=>s.startsWith('Mem:')).trim().split(/\s+/).at(-1));
      let testing=true;try{execFileSync('pgrep',['-f','[n]ode --test'],{stdio:'ignore'});}catch(e){if(e.status===1)testing=false;else throw e;}
      if(available>=4000 && !testing)break;
      console.log('Waiting 60 seconds for recording memory budget.');await sleep(60_000);
    }
  }
  const p=spawn(tool,tool==='ffmpeg'?['-y',...args]:args,{cwd:dir,stdio:['ignore','pipe','pipe']});let out='',err='';
  p.stdout.on('data',x=>out+=x);
  p.stderr.on('data',x=>err=(err+x).slice(-3000));
  const code=await new Promise((done,reject)=>{p.once('error',reject);p.once('exit',done);});
  assert.equal(code,0,`${tool} export failed: ${err.replaceAll(root,'[worktree]')}`);return out;
}
const probe = async name => JSON.parse(await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',name]));
const raw=await probe('raw.mp4');
const video=raw.streams.find(s=>s.codec_type==='video');
assert.equal(video.width,1920);assert.equal(video.height,1080);assert.equal(video.r_frame_rate,'30/1');
assert.ok(Number(raw.format.duration)>=session.duration-1, 'Raw capture ended before the session');
let filters=[];
async function caption(file,text,{y=995,size=30,start=0,end=90}={}) {
  await writeFile(join(dir,file),text+'\n');
  filters.push(`drawtext=expansion=none:textfile=${file}:fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=${y}:enable='between(t,${start},${end})'`);
}
filters.push('drawbox=x=0:y=960:w=1920:h=120:color=0x0c2521:t=fill');
for(let i=0;i<session.scenes.length;i++){
  const s=session.scenes[i],end=session.scenes[i+1]?.seconds??session.duration;
  await caption(`caption-${i}.txt`,s.caption,{start:s.seconds,end});
}
await caption('disclosure.txt',`Scripted MCP · Automated real UI approvals · FAKE fixtures${session.addon.temporary ? ' · Development add-on' : ' · Signed add-on'}`,{y:1043,size:22});
const end=session.scenes.find(s=>s.name==='end').seconds;
filters.push(`drawbox=x=0:y=0:w=1920:h=980:color=0x0c2521:t=fill:enable='lt(t,4)+gte(t,${end})'`);
await caption('title.txt','FAI Browser',{y:330,size:100,start:0,end:4});
await caption('subtitle.txt','Official Firefox. A separate FAI profile. Your say.',{y:480,size:40,start:0,end:4});
await caption('end-title.txt','Your agent. Your browser. Your say.',{y:330,size:66,start:end,end:session.duration});
await caption('end-url.txt','github.com/jedbjorn/fai-browser  ·  Firefox  ·  MIT',{y:480,size:36,start:end,end:session.duration});
// Real corpus medians; never imply that these were measured on the demo shop or on Firefox.
const summary=data.summary.openText.tokenizers.openaiO200k;
filters.push("drawbox=x=60:y=600:w=1800:h=290:color=0x0c2521@0.98:t=fill:enable='between(t,24,29)'");
await caption('benchmark-heading.txt',`${data.pages.length} captured public pages · Median opening output`,{y:625,size:36,start:24,end:29});
await caption('benchmark-values.txt',`FAI ${summary.faiTokens.toLocaleString('en-US')} vs snapshot ${Math.round(summary.pwTokens).toLocaleString('en-US')} tokens · ${(summary.tokenReduction*100).toFixed(0)}% fewer`,{y:687,size:40,start:24,end:29});
await caption('benchmark-method.txt','o200k_base tokenizer; FAI opening result vs Playwright-MCP-style accessibility snapshot',{y:760,size:27,start:24,end:29});
await caption('benchmark-caveat.txt','Same page; output size only, not task success · Offline Chromium benchmark',{y:810,size:28,start:24,end:29});
const encode=['-c:v','libx264','-crf','18','-preset','medium','-threads','2','-pix_fmt','yuv420p','-r','30','-movflags','+faststart','-an'];
const returnedImage = session.images[0];
assert.ok(returnedImage, 'An actual returned MCP image is required');
const imageStart = Math.max(54, returnedImage.seconds+0.2);
const imageEnd = session.scenes.find(s=>s.name==='paste').seconds;
assert.ok(imageEnd-imageStart >= 3, 'Hold the returned MCP image for at least three seconds');
filters.push(`drawbox=x=0:y=0:w=1105:h=980:color=0x0c2521:t=fill:enable='between(t,${imageStart},${imageEnd})'`);
await writeFile(join(dir,'image-label.txt'),'Actual MCP image · Redacted by FAI');
filters.push(`drawtext=expansion=none:textfile=image-label.txt:fontcolor=white:fontsize=28:x=172:y=28:enable='between(t,${imageStart},${imageEnd})'`);
const graph=`[0:v]${filters.join(',')}[base];[1:v]scale=760:-1[returned];[base][returned]overlay=172:80:enable='between(t,${imageStart},${imageEnd})'[out]`;
await run('ffmpeg',['-hide_banner','-loglevel','error','-i','raw.mp4','-loop','1','-i',returnedImage.name,
  '-filter_complex_threads','1','-filter_complex',graph,'-map','[out]','-t',String(session.duration),...encode,'demo.mp4']);
assert.ok(Math.abs(Number((await probe('demo.mp4')).format.duration)-session.duration)<0.15,
  'Main export must cover the full verified session');
// 30 seconds: two-second cards plus three unsped, chronological excerpts (8+10+8).
const request=session.ui.find(e=>e.name==='approval-card')?.seconds??10;
const purchase=session.ui.find(e=>e.name==='approve-once')?.seconds??32;
const secrets=session.scenes.find(s=>s.name==='secrets').seconds;
const cuts=[[0,2],[Math.max(4,request-2),8],[Math.max(0,purchase-2),10],[Math.max(secrets,imageStart-1),8],[end,2]];
const trims=cuts.map(([start,duration],i)=>`[0:v]trim=start=${start}:duration=${duration},setpts=PTS-STARTPTS[v${i}]`);
trims.push(`${cuts.map((_,i)=>`[v${i}]`).join('')}concat=n=5:v=1:a=0[out]`);
await run('ffmpeg',['-hide_banner','-loglevel','error','-i','demo.mp4','-filter_complex',trims.join(';'),'-map','[out]',...encode,'demo-social.mp4']);
for(const colors of [96,64,48]) {
  await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i','demo.mp4','-filter_complex',
    `fps=12,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
    '-threads','1','-loop','0','demo.gif']);
  if((await stat(join(dir,'demo.gif'))).size<8_000_000)break;
}
assert.ok((await stat(join(dir,'demo.gif'))).size<8_000_000,'GIF exceeds 8 MB; do not silently change the requested width/fps');
await run('ffmpeg',['-hide_banner','-loglevel','error','-i','demo.mp4','-vf','fps=1/5,scale=480:-1,tile=5x4:padding=8:margin=8:color=0x0c2521','-frames:v','1','-threads','1','review-strip.png']);
const files=[];
for(const name of await readdir(dir))if(/\.(png|gif|mp4)$/.test(name)&&name!=='raw.mp4'){
  const info={name,bytes:(await stat(join(dir,name))).size};
  if(name.endsWith('.mp4'))info.duration=Number((await probe(name)).format.duration);
  files.push(info);
}
assert.ok(Math.abs(files.find(f=>f.name==='demo-social.mp4').duration-30)<.15,'Social cut must be 30 seconds');
const total=files.reduce((n,f)=>n+f.bytes,0);
assert.ok(total<25_000_000,'Media exceeds 25 MB; re-edit instead of silently lowering quality');
await writeFile(join(dir,'media-manifest.json'),JSON.stringify({files,total,reviewed:false},null,2));
console.log('Exports generated. INCOMPLETE remains until every image and the video frame strip are visually reviewed.');
