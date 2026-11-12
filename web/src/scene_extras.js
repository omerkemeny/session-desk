// @ts-check
// Rare touches tied to the real date and weather: rainbow after rain, autumn leaves from the big tree, migrating flocks.
import { mix } from './util.js';
import { ilDay, ilInstant, leafFall, migration } from './world_time.js';

const BOW = ['#ff5a4a', '#ff9a3a', '#ffe45a', '#6fd06a', '#4a9aff', '#9a6aff']; // rainbow bands, outside in
const AUTUMN = ['#e0892e', '#d9b03a', '#b8562a', '#c9762a']; // falling leaf colours
const LEAF_RATE = 1 / 7; // leaves per second at the peak of autumn
const FLOCK_RATE = 1 / 420; // migrating flocks per second in season

/** Preview overrides and weather memory: date replaces today, rainAt is when the latest rain ended (epoch ms, 0 none). @type {{ date: Date | null, rainAt: number }} */
export const sky = { date: null, rainAt: 0 };

/** Instant shown by the scene: today in Israel (or sky.date's day) at scene minute t. @param {number} t */
export const sceneInstant = t => ilInstant(ilDay(sky.date ?? new Date()).iso, t);
/** Season facts for the scene's day: leaf fall 0..1 and flock direction. @param {Date} d */
export function season(d) { const { m, d: day } = ilDay(d); return { leaves: leafFall(m, day), flock: migration(m, day) }; }

/** Faint rainbow arc tinted into a pixel layer around (cx, cy), radius r, strength a; rows at or below yMax are left alone. @param {{ tint: (x: number, y: number, c: string, a: number) => void }} G @param {number} cx @param {number} cy @param {number} r @param {number} a @param {number} yMax */
export function drawRainbow(G, cx, cy, r, a, yMax) {
  for (let y = Math.max(0, Math.floor(cy - r - 1)); y < yMax; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
    const band = Math.floor(r - Math.hypot(x - cx, (y - cy) * 1.1)); if (band < 0 || band >= BOW.length) continue;
    G.tint(x, y, BOW[band], a * (band === 0 || band === BOW.length - 1 ? .6 : 1) * Math.min(1, (yMax - y) / 10));
  }
}
/** A few fallen leaves at the foot of the big tree, amount 0..1, dimmed by darkness. @param {{ px: (x: number, y: number, c: string) => void }} G @param {number} x0 @param {number} x1 @param {number} y0 @param {number} y1 @param {number} amt @param {number} dark @param {string} night @param {() => number} r */
export function fallenLeaves(G, x0, x1, y0, y1, amt, dark, night, r) {
  for (let i = 0; i < Math.round(16 * amt); i++) { const x = x0 + r() * (x1 - x0), y = y0 + r() * (y1 - y0), c = mix(AUTUMN[i % 4], night, dark * .6); G.px(x, y, c); if (i % 3 === 0) G.px(x + 1, y, c); }
}

/** New leaf and flock events for this tick; roll(rate) is the caller's capped random trial. @param {Record<string, any>} b @param {(rate: number) => boolean} roll @param {number} s */
export function spawnExtras(b, roll, s) {
  const ev = b.ev, rnd = Math.random, tr = b.tree;
  if (tr && b.season.leaves > 0 && !b.snow && roll(LEAF_RATE * b.season.leaves)) {
    const x0 = tr.x0 + rnd() * (tr.x1 - tr.x0), y0 = x0 < tr.xc ? tr.yLow - rnd() * 10 : tr.yHigh + rnd() * 3, y1 = tr.g0 + rnd() * (tr.g1 - tr.g0), v = 4 + rnd() * 2.5;
    if (y1 > y0 + 4) ev.push({ k:'leaf', x0, y0, y1, t0:s, dur:(y1 - y0) / v, ph:rnd() * 6, drift:(b.storm ? 14 : 3) * (rnd() + .3), col:AUTUMN[Math.floor(rnd() * 4)] });
  }
  if (b.season.flock && b.L > .35 && !b.wet && !b.snow && !b.fog && !ev.some((/** @type {any} */ e) => e.k === 'flock') && roll(FLOCK_RATE)) {
    const dir = b.season.flock, v = 7 + rnd() * 2, n = 7 + 2 * Math.floor(rnd() * 3);
    ev.push({ k:'flock', dir, v, n, x: dir > 0 ? -20 : b.W + 20, y: Math.round(b.hz * (.12 + rnd() * .2)), t0:s, dur:(b.W + 40 + n * 4) / v });
  }
}
/** Paint flocks (sky pass, before the land layer) or leaves (land pass). @param {Record<string, any>} b @param {(col: string, a: number, y: number, w?: number, h?: number) => void} R @param {(a: number) => void} alpha @param {number} s @param {boolean} land */
export function paintExtras(b, R, alpha, s, land) {
  for (const e of b.ev) {
    if (!land && e.k === 'flock') {
      const head = e.x + e.dir * (s - e.t0) * e.v;
      for (let i = 0; i < e.n; i++) {
        const g = Math.ceil(i / 2), bx = Math.round(head - e.dir * g * 6), by = e.y + (i % 2 ? -g : g) * 3 + Math.round(Math.sin(s * .9 + i) * .6), up = Math.floor(s * 2.6 + i * .9) % 2;
        R(b.A.bird, bx - 2, by - up); R(b.A.bird, bx - 1, by); R(b.A.bird, bx, by); R(b.A.bird, bx + 1, by); R(b.A.bird, bx + 2, by - up);
      }
    } else if (land && e.k === 'leaf') {
      const p = (s - e.t0) / e.dur, lx = Math.round(e.x0 + e.drift * p * 4 + Math.sin(s * 1.7 + e.ph) * 3), ly = Math.round(e.y0 + (e.y1 - e.y0) * p);
      alpha((p > .85 ? (1 - p) / .15 : 1) * (1 - b.dark * .45)); if (Math.floor(s * 3 + e.ph) % 2) R(e.col, lx, ly, 2, 1); else R(e.col, lx, ly, 1, 2);
    }
  }
  alpha(1);
}
