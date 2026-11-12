// @ts-check
// Working and Resting lists (keyed rows patched in place) and the header summary.
import { $, esc, fmt, LATE, rel } from './util.js';
import { bareLabel, bareTitle, codeHtml, DOCTOR_LINE, rowChipsHtml as chipsHtml, gardenOverflow, setupNotes, workingCount, isAuto, keyAction, LABEL, markHits, matches, nameOf, plain, rowTip, shownRows, tally } from './logic.js';
import { group, isReduced, state } from './state.js';
import { actors } from './actors.js';
import { sprite } from './looks.js';

/** @typedef {import('./types.js').Session} Session */

/** One row with search hits marked; previews are plain text; badges sit after the title; a bare title ("(session)", id prefix) gives its line to project and branch; hover shows the whole title, how long it waits and the latest request. @param {Session} s @param {string} q */
function rowHtml(s, q) {
  const g = group(s), tip = rowTip(s, Date.now()), chips = chipsHtml(s), bare = bareTitle(s) && !!s.project;
  const title = bare ? `${markHits(s.project, q)} · <span class="mono">${markHits(s.branch || '-', q)}</span>` : markHits(nameOf(s), q);
  const sub = bare ? `<span class="mono">${markHits(bareLabel(s), q)}</span>` : `${markHits(s.project, q)} · <span class="mono">${markHits(s.branch || '-', q)}</span>`;
  return `<button class="row ${g}${isAuto(s) ? ' auto' : ''}" data-id="${esc(s.id)}" title="${esc(tip)}">${sprite(s.id)}<span style="min-width:0">
    <span class="tl"><span class="title">${title}</span><span class="chips">${chips}</span></span>
    <span class="sub" style="display:block">${sub} · <span class="ago" data-t="${Number(s.updated) || 0}">${rel(s.updated)}</span></span>
    <span class="last" style="display:block">${markHits(plain(s.last || s.ask || ''), q)}</span></span></button>`;
}
// Keyed list state: column skeleton, live row elements by id, last query seen, first-draw flag, automated runs unfolded (per browser), long lists unfolded by column (this page only).
/** @type {{ cols: Record<string, any> | null, rows: Map<string, any>, q: string | null, drawn: boolean, tpl: HTMLTemplateElement, open: boolean, all: Record<string, boolean> }} */
const lfx = { cols:null, rows:new Map(), q:null, drawn:false, tpl:document.createElement('template'), open:false, all:{ running:false, resting:false } };
try { lfx.open = localStorage.getItem('autoRunsOpen') === '1'; } catch (e) {}
const CAP = 30; // rows drawn per list part while searching; search finds the rest
const FEW = 12; // newest Resting rows shown before "Show N more"
/** Newest rows a column shows before its "Show N more" line: Working 30 (CAP), Resting 12 (FEW). @param {string} g */
const fewOf = g => g === 'resting' ? FEW : CAP;
/** @param {string} html @returns {any} */
const rowEl = html => { lfx.tpl.innerHTML = html; const el = /** @type {any} */ (lfx.tpl.content.firstElementChild); el._html = html; return el; };
// Move a node with a plain insert; the focused one with moveBefore so it keeps focus, its children redrawn since moveBefore can keep their old column's styles.
/** @param {any} box @param {Element} el @param {Node | null} ref */
const moveRow = (box, el, ref) => {
  if (box.moveBefore && el.isConnected && el === document.activeElement) try { box.moveBefore(el, ref); el.replaceChildren(...[...el.childNodes].map(n => n.cloneNode(true))); return; } catch (e) {}
  box.insertBefore(el, ref);
};
// Two columns built once, so later renders patch rows instead of replacing them.
function listCols() {
  if (lfx.cols) return lfx.cols;
  lfx.cols = {}; $('lists').textContent = '';
  for (const [g, empty] of [['running', 'No agent is working right now.'], ['resting', 'No finished session here.']]) {
    const c = document.createElement('div'); c.className = 'col';
    c.innerHTML = `<h3>${LABEL[/** @type {'running' | 'resting'} */ (g)]} <span class="num"></span></h3><div class="rows" hidden><div class="more" hidden></div><button type="button" class="fold showmore" aria-expanded="false" hidden></button>`
      + `<button type="button" class="fold" aria-expanded="false" hidden></button><div class="more auto" hidden></div></div><div class="none" hidden></div>`;
    $('lists').append(c);
    const fold = c.querySelector('.fold:not(.showmore)'); fold.addEventListener('click', () => { lfx.open = !lfx.open; try { localStorage.setItem('autoRunsOpen', lfx.open ? '1' : '0'); } catch (e) {} renderLists(); });
    const all = c.querySelector('.showmore'); all.addEventListener('click', () => { lfx.all[g] = !lfx.all[g]; renderLists(); if (lfx.all[g]) { const r = c.querySelectorAll('.rows > .row:not(.gone):not(.auto)')[fewOf(g)]; if (r) r.focus(); } });
    lfx.cols[g] = { h3:c.firstChild, n:c.querySelector('.num'), rows:c.querySelector('.rows'), more:c.querySelector('.more'), all, fold:c.querySelector('.fold:not(.showmore)'), amore:c.querySelector('.more.auto'), none:c.querySelector('.none'), empty };
  }
  return lfx.cols;
}
// Patch a kept row from fresh markup, typing in changed text; true when it switched column.
/** @param {any} el @param {string} html @param {boolean} anim */
function patchRow(el, html, anim) {
  if (el._html === html) return false;
  const n = rowEl(html), moved = el.className !== n.className; el._html = html; el.className = n.className; el.title = n.title;
  const a = el.querySelector('.sprite'), b = n.querySelector('.sprite');
  if (a.getAttribute('style') !== b.getAttribute('style')) a.setAttribute('style', b.getAttribute('style'));
  for (const k of ['.title', '.chips', '.sub', '.last']) {
    const x = el.querySelector(k), y = n.querySelector(k); if (x.innerHTML === y.innerHTML) continue;
    x.innerHTML = y.innerHTML;
    if (anim && k !== '.sub' && k !== '.chips' && x.textContent) x.animate([{ clipPath:'inset(0 100% 0 0)' }, { clipPath:'inset(0 0 0 0)' }], { duration:420, easing:'steps(14, end)' });
  }
  return moved;
}
// Keyed render: rows patch in place, new ones slide in, gone ones fade, moves glide (FLIP), focus kept; search edits apply at once.
export function renderLists() {
  const st = state.st;
  /** @param {Session} s */
  const q = st.q.trim(), hit = s => matches(s, q);
  const C = listCols(), setup = setupNotes(state.health, state.S.length), motion = !isReduced() && !document.hidden && (lfx.q === null || lfx.q === st.q), anim = motion && lfx.drawn;
  /** @type {Record<string, Session[]>} */
  const want = {}, keep = new Set();
  for (const g in C) want[g] = state.S.filter(s => group(s) === g && hit(s)).sort((a, b) => b.updated - a.updated);
  // Resting splits into rows you started and automated runs, folded away unless opened or searched for.
  const auto = want.resting.filter(isAuto), autoShown = !!auto.length && (lfx.open || !!q);
  want.resting = want.resting.filter(s => !isAuto(s));
  /** @type {Record<string, number>} */
  const lim = {}; for (const g in C) lim[g] = shownRows(want[g].length, { q:!!q, open:lfx.all[g], few:fewOf(g), cap:CAP });
  for (const g in C) want[g].slice(0, lim[g]).forEach(s => keep.add(s.id));
  if (autoShown) auto.slice(0, CAP).forEach(s => keep.add(s.id));
  /** @type {any} */
  const act = document.activeElement;
  const kbd = !!(act && act.matches && act.matches('.row:focus-visible')), old = new Map(), out = [];
  /** @type {any} */
  let refocus = null;
  if (anim) for (const el of [...lfx.rows.values(), ...Object.values(C).map(c => c.h3)]) old.set(el, el.getBoundingClientRect());
  for (const [id, el] of lfx.rows) if (!keep.has(id)) {
    if (el === act && kbd) refocus = [el.parentNode, [...el.parentNode.querySelectorAll(':scope > .row:not(.gone)')].indexOf(el)];
    out.push([el, el.offsetLeft, el.offsetTop, el.offsetWidth]); lfx.rows.delete(id); old.delete(el);
  }
  for (const el of old.keys()) for (const a of el.getAnimations()) if (a.id === 'flip') a.cancel();
  for (const [el, x, y, w] of out) {
    if (!anim) { el.remove(); continue; }
    el.classList.add('gone'); el.inert = true; el.style.cssText += `;position:absolute;left:${x}px;top:${y}px;width:${w}px`; el.parentNode.append(el);
    el.animate([{ opacity:1 }, { opacity:0, transform:'translateX(-10px)' }], { duration:200, easing:'steps(4, end)', fill:'forwards' }).onfinish = () => el.remove();
  }
  /** @type {any[]} */
  const added = [], moved = [];
  for (const g in C) {
    const c = C[g], r = want[g], a = g === 'resting' ? auto : [], seq = [];
    c.rows.hidden = !r.length && !a.length; c.none.hidden = !c.rows.hidden; rollNum(c.n, g === 'running' && !q ? workingCount(state.S, state.sentHome) : r.length, String, motion);
    // With nothing listed and a setup problem, the Working column says what is wrong and how to check it.
    const none = q ? esc(`No match for “${q}”.`) : g === 'running' && setup.empty ? `<span class="setup-why">${codeHtml(setup.empty)}</span><span class="setup-how">${codeHtml(DOCTOR_LINE)}</span>` : esc(c.empty);
    if (c.none.dataset.h !== none) { c.none.dataset.h = none; c.none.innerHTML = none; c.none.classList.toggle('setup', !q && g === 'running' && !!setup.empty); }
    /** @param {Session} s */
    const put = s => { const html = rowHtml(s, q); let el = lfx.rows.get(s.id);
      if (!el) { lfx.rows.set(s.id, el = rowEl(html)); added.push(el); } else if (patchRow(el, html, anim)) moved.push(el);
      seq.push(el); };
    r.slice(0, lim[g]).forEach(put);
    const left = r.length - lim[g], few = !q && r.length > fewOf(g);
    c.more.hidden = !left || few; if (left && !few) c.more.textContent = `and ${left} more. ${q ? 'Add a word to narrow the search.' : 'Search to find them.'}`;
    seq.push(c.more);
    // Long lists: newest rows first, one quiet line unfolds the rest in place; searching always looks through all.
    c.all.hidden = !few;
    if (few) { const t = lfx.all[g] ? `▴ Show the newest ${fewOf(g)} only` : `▾ Show ${left} more`; if (c.all.textContent !== t) c.all.textContent = t; c.all.setAttribute('aria-expanded', String(lfx.all[g])); }
    seq.push(c.all);
    // One quiet line folds the automated runs; it opens in place and stays open in this browser.
    c.fold.hidden = !a.length;
    if (a.length) {
      const t = `${autoShown ? '▾' : '▸'} ${a.length} automated run${a.length === 1 ? '' : 's'}${q ? ' match' + (a.length === 1 ? 'es' : '') : ''}`;
      if (c.fold.textContent !== t) c.fold.textContent = t;
      c.fold.setAttribute('aria-expanded', String(autoShown)); c.fold.disabled = !!q;
      c.fold.title = q ? 'Shown while you search' : autoShown ? 'Fold automated runs away' : 'Runs started by hooks or scripts, not typed by you';
    }
    seq.push(c.fold);
    if (autoShown) a.slice(0, CAP).forEach(put);
    c.amore.hidden = !autoShown || a.length <= CAP; if (autoShown && a.length > CAP) c.amore.textContent = `and ${a.length - CAP} more automated runs. Search to find them.`;
    seq.push(c.amore);
    let ref = c.rows.firstChild;
    for (const el of seq) { if (el === ref) ref = el.nextSibling; else moveRow(c.rows, el, ref); }
  }
  if (anim) {
    const soft = getComputedStyle($('lists')).getPropertyValue('--accent-soft').trim() || '#fbe6dc';
    /** @param {any} el */
    const flash = el => el.animate([{ backgroundColor:soft }, { backgroundColor:getComputedStyle(el).backgroundColor }], { duration:900, easing:'steps(5, end)' });
    for (const [el, r] of old) {
      if (!el.isConnected || !el.offsetParent) continue;
      const n = el.getBoundingClientRect(), dx = r.left - n.left, dy = r.top - n.top;
      if (Math.abs(dx) + Math.abs(dy) < .5) continue;
      const a = el.animate([{ transform:`translate(${dx}px, ${dy}px)` }, { transform:'none' }], { id:'flip', duration:320, easing:'cubic-bezier(.2, .8, .2, 1)' });
      if (moved.includes(el)) { el.style.position = 'relative'; el.style.zIndex = 2; a.onfinish = a.oncancel = () => { if (!el.classList.contains('gone')) el.style.position = el.style.zIndex = ''; }; }
    }
    for (const el of added) { el.animate([{ opacity:0, transform:'translateX(-14px)' }, { opacity:1, transform:'translateX(3px)', offset:.7 }, { opacity:1, transform:'none' }], { duration:260, easing:'ease-out' }); flash(el); }
    moved.forEach(flash);
  } else if (motion && !lfx.drawn) added.forEach((el, i) => el.animate([{ opacity:0, transform:'translateY(6px)' }, { opacity:1, transform:'none' }], { duration:240, delay:Math.min(i, 12) * 35, easing:'cubic-bezier(.2, .8, .2, 1)', fill:'backwards' }));
  if (refocus) { const live = refocus[0].querySelectorAll(':scope > .row:not(.gone)'), t = live[Math.min(refocus[1], live.length - 1)]; if (t) t.focus({ preventScroll:true }); }
  else if (act && act !== document.activeElement && act.isConnected && !act.inert) act.focus({ preventScroll:true });
  lfx.drawn = true; lfx.q = st.q;
  renderHits(q, want, autoShown ? auto.length : 0);
}
// Quiet line under the search box when sessions are listed but the CLI cannot run: terminals and quick replies are off, and why.
export function renderSetup() {
  const el = $('setup'); if (!el) return;
  const t = setupNotes(state.health, state.S.length).cliOff, html = t ? `${codeHtml(t)} ${codeHtml(DOCTOR_LINE)}` : '';
  if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; el.hidden = !html; }
}
// Under the search box: how many rows match (automated ones said apart) and garden sessions that match; without a query, sessions that need you but found no garden spot.
/** @param {string} q @param {Record<string, Session[]>} want @param {number} autoN */
function renderHits(q, want, autoN) {
  const el = $('hits'); if (!el) return;
  /** @param {Session[]} g @param {string} q */
  const btns = (g, q) => g.slice(0, 3).map(s => `<button type="button" class="ghit" data-id="${esc(s.id)}" title="${esc(rowTip(s, Date.now()))}">${markHits(nameOf(s), q)}</button>`).join(' ') + (g.length > 3 ? ` and ${g.length - 3} more` : '');
  const n = (want.running || []).length + (want.resting || []).length + autoN;
  let html = '';
  if (q) { const g = state.S.filter(s => group(s) === 'waiting' && matches(s, q)); html = `${n} match${n === 1 ? '' : 'es'} below${autoN ? ` (${autoN} automated)` : ''}` + (g.length ? ` · in the garden: ${btns(g, q)}` : ''); }
  else { const o = gardenOverflow(state.S, state.sentHome, actors); if (o.length) html = `<span class="over">${o.length} more need${o.length === 1 ? 's' : ''} you, no room in the garden:</span> ${btns(o, '')}`; }
  if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; el.hidden = !html; }
}
// List keys: / jumps to search, j/k (or arrows on a row) step through rows in page order, ArrowDown or Esc leaves the search box.
export function initListKeys() {
  document.addEventListener('keydown', e => {
    const a = /** @type {HTMLElement | null} */ (document.activeElement), search = $('search');
    const typing = !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
    const overlay = !!state.st.open || !!document.querySelector('.us:not([hidden])');
    const act = keyAction({ key:e.key, ctrl:e.ctrlKey, meta:e.metaKey, alt:e.altKey }, { typing, search:a === search, empty:!search.value, overlay, onRow:!!a && a.matches('.lists .row') });
    if (!act) return;
    e.preventDefault();
    if (act === 'search') { search.focus(); search.select(); return; }
    if (act === 'blur') { search.blur(); return; }
    const rows = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.lists .row:not(.gone)')]), i = a ? rows.indexOf(a) : -1;
    const t = act === 'down' ? rows[i < 0 ? 0 : Math.min(i + 1, rows.length - 1)] : rows[i < 0 ? 0 : Math.max(i - 1, 0)];
    if (t) { t.focus(); t.scrollIntoView({ block:'nearest' }); }
  });
}
// Final number first, then a count from the old value as decoration; a late frame (throttled page) ends the count at the final value.
/** @param {any} el @param {number} to @param {(n: number) => string} [f] */
function rollNum(el, to, f = String, motion = !isReduced() && !document.hidden) {
  if (el._to === to && el.textContent) return;
  const from = el._to ?? 0; el._to = to; cancelAnimationFrame(el._raf); el.textContent = f(to);
  if (!motion || from === to) return;
  let prev = performance.now(); const t0 = prev;
  /** @param {number} now */
  const step = now => {
    let k = Math.max(0, Math.min(1, (now - t0) / 450)); if (now - prev > LATE) k = 1; prev = now;
    el.textContent = f(k < 1 ? Math.round(from + (to - from) * (1 - (1 - k) ** 3)) : to); if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
  el.animate([{ transform:'translateY(-3px)' }, { transform:'none' }], { duration:240, easing:'steps(3, end)' });
}
/** Header line: needs you (same rule as the garden sign), working, resting rows listed, automated runs folded away, tokens. */
export function renderSum() {
  const c = tally(state.S, state.sentHome), el = $('sum');
  // Each number stays with its word; lines break only at the separators.
  if (!el.firstChild) el.innerHTML = `<span class="sg"><b class="num"></b> need you</span>&nbsp;· <span class="sg"><span class="num"></span> working</span>&nbsp;· <span class="sg"><span class="num"></span> resting</span><span class="sum-auto" hidden>&nbsp;· <span class="sg"><span class="num"></span> automated</span></span>&nbsp;· <span class="sg"><span class="num"></span> tokens</span>`;
  const [w, r, z, a, t] = el.querySelectorAll('.num');
  rollNum(w, c.need); rollNum(r, c.working); rollNum(z, c.resting); rollNum(a, c.auto); rollNum(t, c.tokens, fmt);
  el.querySelector('.sum-auto').hidden = !c.auto;
}
// "x min ago" texts: each row's time is rewritten only when its words change, so a still page does no work.
export function tickAgo() {
  for (const el of lfx.rows.values()) { const a = el.querySelector('.ago'); if (!a) continue; const t = rel(+a.dataset.t); if (a.textContent !== t) a.textContent = t; }
}
