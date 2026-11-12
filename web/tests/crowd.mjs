// Crowded-garden check: renders 6, 12 and 17 waiting characters at 1280 and 800 px in headless Chrome, counts overlaps, saves screenshots; --shrink also sends the 12 newest of 17 to work and measures how the 5 left regroup.
// Columns wide/cut/dir: tags wider than their max-width, tags whose text is cut sideways without an ellipsis, tags without dir="auto"; hoverOut: hovered tags that leave the garden box. --hard uses ?titles=hard.
// --narrow: at 320 and 390 px with 0, 3 and 17 waiting and 0, 3 and 12 working, counts overlaps among the sign, weather plaque, both "+N" marks, door notes, camp fire, cat, vane, nest and tags, and those leaving the garden box.
// Usage: node web/tests/crowd.mjs [--narrow] [--shots DIR] [--label NAME] [--reduced] [--shrink] [--hard] [--height 1000] [--query "&clock=20:30"]   (free ports unless CROWD_PORT / SMOKE_DEBUG_PORT say otherwise)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from '../../tools/smoke_lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const SHOTS = arg('--shots', join(ROOT, '..', '.shots')), LABEL = arg('--label', 'now'), EXTRA = arg('--query', '') + (process.argv.includes('--hard') ? '&titles=hard' : ''), REDUCED = process.argv.includes('--reduced'), HEIGHT = +arg('--height', 1000), SHRINK = process.argv.includes('--shrink'), NARROW = process.argv.includes('--narrow');
process.env.SMOKE_DEBUG_PORT ||= '0';
mkdirSync(SHOTS, { recursive: true });

// In-page measurement: tag/tag, tag/character and bubble overlaps, bodies more than a third covered, tags clipped by the garden edge.
const MEASURE = `(() => {
  const g = document.getElementById('garden').getBoundingClientRect(), R = e => e.getBoundingClientRect();
  const on = e => { if (!e) return false; const c = getComputedStyle(e); return c.visibility !== 'hidden' && c.display !== 'none' && e.getClientRects().length > 0; };
  const cut = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const all = [...document.querySelectorAll('#actors .agent')].filter(a => !a.classList.contains('bye') && !a.classList.contains('sleeper'));
  const ags = all.filter(a => !a.classList.contains('miner'));
  const tags = ags.map(a => [a, a.querySelector('.tag')]).filter(([, t]) => on(t)), bubs = ags.map(a => [a, a.querySelector('.bubble')]).filter(([, b]) => on(b));
  let tagTag = 0, tagChar = 0, bubBub = 0, bubTag = 0, clipped = 0, covered = 0;
  for (let i = 0; i < tags.length; i++) { const r = R(tags[i][1]); if (r.left < g.left - 1 || r.right > g.right + 1 || r.bottom > g.bottom + 1) clipped++; for (let j = i + 1; j < tags.length; j++) if (cut(r, R(tags[j][1])) > 4) tagTag++; }
  const pairs = [];
  for (const [a, t] of tags) for (const b of all) if (b !== a && cut(R(t), R(b.querySelector('.pix, .sprite'))) > 16) { tagChar++; pairs.push(a.dataset.id + '>' + b.dataset.id + (b.classList.contains('miner') ? '(miner)' : '')); }
  for (let i = 0; i < bubs.length; i++) { for (let j = i + 1; j < bubs.length; j++) if (cut(R(bubs[i][1]), R(bubs[j][1])) > 4) bubBub++; for (const [a, t] of tags) if (a !== bubs[i][0] && cut(R(bubs[i][1]), R(t)) > 4) bubTag++; }
  const worst = [];
  for (const a of ags) {
    const p = R(a.querySelector('.pix')); let hid = 0, n = 0;
    for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) { const e = document.elementFromPoint(p.left + p.width * x / 7, p.top + p.height * y / 7); n++; if (!e || !a.contains(e)) hid++; }
    if (hid / n > 1 / 3) { covered++; worst.push(a.dataset.id); }
  }
  // Grouping: mean px to the nearest same-project character against the nearest character of any project, and how many have a teammate as nearest neighbour.
  const S = window.desk.S, proj = a => (S.find(s => s.id === a.dataset.id) || {}).project, at = a => { const p = R(a.querySelector('.pix')); return [p.left + p.width / 2, p.bottom]; };
  let same = 0, any = 0, k = 0, mate = 0;
  for (const a of ags) { const mates = ags.filter(b => b !== a && proj(b) === proj(a)); if (!mates.length) continue; const [x, y] = at(a), d = b => { const [u, v] = at(b); return Math.hypot(u - x, v - y); };
    const ds = Math.min(...mates.map(d)), da = Math.min(...ags.filter(b => b !== a).map(d)); same += ds; any += da; k++; if (ds <= da) mate++; }
  const group = k ? (same / k).toFixed(0) + '/' + (any / k).toFixed(0) + ' ' + mate + '/' + k : '-';
  const notch = tags.filter(([a]) => a.matches('.tagr, .tagl, .tagu')).length + '/' + tags.filter(([a]) => getComputedStyle(a, '::after').content !== 'none').length;
  // Tag text: wider than its max-width, cut sideways (no ellipsis), or missing dir="auto" on the shown text.
  let wide = 0, cut2 = 0, nodir = 0;
  for (const [, t] of tags) { const c = getComputedStyle(t), mw = parseFloat(c.maxWidth); if (t.offsetWidth > mw + 0.5) wide++; if (t.scrollWidth > t.clientWidth + 1) cut2++; const sp = [...t.children].find(e => getComputedStyle(e).display !== 'none') || t; if (sp.closest('[dir="auto"]') == null) nodir++; }
  return { wide, cut: cut2, nodir, group, notch, chars: ags.length, tagsShown: tags.length, tagTag, tagChar, bubBub, bubTag, clipped, covered, worst: [...worst, ...pairs].join(' ') };
})()`;


