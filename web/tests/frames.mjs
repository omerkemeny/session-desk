// Backdrop cost on the idle demo page: animation-frame callbacks, canvas paints, style recalculations and page CPU per second for a few skies, measured from 16 s after load.
// Usage: node web/tests/frames.mjs [--root DIR] [--secs 10] [--width 1280] [--only NAME]   (DIR defaults to this web/; free ports)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from '../../tools/smoke_lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = arg('--root', join(HERE, '..')), SECS = +arg('--secs', 10), WIDTH = +arg('--width', 1280), ONLY = arg('--only', '');
process.env.SMOKE_DEBUG_PORT ||= '0';
// Skies: calm clear night (with and without the demo's paper boats), calm day, rain, windy cloudy day; "paused" stops the backdrop loop to show the page's floor.
const SKIES = { 'calm clear night': 'clock=23:30&cloud=0', 'calm night no boats': 'clock=23:30&cloud=0&runs=0', 'calm day': 'clock=12:00&cloud=0', rain: 'clock=12:00&wx=61', 'windy cloudy day': 'clock=12:00&cloud=70&wind=40,270', 'paused night': 'clock=23:30&cloud=0&paused' };
// Counts rAF callbacks and full-canvas blits on #bg (two per backdrop paint); ?paused swallows the backdrop's frames.
const COUNT = `(() => { const c = window.__n = { raf: 0, blit: 0 }, raf = window.requestAnimationFrame.bind(window), paused = /[?&]paused/.test(location.search);
  window.requestAnimationFrame = f => raf(t => { c.raf++; if (paused && String(f).includes('bgs.raf = 0')) return; f(t); });
  const di = CanvasRenderingContext2D.prototype.drawImage; CanvasRenderingContext2D.prototype.drawImage = function (...a) { if (this.canvas.id === 'bg' && a.length === 3 && a[1] === 0 && a[2] === 0 && a[0].width === this.canvas.width) c.blit++; return di.apply(this, a); }; })()`;

// Without --only, each sky runs in its own process: counts leak between skies measured in one process.
if (!ONLY) {
  console.log(`sky                  raf/s  paints/s  style/s  cpu %   (${SECS} s, ${WIDTH} px, root ${ROOT})`);
  for (const k of Object.keys(SKIES)) process.stdout.write(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--root', ROOT, '--secs', String(SECS), '--width', String(WIDTH), '--only', k, '--quiet'], { encoding: 'utf8' }));
  process.exit(0);
}
const srv = launch('python3', [join(HERE, '..', '..', 'tools', 'dev_static.py'), '--root', ROOT, '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
let chrome;
try {
  const m = await readLine(srv, /http:\/\/\[::1\]:(\d+)\//); if (!m) throw new Error('dev_static.py did not start');
  if (!process.argv.includes('--quiet')) console.log(`sky                  raf/s  paints/s  style/s  cpu %   (${SECS} s, ${WIDTH} px, root ${ROOT})`);
  // A fresh browser per sky: pages left behind in one renderer process would count in the next sky's numbers.
  for (const [name, q] of Object.entries(SKIES)) {
    if (ONLY && !name.includes(ONLY)) continue;
    let wsUrl; ({ chrome, wsUrl } = await startChrome(tempDir('desk-frames-')));
    const { send } = await devtools(wsUrl);
    await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable', { timeDomain: 'timeTicks' });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT });
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 1000, deviceScaleFactor: 1, mobile: false });
    const ev = async x => (await send('Runtime.evaluate', { expression: x, returnByValue: true })).result.value;
    const met = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(q => [q.name, q.value]));
    await send('Page.navigate', { url: `http://[::1]:${m[1]}/?crowd=14&${q}` }); await sleep(16000);  // after the demo's 9 s walk-in
    const a = await met(), n0 = await ev('({ ...window.__n })'); await sleep(SECS * 1000); const b = await met(), n1 = await ev('({ ...window.__n })');
    const dt = b.Timestamp - a.Timestamp, per = k => (b[k] - a[k]) / dt;
    console.log(`${name.padEnd(20)} ${((n1.raf - n0.raf) / dt).toFixed(1).padStart(5)} ${((n1.blit - n0.blit) / 2 / dt).toFixed(2).padStart(9)} ${per('RecalcStyleCount').toFixed(2).padStart(8)} ${(per('TaskDuration') * 100).toFixed(2).padStart(6)}`);
    await stop(chrome); chrome = null;
  }
} finally { await stop(chrome); await stop(srv); }
