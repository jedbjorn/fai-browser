#!/usr/bin/env python3
"""Offline editorial cut from reviewed Firefox evidence; no browser or personal display.

Requires Pillow and ffmpeg. Source media is recovered from the reviewed git revision,
not the current demo.mp4, so repeat exports never edit an already edited video.
All terminal excerpts are labeled and use recorded fields, without invented events.
"""
import argparse
import hashlib
import json
import math
import resource
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / 'docs/media'
SOURCE = 'a91e894'
SOURCE_VIDEO_SHA256 = 'f0f5ec0a955f622991f0ce36ce7d867a97b83a285e5d4317fceef656aace5d30'
W, H, FPS = 1920, 1080, 30
BG, FG, MINT, MUTED = '#0b211e', '#f0f6f2', '#7ce4bd', '#adc5bc'
FONTDIR = Path('/usr/share/fonts/TTF')
if not (FONTDIR / 'DejaVuSans.ttf').exists():
    FONTDIR = Path('/usr/share/fonts/truetype/dejavu')

def font(size, bold=False, mono=False):
    name = 'DejaVuSansMono' if mono else 'DejaVuSans'
    return ImageFont.truetype(str(FONTDIR / f'{name}{"-Bold" if bold else ""}.ttf'), size)

def run(args, **kw):
    return subprocess.run(args, check=True, **kw)

def text(d, xy, value, size=32, color=FG, bold=False, mono=False):
    f = font(size, bold, mono)
    assert d.textbbox(xy, value, font=f)[2] < W-65, f'Text exceeds safe area: {value}'
    d.text(xy, value, font=f, fill=color, spacing=16)

def base():
    # Soft, static studio lighting: all motion is deliberate and only between beats.
    small = Image.new('RGB', (192,108))
    px = small.load()
    for y in range(108):
        for x in range(192):
            light = max(0, 1-math.hypot((x-143)/180, (y-33)/115))
            px[x,y] = (int(8+8*light), int(25+23*light), int(23+20*light))
    im = small.resize((W,H), Image.Resampling.BICUBIC)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((88,48,132,82), 8, outline=MINT, width=2)
    d.line((89,59,131,59), fill=MINT, width=2)
    d.ellipse((106,65,114,73),fill=MINT)
    text(d,(149,43),'FAI Browser',29,bold=True)
    text(d,(1350,48),'OFFICIAL FIREFOX',20,color=MUTED)
    d.line((88,1013,1832,1013),fill='#35534a',width=1)
    text(d,(88,1033),'Scripted MCP · Automated real UI approvals · Local FAKE fixtures',20,color=MUTED)
    text(d,(1510,1033),'Development add-on',20,color=MUTED)
    return im

BACKGROUND = base()

def body(chapter, title, subtitle):
    im = Image.new('RGBA',(W,H)); d=ImageDraw.Draw(im)
    text(d,(94,128),chapter,22,color=MINT,bold=True)
    text(d,(88,173),title,59,bold=True)
    text(d,(92,253),subtitle,28,color=MUTED)
    return im

def panel(im, box, fill='#102d27'):
    d=ImageDraw.Draw(im)
    d.rounded_rectangle(box,24,fill=fill,outline='#36574c',width=2)

def shot(name):
    # Strip only editorial margins; the captured product UI pixels are unmodified.
    p = Image.open(MEDIA / (name+'.png')).convert('RGB')
    return p.crop((48,110,p.width-48,p.height-48))

def paste_fit(im, image, box):
    x,y,w,h=box
    scale=min(w/image.width,h/image.height)
    fitted=image.resize((round(image.width*scale),round(image.height*scale)),Image.Resampling.LANCZOS)
    im.paste(fitted,(round(x+(w-fitted.width)/2),round(y+(h-fitted.height)/2)))

def terminal(chapter,title,subtitle,lines):
    im=body(chapter,title,subtitle); panel(im,(92,335,1828,950),'#071b18');d=ImageDraw.Draw(im)
    for i,col in enumerate(['#d98c79','#d7be7b','#7bbd9a']):d.ellipse((123+i*27,359,137+i*27,373),fill=col)
    text(d,(240,350),'MCP excerpt · Reformatted for readability',22,color=MUTED)
    d.line((93,400,1827,400),fill='#315247',width=1)
    for i,(line,color) in enumerate(lines):text(d,(133,435+i*58),line,31,color=color,mono=True)
    return im