// Narrow pages: named boxes (DOM marks, plus the canvas-drawn notes and cat from the backdrop's geometry) that overlap each other or leave the garden.
const MARKS = `(async () => { const b = (await import('/src/backdrop.js')).bgs, g = document.getElementById('garden').getBoundingClientRect(), c = document.getElementById('bg'), cr = c.getBoundingClientRect(), k = cr.width / c.width, kh = cr.height / c.height;
  const on = e => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.display !== 'none' && e.getClientRects().length > 0; }, R = e => e.getBoundingClientRect(), box = [];
  for (const [n, sel] of [['sign', '#sign'], ['wx', '#wx'], ['signN', '#sign .more'], ['mineN', '#minemore'], ['fire', '#actors .fire']]) for (const e of document.querySelectorAll(sel)) if (on(e)) box.push([n, R(e)]);
  for (const e of document.querySelectorAll('#actors .agent:not(.bye) .tag')) if (on(e)) { const a = e.closest('.agent'), m = a._tm, ar = R(a); box.push(['tag:' + a.dataset.id + (${process.env.CROWD_DEBUG ? 1 : 0} ? '[' + a.className + ' w' + e.offsetWidth + ' h' + e.offsetHeight + ' model' + (m ? m.one.w + 'x' + m.one.h : '-') + ' body' + Math.round(ar.left) + '-' + Math.round(ar.right) + ']' : ''), R(e)]); }
  for (const [n, q] of [['notes', b.notesBox], ['cat', b.catBox], ['vane', b.vaneBox], ['nest', b.nestBox]]) if (q) box.push([n, { left: cr.left + q[0] * k, top: cr.top + q[1] * kh, right: cr.left + (q[0] + q[2]) * k, bottom: cr.top + (q[1] + q[3]) * kh }]);
  const cut = (a, c) => Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) * Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
  const over = [], out = [];
  for (let i = 0; i < box.length; i++) { const [n, r] = box[i]; if (r.left < g.left - 1 || r.right > g.right + 1 || r.top < g.top - 1 || r.bottom > g.bottom + 1) out.push(n + '@' + [r.left - g.left, r.right - g.right, r.top - g.top, r.bottom - g.bottom].map(Math.round).join(','));
    for (let j = i + 1; j < box.length; j++) { const [m] = box[j]; if (n === 'sign' && m === 'signN' || m === 'sign' && n === 'signN' || n.startsWith('tag') && m.startsWith('tag')) continue; if (cut(r, box[j][1]) > 4) over.push(n + '/' + m); } }
  const tt = box.filter(([n]) => n.startsWith('tag')); let tagTag = 0; for (let i = 0; i < tt.length; i++) for (let j = i + 1; j < tt.length; j++) if (cut(tt[i][1], tt[j][1]) > 4) tagTag++;
  return { h: Math.round(g.height), marks: box.length, tagTag, over, out }; })()`;

