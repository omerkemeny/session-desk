// World check: canvas pixel diff against a baseline copy of web/ with clock and randomness frozen, moving-layer frame times, and screenshots with data on.
// Usage: node web/tests/world_check.mjs --base /path/to/baseline/web [--shots DIR]   (the baseline's backdrop.js must export bgPaint and bgSpawn; free ports)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from '../../tools/smoke_lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..'), BASE = arg('--base', ''), SHOTS = arg('--shots', join(ROOT, '..', '.shots'));
if (!BASE) throw new Error('--base is required');
process.env.SMOKE_DEBUG_PORT ||= '0';
mkdirSync(SHOTS, { recursive: true });
const T0 = Date.parse('2026-11-11T10:00:00Z');
// Frozen page: fixed Date, seeded Math.random, no animation frames.
const FREEZE = `(() => { const T = ${T0}, R = Date; class D extends R { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } }
  window.Date = D; let s = 7; Math.random = () => (s = s * 16807 % 2147483647) / 2147483647; window.requestAnimationFrame = () => 0; })()`;
const PIXELS = `(() => { const c = document.getElementById('bg'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = '';
  for (let i = 0; i < d.length; i += 32768) s += String.fromCharCode.apply(null, d.subarray(i, i + 32768)); return { w: c.width, h: c.height, b: btoa(s) }; })()`;
const BENCH = `(async () => { const m = await import('/src/backdrop.js'), c = document.getElementById('bg').getContext('2d'), t = []; let s = Date.now() / 1000;
  for (let i = 0; i < 330; i++) { const a = performance.now(); m.bgSpawn(.1, s); m.bgPaint(s); c.getImageData(0, 0, 1, 1); if (i >= 30) t.push(performance.now() - a); s += .1; }
  t.sort((a, b) => a - b); return { med: t[150], p95: t[284], max: t[299] }; })()`;
const SCENES = { day: 'clock=12:00', dusk: 'clock=17:55', night: 'clock=22:00', rain: 'clock=12:00&wx=61', snow: 'clock=12:00&wx=71', fog: 'clock=12:00&wx=45' };

const servers = [0, 1].map(i => launch('python3', [join(ROOT, '..', 'tools', 'dev_static.py'), '--root', i ? ROOT : BASE, '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] }));
let chrome;
try {
  const urls = [];
  for (const s of servers) { const m = await readLine(s, /http:\/\/\[::1\]:(\d+)\//); if (!m) throw new Error('dev_static.py did not start'); urls.push(`http://[::1]:${m[1]}/`); }
  let wsUrl; ({ chrome, wsUrl } = await startChrome(tempDir('desk-world-')));
  const { send } = await devtools(wsUrl);
  await send('Page.enable'); await send('Runtime.enable');
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const open = async (url, w, ms) => { await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false }); await send('Page.navigate', { url }); await sleep(ms); };
  // 1. baseline diff at zero state: sunrise and sunset pinned to the baseline's 06:00 and 18:00, then following the real sun on 2026-11-11 (sunrise 06:06, sunset 16:44)
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE });
  const diffAt = async (q, w) => {
    const got = [];
    for (const u of urls) { await open(`${u}?${q}&tokens=0&prs=0&runs=0&week=0&vane=0&streak=0`, w, 1500); got.push(await ev(PIXELS)); }
    const [a, b] = got.map(g => Buffer.from(g.b, 'base64')), cw = got[0].w; let diff = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    if (a.length !== b.length) return { n: a.length / 4, diff: -1, box: '' };
    for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) { diff++; const p = i / 4, x = p % cw, y = Math.floor(p / cw); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { n: a.length / 4, diff, box: diff ? `${x0},${y0}-${x1},${y1}` : '' };
  };
  console.log('pinned 06:00-18:00   width  pixels  differ');
  for (const w of [1280, 800]) for (const [name, q] of Object.entries(SCENES)) { const r = await diffAt(q + '&sun=06:00-18:00', w); console.log(`${name.padEnd(20)} ${String(w).padEnd(6)} ${String(r.n).padStart(7)} ${String(r.diff).padStart(7)}`); }
  console.log('\nreal sun, 1280 px   pixels  differ  box (x0,y0-x1,y1)');
  for (const t of ['03:00', '06:30', '12:00', '15:30', '16:15', '16:45', '17:15', '17:55', '18:30', '22:00']) { const r = await diffAt('clock=' + t, 1280); console.log(`clock ${t}          ${String(r.n).padStart(7)} ${String(r.diff).padStart(7)}  ${r.box}`); }
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  // 2. frame time of the moving layer, before (baseline) and after (with every concept on)
  console.log('\nframe ms (300 frames)     median    p95    worst');
  for (const name of ['day', 'night', 'rain']) for (const [i, u] of urls.entries()) {
    await open(`${u}?crowd=14&${SCENES[name]}&tokens=12e6&prs=6&runs=3&rainago=20`, 1280, 2500);
    const r = await ev(BENCH); console.log(`${name.padEnd(6)} ${i ? 'after ' : 'before'}            ${r.med.toFixed(2).padStart(6)} ${r.p95.toFixed(2).padStart(6)} ${r.max.toFixed(2).padStart(6)}`);
  }
  // 3. screenshots with a crowd and every concept on
  for (const w of [1280, 800]) for (const name of ['day', 'night']) {
    await open(`${urls[1]}?crowd=14&${SCENES[name]}&tokens=12e6&prs=6&runs=3&rainago=40&week=1101011&stale=2`, w, 3500);
    const g = await ev(`(() => { const r = document.getElementById('garden').getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...g, scale: 1 } });
    writeFileSync(join(SHOTS, `world-${name}-${w}.png`), Buffer.from(shot.data, 'base64'));
  }
  console.log('\nscreenshots in', SHOTS);
} finally { await stop(chrome); for (const s of servers) await stop(s); }
