// @ts-check
// Session drawer: the whole session as a terminal transcript (or the live terminal), with a reply box and actions.
import { $, esc, fmt, rel } from './util.js';
import { bareLabel, bareTitle, flat, LABEL, nameOf, replyBlock, setupHint, setupOf, setupOff, replyFailure, rowChipsHtml as chipsHtml, syncLineHtml as syncHtml, waitedFor } from './logic.js';
import { aroundMatch, findFrom, findLabel, findMatches, findSpans, findText, findWords, firstChange, segAt, segHtml, segments, startMatch, stepMatch, viewLines } from './transcript_view.js';
import { EXAMPLE_FULL } from './demo.js';
import { toast } from './toast.js';
import { asleep, group, isReduced, needsYou, REAL, state } from './state.js';
import { sprite } from './looks.js';
import { focusTerm, killTerm, mountTerm } from './terminal.js';

/** @typedef {import('./types.js').Session} Session */

const XT_HINT = 'Live Claude CLI on this session. Approval keys, Esc and slash commands work here. F6 or Ctrl+Shift+← moves out of the terminal.';  // Terminal tab footer hint
const XT_SHORT = 'Live Claude CLI on this session. Approvals and slash commands work here.';  // the same on narrow and touch screens, where key hints are hidden
/** Narrow or touch screen: shorter footer hints, as the page hides its key hints there. */
const narrow = () => typeof matchMedia === 'function' && matchMedia('(max-width: 700px), (pointer: coarse)').matches;
const WINDOW = 400;  // newest events drawn when the tab opens
const MORE = 1000;  // events added by each "Show earlier"
// Folds and expanded lines the reader opened, by start index, for the open session only; kept across redraws while the sidebar stays open.
const folds = { id:/** @type {string | null} */ (null), open:new Set(), xp:/** @type {Set<number>} */ (new Set()) };
// Details switch: every tool result shown and nothing grouped (the CLI's ctrl+o view); remembered per browser.
const det = { on:false }; try { det.on = localStorage.getItem('transcriptDetails') === '1'; } catch (e) {}
/** View options for the transcript markup. */
const vopts = () => ({ xp:folds.xp, detail:det.on });
const FIND_GAP = 100;  // ms: the first key searches at once, keys typed faster wait for one trailing search
const PAINT_MAX = 500;  // drawn matches highlighted at most
const NEAR = 600;  // events: a match this close to a drawn part grows that part; farther away it gets a window of its own
const HALF = 150;  // events drawn on each side of a far match
const TICKS_MAX = 300;  // more drawn matches than this: no ticks beside the scrollbar
const GAP_DWELL = 250;  // ms the gap line stays in view before it draws its lines (a fling past it draws nothing)
// Find in a session: open, query, matching event indexes, current position and event, what find opened (fold "f<at>" or line "x<at>"), focus to return to, text index per event, timing for the smoke test.
const F = { open:false, q:'', words:/** @type {string[]} */ ([]), hits:/** @type {number[]} */ ([]), k:-1, cur:-1, opened:/** @type {string[]} */ ([]), back:/** @type {HTMLElement | null} */ (null),
  idx:{ id:/** @type {string | null} */ (null), ev:/** @type {any[][] | null} */ (null), texts:/** @type {string[]} */ ([]), detail:false }, timer:/** @type {ReturnType<typeof setTimeout> | 0} */ (0), last:-Infinity, runs:0, steps:0, ms:0 };
// Quick-reply drafts by session id: kept when the transcript redraws, the tab switches or the sidebar closes; cleared when the reply is sent.
const drafts = /** @type {Map<string, string>} */ (new Map());
const HL = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';  // CSS Custom Highlight API: marks words without touching the transcript's nodes
// What the Transcript tab shows now: session, events, segments, first drawn segment, footer markup.
// w: a window of events [lo, hi) drawn around a far match, apart from the newest part, with a gap line between them (null when none).
const V = { id:/** @type {string | null} */ (null), ev:/** @type {any[][]} */ ([]), segs:/** @type {import('./transcript_view.js').Seg[]} */ ([]), from:0, foot:'', detail:false, w:/** @type {{ lo: number, hi: number } | null} */ (null) };
/** Events to draw: the loaded transcript, or the example one with the pending question in demo mode. @param {Session} s @returns {any[][] | null} */
function eventsOf(s) {
  if (REAL) return s.full || null;
  const ev = s.full || /** @type {any} */ (EXAMPLE_FULL)[s.id] || flat(s.tl);
  return group(s) === 'waiting' && s.ask ? [...ev, ['claude', s.ask]] : ev;
}
/** First segment to draw so about n of the newest events show. @param {import('./transcript_view.js').Seg[]} segs @param {number} total @param {number} n */
const windowFrom = (segs, total, n) => { const k = segs.findIndex(g => g.e > total - n); return k < 0 ? segs.length : k; };
/** "Show earlier" control, or nothing when everything is drawn. */
const moreHtml = () => { const f = firstDrawn(), left = f ? viewLines(V.ev.slice(0, V.segs[f] ? V.segs[f].s : V.ev.length), V.detail) : 0; return left ? `<button type="button" class="tbtn more" data-more="1">Show earlier · about ${left.toLocaleString('en-US')} more line${left === 1 ? '' : 's'}</button>` : ''; };
/** Segments a..b (end exclusive, default the last) as markup. @param {number} a @param {number} [b] */
const segsHtml = (a, b = V.segs.length) => { const o = vopts(); let out = ''; for (let i = a; i < b; i++) out += segHtml(V.ev, V.segs[i], folds.open, o); return out; };
/** The window's segments [a, b), or null when no window is drawn. @returns {[number, number] | null} */
const win = () => V.w ? [segAt(V.segs, V.w.lo), Math.min(V.from, segAt(V.segs, V.w.hi))] : null;
/** First drawn segment: the window's when there is one, else the newest part's. */
const firstDrawn = () => { const w = win(); return w ? Math.min(w[0], V.from) : V.from; };
/** Gap line between the window and the newest part: how many lines it holds; a click or scrolling into it draws them part by part. */
const gapHtml = () => { const w = win(); if (!w) return ''; const n = viewLines(V.ev.slice(w[1] > 0 ? V.segs[w[1] - 1].e : 0, V.segs[V.from] ? V.segs[V.from].s : V.ev.length), V.detail);
  return `<button type="button" class="tbtn more gap" data-gap="1" title="Lines between this part and the newest one">Show later · about ${n.toLocaleString('en-US')} more line${n === 1 ? '' : 's'}</button>`; };
