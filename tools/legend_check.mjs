// Legend page check in headless Chrome: every row drawn, no console errors, nothing wider than the page, keyboard reach; saves screenshots at 1280 and 390 px in light and dark.
// Usage: node tools/legend_check.mjs [--shots DIR] [--reduced]   (default shots folder: .shots/ in the repo, untracked)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from './smoke_lib.mjs';

const arg = (/** @type {string} */ k, /** @type {string} */ d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = dirname(fileURLToPath(import.meta.url)), shots = arg('--shots', join(HERE, '..', '.shots')), REDUCED = process.argv.includes('--reduced');
mkdirSync(shots, { recursive: true });
const fails = [], errs = [];
const check = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {unknown} */ info) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info === undefined ? '' : ' ' + JSON.stringify(info)}`); if (!ok) fails.push(name); };
const server = launch('python3', [join(HERE, 'dev_static.py'), '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
let chrome;
try {
  const m = await readLine(server, /http:\/\/\[::1\]:(\d+)\//); if (!m) throw new Error('dev_static.py did not start');
  const URL = `http://[::1]:${m[1]}/legend.html`;
  let wsUrl; ({ chrome, wsUrl } = await startChrome(tempDir('legend-chrome-')));
  const { send, on } = await devtools(wsUrl);
  const ev = async (/** @type {string} */ body) => { const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  on.set('Runtime.exceptionThrown', (/** @type {any} */ p) => errs.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  on.set('Runtime.consoleAPICalled', (/** @type {any} */ p) => { if (p.type === 'error' || p.type === 'warning') errs.push('console.' + p.type + ': ' + p.args.map((/** @type {any} */ a) => a.value ?? a.description).join(' ')); });
  on.set('Log.entryAdded', (/** @type {any} */ p) => { if (p.entry.level === 'error' && !/fonts\.(googleapis|gstatic)\.com/.test(p.entry.url || '')) errs.push('log: ' + p.entry.text + ' ' + (p.entry.url || '')); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  for (const [w, scheme] of /** @type {Array<[number, string]>} */ ([[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']])) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 700 });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: REDUCED ? 'reduce' : 'no-preference' }] });
    await send('Page.navigate', { url: URL });
    let n = 0; for (let i = 0; i < 60 && !n; i++) { await sleep(200); n = await ev(`return document.querySelectorAll('.lg-row').length && !document.querySelector('.lg-scene:empty') ? document.querySelectorAll('.lg-row').length : 0;`); }
    await sleep(400);
    const facts = await ev(`return { rows: document.querySelectorAll('.lg-row').length, empty: [...document.querySelectorAll('.lg-empty')].map(e => e.closest('.lg-row')?.id), wide: document.documentElement.scrollWidth - innerWidth,
      crops: document.querySelectorAll('.lg-scene canvas').length, keys: document.querySelectorAll('.lg-keys tbody tr').length, h: document.documentElement.scrollHeight, global: Object.keys(window).filter(k => /^(desk|DESK_TOKEN)$/.test(k)) };`);
    check(`${w} ${scheme}: every row drawn`, facts.rows > 40 && facts.crops >= 14 && facts.empty.length === (REDUCED ? 2 : 0), facts);
    check(`${w} ${scheme}: no sideways scroll`, facts.wide <= 0, facts.wide);
    const tag = `${w}-${scheme}${REDUCED ? '-reduced' : ''}`;
    for (const [i, y] of [...Array(14).keys()].map(i => [i, i * 900]).filter(([, y]) => y < facts.h)) {
      await ev(`scrollTo(0, ${y}); return 1;`); await sleep(150);
      writeFileSync(join(shots, `legend-${tag}-${i}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
  }
  // Keyboard: Tab reaches the section links and the zoom switch, which toggles.
  await ev(`scrollTo(0, 0); document.activeElement?.blur(); return 1;`);
  const seen = [];
  for (let i = 0; i < 9; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }); seen.push(await ev(`return document.activeElement?.textContent || '';`)); }
  check('Tab reaches links and the zoom switch', seen.includes('Keys') && seen.includes('3× zoom'), seen);
  const z = await ev(`document.querySelector('.lg-zoom').click(); await new Promise(r => setTimeout(r, 100)); return [document.body.classList.contains('lg-big'), document.documentElement.scrollWidth - innerWidth];`);
  check('zoom switch turns 3x on without sideways scroll', z[0] && z[1] <= 0, z);
  writeFileSync(join(shots, `legend-zoom${REDUCED ? '-reduced' : ''}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await ev(`document.querySelector('.lg-zoom').click(); return 1;`);
  check('no console errors', errs.length === 0, errs.slice(0, 5));
} catch (e) { check('run', false, String(e)); }
finally { await stop(chrome); await stop(server); }
console.log(fails.length ? `FAILED ${fails.length}` : 'ALL PASSED', '· shots in', shots);
process.exit(fails.length ? 1 : 0);
