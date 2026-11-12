// @ts-check
// Garden backdrop: Israel clock and Tel Aviv weather; static scenery into two offscreen layers, moving things painted on top about 10 times a second.
import { $, mix, rng } from './util.js';
import { isSnow, isWet, phase, wxName } from './logic.js';
import { REAL, state } from './state.js';
import { later, moving, onPace, pace } from './pace.js';
import { drawRainbow, fallenLeaves, paintExtras, sceneInstant, season, sky, spawnExtras } from './scene_extras.js';
import { FAST_MS, vanePose, fireflyTime, ilDay, moonFull, moonLit, moonPhase, moonPx, puddleLeft, rainEnded, rainbow, repaintMs, skyStars, smokeCount, smokeDrift, sunTimes, windLean } from './world_time.js';
import { cometOn, parseWorld, world, worldNow } from './world_data.js';
import { catNap, comet, nest, oreHeap, paintBoats, pinNotes, sunflowers, weatherVane } from './world_art.js';

/** @typedef {import('./types.js').Weather} Weather */

const GROUND = {
  day: { hedge:'#2f7d4f', fence:'#d9b27c', fenceD:'#9a7143', grass:'#74c15c', grass2:'#66b354', grass3:'#86cf68', path:'#d8b77c', pathD:'#b38e5a', water:'#3f9fe0', waterL:'#a9e2fb', lily:'#3f9a4a',
    trunk:'#8a5a34', leaf:'#3c9a4c', leaf2:'#64c05a', stem:'#3f9a4a', fl:['#ff6b8b','#ffd447','#ffffff','#c58bff','#ff9a4a'],
    snow:'#ffffff', ice:'#cfe6f5', drop:'#cfe9ff', fish:'#ff8a3d', fishT:'#ffc07a', body:'#3b2a20', fly:'#f4ff8a', glow:'#c8ff5a',
    hill:'#4f9a6a', sand:'#e2cf98', reed:'#4f8a3a', cattail:'#7a4a2a', waterD:'#2f7fc4',
    leafD:'#1e5651', leafL:'#a8de4e', leafH:'#e8f57e', trunkD:'#4a2c2e', trunkL:'#c08a56', moss:'#7fae42', pine:'#2e6d5e', pineL:'#4d9472',
    mtnL:'#f1dcbc', mtn:'#b89c8c', mtnD:'#7e7299', mtnDD:'#5e5a86', snowS:'#c4d4f2', snowD:'#99aedf',
    fall:'#5db4ee', fallL:'#e4f7ff', foam:'#ffffff', boulder:'#9a96a8', boulderL:'#c9c6cf', boulderD:'#5f5d78', fg:'#1b4a42', plank:'#a8743f', plankD:'#6e4628',
    walls:['#f4e4c4','#ecd3b2','#dce8ee'], roofs:['#d0573f','#8e5ad6','#3f8cf0'], beam:'#7a4e30' },
  night: { hedge:'#0f3236', fence:'#6e5a52', fenceD:'#3a2e36', grass:'#1b5446', grass2:'#164840', grass3:'#226050', path:'#4f5470', pathD:'#3a3d5c', water:'#1b3f96', waterL:'#7aa4ec', lily:'#164a3c',
    trunk:'#3e2c34', leaf:'#164a46', leaf2:'#1f5e50', stem:'#1a4f40', fl:['#9a4a78','#a8963a','#aeb6d6','#7a5ab8','#a8683a'],
    snow:'#c9d3ee', ice:'#5f7fb6', drop:'#7fa6dc', fish:'#9a5a30', fishT:'#b5804f', body:'#1c140f', fly:'#f4ff8a', glow:'#c8ff5a',
    hill:'#163e48', sand:'#5a5a72', reed:'#1c4a3c', cattail:'#3e2a2c', waterD:'#122c78',
    leafD:'#0a2232', leafL:'#2f7056', leafH:'#4f8a62', trunkD:'#160f1c', trunkL:'#5a4048', moss:'#2a5040', pine:'#10303e', pineL:'#1a4450',
    mtnL:'#4c58a2', mtn:'#323c84', mtnD:'#222b6a', mtnDD:'#1a2158', snowS:'#7484c8', snowD:'#5262a8',
    fall:'#2c5cb0', fallL:'#9cc0f2', foam:'#c9d8f6', boulder:'#3e4266', boulderL:'#5e6490', boulderD:'#21244a', fg:'#06122a', plank:'#4a3a44', plankD:'#2a2030',
    walls:['#6a6488','#62597e','#5a6890'], roofs:['#6a2e40','#46306e','#22407a'], beam:'#2e2230' } };
const ROCK = { day: { stone:'#a88660', dark:'#7a5c44', floor:'#bfb39c', speck:'#b6a990', cave:'#2a2230', ore:['#ffd447','#6fe0ff'], lamp:'#ffd98a', post:'#6b4a2e', glint:'#ffffff', ember:'#ff9a4a',
    wood:'#9a6a3c', rail:'#9aa0a8', cart:'#7a5a3a', cartL:'#a98455', block:'#b98758', blockL:'#e2b47c', blockD:'#86593e', mortar:'#5a3a32', cap:'#7ccd48', capL:'#c8f06c', capD:'#3e8a40', floorL:'#ccc1ab' },
  night: { stone:'#4a4060', dark:'#33304e', floor:'#3e3e60', speck:'#3a3a5a', cave:'#0c0a18', ore:['#b8983a','#4a9fb8'], lamp:'#ffd447', post:'#2e2232', glint:'#e8ecff', ember:'#ff9a4a',
    wood:'#4a3640', rail:'#5a6080', cart:'#3a2c38', cartL:'#56424e', block:'#4e4466', blockL:'#6a5e86', blockD:'#352e50', mortar:'#1c1830', cap:'#1f5248', capL:'#2f6e58', capD:'#143a3a', floorL:'#585676' } };
const SKY = { night:['#0a1238','#13206a','#24358a'], dawn:['#6a78c2','#f0a6a0','#ffd9a8'], day:['#4fa2ea','#8ccbf5','#d2effc'], dusk:['#4b3f8f','#d9728a','#ffb36b'] };
// Sky life and light: clouds, sun, moon, stars, birds, smoke, washes; day and night ends of every blend.
const AIR = {
  day: { grey:'#9aa3ad', cloud:'#eef5fb', cloudL:'#ffffff', cloudD:'#c8daee', cloudS:'#9eb6dc', rainc:'#c3cad2', rainD:'#a9b2bc', rainS:'#848e9e', bird:'#34414e', smoke:'#eceff1', fog:'#dfe6ea', win:'#8fc4e8',
    sun:'#ffe27a', sunLow:'#ffb347', sunCore:'#fffbe0', moon:'#f4f1d0', moonD:'#c8c49c', star:'#e8ecff', wet:'#1c2a44', dawn:'#ffb38a', dusk:'#ff7a3c', shade:'#0d1340', light:'#fff6dc', warm:'#ffe0a0' },
  night: { grey:'#262c48', cloud:'#2e3a7a', cloudL:'#4a5aa0', cloudD:'#24306a', cloudS:'#1a2456', rainc:'#2e3666', rainD:'#252c56', rainS:'#1c2246', bird:'#1a2030', smoke:'#4a5478', fog:'#4a5276', win:'#ffcf5a',
    sun:'#ffe27a', sunLow:'#ffb347', sunCore:'#fffbe0', moon:'#fbf6d8', moonD:'#d6d0a6', star:'#e8ecff', wet:'#0c1430', dawn:'#ffb38a', dusk:'#ff7a3c', shade:'#060a2a', light:'#a9b8f0', warm:'#ffb848' } };
// Current Tel Aviv weather; sunrise and sunset in minutes after midnight, Israel time, from the sun's real path for the scene's day.
/** @type {Weather} */
export const wx = { code:0, cloud:15, temp:null, ...sunTimes(ilDay(new Date()).iso), ok:false };
/** Wind at 10 m from the weather request: speed in km/h and the direction it comes from in degrees; null until known. @type {{ speed: number | null, dir: number | null }} */
export const wind = { speed: null, dir: null };
/** Demo pin for sunrise and sunset from ?sun=HH:MM-HH:MM, null to follow the sun. @type {{ sr: number, ss: number } | null} */
let sunPin = null;
// Sunrise and sunset for the scene's day into wx, unless pinned.
const followSun = () => Object.assign(wx, sunPin || sunTimes(ilDay(sky.date ?? new Date()).iso));
// Clock in Israel, whatever the viewer's own time zone is.
function ilNow() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Jerusalem', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date());
  const h = +(/** @type {Intl.DateTimeFormatPart} */ (p.find(x => x.type === 'hour'))).value % 24, m = +(/** @type {Intl.DateTimeFormatPart} */ (p.find(x => x.type === 'minute'))).value;
  return { t: state.st.clock ?? h * 60 + m, label: String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') };
}
// Demo address overrides for the data-driven scenery and the time since rain.
if (!REAL && typeof location !== 'undefined') { const o = parseWorld(location.search); Object.assign(world, { tokens: o.tokens, prs: o.prs, runs: o.runs, week: o.week, lantern: o.lantern, cat: o.cat, vane: o.vane, streak: o.streak, notes: o.notes == null ? null : Math.min(3, Math.floor(o.notes)) }); if (o.rainAgo != null) sky.rainAt = Date.now() - o.rainAgo * 60000;
  const p = /[?&]sun=(\d\d):(\d\d)-(\d\d):(\d\d)/.exec(location.search); if (p) sunPin = { sr: +p[1] * 60 + +p[2], ss: +p[3] * 60 + +p[4] };
  const dd = /[?&]date=(\d{4}-\d\d-\d\d)/.exec(location.search); if (dd) sky.date = new Date(dd[1] + 'T12:00:00Z');
  const v = /[?&]wind=(\d+),(\d+)/.exec(location.search); if (v) Object.assign(wind, { speed: +v[1], dir: +v[2] }); }