const server = launch('python3', [join(ROOT, '..', 'tools', 'dev_static.py'), '--root', ROOT, '--port', process.env.CROWD_PORT || '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
let chrome;
try {
  const m = await readLine(server, /http:\/\/\[::1\]:(\d+)\//); if (!m) throw new Error('dev_static.py did not start');
  const URL = `http://[::1]:${m[1]}/`;
  let wsUrl; ({ chrome, wsUrl } = await startChrome(tempDir('desk-crowd-')));
  const { send } = await devtools(wsUrl);
  await send('Page.enable'); await send('Runtime.enable');
  if (REDUCED) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const rows = [];
  if (NARROW) {
    console.log('width waiting working  garden h  marks  tag/tag  overlaps  outside  which');
    let bad = 0;
    for (const w of [320, 390]) for (const n of [0, 3, 17]) for (const wk of [0, 3, 12]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: true });
      await send('Page.navigate', { url: `${URL}?crowd=${n}&working=${wk}&notes=3&cat=1&clock=20:30${EXTRA}` }); await sleep(1200);
      await ev(`(() => { const S = window.desk.S; if (${n} === 0) S.filter(s => s.status === 'waiting').forEach(s => s.status = 'done'); if (${wk} === 0) S.filter(s => s.status === 'running').forEach(s => s.status = 'done'); window.desk.render(); })()`);
      await sleep(10500);
      const r = await ev(MARKS); bad += r.over.length + r.out.length + r.tagTag;
      console.log(`${String(w).padEnd(6)}${String(n).padStart(7)}${String(wk).padStart(8)}  ${String(r.h).padStart(8)} ${String(r.marks).padStart(6)} ${String(r.tagTag).padStart(8)} ${String(r.over.length).padStart(9)} ${String(r.out.length).padStart(8)}  ${[...r.over, ...r.out.map(x => 'out:' + x)].join(' ')}`);
      const g = await ev(`(() => { const r = document.getElementById('garden').getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
      const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...g, scale: 1 } });
      writeFileSync(join(SHOTS, `${LABEL}-narrow-${w}-${n}-${wk}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(bad ? `narrow: ${bad} problems` : 'narrow: clean'); process.exitCode = bad ? 1 : 0;
  }
  if (!NARROW) for (const w of [1280, 800]) for (const n of [6, 12, 17]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${URL}?crowd=${n}${EXTRA}` }); await sleep(3200);
    const r = await ev(MEASURE);
    // Hover each meadow character in turn: its full tag must stay inside the garden box.
    const pts = await ev(`[...document.querySelectorAll('#actors .agent:not(.miner):not(.bye)')].map(a => { const p = a.querySelector('.pix').getBoundingClientRect(); return [p.left + p.width / 2, p.top + p.height / 2]; })`);
    let hoverOut = 0;
    for (const [x, y] of pts) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(60);
      hoverOut += await ev(`(() => { const g = document.getElementById('garden').getBoundingClientRect(), a = document.querySelector('#actors .agent:hover'), t = a && a.querySelector('.tag'); if (!t || getComputedStyle(t).visibility === 'hidden') return 0; const q = t.getBoundingClientRect(); return q.left < g.left - 1 || q.right > g.right + 1 || q.bottom > g.bottom + 1 ? 1 : 0; })()`); }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }); await sleep(100);
    rows.push({ w, n, hoverOut, ...r });
    const g = await ev(`(() => { const r = document.getElementById('garden').getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...g, scale: 1 } });
    writeFileSync(join(SHOTS, `${LABEL}-${w}-${n}.png`), Buffer.from(shot.data, 'base64'));
  }
  // Shrink: 17 waiting, the 12 newest start working; spread of the 5 left (mean px from their centre, box width) right after and once regrouped.
  const SPREAD = `(() => { const R = e => e.getBoundingClientRect(), ags = [...document.querySelectorAll('#actors .agent:not(.miner):not(.bye):not(.fisher)')].map(a => { const p = R(a.querySelector('.pix')); return [p.left + p.width / 2, p.bottom]; });
    const cx = ags.reduce((s, p) => s + p[0], 0) / ags.length, cy = ags.reduce((s, p) => s + p[1], 0) / ags.length, xs = ags.map(p => p[0]);
    return { n: ags.length, mean: Math.round(ags.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / ags.length), box: Math.round(Math.max(...xs) - Math.min(...xs)), walking: document.querySelectorAll('#actors .agent.walking').length }; })()`;
  const shrink = [];
  if (SHRINK) for (const w of [1280, 800]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${URL}?crowd=17${EXTRA}` }); await sleep(3500);
    const at17 = await ev(SPREAD);
    await ev(`(() => { const S = window.desk.S, w = S.filter(s => s.status === 'waiting').sort((a, b) => b.updated - a.updated).slice(0, 12); for (const s of w) s.status = 'running'; window.desk.render(); })()`);
    await sleep(3000); const left = await ev(SPREAD), m0 = await ev(MEASURE);
    let after = left; for (let t = 0; t < 40; t++) { await sleep(1000); after = await ev(SPREAD); if (t > 6 && !after.walking) break; }
    await sleep(1500); after = await ev(SPREAD); const m1 = await ev(MEASURE);
    shrink.push({ w, at17, left, after, tags: m0.tagsShown + '>' + m1.tagsShown, tagChar: m0.tagChar + '>' + m1.tagChar });
    const g = await ev(`(() => { const r = document.getElementById('garden').getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...g, scale: 1 } });
    writeFileSync(join(SHOTS, `${LABEL}-shrink-${w}.png`), Buffer.from(shot.data, 'base64'));
  }
  if (shrink.length) { console.log('shrink 17 -> 5   width  spread at 17  left (mean/box)  regrouped (mean/box)  tags  tag/char');
    for (const r of shrink) console.log(`                 ${String(r.w).padEnd(6)} ${(r.at17.mean + '/' + r.at17.box).padEnd(13)} ${(r.left.mean + '/' + r.left.box + ' n' + r.left.n).padEnd(16)} ${(r.after.mean + '/' + r.after.box).padEnd(21)} ${r.tags.padEnd(5)} ${r.tagChar}`); }
  console.log('width  n  chars tags  tag/tag tag/char bub/bub bub/tag clipped covered wide cut nodir hoverOut  group(same/any px, mate nearest)  aside/notched  worst');
  for (const r of rows) console.log(`${String(r.w).padEnd(6)}${String(r.n).padStart(2)}  ${String(r.chars).padStart(5)} ${String(r.tagsShown).padStart(4)}  ${String(r.tagTag).padStart(7)} ${String(r.tagChar).padStart(8)} ${String(r.bubBub).padStart(7)} ${String(r.bubTag).padStart(7)} ${String(r.clipped).padStart(7)} ${String(r.covered).padStart(7)} ${String(r.wide).padStart(4)} ${String(r.cut).padStart(3)} ${String(r.nodir).padStart(5)} ${String(r.hoverOut).padStart(8)}  ${r.group.padEnd(32)} ${r.notch.padEnd(14)} ${r.worst}`);
} finally { await stop(chrome); await stop(server); }
