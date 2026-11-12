// Renders every sprite sheet the app uses into raw pixel buffers through the stub canvas, keyed by sheet name.
import { createHash } from 'node:crypto';
import { images, install, StubCanvas } from '../../tools/canvas_stub.mjs';

install();
export const ORES = ['#ffd447', '#6fe0ff'];

/** Paints [x, y, colour] pixels or letter grids into a w x h buffer. @param {number} w @param {number} h @param {Array<[number, number, string]>} px */
export function bufferOf(w, h, px) {
  const c = new StubCanvas(w, h), x = c.getContext();
  for (const [a, b, col] of px) { x.fillStyle = col; x.fillRect(a, b, 1, 1); }
  return { w, h, data: c.data };
}

/** Pixels of a letter grid painted with a palette. @param {string[]} rows @param {Record<string, string>} pal */
export const gridPixels = (rows, pal) => rows.flatMap((r, y) => [...r].flatMap((ch, x) => ch === '.' ? [] : [/** @type {[number, number, string]} */ ([x, y, pal[ch]])]));

/** Every sheet as {w, h, data}; rod holds the float, reel and bang grids. @param {any} S sprites module @param {any} rod */
export function renderAll(S, rod) {
  /** @type {Map<string, {w: number, h: number, data: Uint8ClampedArray}>} */
  const out = new Map(), img = (/** @type {string} */ u) => { const i = images.get(u); if (!i) throw new Error('not a stub image: ' + u); return i; };
  for (const h of S.HN) for (let c = 0; c < S.BODIES.length; c++) {
    out.set(`list:${h}:${c}`, img(S.sheet(h, '', c)));
    out.set(`sleep:${h}:${c}`, img(S.sheet(h, 'sleep', c)));
    out.set(`glad:${h}:${c}`, img(S.sheet(h, 'glad', c)));
    out.set(`pose:${h}:${c}`, img(S.poseSheet(h, c)));
    out.set(`mine:${h}:${c}`, img(S.minerSheet(h, c)));
    for (const r of ['sit', 'nap']) out.set(`${r}:${h}:${c}`, img(S.poseSheet(h, c, r)));
    out.set(`stale:${h}:${c}`, img(S.poseSheet(h, c, 'nap', '', true)));
    for (const t of ['hammer', 'pan']) out.set(`mine-${t}:${h}:${c}`, img(S.minerSheet(h, c, t)));
  }
  for (const p of S.PROPS) for (let c = 0; c < S.BODIES.length; c++) out.set(`mini-${p}:${c}`, img(S.miniSheet(p, c)));
  out.set('props:stump', img(S.propSheet(['stump']))); out.set('props:blanket', img(S.propSheet(['blanket'])));
  for (let c = 0; c < S.BODIES.length; c++) { out.set(`props:umbrella:${c}`, img(S.propSheet(['umbrella'], c))); out.set(`props:flag:${c}`, img(S.propSheet(['flag-a'], c))); }
  for (let c = 0; c < S.BODIES.length; c++) { out.set(`mini:${c}`, img(S.sheet('none', 'glad', c))); out.set(`bare:${c}`, img(S.sheet('none', '', c))); }
  for (const o of ORES) out.set(`rock:${o}`, img(S.rockSheet(o)));
  for (let n = 0; n < 4; n++) for (let f = 0; f < 2; f++) out.set(`fish:${n}:${f}`, bufferOf(9, 6, S.fishSprite(n, f)));
  for (const k of ['float', 'reel', 'bang']) out.set(`rod:${k}`, bufferOf(rod[k][0].length, rod[k].length, gridPixels(rod[k], S.COL)));
  return out;
}

/** Short stable hash of one buffer, size included. @param {{w: number, h: number, data: Uint8ClampedArray}} b */
export const hashOf = b => createHash('sha256').update(`${b.w}x${b.h}:`).update(b.data).digest('hex').slice(0, 16);
/** Short hash of a JSON value. @param {any} v */
export const hashJson = v => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
