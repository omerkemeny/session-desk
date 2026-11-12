// @ts-check
// Garden characters: waiting sessions stand in slots, working ones swing pickaxes at the mine, sent-home ones sleep in town.
import { $, esc, hash } from './util.js';
import { BODIES, COL, miniSheet, minerSheet, poseSheet, propSheet, rockSheet } from './sprites.js';
import { codeHtml, FISH, isAirflow, isSnow, isWet, nameOf, sayHtml, setupHint, workingCount, workingOverflow } from './logic.js';
import { freshOf, hasPr, propOf, restOf, staleOf, toolOf, troubled, waitLabel, waitedMin } from './activity.js';
import { asleep, group, needsYou, state } from './state.js';
import { every, later, onPace, pace } from './pace.js';
import { look } from './looks.js';
import { addRod } from './fishing.js';
import './crowd.js';
import { bestPlan, BY_FIRE, crowdHidden, fireFace, matesOf, MAX_STAND, mineMoreText, pickMiners, pickSpot, placeTags, shortTitle, SPOTS, tagOrder } from './garden_layout.js';
import { wx } from './backdrop.js';
import { fireOn, syncFire } from './campfire.js';
import { watchMoments } from './moments.js';

/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('./types.js').Actor} Actor */

/** Waiting characters in the garden, by session id. @type {Map<string, Actor>} */
export const actors = new Map();
/** @type {Set<string>} */
const toMine = new Set();
const WALK_EASE = 'linear', MINE_DX = 'var(--px) * -3px';
// Puts a character's feet at (x, y) in garden fractions, nudged by an optional CSS length.
/** @param {HTMLElement} el @param {number} x @param {number} y @param {string} [dx] */
const placeAt = (el, x, y, dx) => { el.style.left = dx ? `calc(${x * 100}% + ${dx})` : x * 100 + '%'; el.style.top = y * 100 + '%'; };
// Name tag text: the full title, plus its most telling words for one-line crowd tags.
/** @param {string} t */
const tagHtml = t => `<span class="tn" dir="auto">${esc(t)}</span><span class="ts" dir="auto">${esc(shortTitle(t))}</span>`;
// Hover bubble: title, latest request and last reply, then how long it has waited.
/** @param {Session} s */
const sayFor = s => sayHtml(s, s.ask) + `<i class="wt">${waitLabel(s, Date.now())}</i>`;
/** Garden width and height in px and px per sprite pixel. */
const dims = () => { const g = $('garden'); return { W: g.clientWidth, H: g.clientHeight, u: +getComputedStyle(g).getPropertyValue('--px') || 4 }; };
// Walks a character to (x, y) at a steady pace, facing the way it goes; returns the walk time in ms.
/** @param {HTMLElement} el @param {number} x @param {number} y @param {string} [dx] @param {boolean} [fade] */
function walkTo(el, x, y, dx, fade) {
  // The box jumps to the goal at once and a `translate` from the old spot back to zero carries it there, so the walk runs on the compositor.
  const g = $('garden').getBoundingClientRect(), r = el.getBoundingClientRect();
  const fx = (r.left + r.width / 2 - g.left) / g.width, ms = 2400;
  if (Math.abs(x - fx) * g.width > 4) el.classList.toggle('left', x < fx);
  el.classList.add('walking');
  el.style.transition = 'none'; el.style.translate = ''; placeAt(el, x, y, dx);
  const q = el.getBoundingClientRect(); el.style.translate = `${Math.round(r.left - q.left)}px ${Math.round(r.top - q.top)}px`; void el.offsetWidth;
  el.style.transition = `translate ${ms}ms ${WALK_EASE}` + (fade ? `, opacity 450ms linear ${ms - 450}ms` : '');
  el.style.translate = '0px 0px'; if (fade) el.style.opacity = '0';
  return ms;
}
// Per-character timing from the session id, so nobody blinks, looks or hops in unison.
/** @param {HTMLElement} el @param {string} id */
function quirks(el, id) {
  /** @param {number} k @param {number} n */
  const h = hash(id), v = (k, n) => (h >>> k) % n;
  /** @type {Record<string, number>} */
  const q = { '--d': -v(3, 97) / 10, '--t': 8 + v(9, 5), '--b': 1.5 + v(12, 6) / 10, '--h': 9 + v(15, 8), '--hd': -v(18, 90) / 10, '--q': 1.9 + v(25, 7) / 10 };
  for (const k in q) el.style.setProperty(k, q[k].toFixed(1) + 's');
  el.classList.toggle('alt', v(28, 2) === 1);
}
// One-shot arrival effect (squash, bubble pop, the fresh-wait ring), cleared once it has played.
/** @param {HTMLElement} el @param {string} cls */
function settleIn(el, cls, delay = 0, ms = cls === 'ring' ? RING_MS : 560) {
  el.style.setProperty(cls === 'ring' ? '--rd' : '--ld', delay + 'ms'); el.classList.add(cls);
  // Bubbles grow from nothing on arrival, so tags are placed again once they have their size.
  setTimeout(() => { el.classList.remove(cls); if (cls !== 'ring') layoutTags(); }, delay + ms);
}
const RING_MS = 1600;  // the one soft ring round a session that just started waiting
// Fills a waiting character's hover bubble when it opens, then keeps it inside the garden's left and right edges.
/** @param {Event} e */
function placeSay(e) {
  const el = /** @type {HTMLElement} */ (e.currentTarget), say = /** @type {HTMLElement | null} */ (el.querySelector('.say')); if (!say) return;
  const s = !el.classList.contains('miner') && state.S.find(x => x.id === el.dataset.id); if (s) { const html = sayFor(s); if (say.innerHTML !== html) say.innerHTML = html; }
  const g = $('garden').getBoundingClientRect(), r = el.getBoundingClientRect(), w = say.offsetWidth, c = r.left + r.width / 2;
  say.style.setProperty('--sx', Math.round(Math.min(Math.max(c - w / 2, g.left + 8), g.right - 8 - w) - (c - w / 2)) + 'px');
  // The full tag shown on hover or focus stays inside the garden too.
  const tag = /** @type {HTMLElement | null} */ (el.querySelector('.tag')); if (!tag || el.classList.contains('miner')) return;
  const tw = tag.offsetWidth, tb = r.bottom + tag.offsetTop - el.offsetHeight + tag.offsetHeight;
  el.style.setProperty('--hx', Math.round(Math.min(Math.max(c - tw / 2, g.left + 2), g.right - 2 - tw) - (c - tw / 2)) + 'px');
  el.style.setProperty('--hy', Math.round(Math.min(0, g.bottom - 2 - tb)) + 'px');
}
// Dresses a standing character for its session's state (bright bubble while fresh, stump and sit or nap after a long wait, muted under a blanket after a day, pennant, umbrella); true when anything changed.
/** @param {HTMLElement} el @param {Session | undefined} s */
function dress(el, s) {
  const id = el.dataset.id || '', lk = look(id), fishing = !!s && isAirflow(s) && !!FISH[/** @type {Actor} */ (actors.get(id))?.slot];
  const bye = el.classList.contains('bye'), warm = !!s && !fishing && !bye && s.status === 'waiting' && BY_FIRE.includes(/** @type {Actor} */ (actors.get(id))?.slot) && fireOn();
  const rest = s && !fishing && !bye ? restOf(s, Date.now()) || (warm ? 'sit' : '') : '', stale = !!s && rest === 'nap' && staleOf(s, Date.now()), fresh = !!s && !bye && freshOf(s, Date.now()), long = !!s && !fishing && !bye && restOf(s, Date.now()) !== '', pr = !!s && !fishing && hasPr(s), err = !!s && !bye && troubled(s), wet = !fishing && (isWet(wx.code) || isSnow(wx.code));
  if (s && !bye) {
    const label = `${nameOf(s)}: needs your answer, ${waitLabel(s, Date.now())} (${BODIES[lk.c][2]}, ${lk.hat})${stale ? ', asleep under a blanket after a day of waiting' : rest === 'nap' ? ', dozing after a long wait' : warm && restOf(s, Date.now()) === '' ? ', sitting by the fire' : rest ? ', sitting after a long wait' : ''}${pr ? ', pull request open' : ''}${err ? ', last step failed' : ''}`;
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
  }
  const sig = rest + ':' + stale + ':' + fresh + ':' + long + ':' + warm + ':' + pr + ':' + err + ':' + wet + ':' + lk.hat + lk.c;
  if (el.dataset.act === sig) return false; el.dataset.act = sig;
  el.classList.toggle('fresh', fresh); el.classList.toggle('long', long); el.classList.toggle('stale', stale);
  if (!bye) { el.classList.toggle('err', err); /** @type {HTMLElement} */ (el.querySelector('.bubble')).textContent = err ? '!' : '?'; }
  const pix = /** @type {HTMLElement} */ (el.querySelector('.pix')), fig = /** @type {HTMLElement} */ (el.querySelector('.fig'));
  pix.style.backgroundImage = `url(${poseSheet(lk.hat, lk.c, rest, warm && rest === 'sit' ? fireFace(/** @type {Actor} */ (actors.get(id)).slot) : '', stale)})`;
  el.classList.toggle('sit', !!rest); el.classList.toggle('nap', rest === 'nap');
  let seat = el.querySelector('.seat'), flag = pix.querySelector('.flag'), umb = pix.querySelector('.umb'), wrap = pix.querySelector('.blanket');
  if (rest && !seat) { seat = document.createElement('i'); seat.className = 'seat'; /** @type {HTMLElement} */ (seat).style.backgroundImage = `url(${propSheet(['stump'])})`; el.insertBefore(seat, fig); } else if (!rest && seat) seat.remove();
  if (stale && !wrap) { wrap = document.createElement('b'); wrap.className = 'blanket'; /** @type {HTMLElement} */ (wrap).style.backgroundImage = `url(${propSheet(['blanket'])})`; pix.append(wrap); } else if (!stale && wrap) wrap.remove();
  if (pr && !flag) { flag = document.createElement('b'); flag.className = 'flag'; /** @type {HTMLElement} */ (flag).style.backgroundImage = `url(${propSheet(['flag-a'], lk.c)})`; pix.append(flag); } else if (!pr && flag) flag.remove();
  if (wet && !umb) { umb = document.createElement('b'); umb.className = 'umb'; pix.append(umb); } else if (!wet && umb) umb.remove();
  if (umb) /** @type {HTMLElement} */ (umb).style.backgroundImage = `url(${propSheet(['umbrella'], lk.c)})`;
  return true;
}
// Long waits grow while nothing polls, so stand, sit and nap are re-checked every half minute.
every(30000, () => { let moved = syncFire(); for (const [id, a] of actors) if (!a.el.classList.contains('walking') && dress(a.el, state.S.find(x => x.id === id))) moved = true; if (moved) layoutTags(); regroup(); resettle(); });
// Teammates of a session among the standing characters, as [slot, weight] for pickSpot.
/** @param {Session} s */
const teamOf = s => matesOf(s, [...actors].filter(([id]) => id !== s.id).map(([id, a]) => { const o = state.S.find(x => x.id === id); return { slot: a.slot, project: o?.project, branch: o?.branch }; }));
// Hovering or focusing a character lights the ground faintly under it and its project's other characters; nothing when it has none.
/** @param {string} id @param {boolean} on */
function markTeam(id, on) {
  const p = state.S.find(x => x.id === id)?.project, team = on && p && p !== 'unknown' ? [...actors.keys()].filter(k => state.S.find(x => x.id === k)?.project === p) : [];
  for (const [k, a] of actors) a.el.classList.toggle('mate', team.length > 1 && team.includes(k));
}
/** @param {Session} s @param {boolean} [walk] @param {number} [at] spot chosen ahead for a crowd arriving together */
function enter(s, walk, at) {
  // Airflow sessions take a pond spot and fish; the others fill the meadow first, near their project's characters.
  const used = new Set([...actors.values()].map(a => a.slot)), pond = isAirflow(s), { W, H, u } = dims();
  const slot = at != null && at >= 0 && !used.has(at) ? at : pickSpot(used, pond, W, H, u, teamOf(s));
  if (slot < 0 || actors.size >= MAX_STAND) return;
  const lk = look(s.id);
  const [x, y] = SPOTS[slot], el = document.createElement('button');
  el.className = 'agent'; el.dataset.id = s.id; el.setAttribute('aria-describedby', 'say-' + s.id);
  el.setAttribute('aria-label', `${nameOf(s)}: needs your answer, ${waitLabel(s, Date.now())} (${BODIES[lk.c][2]}, ${lk.hat})`);
  el.style.zIndex = String(Math.round(y * 100)); quirks(el, s.id);
  el.innerHTML = `<span class="bubble">?</span><span class="gnd"></span><span class="fig"><i class="pix" style="background-image:url(${poseSheet(lk.hat, lk.c)})"></i></span>`
    + `<span class="tag" data-t="${esc(nameOf(s))}">${tagHtml(nameOf(s))}</span><span class="say" id="say-${esc(s.id)}">${sayFor(s)}</span>`;
  el.addEventListener('pointerenter', placeSay); el.addEventListener('focus', placeSay);
  for (const [k, on] of /** @type {Array<[string, boolean]>} */ ([['pointerenter', true], ['focus', true], ['pointerleave', false], ['blur', false]])) el.addEventListener(k, () => markTeam(s.id, on));
  actors.set(s.id, { el, slot });
  const m = miners.get(s.id);
  if (m) { m.el.remove(); miners.delete(s.id); }
  if (!pace.still && waitedMin(s, Date.now()) < 1) settleIn(el, 'ring', walk || m ? 2400 : 0);
  if ((walk || m) && !pace.still) {
    // Walk in from the left edge, or from the mine when the session just stopped working.
    const [fx, fy] = m ? MSLOTS[m.slot] : [-.08, y];
    placeAt(el, fx, fy, m ? MINE_DX : ''); $('actors').append(el);
    const ms = walkTo(el, x, y);
    setTimeout(() => { if (el.disabled) return; el.classList.remove('walking'); el.style.transition = el.style.translate = ''; settleIn(el, 'land'); dress(el, state.S.find(x => x.id === s.id)); if (pond) addRod(actors, s.id); layoutTags(); }, ms);
  } else { placeAt(el, x, y); $('actors').append(el); dress(el, s); if (!pace.still) settleIn(el, 'spawn', Math.min(slot, actors.size) * 90); if (pond) addRod(actors, s.id); }
}
/** A character leaves: to the mine when its session started working, home to town when sent home, else off the right edge. @param {string} id @param {boolean} [thanked] @param {boolean} [home] */
export function leave(id, thanked, home) {
  const a = actors.get(id); if (!a) return; actors.delete(id);
  const el = a.el, bub = /** @type {HTMLElement} */ (el.querySelector('.bubble')); el.disabled = true;
  if (a.rod) a.rod.remove();
  setTimeout(() => { regroup(); resettle(); }, 3200);
  el.classList.add('bye'); dress(el, state.S.find(x => x.id === id));
  if (pace.still) return el.remove();
  let go;
  if (home) {
    // Sent home: walk up to a house door and fade inside.
    const done = () => { el.remove(); if (arriving.delete(id)) syncTown(); };
    arriving.add(id); bub.textContent = 'z';
    go = () => setTimeout(done, walkTo(el, .18, .3, '', true) + 60);
  } else {
    const cur = state.S.find(x => x.id === id), free = new Set([...miners.values()].map(m => m.slot)), spot = MSLOTS.findIndex((_, i) => !free.has(i));
    if (cur && cur.status === 'running' && spot >= 0) {
      // Started working: walk to a free spot at the mine; the miner appears only on arrival.
      const done = () => { el.remove(); if (toMine.delete(id)) syncMine(); };
      toMine.add(id);
      go = () => setTimeout(done, walkTo(el, MSLOTS[spot][0], MSLOTS[spot][1], MINE_DX) + 60);
    } else go = () => setTimeout(() => el.remove(), walkTo(el, 1.08, SPOTS[a.slot][1]) + 60);
    bub.textContent = thanked ? '♥' : '…';
    el.classList.toggle('glad', !!thanked);
  }
  el.classList.add('bye');
  go();
}
// Sessions sent home sleep inside the town houses, top left.
/** @type {Set<string>} */
const arriving = new Set();
/** @type {HTMLElement[]} */
const snores = [];
// Sleepers stay out of sight; one z drifts from a chimney per sleeper, up to the three houses.
export function syncTown() {
  if (later('town', syncTown)) return;
  const n = state.S.filter(s => asleep(s) && !arriving.has(s.id)).length; if (!n && !snores.length) return;
  const g = $('garden'), px = +getComputedStyle(g).getPropertyValue('--px') || 4, W = Math.ceil(g.clientWidth / px), H = Math.ceil(g.clientHeight / px), hz = Math.round(H * .26);
  [[12, 9], [10, 11], [13, 8]].forEach(([w, h], i) => {
    let z = snores[i];
    if (!z) { z = snores[i] = document.createElement('i'); z.className = 'snore'; z.textContent = 'z'; z.setAttribute('aria-hidden', 'true'); z.style.animationDelay = -i * 1.2 + 's'; $('actors').append(z); }
    z.style.left = (Math.round(W * .11 + i * Math.max(15, W * .065)) + w - 3) / W * 100 + '%'; z.style.top = (hz - 4 - h) / H * 100 + '%'; z.hidden = i >= n;
  });
}
// Working sessions swing pickaxes at the mine on the right; click opens the session.
/** @type {Array<[number, number]>} */
const MSLOTS = [[.85,.5],[.92,.6],[.85,.72],[.92,.8],[.85,.9]];
/** Miners at the mine, by session id. @type {Map<string, Actor>} */
const miners = new Map();
let mineDrawn = false, gardenDrawn = false;
export function syncMine() {
  if (later('mine', syncMine)) return;
  const fresh = !mineDrawn; mineDrawn = true;
  const working = state.S.filter(s => group(s) === 'running'), free = working.filter(s => !toMine.has(s.id));
  const ids = new Set(pickMiners(free, new Set(miners.keys()), Math.max(0, MSLOTS.length - toMine.size))), want = free.filter(s => ids.has(s.id));
  for (const [id, m] of [...miners]) if (!ids.has(id)) { m.el.remove(); miners.delete(id); }
  for (const s of want) {
    if (miners.has(s.id)) { const m = /** @type {Actor} */ (miners.get(s.id)).el; /** @type {HTMLElement} */ (m.querySelector('.say')).innerHTML = sayHtml(s, s.last); /** @type {HTMLElement} */ (m.querySelector('.tag')).textContent = nameOf(s); equip(m, s); continue; }
    const used = new Set([...miners.values()].map(m => m.slot)), slot = MSLOTS.findIndex((_, i) => !used.has(i)); if (slot < 0) break;
    const [x, y] = MSLOTS[slot], el = document.createElement('button'), h = hash(s.id);
    el.className = 'agent miner'; el.dataset.id = s.id; el.setAttribute('aria-label', `${nameOf(s)}: working`); el.setAttribute('aria-describedby', 'say-' + s.id);
    placeAt(el, x, y); el.style.zIndex = String(Math.round(y * 100));
    el.style.setProperty('--sw', (.8 + h % 5 * .07).toFixed(2) + 's'); el.style.setProperty('--d', (-(h % 7) / 10).toFixed(1) + 's'); el.style.setProperty('--oc', h >> 4 & 1 ? '#ffd447' : '#6fe0ff');
    el.innerHTML = `<span class="gnd"></span><span class="fig"><i class="rock" style="background-image:url(${rockSheet(h >> 4 & 1 ? '#ffd447' : '#6fe0ff')})"></i><span class="sprite"></span><i class="spark"></i><i class="ore"></i></span>`
      + `<span class="tag">${esc(nameOf(s))}</span><span class="say" id="say-${esc(s.id)}">${sayHtml(s, s.last)}</span>`;
    el.addEventListener('pointerenter', placeSay); el.addEventListener('focus', placeSay);
    equip(el, s); $('actors').append(el); miners.set(s.id, { el, slot });
    if (!pace.still) settleIn(el, fresh ? 'spawn' : 'land', fresh ? 300 + slot * 90 : 0);
    layoutTags();
  }
  syncMineMore(workingCount(state.S, state.sentHome), workingOverflow(state.S, state.sentHome, MSLOTS.length));
}
// The mine's "+N": working sessions with no spot at the mine, a small plaque by the door like the sign's.
// The count comes from logic.js (the Working heading's rule), so the mine and the heading always agree.
/** @param {number} n working in all @param {number} out working with no spot at the mine */
function syncMineMore(n, out) {
  let el = /** @type {HTMLElement | null} */ (document.getElementById('minemore'));
  if (!out) { el?.remove(); return; }
  if (!el) { el = document.createElement('span'); el.id = 'minemore'; el.className = 'minemore'; el.setAttribute('role', 'img'); $('actors').append(el); }
  const t = mineMoreText(n, n - out);
  if (el.title !== t) { el.title = t; el.setAttribute('aria-label', t); el.innerHTML = `<span class="more">+${out}</span>`; }
}
// Hands a miner the tool for its work (pickaxe, mallet or gold pan) when that changes.
/** @param {HTMLElement} el @param {Session} s */
function equip(el, s) {
  const tool = toolOf(s), lk = look(s.id); if (el.dataset.tool === tool + lk.hat + lk.c) return; el.dataset.tool = tool + lk.hat + lk.c;
  /** @type {HTMLElement} */ (el.querySelector('.sprite')).style.backgroundImage = `url(${minerSheet(lk.hat, lk.c, tool)})`;
  el.classList.toggle('pan', tool === 'pan'); el.classList.toggle('hammer', tool === 'hammer');
  el.setAttribute('aria-label', `${nameOf(s)}: working${tool === 'pan' ? ', running tests' : tool === 'hammer' ? ', building' : ''}`);
}
// Running subagents: up to four minis beside their session's character, the rest as "+N".
export function syncMinis() {
  if (later('minis', syncMinis)) return;
  for (const [map, side] of /** @type {Array<[Map<string, Actor>, string]>} */ ([[actors, 'r'], [miners, 'l']])) for (const [id, a] of map) {
    const s = state.S.find(x => x.id === id), subs = (s && s.subs) || [], c = look(id).c, sig = c + subs.join('\n');
    let box = /** @type {HTMLElement | null} */ (a.el.querySelector('.minis'));
    if (!subs.length) { if (box) box.remove(); continue; }
    if (box && box.dataset.sig === sig) continue;
    if (!box) { box = document.createElement('span'); box.className = 'minis ' + side; a.el.append(box); }
    box.dataset.sig = sig;
    box.innerHTML = subs.slice(0, 4).map(d => `<i class="mini" title="${esc(d)}" style="background-image:url(${miniSheet(propOf(d), c)});animation-delay:${-(hash(d) % 5) / 10}s"></i>`).join('')
      + (subs.length > 4 ? `<b>+${subs.length - 4}</b>` : '');
  }
}
let signN = -1;
const QUIET = 'Nobody needs you. Enjoy the garden.';  // the quiet note when the setup is fine (as in index.html)
/** Keeps one character per session that needs you, the sign count and the quiet note in step with the sessions. */
export function syncGarden() {
  if (later('garden', syncGarden)) return;
  syncFire(); watchMoments(state.S);
  const want = state.S.filter(needsYou).sort((a, b) => b.updated - a.updated), ids = new Set(want.map(s => s.id)), fresh = !gardenDrawn; gardenDrawn = true;
  for (const id of [...actors.keys()]) if (!ids.has(id)) leave(id, false);
  const come = want.filter(s => !actors.has(s.id));
  // Several arriving at once (page load): place teams one after another so each settles near its own, then keep newest-first tab order.
  if (come.length > 2 && !actors.size) {
    const { W, H, u } = dims(), as = (/** @type {Session[]} */ l) => l.map(s => ({ ...s, pond: isAirflow(s) })), plan = bestPlan([as(come), as(byTeam(come))], W, H, u);
    plan.list.forEach((s, i) => enter(/** @type {Session} */ (s), !fresh, plan.slots[i])); for (const s of come) { const a = actors.get(s.id); if (a) $('actors').append(a.el); } }
  for (const s of want) {
    if (!actors.has(s.id)) { enter(s, !fresh); continue; }
    // Keep the name tag and bubble of a standing character current.
    const el = /** @type {Actor} */ (actors.get(s.id)).el, tag = /** @type {HTMLElement} */ (el.querySelector('.tag'));
    if (tag.dataset.t !== nameOf(s)) { tag.dataset.t = nameOf(s); tag.innerHTML = tagHtml(nameOf(s)); }
    if (!el.classList.contains('walking')) dress(el, s);
  }
  // Sign bumps when the count changes; the quiet note eases in once nobody waits.
  // Sessions with no room in the garden show as "+N" on the sign.
  const n = want.length, sign = $('sign'), out = want.filter(s => !actors.has(s.id)).length, key = n * 1000 + out;
  if (key !== signN) {
    sign.innerHTML = n ? `<b class="num">${n}</b> need${n === 1 ? 's' : ''} you${out ? ` <span class="more" title="${out} not drawn: no room in the garden">+${out}</span>` : ''}` : 'All quiet';
    if (signN >= 0 && !pace.still) { sign.classList.remove('bump'); void sign.offsetWidth; sign.classList.add('bump'); }
    signN = key;
  }
  // With nobody waiting, the quiet note says what is wrong with the setup when something is, else the usual line.
  const quiet = $('quiet'), hint = n ? '' : setupHint(state.health), qh = hint ? codeHtml(hint) : QUIET;
  if (quiet.innerHTML !== qh) quiet.innerHTML = qh;
  quiet.hidden = n > 0;
  if (!$('drawer').hidden) markCovered();
  settledN = Math.max(settledN, actors.size);
  layoutTags();
}
// Arrivals grouped by project, biggest team first, newest first inside a team and among loners.
/** @param {Session[]} come */
function byTeam(come) {
  /** @param {Session} s */
  const p = s => s.project && s.project !== 'unknown' ? s.project : '#' + s.id, n = new Map();
  for (const s of come) n.set(p(s), (n.get(p(s)) || 0) + 1);
  const first = new Map(); come.forEach((s, i) => { if (!first.has(p(s))) first.set(p(s), i); });
  return [...come].sort((a, b) => (n.get(p(b)) > 1 ? 1 : 0) - (n.get(p(a)) > 1 ? 1 : 0) || n.get(p(b)) - n.get(p(a)) || first.get(p(a)) - first.get(p(b)));
}
// Characters under the open sidebar hold still: CSS pauses the animations of anything marked "under".
function markCovered() {
  const d = $('drawer'), x = d && !d.hidden ? innerWidth - d.offsetWidth : Infinity;
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#actors > *'))) { const r = el.getBoundingClientRect(); el.classList.toggle('under', r.width > 0 && r.left + r.width / 2 >= x); }
}
if ($('drawer')) new MutationObserver(markCovered).observe($('drawer'), { attributes: true, attributeFilter: ['hidden'] });
let tagRaf = 0;
/** Re-places every standing character's name tag on the next frame so crowds keep tags clear of bodies and each other. */
export function layoutTags() {
  if (tagRaf) return;
  tagRaf = requestAnimationFrame(() => {
    tagRaf = 0;
    const g = $('garden').getBoundingClientRect(), box = (/** @type {Element} */ e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
    const stand = [...actors.values()].map(a => a.el).filter(el => !el.classList.contains('walking') && !el.disabled);
    const blocks = [...document.querySelectorAll('#actors .agent:not(:disabled), #actors .agent .bubble, #actors .agent .umb, #actors .minis, #actors .miner .rock, #actors .fire, #minemore, #sign, #wx')].map(box);
    const items = stand.filter(el => !el.classList.contains('fisher')).map(el => {
      const tag = /** @type {HTMLElement} */ (el.querySelector('.tag')), bub = /** @type {HTMLElement} */ (el.querySelector('.bubble')), r = el.getBoundingClientRect(), u = parseFloat(getComputedStyle(el).getPropertyValue('--u')) || 4;
      // Tag sizes on two lines and on one, measured only when its text or the font changed.
      let m = /** @type {any} */ (el)._tm; const k = tag.dataset.t + '|' + fontGen;
      if (!m || m.k !== k) {
        el.classList.remove('tag1', 'tagt'); const two = { w: tag.offsetWidth, h: tag.offsetHeight };  // tagt caps the width, so it is off while measuring
        el.classList.remove('tagr', 'tagl'); el.classList.add('tag1'); m = /** @type {any} */ (el)._tm = { k, two, one: { w: tag.offsetWidth, h: tag.offsetHeight } };
      }
      const wait = el.classList.contains('stale') ? 'stale' : el.classList.contains('long') ? 'long' : el.classList.contains('fresh') ? 'fresh' : '';
      return { id: el.dataset.id || '', x: r.left + r.width / 2, y: r.bottom + 2 * u + 2, body: box(el), top: r.top - 6 - bub.offsetHeight - 4, two: m.two, one: m.one, el, tag, wait };
    });
    // Tags are served most important wait first, so a tag with no room is a day-old wait's, never a fresh one's.
    const spots = placeTags(tagOrder(items), blocks, { l: g.left, t: g.top, r: g.right, b: g.bottom });
    for (const it of items) {
      const p = /** @type {import('./garden_layout.js').TagSpot} */ (spots.get(it.id));
      it.el.classList.toggle('tag1', p.mode !== 'two'); it.el.classList.toggle('tagoff', p.mode === 'hide'); it.el.classList.toggle('tagr', p.mode === 'r'); it.el.classList.toggle('tagl', p.mode === 'l'); it.el.classList.toggle('tagu', p.mode === 'u'); it.el.classList.toggle('tagt', !!p.tiny);
      for (const [k, v] of [['--tx', p.dx + 'px'], ['--ty', p.dy + 'px']]) if (it.el.style.getPropertyValue(k) !== v) it.el.style.setProperty(k, v);
    }
  });
}
// A character whose tag has no room walks calmly to a free spot where the modelled crowd keeps more tags readable; one at a time, never while hovered or focused.
function resettle() {
  if (pace.still || [...actors.values()].some(a => a.el.classList.contains('walking'))) return;
  const { W, H, u } = dims(), slots = [...actors.values()].map(a => a.slot), now = crowdHidden(slots, W, H, u);
  for (const [id, a] of actors) {
    if (!a.el.classList.contains('tagoff') || a.el.matches(':hover, :focus-visible') || a.el.classList.contains('fisher')) continue;
    const s = state.S.find(q => q.id === id), rest = new Set(slots.filter(j => j !== a.slot)), to = pickSpot(rest, false, W, H, u, s ? teamOf(s) : []);
    if (to < 0 || to === a.slot || to < FISH.length || crowdHidden(slots.map(j => j === a.slot ? to : j), W, H, u) >= now) continue;
    a.slot = to; const el = a.el, [x, y] = SPOTS[to];
    el.style.zIndex = String(Math.round(y * 100));
    setTimeout(() => { if (el.disabled) return; el.classList.remove('walking'); el.style.transition = el.style.translate = ''; dress(el, state.S.find(q => q.id === id)); layoutTags(); }, walkTo(el, x, y));
    return;
  }
}
// Crowd size at the last settle; when a third or more have left since, the rest walk calmly to a fresh layout's spots, one at a time.
let settledN = 0, regrouping = false;
/** Fresh spots for the standing characters as if they arrived now (anglers keep their pond spots), by id. */
function freshLayout() {
  const { W, H, u } = dims(), used = new Set(), out = new Map(), placed = /** @type {Array<{ slot: number, project?: string, branch?: string }>} */ ([]);
  const walkers = /** @type {Session[]} */ ([]);
  for (const [id, a] of actors) { const s = state.S.find(x => x.id === id); if (a.el.classList.contains('fisher') || !s) { used.add(a.slot); out.set(id, a.slot); } else walkers.push(s); }
  for (const s of byTeam(walkers.sort((p, q) => q.updated - p.updated))) {
    const to = pickSpot(used, false, W, H, u, matesOf(s, placed)); if (to < 0) return null;
    used.add(to); out.set(s.id, to); placed.push({ slot: to, project: s.project, branch: s.branch });
  }
  return out;
}
/** Starts or continues a regroup after the crowd shrank: one calm walk at a time, never while hovered or focused, never anglers, nothing under reduced motion. */
function regroup() {
  if (regrouping || pace.still || document.hidden) return;
  if (actors.size > settledN * 2 / 3 || !actors.size) { settledN = Math.max(settledN, actors.size); return; }
  const plan = freshLayout(), { W, H, u } = dims(), now = [...actors.values()].map(a => a.slot);
  if (!plan || crowdHidden([...plan.values()], W, H, u) > crowdHidden(now, W, H, u)) { settledN = actors.size; return; }
  regrouping = true;
  const step = () => {
    if ([...actors.values()].some(a => a.el.classList.contains('walking'))) return setTimeout(step, 1000);
    const taken = new Set([...actors.values()].map(a => a.slot));
    const next = pace.still || document.hidden ? null : [...actors].find(([id, a]) => plan.has(id) && plan.get(id) !== a.slot && !taken.has(/** @type {number} */ (plan.get(id))) && !a.el.classList.contains('fisher') && !a.el.matches(':hover, :focus-visible'));
    if (!next) { regrouping = false; settledN = actors.size; return; }
    const [id, a] = next, to = /** @type {number} */ (plan.get(id)), [x, y] = SPOTS[to], el = a.el;
    a.slot = to; el.style.zIndex = String(Math.round(y * 100));
    const ms = walkTo(el, x, y);
    setTimeout(() => { if (!el.disabled) { el.classList.remove('walking'); el.style.transition = el.style.translate = ''; dress(el, state.S.find(q => q.id === id)); layoutTags(); } setTimeout(step, 700); }, ms);
  };
  step();
}
let fitT = 0, fontGen = 0;
document.fonts?.ready.then(() => { fontGen++; layoutTags(); });
document.fonts?.addEventListener('loadingdone', () => { fontGen++; layoutTags(); });
new ResizeObserver(() => { layoutTags(); clearTimeout(fitT); fitT = setTimeout(resettle, 1500); }).observe($('garden'));