def actual(chapter,title,subtitle,name):
    im=body(chapter,title,subtitle)
    paste_fit(im,shot(name),(190,319,1540,656))
    return im

def prepare(out):
    source=out/'source.mp4'
    if not source.exists():
        with source.open('wb') as f:run(['git','show',f'{SOURCE}:docs/media/demo.mp4'],cwd=ROOT,stdout=f)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == SOURCE_VIDEO_SHA256, 'Source video changed'
    for sec in [15,40]:
        run(['ffmpeg','-y','-v','error','-threads','1','-filter_threads','1','-ss',str(sec),'-i',str(source),'-frames:v','1','-threads','1',str(out/f'source-{sec}.png')])
    scenes=[]
    def add(name,duration,im,transition='dissolve'):
        path=out/f'{name}.png'; flat=BACKGROUND.copy();flat.paste(im,(0,0),im);flat.save(path)
        scenes.append(dict(name=name,duration=duration,transition=transition,body=im,path=path))
    im=Image.new('RGBA',(W,H));d=ImageDraw.Draw(im)
    text(d,(120,242),'YOUR AGENT. YOUR BROWSER.',25,color=MINT,bold=True)
    text(d,(112,309),'Your say.',127,bold=True)
    text(d,(121,500),'One approved tab. Every sensitive step in your hands.',36,color=MUTED)
    for x,label in [(121,'01  Approve the tab'),(677,'02  Control the action'),(1233,'03  Protect the secret')]:
        d.rounded_rectangle((x,664,x+520,759),18,outline='#547766',width=2)
        text(d,(x+28,694),label,27,color=FG)
    text(d,(121,879),'A real Firefox capture, edited for clarity.',27,color=MUTED)
    add('01-intro',4,im)
    add('02-request-terminal',6,terminal('01 / APPROVE THE TAB','Start with a clear request.','The agent asks for one origin and a permission level.',[
        ('$ fai_browser_open',MINT),
        ('  origins: ["http://127.0.0.1:8765"]',FG),
        ('  mode: "full"',FG),
        ('  task: "Buy one brass compass',FG),
        ('         in the Northwind test shop."',FG),
        ('',FG),
        ('Selected fields from the recorded MCP call.',MUTED),
    ]),'right')
    im=body('01 / APPROVE THE TAB','You choose the access.','An actual tab request from the captured session.')
    d=ImageDraw.Draw(im)
    text(d,(119,402),'One origin.',48,bold=True)
    text(d,(119,482),'A level you choose.',48,bold=True)
    text(d,(122,600),'Opening the page is a separate step.',26,color=MUTED)
    text(d,(122,645),'The toolbar click approves the tab.',26,color=MUTED)
    paste_fit(im,shot('approval-card'),(955,327,800,624))
    add('03-request-browser',7,im)
    im=body('01 / APPROVE THE TAB','Now the agent can work.','The approved local shop, in its separate Firefox window.')
    product=Image.open(out/'source-15.png').crop((1100,0,1920,900))
    paste_fit(im,product,(1010,315,715,675))
    d=ImageDraw.Draw(im);text(d,(122,416),'Read the page.',49,bold=True);text(d,(122,501),'Choose an action.',49,bold=True)
    text(d,(124,629),'The replay adds one brass compass',28,color=MUTED);text(d,(124,674),'and reviews the order.',28,color=MUTED)
    add('04-shop-browser',5,im,'left')
    add('05-action-terminal',5,terminal('02 / CONTROL THE ACTION','A purchase is a separate decision.','The final action includes an expectation that can be checked.',[
        ('$ fai_browser_act',MINT),
        ('  reason: "Buy the brass compass as asked (test shop)"',FG),
        ('  expectation:',FG),
        ('    textIncludes: "Order confirmed"',MINT),
        ('',FG),
        ('Selected fields from the recorded Pay now call.',MUTED),
    ]),'right')
    add('06-purchase-browser',8,actual('02 / CONTROL THE ACTION','Pay now waits for you.','Read the exact action and amount. Approve once permits that one click.','approve-once'))
    im=body('02 / CONTROL THE ACTION','Approved once. Completed once.','The real confirmation from the local shop. No real payment occurred.')
    confirm=Image.open(out/'source-40.png').crop((1100,0,1920,790))
    paste_fit(im,confirm,(1000,320,750,666));d=ImageDraw.Draw(im)
    text(d,(120,420),'$142.80',91,color=MINT,bold=True);text(d,(124,550),'One fixture payment.',39,bold=True)
    text(d,(124,654),'Zero before approval.',28,color=MUTED);text(d,(124,701),'Exactly one afterwards.',28,color=MUTED)
    add('07-confirm-browser',5,im,'left')
    add('08-verified-terminal',6,terminal('02 / CONTROL THE ACTION','The result is checked.', 'These are the actual returned fields from the recorded MCP response.',[
        ('status: completed, verified: true',MINT),
        ('expectation: {"textIncludes":"Order confirmed"}',FG),
        ('granted: full (asked full)',FG),
        ('',FG),
        ('did: click "Pay now"',FG),
        ('Order confirmed',FG),
        ('Total paid $142.80',FG),
    ]))
    add('09-handles-terminal',7,terminal('03 / PROTECT THE SECRET','The agent receives a handle.','Verbatim lines from the real digest. The fixture key is deliberately fake.',[
        ('title: API keys · Northwind test workspace',FG),
        ('page digest:',FG),
        ('NORTHWIND / DEVELOPER FAKE DATA',FG),
        ('',FG),
        ('API key',FG),
        ('[secret:1 openai sk-proj-…Yz56 len 64]',MINT),
        ('Copy key',FG),
    ]),'right')
    im=body('03 / PROTECT THE SECRET','Redaction reaches the screenshot, too.','The actual image returned by MCP. Its black boxes were applied by FAI.')
    redacted=Image.open(MEDIA/'redacted-screenshot.png').crop((1736,142,3376,1742))
    paste_fit(im,redacted,(1000,320,720,670));d=ImageDraw.Draw(im)
    text(d,(120,421),'Useful context.',46,bold=True);text(d,(120,497),'Protected values.',46,color=MINT,bold=True)
    text(d,(123,638),'The page remains understandable.',28,color=MUTED);text(d,(123,685),'The raw key stays out of the image.',28,color=MUTED)
    add('10-redacted-browser',7,im)
    add('11-fill-browser',8,actual('03 / PROTECT THE SECRET','Another site needs another approval.','The captured cross-origin warning names the source, destination and field.','secret-handle'))
    data=json.loads((ROOT/'bench/tokens/results-real.json').read_text())
    summary=data['summary']['openText']['tokenizers']['openaiO200k']
    fai,pw=summary['faiTokens'],summary['pwTokens']
    im=body('04 / SMALLER OBSERVATIONS','More room for the task.',f'Median opening output · {len(data["pages"])} captured public pages · o200k_base tokenizer')
    d=ImageDraw.Draw(im)
    text(d,(118,374),f'{summary["tokenReduction"]:.0%}',104,color=MINT,bold=True)
    text(d,(125,507),'fewer tokens',31,color=MUTED)
    x0,x1=620,1724
    for y,value,label,col in [(394,pw,'Accessibility snapshot','#829eaf'),(594,fai,'FAI opening result',MINT)]:
        text(d,(x0,y-45),label,30)
        d.rounded_rectangle((x0,y+15,x0+(x1-x0)*value/pw,y+78),8,fill=col)
        text(d,(x0,y+91),f'{math.floor(value+0.5):,} tokens',32,color=col,bold=True)
    d.line((x0,391,x0,675),fill='#aec3b9',width=2)
    text(d,(120,838),'Same pages. Common zero baseline. Values rounded for display.',26,color=MUTED)
    text(d,(120,887),'Offline Chromium benchmark · Output size only, not task success or Firefox performance.',26,color=MUTED)
    add('12-benchmark',8,im)
    im=Image.new('RGBA',(W,H));d=ImageDraw.Draw(im)
    text(d,(122,240),'FAI BROWSER',25,color=MINT,bold=True)
    text(d,(112,313),'Let the agent work.',82,bold=True)
    text(d,(112,417),'Keep the decisions.',82,color=MINT,bold=True)
    text(d,(121,604),'Official Firefox · A separate FAI profile · Open source',31,color=MUTED)
    d.rounded_rectangle((120,727,1800,828),18,fill='#163c31',outline='#487a64',width=2)
    text(d,(160,753),'github.com/jedbjorn/fai-browser',43,bold=True)
    text(d,(124,907),'Edited from genuine local-test footage and captured UI. No audio.',25,color=MUTED)
    add('13-outro',5,im)
    (out/'storyboard.json').write_text(json.dumps([{k:v for k,v in s.items() if k not in ['body','path']} for s in scenes],indent=2))
    return scenes


