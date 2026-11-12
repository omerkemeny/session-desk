// @ts-check
// Boot: wires the modules together, handles page-wide clicks and keys, polls the local server or plays the demo.
import { $ } from './util.js';
import { BODIES } from './sprites.js';
import { REAL, key, state } from './state.js';
import { look, syncLooks } from './looks.js';
import { listDrift, pageTitle, setupOf, syncLineHtml as syncHtml, tally, waitingNews } from './logic.js';
import { ilDay } from './world_time.js';
import { drawGarden, loadWeather } from './backdrop.js';
import { initRods, reel } from './fishing.js';
import { leave, syncGarden, syncMine, syncMinis, syncTown } from './actors.js';
import { initListKeys, renderLists, renderSetup, renderSum, tickAgo } from './lists.js';
import { clearDraft, closeDrawer, drawDrawer, findStats, headHtml, initDrawer, loadFull, openDrawer, termHere } from './drawer.js';
import { drop, focusTerm, post } from './terminal.js';
import { announce, toast } from './toast.js';
import { initStats, streakNow } from './stats.js';
import { setStreak } from './world_data.js';
import { demoSetup, EXAMPLE } from './demo.js';
import { codeMoved, createFeed, HEALTH_EVERY, healthDue, patchList, versionsOf } from './feed.js';

/** @typedef {import('./types.js').Session} Session */

const { st, sentHome } = state;

// Sessions that waited at the last redraw (null before the first): a session that starts waiting is announced once.
/** @type {Set<string> | null} */
let waited = null;
/** Redraw everything from state.S; say politely who started waiting and keep the waiting count in the tab title. */
function renderAll() {
  syncLooks(); renderSum(); syncGarden(); syncMine(); syncMinis(); syncTown(); renderLists(); renderSetup(); st.first = false;
  const news = waitingNews(waited, state.S); waited = news.ids; if (news.text) announce(news.text);
  const t = pageTitle(tally(state.S, sentHome).need); if (document.title !== t) document.title = t;
}

// Demo only: answer sends the agent back to work and out of the garden.
/** @param {Session} s @param {string} text */
function answer(s, text) {
  if (!text.trim()) return toast('Type a reply first');
  clearDraft(s.id); s.tl = [.../** @type {any[]} */ (s.tl), ['claude', s.ask], ['you', text.trim()]]; s.status = 'running'; s.last = 'Back to work with your answer'; s.updated = Date.now();
  closeDrawer(); leave(s.id, true); renderAll(); toast('Answered. Off it goes.');
}
// Real mode: hand the reply to the local server, which continues the session through the CLI.
/** @param {Session} s @param {string} text */
async function sendReply(s, text) {
  text = text.trim(); if (!text) return toast('Type a reply first');
  $('reply').disabled = true;
  try {
    const r = await post('api/reply', { id:s.id, text });
    if (r.status === 413) throw new Error('the reply is over 100 KB. Send it in smaller parts.');
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'send failed');
    clearDraft(s.id); s.status = 'running'; s.replyError = ''; s.full = [...(s.full || []), ['you', text]];
    leave(s.id, true); renderAll(); if (st.open === s.id) drawDrawer(s); toast('Sent. Off it goes.');
  } catch (e) { if ($('reply')) $('reply').disabled = false; toast('Not sent: ' + /** @type {Error} */ (e).message); }
}

