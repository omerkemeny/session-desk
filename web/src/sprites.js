// @ts-check
// Pixel sprites read from the art files in web/art/ (bundled into art.generated.js); sheet builders return cached data URLs (canvas only when called).
import { ART_TEXT } from './art.generated.js';

/** @typedef {{hex: string, role: string, note: string}} Swatch */
/** @typedef {{size: number[] | null, fit: number[] | null, palette: Record<string, Swatch> | null, colours: Array<{name: string, values: Record<string, string>}>, frames: Record<string, string[]>}} ArtFile */

// Parses one art file: optional size/fit lines, then [palette], [colours] and [frame NAME] sections (format in web/art/README.md).
/** @param {string} text @param {string} [file] @returns {ArtFile} */
export function parseArt(text, file = 'art') {
  /** @type {ArtFile} */
  const a = { size: null, fit: null, palette: null, colours: [], frames: {} };
  let sec = '', /** @type {string[]} */ cur = [];
  text.split('\n').forEach((raw, i) => {
    const s = raw.trim(), at = `${file}:${i + 1}`;
    if (!s || s[0] === '#') return;
    const m = /^\[(palette|colours|frame\s+(\S+))\]$/.exec(s);
    if (m) {
      sec = m[2] ? 'frame' : m[1];
      if (m[2]) { if (a.frames[m[2]]) throw new Error(`${at}: frame ${m[2]} defined twice`); cur = a.frames[m[2]] = []; } else if (sec === 'palette') a.palette = {};
      return;
    }
    if (!sec) {
      const d = /^(size|fit)\s+(\d+)x(\d+)$/.exec(s); if (!d) throw new Error(`${at}: expected "size WxH", "fit WxH" or a [section]`);
      a[/** @type {'size' | 'fit'} */ (d[1])] = [+d[2], +d[3]]; return;
    }
    if (sec === 'palette') {
      const p = /^([^\s.#[])\s+(#[0-9a-fA-F]{6})(?:\s+@(\w+))?(?:\s+(.*))?$/.exec(s); if (!p) throw new Error(`${at}: expected "letter #rrggbb [@role] [note]"`);
      /** @type {Record<string, Swatch>} */ (a.palette)[p[1]] = { hex: p[2], role: p[3] || '', note: p[4] || '' }; return;
    }
    if (sec === 'colours') {
      const [name, ...kv] = s.split(/\s+/), /** @type {Record<string, string>} */ values = {};
      for (const t of kv) { const q = /^(\w+)=(#[0-9a-fA-F]{6})$/.exec(t); if (!q) throw new Error(`${at}: expected "name role=#rrggbb ..."`); values[q[1]] = q[2]; }
      a.colours.push({ name, values }); return;
    }
    if (/\s/.test(s)) throw new Error(`${at}: a grid row cannot contain spaces`);
    cur.push(s);
  });
  return a;
}

/** Every art file, parsed, by name without .txt. @type {Record<string, ArtFile>} */
export const ART = Object.fromEntries(Object.entries(ART_TEXT).map(([f, t]) => [f.replace(/\.txt$/, ''), parseArt(t, f)]));
/** Resolves once the art is loaded; the art is bundled, so it already has. */
export const ready = Promise.resolve();
const SHARED = /** @type {Record<string, Swatch>} */ (ART.palette.palette);
/** Palette a file paints with: its own, else the shared palette.txt. @param {ArtFile} f */
export const paletteOf = f => f.palette || SHARED;
/** Colour of letter ch; a @role letter takes its colour from the colour set when it names that role. @param {Record<string, Swatch>} pal @param {string} ch @param {Record<string, string>} [set] */
export const colourOf = (pal, ch, set) => { const p = pal[ch]; return (p.role && set && set[p.role]) || p.hex; };

/** Shared palette, letter to colour. @type {Record<string, string>} */
export const COL = Object.fromEntries(Object.entries(SHARED).map(([k, p]) => [k, p.hex]));
// Body colours a session can wear: main, shade, name.
export const BODIES = ART.body.colours.map(c => [c.values.body, c.values.shade, c.name]);
export const BODY = ART.body.frames.stand;
export const LEGS = ['stand', 'step', 'step2'].map(k => ART.legs.frames[k]);
/** @type {Record<string, string[]>} */
export const HATS = { ...ART.hats.frames };
/** Hat names a session can wear, in a fixed order. */
export const HN = Object.keys(HATS);
HATS.none = [];  // bare head for subagent minis; not an outfit
/** Garden pose sheet frames in order (the CSS picks them by index): label, body frame, legs frame. */
export const POSES = [['stand', 'stand', 'stand'], ['step', 'stand', 'step'], ['blink', 'shut', 'stand'], ['look right', 'look-right', 'stand'], ['look left', 'look-left', 'stand'],
  ['wave', 'wave', 'stand'], ['cheer', 'cheer', 'step'], ['step two', 'stand', 'step2'], ['glad', 'glad', 'stand'], ['glad step', 'glad', 'step']];
/** Miner sheet frames: pickaxe frame, body frame, legs frame. */
export const MINER = [['raise', 'look-right', 'stand'], ['strike', 'shut', 'step']];
/** Miner frames per tool: pickaxe digs, mallet for builds, gold pan shakes for tests. @type {Record<string, string[][]>} */
export const TOOLS = { pick: MINER, hammer: [['hammer-up', 'look-right', 'stand'], ['hammer-down', 'shut', 'step']], pan: [['pan-a', 'look-right', 'stand'], ['pan-b', 'look-right', 'stand']] };
/** Props a subagent mini can hold, in props.txt. */
export const PROPS = ['lens', 'paper', 'crate'];
const rc = ART.rod.colours[0].values, rf = ART.rod.frames;
/** Fishing rod colours and its float, reel and "!" grids (letters from COL). */
export const ROD = { pole: [rc.pole, rc.pole2], node: rc.node, grip: [rc.grip, rc.grip2], tip: rc.tip, line: rc.line, ring: rc.ring, drop: rc.drop, float: rf.float, reel: rf.reel, bang: rf.bang };

// New canvas of w x h with its 2D context.
/** @param {number} w @param {number} h @returns {[HTMLCanvasElement, CanvasRenderingContext2D]} */
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'))]; }
// Paints a letter grid at (ox, oy), one 1x1 rect per non-'.' letter in colour col(letter).
/** @param {CanvasRenderingContext2D} x @param {string[]} rows @param {number} ox @param {number} oy @param {(ch: string) => string} col */
function paint(x, rows, ox, oy, col) { rows.forEach((row, y) => [...row].forEach((ch, i) => { if (ch !== '.') { x.fillStyle = col(ch); x.fillRect(ox + i, oy + y, 1, 1); } })); }
export const MUTE = .5;  // share of slate-grey mixed into a stale character's body colour; .5 keeps every pair of body colours apart (web/tests/salience.mjs identity)
export const SLATE_TINT = .3;  // how far that grey leans toward the blanket's slate (palette v), at the same lightness
/** Hex colour hx mixed MUTE of the way to a slate-leaning grey of its own lightness, so hue order survives. @param {string} hx */
export const muteHex = hx => { const n = [1, 3, 5].map(i => parseInt(hx.slice(i, i + 2), 16)), sl = [1, 3, 5].map(i => parseInt(SHARED.v.hex.slice(i, i + 2), 16)), lum = (/** @type {number[]} */ q) => q[0] * .3 + q[1] * .59 + q[2] * .11, y = lum(n), k = y / lum(sl);
  return '#' + n.map((q, i) => Math.round(q + (Math.min(255, sl[i] * k) * SLATE_TINT + y * (1 - SLATE_TINT) - q) * MUTE).toString(16).padStart(2, '0')).join(''); };
/** Body colour set c, its body and shade muted (muteHex) for a day-old wait. @param {number} [c] @param {boolean} [muted] */
const setOf = (c, muted) => { const v = ART.body.colours[c || 0].values; return muted ? { ...v, body: muteHex(v.body), shade: muteHex(v.shade) } : v; };
/** Colour of one letter for body colour c, muted for a stale wait. @param {number} [c] @param {boolean} [muted] */
const tone = (c, muted) => (/** @type {string} */ ch) => colourOf(SHARED, ch, setOf(c, muted));
// Paints one 16x15 frame (hat, body, legs) at column ox; a muted body keeps its hat in full colour.
/** @param {CanvasRenderingContext2D} x @param {string} h @param {string} body body frame name @param {string} legs legs frame name @param {number} ox @param {number} [c] @param {boolean} [muted] */
function paintFrame(x, h, body, legs, ox, c, muted) {
  paint(x, [...Array(5 - HATS[h].length).fill('................'), ...HATS[h]], ox, 0, tone(c));
  paint(x, [...ART.body.frames[body], ...ART.legs.frames[legs]], ox, 5, tone(c, muted));
}
/** @type {Record<string, string>} */
const sheets = {};
// Two-frame sprite sheet (stand, step) for one hat, as a data URL.
/** @param {string} h @param {string} [asleep] '' awake, 'glad' happy arcs, anything else eyes shut @param {number} [bc] */
export function sheet(h, asleep, bc = 0) {
  const k = h + ':' + (asleep || '') + ':' + bc; if (sheets[k]) return sheets[k];
  const body = asleep === 'glad' ? 'glad' : asleep ? 'shut' : 'stand', [c, x] = canvas(32, 15);
  ['stand', 'step'].forEach((legs, f) => paintFrame(x, h, body, legs, f * 16, bc));
  return sheets[k] = c.toDataURL();
}
// Garden poses for one hat, in POSES order; rest 'sit' dangles the feet, 'nap' also shuts the eyes of the resting frame; face sets the resting frame's eyes (look-left, look-right); muted greys the body of a day-old wait.
/** @param {string} h @param {number} [bc] @param {'' | 'sit' | 'nap'} [rest] @param {string} [face] @param {boolean} [muted] */
export function poseSheet(h, bc = 0, rest = '', face = '', muted = false) {
  const k = h + ':pose:' + bc + (rest ? ':' + rest : '') + (face ? ':' + face : '') + (muted ? ':muted' : ''); if (sheets[k]) return sheets[k];
  const [c, x] = canvas(16 * POSES.length, 15);
  POSES.forEach(([, body, legs], n) => paintFrame(x, h, rest === 'nap' && !n ? 'shut' : face && !n ? face : body, rest ? 'sit' : legs, n * 16, bc, muted));
  return sheets[k] = c.toDataURL();
}
// Two-frame sheet for a working agent in its own hat and colour, holding its tool (TOOLS): raised, then struck.
/** @param {string} h @param {number} [c] @param {string} [tool] */
export function minerSheet(h, c = 0, tool = 'pick') {
  const k = h + ':mine:' + c + (tool === 'pick' ? '' : ':' + tool); if (sheets[k]) return sheets[k];
  const w = ART.miner.frames.raise[0].length, [cv, x] = canvas(2 * w, 15);
  TOOLS[tool].forEach(([pick, body, legs], f) => { paintFrame(x, h, body, legs, f * w, c); paint(x, ART.miner.frames[pick], f * w, 0, tone(c)); });
  return sheets[k] = cv.toDataURL();
}
// Two-frame hatless mini stepping in place with a prop from props.txt.
/** @param {string} prop @param {number} [c] */
export function miniSheet(prop, c = 0) {
  const k = 'mini:' + prop + ':' + c; if (sheets[k]) return sheets[k];
  const [cv, x] = canvas(32, 15);
  ['stand', 'step'].forEach((legs, f) => { paintFrame(x, 'none', 'glad', legs, f * 16, c); paint(x, ART.props.frames[prop], f * 16, 0, tone(c)); });
  return sheets[k] = cv.toDataURL();
}
// Frames of props.txt side by side in one sheet (all the same size), as a data URL; body-colour letters in body colour c.
/** @param {string[]} names @param {number} [c] */
export function propSheet(names, c) {
  const k = 'props:' + names.join(',') + (c ? ':' + c : ''); if (sheets[k]) return sheets[k];
  const f = ART.props.frames, w = f[names[0]][0].length, [cv, x] = canvas(w * names.length, f[names[0]].length);
  names.forEach((n, i) => paint(x, f[n], i * w, 0, tone(c)));
  return sheets[k] = cv.toDataURL();
}
/** @type {Record<string, string>} */
const rocks = {};
// Two-frame ore boulder for a miner to work on, its ore crystals in colour ore.
/** @param {string} ore */
export function rockSheet(ore) {
  if (rocks[ore]) return rocks[ore];
  const { glint, sparkle } = ART.rock.frames, w = glint[0].length, [c, x] = canvas(2 * w, glint.length), pal = paletteOf(ART.rock);
  [glint, sparkle].forEach((rows, f) => paint(x, rows, f * w, 0, ch => colourOf(pal, ch, { ore })));
  return rocks[ore] = c.toDataURL();
}
/** @type {Record<string, Array<[number, number, string]>>} */
const fishUrl = {};
// Fish pixels [x, y, colour] in one of four colours, head to the right; frame 1 flicks the tail.
/** @param {number} n @param {number} [fr] */
export function fishSprite(n, fr = 0) {
  const k = n + ':' + fr; if (fishUrl[k]) return fishUrl[k];
  const set = ART.fish.colours[n].values, pal = paletteOf(ART.fish), p = /** @type {Array<[number, number, string]>} */ ([]);
  ART.fish.frames[fr ? 'flick' : 'swim'].forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') p.push([x, y, colourOf(pal, ch, set)]); }));
  return fishUrl[k] = p;
}
