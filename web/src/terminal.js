// @ts-check
// Live terminal: the real CLI runs on the local server, xterm draws it in the drawer.
import { $ } from './util.js';
import { setupOf, setupHint, setupOff, syncLineHtml as syncHtml, termLeave } from './logic.js';
import { cliMissing, cliMissingText, exitText, NOT_FOUND, reattachDelay, sseEvents } from './feed.js';
import { isReduced, onReducedChange, state } from './state.js';
import { toast } from './toast.js';

/** @typedef {import('./types.js').Session} Session */

/** @type {any} */
let xt = null;
/** @type {Promise<void> | null | undefined} */
let xtLib;
/** One POST to the local server with the page token. @param {string} path @param {object} body */
const send = (path, body) => fetch(path, { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Desk-Token':/** @type {any} */ (window).DESK_TOKEN || '' }, body:JSON.stringify(body) });
/** Reads the token of a restarted server from the page shell; true when it changed. */
const retoken = async () => { const m = /DESK_TOKEN="([^"]+)"/.exec(await fetch('./', { cache:'no-store' }).then(r => r.text()).catch(() => '')), w = /** @type {any} */ (window); if (!m || m[1] === w.DESK_TOKEN) return false; w.DESK_TOKEN = m[1]; return true; };
/** Releases an answer nobody reads, so the browser can drop the request. @param {Response} r */
export const drop = r => { if (r.body) r.body.cancel().catch(() => {}); };
/** Guarded POST; after a server restart (403 with an old token) it takes the new token and tries once more. @param {string} path @param {object} body */
export const post = async (path, body) => { const r = await send(path, body); return r.status === 403 && await retoken() ? send(path, body) : r; };
const TOO_BIG = 'Not sent: the server takes at most 100 KB at once. Paste it in smaller parts.';  // footer line for a 413 answer
const TOO_MANY = 'Too many terminal streams are open (16 at most). Close the Terminal tab in another browser tab; this one retries by itself.';  // footer line for a 503 answer
/** @param {string} src */
const loadScript = src => new Promise((ok, no) => { const el = document.createElement('script'); el.src = src; el.onload = ok; el.onerror = no; document.head.append(el); });
// Terminal library, fetched once on first use.
function xtermLib() {
  return xtLib ||= (async () => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'vendor/xterm.css'; document.head.append(css);
    await loadScript('vendor/xterm.js');
    await loadScript('vendor/xterm-addon-fit.js');
    await loadScript('vendor/xterm-addon-web-links.js');
  })();
}
// The CLI could not run (exit 127 or an open refusal), or the setup turns page terminals off: the page's few words, then the server's sentence, kept until a health answer says the CLI is fine again, so reopening the tab shows them instead of failing again.
let noCli = '';
/** Why no terminal can start, or '' when it may: the remembered failure, else what the health answer's setup turns off. */
const cliBlock = () => { const h = state.health; if (h && setupOf(h).cli === 'ok' && h.setup) noCli = ''; const off = setupOff(h); return noCli || (off ? cliMissingText(off) : ''); };
/** Show the CLI-missing words in the box (plain text, once), not in a terminal. @param {HTMLElement} box @param {string} text */
const showNoCli = (box, text) => { box.textContent = ''; const p = document.createElement('p'); p.className = 'xt-off'; p.setAttribute('role', 'status'); p.textContent = text; box.append(p); };
/** Start or attach the CLI for s in the #xt box. @param {Session} s */
export async function mountTerm(s) {
  const st = state.st;
  const box = $('xt'), mine = () => st.open === s.id && st.view === 'term' && box.isConnected;
  const off = cliBlock(); if (off) return showNoCli(box, off);
  box.textContent = 'Starting Claude CLI…';
  try { await xtermLib(); } catch (e) { xtLib = null; box.textContent = 'Could not load the terminal library. Check that web/vendor exists beside server.py.'; return; }
  if (!mine()) return;
  box.textContent = '';
  // Globals set by the vendor scripts.
  const { Terminal, FitAddon, WebLinksAddon } = /** @type {any} */ (window);
  const term = new Terminal({ fontFamily:'"JetBrains Mono", Menlo, monospace', fontSize:13, cursorBlink:!isReduced(), scrollback:5000, theme:{ background:'#17171a', foreground:'#e8e6e3' } });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon.WebLinksAddon());
  // Unpadded inner box: the fit addon sizes rows from its parent's full height.
  const inner = document.createElement('div'); inner.className = 'xtin'; box.append(inner);
  // F6 or Ctrl+Shift+Left leaves the terminal for the sidebar tabs, Shift+F6 for its footer; every other key stays with the CLI.
  term.attachCustomKeyEventHandler((/** @type {KeyboardEvent} */ e) => {
    const to = termLeave({ key:e.key, ctrl:e.ctrlKey, shift:e.shiftKey, alt:e.altKey, meta:e.metaKey }); if (!to) return true;
    if (e.type === 'keydown') { e.preventDefault(); leaveTerm(to); }
    return false;
  });
  term.open(inner); fit.fit();
  /** @param {boolean} fresh */
  const open = fresh => post('api/term/open', { id:s.id, cols:term.cols, rows:term.rows, fresh }).then(async r => ({ ok:r.ok, ...(await r.json()) })).catch(() => null);
  const fresh = st.fresh === s.id; st.fresh = null;
  let r = await open(fresh);
  // A working CLI refuses a reload: say why, then attach to it as it is.
  if (fresh && r && !r.ok) { toast(r.error); r = await open(false); }
  if (!mine()) return disposeTerm(term);
  if (r && !r.ok && cliMissing(r.error)) { disposeTerm(term); noCli = cliMissingText(setupOff(state.health) || r.error); return showNoCli(box, noCli); }
  if (!r || !r.ok) { term.write('Could not start the CLI: ' + String(r ? r.error : 'local server not reachable').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ') + '\r\n'); xt = { term }; return; }
  if (r.restarted) { s.behind = false; const el = $('sync'); if (el) { el.innerHTML = syncHtml(s, true); el.hidden = !el.innerHTML; } toast('Terminal reloaded with the newest messages.'); }
  // Keystrokes go out one at a time, in order; a failed send says so in the footer.
  /** @type {Promise<any>} */
  let q = Promise.resolve();
  term.onData((/** @type {string} */ d) => { q = q.then(() => post('api/term/input', { id:s.id, data:d })).then(r => { if (r.status === 413) note(TOO_BIG, 15000); drop(r); }).catch(() => note('Server not reachable. Keys typed now are not sent.')); });
  const ro = new ResizeObserver(() => { fit.fit(); post('api/term/resize', { id:s.id, cols:term.cols, rows:term.rows }).then(drop).catch(() => {}); });
  ro.observe(inner);
  xt = { term, ro, ...follow(s, term, mine) }; term.focus();
}
/** Move focus from the terminal to the sidebar's active tab ('tabs') or its footer's first button ('foot'). @param {'tabs' | 'foot'} to */
function leaveTerm(to) {
  const d = $('drawer'), t = /** @type {HTMLElement | null} */ (to === 'foot' ? d.querySelector('.tfoot button:not(:disabled)') : d.querySelector('.tab[aria-pressed="true"]') || $('close'));
  if (t) t.focus();
}
/** Focus the live terminal again; false when none is mounted. */
export function focusTerm() { if (!xt || !xt.ro) return false; xt.term.focus(); return true; }
// The cursor stops blinking as soon as reduced motion is turned on, and blinks again when it is turned off.
onReducedChange(r => { if (xt && xt.term) xt.term.options.cursorBlink = !r; });
/** Quiet status in the Terminal tab footer, in place of the usual hint so the terminal keeps its size; empty text restores the hint, ms restores it later. @param {string} text @param {number} [ms] */
function note(text, ms = 0) {
  const el = $('xtnote'); if (!el) return; const t = text || el.dataset.hint || ''; clearTimeout(noteT);
  if (el.textContent !== t) el.textContent = t;
  if (ms) noteT = setTimeout(() => { if (el.textContent === t) el.textContent = el.dataset.hint || ''; }, ms);
}
/** @type {ReturnType<typeof setTimeout> | undefined} */
let noteT;
/**
 * Follow the terminal's output stream from the last byte seen (Last-Event-ID), re-attaching by itself after a drop or a server restart.
 * @param {Session} s @param {any} term @param {() => boolean} mine @returns {{ stop: () => void }}
 */
function follow(s, term, mine) {
  const c = { pos:0, tries:0, dropped:false, busy:false, suspect:false, dead:false, ac:/** @type {AbortController | null} */ (null), timer:/** @type {any} */ (0) };
  const live = () => !c.dead && mine();
  /** @param {number | null} code */
  const end = code => {
    c.dead = true; note('');
    // Exit 127: the CLI path could not run; say so in the server's words (or the setup hint), once, with no "open again" advice.
    if (code === NOT_FOUND) { noCli = cliMissingText(setupOff(state.health) || setupHint(state.health) || ''); term.write(`\r\n\x1b[2m[${noCli}]\x1b[0m\r\n`); return; }
    term.write(`\r\n\x1b[2m[${code === null ? 'Terminal is no longer running. Open the Terminal tab again to start it.' : exitText(code)}]\x1b[0m\r\n`);
  };
  const again = (busy = false) => { if (!live()) return; c.busy = busy; if (busy) note(TOO_MANY); else if (!c.dropped) note('Server not reachable. Re-attaching…'); c.dropped = true; c.timer = setTimeout(attach, busy ? 3000 : reattachDelay(c.tries++)); };
  async function attach() {
    if (!live()) return;
    const ac = c.ac = new AbortController();
    /** @type {Response} */
    let r;
    try { r = await fetch('api/term/stream?id=' + encodeURIComponent(s.id), { cache:'no-store', signal:ac.signal, headers:c.pos ? { 'Last-Event-ID':String(c.pos) } : {} }); }
    catch (e) { return again(); }
    if (!live()) return ac.abort();
    if (r.status === 404) return end(c.suspect ? -1 : null);
    if (r.status === 503) return again(true);
    if (!r.ok || !r.body) return again();
    if (c.dropped) note(c.busy ? '' : 'Server restarted, terminal re-attached.', 30000);
    c.dropped = false; c.busy = false; c.tries = 0;
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await rd.read(); if (done || !live()) break;
        const out = sseEvents(buf + dec.decode(value, { stream:true })); buf = out.rest;
        for (const e of out.events) {
          if (e.event === 'exit') {
            // -1 can also mean the server went down mid-stream: look once more before calling the host stopped.
            const code = Number(e.data); ac.abort();
            if (code === -1 && !c.suspect) { c.suspect = true; return again(); }
            return end(code);
          }
          const id = /^\d+$/.test(e.id) ? +e.id : -1;
          if (id >= 0 && id < c.pos) term.reset();  // the stream started over (host restarted): drop the old screen so nothing shows twice
          term.write(Uint8Array.from(atob(e.data), ch => ch.charCodeAt(0)));
          if (id >= 0) c.pos = id;
          c.suspect = false;
        }
      }
    } catch (e) { /* stream dropped */ }
    again();
  }
  attach();
  return { stop() { c.dead = true; clearTimeout(c.timer); if (c.ac) c.ac.abort(); } };
}
// Detach the page from the terminal: stream and size observer stop before the terminal goes; the CLI itself keeps running on the server.
export function killTerm() { if (!xt) return; const t = xt; xt = null; if (t.stop) t.stop(); if (t.ro) t.ro.disconnect(); disposeTerm(t.term); }
// xterm 5.3.0 leaves the viewport's refresh frame queued on dispose and Viewport._innerRefresh then throws: cancel that frame, make a late one a no-op, and ignore only that error.
/** @param {any} term */
function disposeTerm(term) {
  const vp = term && term._core && term._core.viewport;
  if (vp) { if (vp._refreshAnimationFrame != null) cancelAnimationFrame(vp._refreshAnimationFrame); vp._refreshAnimationFrame = null; vp._innerRefresh = () => {}; }
  try { term.dispose(); } catch (e) { if (!/_innerRefresh/.test(String(/** @type {any} */ (e)?.stack))) throw e; }
}
