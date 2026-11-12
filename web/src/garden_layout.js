// @ts-check
// Pure garden-crowd rules: extra standing spots, spread-out slot choice, name-tag placement that avoids bodies and other tags, the camp fire.
import { FISH, SLOTS } from './logic.js';

/** @typedef {import('./types.js').Slot} Slot */
/** @typedef {{ l: number, t: number, r: number, b: number }} Box */
/** @typedef {{ id: string, x: number, y: number, body: Box, top?: number, two: { w: number, h: number }, one: { w: number, h: number } }} TagItem */
/** @typedef {{ mode: 'two' | 'one' | 'r' | 'l' | 'u' | 'hide', dx: number, dy: number, tiny?: boolean }} TagSpot */

// Open grass for extra spots: below the fence, above the bottom edge, off the pond and the mine yard, clear of the big tree.
/** @param {number} x @param {number} y */
const grass = (x, y) => y >= .44 && y <= .86 && x >= .04 && x <= .77 && !(x < .07 && y < .56) && !(x < .18 && Math.abs(y - .585) < .09) && ((x - .66) / .14) ** 2 + ((y - .715) / .22) ** 2 > 1;
const MID = [.36, .66];  // extra spots fill outward from here
// Extra meadow spots after the twelve in logic.js: a fine grid over open grass, nearest the meadow's middle first; spacing rules keep them apart.
/** @type {Slot[]} */
export const MORE = [];
for (let y = .44; y <= .861; y += .03) for (let x = .04; x <= .771; x += .015) if (grass(x, y)) MORE.push([Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
MORE.sort((a, b) => Math.hypot(a[0] - MID[0], (a[1] - MID[1]) * 1.6) - Math.hypot(b[0] - MID[0], (b[1] - MID[1]) * 1.6));
/** Every standing spot: pond spots, the original meadow spots, then the extra grid. @type {Slot[]} */
export const SPOTS = [...SLOTS, ...MORE];
export const GAP = [76, 92];  // px apart, across or down, before two bodies crowd each other
const SIDE = 116, STAG = [88, 40], STACK = 124;  // px: side by side with tags, staggered rows, or stacked so a tag fits under each
const SHIFTS = [0, -14, 14, -28, 28, -42, 42];  // px a tag may slide sideways to clear a neighbour
export const TINY = 64;  // px: the narrowest one-line tag, its last resort before hiding
const TAG_W = 84, TAG_H = 15, BUB = [26, 26];  // px: typical crowd tag, the "?" bubble, for modelling spots
export const MAX_STAND = 24;  // characters drawn in the garden at most; the rest count as "+N" on the sign
export const CROWD = 8;  // standing characters with tags before tags drop to one line
const PAD = 2;  // px of slack around boxes, for the one-pixel bob

/** True when characters at spots a and b both keep room for a one-line tag. @param {Slot} a @param {Slot} b @param {number} W @param {number} H */
export const tagSafe = (a, b, W, H) => { const dx = Math.abs(a[0] - b[0]) * W, dy = Math.abs(a[1] - b[1]) * H; return dx >= SIDE || dy >= STACK || (dx >= STAG[0] && dy >= STAG[1]); };
/** How clear spot i stands of the used spots' bodies, 1 or more when clear. @param {number} i @param {Set<number>} used @param {number} W @param {number} H */
const room = (i, used, W, H) => Math.min(Infinity, ...[...used].map(j => Math.max(Math.abs(SPOTS[i][0] - SPOTS[j][0]) * W / GAP[0], Math.abs(SPOTS[i][1] - SPOTS[j][1]) * H / GAP[1])));
/** Modelled tag item for a character standing at a spot, in px: body, the "?" bubble above it, a one-line crowd tag of width tw. @param {string} id @param {Slot} p @param {number} W @param {number} H @param {number} u @param {number} tw @returns {TagItem} */
export const modelItem = (id, p, W, H, u = 4, tw = TAG_W) => {
  const x = p[0] * W, f = p[1] * H, body = { l: x - 8 * u, t: f - 19 * u, r: x + 8 * u, b: f };
  return { id, x, y: f + 2 * u + 2, body, top: body.t - BUB[1] - 10, two: { w: tw + 24, h: 2 * TAG_H }, one: { w: tw, h: TAG_H } };
};
/** Box of the "?" bubble above a modelled item. @param {TagItem} it @returns {Box} */
const bubbleOf = it => ({ l: it.x - BUB[0] / 2, t: it.body.t - BUB[1] - 6, r: it.x + BUB[0] / 2, b: it.body.t - 6 });
/** Modelled crowd at the used spots: items with tags (pond spots fish and show none), bodies and bubbles, and where placeTags puts each tag. @param {number[]} used @param {number} W @param {number} H @param {number} u */
function crowdModel(used, W, H, u) {
  const all = used.map(j => modelItem(String(j), SPOTS[j], W, H, u)), items = all.filter((_, k) => used[k] >= FISH.length);
  const blocks = all.flatMap(it => [it.body, bubbleOf(it)]), spots = placeTags(items, blocks, { l: 0, t: 0, r: W, b: H }, true);
  return { items, blocks, spots };
}
/** Modelled crowd tags with no room, for characters at these spots in arrival order. @param {number[]} slots @param {number} W @param {number} H @param {number} [u] */
export const crowdHidden = (slots, W, H, u = 4) => [...crowdModel(slots, W, H, u).spots.values()].filter(p => p.mode === 'hide').length;
/** Tag boxes the used spots' crowd tags take now, with their bodies and bubbles. @param {number[]} used @param {number} W @param {number} H @param {number} u */
function crowdNow(used, W, H, u) {
  const { items, blocks, spots } = crowdModel(used, W, H, u);
  const tags = items.flatMap(it => { const p = /** @type {TagSpot} */ (spots.get(it.id)); const c = candidates(it, true).find(([q]) => q.mode === p.mode && q.dx === p.dx && q.dy === p.dy && !q.tiny === !p.tiny); return c ? [c[1]] : []; });
  return { blocks, tags };
}
/** Cost of a newcomer at spot i for the crowd's tags: tags its body or bubble would cover, 2 per body or bubble it would overlap, plus 1 when its own tag finds no room (pond spots need none). @param {number} i @param {{ blocks: Box[], tags: Box[] }} now @param {number} W @param {number} H @param {number} u */
function tagCost(i, now, W, H, u) {
  const it = modelItem('new', SPOTS[i], W, H, u), mine = [it.body, bubbleOf(it)], g = { l: 0, t: 0, r: W, b: H };
  const broken = now.tags.filter(t => mine.some(b => hits(t, b))).length + 2 * now.blocks.filter(b => mine.some(m => hits(m, b))).length;
  if (i < FISH.length) return broken;
  const taken = [...now.blocks, ...now.tags.filter(t => !mine.some(b => hits(t, b))), ...mine];
  const fit = candidates(it, true).findIndex(([, box]) => inside(box, g) && !taken.some(k => hits(box, k)));
  return broken + (fit < 0 ? 1 : fit > 0 ? .01 * Math.min(fit, 20) : 0);
}
export const PULL = .6;  // most a teammate's distance adds to a spot's cost: below one lost tag, above small tag shifts
/** Teammate pull at spot i, 0..PULL: px to the nearest mate spot, each [slot, weight] (1 same branch, less same project only), over the garden's diagonal. @param {number} i @param {Array<[number, number]>} mates @param {number} W @param {number} H */
export const pull = (i, mates, W, H) => mates.length ? PULL * Math.min(1, Math.min(...mates.map(([j, w]) => Math.hypot((SPOTS[i][0] - SPOTS[j][0]) * W, (SPOTS[i][1] - SPOTS[j][1]) * H) / w)) / Math.hypot(W * .75, H * .45)) : 0;
/** Teammates of a session among standing characters: [slot, weight] for each with the same project, weight 1 when the branch matches too. @param {{ project?: string, branch?: string }} s @param {Array<{ slot: number, project?: string, branch?: string }>} others */
export const matesOf = (s, others) => !s.project || s.project === 'unknown' ? [] : others.filter(o => o.project === s.project).map(o => /** @type {[number, number]} */ ([o.slot, s.branch && o.branch === s.branch ? 1 : .8]));
/** Free spot for a newcomer: pond spots for Airflow, meadow for the rest, in list order; bodies apart (a little closer once the meadow is full) and the crowd's one-line tags kept readable (fewest tags lost, no body under a bubble), then near its teammates, else the roomiest; -1 when full. @param {Set<number>} used @param {boolean} pond @param {number} W @param {number} H @param {number} [u] px per sprite pixel @param {Array<[number, number]>} [mates] teammates' [slot, weight] */
export function pickSpot(used, pond, W, H, u = 4, mates = []) {
  const free = SPOTS.map((_, i) => i).filter(i => !used.has(i)), mine = free.filter(i => (i < FISH.length) === pond), order = [...mine, ...free.filter(i => !mine.includes(i))];
  if (!order.length) return -1;
  const roomy = (/** @type {number} */ b, /** @type {number} */ i) => room(i, used, W, H) > room(b, used, W, H) + .05 ? i : b;
  let apart = order.filter(i => room(i, used, W, H) >= 1);
  if (!apart.length) apart = order.filter(i => room(i, used, W, H) >= .7);
  if (!apart.length) return order.reduce(roomy, order[0]);
  const own = apart.filter(i => (i < FISH.length) === pond), pool = own.length ? own : apart;
  if (used.size < 3 && !mates.length) return pool[0];
  const now = crowdNow([...used], W, H, u), bad = (/** @type {number} */ i) => [...used].filter(j => !tagSafe(SPOTS[i], SPOTS[j], W, H)).length;
  let best = pool[0], cost = Infinity;
  for (const i of pool) { const c = tagCost(i, now, W, H, u) + pull(i, mates, W, H) + bad(i) * (mates.length ? .03 : .001) - Math.min(room(i, used, W, H), 2) * .0001; if (c < cost - 1e-9) { cost = c; best = i; } }
  return best;
}
/** True when two boxes overlap by more than the slack (negative slack asks for a gap). @param {Box} a @param {Box} b @param {number} [pad] */
export const hits = (a, b, pad = PAD) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > pad && Math.min(a.b, b.b) - Math.max(a.t, b.t) > pad;
const TAG_GAP = -2;  // tags keep two px between each other
/** True when box b sits inside garden g with the slack to spare. @param {Box} b @param {Box} g */
const inside = (b, g) => b.l >= g.l + PAD && b.r <= g.r - PAD && b.t >= g.t + PAD && b.b <= g.b - PAD;
/** Candidate tag boxes for one character in preference order: under it on two lines (one line only in a crowd), then one line, beside its body on either side, above its bubble, then cut to TINY px under or beside it. @param {TagItem} it @param {boolean} [crowd] @returns {Array<[TagSpot, Box]>} */
export function candidates(it, crowd = false) {
  const out = /** @type {Array<[TagSpot, Box]>} */ ([]), mid = (it.body.t + it.body.b) / 2, { w, h } = it.one;
  for (const mode of /** @type {Array<'two' | 'one'>} */ (crowd ? ['one'] : ['two', 'one'])) for (const dx of SHIFTS) { const { w, h } = it[mode], x = it.x + dx; out.push([{ mode, dx, dy: 0 }, { l: x - w / 2, t: it.y, r: x + w / 2, b: it.y + h }]); }
  for (const dy of [4, -6, 14, -16]) { const t = mid - h / 2 + dy; out.push([{ mode: 'r', dx: 0, dy }, { l: it.body.r + 2, t, r: it.body.r + 2 + w, b: t + h }], [{ mode: 'l', dx: 0, dy }, { l: it.body.l - 2 - w, t, r: it.body.l - 2, b: t + h }]); }
  const up = (it.top ?? it.body.t - 32) - 6 - h;
  for (const dx of SHIFTS.slice(0, 5)) out.push([{ mode: 'u', dx, dy: Math.round(up - it.y) }, { l: it.x + dx - w / 2, t: up, r: it.x + dx + w / 2, b: up + h }]);
  for (const dy of [12, 22]) { const t = it.y + dy; out.push([{ mode: 'one', dx: 0, dy }, { l: it.x - w / 2, t, r: it.x + w / 2, b: t + h }]); }
  // Last resort: the one-line tag cut to TINY px with an ellipsis, under the body or beside it.
  const n = Math.min(w, TINY); if (n < w) {
    for (const dx of SHIFTS) out.push([{ mode: 'one', dx, dy: 0, tiny: true }, { l: it.x + dx - n / 2, t: it.y, r: it.x + dx + n / 2, b: it.y + h }]);
    for (const dy of [4, -6, 14, -16]) { const t = mid - h / 2 + dy; out.push([{ mode: 'r', dx: 0, dy, tiny: true }, { l: it.body.r + 2, t, r: it.body.r + 2 + n, b: t + h }], [{ mode: 'l', dx: 0, dy, tiny: true }, { l: it.body.l - 2 - n, t, r: it.body.l - 2, b: t + h }]); }
  }
  return out;
}
/**
 * Places name tags in priority order at the first candidate that stays inside the garden and clear of every body, bubble and earlier tag;
 * a tag with no room may move one placed neighbour to another free candidate; else hidden until hover or focus.
 * @param {TagItem[]} items @param {Box[]} blocks @param {Box} garden @param {boolean} [crowd] one-line tags (default: more than CROWD items) @returns {Map<string, TagSpot>}
 */
export function placeTags(items, blocks, garden, crowd = items.length > CROWD) {
  /** @type {Map<string, [TagSpot, Box]>} */
  const got = new Map(), cand = new Map(items.map(it => [it.id, candidates(it, crowd).filter(([, b]) => inside(b, garden) && !blocks.some(k => hits(b, k, 0)))]));
  const free = (/** @type {Box} */ b, /** @type {string} */ skip = '') => ![...got].some(([id, [, t]]) => id !== skip && hits(b, t, TAG_GAP));
  for (const it of items) {
    const mine = /** @type {Array<[TagSpot, Box]>} */ (cand.get(it.id)), hit = mine.find(([, b]) => free(b));
    if (hit) { got.set(it.id, hit); continue; }
    // One repair step: a candidate blocked by a single placed tag that can move elsewhere.
    for (const c of mine) {
      const by = [...got].filter(([, [, t]]) => hits(c[1], t, TAG_GAP)); if (by.length !== 1) continue;
      const [oid] = by[0], alt = /** @type {Array<[TagSpot, Box]>} */ (cand.get(oid)).find(([, b]) => !hits(b, c[1], TAG_GAP) && free(b, oid));
      if (alt) { got.set(oid, alt); got.set(it.id, c); break; }
    }
  }
  return new Map(items.map(it => [it.id, got.get(it.id)?.[0] || { mode: 'hide', dx: 0, dy: 0 }]));
}
const FILLER = new Set('a an the to for in of on with and or from into by at as up out via per vs is be it its this that my our new some all'.split(' '));  // words a short tag drops first
const VERBS = /^(add|adds|fix|fixes|update|upgrade|bump|write|draft|investigate|clean|rename|speed|port|profile|tidy|migrate|make|create|remove|delete|refactor|implement|check|review|improve|explain|support|handle|set|use|move|debug|run|build|try|help|get|find|look|change|replace|convert|backfill|split|merge|drop|allow|enable|disable|show|hide|keep|let|ensure|prepare|plan|work)$/i;  // generic task verbs, dropped when nouns remain
const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;  // ticket ids such as ABC-1234
export const SHORT = 16;  // characters in a crowd tag
/** Most telling words of a title within max characters, in title order: ticket ids, then names with digits, underscores, dots or capitals inside, then other nouns; filler and a leading task verb go first; a telling word too long to fit is cut with an ellipsis. @param {string} title @param {number} [max] */
export function shortTitle(title, max = SHORT) {
  const t = String(title || '').replace(/\s+/g, ' ').trim(); if (t.length <= max) return t;
  // Words with a following bare number joined ("Node 24", "Airflow 3"); trailing punctuation trimmed.
  const words = /** @type {string[]} */ ([]);
  for (const w of t.split(' ').map(w => w.replace(/^[({["'`]+|[)}\]"'`,.:;!?]+$/g, '')).filter(w => /[\p{L}\p{N}]/u.test(w))) if (/^v?\d+(\.\d+)*$/.test(w) && words.length && !FILLER.has(words[words.length - 1].toLowerCase())) words[words.length - 1] += ' ' + w; else words.push(w);
  const cut = (/** @type {string} */ w) => [...w].slice(0, max - 1).join('') + '…';
  if (!words.length) return cut(t);
  const rank = (/** @type {string} */ w) => TICKET.test(w) ? 0 : /^[A-Z]{2,}s?$/.test(w) ? 1.5 : /[\d_./#]|[a-z][A-Z]/.test(w) ? 1 : FILLER.has(w.toLowerCase()) ? 4 : VERBS.test(w) ? 3 : 2;
  const order = words.map((w, i) => /** @type {[string, number, number]} */ ([w, i, rank(w)])).sort((a, b) => a[2] - b[2] || a[1] - b[1]), keep = new Set();
  let len = -1;
  for (const [w, i, r] of order) { if (r >= 3 && keep.size) break; if (len + 1 + w.length <= max) { keep.add(i); len += 1 + w.length; } else if (r >= 2 && keep.size) break; else if (r <= 1 && !keep.size) return cut(w); }
  if (!keep.size) return cut(order[0][0]);
  return words.filter((_, i) => keep.has(i)).join(' ');
}
// Camp fire in the meadow between the two left spots: x as a garden fraction plus px; y of its base.
export const FIRE = { x: .135, dx: 0, y: .575 };
/** Spots beside the fire, whose characters sit facing it while it burns. */
export const BY_FIRE = [7, 11];
/** Fire burns at dusk and night in dry weather. @param {string} sky dawn, day, dusk or night @param {boolean} wet rain or snow falling */
export const fireLit = (sky, wet) => !wet && (sky === 'dusk' || sky === 'night');
/** Eyes of a character sitting by the fire at spot i, turned toward it without mirroring: look-left right of the fire, look-right left of it. @param {number} i */
export const fireFace = i => SPOTS[i] ? (SPOTS[i][0] < FIRE.x ? 'look-right' : 'look-left') : '';
/** Spots for a crowd arriving together in this order, each chosen as pickSpot would with the earlier ones standing (teammates pull). @param {Array<{ pond: boolean, project?: string, branch?: string }>} list @param {number} W @param {number} H @param {number} [u] */
export function planSpots(list, W, H, u = 4) {
  const used = new Set(), placed = /** @type {Array<{ slot: number, project?: string, branch?: string }>} */ ([]);
  return list.map(s => { const slot = pickSpot(used, s.pond, W, H, u, matesOf(s, placed)); if (slot >= 0) { used.add(slot); placed.push({ slot, project: s.project, branch: s.branch }); } return slot; });
}
/** Characters whose nearest neighbour is a teammate, for spots in list order. @param {Array<{ project?: string }>} list @param {number[]} slots @param {number} W @param {number} H */
export function matesNear(list, slots, W, H) {
  const d = (/** @type {number} */ i, /** @type {number} */ j) => Math.hypot((SPOTS[slots[i]][0] - SPOTS[slots[j]][0]) * W, (SPOTS[slots[i]][1] - SPOTS[slots[j]][1]) * H);
  return list.filter((s, i) => { if (slots[i] < 0 || !s.project || s.project === 'unknown') return false; let best = -1; slots.forEach((q, j) => { if (j !== i && q >= 0 && (best < 0 || d(i, j) < d(i, best))) best = j; }); return best >= 0 && list[best].project === s.project; }).length;
}
/** Of several arrival orders, the first plan unless a later one loses fewer modelled tags, or loses none and puts more characters next to a teammate. @param {Array<Array<{ pond: boolean, project?: string, branch?: string }>>} orders @param {number} W @param {number} H @param {number} [u] */
export function bestPlan(orders, W, H, u = 4) {
  let best = null, key = [Infinity, -Infinity];
  for (const list of orders) { const slots = planSpots(list, W, H, u), k = [crowdHidden(slots.filter(i => i >= 0), W, H, u), matesNear(list, slots, W, H)]; if (k[0] < key[0] || (k[0] === key[0] && !k[0] && k[1] > key[1])) { best = { list, slots }; key = k; } }
  return /** @type {{ list: Array<{ pond: boolean, project?: string, branch?: string }>, slots: number[] }} */ (best);
}
export const MINE_SPOTS = 5; // miners drawn at the mine at most; the rest count as "+N" at the mine door
/** Ids of the working sessions drawn at the mine, at most n: a drawn one keeps its spot while it works (no reshuffle on a poll), free spots go first to sessions with running subagents (most work in flight), then to the most recently active. @param {Array<{ id: string, updated: number, subs?: string[] }>} working @param {Set<string>} drawn @param {number} [n] @returns {string[]} */
export function pickMiners(working, drawn, n = MINE_SPOTS) {
  const keep = working.filter(s => drawn.has(s.id)).slice(0, n), subs = (/** @type {{ subs?: string[] }} */ s) => (s.subs && s.subs.length ? 1 : 0);
  const rest = working.filter(s => !drawn.has(s.id)).sort((a, b) => subs(b) - subs(a) || b.updated - a.updated || (a.id < b.id ? -1 : 1));
  return [...keep, ...rest].slice(0, n).map(s => s.id);
}
/** Words for the mine's "+N" mark: working sessions in all and how many are not drawn. @param {number} working @param {number} drawn */
export const mineMoreText = (working, drawn) => `${working} working, ${working - drawn} not drawn: the mine has room for ${MINE_SPOTS}`;
/** Wait states from most to least important for a name tag: fresh, normal, long, day-old (the salience order). */
export const TAG_RANK = ['fresh', '', 'long', 'stale'];
/** Items in the order placeTags should serve them: by wait state (TAG_RANK), stable inside a state, so a tag that finds no room is the least important one, never a fresh wait's. @template {{ wait?: string }} T @param {T[]} items @returns {T[]} */
export const tagOrder = items => items.map((it, i) => /** @type {[T, number]} */ ([it, i])).sort(([a, i], [b, j]) => (TAG_RANK.indexOf(a.wait || '') - TAG_RANK.indexOf(b.wait || '')) || i - j).map(([it]) => it);
