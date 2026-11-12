// @ts-check
// Session refreshes in real mode: one change feed (server-sent events) triggers fetches; a 30 s safety poll while it is healthy, the 4 s poll and backoff retries when it is not.

export const GAP = 300, SLOW = 30000, FAST = 4000, RETRY = [5000, 15000, 60000];
export const BOOT_WAIT = 1500;  // ms start waits for the feed's first change event before fetching anyway
export const MAX_IDS = 100;  // most ids one partial list request may name

/** Wait before feed retry number n (0-based): 5 s, 15 s, then 60 s for good. @param {number} n */
export const retryDelay = n => RETRY[Math.min(Math.max(n, 0), RETRY.length - 1)];
/** Safety-poll period: slow while the feed pushes, fast on the fallback. @param {boolean} live */
export const pollPeriod = live => live ? SLOW : FAST;
/** Tagline for the feed state; ok is the last fetch result, null before the first. @param {boolean} live @param {boolean | null} ok */
export const modeText = (live, ok) => ok === false ? 'offline · retrying' : ok === null ? 'loading…' : live ? 'live' : 'live · polling';
/** What a wanted fetch does: 'queue' behind the one in flight, 'none' when one is already queued or scheduled, else ms to wait before starting. @param {{ busy: boolean, queued: boolean, waiting: boolean, last: number }} f @param {number} now @returns {'queue' | 'none' | number} */
export const fetchPlan = (f, now) => f.busy ? (f.queued ? 'none' : 'queue') : f.waiting ? 'none' : Math.max(0, f.last + GAP - now);

/** Code versions in a health answer: server code, and the page files when the server sends webVersion (null when it does not). @param {any} h @returns {{ code: number, web: number | null }} */
export const versionsOf = h => ({ code: Number(h && h.codeVersion) || 0, web: h && h.webVersion != null ? Number(h.webVersion) || 0 : null });
/** The page runs old code: a later health answer's codeVersion differs from the first one, or its webVersion does when both answers have one. @param {{ code: number, web: number | null } | null} first @param {{ code: number, web: number | null } | null} now */
export const codeMoved = (first, now) => !!first && !!now && ((!!first.code && !!now.code && first.code !== now.code) || (first.web != null && now.web != null && first.web !== now.web));
export const HEALTH_EVERY = 60000;  // ms between update checks of /api/health; feed reconnects check at once
/** Whether an update check may run now: at most once per HEALTH_EVERY, a feed reconnect always. @param {number} last @param {number} now @param {boolean} reconnect */
export const healthDue = (last, now, reconnect) => reconnect || now - last >= HEALTH_EVERY;

/**
 * Feed controller; refresh() resolves true when the sessions loaded. Dependencies are injectable for tests.
 * While hidden() is true a wanted fetch is only remembered (due); wake() runs it once when the page shows again.
 * @param {{ refresh: () => Promise<boolean>, setMode: (text: string) => void, onOpen?: () => void, onNamed?: (d: { ids: string[], all: boolean } | null) => void, ES?: any, url?: string, timers?: { setTimeout: Function, clearTimeout: Function }, now?: () => number, hidden?: () => boolean }} o
 */