initRods();
initDrawer();
document.addEventListener('click', e => {
  const target = /** @type {HTMLElement} */ (e.target);
  if (target.id === 'shade') return closeDrawer();
  const b = /** @type {HTMLElement | null} */ (target.closest('button')); if (!b) return;
  const d = b.dataset, s = /** @type {Session} */ (state.S.find(x => x.id === st.open));
  if (d.id) openDrawer(d.id);
  else if (d.act === 'close') closeDrawer();
  else if (!s) return;  // a stale sidebar button (the drawer closing or gone) has no session to act on
  else if (d.view && d.view === st.view && d.view === 'term' && focusTerm()) return;  // the open Terminal tab: Enter or a click goes back into the terminal
  else if (d.view) { st.view = /** @type {'term' | 'log'} */ (d.view); drawDrawer(s); if (d.view === 'log') $('term').focus(); }
  else if (d.act === 'reterm') { st.fresh = s.id; st.view = 'term'; drawDrawer(s); }
  else if (d.act === 'endterm') { post('api/term/close', { id:s.id }).then(drop).catch(() => {}); st.view = 'log'; drawDrawer(s); toast('Terminal ended.'); }
  else if (d.answer) answer(s, d.answer);
  else if (d.act === 'home') { sentHome.add(key(s)); try { localStorage.setItem('sentHome', JSON.stringify([...sentHome].slice(-200))); } catch (e) {} closeDrawer(); leave(s.id, true, true); renderAll(); toast('Sent home. It sleeps in town until it needs you again.'); }
  else if (d.act === 'wake') { sentHome.delete(key(s)); try { localStorage.setItem('sentHome', JSON.stringify([...sentHome])); } catch (e) {} closeDrawer(); renderAll(); toast('Woken up. Back in the garden.'); }
  else if (d.act === 'copy') { const c = `claude --resume ${s.id}`; (navigator.clipboard ? navigator.clipboard.writeText(c) : Promise.reject()).then(() => toast('Copied: ' + c), () => toast(c)); }
});
document.addEventListener('submit', e => { e.preventDefault(); const s = state.S.find(x => x.id === st.open); if (/** @type {HTMLElement} */ (e.target).id === 'pform' && s) (REAL ? sendReply : answer)(s, $('reply').value); });
// Esc closes the topmost layer: Stats first (its own handler), then the sidebar; in the Terminal tab Esc belongs to the CLI.
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented && st.open && st.view !== 'term' && !document.querySelector('.us:not([hidden])')) closeDrawer(); });
$('search').addEventListener('input', (/** @type {any} */ e) => { st.q = e.target.value; renderLists(); });
/** @type {ReturnType<typeof setTimeout> | undefined} */
let rt; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(drawGarden, 80); }).observe($('garden'));
initStats();
/** Keep the nest on the Stats panel's day streak: ask again soon while the server counts, else every half hour. */
async function nestStreak() { const n = await streakNow(); if (n !== null) setStreak(n); setTimeout(nestStreak, n === null ? 15000 : 1800000); }
nestStreak();
initListKeys();

