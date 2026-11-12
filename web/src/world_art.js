// @ts-check
// Pixel drawing for the data-driven scenery: ore heap at the mine, sunflowers by the fence, a comet, paper boats on the stream, a cat asleep on the fence, a weather vane on a roof, a nest on the cliff.
import { mix } from './util.js';

/** @typedef {{ px: (x: number, y: number, c: string) => void, rect: (c: string, x: number, y: number, w: number, h: number) => void, tint: (x: number, y: number, c: string, a: number) => void }} Grid */

const BOAT_TRIP = 150; // seconds a paper boat takes from the waterfall pool to the pond
const BLOOM_ORDER = [3, 5, 1, 6, 2, 7, 0, 4]; // fence slots in the order sunflowers come up, spread out

/** Pseudo-random 0..1 from two integers, stable across frames. @param {number} a @param {number} b */
const h2 = (a, b) => { let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) | 0; h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; };

/** Rounded ore heap of step 1..4 with its base row at y = base, centred on cx; pushes a nugget per step into glints. @param {Grid} G @param {number} cx @param {number} base @param {number} step @param {Record<string, any>} K @param {number[][]} glints */
export function oreHeap(G, cx, base, step, K, glints) {
  const h = 2 + step * 2, hw0 = 7, lit = mix(K.stone, K.blockL, .45), rim = mix(K.dark, K.stone, .4);
  for (let k = 0; k < h; k++) {
    const hw = Math.max(1, Math.round(hw0 * Math.sqrt(1 - k / h))), y = base - k;
    for (let i = -hw; i <= hw; i++) G.px(cx + i, y, k === h - 1 || i === hw ? K.dark : i < -hw * .25 ? lit : h2(i, k) < .25 ? rim : K.stone);
  }
  for (let q = 0; q < step * 2; q++) {
    const k = 1 + Math.floor(h2(q, 7) * (h - 2)), hw = Math.round(hw0 * Math.sqrt(1 - k / h)) - 1, x = cx - hw + Math.floor(h2(q, 9) * (hw * 2)), y = base - k;
    G.px(x, y, K.ore[q % 2]); if (q % 2 === 0) { G.px(x + 1, y, K.ore[q % 2]); glints.push([x, y]); }
  }
}
/** Sunflowers in front of the town fence, one per slot up to n; heads turn toward the sun and droop at night. @param {Grid} G @param {number} f0 @param {number} f1 @param {number[]} avoid @param {number} hz @param {number} n @param {Record<string, any>} P @param {number} sunDx @param {number} dark */
export function sunflowers(G, f0, f1, avoid, hz, n, P, sunDx, dark) {
  const head = P.fl[1], eye = P.trunkD, petal = mix(P.fl[1], P.fl[4], .35), droop = dark > .6;
  for (let q = 0; q < Math.min(n, BLOOM_ORDER.length); q++) {
    let x = Math.round(f0 + 4 + (BLOOM_ORDER[q] + .5) * (f1 - f0 - 8) / BLOOM_ORDER.length);
    while (avoid.some(a => Math.abs(x - a) < 6)) x += 6;
    const base = hz + 13, top = hz + 4 - (q % 3), hx = x + (droop ? 1 : sunDx), hy = top + (droop ? 1 : 0);
    for (let y = top + 1; y <= base; y++) G.px(y < top + 3 ? x + Math.round((hx - x) * (top + 3 - y) / 3) : x, y, P.stem);
    G.px(x - 1, base - 3, P.leaf2); G.px(x + 1, base - 5, P.leaf2);
    G.rect(head, hx - 1, hy - 1, 3, 3); G.px(hx, hy, eye);
    G.px(hx - 2, hy, petal); G.px(hx + 2, hy, petal); G.px(hx, hy + 2, petal); if (!droop) G.px(hx, hy - 2, petal);
  }
}
/** Faint comet tinted into the sky layer: bright head at (x, y), tail streaming up and to the left. @param {Grid} G @param {number} x @param {number} y @param {string} col @param {number} a */
export function comet(G, x, y, col, a) {
  const L = 28, ux = -.86, uy = -.5;
  for (let d = 1; d <= L; d++) { const w = d / 9, f = a * .5 * (1 - d / L) ** 1.4;
    for (let o = -Math.ceil(w); o <= Math.ceil(w); o++) { if (Math.abs(o) > w + .3) continue; G.tint(Math.round(x + ux * d - uy * o), Math.round(y + uy * d + ux * o), col, f * (1 - Math.abs(o) / (w + 1))); } }
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (i * i + j * j <= 5) G.tint(x + i, y + j, col, a * .3);
  G.tint(x, y, col, a); G.tint(x + 1, y, col, a * .8); G.tint(x, y + 1, col, a * .6);
}
/** Paper boats drifting down the stream; s is seconds (0 under reduced motion keeps them still), hidden under the bridge. @param {Record<string, any>} b @param {(col: string, a: number, y: number, w?: number, h?: number) => void} R @param {(a: number) => void} alpha @param {number} s @param {number} n */
export function paintBoats(b, R, alpha, s, n) {
  const st = b.stream, m = st.length, P = b.P, br = b.bridge; if (!n || m < 8) return;
  const hull = P.foam, shade = mix(P.foam, P.waterD, .45);
  for (let i = 0; i < n; i++) {
    const ph = ((s / BOAT_TRIP + i / n + .13) % 1 + 1) % 1, f = 2 + ph * (m - 4), q = Math.floor(f), u = f - q;
    const x = Math.round(st[q][0] + (st[q + 1][0] - st[q][0]) * u), y = Math.round(st[q][1] + (st[q + 1][1] - st[q][1]) * u);
    if (br && Math.abs(x - br[0]) < 12 && Math.abs(y - br[1]) < 7) continue;
    alpha(Math.min(1, ph * 12, (1 - ph) * 10));
    R(shade, x - 1, y + 1, 3, 1); R(hull, x - 2, y, 5, 1); R(hull, x - 1, y - 1, 2, 1); R(shade, x + 1, y - 1); R(hull, x, y - 2);
  }
  alpha(1);
}
const CAT = ['.f.f....', 'fffffff.', 'fkffffff', '.fffffts'];  // curled sleeping cat facing left: ears, head, shut eye, tail tip
/** Cat asleep on the fence's top rail at x, its paws on row y; tabby by day, dimmed by dark. @param {Grid} G @param {number} x @param {number} y @param {number} dark */
export function catNap(G, x, y, dark) {
  const fur = mix('#d98a4e', '#4a3a48', dark * .7), shade = mix('#a8622e', '#2e2232', dark * .7), col = /** @type {Record<string, string>} */ ({ f: fur, k: shade, t: shade, s: mix(fur, '#ffffff', .35) });
  CAT.forEach((r, j) => [...r].forEach((c, i) => { if (c !== '.') G.px(x + i, y - CAT.length + j, col[c]); }));
}
/** Paper notes pinned down the mine's right door post from (x, y), one per session out of step, a red pin on each; dimmed by darkness. @param {{ px: (x: number, y: number, c: string) => void, rect: (c: string, x: number, y: number, w: number, h: number) => void }} G @param {number} x @param {number} y @param {number} n @param {number} dark */
export function pinNotes(G, x, y, n, dark) {
  const paper = mix('#f3ead0', '#3a3448', dark * .6), line = mix('#9a8a6a', '#2a2436', dark * .6), pin = mix('#e0483c', '#5a2a3a', dark * .5);
  for (let i = 0; i < n; i++) { const nx = x - (i % 2), ny = y + i * 6; G.rect(paper, nx, ny, 4, 4); G.rect(line, nx + 1, ny + 2, 2, 1); G.px(nx + 1, ny, pin); }
}
/** Iron weather vane standing on a roof ridge at (x, y), its arrow posed by world_time.vanePose (head into the wind, shortened when it points toward or away from the viewer); dimmed by dark. @param {Grid} G @param {number} x @param {number} y @param {{ x: number, z: number }} pose @param {number} dark */
export function weatherVane(G, x, y, pose, dark) {
  const iron = mix('#4a4250', '#1a1622', dark * .8), gold = mix('#d9a83a', '#5a4a3a', dark * .7), ay = y - 4;
  G.rect(iron, x, y - 6, 1, 6); G.px(x, y - 7, gold);
  if (!pose.x) { if (pose.z > 0) { G.rect(gold, x - 1, ay, 3, 1); G.px(x, ay - 1, gold); G.px(x, ay + 1, gold); } else { G.rect(iron, x - 1, ay - 1, 1, 3); G.rect(iron, x + 1, ay - 1, 1, 3); } return; }
  const n = pose.z ? 2 : 3, d = pose.x;
  G.rect(iron, x - n, ay, n * 2 + 1, 1);
  G.px(x + d * n, ay, gold); G.px(x + d * (n - 1), ay - 1, gold); G.px(x + d * (n - 1), ay + 1, gold);
  G.rect(iron, x - d * n, ay - (pose.z < 0 ? 1 : 2), 1, pose.z < 0 ? 2 : 3); if (!pose.z) G.px(x - d * (n - 1), ay - 1, iron);
}
/** Twig nest sitting on row y around x with n eggs (at most five fit) framed by its rims, dimmed by dark. @param {Grid} G @param {number} x @param {number} y @param {number} n @param {number} dark */
export function nest(G, x, y, n, dark) {
  const twig = mix('#a8743f', '#3a2c34', dark * .7), twigD = mix('#5a3a22', '#1a1420', dark * .7), egg = mix('#fbf6e6', '#7a82a6', dark * .6), eggS = mix('#bcd8e6', '#4a5478', dark * .6);
  G.rect(twigD, x - 4, y - 4, 9, 1); G.rect(twigD, x - 5, y - 3, 11, 2);
  for (let i = 0; i < Math.min(5, n); i++) { const ex = x - 4 + i * 2; G.px(ex, y - 3, egg); G.px(ex, y - 2, eggS); }
  G.rect(twig, x - 5, y - 1, 11, 1); G.rect(twigD, x - 4, y, 9, 1); G.px(x - 6, y - 2, twig); G.px(x + 6, y - 2, twig); G.px(x - 2, y - 1, twigD); G.px(x + 3, y - 1, twigD);
}
