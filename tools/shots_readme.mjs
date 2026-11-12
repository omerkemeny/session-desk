// @ts-check
// Pictures for README.md and docs/guide.md, taken from the demo page and the Legend with a fixed clock, weather and random seed.
// Usage: node tools/shots_readme.mjs [--out DIR]   (default docs/img; free ports; example data only, never a real server)
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from './smoke_lib.mjs';

const arg = (/** @type {string} */ k, /** @type {string} */ d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), OUT = arg('--out', join(ROOT, 'docs', 'img'));
const DAY = '2026-10-14';  // a fixed autumn day; the city is at UTC+3 then
// Frozen page at local time hh:mm of DAY: fixed Date, seeded Math.random, no animation frames (the same freeze as web/tests/world_check.mjs).
const FREEZE = (/** @type {string} */ hm) => `(() => { const T = ${Date.parse(`${DAY}T${hm}:00+03:00`)}, R = Date; class D extends R { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } }
  window.Date = D; let s = 7; Math.random = () => (s = s * 16807 % 2147483647) / 2147483647; window.requestAnimationFrame = () => 0; })()`;
const BOX = (/** @type {string} */ sel) => `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`;

/** Every picture: file, local time, page query, viewport, what to do first (JS run in the page), the element to clip, its height cap and side margin. */
const SHOTS = [
  { file: 'garden-day.png', at: '10:40', q: 'wx=1&crowd=6&tokens=3e6&prs=2&runs=1', w: 1100, h: 900, sel: 'body', cap: 620 },
  { file: 'garden-night.png', at: '21:30', q: 'wx=0&crowd=10&tokens=12e6&prs=6&runs=3&week=1101011&stale=2', w: 1100, h: 900, sel: '#garden' },
  { file: 'transcript.png', at: '10:40', q: 'wx=1', w: 1100, h: 620, act: `document.querySelector('.row[data-id="s8"]').click(); setTimeout(() => { document.getElementById('term').scrollTop = 0; }, 600)`, sel: '#drawer' },
  { file: 'stats.png', at: '10:40', q: 'wx=1&tokens=3e6&prs=2&runs=1', w: 1100, h: 900, act: `document.querySelector('.us-btn').click()`, sel: '.us', cap: 370 },
  { file: 'legend.png', at: '10:40', page: 'legend.html', q: '', w: 1100, h: 900, sel: '#day', cap: 250, pad: 12 },
];

const server = launch('python3', [join(ROOT, 'tools', 'dev_static.py'), '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
let chrome, failed = 0;
try {
  const m = await readLine(server, /http:\/\/\[::1\]:(\d+)\//); if (!m) throw new Error('dev_static.py did not start');
  const base = `http://[::1]:${m[1]}/`;
  let wsUrl; ({ chrome, wsUrl } = await startChrome(tempDir('desk-readme-')));
  const { send } = await devtools(wsUrl);
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*open-meteo.com*'] });  // weather comes from ?wx= only
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  const ev = async (/** @type {string} */ x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  mkdirSync(OUT, { recursive: true });
  for (const s of SHOTS) {
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE(s.at) });
    await send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${base}${s.page || ''}?clock=${s.at}&${s.q}` }); await sleep(2500);
    if (s.act) { await ev(s.act); await sleep(1200); }
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    const box = await ev(BOX(s.sel)), pad = s.pad || 0;
    const clip = { x: Math.max(0, box.x - pad), y: box.y, width: box.width + 2 * pad, height: Math.min(box.height, s.cap || box.height), scale: 1 };
    const shot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    const file = join(OUT, s.file);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const kb = statSync(file).size / 1024;
    if (kb > 150) failed++;
    console.log(`${kb > 150 ? 'FAIL' : 'ok  '}  ${s.file.padEnd(18)} ${Math.round(clip.width)}x${Math.round(clip.height)}  ${kb.toFixed(0)} KB`);
  }
} finally { await stop(chrome); await stop(server); }
process.exit(failed ? 1 : 0);
