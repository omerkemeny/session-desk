// @ts-check
// Fishing at the pond: a bamboo rod per angler with a three-frame idle strip, and a catch played on its canvas now and then, on the backdrop's frames.
import { $, hash } from './util.js';
import { COL, fishSprite, ROD } from './sprites.js';
import { FISH, SLOTS } from './logic.js';
import { moving } from './pace.js';
import { onFrame } from './backdrop.js';

/** @typedef {import('./types.js').Actor} Actor */

// Stepped pixel path along a quadratic curve, with doubled corners removed.
/** @param {number[]} a @param {number[]} c @param {number[]} b */
function bez(a, c, b) {
  const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 3) + 2, o = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t, q = [Math.round(u * u * a[0] + 2 * u * t * c[0] + t * t * b[0]), Math.round(u * u * a[1] + 2 * u * t * c[1] + t * t * b[1])], m = o.length;
    if (m && o[m - 1][0] === q[0] && o[m - 1][1] === q[1]) continue;
    if (m > 1 && Math.abs(o[m - 2][0] - q[0]) === 1 && Math.abs(o[m - 2][1] - q[1]) === 1) o.pop();
    o.push(q);
  }
  return o;
}
// Draws one moment through put(x, y, colour) in half-pixels, facing right, origin at the angler's sprite corner.
/** @param {(x: number, y: number, col: string) => void} put @param {any} G @param {any} s */
function rodScene(put, G, s) {
  const { S, F, L } = G, ph = s.phi * Math.PI / 180, si = Math.sin(ph), co = Math.cos(ph), T = [Math.round(S[0] + L * co), Math.round(S[1] - L * si)];
  const C = [(S[0] + T[0]) / 2 - s.bow * L * si, (S[1] + T[1]) / 2 - s.bow * L * co], fp = s.fp || F;
  for (const r of s.rings || []) { const h = Math.max(1, Math.round(r / 3)), seen = new Set(); for (let a = 0; a < 6.3; a += .05) { const x = Math.round(F[0] + r * Math.cos(a)), y = Math.round(F[1] + h * Math.sin(a)); if (!seen.has(x + ',' + y)) { seen.add(x + ',' + y); put(x, y, ROD.ring); } } }
  if (s.line) { const e = s.line, sag = s.sag ?? 1 + Math.abs(e[0] - T[0]) * .18; for (const [x, y] of bez(T, [(T[0] + e[0]) / 2, (T[1] + e[1]) / 2 + sag], e)) put(x, y, ROD.line); }
  if (s.float != null) ROD.float.forEach((r, y) => { const yy = fp[1] - 5 + y + s.float; if (!s.fp && yy >= F[1]) return; [...r].forEach((ch, x) => ch !== '.' && put(fp[0] - 2 + x, yy, COL[ch])); });
  const B = [S[0] + (S[0] - C[0]) * .3, S[1] + (S[1] - C[1]) * .3], grip = bez(B, [(B[0] + S[0]) / 2, (B[1] + S[1]) / 2], S), pole = bez(S, C, T);
  /** @param {number[]} p @param {number[]} q */
  const side = (p, q) => Math.abs(q[1] - p[1]) > Math.abs(q[0] - p[0]) ? [1, 0] : [0, 1];
  grip.forEach(([x, y], i) => { const [a, b] = side(grip[Math.max(0, i - 1)], grip[Math.min(grip.length - 1, i + 1)]); put(x, y, ROD.grip[i % 2]); put(x + a, y + b, ROD.grip[0]); });
  pole.forEach(([x, y], i) => {
    const n = pole.length, node = i % 6 === 5 && i < n - 4, [a, b] = side(pole[Math.max(0, i - 1)], pole[Math.min(n - 1, i + 1)]);
    if (i >= n - 2) return put(x, y, ROD.tip);
    put(x, y, node ? ROD.node : ROD.pole[0]); if (i < n * .7) put(x + a, y + b, node ? ROD.node : ROD.pole[1]); if (i < n * .3) put(x + 2 * a, y + 2 * b, ROD.node);
  });
  const R = grip[Math.floor(grip.length / 2)];
  ROD.reel.forEach((r, y) => [...r].forEach((ch, x) => ch !== '.' && put(R[0] + x, R[1] - 2 + y, COL[ch])));
  if (s.fish) { const { n, fr, x, y, o } = s.fish; for (const [c, r, col] of fishSprite(n, fr)) put(o === 'v' ? x + r - 2 : o === 'l' ? x + 4 - c : x - 4 + c, o === 'v' ? y + 8 - c : y - 2 + r, col); }
  for (const [x, y] of s.drops || []) put(x, y, ROD.drop);
  if (s.splash != null) for (const [x, y] of [[[-4, -1], [4, -1], [-2, -3], [3, -4], [0, -5]], [[-5, -2], [5, -2], [-3, -5], [2, -6], [-1, -3], [1, -2]]][s.splash]) put(F[0] + x, F[1] + y, ROD.drop);
  if (s.bang != null) ROD.bang.forEach((r, y) => [...r].forEach((ch, x) => put(14 + x, G.bang + s.bang + y, COL[ch])));
}
// The catch at t ms: nibble, bite with splash and "!", lift, dangle, swing to the angler's feet, recast with a plop.
/** @param {any} G @param {number} t @param {number} n @param {Array<[number, string, number, number]>} drops @returns {any} */
function catchAt(G, t, n, drops) {
  /** @param {number} u */
  const { F, S, L, phi } = G, k = Math.floor(t / 70) % 2, cl = u => Math.min(1, Math.max(0, u)), mix = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ u) => a + (b - a) * cl(u);
  /** @param {number} p */
  const lift = Math.min(Math.max(phi + 30, 80), 88), tipAt = p => [Math.round(S[0] + L * Math.cos(p * Math.PI / 180)), Math.round(S[1] - L * Math.sin(p * Math.PI / 180))];
  /** @type {(a: number[], c: number[], b: number[], u: number) => number[]} */
  const bz = (a, c, b, u) => { const v = 1 - cl(u); u = cl(u); return [0, 1].map(i => Math.round(v * v * a[i] + 2 * v * u * c[i] + u * u * b[i])); };
  const D = tipAt(lift), Dm = [D[0], D[1] + 9], land = G.land;
  /** @type {any} */
  const s = { phi, bow: .12, rings: [], drops: drops.map(d => { const dt = (t - d[0]) / 100, o = d[1] === 'D' ? [Dm[0], Dm[1] + 9] : F, y = o[1] + d[3] * dt + 1.2 * dt * dt; return dt >= 0 && (d[1] === 'D' ? dt < 5 : y <= o[1]) ? [Math.round(o[0] + d[2] * dt), Math.round(y)] : null; }).filter(Boolean) };
  if (t < 200) return Object.assign(s, { phi: phi - 5, bow: .17, float: 2, line: [F[0], F[1] - 4], rings: [3, 6] });
  if (t < 850) return Object.assign(s, { phi: phi - 18 + k * 5, bow: .3 - k * .05, line: [F[0], F[1] - 1], sag: 0, rings: [k ? 5 : 3, k ? 8 : 7], splash: k, bang: t < 280 ? -2 : 0 });
  if (t < 1300) { const u = (t - 850) / 450, p = bz(F, [(F[0] + Dm[0]) / 2, Math.min(F[1], Dm[1]) - 10], Dm, u); return Object.assign(s, { phi: mix(phi - 18, lift, u * 1.4), bow: mix(.3, .2, u), line: [p[0] - 4, p[1]], sag: 0, rings: [Math.round(4 + u * 6)], fish: { n, fr: k, x: p[0], y: p[1], o: 'l' }, bang: t < 1000 ? 0 : null }); }
  if (t < 1850) { const sw = Math.floor(t / 140) % 2; return Object.assign(s, { phi: lift + sw * 2, bow: .2, line: [Dm[0] + sw, Dm[1]], sag: 0, fish: { n, fr: k, x: Dm[0] + sw, y: Dm[1], o: 'v' } }); }
  if (t < 2250) { const p = bz(Dm, land[0] < 0 ? [(Dm[0] + land[0]) / 2, Dm[1] - 16] : [Dm[0] + 12, land[1] - 6], land, (t - 1850) / 400); return Object.assign(s, { phi: mix(lift, lift - 30, (t - 1850) / 400), bow: .16, line: [p[0] - 4, p[1]], sag: 0, fish: { n, fr: k, x: p[0], y: p[1], o: 'l' } }); }
  const p = t < 2400 ? mix(lift - 30, lift, (t - 2250) / 150) : t < 2650 ? mix(lift, phi - 10, (t - 2400) / 140) : mix(phi - 10, phi, (t - 2650) / 300), T = tipAt(p);
  Object.assign(s, { phi: p, bow: .1 });
  if (t < 2950) { const hop = t >= 2350 && t < 2450 || t >= 2650 && t < 2750; s.fish = { n, fr: hop ? 1 : 0, x: land[0], y: land[1] - (hop ? 2 : 0), o: t >= 2650 && t < 2750 ? 'r' : 'l' }; }
  else if (t < 3050) s.drops.push([land[0] - 4, land[1] - 2], [land[0] + 4, land[1] - 3], [land[0], land[1] - 5]);
  if (t < 2450) return Object.assign(s, { line: [T[0], T[1] + 5], sag: 0 });
  if (t < 2650) { const q = bz(T, [(T[0] + F[0]) / 2, Math.min(T[1], F[1]) - 8], F, (t - 2450) / 200); return Object.assign(s, { line: [q[0], q[1] - 6], sag: 0, float: 0, fp: q }); }
  const dy = t < 2720 ? 3 : t < 2790 ? 1 : 0, r = Math.floor((t - 2650) / 90);
  return Object.assign(s, { float: dy, line: [F[0], F[1] - 6 + dy], rings: r < 6 ? [3 + r] : [4], splash: t < 2720 ? 0 : null });
}
// Lays the rod out from the angler's hand toward its float, sizes the box and paints the three idle frames.
/** @param {any} rod */
function paintRod(rod) {
  const g = $('garden'), px = +getComputedStyle(g).getPropertyValue('--px') || 4, f = px / 2, d = rod._d, gw = g.clientWidth, gh = g.clientHeight;
  const ox = d.x * gw - 8 * px, oy = d.y * gh - 15 * px, fx = Math.round((d.bx * gw - ox) / f), F = [d.dir > 0 ? fx : 31 - fx, Math.round((d.by * gh - oy) / f)], S = [31, 20];
  const low = F[1] > S[1] + 12, tx = F[0] < S[0] + 7 ? Math.max(S[0] - 3, F[0]) : low ? F[0] : Math.min(Math.max(S[0] + 13, F[0] - 6 - (F[0] - S[0]) * .1), F[0] - 2);
  const ty = low ? Math.min(S[1] - 18, S[1] - Math.sqrt(Math.max(0, 676 - (tx - S[0]) ** 2))) : Math.min(F[1], S[1]) - 18;
  const L = Math.min(38, Math.max(26, Math.hypot(tx - S[0], ty - S[1]))), phi = Math.atan2(S[1] - ty, tx - S[0]) * 180 / Math.PI;
  const lf = [(ox + (d.dir > 0 ? 16 : 15) * f) / gw, (oy + 37 * f) / gh], wet = ((lf[0] - .66) / .1) ** 2 + ((lf[1] - .715) / .14) ** 2 < 1;
  const lx0 = -12, lx1 = Math.ceil(Math.max(F[0], S[0] + L)) + 12, bang = -Math.ceil((rod._el.querySelector('.bubble').offsetHeight + 6) / f) - 10, ly0 = Math.min(S[1] - L - 6, bang) - 2, ly1 = Math.max(42, F[1] + 6), w = lx1 - lx0, h = ly1 - ly0, X0 = d.dir > 0 ? lx0 : 32 - lx1;
  /** @param {CanvasRenderingContext2D} x @param {number} o */
  const G = rod._g = { F, S, L, phi, w, h, bang, land: wet ? [-6, 29] : [16, 37], put: (x, o) => (/** @type {number} */ a, /** @type {number} */ b, /** @type {string} */ col) => { x.fillStyle = col; x.fillRect((d.dir > 0 ? a : 31 - a) - X0 + o, b - ly0, 1, 1); } };
  Object.assign(rod.style, { left: ox + X0 * f + 'px', top: oy + ly0 * f + 'px', width: w * f + 'px', height: h * f + 'px' });
  const c = rod.querySelector('canvas'), sh = document.createElement('canvas'), x = /** @type {CanvasRenderingContext2D} */ (sh.getContext('2d')); c.width = w; c.height = h; sh.width = 3 * w; sh.height = h;
  [[0, .12, 0, [4]], [-2, .14, 1, [5]], [-5, .17, 2, [3, 6]]].forEach(([dp, bow, fl, rings], i) => rodScene(G.put(x, i * w), G, { phi: phi + /** @type {number} */ (dp), bow, float: fl, line: [F[0], F[1] - 6 + /** @type {number} */ (fl)], rings }));
  rod.querySelector('b').style.backgroundImage = `url(${sh.toDataURL()})`;
}
// Runs one catch on the backdrop's own frames (no frame loop of its own), stepped at 70 ms, then schedules the next; a timer ends it if those frames stop.
/** @param {any} rod */
export function reel(rod) {
  if (!rod.isConnected) return;
  rod._t = setTimeout(() => reel(rod), 9000 + Math.random() * 26000);
  if (!moving() || rod._run) return;
  /** @param {number} a @param {number} b */
  const n = Math.floor(Math.random() * 4), c = rod.querySelector('canvas'), x = c.getContext('2d'), t0 = performance.now(), el = rod._el, rnd = (a, b) => a + Math.random() * (b - a);
  const drops = /** @type {Array<[number, string, number, number]>} */ ([...Array(6)].map(() => [870, 'F', rnd(-2.5, 2.5), rnd(-4.5, -2.5)]).concat([1350, 1560, 1770].map(t => [t, 'D', 0, 0]), [...Array(4)].map(() => [2650, 'F', rnd(-1.6, 1.6), rnd(-3, -2)])));
  let last = -1; rod._run = 1; rod.classList.add('reeling');
  const end = () => { off(); clearTimeout(stop); rod._run = 0; rod.classList.remove('reeling'); el.classList.remove('caught'); x.clearRect(0, 0, c.width, c.height); };
  /** @param {number} now */
  const step = now => {
    const t = now - t0, q = Math.floor(t / 70);
    if (!rod.isConnected || t > 3400) return end();
    if (q !== last) { last = q; el.classList.toggle('caught', t > 1300 && t < 2900); x.clearRect(0, 0, c.width, c.height); rodScene(rod._g.put(x, 0), rod._g, catchAt(rod._g, q * 70, n, drops)); }
  };
  const off = onFrame(step), stop = setTimeout(end, 3600);
  step(t0);
}
// Fishing rod, line and float for a waiting agent standing at the pond, held in the hand on the water side.
/** @param {Map<string, Actor>} actors garden characters by session id @param {string} id */
export function addRod(actors, id) {
  const a = actors.get(id); if (!a || a.rod || !FISH[a.slot]) return;
  const [x, y] = SLOTS[a.slot], [bx, by] = FISH[a.slot], h = hash(id);
  /** @type {any} */
  const rod = document.createElement('div'); rod.className = 'rod'; rod.setAttribute('aria-hidden', 'true');
  rod._d = { x, y, bx, by, dir: bx < x ? -1 : 1 }; rod._el = a.el;
  rod.style.zIndex = Math.round(y * 100) - 1; rod.style.setProperty('--rt', 6.5 + h % 20 / 10 + 's'); rod.style.setProperty('--rd', -(h % 80) / 10 + 's');
  rod.innerHTML = '<b></b><canvas></canvas>';
  $('actors').append(rod); a.rod = rod; a.el.classList.add('fisher'); paintRod(rod);
  rod._t = setTimeout(() => reel(rod), 4000 + Math.random() * 20000);
}
/** Repaint every rod when the garden changes size. */
export function initRods() {
  new ResizeObserver(() => document.querySelectorAll('.rod').forEach(paintRod)).observe(document.getElementById('garden'));
}
