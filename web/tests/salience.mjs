// Calm-scene measure: per wait state, how much a character stands out from the grass (perceptual colour difference, chroma, warm pixels), motion and colour counts in a busy scene, and idle layout cost; saves screenshots.
// Usage: node web/tests/salience.mjs [--quick] [--root DIR] [--label NAME] [--shots DIR] [--skip idle,motion,shots,salience,identity]   (DIR: a web/ folder, default this one; free ports)
// --quick: one page load per sky for salience, no reduced-motion pass, 1280 px shots only, 12 s idle with the outside of the garden stopped.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from '../../tools/smoke_lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = arg('--root', join(HERE, '..')), LABEL = arg('--label', 'now'), SHOTS = arg('--shots', join(HERE, '..', '..', '.shots')), SKIP = arg('--skip', ''), QUICK = process.argv.includes('--quick');
process.env.SMOKE_DEBUG_PORT ||= '0';
mkdirSync(SHOTS, { recursive: true });

// Wait states in salience order, as minutes waited.
const STATES = [['recent', 2], ['normal', 9], ['long-sit', 30], ['long-nap', 90], ['day-old', 26 * 60]];
// Realistic mix for 17 waiting sessions by id order: minutes waited, then p for a pull request, e for a failed step.
const MIX = ['1', '26h p', '3 e', '26h p', '12', '26h', '40 p', '26h p', '7 p', '90', '26h p', '20 e', '26h', '4', '130 p', '9 p', '2'];
const mins = t => t.endsWith('h') ? parseFloat(t) * 60 : parseFloat(t);
/** In-page: set wait age, pull request and failure for the waiting sessions by id order, then redraw. */
const SET = list => `(() => { const S = window.desk.S.filter(s => s.status === 'waiting').sort((a, b) => a.id < b.id ? -1 : 1), now = Date.now(), L = ${JSON.stringify(list)};
  S.forEach((s, i) => { const [m, f] = L[i % L.length]; const t = now - m * 60000; Object.assign(s, { waitingSince: t, updated: t, statusAt: t, prOpened: f.includes('p') ? 1 : 0, lastError: f.includes('e') }); });
  window.desk.render(); return S.length; })()`;
/** In-page: the waiting characters' own boxes (body, bubble, tag, props) relative to the garden, with each one's wait minutes. */
const RECTS = `(() => { const g = document.getElementById('garden').getBoundingClientRect(), S = window.desk.S;
  const on = e => { const c = getComputedStyle(e); return c.visibility !== 'hidden' && c.display !== 'none' && +c.opacity > 0 && e.getClientRects().length > 0; };
  return [...document.querySelectorAll('#actors .agent:not(.miner):not(.bye):not(.fisher)')].map(a => { const s = S.find(x => x.id === a.dataset.id);
    const rs = [...a.querySelectorAll('.pix, .bubble, .tag, .seat, .flag, .umb, .blanket')].filter(on).map(e => { const r = e.getBoundingClientRect(); return [r.left - g.left, r.top - g.top, r.width, r.height]; });
    return { id: a.dataset.id, m: (Date.now() - s.waitingSince) / 60000, rs }; }); })()`;