def flatten(body):
    im=BACKGROUND.copy();im.paste(body,(0,0),body);return im


def render(scenes,out,name,durations=None):
    path=out/name
    args=['ffmpeg','-y','-v','error','-filter_threads','1','-f','rawvideo','-pix_fmt','rgb24','-s','1920x1080','-r','30','-i','pipe:0','-an',
          '-c:v','libx264','-crf','18','-preset','medium','-threads','2','-pix_fmt','yuv420p','-movflags','+faststart',str(path)]
    p=subprocess.Popen(args,stdin=subprocess.PIPE,
        preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_AS, (1536*1024**2, 1536*1024**2)))
    durations=durations or [s['duration'] for s in scenes]
    timeline=[];frame=0
    try:
        for idx,s in enumerate(scenes):
            count=round(durations[idx]*FPS)
            transition_frames=(36 if s['transition'] in ['left','right'] else 24) if idx<len(scenes)-1 else 0
            if durations is not None and min(durations)<4:transition_frames=min(transition_frames,18)
            timeline.append(dict(name=s['name'],start=frame/FPS,hold=(count-transition_frames)/FPS,transition=transition_frames/FPS))
            print(f'{name}: {frame/FPS:.1f}s {s["name"]}',flush=True)
            pixels=flatten(s['body']).tobytes()
            for n in range(count-transition_frames):p.stdin.write(pixels);frame+=1
            if transition_frames:
                target=scenes[idx+1]['body']
                for n in range(transition_frames):
                    u=(n+1)/transition_frames;ease=u*u*u*(u*(u*6-15)+10)
                    if s['transition'] in ['left','right']:
                        # Both panels move on one track. Fractional transform avoids integer-pixel stutter.
                        direction=1 if s['transition']=='right' else -1
                        canvas=Image.new('RGBA',(W,H))
                        for layer,delta in [(s['body'],-direction*W*ease),(target,direction*W*(1-ease))]:
                            moved=layer.transform((W,H),Image.Transform.AFFINE,(1,0,-delta,0,1,0),Image.Resampling.BICUBIC)
                            canvas.alpha_composite(moved)
                        image=flatten(canvas)
                    else:
                        image=Image.blend(flatten(s['body']),flatten(target),ease)
                    p.stdin.write(image.tobytes());frame+=1
        p.stdin.close();assert p.wait()==0,'ffmpeg export failed'
    except BaseException:
        p.kill();p.wait();raise
    (out/(name+'.timeline.json')).write_text(json.dumps(timeline,indent=2))
    return path