/** @type {Record<string, string>} */
const tiles = {};
// Repeating 24px tile of rain streaks (leaning with the wind, -2..2) or snow flakes.
/** @param {boolean} snow @param {number} [lean] */
function tile(snow, lean = 0) {
  const k = snow ? 's' : 'r' + (lean || ''); if (tiles[k]) return tiles[k];
  const c = document.createElement('canvas'); c.width = c.height = 24; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')), r = rng(snow ? 3 : 4);
  x.fillStyle = snow ? '#ffffff' : '#cfe9ff';
  for (let i = 0; i < 12; i++) { const a = Math.floor(r() * 24), b = Math.floor(r() * 21); if (snow || !lean) x.fillRect(a, b, 1, snow ? 1 : 3); else for (let j = 0; j < 3; j++) x.fillRect((a + Math.sign(lean) * Math.round(j * Math.abs(lean) / 2) + 24) % 24, b + j, 1, 1); }
  return tiles[k] = c.toDataURL();
}
// Chunky pixel rect and filled ellipse on a given 2D context.
/** @param {CanvasRenderingContext2D} x @param {string} col @param {number} a @param {number} b */
const bgRect = (x, col, a, b, w = 1, h = 1) => { x.fillStyle = col; x.fillRect(Math.round(a), Math.round(b), Math.max(1, Math.round(w)), Math.max(1, Math.round(h))); };
/** @param {CanvasRenderingContext2D} x @param {string} col @param {number} cx @param {number} cy @param {number} rx @param {number} ry */
const bgOval = (x, col, cx, cy, rx, ry) => { for (let j = -ry; j <= ry; j++) { const w = Math.round(rx * Math.sqrt(1 - j * j / (ry * ry + .01))); bgRect(x, col, cx - w, cy + j, w * 2 + 1, 1); } };
// Blend two palettes (objects or arrays of hex colours) key by key.
/** @type {(a: any, b: any, k: number) => any} */
const bgBlend = (a, b, k) => Array.isArray(a) ? a.map((v, i) => bgBlend(v, b[i], k)) : typeof a === 'object' ? Object.fromEntries(Object.keys(a).map(n => [n, bgBlend(a[n], b[n], k)])) : mix(a, b, k);
// Daylight 0..1 eased across the 90-minute dawn and dusk windows, plus raw twilight progress k.
/** @param {number} t */
function bgLight(t) {
  const k = Math.max(0, Math.min(1, (t - wx.sr + 40) / 90, (wx.ss + 40 - t) / 90));
  return { L: k * k * (3 - 2 * k), k, eve: t > (wx.sr + wx.ss) / 2 };
}
// Deterministic hash noise in 0..1 and its smooth value-noise version.
/** @param {number} x @param {number} y @param {number} s */
const bgHash = (x, y, s) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 982451653) | 0; h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; };
/** @param {number} x @param {number} y @param {number} s */
const bgNoise = (x, y, s) => { const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, a = bgHash(i, j, s), b = bgHash(i + 1, j, s), c = bgHash(i, j + 1, s), d = bgHash(i + 1, j + 1, s), p = u * u * (3 - 2 * u), q = v * v * (3 - 2 * v); return a + (b - a) * p + (c - a) * q + (a - b - c + d) * p * q; };
// Indexed pixel layer: paint per pixel, then flush to a context as horizontal runs.
/** @param {number} W @param {number} H */
function bgGrid(W, H) {
  /** @type {string[]} */
  const cols = [];
  const g = new Int16Array(W * H).fill(-1), ix = new Map();
  /** @param {string} c */
  const id = c => { let i = ix.get(c); if (i === undefined) { ix.set(c, i = cols.length); cols.push(c); } return i; };
  return { W, H,
    /** @param {number} x @param {number} y @param {string} c */
    px(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < W && y < H) g[y * W + x] = id(c); },
    /** @param {number} x @param {number} y */
    at(x, y) { x = Math.round(x); y = Math.round(y); const i = x >= 0 && y >= 0 && x < W && y < H ? g[y * W + x] : -1; return i < 0 ? null : cols[i]; },
    /** @param {string} c @param {number} x @param {number} y @param {number} w @param {number} h */
    rect(c, x, y, w, h) { x = Math.round(x); y = Math.round(y); const k = id(c), x1 = Math.min(W, x + Math.round(w)), y1 = Math.min(H, y + Math.round(h)); for (let j = Math.max(0, y); j < y1; j++) for (let i = Math.max(0, x); i < x1; i++) g[j * W + i] = k; },
    /** @param {number} x @param {number} y @param {string} c @param {number} a */
    tint(x, y, c, a) { const o = this.at(x, y); if (o) this.px(x, y, mix(o, c, a)); },
    /** @param {CanvasRenderingContext2D} x */
    flush(x) { let last = -2; for (let j = 0; j < H; j++) for (let i = 0; i < W;) { const k = g[j * W + i]; let e = i + 1; while (e < W && g[j * W + e] === k) e++; if (k >= 0) { if (k !== last) { x.fillStyle = cols[k]; last = k; } x.fillRect(i, j, e - i, 1); } i = e; } } };
}
/** @typedef {ReturnType<typeof bgGrid>} Grid */
// Shaded clump from stacked offset discs, darkest rim to lit upper-left core; leafy edges break into 2px clusters.
/** @param {Grid} G @param {string[]} ramp @param {number} cx @param {number} cy @param {number} r @param {number} sd @param {{ lean?: number, base?: number, leafy?: number, foot?: number, lift?: number }} [o] */
function bgBlob(G, ramp, cx, cy, r, sd, o = {}) {
  const n = ramp.length, R0 = Math.ceil(r * 1.25) + 1, lean = o.lean ?? 1, base = o.base ?? 1e9;
  for (let j = -R0; j <= R0; j++) {
    const y = Math.round(cy + j); if (y > base) continue;
    for (let i = -R0; i <= R0; i++) {
      const x = Math.round(cx + i), a = Math.atan2(j, i);
      let w = 1 + .12 * Math.sin(a * 5 + sd) + .06 * Math.sin(a * 9 + sd * 2.3);
      if (o.leafy) w += (bgHash(x >> 1, y >> 1, sd) - .5) * o.leafy;
      if (i * i + j * j > r * r * w * w) continue;
      let lv = 0;
      for (let q = 1; q < n; q++) {
        const f = q / n, dx = i + r * .4 * f * lean, dy = j + r * .55 * f, aa = Math.atan2(dy, dx), ww = w * (1 + .1 * Math.sin(aa * 4 + sd * 1.7 + q)) + (o.leafy ? (bgHash(x >> 1, y >> 1, sd + q) - .5) * o.leafy * .8 : 0);
        if (dx * dx + dy * dy <= (r * ww * (1 - f * .74)) ** 2) lv = q; else break;
      }
      if (base - y < (o.foot ?? 0)) lv = Math.min(lv, 1);
      G.px(x, y, ramp[Math.max(0, Math.min(n - 1, lv + (o.lift ?? 0)))]);
    }
  }
}
const FULL_LIFT = .07;  // how far a full moon lifts the night land toward daylight
const WEEK_SHAPE = [[0, 6], [7, 1], [13, 0], [19, 2], [20, 9], [29, 10], [30, 2]];  // a dipper of seven, handle end (oldest day) to the pointer (today), canvas px
/** Backdrop state: built layers, scenery positions, ambient events and the loop's bookkeeping. @type {Record<string, any>} */
export const bgs = { key:'', ev:[], raf:0, last:0, min:-1, W:0, H:0 };
// Static scenery into two offscreen layers (sky behind, land in front); runs on resize, minute or weather change only.
/** @param {number} W @param {number} H @param {number} t */
function bgBuild(W, H, t) {
  const b = bgs, { L, k, eve } = bgLight(t), dark = 1 - L, hz = Math.round(H * .26), when = sceneInstant(t);
  b.season = season(when);
  let P = bgBlend(GROUND.night, GROUND.day, L), K = bgBlend(ROCK.night, ROCK.day, L); const A = bgBlend(AIR.night, AIR.day, L);
  const wet = isWet(wx.code), snow = isSnow(wx.code), fog = wx.code === 45 || wx.code === 48, storm = wx.code >= 95;
  const grey = wet || snow ? .65 : wx.cloud > 80 ? .45 : wx.cloud > 50 ? .2 : 0, tw = SKY[eve ? 'dusk' : 'dawn'];
  const stops = [0, 1, 2].map(i => mix(L < .5 ? mix(SKY.night[i], tw[i], L * 2) : mix(tw[i], SKY.day[i], L * 2 - 1), A.grey, grey));
  /** @param {string} c @param {number} f */
  const dk = (c, f) => mix(c, A.shade, f), lt = (c, f) => mix(c, A.light, f), haze = (c, f) => mix(c, stops[2], f);
  /** @type {(o: any) => any} */
  const dull = o => Array.isArray(o) ? o.map(dull) : typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([n, v]) => [n, dull(v)])) : mix(o, A.grey, grey * .25);
  if (grey) { P = dull(P); K = dull(K); }
  /** @param {string} c */
  const glowK = Math.sin(Math.PI * k) * .45, glowC = eve ? A.dusk : A.dawn, warmUp = c => mix(c, glowC, glowK);
  /** @type {(c: any, w?: number, h?: number) => HTMLCanvasElement} */
  const fresh = (c, w = W, h = H) => { c = c || document.createElement('canvas'); c.width = w; c.height = h; return c; };
  b.skyC = fresh(b.skyC); b.landC = fresh(b.landC);
  /** @param {number} x @param {number} y @param {number} s */
  const S = bgGrid(W, H), hs = (x, y, s) => bgHash(x, y, s);
  // sky gradient with one checker row between bands
  const NB = 12, bands = Array.from({ length: NB }, (_, i) => { const f = i / (NB - 1); return f < .5 ? mix(stops[0], stops[1], f * 2) : mix(stops[1], stops[2], f * 2 - 1); });
  for (let y = 0; y < hz + 2; y++) {
    const f = Math.min(NB - 1, y / hz * (NB - 1)), i = Math.floor(f); S.rect(bands[i], 0, y, W, 1);
    if (i < NB - 1 && f - i > .78) for (let x = y & 1; x < W; x += 2) S.px(x, y, bands[i + 1]);
  }
  /** @param {number} f */
  const arc = f => f < 0 ? f * 8 : f > 1 ? (1 - f) * 8 : Math.sin(Math.PI * f), day = wx.ss - wx.sr;
  let fm = t - wx.ss; if (fm < -day / 2) fm += 1440; fm /= 1440 - day;
  const fs = (t - wx.sr) / day;
  b.sun = b.moon = null;
  if (grey < .6 && fm > -.3 && fm < 1.3 && dark > .05) {
    const mx = Math.round(W * (.24 + .52 * fm)), my = Math.round(hz * (.82 - .66 * arc(fm))), a = Math.min(1, dark * 1.4), mc = mix(stops[0], A.moon, a), md = mix(stops[0], A.moonD, a);
    const mp = moonPhase(when), lit = moonLit(mp), me = mix(stops[0], A.moonD, a * .14);
    for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++) { const d = i * i + j * j; if (d > 70) continue; const c = !moonPx(i, j, 8.4, mp) ? me : (i + 4) ** 2 + (j - 3) ** 2 < 14 || (i - 3) ** 2 + (j + 3) ** 2 < 5 || (i - 2) ** 2 + (j - 4) ** 2 < 3 ? md : d > 50 && i + j > 2 ? md : mc; S.px(mx + i, my + j, c); }
    b.moon = { x: mx, y: my, a, k: .15 + .85 * lit };
  }
  // full moon nights: the land a little lighter and the moon's halo a little wider
  b.full = b.moon ? moonFull(moonPhase(when)) : 0;
  if (b.full > 0) { P = bgBlend(GROUND.night, GROUND.day, L + dark * b.full * FULL_LIFT); K = bgBlend(ROCK.night, ROCK.day, L + dark * b.full * FULL_LIFT); if (grey) { P = dull(P); K = dull(K); } }
  if (grey < .6 && fs > -.3 && fs < 1.3) {
    const sx = Math.round(W * (.24 + .52 * fs)), sy = Math.round(hz * (.82 - .66 * arc(fs))), col = mix(A.sunLow, A.sun, Math.max(0, Math.min(1, arc(fs) * 2.5)));
    for (let j = -10; j <= 10; j++) for (let i = -10; i <= 10; i++) { const d = i * i + j * j; if (d <= 100) S.px(sx + i, sy + j, d > 81 ? mix(col, stops[1], .45) : d > 56 ? col : (i + 3) ** 2 + (j + 3) ** 2 < 14 ? A.sunCore : mix(col, A.sunCore, .45)); }
    b.sun = { x: sx, y: sy, col };
  }
  // faint rainbow opposite the sun for a while after rain
  const bow = rainbow((Date.now() - sky.rainAt) / 60000, L, wet || snow, wx.cloud);
  if (bow > 0 && sky.rainAt) drawRainbow(S, Math.max(W * .22, Math.min(W * .6, b.sun ? W - b.sun.x : W * .4)), hz * 1.2, hz * 1.02, .5 * bow, hz);
  // comet after a big pull-request day, drifting west through the night ahead of the moon's path
  const sa0 = Math.max(0, Math.min(1, dark * 1.6 - .5)), nightF = Math.max(0, Math.min(1, ((t - wx.ss + 1440) % 1440) / Math.max(1, 1440 - (wx.ss - wx.sr))));
  if (b.world && cometOn(b.world.prs, sa0, wx.cloud < 70 && !wet && !snow && !fog)) comet(S, Math.round(W * (.52 + .24 * nightF)), Math.round(hz * (.14 + .4 * (nightF - .5) ** 2)), A.star, sa0);
  // towering cumulus bank on the horizon, flat-shaded in four tones
  const pink = Math.sin(Math.PI * k) * .35, gc = wet || snow, cramp = (gc ? [A.rainS, A.rainD, A.rainc, lt(A.rainc, .3)] : [A.cloudS, A.cloudD, A.cloud, A.cloudL]).map((c, i) => mix(mix(c, stops[1], pink * (i < 2 ? .7 : .4)), stops[2], fog ? .5 : 0));
  const bank = new Uint8Array(W * hz), rb = rng(9), bs = .55 + Math.min(100, wx.cloud) / 220 + (gc ? .2 : 0), baseY = hz - 10;
  const G0 = bgGrid(W, hz);
  for (let tx = W * (.08 + rb() * .1); tx < W * .74; tx += 70 + rb() * 60) {
    const th = (18 + rb() * 15) * bs, tw2 = (26 + rb() * 18) * (gc ? 1.6 : 1);
    const puffs = [];
    for (let q = 0; q < 7; q++) { const u = q / 6, r = (tw2 * .32) * (1 - u * .45) * (.8 + rb() * .4); puffs.push([tx + (rb() - .5) * tw2 * (1 - u * .6), baseY - th * u, r]); }
    for (let q = 0; q < 4; q++) puffs.push([tx + (q - 1.5) * tw2 * .5, baseY - 2 - rb() * 4, 6 + rb() * 5]);
    puffs.sort((p, q) => p[1] - q[1]);
    puffs.forEach(([px, py, r], q) => bgBlob(G0, cramp, px, py, r, q * 7 + tx, { base: baseY, foot: 3 }));
  }
  for (let y = 0; y < hz; y++) for (let x = 0; x < W; x++) { const c = G0.at(x, y); if (c) { S.px(x, y, c); bank[y * W + x] = 1; } }
  S.flush(b.skyC.getContext('2d'));
  // drifting clouds become small pre-shaded sprites
  const r2 = rng(5), n = Math.max(wet || snow ? 6 : 0, Math.round(wx.cloud / 100 * 8));
  b.cc = cramp[2]; b.clouds = [];
  b.cloudC = b.cloudC || [];
  for (let i = 0; i < n; i++) {
    const far = r2() < .35, w = Math.round((far ? 22 : 34) + r2() * (far ? 14 : 26)), h = Math.round(w * .42), C = bgGrid(w, h), ramp = far ? cramp.slice(1).map(c => mix(c, stops[1], .35)) : cramp;
    const m = 2 + Math.floor(w / 14);
    for (let q = 0; q < m; q++) { const u = (q + .5) / m, r = h * (.42 + .4 * Math.sin(Math.PI * u)) * (.8 + r2() * .3); bgBlob(C, ramp, w * u, h - 2 - r * .55, r, i * 13 + q, { base: h - 2, foot: 2 }); }
    const cv = b.cloudC[i] = fresh(b.cloudC[i], w, h); C.flush(/** @type {CanvasRenderingContext2D} */ (cv.getContext('2d')));
    b.clouds.push({ cv, w, y: Math.round(hz * (.08 + r2() * .42)), x0: r2() * 1000, v: ((far ? .16 : .36) + r2() * .4 + (storm ? 1 : 0)), far });
  }
  b.clouds.sort((/** @type {any} */ p, /** @type {any} */ q) => q.far - p.far);
  const r4 = rng(7), mn = b.moon; b.stars = []; b.starA = Math.max(0, Math.min(1, dark * 1.6 - .5));
  if (b.starA > 0) for (let i = 0; i < W / 4 * (1 - wx.cloud / 100); i++) { const x = Math.floor(r4() * W), y = Math.floor(r4() * hz * .8), p = r4() * 7, v = .6 + r4() * 1.4, big = r4() < .12; if (!bank[y * W + x]) b.stars.push({ x, y, p, v, big }); }
  if (b.starA > 0 && wx.cloud < 90) for (const [x, y, mag] of skyStars(when, W, hz)) if (!bank[y * W + x]) b.stars.push({ x, y, p: x * .37, v: .35, big: mag < 1.3 });
  if (mn) b.stars = b.stars.filter((/** @type {any} */ p) => (p.x - mn.x) ** 2 + (p.y - mn.y) ** 2 > 110);
  // the week's pull requests as a small steady constellation, oldest day first; shown once any day has one
  const wk = b.world?.week || [], wkx = Math.round(W * (mn && mn.x < W * .5 ? .6 : .3)), wky = Math.round(hz * .16);
  b.week = b.starA > 0 && wk.some(Boolean) ? WEEK_SHAPE.map(([dx, dy], i) => [wkx + dx, wky + dy, wk[i]]).filter(([x, y]) => !bank[y * W + x] && (!mn || (x - mn.x) ** 2 + (y - mn.y) ** 2 > 200)) : [];
  if (b.week.length) b.stars = b.stars.filter((/** @type {any} */ p) => !b.week.some((/** @type {number[]} */ [x, y]) => Math.abs(p.x - x) < 4 && Math.abs(p.y - y) < 4));

  // ---- land layer
  const G = bgGrid(W, H);
  // far snowy range, then a warmer mid range, both faceted and lit from the left
  /** @param {number} seed @param {number} step @param {number} hMin @param {number} hMax @param {number} base @param {number} hz2 @param {number} snowF */
  const range = (seed, step, hMin, hMax, base, hz2, snowF) => {
    const r = rng(seed), pk = [];
    for (let x = -r() * step; x < W + step; x += step * (.7 + r() * .6)) pk.push({ x, h: hMin + r() * (hMax - hMin), sl: .5 + r() * .3, sr: .55 + r() * .35, s: r() * 100 });
    const ramp = [P.mtnDD, P.mtnD, P.mtn, P.mtnL].map((c, i) => haze(i === 3 ? warmUp(c) : c, hz2)), sramp = [P.snowD, P.snowS, P.snow].map((c, i) => haze(i === 2 ? warmUp(c) : c, hz2 * .8));
    for (let x = 0; x < W; x++) {
      /** @type {any} */
      let top = 1e9, p = null;
      for (const q of pk) { const y = base - q.h + Math.abs(x - q.x) * (x < q.x ? q.sl : q.sr); if (y < top) { top = y; p = q; } }
      top = Math.round(top + (hs(x >> 1, 0, seed) < .3 ? 1 : 0));
      const py = base - p.h, sl = py + p.h * (snow ? .75 : snowF) + Math.sin(x * .45 + p.s) * 2.5 + hs(x >> 1, 1, seed) * 3;
      for (let y = Math.max(0, top); y <= base + 2; y++) {
        const rx = p.x + (y - py) * .28 + Math.sin(y * .3 + p.s) * 1.5, lit = x < rx, dist = rx - x;
        const gully = lit && ((x * .55 + y + p.s * 3) % 13 < 1.6) && y > py + 4;
        let c;
        if (y < sl && p.h > hMin + 4) c = lit ? (dist < 2 ? sramp[1] : sramp[2]) : (dist > -3 ? sramp[0] : sramp[1]);
        else c = lit ? (gully ? ramp[1] : dist < 3 ? ramp[3] : (y - top > 18 ? ramp[1] : ramp[2])) : (dist > -2 ? ramp[0] : ramp[1]);
        if (y === top && lit) c = y < sl ? sramp[2] : lt(ramp[3], .25);
        G.px(x, y, c);
      }
    }
  };
  range(21, 92, 30, 46, hz - 2, .32 + grey * .25, .4);
  range(33, 66, 16, 30, hz + 2, .12 + grey * .25, .22);
  // misty pine forest at the foot of the mountains
  const rpn = rng(43), pr = [dk(P.pine, .2), P.pine, P.pineL].map(c => haze(c, .3 + grey * .15));
  for (let x = -6; x < W + 6; x += 4 + rpn() * 5) {
    const h = 6 + rpn() * 8, by = hz, px0 = Math.round(x);
    for (let j = 0; j < h; j++) { const hw = Math.floor(j * .42 + (j % 4 === 3 ? 1 : 0)); for (let i = -hw; i <= hw; i++) G.px(px0 + i, by - h + j, i < -hw * .2 ? pr[2] : i > hw * .45 ? pr[0] : pr[1]); }
    if (snow) for (let j = 0; j < h * .6; j += 3) G.px(px0 - Math.floor(j * .42), by - h + j, P.snow);
  }
  // round bushy treeline right on the horizon
  const rtl = rng(47), tr = [P.leafD, P.hedge, P.leaf, P.leaf2].map(c => haze(c, .12 + grey * .1));
  for (let x = -4; x < W * .8; x += 6 + rtl() * 8) { const big = rtl() < .22, r = big ? 7 + rtl() * 3 : 3.5 + rtl() * 2.5; bgBlob(G, tr, x, hz - 1 - r * (big ? 1 : .6), r, x, { base: hz + 1, leafy: .25 }); }
  // meadow: depth bands, broad soft patches and sparse tufts, kept calm and mid-value
  /** @param {string} c */
  const gb = [.24, .14, .06, 0, -1].map(f => f < 0 ? mix(P.grass, P.grass2, .45) : haze(P.grass, f)), cut = [0, .1, .24, .45, .84, 1].map(f => Math.round(hz + (H - hz) * f)), sn = (c, f = .7) => snow ? mix(c, P.snow, f) : c;
  gb.forEach((c, i) => gb[i] = sn(c));
  for (let y = hz; y < H; y++) {
    let bi = 0; while (bi < 4 && y >= cut[bi + 1]) bi++;
    const base = gb[bi], pd = snow ? mix(base, P.grass2, .3) : mix(base, P.grass2, .75), pl = snow ? lt(base, .3) : mix(base, P.grass3, .6);
    for (let x = 0; x < W; x++) {
      const v = bgNoise(x / 34, y / 11, 3) * .7 + bgNoise(x / 9, y / 4, 4) * .3;
      let c = base;
      if (y === cut[bi] && bi && (x & 1)) c = gb[bi - 1];
      if (v > .62 || (v > .59 && ((x + y) & 1))) c = pd; else if (v < .3 || (v < .33 && ((x + y) & 1))) c = pl;
      G.px(x, y, c);
    }
  }
  G.rect(sn(dk(haze(P.grass, .2), .18), .5), 0, hz, W, 1);
  const rg = rng(19), tuftD = sn(mix(P.grass, P.grass2, .9), .45), tuftL = sn(lt(P.grass3, .12), .5);
  for (let i = 0; i < W * H / 260; i++) {
    const y = Math.round(hz + 4 + rg() * (H - hz - 5)), x = Math.round(rg() * W), tall = (y - hz) / (H - hz) > .45;
    G.px(x, y, tuftD); G.px(x - 1, y, tuftD); G.px(x - 1, y - 1, tuftL); if (tall) { G.px(x + 1, y - 1, tuftL); G.px(x + 1, y - 2, tuftL); }
  }
  // worn dirt paths with grass creeping into the edges
  const d0 = Math.round(W * .11 + Math.max(30, W * .065)) + 4;
  /** @param {number} y */
  const pathAt = y => { const u = Math.max(0, (y - hz) / (H - hz)); return [d0 + u ** 1.6 * W * .16 + Math.sin(u * 4) * W * .02, 6 + u * 16]; };
  /** @param {number} px @param {number} py @param {number} m */
  const onPath = (px, py, m) => { const [c, w] = pathAt(py); return Math.abs(px - c) < w / 2 + m; };
  const pc = sn(mix(P.path, P.grass, .18), .45), pcD = sn(mix(P.pathD, P.grass, .2), .45), pcL = lt(pc, .18), edge = mix(pc, gb[3], .5);
  /** @param {number} x @param {number} y @param {number} w */
  const dirt = (x, y, w) => { for (let i = Math.round(x - w / 2) - 1; i <= Math.round(x + w / 2) + 1; i++) {
    const e = Math.min(i - (x - w / 2), x + w / 2 - i), n1 = bgHash(i >> 1, y >> 1, 77);
    if (e < -1) continue; if (e < 0) { if (n1 < .5) G.px(i, y, edge); continue; } if (e < 1.5 && n1 < .35) { G.px(i, y, edge); continue; }
    G.px(i, y, e < 1.5 ? pcD : n1 > .9 ? pcL : n1 < .08 ? pcD : pc); } };
  for (let y = hz + 4; y < H; y++) { const [c, w] = pathAt(y); dirt(c, y, w); }
  const bx0 = Math.round(W * .785), brY = hz + 22;
  /** @param {number} x */
  const lane = x => hz + 9 + Math.sin(x / 40) * 2 + (x - d0) / (bx0 - d0) * (brY - hz - 12);
  for (let x = d0 - 2; x < bx0 - 8; x++) { const y0 = Math.round(lane(x)); for (let j = -1; j <= 3; j++) { const n1 = bgHash(x >> 1, (y0 + j) >> 1, 78); G.px(x, y0 + j, /** @type {string} */ (j < 0 || j > 2 ? (n1 < .4 ? edge : null) || G.at(x, y0 + j) : j === 2 ? (n1 < .3 ? edge : pcD) : n1 > .92 ? pcL : n1 < .15 ? edge : pc)); } }
  /** @param {number} px @param {number} py */
  const lnp = (px, py) => px > d0 && px < bx0 && Math.abs(py - lane(px) - 1) < 4;
  // fence along the town edge, gate where the path leaves
  const f0 = Math.round(W * .09), f1 = Math.round(W * .32), [gcx] = pathAt(hz + 6), fenL = lt(P.fence, .3);
  for (let i = f0; i <= f1; i++) {
    if (Math.abs(i - gcx) < 6) continue;
    if ((i - f0) % 7 === 0) { G.px(i, hz + 3, snow ? P.snow : fenL); G.rect(P.fence, i, hz + 4, 1, 7); G.px(i + 1, hz + 5, P.fenceD); G.rect(P.fenceD, i, hz + 11, 1, 1); }
    else { G.px(i, hz + 6, P.fence); G.px(i, hz + 9, P.fence); G.px(i, hz + 7, P.fenceD); G.px(i, hz + 10, P.fenceD); }
  }
  // cottages: timber walls, shingled roofs with a lit ridge, chimneys, warm windows
  b.chims = []; b.lights = [];
  [[12, 9], [10, 11], [13, 8]].forEach(([w0, h0], i) => {
    const w = w0 * 2, h = h0 * 2, hx = Math.round(W * .11 + i * Math.max(30, W * .065)), top = hz + 4 - h;
    const wl = P.walls[i], wd = dk(wl, .25), rf = P.roofs[i], rd = dk(rf, .4), rl = lt(rf, .28), bm = P.beam;
    G.rect(sn(dk(P.grass, .25), .5), hx - 2, hz + 4, w + 4, 2);
    G.rect(wl, hx, top, w, h); G.rect(wd, hx + w - 4, top, 4, h); G.rect(dk(wl, .4), hx, top, w, 2);
    G.rect(dk(wl, .18), hx, hz + 1, w, 3); for (let q = hx + (i & 1) * 2; q < hx + w; q += 4) G.px(q, hz + 2, dk(wl, .32));
    if (i !== 2) { G.rect(bm, hx, top + 2, 1, h - 5); G.rect(bm, hx + w - 1, top + 2, 1, h - 5); G.rect(bm, hx, top + Math.round(h / 2), w, 1); }
    for (let j = 0; j < 10; j++) {
      const y = top - 1 - j, x0 = hx - 3 + j, ww = w + 6 - j * 2; if (ww < 2) break;
      G.rect(j === 0 ? rd : (j % 2 ? mix(rf, rd, .25) : rf), x0, y, ww, 1);
      if (j && j % 2 === 0) for (let q = x0 + ((j >> 1) & 1) * 2; q < x0 + ww; q += 4) G.px(q, y, mix(rf, rd, .45));
      G.px(x0, y, rl); G.px(x0 + 1, y, rl); G.px(x0 + ww - 1, y, rd);
      if (snow && j > 1) G.rect(P.snow, x0 + 1, y, Math.max(1, ww - 4), 1);
    }
    const rj = Math.min(9, Math.floor((w + 6) / 2) - 1); G.rect(lt(rf, .5), hx - 3 + rj, top - 1 - rj, w + 6 - rj * 2, 1);
    const ch = dk(P.beam, .1), chx = hx + w - 8;
    G.rect(ch, chx, top - 12, 4, 10); G.rect(dk(ch, .35), chx + 3, top - 12, 1, 10); G.rect(lt(ch, .3), chx - 1, top - 13, 6, 2); G.px(chx, top - 10, lt(ch, .2));
    if (snow) G.rect(P.snow, chx - 1, top - 14, 6, 1);
    b.chims.push([chx + 1, top - 15]);
    if (i === 0) { b.vaneBox = b.world?.vane !== false ? [hx + 5, top - rj - 8, 9, 7] : null; if (b.vaneBox) weatherVane(G, hx + 9, top - 1 - rj, vanePose(wind.dir), dark); }
    const dx = hx + 3, dr = dk(P.beam, .15);
    G.rect(dk(wl, .35), dx - 1, hz - 7, 8, 1); G.rect(dr, dx, hz - 6, 6, 10); G.px(dx, hz - 6, wl); G.px(dx + 5, hz - 6, wl); G.rect(dk(dr, .35), dx + 4, hz - 5, 1, 9); G.rect(lt(dr, .2), dx + 1, hz - 5, 1, 9); G.px(dx + 4, hz - 1, A.warm);
    const wx0 = hx + w - 12, wy = top + 4, lit = dark > .3;
    G.rect(dk(wl, .45), wx0 - 1, wy - 1, 8, 8); G.rect(A.win, wx0, wy, 6, 6); G.rect(mix(A.win, dk(wl, .45), .5), wx0 + 3, wy, 1, 6); G.rect(mix(A.win, dk(wl, .45), .5), wx0, wy + 3, 6, 1);
    if (!lit) G.rect(lt(A.win, .5), wx0, wy, 2, 1);
    G.rect(dk(P.beam, .05), wx0 - 2, wy + 7, 10, 2); [0, 2, 4, 6].forEach((q, n2) => G.px(wx0 - 1 + q, wy + 6, P.fl[(n2 + i) % 5]));
    if (lit) { b.lights.push([wx0 + 3, hz + 8, 12, 4, .5], [dx + 3, hz + 6, 8, 3, .4]); for (let j = -3; j < 10; j++) for (let q = -3; q < 10; q++) if ((q < 0 || q > 5 || j < 0 || j > 5) && j + 3 + q + 3 < 17) G.tint(wx0 + q, wy + j, A.warm, .22 * dark * (1 - (Math.abs(q - 2.5) + Math.abs(j - 2.5)) / 9)); }
  });
  const lpx = Math.round(W * .11 + 2 * Math.max(30, W * .065)) + 34;
  if (lpx < W * .4) { G.rect(dk(P.beam, .2), lpx, hz - 6, 1, 14); G.rect(dk(P.beam, .3), lpx - 1, hz - 7, 3, 1); G.rect(A.warm, lpx - 1, hz - 6, 3, 3); G.px(lpx, hz - 5, lt(A.warm, .5)); b.lights.push([lpx, hz + 8, 10, 4, .5]); b.lamps = [[lpx, hz - 5]]; } else b.lamps = [];
  // sunflowers along the fence, one per pull request opened today
  // a cat asleep on the fence's top rail while the garden is idle, at the fence's right end clear of the gate
  const catX = Math.abs(f1 - 9 - gcx) < 10 ? f0 + 3 : f1 - 9;
  if (b.world?.blooms) sunflowers(G, f0, f1, b.world?.cat ? [gcx, lpx, catX + 4] : [gcx, lpx], hz, b.world.blooms, P, b.sun ? Math.sign(b.sun.x - W * .2) : 0, dark);
  if (b.world?.cat) catNap(G, catX, hz + 6, dark);
  b.catBox = b.world?.cat ? [catX, hz + 2, 8, 4] : null;
  // stepped cliff of chunky stone blocks with grass caps, drips and vines; the mine sits at its foot
  const cx0 = Math.round(W * .785), fl0 = hz + 14, steps = [[cx0, hz - 24], [Math.round(W * .815), hz - 33], [Math.round(W * .862), 11], [Math.round(W * .94), -4]];
  /** @param {number} x */
  const topAt = x => { let tp = 1e9, si = 0; steps.forEach(([sx, sy], q) => { if (x >= sx) { tp = sy; si = q; } }); return tp + (bgHash(x >> 2, si, 3) < .3 ? 1 : 0); };
  /** @type {number[][]} */
  const rowOf = [], breaks = [];
  const rr = rng(23);
  for (let y = -12, r = 0; y < fl0 + 2; r++) { const h = 6 + Math.floor(rr() * 4); for (let q = 0; q < h; q++) rowOf[y + q + 12] = [r, y, h]; y += h;
    const bk = []; for (let x = cx0 - 6 - rr() * 12; x < W + 22; x += 8 + rr() * 13) bk.push(Math.round(x)); breaks.push(bk); }
  const bl = [K.mortar, K.blockD, K.block, K.blockL], capC = snow ? [mix(P.snowS, K.capD, .2), P.snowS, P.snow, P.snow] : [K.capD, K.cap, K.cap, K.capL];
  for (let x = cx0; x < W; x++) {
    const tp = topAt(x);
    for (let y = tp; y < fl0; y++) {
      const [r, ry0, bh] = rowOf[y + 12], by = y - ry0, bk = breaks[r]; let bi = 0; while (bi < bk.length - 1 && bk[bi + 1] <= x) bi++;
      const bxl = bk[bi], bw = (bk[bi + 1] ?? W + 30) - bxl, bxp = x - bxl, v = hs(bxl, r, 5);
      let c = v < .33 ? mix(bl[2], bl[1], .3) : v > .78 ? mix(bl[2], bl[3], .22) : bl[2];
      if (by === bh - 1 || bxp === bw - 1 || (bxp === 0 && by === 0)) c = bl[0];
      else if (by === 0) c = bl[3]; else if (bxp === 0) c = mix(c, bl[3], .5);
      else if (by === bh - 2 || bxp === bw - 2) c = bl[1];
      else if (v > .86 && by === Math.round((bxp - 2) * .6) + 1 && bxp < bw - 3) c = bl[1];
      const under = y - tp; if (under < 4) c = mix(c, bl[0], .5 - under * .12);
      if (y > fl0 - 7) c = mix(c, bl[0], (y - fl0 + 7) * .06);
      if (x <= cx0 + 1) c = x === cx0 ? bl[1] : mix(c, bl[3], .35);
      G.px(x, y, c);
    }
  }
  for (let q = 1; q < steps.length; q++) { const [sx, sy] = steps[q], low = steps[q - 1][1]; for (let y = sy; y < low; y++) { G.px(sx, y, mix(bl[2], bl[3], .6)); G.px(sx - 1, y, bl[0]); } }
  for (let x = cx0 - 1; x < W; x++) {
    const tp = topAt(x), dr = hs(x, 3, 11), drop = dr < .22 ? 2 + Math.floor(dr * 18) : dr < .6 ? 1 : 0;
    G.px(x, tp - 1, capC[3]); G.px(x, tp, capC[2]); G.px(x, tp + 1, capC[1]); for (let j = 0; j < drop; j++) G.px(x, tp + 2 + j, j === drop - 1 ? capC[0] : capC[1]);
    if (hs(x >> 1, 4, 12) < .35) G.px(x, tp - 2, capC[3]);
  }
  if (!snow) for (let q = 0; q < 7; q++) { const vx2 = Math.round(cx0 + 12 + rr() * (W - cx0 - 16)), tp = topAt(vx2), len = 6 + Math.floor(rr() * 10);
    if (Math.abs(vx2 - W * .93) < 16) continue;
    for (let j = 0; j < len && tp + 2 + j < fl0 - 4; j++) { G.px(vx2, tp + 2 + j, j % 3 === 2 ? K.capL : K.capD); if (j % 3 === 1) G.px(vx2 + (j % 6 < 3 ? 1 : -1), tp + 2 + j, K.cap); } }
  for (let q = 0; q < 6; q++) { const bx = cx0 + 10 + rr() * (W - cx0 - 14), tp = topAt(bx); if (tp < hz - 20 && !snow) bgBlob(G, [K.capD, K.cap, K.capL], bx, tp - 2, 3 + rr() * 2.5, q, { base: tp + 1, leafy: .3 }); }
  // a nest on the cliff's second ledge, one egg per day in a row with a session
  const nx = Math.round(W * .838); b.nestBox = b.world?.eggs ? [nx - 6, topAt(nx) - 5, 13, 5] : null; if (b.nestBox) nest(G, nx, topAt(nx) - 1, b.world.eggs, dark);
  b.ore = [];
  for (let i = 0; i < 9; i++) { const ox = Math.round(cx0 + 6 + rr() * (W - cx0 - 10)), oy = Math.round(topAt(ox) + 6 + rr() * (fl0 - topAt(ox) - 12)); if (oy > fl0 - 6 || Math.abs(ox - W * .93) < 16) continue; G.rect(dk(K.mortar, .2), ox - 1, oy - 1, 4, 4); G.rect(K.ore[i % 2], ox, oy, 2, 2); G.px(ox + 1, oy + 1, dk(K.ore[i % 2], .3)); b.ore.push([ox, oy]); }
  // mine floor: calm warm stone with soft patches, edged by small stones
  /** @param {number} y */
  const edgeAt = y => Math.round(W * .8 + Math.max(0, fl0 + 10 - y) * .6 + Math.sin(y / 5) * 1.2);
  const fj = sn(dk(K.floor, .09), .5), fT = [K.floor, K.speck, mix(K.floor, K.floorL, .35)].map(c => sn(c, .55));
  for (let y = fl0, r = 0; y < H; r++) { const h = 9 + Math.floor(hs(r, 0, 61) * 4), bk = []; for (let x = cx0 - hs(r, 1, 61) * 20; x < W + 30; x += 14 + hs(x | 0, r, 65) * 13) bk.push(Math.round(x));
    for (let yy = y; yy < Math.min(H, y + h); yy++) { let bi = 0; for (let x = edgeAt(yy); x < W; x++) {
      while (bi < bk.length - 1 && bk[bi + 1] <= x) bi++; const v = hs(bk[bi], r, 62), wv = hs(x >> 1, yy >> 1, 63) < .3, c = fT[Math.floor(v * 3)];
      G.px(x, yy, (yy === y + h - 1 || x === bk[bi]) && !wv ? fj : yy === y && !wv ? mix(c, K.floorL, .3) : c); } }
    y += h; }
  G.rect(dk(K.floor, .3), cx0, fl0, W - cx0, 1); G.rect(dk(K.floor, .15), cx0, fl0 + 1, W - cx0, 2);
  /** @param {number} x @param {number} y @param {number} r @param {number} sd */
  const boulder = (x, y, r, sd) => bgBlob(G, [P.boulderD, mix(P.boulderD, P.boulder, .5), P.boulder, P.boulderL], x, y, r, sd, { base: y + r * .6 });
  for (let y = fl0 + 18; y < H; y += 8 + Math.floor(rr() * 6)) boulder(edgeAt(y) - 1, y, 1.8 + rr(), y);
  // mine mouth: timber frame, dark arch, lantern, rails, cart and props
  const vx = Math.round(W * .93), m0 = hz - 12, wdD = dk(K.wood, .35);
  for (let y = m0; y < fl0; y++) { const d = y - m0, hw = d < 3 ? 8 - [3, 1, 0][d] : 8; G.rect(mix(K.cave, dk(K.cave, .5), d < 8 ? .6 : 0), vx - hw, y, hw * 2, 1); }
  G.rect(dk(K.cave, .4), vx - 6, fl0 - 4, 12, 4);
  G.rect(K.wood, vx - 11, m0, 3, fl0 - m0); G.rect(wdD, vx - 9, m0, 1, fl0 - m0); G.rect(K.wood, vx + 8, m0, 3, fl0 - m0); G.rect(wdD, vx + 10, m0, 1, fl0 - m0);
  G.rect(K.wood, vx - 14, m0 - 4, 29, 4); G.rect(lt(K.wood, .3), vx - 14, m0 - 4, 29, 1); G.rect(wdD, vx - 14, m0 - 1, 29, 1); G.px(vx - 12, m0 - 3, wdD); G.px(vx + 12, m0 - 3, wdD);
  if (snow) G.rect(P.snow, vx - 14, m0 - 5, 29, 1);
  G.rect(K.post, vx - 14, m0, 1, 3); G.rect(dk(K.post, .3), vx - 15, m0 + 3, 3, 1); G.rect(b.world?.lantern === false ? dk(K.post, .1) : K.lamp, vx - 15, m0 + 4, 3, 4); if (b.world?.lantern !== false) G.px(vx - 14, m0 + 5, lt(K.lamp, .6)); G.rect(dk(K.post, .3), vx - 15, m0 + 8, 3, 1);
  b.lamp = [vx - 14, m0 + 6]; b.cave = [vx, fl0 - 3];
  if (b.world?.notes) pinNotes(G, vx + 8, m0 + 2, b.world.notes, dark);
  b.notesBox = b.world?.notes ? [vx + 7, m0 + 2, 5, b.world.notes * 6 - 2] : null;
  /** @param {number} x @param {number} y @param {number} s */
  const crate = (x, y, s) => { G.rect(K.wood, x, y, s, s); G.rect(lt(K.wood, .3), x, y, s, 1); G.rect(wdD, x + s - 1, y, 1, s); G.rect(wdD, x, y + s - 1, s, 1); for (let q = 1; q < s - 1; q++) G.px(x + q, y + q, wdD); };
  /** @param {number} x @param {number} y */
  const barrel = (x, y) => { G.rect(K.cartL, x, y, 6, 8); G.rect(K.cart, x + 4, y, 2, 8); G.rect(lt(K.cartL, .3), x + 1, y, 1, 8); G.rect(K.rail, x, y + 2, 6, 1); G.rect(K.rail, x, y + 6, 6, 1); G.rect(dk(K.cart, .3), x, y - 1, 6, 1); };
  if (vx + 22 < W) { crate(vx + 13, fl0 - 7, 7); crate(vx + 15, fl0 - 13, 6); }
  barrel(vx - 21, fl0 - 8);
  const ra = Math.round(W * .83), ca = ra + 3;
  for (let i = ra; i < vx + 8; i += 4) G.rect(wdD, i, fl0 + 1, 2, 5);
  G.rect(K.rail, ra, fl0 + 2, vx + 8 - ra, 1); G.rect(K.rail, ra, fl0 + 4, vx + 8 - ra, 1); G.rect(lt(K.rail, .4), ra, fl0 + 2, vx + 8 - ra, 1) ;
  if (ca + 22 < vx - 21) {
    G.rect(K.stone, ca + 5, fl0 - 10, 6, 2); G.rect(K.dark, ca + 2, fl0 - 8, 14, 2); G.rect(K.ore[0], ca + 4, fl0 - 9, 2, 2); G.rect(K.ore[1], ca + 10, fl0 - 9, 2, 2);
    G.rect(K.cartL, ca, fl0 - 6, 18, 2); G.rect(K.cart, ca, fl0 - 4, 18, 4); G.rect(dk(K.cart, .3), ca + 2, fl0, 14, 1); G.rect(dk(K.cart, .35), ca + 4, fl0 - 4, 1, 4); G.rect(dk(K.cart, .35), ca + 12, fl0 - 4, 1, 4);
    G.rect(K.cave, ca + 2, fl0 + 1, 3, 3); G.rect(K.cave, ca + 13, fl0 + 1, 3, 3); G.px(ca + 3, fl0 + 2, K.rail); G.px(ca + 14, fl0 + 2, K.rail);
    b.ore.push([ca + 4, fl0 - 9], [ca + 10, fl0 - 9]);
  }
  // ore heaped on the cart (or on the ground beside the rails) by today's tokens
  if (b.world?.ore) { const onCart = ca + 22 < vx - 21; oreHeap(G, ca + (onCart ? 8 : 7), onCart ? fl0 - 10 : fl0 - 1, b.world.ore, K, b.ore); }
  // waterfall over the first ledge into a pool, then a bouldered stream down to the pond
  const fw = W > 300 ? 11 : 7, fx = cx0 + 3, fy0 = steps[0][1] - 1, fy1 = fl0 + 3;
  for (let y = fy0; y < fy1; y++) for (let i = 0; i < fw; i++) G.px(fx + i, y, i === 0 || i === fw - 1 ? P.waterD : (i + Math.floor(y / 3)) % 4 === 0 || y < fy0 + 2 ? P.fallL : P.fall);
  G.rect(P.fall, fx, fy0 - 2, fw, 1); G.rect(P.fallL, fx - 1, fy0 - 1, fw + 2, 1); G.px(fx - 1, fy0, P.foam); G.px(fx + fw, fy0, P.foam);
  const cx = W * .66, cy = hz + (H - hz) * .62, rx = Math.round(Math.max(20, W * .09)), ry = Math.round(Math.max(10, (H - hz) * .17));
  /** @param {number} p0 @param {number} p1 @param {number} p2 @param {number} p3 @param {number} u */
  const bez = (p0, p1, p2, p3, u) => p0 * (1 - u) ** 3 + 3 * p1 * u * (1 - u) ** 2 + 3 * p2 * u * u * (1 - u) + p3 * u ** 3;
  /** @type {Array<[number, number]>} */
  const sp = [];
  const sx0 = fx + fw / 2;
  for (let u = 0; u <= 1; u += .004) sp.push([bez(sx0, W * .787, W * .792, cx + rx * .8, u), bez(fy1, fl0 + 18, cy - ry * .4, cy - ry * .1, u)]);
  const sw = W > 300 ? 3 : 2;
  for (const [x, y] of sp) for (let j = -sw - 1; j <= sw + 1; j++) for (let i = -sw - 1; i <= sw + 1; i++) if (i * i + j * j <= (sw + 1.2) ** 2) G.px(x + i, y + j, j > 0 ? sn(dk(P.grass, .3), .5) : sn(mix(P.grass, P.sand, .5), .6));
  for (const [x, y] of sp) for (let j = -sw; j <= sw; j++) for (let i = -sw; i <= sw; i++) if (i * i + j * j <= sw * sw + .5) G.px(x + i, y + j, snow ? P.ice : j < -sw + 1 ? P.waterD : P.water);
  if (!snow) sp.forEach(([x, y], q) => { if (q % 9 < 3) G.px(x + (q % 18 < 9 ? -1 : 1), y, P.waterL); if (q % 37 < 4 && q > 20) G.px(x + (q % 74 < 37 ? 1 : -1), y + 1, P.foam); });
  bgBlob(G, [P.waterD, P.water, P.fall], sx0, fy1 + 2, 6, 3, { base: fy1 + 6 });
  for (let i = -5; i <= 5; i += 2) G.px(sx0 + i, fy1 + (i & 2 ? 0 : 1), P.foam);
  const rsb = rng(53);
  for (let q = 10; q < sp.length - 60; q += 26 + Math.floor(rsb() * 20)) { const [x, y] = sp[q], side = q % 2 ? 1 : -1; boulder(x + side * (sw + 3), y + 1, 2 + rsb() * 1.5, q); }
  boulder(fx - 4, fy1 + 1, 3, 1); boulder(fx + fw + 4, fy1 + 2, 3.5, 2);
  b.fall = { x: fx, y0: fy0, y1: fy1, w: fw }; b.stream = sp.filter((_, q) => q % 6 === 0);
  // plank bridge with post lanterns where the lane crosses the stream
  let bq = sp.findIndex(([, y]) => y >= brY); if (bq < 0) bq = 40; const [bxc, byc] = sp[bq];
  G.rect(dk(P.plankD, .45), bxc - 9, byc + 3, 19, 2);
  for (let i = -9; i <= 9; i++) { G.rect((i & 1) ? P.plank : mix(P.plank, P.plankD, .35), bxc + i, byc - 2, 1, 5); G.px(bxc + i, byc - 2, lt(P.plank, .25)); if (bgHash(i, 0, 5) < .3) G.px(bxc + i, byc + bgHash(i, 1, 5) * 3, P.plankD); }
  [-1, 1].forEach(sd => { const px2 = bxc + sd * 10 - (sd > 0 ? 1 : 0); G.rect(P.plankD, px2, byc - 7, 2, 11); G.px(px2, byc - 7, lt(P.plank, .3)); });
  G.rect(P.plankD, bxc - 9, byc - 5, 19, 1); G.rect(lt(P.plank, .2), bxc - 9, byc - 6, 19, 1);
  b.bridge = [bxc, byc];
  [-1, 1].forEach(sd => { const lx = bxc + sd * 12; G.rect(P.plankD, lx - (sd < 0 ? 0 : 1), byc - 7, 2, 1); G.rect(dk(P.plankD, .3), lx, byc - 6, 1, 1); G.rect(dk(P.plankD, .3), lx - 1, byc - 5, 3, 1); G.rect(A.warm, lx - 1, byc - 4, 3, 3); G.px(lx, byc - 3, lt(A.warm, .6)); G.rect(dk(P.plankD, .3), lx - 1, byc - 1, 3, 1); b.lights.push([lx, byc + 5, 9, 4, .45]); b.lamps.push([lx - 1, byc - 3]); });
  // pond with sand and pebble rim, banded water and reflected light dashes
  bgOvalG(G, sn(dk(P.grass, .2), .55), cx, cy + 2, rx + 5, ry + 3); bgOvalG(G, sn(mix(P.sand, P.grass, .2), .6), cx, cy, rx + 3, ry + 2);
  for (let j = -ry; j <= ry; j++) {
    const v = j / ry, w = Math.round(rx * Math.sqrt(1 - v * v));
    for (let i = -w; i <= w; i++) { const d = Math.hypot(i / rx, (j + ry * .15) / ry), ch = (i + j) & 1;
      G.px(cx + i, cy + j, snow ? (d > .8 ? lt(P.ice, .3) : P.ice) : j < -ry + 3 + (bgHash(i >> 2, 0, 66) < .5 ? 1 : 0) ? dk(P.waterD, .25) : d > .84 || (d > .8 && ch) ? mix(P.water, P.waterL, .3) : d < .48 || (d < .52 && ch) ? P.waterD : P.water); }
  }
  if (!snow) { const rd = rng(61); for (let i = 0; i < rx * ry / 30; i++) { const j = Math.round((rd() * 2 - 1) * ry * .8), w = Math.round(rx * Math.sqrt(1 - (j / ry) ** 2)) - 3, len = 2 + Math.floor(rd() * 5), x = Math.round(cx - w + rd() * (2 * w - len)); if (w > 4) G.rect(mix(P.waterL, P.water, .35), x, cy + j, len, 1); } }
  if (b.moon && !snow) { const mx = Math.max(cx - rx * .6, Math.min(cx + rx * .6, b.moon.x)); for (let j = -ry + 4; j < ry - 3; j++) { if (bgHash(j, 0, 3) < .45) continue; const w = 1 + Math.round(bgHash(j, 1, 3) * (3 + (ry - Math.abs(j)) * .15)); G.rect(mix(P.water, A.moon, .5 * b.moon.a * b.moon.k), mx - w + Math.round((bgHash(j, 2, 3) - .5) * 6), cy + j, w * 2, 1); } }
  const rpb = rng(37);
  for (let a = 0; a < 6.283; a += .1) { const x = cx + Math.cos(a) * (rx + 2.5), y = cy + Math.sin(a) * (ry + 1.8); if (bgNoise(a * 3, 0, 64) < .45) G.rect(sn(mix(P.grass, P.grass2, .5)), x - 1, y, 3, 1); }
  for (let a = 0; a < 6.283; a += .3 + rpb() * .25) { const x = cx + Math.cos(a) * (rx + 2), y = cy + Math.sin(a) * (ry + 1.5); if (rpb() < .5) { G.rect(P.boulder, x - 1, y, 2, 1); G.px(x - 1, y - 1, P.boulderL); G.px(x, y + 1, P.boulderD); } }
  [[3.14, 3.2], [0, 2.6], [-.5, 3.4], [-2.6, 2.4], [-1.9, 2]].forEach(([a, r], q) => boulder(cx + Math.cos(a) * (rx + 2), cy + Math.sin(a) * (ry + 1) + 1, r, 90 + q));
  /** @param {number} px @param {number} py @param {boolean} fl */
  const lily = (px, py, fl) => { bgOvalG(G, P.lily, px, py, 3, 1); G.rect(lt(P.lily, .3), px - 2, py - 1, 3, 1); G.px(px + 2, py, snow ? P.ice : P.water); if (fl) { G.rect(P.fl[0], px - 1, py - 2, 2, 1); G.px(px - 1, py - 3, P.fl[2]); } };
  if (!snow) { lily(cx + rx * .4, cy - ry * .15, true); lily(cx - rx * .3, cy + ry * .5, false); lily(cx - rx * .05, cy - ry * .45, false); }
  const rr5 = rng(39);
  [[cx - rx - 2, cy - 2, 9], [cx + rx - 8, cy - ry * .5, 6]].forEach(([qx, qy, m]) => { for (let i = 0; i < m; i++) {
    const bx = Math.round(qx + i), by = Math.round(qy + (i % 2) * 2), hgt = 5 + Math.floor(rr5() * 5);
    G.rect(i % 3 ? P.reed : lt(P.reed, .2), bx, by - hgt, 1, hgt + 1); if (rr5() < .45) G.rect(P.cattail, bx, by - hgt - 2, 1, 3);
  } });
  b.pond = { cx, cy, rx, ry };
  // big tree on the left: ridged trunk, roots and a canopy that frames the top-left corner
  const tx = Math.round(W * .04), twd = W > 300 ? 16 : 10, bt = hz + 16, trR = [P.trunkD, mix(P.trunkD, P.trunk, .55), P.trunk, P.trunkL];
  for (let y = 0; y <= bt; y++) {
    const fl = Math.max(0, y - bt + 6) ** 1.5 * .35, l = Math.round(tx - twd / 2 + Math.sin(y / 23) * 1.5 - fl), r = Math.round(tx + twd / 2 + Math.sin(y / 23) * 1.5 + fl * .8);
    for (let x = l; x < r; x++) {
      const u = (x - l) / (r - l), groove = bgHash(x, Math.floor(y / 5 + bgHash(x, 0, 9) * 3), 19) < .22 && u > .15 && u < .9;
      let c = u < .22 ? trR[3] : u < .62 ? trR[2] : u < .85 ? trR[1] : trR[0];
      if (groove) c = trR[Math.max(0, trR.indexOf(c) - 1)];
      if (y > bt - 4 && bgHash(x >> 1, 0, 6) < .3) c = trR[0];
      if (y < 54) c = mix(c, trR[0], Math.min(.8, (54 - y) / 12));
      G.px(x, y, c);
    }
  }
  G.rect(sn(dk(P.grass, .3), .5), tx - twd, bt + 1, twd * 2 + 4, 1);
  [[-1, 9], [1, 8]].forEach(([sd, len]) => { for (let i = 0; i < len; i++) { const x = tx + sd * (twd / 2 + 2 + i), y = bt - 1 + Math.floor(i / 3); G.rect(i < len - 3 ? trR[1] : trR[0], x, y, 1, i < len - 4 ? 3 : 2); G.px(x, y, trR[2]); } });
  const leaves = [P.leafD, mix(P.leafD, P.leaf, .5), P.leaf, P.leaf2, P.leafL, P.leafH], rt = rng(41), townX = W * .11 - 4;
  if (b.season.leaves > 0 && !snow) fallenLeaves(G, tx - twd, tx + twd * 2.2, bt - 1, bt + 7, b.season.leaves, dark, P.trunkD, rng(44));
  const brEnd = Math.min(W * .28, townX + 62);
  b.tree = { x0: tx - twd, x1: brEnd - 8, xc: townX, yLow: 44, yHigh: 13, g0: hz + 6, g1: bt + 8 };
  for (let x = tx; x < brEnd; x++) { const u = (x - tx) / (brEnd - tx), y = 6 + u * 5 - Math.sin(u * 3.14) * 3, th = Math.max(1, Math.round(4 * (1 - u))); G.rect(trR[2], x, y, 1, th); G.px(x, y, trR[3]); G.px(x, y + th, trR[0]); }
  /** @type {number[][]} */
  const cl = [];
  const und = [dk(P.leafD, .3), dk(P.leafD, .15)]; bgBlob(G, und, tx - 4, 33, 12, 7, { leafy: .5 }); bgBlob(G, und, tx + 12, 31, Math.min(12, townX - tx - 6), 8, { leafy: .5 });
  for (let q = 0; q < 14; q++) cl.push([-8 + rt() * (townX + 4), -8 + rt() * 38, 10 + rt() * 8]);
  for (let x = townX; x < brEnd + 6; x += 10 + rt() * 5) cl.push([Math.min(x, brEnd), 4 + rt() * 5, 6 + rt() * 4]);
  cl.forEach(c => { if (c[0] + c[2] > townX && c[1] + c[2] > 16) c[1] = 16 - c[2] + (c[0] < townX ? 6 : 0); });
  cl.sort((p, q) => p[1] - q[1]).forEach(([x, y, r], q) => {
    bgBlob(G, leaves.slice(0, 4), x, y, r, q * 5 + 1, { leafy: .35, lift: y > 26 ? -1 : 0 });
    for (let d = 0; d < r * 1.7; d++) { const a = -3.7 + rt() * 2.8, e = rt() * r * .78, dx = x + Math.cos(a) * e, dy = y + Math.sin(a) * e;
      bgBlob(G, leaves.slice(1), dx, dy, 1.6 + rt() * 1.8, q * 31 + d, { lift: (dy < y - r * .35 ? 1 : 0) - (y > 26 ? 2 : 0) }); }
  });
  if (snow) cl.forEach(([x, y, r]) => { for (let i = -r * .6; i < r * .3; i++) G.px(x + i, y - r * .85 + Math.abs(i) * .25, P.snow); });
  // flowering bushes on the meadow edges, clear of the character slots
  /** @param {number} x @param {number} y @param {number} r @param {number} sd */
  const bush = (x, y, r, sd) => { G.rect(sn(dk(P.grass, .3), .5), x - r, y + r * .6, r * 2, 2); bgBlob(G, [P.leafD, mix(P.leafD, P.leaf, .5), P.leaf, P.leaf2, P.leafL], x, y, r, sd, { leafy: .35, base: y + r * .7 });
    const rb2 = rng(sd); if (!snow) for (let q = 0; q < r; q++) { const a = -3.5 + rb2() * 2.8, e = rb2() * r * .75; G.rect(P.fl[(sd + q) % 5], x + Math.cos(a) * e, y + Math.sin(a) * e, 2, 1); } else bgOvalG(G, P.snow, x - 1, y - r * .7, r * .6, 1); };
  bush(W * .755, H - 5, 8, 71); bush(W * .725, H, 6, 72); if (W > 300) bush(3, hz + 40, 7, 73);
  // dark foreground leaves in the bottom-left corner
  const fgR = [P.fg, mix(P.fg, P.leafD, .6), P.leafD, mix(P.leafD, P.leaf, .45)], fr = Math.min(24, W * .06);
  const rbl = rng(83); for (let q = 0; q < fr * 1.6; q++) { const bx = rbl() * fr * 1.5, h = 5 + rbl() * fr * .7, lean = (rbl() - .3) * .5; for (let j = 0; j < h; j++) G.rect(j > h - 3 ? fgR[3] : fgR[q % 2 + 1], bx + lean * j, H - 1 - j, j < h * .45 ? 2 : 1, 1); }
  bgBlob(G, fgR, -3, H + 4, fr, 3, { leafy: .4 }); bgBlob(G, fgR, fr * .75, H + 6, fr * .55, 4, { leafy: .4 }); bgBlob(G, fgR, fr * .15, H - fr * .7, fr * .4, 5, { leafy: .4 });
  b.puddles = [];
  // puddles while it rains, shrinking for a while after it stops
  const pl = puddleLeft((Date.now() - sky.rainAt) / 60000, wet, snow);
  if (pl > 0) { const r5 = rng(31), pc2 = mix(P.water, P.grass, .35), prx = wet ? 4 : 1 + Math.round(3 * pl);
    for (let i = 0; i < 7; i++) { const qx = Math.round(W * (.06 + r5() * .7)), qy = Math.round(hz + 20 + r5() * (H - hz - 28));
      if (((qx - cx) / (rx + 10)) ** 2 + ((qy - cy) / (ry + 8)) ** 2 < 1 || onPath(qx, qy, 4)) continue;
      bgOvalG(G, pc2, qx, qy, prx, 1); if (prx > 2) G.rect(P.waterL, qx - 2, qy - 1, 2, 1); if (wet) b.puddles.push([qx, qy]); } }
  // warm light pools from windows and lanterns at night
  if (dark > .3) for (const [lx, ly, lrx, lry, a] of b.lights) for (let j = -lry; j <= lry; j++) for (let i = -lrx; i <= lrx; i++) { const d = (i / lrx) ** 2 + (j / lry) ** 2; if (d <= 1) G.tint(lx + i, ly + j, A.warm, a * dark * (d < .4 ? 1 : .55)); }
  G.flush(b.landC.getContext('2d'));
  const rf = rng(13); b.flowers = [];
  if (!snow) for (let i = 0; i < W / 4; i++) {
    const fx2 = Math.round(rf() * W), fy = Math.round(hz + 16 + rf() * (H - hz - 20)), col = P.fl[Math.floor(rf() * P.fl.length)], big = rf() < .4, inZone = fx2 > W * .04 && fx2 < W * .76 && fy > H * .4;
    if (fx2 > W * .77 || (inZone && rf() < .55) || ((fx2 - cx) / (rx + 6)) ** 2 + ((fy - cy) / (ry + 5)) ** 2 < 1 || onPath(fx2, fy, 3) || lnp(fx2, fy) || fx2 < tx + twd && fy < bt + 4) continue;
    b.flowers.push([fx2, fy, col, big]);
  }
  const warm = Math.sin(Math.PI * k) * (eve ? .16 : .14);
  b.wash = [];
  if (warm > .01) b.wash.push([eve ? A.dusk : A.dawn, warm, hz - 16]);
  if (snow) b.wash.push([P.snow, .12, 0]); else if (wet) b.wash.push([A.wet, .14, hz - 16]);
  if (fog) b.wash.push([A.fog, .4, 0]);
  Object.assign(b, { W, H, hz, P, K, A, L, dark, wet, snow, fog, storm, lean: windLean(wind.speed, wind.dir) });
}
// Filled ellipse into a pixel layer.
/** @param {Grid} G @param {string} col @param {number} cx @param {number} cy @param {number} rx @param {number} ry */
function bgOvalG(G, col, cx, cy, rx, ry) { for (let j = -ry; j <= ry; j++) { const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - j * j / (ry * ry + .01)))); G.rect(col, cx - w, cy + j, w * 2 + 1, 1); } }
// One frame: blit both static layers and draw everything that moves on top; s is wall-clock seconds, a the phase of the idle loops (water, flowers, smoke, glows), held while the scene rests.
/** @param {number} s @param {number} [a] */
export function bgPaint(s, a = s) {
  const b = bgs, x = b.ctx, { W, H, hz, P, K, A, L, pond: pd } = b;
  /** @type {(col: string, a: number, y: number, w?: number, h?: number) => void} */
  const R = (col, a, y, w, h) => bgRect(x, col, a, y, w, h), alpha = (/** @type {number} */ k) => { x.globalAlpha = Math.max(0, Math.min(1, k)); };
  x.drawImage(b.skyC, 0, 0);
  if (b.starA > 0) for (const p of b.stars) {
    const v = Math.sin(s * p.v + p.p); if (v < -.85) continue;
    alpha(b.starA * (v < -.4 ? .5 : 1)); R(A.star, p.x, p.y);
    if (p.big && v > .7) { alpha(b.starA * .45); R(A.star, p.x - 1, p.y, 3, 1); R(A.star, p.x, p.y - 1, 1, 3); }
  }
  for (const e of b.ev) if (e.k === 'shoot') {
    const p = (s - e.t0) / e.dur;
    for (let j = 0; j < 8; j++) { alpha(b.starA * (1 - j / 8) * (1 - p * .6)); R(A.star, e.x + e.dir * (p * 44 - j * 2), e.y + p * 18 - j); }
  }
  if (b.sun) { const g = Math.sin(a * .45) > 0 ? 15 : 14; alpha(.1 + .04 * Math.sin(a * .9)); bgOval(x, b.sun.col, b.sun.x, b.sun.y, g, g); }
  if (b.moon) { alpha(b.moon.a * b.moon.k * (.08 + .02 * Math.sin(a * .7))); bgOval(x, A.moon, b.moon.x, b.moon.y, 14, 14); if (b.full > 0) { alpha(b.moon.a * b.full * .05); bgOval(x, A.moon, b.moon.x, b.moon.y, 22, 22); } }
  for (const [wx0, wy0, on] of b.week || []) { alpha(b.starA * (on ? 1 : .2)); R(A.star, wx0, wy0); if (on) { alpha(b.starA * .4); R(A.star, wx0 - 1, wy0, 3, 1); R(A.star, wx0, wy0 - 1, 1, 3); } }
  alpha(1);
  for (const c of b.clouds) x.drawImage(c.cv, Math.round((c.x0 + s * c.v) % (W + c.w + 8)) - c.w - 4, c.y);
  for (const e of b.ev) if (e.k === 'birds') {
    const head = e.x + e.dir * (s - e.t0) * e.v;
    for (let i = 0; i < e.n; i++) {
      const g = Math.ceil(i / 2), bx = Math.round(head - e.dir * g * 6), by = e.y + (i % 2 ? -g : g) * 3 + Math.round(Math.sin(s * 2.5 + i) * 1), up = Math.floor(s * 5 + i * 1.7) % 2 ? 1 : -1;
      R(A.bird, bx - 2, by - up); R(A.bird, bx - 1, by - (up > 0 ? 1 : 0)); R(A.bird, bx, by); R(A.bird, bx + 1, by - (up > 0 ? 1 : 0)); R(A.bird, bx + 2, by - up);
    }
  }
  paintExtras(b, R, alpha, s, false);
  x.drawImage(b.landC, 0, 0);
  // a bird leaving the big tree: rises out of the canopy, flaps in two frames, fades as it goes
  for (const e of b.ev) if (e.k === 'lift') {
    const p = (s - e.t0) / e.dur, bx = Math.round(e.x0 + p * W * .42), by = Math.round(e.y0 - 14 * Math.sqrt(p) + Math.sin(s * 2.2) * .6), up = Math.floor(s * 5) % 2 ? 1 : -1;
    alpha(p > .8 ? (1 - p) / .2 : 1); R(A.bird, bx - 2, by - up); R(A.bird, bx - 1, by - (up > 0 ? 1 : 0)); R(A.bird, bx, by); R(A.bird, bx + 1, by - (up > 0 ? 1 : 0)); R(A.bird, bx + 2, by - up); alpha(1);
  }
  const f = b.fall;
  if (f && !b.snow) {
    for (let i = 1; i < f.w - 1; i++) for (let q = 0; q < 2; q++) { const h = f.y1 - f.y0, yy = f.y0 + ((a * 26 + bgHash(i, q, 7) * h) % h); R(P.fallL, f.x + i, yy, 1, 3 + q); }
    for (let i = 0; i < 4; i++) { const ph = (a * 3 + i * .7) % 1; alpha(1 - ph); R(P.foam, f.x + f.w / 2 - 5 + i * 3 + Math.round(Math.sin(a * 2 + i) * 1.5), f.y1 + 1 - Math.round(ph * 4), 2, 1); }
    alpha(1);
    const st2 = b.stream, n = st2.length;
    for (let i = 0; i < 6; i++) { const q = Math.floor((a * 4 + i * n / 6) % n), [qx, qy] = st2[q]; R(P.waterL, qx - 1, qy - 1, 2, 1); }
    if (b.world?.boats) paintBoats(b, R, alpha, pace.still ? 0 : s, b.world.boats);
  }
  if (!b.snow) {
    const o1 = Math.round(Math.sin(a * .8) * 2), o2 = Math.round(Math.sin(a * .8 + 2.1) * 2);
    R(P.waterL, pd.cx - pd.rx * .55 + o1, pd.cy - pd.ry * .45, pd.rx * .5 + (o2 > 0 ? 2 : 0), 1); R(P.waterL, pd.cx + pd.rx * .1 + o2, pd.cy + pd.ry * .35, pd.rx * .35, 1);
    for (let i = 0; i < 3; i++) if (Math.sin(a * 2.3 + i * 2.4) > .6) R(P.waterL, pd.cx + (i - 1) * pd.rx * .45 + Math.round(Math.sin(a * .5 + i) * 3), pd.cy + (i % 2 ? -1 : 1) * pd.ry * .15, 2, 1);
  }
  for (const e of b.ev) {
    const p = (s - e.t0) / e.dur;
    if (e.k === 'ripple') {
      const rr = 1 + p * (e.max - 1); alpha(1 - p);
      for (let a = 0; a < 16; a++) { const qx = Math.round(e.x + Math.cos(a * .3927) * rr), qy = Math.round(e.y + Math.sin(a * .3927) * rr * .5);
        if (e.free || ((qx - pd.cx) / pd.rx) ** 2 + ((qy - pd.cy) / pd.ry) ** 2 < .92) R(P.waterL, qx, qy); }
    } else if (e.k === 'fish') {
      const fx = Math.round(e.x0 + e.dir * p * 18), fy = Math.round(e.y - Math.sin(Math.PI * p) * 14), up = p < .5 ? 1 : -1;
      alpha(1); R(P.fish, fx - (e.dir < 0 ? 1 : 0), fy, 2, 2); R(P.fish, fx - 2 * e.dir, fy + up, 2, 1); R(P.fishT, fx - 3 * e.dir, fy + 2 * up, 1, 2);
    } else if (e.k === 'splash') {
      alpha(1); if (p < .5) R(P.drop, e.x, e.y, 1, 2); else { R(P.drop, e.x - 2, e.y - 1); R(P.drop, e.x + 2, e.y - 1); }
    }
  }
  alpha(1);
  const gust = b.storm ? -.2 : .45, wave = Math.sin(a * .31) * 2;
  for (const [fx, fy, col, big] of b.flowers) {
    const sw = Math.sin(a * 1.7 - fx * .07 + wave) > gust ? 1 : 0;
    R(P.stem, fx, fy + 1, 1, 2); R(col, fx + sw, fy);
    if (big) { R(col, fx + sw - 1, fy, 3, 1); R(col, fx + sw, fy - 1, 1, 3); R(P.fl[1], fx + sw, fy); }
  }
  b.chims.slice(0, smokeCount(wx.temp)).forEach((/** @type {number[]} */ [hx, hy], /** @type {number} */ i) => { for (let j = 0; j < 4; j++) {
    const q = (a * .22 + j / 4 + i * .37) % 1, z = q > .5 ? 4 : q > .2 ? 3 : 2;
    const sx = hx + Math.round(Math.sin(q * 6 + i) * 2.4 + q * smokeDrift(b.lean, b.storm)), sy = hy - Math.round(q * 22) - z + 2; alpha((1 - q) * .7); R(A.smoke, sx, sy + 1, z, z - 1); if (z > 2) R(A.smoke, sx + 1, sy, z - 2, z + 1);
  } });
  alpha(1);
  b.ore.forEach((/** @type {number[]} */ [ox, oy], /** @type {number} */ i) => { if ((a * .9 + i * .713) % 5 < .3) {
    R(K.glint, ox, oy, 2, 2); alpha(.55); R(K.glint, ox - 2, oy, 6, 1); R(K.glint, ox, oy - 2, 1, 6); alpha(1);
  } });
  const fa = (L - .55) * 3;
  if (fa > 0 && !b.wet && !b.snow) { alpha(fa); for (let i = 0; i < 3; i++) {
    const bx = Math.round(W * (.12 + .26 * i) + Math.sin(s * .21 * (1 + i * .3) + i * 2) * W * .1), by = Math.round(hz + 28 + (H - hz - 44) * (.3 + .25 * Math.sin(s * .17 + i * 1.7)) + Math.sin(s * 1.9 + i) * 4);
    const col = P.fl[[0, 3, 4][i]];
    if (Math.floor(s * 6 + i * 1.3) % 2) { R(col, bx - 2, by - 2, 2, 2); R(col, bx + 1, by - 2, 2, 2); R(col, bx - 1, by, 1, 1); R(col, bx + 1, by, 1, 1); } else R(col, bx - 1, by - 2, 3, 1);
    R(P.body, bx, by - 2, 1, 3);
  } alpha(1); }
  paintExtras(b, R, alpha, s, true);
  for (const [col, a, y] of b.wash) { alpha(a); R(col, 0, y, W, H - y); }
  if (b.fog) { alpha(.18); for (let i = 0; i < 3; i++) { const fw = Math.round(W * .55); R(A.fog, Math.round((s * (2.4 + i) + i * 194) % (W + fw)) - fw, hz - 12 + i * Math.round((H - hz) / 3), fw, 6); } }
  alpha(1);
  const glow = (b.dark - .25) * 1.33;
  if (glow > 0) {
    const fk = .85 + Math.random() * .15, lit = b.world?.lantern !== false; if (lit) { alpha(.12 * glow * fk); bgOval(x, K.lamp, b.lamp[0], b.lamp[1], 10, 7); alpha(.16 * glow * fk); bgOval(x, K.lamp, b.lamp[0], b.lamp[1], 5, 4); }
    alpha(.22 * glow * (.7 + Math.random() * .3)); bgOval(x, K.ember, b.cave[0], b.cave[1], 4, 1);
    for (const [lx, ly] of b.lamps) { alpha(.16 * glow * (.85 + Math.random() * .15)); bgOval(x, A.warm, lx + 1, ly, 5, 4); }
    alpha(glow); if (lit) R(K.lamp, b.lamp[0], b.lamp[1] - 1, 1, 2);
  }
  const ff = (.5 - L) * 3;
  if (ff > 0 && !b.wet && !b.snow && b.flies !== false) for (let i = 0; i < 10; i++) {
    const blink = Math.sin(s * (1.1 + i * .07) + i * 2.3); if (blink < .1) continue;
    const fx = Math.round(W * (.04 + .74 * (i * .618 % 1)) + Math.sin(s * (.23 + i * .021) + i * 1.9) * W * .06);
    const fy = Math.round(hz + 18 + (H - hz - 28) * ((i * .382 + .2) % 1) + Math.sin(s * (.31 + i * .017) + i) * 8);
    alpha(Math.min(1, ff) * .3 * blink); R(P.glow, fx - 2, fy, 5, 1); R(P.glow, fx, fy - 2, 1, 5);
    alpha(Math.min(1, ff)); R(P.fly, fx, fy);
  }
  alpha(1);
}
// Ambient events that come and go: birds, flocks, leaves, shooting stars, ripples, a jumping fish, rain splashes.
/** @param {number} dt @param {number} s */
export function bgSpawn(dt, s) {
  /** @param {number} rate */
  const b = bgs, ev = b.ev, pd = b.pond, roll = rate => ev.length < 40 && Math.random() < rate * dt, rnd = Math.random;
  for (let i = ev.length - 1; i >= 0; i--) if (s > ev[i].t0 + ev[i].dur || s < ev[i].t0 - 1) {
    const e = ev.splice(i, 1)[0]; if (e.k === 'fish') ev.push({ k:'ripple', x:e.x0 + e.dir * 18, y:e.y, t0:s, dur:1.4, max:7 });
  }
  if (b.L > .6 && !b.wet && !b.snow && !b.fog && roll(1 / 30)) {
    const dir = rnd() < .5 ? 1 : -1, v = 10 + rnd() * 8, n = 2 + Math.floor(rnd() * 4);
    ev.push({ k:'birds', dir, v, n, x: dir > 0 ? -8 : b.W + 8, y: Math.round(b.hz * (.15 + rnd() * .35)), t0:s, dur:(b.W + 32 + n * 6) / v });
  }
  if (b.starA > .5 && wx.cloud < 70 && !b.wet && !b.snow && roll(1 / 25)) ev.push({ k:'shoot', x:b.W * (.15 + rnd() * .7), y:b.hz * (.05 + rnd() * .3), dir:rnd() < .5 ? 1 : -1, t0:s, dur:.7 });
  spawnExtras(b, roll, s);
  if (b.snow) return;
  const inPond = () => { const a = rnd() * 6.283, d = Math.sqrt(rnd()) * .75; return [pd.cx + Math.cos(a) * d * pd.rx, pd.cy + Math.sin(a) * d * pd.ry]; };
  if (roll(b.wet ? 3 : 1 / 5)) { const [qx, qy] = inPond(); ev.push({ k:'ripple', x:qx, y:qy, t0:s, dur:b.wet ? .9 : 1.6, max:b.wet ? 5 : 7 }); }
  if (b.L > .5 && !b.wet && roll(1 / 40)) {
    const dir = rnd() < .5 ? 1 : -1, x0 = pd.cx - dir * pd.rx * .3 + (rnd() - .5) * pd.rx * .4, y = pd.cy + (rnd() - .5) * pd.ry * .4;
    ev.push({ k:'fish', x0, y, dir, t0:s, dur:1.1 }, { k:'ripple', x:x0, y, t0:s, dur:1.2, max:6 });
  }
  if (b.wet) {
    if (roll(6)) ev.push({ k:'splash', x:Math.round(rnd() * b.W * .78), y:Math.round(b.hz + 8 + rnd() * (b.H - b.hz - 12)), t0:s, dur:.3 });
    if (b.puddles.length && roll(2)) { const [qx, qy] = b.puddles[Math.floor(rnd() * b.puddles.length)]; ev.push({ k:'ripple', x:qx, y:qy, t0:s, dur:.6, max:4, free:true }); }
  }
}
/** One sky moment now: a shooting star across the night sky, or a bird lifting off the big tree. @param {'star' | 'bird'} k */
export function bgMoment(k) {
  const b = bgs, s = Date.now() / 1000; if (!b.W || !moving()) return;
  wake();
  if (k === 'star') b.ev.push({ k:'shoot', x:b.W * (.25 + Math.random() * .5), y:b.hz * (.06 + Math.random() * .2), dir:Math.random() < .5 ? 1 : -1, t0:s, dur:.7 });
  else if (b.tree) b.ev.push({ k:'lift', x0:b.tree.x1 - 6, y0:20, t0:s, dur:7 });
}
// Backdrop loop: paints at FAST_MS while something quick is on screen, once a second for slow drift, and not at all while nothing moves (an idle check each second still rolls for events, and the minute repaints scenery).
/** @param {number} ts */
function bgTick(ts) {
  bgs.raf = 0;
  if (!moving() || !bgs.skyC) return;
  const dt = Math.min(1.2, (ts - bgs.last) / 1000); bgs.last = ts;
  for (const f of [...frameHooks]) f(performance.now());
  if (Math.floor(Date.now() / 60000) !== bgs.min) return drawGarden();
  if (ts - (bgs.wt || 0) > 5000) { bgs.wt = ts; if (worldKey() !== bgs.wkey) return drawGarden(); }
  const s = Date.now() / 1000; bgSpawn(dt, s);
  // A fishing catch draws on its rod, not here: its frames repaint the backdrop only when the scene itself is due.
  const need = gap(false); if (need === FAST_MS) bgs.amb = s;
  if (!frameHooks.size || need === FAST_MS || need && ts - (bgs.pt || 0) >= need - FAST_MS / 2) { bgs.pt = ts; bgPaint(s, bgs.amb ?? s); }
  arm(frameHooks.size ? FAST_MS : need);
}
// Between paints while nothing moves: roll for new events, watch the minute and the scenery facts, and paint only when something needs it.
function bgIdle() {
  bgs.raf = 0; bgs.tm = 0;
  if (!moving() || !bgs.skyC) return;
  const now = performance.now(), dt = Math.min(1.2, (now - bgs.last) / 1000); bgs.last = now;
  let paint = Math.floor(Date.now() / 60000) !== bgs.min;
  if (!paint && now - (bgs.wt || 0) > 5000) { bgs.wt = now; paint = worldKey() !== bgs.wkey; }
  if (!paint) { bgSpawn(dt, Date.now() / 1000); paint = gap() > 0; }
  if (paint) bgs.raf = requestAnimationFrame(bgTick); else arm(0);
}
const IDLE = 1000; // ms between idle checks while nothing moves
// Repaint gap the scene needs now (repaintMs over the live events, catches unless hooks is false, weather, creatures and drift).
const gap = (hooks = true) => { const b = bgs; return repaintMs({ events: b.ev.length, hooks: hooks ? frameHooks.size : 0, wet: !!b.wet, snow: !!b.snow, L: b.L ?? 1, flies: b.flies !== false, clouds: b.clouds?.length || 0, fog: !!b.fog, boats: b.world?.boats || 0 }); };
// Next step after a paint: a frame after ms, or an idle check when ms is 0.
/** @param {number} ms */
function arm(ms) {
  clearTimeout(bgs.tm); bgs.raf = -1; bgs.due = performance.now() + (ms || IDLE);
  bgs.tm = setTimeout(ms ? () => { bgs.tm = 0; bgs.raf = requestAnimationFrame(bgTick); } : bgIdle, ms || IDLE);
}
// Something quick just started (a sky moment, a catch): paint on the next frame instead of waiting.
function wake() {
  if (!moving() || !bgs.skyC || bgs.raf > 0 || (bgs.raf === -1 && bgs.due - performance.now() <= FAST_MS)) return;
  clearTimeout(bgs.tm); bgs.tm = 0; bgs.raf = requestAnimationFrame(bgTick);
}
/** Work drawn on the backdrop's own frames (a fishing catch), so it adds no frames of its own. @type {Set<(now: number) => void>} */
const frameHooks = new Set();
/** Runs fn(now) on every backdrop frame until the returned function is called; the loop runs at its quick rate meanwhile. @param {(now: number) => void} fn */
export const onFrame = fn => { frameHooks.add(fn); wake(); return () => { frameHooks.delete(fn); }; };
// Today's scenery facts from the sessions into bgs.world; returns a key that changes when the drawing would.
function worldKey() { const w = bgs.world = worldNow(state.S, Date.now()); return [w.ore, w.blooms, w.boats, w.prs, w.week.map(Number).join(''), +w.lantern, +w.cat, w.notes, +w.vane, w.eggs].join('/'); }
// Start the loop unless motion is reduced, the tab is hidden, the garden is off screen or it already runs.
function bgKick() {
  if (!bgs.vis) { bgs.vis = true; onPace(() => { if (moving()) bgKick(); else { clearTimeout(bgs.tm); cancelAnimationFrame(bgs.raf); bgs.raf = 0; bgs.tm = 0; } if (pace.still !== bgs.still && !document.hidden) drawGarden(); }); }
  bgs.still = pace.still;
  if (!moving()) return;
  if (!bgs.raf) bgs.last = performance.now();
  if (!bgs.raf || bgs.raf === -1 && bgs.due - performance.now() > (gap() || IDLE)) arm(gap());
}
// Measure at twice the sprite density, rebuild scenery when anything changed, paint one frame, update the weather plaque and rain overlay.
export function drawGarden() {
  if (later('draw', drawGarden)) return;
  const g = $('garden'), px = (+getComputedStyle(g).getPropertyValue('--px') || 4) / 2;
  const W = Math.ceil(g.clientWidth / px), H = Math.ceil(g.clientHeight / px), c = $('bg');
  const now = ilNow(), wet = isWet(wx.code), snow = isSnow(wx.code), rain = $('rain'), fall = wet || snow;
  bgs.min = Math.floor(Date.now() / 60000); followSun();
  rain.hidden = !fall;
  const lean = snow ? 0 : windLean(wind.speed, wind.dir);
  if (fall) { rain.style.backgroundImage = `url(${tile(snow, lean)})`; rain.className = 'rain' + (snow ? ' snow' : '') + (wx.code >= 95 ? ' storm' : '') + (lean ? ` lean${lean > 0 ? 'r' : 'l'}${Math.abs(lean)}` : ''); }
  g.style.setProperty('--fly', phase(now.t, wx) === 'night' ? '#f4ff8a' : '#ff8fb1'); g.querySelectorAll('.fly').forEach((/** @type {HTMLElement} */ f) => f.hidden = true);
  $('wx').textContent = 'Tel Aviv ' + now.label + (wx.ok ? ` · ${Math.round(/** @type {number} */ (wx.temp))}° · ${wxName(wx.code)}` : '');
  if (W < 1 || H < 1) return;
  bgs.wkey = worldKey();
  const key = [W, H, now.t, wx.code, wx.cloud, wx.sr, wx.ss, sky.date?.getTime(), sky.rainAt, bgs.wkey, lean, Object.values(vanePose(wind.dir)).join(':')].join();
  if (key !== bgs.key) { if (W !== bgs.W || H !== bgs.H) bgs.ev = []; bgBuild(W, H, now.t); bgs.key = key; }
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  bgs.ctx = c.getContext('2d'); bgs.flies = fireflyTime(now.t, wx.ss);
  const s = Date.now() / 1000; bgs.amb = s; bgPaint(s);
  bgKick();
}
// Open-Meteo: current weather and the last hours of rain for Tel Aviv.
export async function loadWeather() {
  if (later('weather', loadWeather)) return;
  try {
    const j = await (await fetch('https://api.open-meteo.com/v1/forecast?latitude=32.0853&longitude=34.7818&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m&hourly=precipitation&past_hours=3&forecast_hours=1&timezone=Asia%2FJerusalem&forecast_days=1')).json();
    Object.assign(wx, { code:j.current.weather_code, cloud:j.current.cloud_cover, temp:j.current.temperature_2m, ok:true });
    Object.assign(wind, { speed: j.current.wind_speed_10m ?? null, dir: j.current.wind_direction_10m ?? null });
    sky.rainAt = isWet(wx.code) ? Date.now() : Math.max(sky.rainAt, rainEnded(j.hourly?.time, j.hourly?.precipitation, j.utc_offset_seconds, Date.now()));
  } catch (e) {}
  drawGarden();
}
