#!/usr/bin/env python3
"""Offline artwork from repository data. No browser, network, or screenshots."""
import json
import math
from pathlib import Path
from statistics import median
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/media'
OUT.mkdir(parents=True, exist_ok=True)
FONT = Path('/usr/share/fonts/TTF/DejaVuSans.ttf')
if not FONT.exists():
    FONT = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
BOLD = FONT.with_name('DejaVuSans-Bold.ttf')
BG, INK, MUTED, TEAL, BLUE = '#f4f7f4', '#18322e', '#52675e', '#087565', '#8ca7ba'

def font(size, bold=False):
    return ImageFont.truetype(str(BOLD if bold else FONT), size)

def social():
    im = Image.new('RGB', (1280, 640), '#0c2521')
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((76, 68, 132, 112), radius=10, outline='#76dbc1', width=3)
    d.line((76, 83, 132, 83), fill='#76dbc1', width=3)
    d.ellipse((99, 90, 109, 100), fill='#76dbc1')
    d.text((152, 67), 'FAI Browser', font=font(32, True), fill='#f4f7f4')
    d.text((76, 169), 'Your agent. Your browser.', font=font(59, True), fill='#f4f7f4')
    d.text((76, 245), 'Your say.', font=font(72, True), fill='#76dbc1')
    d.text((79, 351), 'Official Firefox · A separate FAI profile · Open source', font=font(23), fill='#b9cdc5')
    for x, label in [(78, 'One approved tab'), (469, 'Secret redaction'), (860, 'Approve once')]:
        d.rounded_rectangle((x, 431, x + 340, 492), radius=12, outline='#48645b', width=2)
        d.ellipse((x+21, 456, x+31, 466), fill='#76dbc1')
        d.text((x+46, 446), label, font=font(22), fill='#edf6f1')
    d.text((78, 556), 'github.com/jedbjorn/fai-browser', font=font(22), fill='#b9cdc5')
    d.text((1160, 556), 'MIT', font=font(22), fill='#b9cdc5')
    im.save(OUT / 'social-preview.png', optimize=True)

def tokens():
    data = json.loads((ROOT / 'bench/tokens/results-real.json').read_text())
    rows = [(p['id'], p['samples']['faiOpenText']['tokens']['openaiO200k'],
             p['samples']['playwrightOpen']['tokens']['openaiO200k']) for p in data['pages']]
    summary = data['summary']['openText']['tokenizers']['openaiO200k']
    im = Image.new('RGB', (2560, 2320), BG)
    d = ImageDraw.Draw(im)
    d.text((112, 65), 'Smaller opening observations', font=font(68, True), fill=INK)
    d.text((112, 165), f"{summary['faiTokens']:,.0f} vs {math.floor(summary['pwTokens']+0.5):,} tokens", font=font(74, True), fill=TEAL)
    d.text((112, 267), f"Medians across {len(rows)} captured public pages · {summary['tokenReduction']:.0%} fewer tokens", font=font(36), fill=INK)
    d.text((112, 340), 'o200k_base tokenizer · FAI opening result vs Playwright-MCP-style accessibility snapshot', font=font(29), fill=MUTED)
    d.text((112, 390), 'Same page; output size only, not task success. Offline Chromium benchmark, not Firefox.', font=font(29), fill=MUTED)
    for x, color, label in [(112, TEAL, 'FAI opening result'), (780, BLUE, 'Accessibility snapshot')]:
        d.rectangle((x, 470, x+30, 500), fill=color)
        d.text((x+48, 463), label, font=font(30), fill=INK)
    left, right, top, step, maximum = 610, 2220, 570, 116, 100000
    for tick in range(0, maximum+1, 20000):
        x = left + (right-left)*tick/maximum
        d.line((x, top-22, x, top+step*len(rows)-25), fill='#d7e2db', width=2)
        d.text((x-25, top+step*len(rows)), f'{tick:,}', font=font(24), fill=MUTED)
    for i, (name, text, snapshot) in enumerate(rows):
        y = top+i*step
        d.text((112, y+15), name, font=font(29, True), fill=INK)
        for offset, value, color in [(0,text,TEAL),(40,snapshot,BLUE)]:
            end = left+(right-left)*value/maximum
            d.rectangle((left,y+offset,end,y+offset+27),fill=color)
            d.text((end+12,y+offset-3), f'{value:,}',font=font(24),fill=INK)
    d.text((112, 2070), 'Common zero baseline · Exact encoding counts, without chat/tool envelopes', font=font(30), fill=INK)
    d.text((112, 2130), 'Task-ranked output and an accessibility tree carry different information.', font=font(29), fill=MUTED)
    d.text((112, 2190), f"Source: bench/tokens/results-real.json · {data['generatedAt'][:10]} · No model/provider call", font=font(27), fill=MUTED)
    im.save(OUT / 'tokens.png', optimize=True)

if __name__ == '__main__':
    social()
    tokens()
    for name in ['social-preview.png', 'tokens.png']:
        p=OUT/name
        with Image.open(p) as im:
            print(f'docs/media/{name}: {im.width} × {im.height}, {p.stat().st_size:,} bytes')