// In-page analysis of two PNGs (scene, scene without the characters): per box set, colour difference mass, mean, chroma and warm pixels.
const ANALYSE = `async (a, b, sets) => {
  const load = async u => { const i = new Image(); i.src = 'data:image/png;base64,' + u; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return { w: i.width, h: i.height, d: x.getImageData(0, 0, i.width, i.height).data }; };
  const A = await load(a), B = await load(b), lin = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4, f = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const lab = (d, i) => { const r = lin(d[i]), g = lin(d[i + 1]), bl = lin(d[i + 2]); const X = (r * .4124 + g * .3576 + bl * .1805) / .9505, Y = r * .2126 + g * .7152 + bl * .0722, Z = (r * .0193 + g * .1192 + bl * .9505) / 1.089;
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]; };
  const hsv = (d, i) => { const r = d[i] / 255, g = d[i + 1] / 255, bl = d[i + 2] / 255, mx = Math.max(r, g, bl), mn = Math.min(r, g, bl), c = mx - mn; let h = 0;
    if (c) h = mx === r ? ((g - bl) / c + 6) % 6 : mx === g ? (bl - r) / c + 2 : (r - g) / c + 4; return [h * 60, mx ? c / mx : 0, mx]; };
  return sets.map(rs => { const seen = new Set(); let mass = 0, n = 0, ch = 0, warm = 0;
    for (const [x0, y0, w, h] of rs) for (let y = Math.max(0, Math.floor(y0)); y < Math.min(A.h, Math.ceil(y0 + h)); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(A.w, Math.ceil(x0 + w)); x++) {
      const k = y * A.w + x; if (seen.has(k)) continue; seen.add(k); const i = k * 4, p = lab(A.d, i), q = lab(B.d, i), e = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); if (e < 4) continue;
      mass += e; n++; ch += Math.hypot(p[1], p[2]); const [hu, s, v] = hsv(A.d, i); if (s > .55 && v > .7 && (hu < 65 || hu >= 330)) warm++; }
    return { mass: mass / 1000, mean: n ? mass / n : 0, chroma: n ? ch / n : 0, warm, px: n }; }); }`;
// In-page: saturated hue bins (30 degrees, at least 30 px) among pixels where two PNGs differ.
const HUES = `async (a, b) => {
  const load = async u => { const i = new Image(); i.src = 'data:image/png;base64,' + u; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
  const A = await load(a), B = await load(b), bins = new Array(12).fill(0); let red = 0;
  for (let i = 0; i < A.length; i += 4) { if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) < 24) continue;
    const r = A[i] / 255, g = A[i + 1] / 255, bl = A[i + 2] / 255, mx = Math.max(r, g, bl), c = mx - Math.min(r, g, bl); if (!mx || c / mx < .5 || mx < .4) continue;
    const h = (mx === r ? ((g - bl) / c + 6) % 6 : mx === g ? (bl - r) / c + 2 : (r - g) / c + 4) * 60; bins[Math.floor(h / 30) % 12]++; if (h < 15 || h >= 345) red++; }
  return { hues: bins.filter(n => n >= 30).length, bins, red }; }`;
const MOTION = `(() => { const an = document.getAnimations().filter(a => a.playState === 'running'), loop = an.filter(a => a.effect.getTiming().iterations === Infinity);
  const els = new Set(loop.map(a => a.effect.target)), per = new Set(loop.map(a => Math.round(a.effect.getComputedTiming().duration))), agents = [...document.querySelectorAll('#actors .agent:not(.bye)')];
  const most = Math.max(0, ...agents.map(ag => loop.filter(a => ag.contains(a.effect.target)).length));
  const names = {}; for (const a of loop) names[a.animationName] = (names[a.animationName] || 0) + 1;
  return { loops: loop.length, elements: els.size, periods: per.size, perChar: most, oneShot: an.length - loop.length, names }; })()`;

// sRGB to CIE Lab (D65), Euclidean dE76 and CIEDE2000 for the identity table.
const lin = v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4, fl = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
const lab = ([r, g, b]) => { r = lin(r); g = lin(g); b = lin(b); const X = (r * .4124 + g * .3576 + b * .1805) / .9505, Y = r * .2126 + g * .7152 + b * .0722, Z = (r * .0193 + g * .1192 + b * .9505) / 1.089; return [116 * fl(Y) - 16, 500 * (fl(X) - fl(Y)), 200 * (fl(Y) - fl(Z))]; };
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
function de00([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180, Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2, G = .5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7))), p1 = a1 * (1 + G), p2 = a2 * (1 + G), C1 = Math.hypot(p1, b1), C2 = Math.hypot(p2, b2);
  const hue = (b, a) => { const h = Math.atan2(b, a) / rad; return h < 0 ? h + 360 : h; }, h1 = hue(b1, p1), h2 = hue(b2, p2);
  let dh = C1 * C2 ? h2 - h1 : 0; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin(dh * rad / 2), Lb = (L1 + L2) / 2, Cp = (C1 + C2) / 2;
  const hb = !(C1 * C2) ? h1 + h2 : Math.abs(h1 - h2) > 180 ? (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2) : (h1 + h2) / 2;
  const T = 1 - .17 * Math.cos((hb - 30) * rad) + .24 * Math.cos(2 * hb * rad) + .32 * Math.cos((3 * hb + 6) * rad) - .2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + .015 * (Lb - 50) ** 2 / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + .045 * Cp, SH = 1 + .015 * Cp * T, RT = -Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad) * 2 * Math.sqrt(Cp ** 7 / (Cp ** 7 + 25 ** 7));
  return Math.sqrt(((L2 - L1) / SL) ** 2 + ((C2 - C1) / SC) ** 2 + (dH / SH) ** 2 + RT * ((C2 - C1) / SC) * (dH / SH));
}