export function createFeed({ refresh, setMode, onOpen = () => {}, onNamed = () => {}, ES = globalThis.EventSource, url = 'api/events', timers = globalThis, now = () => Date.now(), hidden = () => false }) {
  const f = { on: false, es: /** @type {any} */ (null), live: false, ok: /** @type {boolean | null} */ (null), fails: 0,
    busy: false, queued: false, waiting: false, due: false, last: -Infinity, pollT: 0, retryT: 0, waitT: 0, bootT: 0,
    ids: /** @type {Set<string>} */ (new Set()), all: true, named: false };
  const show = () => setMode(modeText(f.live, f.ok));
  const later = (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.setTimeout(fn, ms);

  // (Re)arm the safety poll at the period for the current feed state.
  function poll() { timers.clearTimeout(f.pollT); f.pollT = later(() => { want(true); poll(); }, pollPeriod(f.live)); }
  // Ask for a fetch (all: the whole list, else the ids named so far); coalesced by fetchPlan.
  function want(all = false) {
    if (all) f.all = true;
    if (!f.on) return;
    if (hidden()) { f.due = true; return; }
    const p = fetchPlan(f, now());
    if (p === 'queue') f.queued = true;
    else if (p === 0) run();
    else if (p !== 'none') { f.waiting = true; f.waitT = later(run, p); }
  }
  // One fetch; runs the queued one afterwards.
  async function run() {
    if (hidden()) { f.waiting = false; f.due = true; return; }
    f.waiting = false; f.due = false; f.busy = true; f.queued = false; f.last = now();
    const ids = f.all ? null : [...f.ids]; f.all = false; f.ids.clear();
    let ok = false; try { ok = await refresh(ids); } catch (e) {}
    if (!ok) f.all = true;
    const back = ok && f.ok === false; f.busy = false; f.ok = ok; show();
    // Server answers again after an outage: reopen the feed now instead of waiting out the backoff.
    if (back && f.on && !f.es) { timers.clearTimeout(f.retryT); f.fails = 0; open(); }
    if (f.queued) { f.queued = false; want(); }
  }
  // Open the feed; any error closes it and hands over to drop().
  function open() {
    f.retryT = 0;
    if (!f.on || !ES) return;
    let es; try { es = new ES(url); } catch (e) { return drop(); }
    f.es = es; f.named = false;
    es.onopen = () => { if (f.es !== es) return; f.live = true; f.fails = 0; poll(); show(); try { onOpen(); } catch (e) {} };
    // A sessions event names what the next change touched; a change without one (the first on connect) or with too many ids asks for the whole list.
    es.addEventListener('sessions', (/** @type {any} */ e) => { if (f.es !== es) return; const d = sessionsEvent(e && e.data); f.named = true; onNamed(d); if (!d || d.all || f.ids.size + d.ids.length > MAX_IDS) f.all = true; else for (const id of d.ids) f.ids.add(id); });
    es.addEventListener('change', () => { if (f.es !== es) return; const named = f.named; f.named = false; want(!named); });
    es.onerror = () => { if (f.es === es) drop(); };
  }
  // Feed lost or refused: one fetch at once (tells a restart from an outage), fast poll, retry the feed after the backoff.
  function drop() {
    if (f.es) { f.es.close(); f.es = null; }
    if (f.live) { f.live = false; poll(); }
    show(); want(true);
    timers.clearTimeout(f.retryT); f.retryT = later(open, retryDelay(f.fails++));
  }
  // Begin (or resume after pagehide): fresh feed and poll; the feed's first change event (sent on connect) loads the sessions, so boot fetches once; without a feed, or when it stays quiet, fetch anyway.
  function start() {
    if (f.on) return; f.on = true; f.fails = 0; f.all = true; const t0 = f.last; open(); poll();
    if (!f.es) want(true); else if (f.last === t0) { timers.clearTimeout(f.bootT); f.bootT = later(() => { if (f.last === t0 && !f.busy && !f.waiting) want(true); }, BOOT_WAIT); }
  }
  // Close the feed and cancel every timer; a fetch already in flight still finishes.
  function stop() {
    f.on = false; f.live = false;
    if (f.es) { f.es.close(); f.es = null; }
    for (const t of [f.pollT, f.retryT, f.waitT, f.bootT]) timers.clearTimeout(t);
    f.waiting = false; f.queued = false;
  }
  // Page shown again: the one fetch remembered while hidden runs now.
  function wake() { if (f.due && !hidden()) { f.due = false; want(); } }
  return { start, stop, wake, state: f };
}

/** A sessions event's data as {ids, all}, or null when it cannot be read; more than MAX_IDS ids count as all. @param {unknown} data @returns {{ ids: string[], all: boolean } | null} */
export function sessionsEvent(data) {
  let d; try { d = JSON.parse(String(data)); } catch (e) { return null; }
  if (!d || typeof d !== 'object' || !Array.isArray(d.ids)) return null;
  const ids = d.ids.filter((/** @type {unknown} */ x) => typeof x === 'string' && /^[\w-]{1,128}$/.test(x));
  return { ids, all: d.all === true || ids.length !== d.ids.length || ids.length > MAX_IDS };
}
/** The list patched from a partial answer (rows replaced or added, gone dropped, server order); null means fetch all: bad answer, another day, or an id with no row. @template {{ id: string }} T @param {T[]} list @param {any} ans @param {string} day @returns {T[] | null} */
export function patchList(list, ans, day) {
  if (!ans || typeof ans !== 'object' || !Array.isArray(ans.rows) || !Array.isArray(ans.order) || !Array.isArray(ans.gone) || typeof ans.today !== 'string' || ans.today !== day) return null;
  const by = new Map(list.map(s => [s.id, s]));
  for (const r of ans.rows) { if (!r || typeof r.id !== 'string') return null; by.set(r.id, r); }
  for (const id of ans.gone) by.delete(id);
  const out = []; for (const id of ans.order) { const s = by.get(id); if (!s) return null; out.push(s); }
  return out;
}
/** Complete server-sent events in buf as {event, id, data}, plus the unfinished rest; comments and blank fields dropped. @param {string} buf @returns {{ events: Array<{ event: string, id: string, data: string }>, rest: string }} */
export function sseEvents(buf) {
  const parts = buf.replace(/\r\n?/g, '\n').split('\n\n'), rest = parts.pop() ?? '', events = [];
  for (const p of parts) {
    const e = { event: 'message', id: '', data: '' }, data = [];
    for (const line of p.split('\n')) {
      if (!line || line[0] === ':') continue;
      const i = line.indexOf(':'), k = i < 0 ? line : line.slice(0, i), v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (k === 'data') data.push(v); else if (k === 'event') e.event = v; else if (k === 'id') e.id = v;
    }
    if (data.length) { e.data = data.join('\n'); events.push(e); }
  }
  return { events, rest };
}
export const ENDED = [129, 130, 143];  // 128 + hang-up, interrupt, terminate: the terminal was ended, not the CLI failing
/** What the Terminal tab prints when the stream ends with an exit code: -1 the terminal host is gone, 128 + signal an ended terminal, else the CLI's own code. @param {number} code */
export function exitText(code) {
  const n = Number(code);
  if (n === -1) return 'Terminal host stopped. Open the Terminal tab again to start a new terminal.';
  if (ENDED.includes(n)) return 'Terminal ended. Open the Terminal tab again to start it.';
  return `CLI ended${Number.isInteger(n) ? ` (code ${n})` : ''}. Open the Terminal tab again to restart it.`;
}
export const NOT_FOUND = 127;  // exit code of a CLI path that could not be run
/** The Terminal tab's line when the CLI cannot run at all (exit 127 or an open refusal): the server's own words, control characters dropped, with the doctor hint; no "open again" advice. @param {unknown} text */
export const cliMissingText = text => { const t = String(text ?? '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'The `claude` command was not found or could not run.'; return /doctor/.test(t) ? t : t + ' Run `python3 server.py doctor` to check the setup.'; };
/** An open refusal that means the CLI itself cannot run (not found, not executable). @param {unknown} err */
export const cliMissing = err => !/session/i.test(String(err ?? '')) && /not found|not executable|no such file|cannot be run|permission denied/i.test(String(err ?? ''));
/** Wait before terminal re-attach try n (0-based): 0.5 s, 1 s, 2 s, then 3 s. @param {number} n */
export const reattachDelay = n => [500, 1000, 2000, 3000][Math.min(Math.max(n, 0), 3)];