def main():
    # Inherited by the only child process: Python + ffmpeg together cannot exceed 2.5 GiB.
    resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1536*1024**2))
    parser=argparse.ArgumentParser();parser.add_argument('--out',default='artifacts/demo-edit');parser.add_argument('--stills-only',action='store_true');parser.add_argument('--social-only',action='store_true')
    args=parser.parse_args();out=(ROOT/args.out).resolve();assert out.is_relative_to(ROOT/'artifacts')
    out.mkdir(parents=True,exist_ok=True)
    scenes=prepare(out)
    # The contact sheet is deterministic and doubles as a simple storyboard review artifact.
    sheet=Image.new('RGB',(4*480,4*300),BG);d=ImageDraw.Draw(sheet)
    for i,s in enumerate(scenes):
        x=(i%4)*480;y=(i//4)*300
        sheet.paste(flatten(s['body']).resize((480,270)),(x,y));d.text((x+12,y+275),s['name'],font=font(17),fill=FG)
    sheet.save(out/'storyboard.png')
    if args.stills_only:return
    if not args.social_only:render(scenes,out,'demo.mp4')
    # A separately paced mini-story, not arbitrary hard cuts out of the long edit.
    social_indices=[0,1,2,5,8,9,10,11,12]
    social=[dict(scenes[i]) for i in social_indices]
    for s in social:s['transition']='dissolve'
    social[1]['transition']='right';social[4]['transition']='right'
    render(social,out,'demo-social.mp4',[2,3,3,5,4,3,4,3,3])
    run(['ffmpeg','-y','-v','error','-threads','1','-i',str(out/'demo-social.mp4'),'-filter_complex_threads','1','-filter_complex',
         'fps=12,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=80[p];[b][p]paletteuse=dither=bayer:bayer_scale=3',
         '-threads','1','-loop','0',str(out/'demo.gif')])
    assert (out/'demo.gif').stat().st_size<8_000_000
    print('Export ready for visual review. No files automatically published to docs/media.',flush=True)

if __name__=='__main__':main()
