#!/usr/bin/env python3
"""Replicate token-radar-01's seven sealed-gate rows against a main.ts output dir.

Usage: python3 gate_check.py <output-dir> [snapshot.json]
Exit 0 when all seven rows pass, else 1 with the failing rows listed.
"""
import json
import re
import struct
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
SNAP = Path(sys.argv[2] if len(sys.argv) > 2 else
            '/home/hatch/workspace/makefun/token-radar-01-kit/input/snapshot.json')

failures = []


def check(name, ok, detail=''):
    print(('PASS' if ok else 'FAIL'), name, detail)
    if not ok:
        failures.append(name)


snap = json.loads(SNAP.read_text())
proto_slugs = {p['slug'] for p in snap['protocols']}
watchlist = snap['watchlist']

# --- 1. dashboard_files ---
dash = OUT / 'dashboard'
files = sorted(p for p in dash.rglob('*') if p.is_file())
names_ok = all(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9._-]{0,127}', p.name) for p in files)
no_dotdir = all(not any(part.startswith('.') for part in p.relative_to(dash).parts[:-1]) for p in files)
has_html = (dash / 'index.html').is_file()
has_css = any(p.suffix == '.css' for p in files)
has_js = any(p.suffix == '.js' for p in files)
total_bytes = sum(p.stat().st_size for p in files)
http_pat = re.compile(r'https?://')
net_ok = True
for p in files:
    if p.suffix in ('.html', '.css', '.js'):
        text = p.read_text(errors='replace')
        if p.suffix == '.html':
            # attribute values only: strip text content between tags roughly
            attrs = ' '.join(re.findall(r'<[^>]+>', text))
            if http_pat.search(attrs):
                net_ok = False
        else:
            if http_pat.search(text):
                net_ok = False
check('dashboard_files', len(files) <= 400 and total_bytes <= 4 * 1024 * 1024 and names_ok
      and no_dotdir and has_html and has_css and has_js and net_ok,
      f'{len(files)} files, {total_bytes} bytes, html={has_html} css={has_css} js={has_js} names_ok={names_ok} no_network={net_ok}')

# --- 2. board_file ---
board_path = OUT / 'board.json'
board = json.loads(board_path.read_text())
rows = board['rows'] if isinstance(board, dict) else board
rows_ok = 100 <= len(rows) <= 4000 and board_path.stat().st_size <= 8 * 1024 * 1024
bad = []
for r in rows:
    if r['slug'] not in proto_slugs:
        bad.append(('invented slug', r['slug']))
    if not isinstance(r.get('name'), str) or not r['name']:
        bad.append(('bad name', r['slug']))
    if not isinstance(r.get('rank'), int) or r['rank'] <= 0:
        bad.append(('bad rank', r['slug']))
    iv = r.get('implied_value_usd')
    if not isinstance(iv, int) or iv <= 0 or iv > 100_000_000_000_000:
        bad.append(('bad implied', r['slug'], iv))
    if not isinstance(r.get('farm_steps'), list):
        bad.append(('no farm_steps', r['slug']))
check('board_file', rows_ok and not bad, f'{len(rows)} rows, {board_path.stat().st_size} bytes, bad={bad[:3]}')

# --- 3. sorted_by_value ---
ranks = sorted(r['rank'] for r in rows)
ranks_ok = ranks == list(range(1, len(rows) + 1))
by_rank = sorted(rows, key=lambda r: r['rank'])
mono = all(by_rank[i]['implied_value_usd'] <= by_rank[i - 1]['implied_value_usd'] for i in range(1, len(rows)))
not_all_equal = len({r['implied_value_usd'] for r in rows}) > 1
check('sorted_by_value', ranks_ok and mono and not_all_equal,
      f'ranks 1..{len(rows)} ok={ranks_ok}, non-increasing={mono}, distinct values={len({r["implied_value_usd"] for r in rows})}')
# rows must also be in rank order in the file? The gate reads rank field, not array order.
# (board.json rows are rank order in our output; note it.)

# --- 4. coverage ---
have = {r['slug'] for r in rows}
missing = [s for s in watchlist if s not in have]
check('coverage', not missing, f'{len(watchlist) - len(missing)}/{len(watchlist)} watchlist covered, missing={missing[:5]}')

# --- 5. farm_steps ---
step_bad = []
for r in rows:
    steps = r['farm_steps']
    if not (3 <= len(steps) <= 12):
        step_bad.append((r['slug'], f'{len(steps)} steps'))
        continue
    for s in steps:
        t = s.strip()
        if not (20 <= len(t) <= 600):
            step_bad.append((r['slug'], f'step {len(t)} chars'))
check('farm_steps', not step_bad, f'bad={step_bad[:3]}')

# --- 6. screenshots ---
shots_dir = OUT / 'screenshots'
shots = sorted(p for p in shots_dir.iterdir() if p.is_file() and not p.name.startswith('.'))
shot_ok = 3 <= len(shots) <= 4
dims = []
for p in shots:
    data = p.read_bytes()
    if len(data) > 512 * 1024:
        shot_ok = False
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        w, h = struct.unpack('>II', data[16:24])
    elif data[:3] == b'\xff\xd8\xff':
        w = h = 0
        i = 2
        while i < len(data) - 1:
            if data[i] != 0xFF:
                i += 1
                continue
            m = data[i + 1]
            if m in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack('>HH', data[i + 5:i + 9])
                break
            i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
        if w == 0:
            shot_ok = False
    else:
        shot_ok = False
        w = h = 0
    dims.append(f'{p.name} {w}x{h} {len(data) // 1024}KiB')
    if not (max(w, h) <= 1440 and min(w, h) >= 800):
        shot_ok = False
check('screenshots', shot_ok, '; '.join(dims))

# --- 7. dossier_matches (byte compare against a fresh buildDossier run) ---
print('INFO dossier_matches: verified by node rebuild (see gate_check_dossier.mjs)')

print()
if failures:
    print('FAILED ROWS:', ', '.join(failures))
    sys.exit(1)
print('ALL CHECKED ROWS PASS (dossier row verified separately)')