// Answer text of the last full sessions fetch, the IL day it was for, and each listed row's text: an unchanged answer (the safety poll on a still day) redraws nothing.
const list = { text:'', day:'', rows:/** @type {Map<string, string>} */ (new Map()) };
/** Today's date in Israel, the day the server's per-day figures use. */
const ilToday = () => ilDay(new Date()).iso;
/** Whole list from the server, or null when it is the same answer as last time. @returns {Promise<Session[] | null>} */
async function fetchAll() {
  const r = await fetch('api/sessions'); if (!r.ok) throw new Error('sessions ' + r.status);
  const txt = await r.text(); list.day = ilToday(); if (txt === list.text) return null;
  list.text = txt; const next = JSON.parse(txt); list.rows = new Map(next.map((/** @type {Session} */ s) => [s.id, JSON.stringify(s)]));
  return next;
}
/** The list patched from the partial answer for ids; undefined when a full fetch is needed, null when nothing changed. @param {string[]} ids @returns {Promise<Session[] | null | undefined>} */
async function fetchSome(ids) {
  const r = await fetch('api/sessions?ids=' + ids.map(encodeURIComponent).join(',')); if (!r.ok) return undefined;
  const ans = await r.json(), next = patchList(state.S, ans, list.day); if (!next) return undefined;
  let same = next.length === state.S.length && next.every((s, i) => s.id === state.S[i].id);
  for (const row of ans.rows) { const t = JSON.stringify(row); if (list.rows.get(row.id) !== t) { same = false; list.rows.set(row.id, t); } }
  for (const id of ans.gone) list.rows.delete(id);
  if (!same) list.text = '';  // the next full answer is compared afresh
  return same ? null : next;
}
// Field guard for the partial refresh: every DRIFT_EVERY-th whole-list poll compares the full answer with the patched list held just before. A difference counts only when the change feed does not name those rows within DRIFT_WAIT (rows that came or went: any named change, since one row entering pushes the oldest out), else the change was still on its way; each one is counted and named in one console warning (field names only).
const DRIFT_EVERY = 10;  // whole-list polls between checks
const DRIFT_WAIT = 3000;  // ms the feed has to name a differing row before it counts as drift
const drift = { polls:0, checks:0, count:0, raced:0, wait:/** @type {{ ids: Set<string>, all: boolean, moved: boolean } | null} */ (null), lastAt:0, seen:/** @type {Map<string, number>} */ (new Map()), allAt:0 };
/** @param {Session[]} held @param {Session[] | null} fresh */
function checkDrift(held, fresh) {
  drift.checks++; const d = fresh ? listDrift(held, fresh) : { fields:[], ids:[], moved:[] }; if (!d.fields.length || drift.wait) return;
  const now = Date.now(), w = drift.wait = { ids:new Set(d.ids.filter(id => !(now - (drift.seen.get(id) || 0) < DRIFT_WAIT))), all:now - drift.allAt < DRIFT_WAIT, moved:d.moved.length > 0 && now - drift.lastAt >= DRIFT_WAIT };
  setTimeout(() => { drift.wait = null; if (w.all || (!w.ids.size && !w.moved)) { drift.raced++; return; }
    drift.count++; console.warn(`Session list: the patched list differed from the full list in ${d.fields.join(', ')}.`); }, DRIFT_WAIT);
}
/** Each sessions event: rows it names shortly before or during a drift check were changes on their way, not drift. @param {{ ids: string[], all: boolean } | null} d */
function namedDuringCheck(d) {
  const now = Date.now(); drift.lastAt = now; if (!d || d.all) drift.allAt = now; else for (const id of d.ids) drift.seen.set(id, now);
  if (drift.seen.size > 500) for (const [id, t] of drift.seen) if (now - t > DRIFT_WAIT) drift.seen.delete(id);
  const w = drift.wait; if (!w) return; w.moved = false; if (!d || d.all) w.all = true; else for (const id of d.ids) w.ids.delete(id);
}
// Real mode: load sessions from the local server (ids: only those changed, else all), true on success; only the open session keeps its loaded transcript, and only until it moves on.
/** @param {string[] | null} [ids] @param {boolean} [check] compare with the patched list now (debug helper) */
async function poll(ids, check = false) {
  try {
    let next = ids && ids.length && list.day === ilToday() ? await fetchSome(ids) : undefined;
    if (next === undefined) { const held = state.S; next = await fetchAll(); if (!(ids && ids.length) && state.S === held && (check || ++drift.polls % DRIFT_EVERY === 0)) checkDrift(held, next); }
    if (!next) return true;
    const old = Object.fromEntries(state.S.map(s => [s.id, s]));
    /** @type {Session | null} */
    let moved = null;
    for (const n of next) {
      const o = old[n.id]; if (!o || o === n) continue;
      if (n.id === st.open) { n.full = o.full; n.files = o.files; }
      if ((o.updated !== n.updated || o.status !== n.status) && n.id === st.open) moved = n;
    }
    state.S = next; renderAll();
    const cur = next.find(n => n.id === st.open), line = $('sync');
    if (cur && line) { const h = syncHtml(cur, termHere(cur)); if (line.dataset.h !== h) { line.dataset.h = h; line.innerHTML = h; line.hidden = !h; } }
    if (moved) {
      if (st.view === 'term') { $('thead').innerHTML = headHtml(moved); loadFull(moved); }
      else {
        // Open session got new lines: reload it, stay at the bottom only if the reader was there.
        const t = $('term'), stick = t.scrollHeight - t.scrollTop - t.clientHeight < 80, top = t.scrollTop;
        await loadFull(moved);
        if (st.open === moved.id && st.view === 'log') {
          // Redraw keeps a half-typed reply; prompt takes focus again once the agent is done.
          const draft = $('reply') ? $('reply').value : '', typing = document.activeElement === $('reply');
          drawDrawer(moved); if (!stick) $('term').scrollTop = top;
          const box = $('reply'); if (box) { box.value = draft; if ((typing || moved.status === 'waiting') && !box.disabled) box.focus(); }
        }
      }
    }
    return true;
  } catch (e) { return false; }
}