/** @param {Session} s */
function termHtml(s) {
  const ev = eventsOf(s);
  const banner = `<div class="banner"><b>✻</b> Claude Code session<br>${esc(s.project)} · ${esc(s.branch || '-')} · ${esc(s.model || '')}</div>`;
  if (folds.id !== s.id) { folds.id = s.id; folds.open.clear(); folds.xp.clear(); V.w = null; Object.assign(F, { open:false, q:'', words:[], hits:[], k:-1, cur:-1, opened:[], back:null }); }
  V.id = s.id; V.ev = ev || []; V.detail = det.on; V.segs = ev ? segments(ev, group(s) === 'running', det.on) : []; V.from = windowFrom(V.segs, V.ev.length, WINDOW);
  if (!ev) { V.w = null; return banner + `<div class="dim">${s.err ? 'Could not load this session. Check that the local server still runs.' : 'Loading whole session…'}</div>`; }
  let w = win(); if (w && (w[1] >= V.from || w[0] >= w[1])) { V.from = Math.min(V.from, w[0]); V.w = null; w = null; }
  return banner + moreHtml() + (w ? segsHtml(w[0], w[1]) + gapHtml() : '') + segsHtml(V.from);
}
/** Redraw only what changed at the end of the open transcript; false when a full draw is needed. @param {Session} s */
function patchLog(s) {
  const t = $('term'), ev = eventsOf(s);
  if (!t || !ev || V.id !== s.id || !V.ev.length || V.detail !== det.on || REAL && state.st.view !== 'log') return false;
  const d = firstChange(V.ev, ev); if (d < 0) return false;
  const segs = segments(ev, group(s) === 'running', det.on);
  let k = 0; while (k < V.segs.length && k < segs.length && V.segs[k].e <= d && V.segs[k].s === segs[k].s && V.segs[k].e === segs[k].e && V.segs[k].fold === segs[k].fold && !!V.segs[k].grp === !!segs[k].grp) k++;
  if (k < V.from) return false;
  const stick = t.scrollHeight - t.scrollTop - t.clientHeight < 80, oldLen = V.ev.length, kids = [...t.children], first = kids.length - (V.segs.length - V.from);
  if (first < 1) return false;
  for (const el of kids.slice(first + k - V.from)) el.remove();
  V.ev = ev; V.segs = segs;
  t.insertAdjacentHTML('beforeend', segsHtml(k));
  if (!isReduced()) [...t.children].slice(first + k - V.from).forEach((el, n) => { if (+(/** @type {HTMLElement} */ (el).dataset.i ?? /** @type {HTMLElement} */ (el).dataset.at ?? -1) >= oldLen) { el.classList.add('fresh'); /** @type {HTMLElement} */ (el).style.animationDelay = Math.min(n, 8) * 40 + 'ms'; } });
  if (stick) t.scrollTop = t.scrollHeight;
  if (F.open) runFind(false);
  return true;
}
/** Details switch: flip, remember, redraw the open transcript keeping the line at the top of the view in place (or the bottom when the reader was there). */
function toggleDetails() {
  det.on = !det.on; try { localStorage.setItem('transcriptDetails', det.on ? '1' : '0'); } catch (e) {}
  const s = state.S.find(x => x.id === state.st.open), t = $('term'); if (!s || !t) return;
  const stick = t.scrollHeight - t.scrollTop - t.clientHeight < 80, top = t.getBoundingClientRect().top;
  const at = /** @type {HTMLElement | undefined} */ ([...t.querySelectorAll('[data-i]')].find(el => el.getBoundingClientRect().bottom > top + 4)), key = at ? +(at.dataset.i || 0) : -1, off = at ? at.getBoundingClientRect().top - top : 0;
  drawDrawer(s); const n = $('term'); if (!n) return;
  if (!stick && key >= 0) { const el = /** @type {HTMLElement | undefined} */ ([...n.querySelectorAll('[data-i]')].find(x => +(/** @type {HTMLElement} */ (x).dataset.i || 0) >= key)); if (el) n.scrollTop += el.getBoundingClientRect().top - n.getBoundingClientRect().top - off; }
  const b = /** @type {HTMLElement | null} */ (document.querySelector('#drawer [data-details]')); if (b) b.focus();
}
/** Prepend the next older part of the transcript and keep the reader's place. */
function showEarlier() { const f = firstDrawn(); if (f > 0 && f < V.segs.length) drawFrom(windowFrom(V.segs, V.segs[f].s, MORE)); if (F.open) paintFind(); }
/** Run a change to the drawn lines without moving what the reader sees: the first line in view stays where it was. @param {HTMLElement} t @param {() => void} fn @param {Element | null} [ref] */
function keepPlace(t, fn, ref = null) {
  const top = t.getBoundingClientRect().top;
  if (!ref) for (const el of t.children) if (el.getBoundingClientRect().bottom > top) { ref = el; break; }
  const y = ref ? ref.getBoundingClientRect().top : 0; fn();
  if (ref && ref.isConnected) t.scrollTop += ref.getBoundingClientRect().top - y;
}
/** "Show earlier" again after the first drawn segment moved. @param {HTMLElement} t */
function fixMore(t) { const old = t.querySelector(':scope > .more:not(.gap)'); if (old) old.remove(); const b = t.querySelector(':scope > .banner'), next = moreHtml(); if (b && next) b.insertAdjacentHTML('afterend', next); }
/** Draw segments k up to the first drawn one above it, keeping the reader's place. @param {number} k */
function drawFrom(k) {
  const t = $('term'), first = firstDrawn(); if (!t || !V.segs.length || k >= first) return;
  const at = t.querySelector(':scope > .more:not(.gap)') || t.querySelector(':scope > .banner'); if (!at) return;
  k = Math.max(0, k);
  keepPlace(t, () => { at.insertAdjacentHTML('afterend', segsHtml(k, first)); if (V.w) V.w.lo = V.segs[k].s; else V.from = k; fixMore(t); });
}
/** Draw segments of the newest part's earlier side from k, after the gap line. @param {HTMLElement} t @param {number} k */
function growTail(t, k) {
  const gap = t.querySelector(':scope > .gap'), w = win(); if (!gap || !w || k >= V.from) return;
  k = Math.max(k, w[1]); const html = segsHtml(k, V.from);
  keepPlace(t, () => { gap.insertAdjacentHTML('afterend', html); V.from = k; joinGap(t); }, gap.nextElementSibling);
}
/** Draw the window's later side up to segment k, before the gap line. @param {HTMLElement} t @param {number} k */
function growWindow(t, k) {
  const gap = t.querySelector(':scope > .gap'), w = win(); if (!gap || !w) return;
  k = Math.min(k, V.from); if (k <= w[1]) return;
  gap.insertAdjacentHTML('beforebegin', segsHtml(w[1], k)); /** @type {{ lo: number, hi: number }} */ (V.w).hi = V.segs[k - 1].e; joinGap(t);
}
/** When the window reached the newest part they are one: the gap line goes; else its count is brought up to date. @param {HTMLElement} t */
function joinGap(t) {
  const gap = t.querySelector(':scope > .gap'), w = win(); if (!gap) return;
  if (!w || w[1] >= V.from) { if (w) V.from = Math.min(V.from, w[0]); V.w = null; gap.remove(); return; }
  const next = gapHtml(); if (gap.outerHTML !== next) gap.outerHTML = next; watchGap(t);
}
/** Draw a window of events around far match i, in place of an earlier window; a match near the newest part grows that part instead. @param {HTMLElement} t @param {number} i */
function placeWindow(t, i) {
  dropWindow(t);
  const [a, b] = aroundMatch(V.segs, i, V.from, HALF);
  if (b >= V.from) return drawFrom(a);
  const at = t.querySelector(':scope > .more:not(.gap)') || t.querySelector(':scope > .banner'); if (!at) return;
  keepPlace(t, () => { at.insertAdjacentHTML('afterend', segsHtml(a, b) + '<i hidden></i>'); V.w = { lo:V.segs[a].s, hi:V.segs[b - 1].e }; const mark = /** @type {Element} */ (t.querySelector(':scope > i[hidden]')); mark.outerHTML = gapHtml(); fixMore(t); watchGap(t); });
}
/** Remove the window and its gap line: only the newest part stays drawn. @param {HTMLElement} t */
function dropWindow(t) {
  const gap = t.querySelector(':scope > .gap'); if (!gap || !V.w) { V.w = null; return; }
  keepPlace(t, () => { for (let p = gap.previousElementSibling; p && !p.matches('.banner, .more'); p = gap.previousElementSibling) p.remove(); gap.remove(); V.w = null; fixMore(t); });
}
/** Gap line clicked or scrolled into: draw the next part toward it from the side the reader came from (from below: the newest part grows up; else the window grows down). @param {HTMLElement} t */
function fillGap(t) {
  const gap = t.querySelector(':scope > .gap'), w = win(); if (!gap || !w) return;
  const r = gap.getBoundingClientRect(), tr = t.getBoundingClientRect(), up = r.top < tr.top + tr.height / 2 && r.bottom > tr.top;
  if (up) growTail(t, segAt(V.segs, Math.max(0, (V.segs[V.from] ? V.segs[V.from].s : V.ev.length) - MORE)));
  else growWindow(t, segAt(V.segs, V.segs[w[1]].s + MORE));
  if (F.open) paintFind();
}
/** @type {IntersectionObserver | null} */
let gapSeen = null;
/** Watch the gap line: scrolling it into view draws the lines it stands for. @param {HTMLElement} t */
function watchGap(t) {
  const gap = t.querySelector(':scope > .gap'); if (!gap || typeof IntersectionObserver !== 'function') return;
  if (gapSeen) gapSeen.disconnect();
  gapSeen = new IntersectionObserver(es => { clearTimeout(gapT); if (es.some(e => e.isIntersecting)) gapT = setTimeout(() => { const g = t.querySelector(':scope > .gap'); if (e0(t) && g && inView(t, g)) fillGap(t); }, GAP_DWELL); }, { root:t });
  gapSeen.observe(gap);
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
let gapT;
/** Some of el shows inside the transcript's view. @param {HTMLElement} t @param {Element} el */
const inView = (t, el) => { const r = el.getBoundingClientRect(), tr = t.getBoundingClientRect(); return r.bottom > tr.top && r.top < tr.bottom; };
/** The observed transcript is still the drawn one. @param {HTMLElement} t */
const e0 = t => t.isConnected && $('term') === t;

/** Find bar under the header: query, count, previous and next, close. */
const findHtml = () => `<div class="tfind" id="tfind" role="search"${F.open ? '' : ' hidden'}><input id="fq" type="text" value="${esc(F.q)}" placeholder="Find in this session" aria-label="Find in this session" aria-keyshortcuts="Enter Shift+Enter Escape" autocomplete="off" spellcheck="false"><span class="fcount" id="fcount" role="status">${findLabel(F.k, F.hits.length, F.q)}</span><button type="button" class="tbtn fstep" data-fstep="-1" aria-label="Previous match" title="Previous match (Shift+Enter)">↑</button><button type="button" class="tbtn fstep" data-fstep="1" aria-label="Next match" title="Next match (Enter)">↓</button><button type="button" class="tbtn" data-fclose="1" aria-label="Close find" title="Close find (Esc)">✕</button></div>`;
/** The find text of every event of the drawn session, brought up to date from the first changed event. */
function findIndex() {
  const I = F.idx; if (I.ev === V.ev && I.id === V.id && I.detail === V.detail) return I.texts;
  const d = I.ev && I.id === V.id && I.detail === V.detail ? firstChange(I.ev, V.ev) : -1, from = d < 0 ? 0 : findFrom(V.ev, Math.min(d, I.texts.length));
  I.texts.length = from; for (let i = from; i < V.ev.length; i++) I.texts.push(findText(V.ev, i, V.detail));
  I.ev = V.ev; I.id = V.id; I.detail = V.detail; return I.texts;
}
/** Last event of the lowest transcript part in view: where a new search starts. @param {HTMLElement} t */
function viewAnchor(t) {
  const kids = t.children, b = t.getBoundingClientRect().bottom;
  for (let j = kids.length - 1; j >= 0; j--) {
    const el = /** @type {HTMLElement} */ (kids[j]), at = el.dataset.i ?? el.dataset.at; if (at == null || !(el.getBoundingClientRect().top < b)) continue;
    const m = segAt(V.segs, +at); return m < V.segs.length ? V.segs[m].e - 1 : V.ev.length;
  }
  return V.ev.length;
}
/** Search the whole session, keep the current match while it still matches, update the count; scroll moves the view to the match. @param {boolean} scroll */
function runFind(scroll) {
  const t = $('term'); if (!t || !F.open || !V.id) return;
  const t0 = performance.now(), texts = findIndex(); F.words = findWords(F.q);
  F.hits = findMatches(texts, F.words); F.k = startMatch(F.hits, F.cur >= 0 ? F.cur : viewAnchor(t)); F.cur = F.k < 0 ? -1 : F.hits[F.k];
  const c = $('fcount'); if (c) c.textContent = findLabel(F.k, F.hits.length, F.q);
  if (scroll) { if (F.cur >= 0) reveal(F.cur); else setOpened([]); }
  paintFind(); F.ms = performance.now() - t0; F.runs++;
}
/** Search now, or once at the end of a burst of keys. */
function queueFind() {
  if (F.timer) clearTimeout(F.timer);
  const go = () => { F.timer = 0; F.last = performance.now(); runFind(true); }, wait = F.last + FIND_GAP - performance.now();
  if (wait <= 0) go(); else F.timer = setTimeout(go, wait);
}
/** Enter or Shift+Enter: a pending search runs first, else the next or previous match. @param {number} dir */
function stepFind(dir) {
  if (F.timer) { clearTimeout(F.timer); F.timer = 0; runFind(true); return; }
  if (!F.hits.length) return runFind(true);
  const t0 = performance.now(); F.k = stepMatch(F.k, F.hits.length, dir); F.cur = F.hits[F.k];
  const c = $('fcount'); if (c) c.textContent = findLabel(F.k, F.hits.length, F.q);
  reveal(F.cur); paintFind(); F.ms = performance.now() - t0; F.steps++;
}
/** Open the find bar and put focus in it; the last query is searched again. */
function openFind() {
  const bar = $('tfind'), q = /** @type {HTMLInputElement | null} */ ($('fq')); if (!bar || !q) return;
  if (!F.open) { const a = /** @type {HTMLElement | null} */ (document.activeElement); F.back = a && a !== q ? a : null; F.open = true; bar.hidden = false; F.cur = -1; }
  const b = document.querySelector('#drawer [data-find]'); if (b) b.setAttribute('aria-expanded', 'true');
  q.focus(); q.select(); if (F.q) runFind(true);
}
/** Close the find bar: marks go, what find opened closes again, focus returns to where it was. @param {boolean} [focus] */
function closeFind(focus = true) {
  if (F.timer) { clearTimeout(F.timer); F.timer = 0; }
  const was = F.open; F.open = false; setOpened([]); F.hits = []; F.k = F.cur = -1; paintFind();
  const t = $('term'); if (t && V.w) { dropWindow(t); t.scrollTop = t.scrollHeight; }
  const bar = $('tfind'); if (bar) bar.hidden = true;
  const b = document.querySelector('#drawer [data-find]'); if (b) b.setAttribute('aria-expanded', 'false');
  if (!was || !focus) return;
  const back = F.back && F.back.isConnected && F.back.getClientRects().length ? F.back : $('term'); F.back = null; if (back) back.focus({ preventScroll:true });
}
/** Key of a fold or expandable line, as F.opened keeps it. @param {HTMLDetailsElement} d */
const keyOf = d => d.classList.contains('fold') ? 'f' + d.dataset.at : 'x' + d.dataset.x;
/** Open these closed folds and lines for the current match; close again what find opened for an earlier one. @param {HTMLDetailsElement[]} need */
function setOpened(need) {
  const keep = new Set(need.map(keyOf)), t = $('term');
  for (const k of F.opened) if (!keep.has(k)) {
    const n = +k.slice(1), d = /** @type {HTMLDetailsElement | null} */ (t && t.querySelector(k[0] === 'f' ? `details.fold[data-at="${n}"]` : `details.xp[data-x="${n}"]`));
    if (d) d.open = false; (k[0] === 'f' ? folds.open : folds.xp).delete(n);
  }
  F.opened = F.opened.filter(k => keep.has(k));
  for (const d of need) { d.open = true; const k = keyOf(d); if (!F.opened.includes(k)) F.opened.push(k); }
}
/** Closed folds and lines that hide this node, innermost first. @param {Node} node @param {HTMLElement} root @returns {HTMLDetailsElement[]} */
function closedAround(node, root) {
  const out = [];
  for (let p = node.nodeType === 1 ? /** @type {HTMLElement} */ (node) : node.parentElement; p && p !== root; p = p.parentElement) {
    if (p.tagName !== 'DETAILS' || /** @type {HTMLDetailsElement} */ (p).open) continue;
    const sum = p.querySelector(':scope > summary'); if (!(sum && sum.contains(node))) out.push(/** @type {HTMLDetailsElement} */ (p));
  }
  return out;
}
const BLOCK = /^(P|DIV|PRE|LI|TD|TH|H[1-6]|BLOCKQUOTE|SUMMARY|DETAILS)$/;  // elements whose text no word runs across
/** Ranges of the query words in an element's drawn text (glyphs and copy buttons left out), also across Markdown marks, in reading order; missing: words it does not show. @param {Element} el @param {string[]} words */
function markOf(el, words) {
  const nodes = /** @type {Text[]} */ ([]), parts = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode:n => n.parentElement && n.parentElement.closest('.g, .cbtn') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  /** @type {Element | null} */ let last = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    let b = n.parentElement; while (b && b !== el && !BLOCK.test(b.tagName)) b = b.parentElement;
    nodes.push(/** @type {Text} */ (n)); parts.push({ t:/** @type {Text} */ (n).data, br:b !== last }); last = b;
  }
  const { spans, missing } = findSpans(parts, words);
  return { missing, ranges:spans.map(([a, x, b, y]) => { const r = document.createRange(); r.setStart(nodes[a], x); r.setEnd(nodes[b], y); return r; }) };
}
/** Elements that draw event i (a failed call in a group is drawn twice); a group line stands for its first call by its own words. @param {HTMLElement} t @param {number} i */
const elsOf = (t, i) => [...t.querySelectorAll(`[data-i="${i}"]`)].map(x => x.classList.contains('grp') ? x.querySelector(':scope > details > summary') : x).filter(x => !!x);
/** Bring match i into view: draw earlier parts when it is above the drawn window, open the fold or line that hides it, scroll to its first word. @param {number} i */
function reveal(i) {
  const t = $('term'); if (!t || !V.segs.length) return;
  drawAround(t, i);
  /** @type {{ el: Element, r: Range | undefined, need: HTMLDetailsElement[], cost: number } | null} */ let best = null;
  for (const el of /** @type {Element[]} */ (elsOf(t, i))) {
    const r = markOf(el, F.words).ranges[0], need = closedAround(r ? r.startContainer : el, t), cost = need.length + (r ? 0 : 50) + (need.length || el.getClientRects().length ? 0 : 99);
    if (!best || cost < best.cost) best = { el, r, need, cost }; if (!cost) break;
  }
  if (!best) return;
  setOpened(best.need);
  const box = (best.r && best.r.getClientRects().length ? best.r : best.el).getBoundingClientRect(), tr = t.getBoundingClientRect();
  if (box.top < tr.top + 24 || box.bottom > tr.bottom - 24) t.scrollTop += box.top - tr.top - Math.round(t.clientHeight / 3);
}
/** Make sure event i is drawn: in the newest part or the window already, or by growing the part it is near, or in a window of its own. @param {HTMLElement} t @param {number} i */
function drawAround(t, i) {
  const m = segAt(V.segs, i); if (m >= V.segs.length || m >= V.from) return;
  const w = win(), tailS = V.segs[V.from] ? V.segs[V.from].s : V.ev.length;
  if (w && m >= w[0] && m < w[1]) return;
  if (w && i < V.segs[w[0]].s && V.segs[w[0]].s - i <= NEAR) return drawFrom(segAt(V.segs, Math.max(0, i - HALF)));
  if (w && i >= V.segs[w[1] - 1].e && i - V.segs[w[1] - 1].e <= NEAR) return growWindow(t, segAt(V.segs, i + HALF) + 1);
  if (tailS - i <= NEAR) return w ? growTail(t, segAt(V.segs, Math.max(0, i - HALF))) : drawFrom(segAt(V.segs, Math.max(0, i - HALF)));
  placeWindow(t, i);
}
/** Mark the query words in drawn matches, the current match stronger; without the highlight API the current line gets a quiet bar. */
function paintFind() {
  const t = $('term'); document.querySelectorAll('#term .fline, #term .fcur').forEach(x => x.classList.remove('fline', 'fcur'));
  const all = HL ? new Highlight() : null, cur = HL ? new Highlight() : null, ticks = /** @type {{ el: Element, cur: boolean }[]} */ ([]);
  if (t && F.open && F.hits.length && V.segs.length) {
    const want = new Set(F.hits), by = /** @type {Map<number, Element[]>} */ (new Map()); let n = 0;
    for (const x of t.querySelectorAll('[data-i]')) {
      const i = +(/** @type {HTMLElement} */ (x).dataset.i || 0); if (!want.has(i)) continue;
      const el = x.classList.contains('grp') ? x.querySelector(':scope > details > summary') : x; if (!el) continue;
      if (!by.has(i)) { if (n++ >= PAINT_MAX) break; by.set(i, []); } /** @type {Element[]} */ (by.get(i)).push(el);
    }
    for (const [i, els] of by) {
      const miss = new Set(F.words);
      for (const el of els) { const m = markOf(el, F.words); for (const r of m.ranges) (i === F.cur ? cur : all)?.add(r); for (const x of F.words) if (!m.missing.includes(x)) miss.delete(x); }
      // Found in the event's source but not in its drawn words (Markdown marks, a link's address): the whole line is marked instead, never other words.
      if (miss.size) for (const el of els) el.classList.add('fline');
      if (i === F.cur && (!HL || miss.size)) for (const el of els) el.classList.add('fcur');
      ticks.push({ el:els[0], cur:i === F.cur });
    }
  }
  if (HL) { CSS.highlights.set('desk-find', /** @type {Highlight} */ (all)); CSS.highlights.set('desk-find-cur', /** @type {Highlight} */ (cur)); }
  paintTicks(t, ticks);
}
/** Ticks beside the transcript's scrollbar for the drawn matches, the current one stronger; none for more than TICKS_MAX. @param {HTMLElement | null} t @param {{ el: Element, cur: boolean }[]} marks */
function paintTicks(t, marks) {
  const d = $('drawer'); let bar = /** @type {HTMLElement | null} */ (d && d.querySelector(':scope > .fticks'));
  if (!t || !d || !marks.length || marks.length > TICKS_MAX) { if (bar) bar.hidden = true; return; }
  if (!bar) { bar = document.createElement('div'); bar.className = 'fticks'; bar.setAttribute('aria-hidden', 'true'); d.append(bar); }
  const H = t.scrollHeight || 1, y0 = t.getBoundingClientRect().top - t.scrollTop, at = /** @type {Map<number, boolean>} */ (new Map());
  for (const { el, cur } of marks) {
    let v = /** @type {Element | null} */ (el); while (v && v !== t && !v.getClientRects().length) v = v.parentElement;
    if (!v || v === t) continue; const y = Math.round((v.getBoundingClientRect().top - y0) / H * 1000) / 10; at.set(y, (at.get(y) || false) || cur);
  }
  bar.style.top = t.offsetTop + 'px'; bar.style.height = t.clientHeight + 'px'; bar.hidden = false;
  bar.innerHTML = [...at].map(([y, c]) => `<i${c ? ' class="cur"' : ''} style="top:${y}%"></i>`).join('');
}
/** @type {number} */
let tickRaf = 0;
/** Redraw the scrollbar ticks once on the next frame (a fold opened or closed, the sidebar resized). */
function queueTicks() { if (!tickRaf) tickRaf = requestAnimationFrame(() => { tickRaf = 0; if (F.open) paintFind(); }); }
/** Put the session's draft back into a freshly drawn reply box; focus returns when the box had it. @param {Session} s @param {boolean} [focus] */
function fillReply(s, focus = false) {
  const r = /** @type {HTMLTextAreaElement | null} */ ($('reply')); if (!r || r.disabled) return;
  const d = drafts.get(s.id); if (d && !r.value) { r.value = d; fitReply(r); }
  if (focus) r.focus();
}
/** Reply box grows with its text up to six lines. @param {HTMLTextAreaElement} r */
function fitReply(r) { r.style.height = 'auto'; r.style.height = Math.min(r.scrollHeight, 6 * 20) + 'px'; r.style.overflowY = r.scrollHeight > 6 * 20 ? 'auto' : 'hidden'; }
/** Forget a session's draft once its reply was sent. @param {string} id */
export function clearDraft(id) { drafts.delete(id); }
/** Copy a code block or a whole reply to the clipboard. @param {HTMLElement} b */
function copyFrom(b) {
  const ln = /** @type {HTMLElement | null} */ (b.closest('[data-i]')), code = b.closest('.code');
  const text = b.dataset.copy === 'pre' && code ? (code.querySelector('pre') || code).textContent || '' : ln ? String(V.ev[+(ln.dataset.i || 0)]?.[1] ?? '') : '';
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => { b.textContent = 'copied'; setTimeout(() => { b.textContent = 'copy'; }, 1200); }, () => toast('Copy failed: the browser blocked the clipboard.'));
}
/** @param {Session} s */
function footHtml(s) {
  const g = group(s);
  const why = (setupOf(state.health).cli !== 'ok' ? `Quick replies are off: ${setupHint(state.health).replace(/`/g, '')} Run python3 server.py doctor to check the setup.` : '') || replyBlock(s, g, termHere(s)), fail = replyFailure(s);
  return REAL
    ? `${fail ? `<div class="needs rerr" role="status"><b>The reply could not run</b>${fail.text ? `<span class="rerr-t">${esc(fail.text)}</span>` : ''}${fail.hint ? '<span>If it needed approval, use the Terminal tab.</span>' : ''}</div>` : ''}
       <form class="prompt${why ? ' off' : ''}" id="pform"><span>&gt;</span><textarea id="reply" rows="1" ${why ? `disabled placeholder="${esc(why)}" title="${esc(why)}"` : `placeholder="${narrow() ? 'Quick reply. Approvals: Terminal tab.' : 'Quick reply. Enter sends, Shift+Enter adds a line. For approvals use the Terminal tab.'}"`} aria-label="Reply" autocomplete="off"></textarea></form>
       <div class="needs"><button type="button" class="tbtn" data-act="copy">Copy resume command</button>${g === 'waiting' ? '<button type="button" class="tbtn" data-act="home">Send home</button>' : asleep(s) ? '<button type="button" class="tbtn" data-act="wake">Wake up</button>' : ''}</div>`
    : g === 'waiting'
    ? `<div class="needs"><span class="w">● Waiting for you</span>${(s.answers || []).map(a => `<button type="button" class="tbtn" data-answer="${esc(a)}">${esc(a)}</button>`).join('')}</div>
       <form class="prompt" id="pform"><span>&gt;</span><textarea id="reply" rows="1" placeholder="Type a reply. Enter sends, Shift+Enter adds a line." aria-label="Reply" autocomplete="off"></textarea></form>`
    : `<form class="prompt"><span>&gt;</span><input disabled placeholder="${g === 'running' ? 'Agent is working. Nothing to answer.' : 'Session finished.'}" aria-label="Reply (disabled)"></form>`;
}
/** Drawer header: sprite, title with the row badges, status line with how long it waits, tabs and close button. @param {Session} s */
export function headHtml(s) {
  const st = state.st;
  /** @param {string} v @param {string} label */
  const g = group(s), files = s.files || [], n = viewLines(eventsOf(s) || [], det.on), tab = (v, label) => `<button type="button" class="tbtn tab" data-view="${v}" aria-pressed="${st.view === v}">${label}</button>`;
  const waited = waitedFor(s, Date.now()), since = waited ? new Date(Number(s.waitingSince)).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) : '', chips = chipsHtml(s);
  return `${sprite(s.id)}<div><div class="dtl"><h2 id="dtitle"${bareTitle(s) ? ` title="Session ${esc(bareLabel(s))}"` : ''}>${esc(nameOf(s))}</h2>${chips ? `<span class="chips">${chips}</span>` : ''}</div>
      <div class="tmeta"><span class="${g}">● ${LABEL[g]}</span>${waited ? `<span class="waited" title="Waiting for you since ${since}">waiting ${waited}</span>` : ''}<span class="where">${bareTitle(s) && s.project ? `session <span class="mono">${esc(bareLabel(s))}</span>` : `${esc(s.project)} · ${esc(s.branch || '-')}`}</span><span class="num">${fmt(s.tokens || 0)} tokens</span>${(s.subs || []).length ? `<span class="num">${s.subs.length} subagent${s.subs.length === 1 ? '' : 's'} working</span>` : ''}<span>${rel(s.updated)}</span>${n ? `<span class="num">${n.toLocaleString('en-US')} line${n === 1 ? '' : 's'}</span>` : ''}${files.length ? `<span class="num">${files.length} file${files.length === 1 ? '' : 's'} edited</span>` : ''}</div></div>
      <div class="tabs">${REAL ? tab('term', 'Terminal') + tab('log', 'Transcript') : ''}${!REAL || st.view === 'log' ? `<button type="button" class="tbtn fnd" data-find="1" aria-expanded="${F.open}" aria-controls="tfind" aria-keyshortcuts="/" title="Find in this session (/)">Find</button><button type="button" class="tbtn det" data-details="1" aria-pressed="${det.on}" title="${det.on ? 'Showing every tool call and result. Click for the CLI\'s default view' : 'Show every tool call and its result, like ctrl+o in the CLI'}">Details</button>` : ''}<button type="button" class="tbtn" data-act="close" id="close" aria-label="Close">✕${st.view === 'term' ? '' : '<span class="esck"> esc</span>'}</button></div>`;
}
/** This page has a terminal for the session: the server says so, or the Terminal tab is open on it and terminals can run. @param {Session} s */
export const termHere = s => !!s.term || (REAL && state.st.open === s.id && state.st.view === 'term' && !setupOff(state.health));
/** @param {Session} s */
const syncLine = s => { const h = REAL ? syncHtml(s, termHere(s)) : ''; return `<div class="needs" id="sync"${h ? '' : ' hidden'}>${h}</div>`; };
/** Draw the open session: live terminal tab or transcript tab. @param {Session} s */
export function drawDrawer(s) {
  const a = /** @type {HTMLElement | null} */ (document.activeElement), inReply = !!a && a.id === 'reply', inFind = !!a && a.id === 'fq', sel = inFind ? [/** @type {HTMLInputElement} */ (a).selectionStart, /** @type {HTMLInputElement} */ (a).selectionEnd] : null;
  if (!(REAL && state.st.view === 'term') && patchLog(s)) {
    drawerIn(); $('thead').innerHTML = headHtml(s);
    const foot = syncLine(s) + footHtml(s); if (foot !== V.foot) { V.foot = foot; $('tfoot').innerHTML = foot; fillReply(s, inReply); }
    return;
  }
  killTerm(); V.id = null;
  const live = REAL && state.st.view === 'term';
  $('drawer').innerHTML = `<div class="thead" id="thead">${headHtml(s)}</div>` + (live
    ? `<div class="xt" id="xt"></div>
       <div class="tfoot">${syncLine(s)}<div class="needs"><span id="xtnote" role="status" data-hint="${narrow() ? XT_SHORT : XT_HINT}">${narrow() ? XT_SHORT : XT_HINT}</span>${needsYou(s) ? '<button type="button" class="tbtn" data-act="home">Send home</button>' : ''}<button type="button" class="tbtn" data-act="endterm">End terminal</button></div></div>`
    : `${findHtml()}<div class="term" id="term" tabindex="0" aria-label="Session transcript" aria-keyshortcuts="j k c /" title="j and k move between messages, c copies the focused reply, / finds">${termHtml(s)}</div><div class="tfoot" id="tfoot">${V.foot = syncLine(s) + footHtml(s)}</div>`);
  if (live) mountTerm(s);
  else {
    const t = $('term'); t.scrollTop = t.scrollHeight; fillReply(s, inReply);
    if (F.open) { $('tfind').hidden = false; runFind(false); const q = /** @type {HTMLInputElement} */ ($('fq')); if (inFind && sel) { q.focus(); q.setSelectionRange(sel[0], sel[1]); } }
  }
}

/** @type {any} */
let lastFocus, opener = '';
/** @param {string} id */
export async function openDrawer(id) {
  const st = state.st;
  const s = state.S.find(x => x.id === id); if (!s) return;
  st.open = id; st.view = REAL && (needsYou(s) || s.term) ? 'term' : 'log';
  lastFocus = document.activeElement; opener = id; $('shade').hidden = $('drawer').hidden = false; document.body.style.overflow = 'hidden';
  drawDrawer(s); if (st.view === 'log') $('term').focus();
  if (REAL && !s.full) {
    await loadFull(s);
    const cur = state.S.find(x => x.id === id) || s; if (cur !== s) { cur.full = s.full; cur.files = s.files; cur.err = s.err; }
    if (st.open !== id) return;
    if (st.view === 'log') { drawDrawer(cur); $('term').focus(); } else $('thead').innerHTML = headHtml(cur);
  }
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
let shutT;
// App state closes at once (terminal, st.open, focus); the drawer and shade animate out a beat later.
export function closeDrawer() {
  const was = state.S.find(x => x.id === state.st.open); if (REAL && was) { delete was.full; delete was.files; }  // a closed session's transcript is fetched again when it reopens
  closeFind(false); killTerm(); V.id = null; state.st.open = null; document.body.style.overflow = '';
  const d = $('drawer'), sh = $('shade'); clearTimeout(shutT);
  if (isReduced() || d.hidden) sh.hidden = d.hidden = true;
  else {
    d.classList.add('closing'); sh.classList.add('closing');
    shutT = setTimeout(() => { sh.hidden = d.hidden = true; d.classList.remove('closing'); sh.classList.remove('closing'); }, 180);
  }
  // Focus goes back to what opened the sidebar, else to that session's row or character.
  const back = lastFocus && lastFocus !== document.body && lastFocus.isConnected && !lastFocus.inert && lastFocus.getClientRects().length ? lastFocus
    : document.querySelector(`.lists .row[data-id="${CSS.escape(opener)}"]:not(.gone), #actors [data-id="${CSS.escape(opener)}"]`);
  if (back) back.focus({ preventScroll:true });
  lastFocus = null;  // never keep a removed row alive
}
// Cancel a close still in flight, so a quick reopen slides in fresh.
function drawerIn() { clearTimeout(shutT); $('drawer').classList.remove('closing'); $('shade').classList.remove('closing'); }
/** On every drawer redraw: undo a pending close, blink the loading cursor; Tab stays inside the open drawer, F6 returns to the terminal; copy and "Show earlier" clicks. */
export function initDrawer() {
  $('drawer').addEventListener('toggle', e => { const d = /** @type {HTMLDetailsElement} */ (e.target); if (!d.matches) return; if (d.matches('.fold')) folds.open[d.open ? 'add' : 'delete'](+(d.dataset.at || 0)); else if (d.matches('.xp')) folds.xp[d.open ? 'add' : 'delete'](+(d.dataset.x || 0)); if (F.open) queueTicks(); }, true);
  // F6 outside the live terminal goes back into it (the terminal's own F6 leaves it).
  $('drawer').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'F6' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && state.st.view === 'term' && !/** @type {HTMLElement} */ (e.target).closest('.xt') && focusTerm()) e.preventDefault();
  });
  $('drawer').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key !== 'Tab' || e.defaultPrevented || /** @type {HTMLElement} */ (e.target).closest('.xt')) return;
    const f = /** @type {HTMLElement[]} */ ([...$('drawer').querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]).filter(x => x.offsetParent);
    const i = f.indexOf(/** @type {HTMLElement} */ (document.activeElement)), t = e.shiftKey ? (i <= 0 ? f[f.length - 1] : null) : (i === f.length - 1 ? f[0] : null);
    if (t) { e.preventDefault(); t.focus(); }
  });
  new MutationObserver(() => {
    const s = state.S.find(x => x.id === state.st.open), t = $('term'); if (!s) return;
    drawerIn(); if (!t) return;
    const wait = t.querySelector(':scope > .dim'); if (wait && !s.err) wait.classList.add('loading');
  }).observe($('drawer'), { childList:true });
  // Transcript keys: j/k step through prompts and replies, c copies the focused reply; never while typing. A focused line's copy buttons join the Tab order, others stay out of it.
  $('drawer').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    const a = /** @type {HTMLElement} */ (document.activeElement), t = $('term');
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || !t || !t.contains(a) || a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    const ln = /** @type {HTMLElement | null} */ (a.closest('.ln[tabindex]'));
    if (e.key === 'c' && ln) { const b = /** @type {HTMLElement | null} */ (ln.querySelector(':scope > .cbtn')); if (b) { e.preventDefault(); copyFrom(b); } return; }
    if (e.key !== 'j' && e.key !== 'k') return;
    e.preventDefault();
    const all = /** @type {HTMLElement[]} */ ([...t.querySelectorAll('.ln[tabindex]')]).filter(x => x.offsetParent), top = t.getBoundingClientRect().top;
    let i = ln ? all.indexOf(ln) + (e.key === 'j' ? 1 : -1) : -1;
    if (!ln) { const first = all.findIndex(x => x.getBoundingClientRect().bottom > top + 4); i = e.key === 'j' ? first : Math.max(0, first); }
    const next = all[Math.max(0, Math.min(i, all.length - 1))]; if (next) { next.focus({ preventScroll:true }); next.scrollIntoView({ block:'nearest' }); }
  });
  // Reply box: Enter sends, Shift+Enter adds a line, the box grows up to six lines; Esc with text leaves the box and keeps the text (a second Esc closes the sidebar).
  $('drawer').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    const r = /** @type {HTMLTextAreaElement} */ (e.target); if (r.id !== 'reply' || e.isComposing) return;
    if (e.key === 'Escape' && r.value) { e.preventDefault(); const t = $('term'); if (t) t.focus({ preventScroll:true }); else r.blur(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault(); const f = /** @type {HTMLFormElement | null} */ (r.form); if (f && !r.disabled) f.requestSubmit();
  });
  // Find: / in the sidebar opens it (never while typing or in the live terminal); in the box Enter is the next match, Shift+Enter the previous, Esc closes it.
  $('drawer').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    const a = /** @type {HTMLElement} */ (e.target);
    if (a.id === 'fq') {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      return;
    }
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented && $('term') && !a.closest('.xt') && !a.isContentEditable && !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { e.preventDefault(); openFind(); }
  });
  addEventListener('resize', () => { if (F.open) queueTicks(); });
  $('drawer').addEventListener('input', e => {
    const r = /** @type {HTMLTextAreaElement} */ (e.target);
    if (r.id === 'fq') { F.q = r.value; queueFind(); return; }
    if (r.id !== 'reply') return; fitReply(r); const id = state.st.open; if (id) { if (r.value) drafts.set(id, r.value); else drafts.delete(id); }
  });
  $('drawer').addEventListener('focusin', e => { const ln = /** @type {HTMLElement} */ (e.target).closest && /** @type {HTMLElement} */ (e.target).closest('.ln[tabindex]'); if (ln) ln.querySelectorAll('.cbtn').forEach(b => b.setAttribute('tabindex', '0')); });
  $('drawer').addEventListener('focusout', e => {
    const ln = /** @type {HTMLElement} */ (e.target).closest && /** @type {HTMLElement} */ (e.target).closest('.ln[tabindex]'), to = /** @type {Node | null} */ (e.relatedTarget);
    if (ln && !(to && ln.contains(to))) ln.querySelectorAll('.cbtn').forEach(b => b.setAttribute('tabindex', '-1'));
  });
  $('drawer').addEventListener('click', e => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button')); if (!b || !state.st.open) return;  // a closed sidebar's leftover buttons do nothing
    if (b.dataset.more) showEarlier(); else if (b.dataset.gap) { const t = $('term'); if (t) fillGap(t); } else if (b.dataset.copy) { e.preventDefault(); copyFrom(b); } else if (b.dataset.details) toggleDetails();
    else if (b.dataset.find) openFind(); else if (b.dataset.fstep) stepFind(+b.dataset.fstep); else if (b.dataset.fclose) closeFind();
  });
}
// Real mode: load one whole transcript from the local server.
/** @param {Session} s */
export async function loadFull(s) {
  try { const d = await (await fetch('api/session?id=' + encodeURIComponent(s.id))).json(); s.full = d.events; s.files = d.files; s.err = 0; } catch (e) { s.err = 1; }
}

/** Find state for the smoke test: runs, last search time in ms, matches, position, current event, what find holds open. */
export const findStats = () => ({ open:F.open, runs:F.runs, steps:F.steps, ms:F.ms, hits:F.hits.length, k:F.k, cur:F.cur, opened:[...F.opened], label:$('fcount') ? $('fcount').textContent : '', win:V.w ? { ...V.w } : null, from:V.segs[V.from] ? V.segs[V.from].s : V.ev.length });
