#!/usr/bin/env python3
"""Frame real Firefox captures and render verbatim MCP excerpts; never invent product UI."""
import json
import sys
import textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from media import font, BG, INK, MUTED

source = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[2]
assert source.parent == root / 'artifacts' and source.name.startswith('demo-capture-')
out = source / 'stills'
out.mkdir(exist_ok=True)
report = json.loads((source / 'session.json').read_text())
build = 'Development add-on' if report['addon']['temporary'] else 'Signed add-on'

def frame(name, label, dark=False):
    subject = Image.open(source / f'{name}.png').convert('RGB')
    pad = 48  # 24 CSS px at the 2x capture scale
    top = 110
    bg, ink = ('#0c2521', '#edf6f1') if dark else (BG, INK)
    im = Image.new('RGB', (subject.width+pad*2, subject.height+pad+top), bg)
    im.paste(subject, (pad, top))
    d = ImageDraw.Draw(im)
    title = label.split(' · '+build)[0] if name != 'firefox-launcher' else label
    label_size = 26
    while d.textlength(title, font=font(label_size, True)) > subject.width and label_size > 16:
        label_size -= 1
    d.text((pad, 26), title, font=font(label_size, True), fill=ink)
    detail = build + (' · Light UI on dark background' if dark else '') if name != 'firefox-launcher' else 'Actual launcher checks · Private profile path omitted'
    detail_size = 22
    while d.textlength(detail, font=font(detail_size)) > subject.width:
        detail_size -= 1
    d.text((pad, 67), detail, font=font(detail_size), fill='#b9cdc5' if dark else MUTED)
    im.save(out / f'{name}{"-dark" if dark else ""}.png', optimize=True)

for name, label in [('approval-card', 'Firefox · Tab request'), ('level-picker', 'Firefox · Actual level selector'),
                    ('approve-once', 'Firefox · One action, one approval'), ('secret-handle', 'Firefox · Cross-origin secret fill'),
                    ('test-site', 'Firefox · A listed local Test site'), ('popup-advanced', 'Firefox · Advanced settings'),
                    ('firefox-launcher', 'Official Firefox · Signed add-on · Separate FAI profile')]:
    frame(name, label if name == 'firefox-launcher' else f'{label} · {build}')
for name, label in [('approval-card', 'Firefox · Tab request'), ('approve-once', 'Firefox · One action, one approval')]:
    frame(name, label, dark=True)

# The excerpt is taken from the real SDK transcript, retaining every digest line and its actual placeholders.
transcript = (source / 'session-transcript.txt').read_text()
block = next(b for b in transcript.split('\n$ ') if 'title: API keys' in b)
excerpt = block[block.index('title: API keys'):].split('actions (revision ', 1)[0].rstrip()
lines = [wrapped for line in excerpt.splitlines() for wrapped in (textwrap.wrap(line, width=85) or [''])]
for dark in [False, True]:
    bg, ink = ('#0c2521', '#edf6f1') if dark else (BG, INK)
    im = Image.new('RGB', (1600, 225+len(lines)*45), bg)
    d = ImageDraw.Draw(im)
    d.text((60, 43), 'What the agent received', font=font(44, True), fill=ink)
    d.text((60, 108), f'Verbatim MCP digest excerpt · Firefox · {build}', font=font(26), fill=ink)
    for i, line in enumerate(lines):
        d.text((60, 180+i*45), line, font=font(29), fill='#76dbc1' if dark and '[secret:' in line else ink)
    im.save(out / f'secret-placeholders{"-dark" if dark else ""}.png', optimize=True)

# Side-by-side: left is a genuine page capture with the fixture's visibly FAKE key;
# right is the actual returned image. Its black boxes and badges are entirely FAI's.
before = Image.open(source / 'keys-page.png').convert('RGB')
after = Image.open(next(source.glob('agent-image-1.*'))).convert('RGB')
width = 1640
before = before.resize((width, round(before.height*width/before.width)), Image.Resampling.LANCZOS)
after = after.resize((width, round(after.height*width/after.width)), Image.Resampling.NEAREST)
im = Image.new('RGB', (width*2+144, max(before.height, after.height)+190), BG)
d = ImageDraw.Draw(im)
d.text((48, 30), 'Firefox page · FAKE fixture data', font=font(35, True), fill=INK)
d.text((width+96, 30), 'Actual MCP image · Redacted by FAI', font=font(35, True), fill=INK)
d.text((48, 86), f'{build} · The returned image is enlarged 2x; no manual redaction', font=font(25), fill=MUTED)
im.paste(before, (48, 142)); im.paste(after, (width+96, 142))
im.save(out / 'redacted-screenshot.png', optimize=True)
for file in sorted(out.glob('*.png')):
    print(f'{file.name}: {file.stat().st_size} bytes')