// Console helpers for debugging, the only names this page puts on window.
/** @type {any} */ (window).desk = { st, looks: state.looks, look, BODIES, drawGarden, reel, render: renderAll,
  get S() { return state.S; }, set S(v) { state.S = v; }, get drift() { return drift.count; }, get driftChecks() { return drift.checks; }, get driftRaced() { return drift.raced; }, checkDrift: () => poll(null, true), findStats };

// Real mode: remember the code versions of the first health answer; once a later one differs, show the quiet "updated · reload" pill.
const ver = { first:/** @type {{ code: number, web: number | null } | null} */ (null), last:-Infinity, opens:0 };
/** @param {boolean} reconnect */
async function checkCode(reconnect) {
  const now = Date.now(); if (!healthDue(ver.last, now, reconnect)) return; ver.last = now;
  try { const j = await (await fetch('api/health', { cache:'no-store' })).json(), h = versionsOf(j); const was = setupKey(); state.health = j; if (setupKey() !== was) { renderSetup(); renderLists(); syncGarden(); } if (!ver.first) ver.first = h; else if (codeMoved(ver.first, h)) $('upd').hidden = false; } catch (e) {}
}
$('upd').addEventListener('click', () => location.reload());
/** The parts of the health answer the setup notices read. */
const setupKey = () => JSON.stringify(setupOf(state.health));

// Page timers that only repaint or refresh skip a hidden tab and remember they are due; showing the tab runs each once.
const due = new Set();
/** @param {() => void} fn @param {number} ms */
const whileShown = (fn, ms) => setInterval(() => { if (document.hidden) due.add(fn); else fn(); }, ms);
drawGarden(); whileShown(drawGarden, 60000); whileShown(tickAgo, 20000);
if (REAL) {
  // Change feed drives refreshes; the feed closes on pagehide so the page can enter the back-forward cache. Each feed open after the first checks for new code at once. Hidden, a change only marks a refresh due.
  const feed = createFeed({ refresh: poll, onNamed: namedDuringCheck, setMode: t => { $('mode').textContent = t; }, onOpen: () => { checkCode(ver.opens++ > 0); }, hidden: () => document.hidden });
  setInterval(() => { if (!document.hidden) checkCode(false); }, HEALTH_EVERY / 4);
  $('mode').textContent = 'loading…'; feed.start(); addEventListener('pagehide', feed.stop); addEventListener('pageshow', feed.start);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) feed.wake(); });
  loadWeather(); whileShown(loadWeather, 900000);
}
else {
  const setup = demoSetup(location.search); if (setup) state.health = setup;
  state.S = setup && (setup.setup.dataDir !== 'ok' || !setup.setup.sessions) ? [] : EXAMPLE; renderAll();
  setTimeout(() => { const s = state.S.find(x => x.id === 's3'); if (!s || s.status !== 'running') return;
    Object.assign(s, { status:'waiting', updated:Date.now(), ask:'Two components format dates in the visitor\'s locale. Keep that, or force UTC everywhere?', answers:['Keep locale','Force UTC'] });
    renderAll(); toast('An agent walked in with a question.'); }, 9000);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) return; const fns = [...due]; due.clear(); for (const fn of fns) fn(); });