const server = launch('python3', [join(HERE, '..', '..', 'tools', 'dev_static.py'), '--root', ROOT, '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
let chrome;
try {
  const m = await readLine(server, /http:\/\/\[::1\]:(\d+)\//); if (!m) throw new Error('dev_static.py did not start');
  const URL = `http://[::1]:${m[1]}/`;
  let wsUrl; ({ chrome, wsUrl } = await startChrome(tempDir('desk-sal-')));
  const { send } = await devtools(wsUrl);
  await send('Page.enable'); await send('Runtime.enable'); await send('Animation.enable'); await send('Performance.enable');
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const size = async w => send('Emulation.setDeviceMetricsOverride', { width: w, height: 1000, deviceScaleFactor: 1, mobile: false });
  const open = async (q, ms = 3400) => { await send('Page.navigate', { url: URL + q }); await send('Animation.setPlaybackRate', { playbackRate: 1 }); await sleep(ms); };
  const clip = async () => ev(`(() => { const r = document.getElementById('garden').getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, width: r.width, height: r.height, scale: 1 }; })()`);
  const shot = async () => (await send('Page.captureScreenshot', { format: 'png', clip: await clip() })).data;
  // Holds the scene still: CSS animations at rate 0, no more backdrop frames.
  const freeze = async () => { await send('Animation.setPlaybackRate', { playbackRate: 0 }); await ev(`window.__raf ||= window.requestAnimationFrame; window.requestAnimationFrame = () => 0; true`); await sleep(300); };
  // Lets the scene move again after freeze (quick mode reuses one page load), dropping the styles added by css().
  const thaw = async () => { await ev(`window.requestAnimationFrame = window.__raf || window.requestAnimationFrame; document.querySelectorAll('style.sal').forEach(e => e.remove()); true`); await send('Animation.setPlaybackRate', { playbackRate: 1 }); };
  const css = async t => ev(`(() => { const s = document.createElement('style'); s.className = 'sal'; s.textContent = ${JSON.stringify(t)}; document.head.append(s); return true; })()`);
  const fn = async (src, ...a) => ev(`(${src})(${a.map(x => JSON.stringify(x)).join(',')})`);

  if (!SKIP.includes('identity')) {
    // Identity: the 8 body colours as drawn at app size (4 px per pixel) on the garden's own grass, day-old (muted, under the blanket) against full colour (nap pose); pairwise colour difference of the body pixels.
    console.log(`identity of day-old characters (${LABEL}): pairwise body-colour difference, dE2000 / dE76, min and the closest pair; strip saved as ${SHOTS}/id-${LABEL}-{day,night}.png`);
    for (const [sky, clock] of [['day', '12:00'], ['night', '22:00']]) {
      await size(1280); await open(`?crowd=0&clock=${clock}`, 2500);
      const r = await ev(`(async () => { const S = await import('./src/sprites.js'), bg = document.getElementById('bg'), gx = bg.getContext('2d'), p = gx.getImageData(Math.round(bg.width * .5), Math.round(bg.height * .82), 1, 1).data;
        const U = 4, n = S.BODIES.length, hat = S.HN[0], c = document.createElement('canvas'); c.width = n * 20 * U; c.height = 2 * 20 * U; const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
        x.fillStyle = 'rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')'; x.fillRect(0, 0, c.width, c.height);
        const img = u => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.src = u; }), blanket = await img(S.propSheet(['blanket']));
        for (let k = 0; k < n; k++) for (const [row, muted] of [[0, true], [1, false]]) { const i = await img(S.poseSheet(hat, k, 'nap', '', muted)); x.drawImage(i, 0, 0, 16, 15, (k * 20 + 2) * U, (row * 20 + 3) * U, 16 * U, 15 * U); if (muted) x.drawImage(blanket, (k * 20 + 2) * U, (row * 20 + 3 + 11) * U, 16 * U, 4 * U); }
        const d = x.getImageData(0, 0, c.width, c.height).data, body = (k, row) => { const m = new Map(); for (let yy = (row * 20 + 3 + 5) * U; yy < (row * 20 + 3 + 11) * U; yy++) for (let xx = (k * 20 + 2) * U; xx < (k * 20 + 18) * U; xx++) { const i = (yy * c.width + xx) * 4, key = d[i] + ',' + d[i + 1] + ',' + d[i + 2]; m.set(key, (m.get(key) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number); };
        return { grass: [p[0], p[1], p[2]], names: S.BODIES.map(b => b[2]), muted: [...Array(n)].map((_, k) => body(k, 0)), full: [...Array(n)].map((_, k) => body(k, 1)), png: c.toDataURL().split(',')[1] }; })()`);
      writeFileSync(join(SHOTS, `id-${LABEL}-${sky}.png`), Buffer.from(r.png, 'base64'));
      const pairs = set => { const out = []; for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) out.push([r.names[i] + '/' + r.names[j], de00(lab(set[i]), lab(set[j])), dist(lab(set[i]), lab(set[j]))]); return out; };
      const m = pairs(r.muted), f = pairs(r.full), min = l => l.reduce((a, b) => b[1] < a[1] ? b : a);
      console.log(`  ${sky.padEnd(5)} grass rgb(${r.grass})  full: min ${min(f)[1].toFixed(1)} / ${Math.min(...f.map(q => q[2])).toFixed(1)} (${min(f)[0]})  day-old: min ${min(m)[1].toFixed(1)} / ${Math.min(...m.map(q => q[2])).toFixed(1)} (${min(m)[0]})`);
      if (sky === 'day') { console.log('        pair             full dE00  dE76   day-old dE00  dE76'); m.forEach((q, i) => console.log(`        ${q[0].padEnd(16)} ${f[i][1].toFixed(1).padStart(9)} ${f[i][2].toFixed(1).padStart(5)}   ${q[1].toFixed(1).padStart(12)} ${q[2].toFixed(1).padStart(5)}`)); }
    }
  }

  if (!SKIP.includes('salience')) {
    // Each state is worn in turn by every meadow character, so looks and tags average out.
    console.log(`salience per wait state (${LABEL}): mass = summed colour difference from the scene without characters (thousands of dE76), mean dE, chroma C*, warm px (bright saturated red/orange/yellow: HSV s > .55, v > .7)`);
    for (const [sky, clock] of [['day', '12:00'], ['night', '22:00']]) {
      const acc = Object.fromEntries(STATES.map(([k]) => [k, { mass: 0, mean: 0, chroma: 0, warm: 0, px: 0, n: 0 }]));
      await size(1280);
      for (let r = 0; r < STATES.length; r++) {
        if (!QUICK || !r) await open(`?crowd=12&clock=${clock}`, 3000); else await thaw();
        const list = Array.from({ length: 17 }, (_, i) => [STATES[(i + r) % STATES.length][1], '']);
        await ev(SET(list)); await sleep(1500); await freeze();
        const rects = await ev(RECTS), a = await shot();
        await css('#actors .agent:not(.miner), #actors .rod { visibility: hidden !important }'); await sleep(150); const b = await shot();
        const res = await fn(ANALYSE, a, b, rects.map(x => x.rs));
        rects.forEach((x, i) => { const st = STATES.find(([, mm]) => Math.abs(mm - x.m) < 1)?.[0]; if (!st) return; const o = acc[st]; for (const k of ['mass', 'mean', 'chroma', 'warm', 'px']) o[k] += res[i][k]; o.n++; });
      }
      console.log(`  ${sky.padEnd(5)} state      n   mass   mean dE  chroma  warm px   px`);
      for (const [k] of STATES) { const o = acc[k], d = Math.max(1, o.n); console.log(`        ${k.padEnd(9)} ${String(o.n).padStart(3)} ${(o.mass / d).toFixed(2).padStart(6)} ${(o.mean / d).toFixed(1).padStart(8)} ${(o.chroma / d).toFixed(1).padStart(7)} ${(o.warm / d).toFixed(0).padStart(8)} ${(o.px / d).toFixed(0).padStart(5)}`); }
    }
  }

  if (!SKIP.includes('motion')) {
    // Busy scene: 14 meadow and pond characters at night in rain with the realistic mix of stale waits, pennants and failures.
    for (const reduced of QUICK ? [false] : [false, true]) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
      await size(1280); await open('?crowd=14&clock=22:00&wx=61');
      await ev(SET(MIX.map(t => [mins(t.split(' ')[0]), t.split(' ')[1] || '']))); await sleep(3500);
      const mo = await ev(MOTION);
      let hues = null;
      if (!reduced) {
        await freeze();
        await css('#actors .agent .pix, #actors .mini, #actors .agent .sprite { background-image: none !important }'); await sleep(150); const a = await shot();
        await css('#actors .agent, #actors .rod { visibility: hidden !important }'); await sleep(150); const b = await shot();
        hues = await fn(HUES, a, b);
      }
      console.log(`motion (${LABEL}${reduced ? ', reduced motion' : ''}): looping animations ${mo.loops} on ${mo.elements} elements, ${mo.periods} loop periods, most on one character ${mo.perChar}, one-shot ${mo.oneShot}; by name ${JSON.stringify(mo.names)}`
        + (hues ? `\n  colour outside the base characters: ${hues.hues} saturated hue bins of 30 deg (>= 30 px), saturated red px ${hues.red}` : ''));
    }
    await send('Emulation.setEmulatedMedia', { features: [] });
  }

  if (!SKIP.includes('shots')) {
    // Same realistic scene for before/after pairs: 17 waiting at 1280 and 800, day and night.
    for (const w of QUICK ? [1280] : [1280, 800]) for (const [sky, clock] of [['day', '12:00'], ['night', '22:00']]) {
      await size(w); await open(`?crowd=17&clock=${clock}`);
      await ev(SET(MIX.map(t => [mins(t.split(' ')[0]), t.split(' ')[1] || '']))); await sleep(2000); await freeze();
      writeFileSync(join(SHOTS, `sal-${LABEL}-${w}-${sky}.png`), Buffer.from(await shot(), 'base64'));
    }
    console.log(`screenshots: ${SHOTS}/sal-${LABEL}-{1280,800}-{day,night}.png`);
  }

  if (!SKIP.includes('idle')) {
    // Idle page from 20 s after load: 35 s with nothing changing (one 30 s re-dress falls inside); layouts, style recalcs and garden DOM mutations per second, then the same with every animation outside the garden stopped (the garden's own cost).
    const met = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map(x => [x.name, x.value]));
    for (const bare of QUICK ? [true] : [false, true]) {
      await size(1280); await open('?crowd=14&clock=22:00', QUICK ? 16000 : 20000);
      if (bare) await css(':not(#garden, #garden *), :not(#garden, #garden *)::before { animation: none !important }');
      await ev(`window.__mut = 0; new MutationObserver(l => { window.__mut += l.length; }).observe(document.getElementById('garden'), { subtree: true, childList: true, attributes: true, characterData: true }); true`);
      const t0 = await met(); await sleep(QUICK ? 12000 : 35000); const t1 = await met(), mut = await ev('window.__mut'), s = t1.Timestamp - t0.Timestamp;
      console.log(`idle (${LABEL}, ?crowd=14 night${bare ? ', outside the garden stopped' : ''}, ${s.toFixed(0)} s): layouts ${((t1.LayoutCount - t0.LayoutCount) / s).toFixed(2)}/s, style recalcs ${((t1.RecalcStyleCount - t0.RecalcStyleCount) / s).toFixed(2)}/s, garden DOM mutations ${mut} (${(mut / s).toFixed(2)}/s)`);
    }
  }
} finally { await stop(chrome); await stop(server); }
