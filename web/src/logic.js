// @ts-check
// Pure rules of the page (no DOM, no storage): looks, grouping, garden places, transcript text, sky phase, formatters.
import { esc, fmt, hash } from './util.js';
import { BODIES, HN } from './sprites.js';
import { blooms, boats, COMET_PRS, dayTotals, MAX_BLOOMS, MAX_BOATS, ORE_STEPS, oreStep } from './world_data.js';

/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('./types.js').Look} Look */
/** @typedef {import('./types.js').Slot} Slot */
/** @typedef {import('./types.js').Weather} Weather */

// ---------- looks ----------
/** A session's look: hat plus body colour, from its stored number or its id hash. @param {Record<string, number>} looks @param {string} id @returns {Look} */
export const lookOf = (looks, id) => { const n = looks[id] ?? hash(id) % (HN.length * BODIES.length); return { hat: HN[n % HN.length], c: Math.floor(n / HN.length) % BODIES.length }; };
/** Gives every active session a look no other active session wears, spreading hats then colours; edits looks, true when it added one. @param {Record<string, number>} looks @param {Session[]} sessions @returns {boolean} */
export function assignLooks(looks, sessions) {
  const N = HN.length * BODIES.length, taken = new Set(), need = [];
  for (const s of sessions.filter(s => s.status !== 'done').sort((a, b) => a.id < b.id ? -1 : 1)) { const n = looks[s.id]; if (n == null || taken.has(n)) need.push(s); else taken.add(n); }
  for (const s of need) {
    /** @type {Record<number, number>} */
    const hats = {}, cols = {}; for (const n of taken) { hats[n % HN.length] = (hats[n % HN.length] || 0) + 1; cols[Math.floor(n / HN.length)] = (cols[Math.floor(n / HN.length)] || 0) + 1; }
    let best = hash(s.id) % N, cost = Infinity;
    for (let i = 0; i < N; i++) { const n = (hash(s.id) + i * 7) % N, c = taken.has(n) ? Infinity : (hats[n % HN.length] || 0) * 2 + (cols[Math.floor(n / HN.length)] || 0); if (c < cost) { cost = c; best = n; } }
    looks[s.id] = best; taken.add(best);
  }
  return need.length > 0;
}

// ---------- status grouping ----------
/** Key under which "sent home" is remembered: the session plus the moment its status last changed. @param {Session} s */
export const sentKey = s => s.id + ':' + (s.statusAt || 0);
/** Waiting and not sent home. @param {Session} s @param {Set<string>} sentHome */
export const needsYou = (s, sentHome) => s.status === 'waiting' && !sentHome.has(sentKey(s));
/** Column a session belongs to. @param {Session} s @param {Set<string>} sentHome @returns {'waiting' | 'running' | 'resting'} */
export const group = (s, sentHome) => needsYou(s, sentHome) ? 'waiting' : s.status === 'running' ? 'running' : 'resting';
/** Waiting but sent home to sleep in town. @param {Session} s @param {Set<string>} sentHome */
export const asleep = (s, sentHome) => s.status === 'waiting' && sentHome.has(sentKey(s));
export const LABEL = { waiting:'Needs you', running:'Working', resting:'Resting' };

// ---------- garden places ----------
// First six spots ring the pond; the rest stand in the meadow.
/** @type {Slot[]} */
export const SLOTS = [[.53,.73],[.66,.575],[.775,.76],[.585,.9],[.735,.9],[.565,.6],[.38,.68],[.2,.56],[.3,.86],[.12,.82],[.42,.47],[.07,.62]];
// Where each pond-side spot drops its float, in garden fractions.
/** @type {Slot[]} */
export const FISH = [[.61,.72],[.715,.665],[.71,.745],[.64,.775],[.68,.775],[.625,.665]];
/** Airflow work: the session's title, latest request or last reply talks about Airflow or DAGs. @param {Session} s */
export const isAirflow = s => /airflow|\bdags?\b|\bdag_|a[23]_dags|backfill|scheduler|task instance/i.test([s.title, s.topic, s.ask, s.last].join(' '));
/** Free slot for a newcomer: pond spots for Airflow sessions, meadow for the rest, either when full; -1 when none. @param {Set<number>} used @param {boolean} pond */
export const pickSlot = (used, pond) => { const free = SLOTS.map((_, i) => i).filter(i => !used.has(i)); return free.find(i => (i < FISH.length) === pond) ?? free[0] ?? -1; };

// ---------- garden and drawer text ----------
/** First ~70 characters of a question, on one line. @param {any} t @returns {string} */
export const sayPeek = t => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > 70 ? t.slice(0, 68).trimEnd() + '…' : t; };
/** Hover bubble: mission title, the latest request, then what the agent last said. @param {Session} s @param {string} [text] */
export const sayHtml = (s, text) => `<b>${esc(s.title)}</b>${s.topic ? `<u>You: ${esc(sayPeek(s.topic))}</u>` : ''}${text ? esc(sayPeek(text)) : ''}`;
/** Demo transcript to drawer events: a 'tools' entry expands to one tool line per item. @param {Array<Array<any>> | undefined} tl */
export const flat = tl => (tl || []).flatMap(e => e[0] === 'tools' ? (e[2] || []).map(/** @param {unknown} i */ i => { const [a, ...r] = String(i).split(' '); return ['tool', a, r.join(' '), '', 0]; }) : [e]);
/** @param {string} u @param {string} t */
const link = (u, t) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`;
/** @param {string} t */
const bold = t => t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
/** Light markdown as the CLI shows it: code and fences stay literal, then links (http/https only, never nested) and bold; everything escaped. @param {string} t */
export function md(t) {
  /** @type {string[]} */
  const keep = [], put = (/** @type {string} */ h) => `\uE000${keep.push(h) - 1}\uE001`, back = (/** @type {string} */ s) => s.replace(/\uE000(\d+)\uE001/g, (_, i) => back(keep[+i]));
  const s = esc(String(t ?? '').replace(/[\uE000\uE001]/g, ''))
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, c) => put(`<pre><code>${c}</code></pre>`))
    .replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${c}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)<\uE000]+)\)/g, (_, x, u) => put(link(u, bold(x))))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)\uE000]+?)(?=\*\*|[\s<)\uE000]|$)/g, (_, p, u) => p + put(link(u, u)));
  return back(bold(s));
}
/**
 * Where a session is open besides this page: null when nowhere else; else the live copies (the server's copies, at least the other programs plus this page's terminal) and their names.
 * here: this page has a terminal for it (the row's term, or the Terminal tab open on it).
 * @param {Session} s @param {boolean} [here] @returns {{ n: number, names: string[] } | null}
 */
export function liveCopies(s, here = false) {
  const also = (s.also || []).filter(Boolean).map(String), mine = here || !!s.term; if (!also.length) return null;
  const n = Math.max(Math.floor(Number(s.copies)) || 0, also.length + (mine ? 1 : 0)), names = [...(mine ? ['this page'] : []), ...also], extra = n - names.length;
  const i = names.indexOf('another terminal');
  if (extra > 0 && i >= 0) names[i] = `${extra + 1} other terminals`; else if (extra > 0) names.push(`${extra} more`);
  return { n, names };
}
/** The sidebar's words for where else the session is open: one other program, said before a second copy is opened here, or every live copy. @param {Session} s @param {boolean} [here] */
export function alsoWords(s, here = false) {
  const c = liveCopies(s, here); if (!c) return null;
  return c.n < 2 ? { head: `Open in ${c.names[0]}.`, tail: 'Opening a terminal here makes a second copy; type in one place.' }
    : { head: `Open in ${c.n} places (${c.names.join(', ')}).`, tail: 'Messages typed in one do not show in the others.' };
}
/** One line that says where else the session is open and whether this terminal fell behind. @param {Session} s @param {boolean} [here] this page has a terminal for it */
export function syncHtml(s, here = false) {
  const a = alsoWords(s, here);
  return (a ? `<span class="w">${esc(a.head)}</span><span>${esc(a.tail)}</span>` : '')
    + (s.behind ? '<span class="w">Newer messages were written elsewhere.</span><button type="button" class="tbtn go" data-act="reterm">Reload terminal</button>' : '');
}

// ---------- sky ----------
/** Weather plaque name for a WMO code. @param {number} c */
export const wxName = c => c === 0 ? 'Clear' : c === 1 ? 'Mostly clear' : c === 2 ? 'Partly cloudy' : c === 3 ? 'Overcast' : c < 50 ? 'Fog' : c < 58 ? 'Drizzle' : c < 68 ? 'Rain' : c < 78 ? 'Snow' : c < 83 ? 'Showers' : c < 87 ? 'Snow showers' : 'Thunderstorm';
/** @param {number} c */
export const isSnow = c => (c >= 71 && c <= 77) || c === 85 || c === 86;
/** @param {number} c */
export const isWet = c => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95;
/** Dawn, day, dusk or night for minute t, from sunrise and sunset in w. @param {number} t @param {Weather} w */
export const phase = (t, w) => t < w.sr - 40 || t > w.ss + 40 ? 'night' : t < w.sr + 50 ? 'dawn' : t > w.ss - 50 ? 'dusk' : 'day';

// ---------- statistics formatters ----------
/** Count with B for billions, else like fmt. @param {number} n */
export const usB = n => { n = Math.round(n); return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : fmt(n); };
/** Whole number with thousands separators. @param {number} n */
export const usInt = n => Math.round(n).toLocaleString('en-US');
/** Seconds as "42 s", "3 min 5 s", "2 h 10 min". @param {number} s */
export const usDur = s => { s = Math.round(s); if (s < 60) return s + ' s'; if (s < 3600) return Math.floor(s / 60) + ' min' + (s % 60 ? ' ' + s % 60 + ' s' : ''); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h + ' h' + (m ? ' ' + m + ' min' : ''); };
/** YYYY-MM-DD as "Wed, 11 Nov". @param {string} d */
export const usDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', timeZone:'UTC' });
/** Index of the largest value (first on ties). @param {number[]} a */
export const usTop = a => a.reduce((b, v, i) => v > a[b] ? i : b, 0);

// ---------- search and keys ----------
/** Lower-case search words of a query. @param {string} q */
export const words = q => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
/** True when every word of q appears in the session's title, project, branch, question, latest request or last line. @param {Session} s @param {string} q */
export const matches = (s, q) => { const t = [s.title, s.project, s.branch, s.ask, s.topic, s.last].join(' ').toLowerCase(); return words(q).every(w => t.includes(w)); };
/** Escaped text with every search word wrapped in <mark>, longest words first so overlaps stay whole. @param {unknown} text @param {string} q */
export function markHits(text, q) {
  const t = String(text ?? ''), ws = [...new Set(words(q))].sort((a, b) => b.length - a.length);
  if (!ws.length) return esc(t);
  const low = t.toLowerCase(), on = new Array(t.length).fill(false);
  for (const w of ws) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + 1)) for (let j = i; j < i + w.length; j++) on[j] = true;
  let out = '', i = 0;
  while (i < t.length) { let j = i; while (j < t.length && on[j] === on[i]) j++; out += on[i] ? `<mark>${esc(t.slice(i, j))}</mark>` : esc(t.slice(i, j)); i = j; }
  return out;
}
/**
 * List action for a key press: 'search', 'down', 'up', 'blur' or ''. Never on modified keys, with the drawer or a panel open, or while typing (except ArrowDown, and Esc in an empty box, in the search box).
 * @param {{ key: string, ctrl?: boolean, meta?: boolean, alt?: boolean }} k
 * @param {{ typing?: boolean, search?: boolean, empty?: boolean, overlay?: boolean, onRow?: boolean }} c
 */
export function keyAction(k, c) {
  if (k.ctrl || k.meta || k.alt || c.overlay) return '';
  if (c.typing) return !c.search ? '' : k.key === 'ArrowDown' ? 'down' : k.key === 'Escape' && c.empty ? 'blur' : '';
  if (k.key === '/') return 'search';
  if (k.key === 'j' || (c.onRow && k.key === 'ArrowDown')) return 'down';
  if (k.key === 'k' || (c.onRow && k.key === 'ArrowUp')) return 'up';
  return '';
}

/** Where a key pressed in the live terminal sends focus: 'tabs' (F6, Ctrl+Shift+Left), 'foot' (Shift+F6), or '' when the key belongs to the CLI. @param {{ key: string, ctrl?: boolean, shift?: boolean, alt?: boolean, meta?: boolean }} k @returns {'tabs' | 'foot' | ''} */
export function termLeave(k) {
  if (k.alt || k.meta) return '';
  if (k.key === 'F6' && !k.ctrl) return k.shift ? 'foot' : 'tabs';
  return k.key === 'ArrowLeft' && k.ctrl && k.shift ? 'tabs' : '';
}

// ---------- transcript folds ----------
/** Runs of at least min consecutive tool events as start index to end index (exclusive); while live, a run that ends the transcript stays unfolded. @param {Array<Array<any>>} ev @param {number} [min] @param {boolean} [live] @returns {Map<number, number>} */
export function toolRuns(ev, min = 5, live = false) {
  const out = new Map(); let i = 0;
  while (i < ev.length) { if (ev[i][0] !== 'tool') { i++; continue; } let j = i; while (j < ev.length && ev[j][0] === 'tool') j++; if (j - i >= min && !(live && j === ev.length)) out.set(i, j); i = j; }
  return out;
}
/** Tool names in order of first use with repeat counts: "Read ×2, Grep, Bash". @param {string[]} names */
export const toolSummary = names => { /** @type {Map<string, number>} */ const n = new Map(); for (const x of names) n.set(x, (n.get(x) || 0) + 1); return [...n].map(([k, v]) => v > 1 ? `${k} ×${v}` : k).join(', '); };

// ---------- list rows and header counts ----------
/** Started by a hook or script through the headless CLI; a missing kind counts as interactive. @param {Session} s */
export const isAuto = s => s.automated === true || s.kind === 'headless';
/** Markdown as one line of plain words: marks, heading hashes, bullets, quotes, fences and link targets dropped. @param {unknown} t */
export function plain(t) {
  return String(t ?? '').slice(0, 2000)
    .replace(/```[^\n]*/g, ' ')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, ' ')
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, ' ')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, x) => x.split('|').map((/** @type {string} */ c) => c.trim()).join(' · '))
    .replace(/^[ \t]*(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+(\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm, '')
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=[^\s*_])([^*_\n]*?[^\s*_])[*_](?![\w*])/g, '$1$2')
    .replace(/~~(?=\S)([^\n]*?\S)~~/g, '$1')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ').trim();
}
/** Copies of the session differ: the optional consistency field holds anything but an in-sync value. @param {Session} s */
export const diverged = s => { const c = s.consistency, v = c && typeof c === 'object' ? (c.state ?? c.status ?? '') : c; return !!v && !/^(ok|same|clean|in[ _-]?sync|synced|consistent)$/i.test(String(v)); };
/**
 * Quiet row badges as [kind, label, tooltip]: failed newest tool result, pull requests, automated, behind (else open twice), diverged. Missing fields mean off.
 * @param {Session} s @returns {Array<[string, string, string]>}
 */
/** True when a session is live in two or more programs: by the server's copy count when it sends one, else when another program holds it besides this page. @param {Session} s */
export const openTwice = s => typeof s.copies === 'number' ? s.copies > 1 : (s.also || []).some(Boolean);
export function badges(s) {
  /** @type {Array<[string, string, string]>} */
  const b = [], also = (s.also || []).filter(Boolean), pr = Math.max(0, Math.floor(Number(s.prOpened) || 0));
  if (s.lastError) b.push(['err', '', 'Its newest tool result failed']);
  if (pr) b.push(['pr', pr > 1 ? 'PR ' + pr : 'PR', pr > 1 ? `Opened ${pr} pull requests` : 'Opened a pull request']);
  if (isAuto(s)) b.push(['auto', 'auto', 'Automated run: started by a hook or script, not typed by you']);
  const where = also.length ? `Also open in ${also.join(' and ')}. Messages typed in one place do not show in the other.` : '';
  if (s.behind) b.push(['behind', 'behind', (where ? where + ' ' : '') + 'Newer messages were written elsewhere. Open it and reload its terminal.']);
  else if (where && openTwice(s)) b.push(['also', 'open twice', where]);
  if (diverged(s)) b.push(['diverged', 'diverged', 'Its copies differ: ' + plain(typeof s.consistency === 'object' ? JSON.stringify(s.consistency) : s.consistency)]);
  return b;
}
/** Header numbers with the list rules: need you (as the garden counts), working, resting rows listed, automated resting runs folded away, tokens. @param {Session[]} S @param {Set<string>} sentHome */
export function tally(S, sentHome) {
  const c = { need:0, working:0, resting:0, auto:0, tokens:0 };
  for (const s of S) { const g = group(s, sentHome); c.tokens += s.tokens || 0; if (g === 'waiting') c.need++; else if (g === 'running') c.working++; else if (isAuto(s)) c.auto++; else c.resting++; }
  return c;
}
// Fields a patched list may hold differently from a fresh full one without being wrong: times, and what the page keeps on a row itself.
const DRIFT_SKIP = new Set(['updated', 'statusAt', 'waitingSince', 'full', 'files', 'err']);
/** Field names (never values) where the page's patched list differs from a fresh full list ('ids' when rows came or went), the ids of rows whose fields differ, and the ids of rows that came or went; a row whose times moved changed since and is skipped. @param {Session[]} held @param {Session[]} fresh @returns {{ fields: string[], ids: string[], moved: string[] }} */
export function listDrift(held, fresh) {
  /** @type {Set<string>} */ const out = new Set(), rows = new Set(), moved = new Set(); const by = new Map(held.map(s => [s.id, s])), now = new Set(fresh.map(s => s.id));
  for (const s of [...held.filter(s => !now.has(s.id)), ...fresh.filter(s => !by.has(s.id))]) { out.add('ids'); moved.add(s.id); }
  for (const f of fresh) {
    const h = /** @type {any} */ (by.get(f.id)), g = /** @type {any} */ (f); if (!h || h.updated !== g.updated || h.statusAt !== g.statusAt || h.waitingSince !== g.waitingSince) continue;
    for (const k of new Set([...Object.keys(h), ...Object.keys(g)])) if (!DRIFT_SKIP.has(k) && JSON.stringify(h[k]) !== JSON.stringify(g[k])) { out.add(k); rows.add(f.id); }
  }
  return { fields: [...out].sort(), ids: [...rows].sort(), moved: [...moved].sort() };
}
/** Working sessions: the Working heading's number, and the one the garden's mine reads for its miners and its "+N" mark. @param {Session[]} S @param {Set<string>} sentHome */
export const workingCount = (S, sentHome) => S.reduce((n, s) => n + (group(s, sentHome) === 'running' ? 1 : 0), 0);
/** Working sessions beyond the garden's miner slots: the mine's "+N" (0 when all fit). @param {Session[]} S @param {Set<string>} sentHome @param {number} slots */
export const workingOverflow = (S, sentHome, slots) => Math.max(0, workingCount(S, sentHome) - slots);
/** Sessions that need you but have no character in the garden (all slots taken), newest first. @param {Session[]} S @param {Set<string>} sentHome @param {{ has: (id: string) => boolean }} drawn */
export const gardenOverflow = (S, sentHome, drawn) => S.filter(s => needsYou(s, sentHome) && !drawn.has(s.id)).sort((a, b) => b.updated - a.updated);

// ---------- sidebar header, quiet extras ----------
/** Badge chips as the list rows draw them: label text, or screen-reader text for the dot. @param {Session} s */
export const chipsHtml = s => badges(s).map(([k, l, t]) => `<span class="chip ${k}" title="${esc(t)}">${l ? esc(l) : `<span class="sr">${esc(t)}</span>`}</span>`).join('');
/** How long a waiting session has waited, as "under a minute", "12 min", "2 h 5 min" or "3 d"; '' when not waiting or waitingSince is 0 or missing. @param {Session} s @param {number} now */
export function waitedFor(s, now) {
  const t = Number(s.waitingSince) || 0; if (s.status !== 'waiting' || t <= 0) return '';
  const m = Math.max(0, Math.floor((now - t) / 60000));
  if (m < 1) return 'under a minute'; if (m < 60) return m + ' min';
  const h = Math.floor(m / 60); return h < 24 ? h + ' h' + (m % 60 ? ' ' + m % 60 + ' min' : '') : Math.floor(h / 24) + ' d';
}
/** The title says nothing about the work: empty, the CLI's "(session)" placeholder, or the 8-character id prefix the resume picker shows. @param {Session} s */
export function bareTitle(s) {
  const t = String(s.title ?? '').trim();
  return !t || t === '(session)' || (/^[0-9a-f]{8}$/i.test(t) && String(s.id ?? '').toLowerCase().startsWith(t.toLowerCase()));
}
/** Session name for one line, never empty: the title, else project and branch, else the id prefix. @param {Session} s */
export function nameOf(s) {
  if (!bareTitle(s)) return String(s.title).trim();
  return s.project ? s.project + (s.branch ? ' · ' + s.branch : '') : String(s.title ?? '').trim() || String(s.id ?? '').slice(0, 8) || '(session)';
}
/** What a bare title is shown as beside project and branch: the id prefix when known, else the title; '' for a real title. @param {Session} s */
export const bareLabel = s => !bareTitle(s) ? '' : String(s.id ?? '').slice(0, 8) || String(s.title ?? '').trim() || '(session)';
/** Row and button tooltip: whole title (project, branch and session id for a bare one), how long it waits, the latest request. @param {Session} s @param {number} now */
export const rowTip = (s, now) => { const w = waitedFor(s, now); return (bareTitle(s) ? `${s.project || 'Session'} · ${s.branch || '-'}\nSession ${bareLabel(s)}` : s.title) + (w ? '\nWaiting for you for ' + w : '') + (s.topic ? '\nYou: ' + sayPeek(plain(s.topic)) : ''); };
/** Rows a list part draws: all while searching (up to cap) or unfolded, else the newest `few`. @param {number} n @param {{ q: boolean, open: boolean, few: number, cap: number }} o */
export const shownRows = (n, o) => Math.min(n, o.q ? o.cap : o.open ? n : o.few);
/** Why the quick reply box is off for a session, or '' when it can be used: working, open in another program (in the sidebar line's words), or an automated run. @param {Session} s @param {string} g its group @param {boolean} [here] this page has a terminal for it */
export function replyBlock(s, g, here = false) {
  const a = alsoWords(s, here), c = liveCopies(s, here);
  return g === 'running' ? 'Agent is working. Wait for it to finish.'
    : a && c ? (c.n < 2 ? `${a.head} Reply there; a quick reply here makes a second copy.` : `${a.head} Reply in one of them; ${a.tail[0].toLowerCase()}${a.tail.slice(1)}`)
    : isAuto(s) ? 'Automated run, started by a hook or script. Use the Terminal tab to continue it.' : '';
}
/** Plain words for a failed quick reply; a tool the headless run was not allowed to use points to the Terminal tab. @param {unknown} err */
export const replyErrorText = err => { const t = String(err ?? '').trim(); return /permission|approv|denied|not allowed|requires? (your )?confirmation/i.test(t) ? 'The quick reply stopped at a tool that needs your approval. Open the Terminal tab to approve it.' : 'Last reply failed: ' + t; };

// ---------- Stats "Today" card ----------
/**
 * What today's scenery stands for, with the garden's own rules: tokens and ore step, pull requests and sunflowers, automated runs and boats, the comet, and who waits.
 * over holds the preview overrides (null keeps the sessions' value); the longest wait is among sessions that need you and know since when.
 * @param {Session[]} S @param {number} now @param {Set<string>} sentHome @param {{ tokens?: number | null, prs?: number | null, runs?: number | null }} [over]
 */
export function dayScene(S, now, sentHome, over = {}) {
  const d = dayTotals(S, now), tokens = over.tokens ?? d.tokens, prs = over.prs ?? d.prs, runs = over.runs ?? d.runs, ore = oreStep(tokens);
  const need = (S || []).filter(s => needsYou(s, sentHome)), dated = need.filter(s => Number(s.waitingSince) > 0).sort((a, b) => Number(a.waitingSince) - Number(b.waitingSince));
  return { tokens, ore, steps: ORE_STEPS.length, next: ORE_STEPS[ore] ?? 0, prs, blooms: blooms(prs), maxBlooms: MAX_BLOOMS, runs, boats: boats(runs), maxBoats: MAX_BOATS,
    comet: prs >= COMET_PRS, cometPrs: COMET_PRS, waiting: need.length, longest: dated.length ? waitedFor(dated[0], now) : '', longestTitle: dated.length ? dated[0].title : '' };
}

// ---------- page extras (lists and sidebar only) ----------
/** Tooltip for the "diverged" badge on list rows and the sidebar: which copy the page shows and what Reload terminal does. */
export const DIVERGED_TIP = 'Its copies differ: this page shows the conversation the CLI resumes, not the branch another program wrote; Reload terminal loads the newest.';
/** Badge chips for list rows and the sidebar header, with the diverged badge saying what to do. @param {Session} s */
export const rowChipsHtml = s => badges(s).map(([k, l, t]) => `<span class="chip ${k}" title="${esc(k === 'diverged' ? DIVERGED_TIP : t)}">${l ? esc(l) : `<span class="sr">${esc(t)}</span>`}</span>`).join('');
/** Sidebar sync line: where else it is open, whether it fell behind, and for a diverged session which copy shows (one Reload terminal button at most). @param {Session} s @param {boolean} [here] this page has a terminal for it */
export function syncLineHtml(s, here = false) {
  const base = syncHtml(s, here);
  return !diverged(s) ? base : base + `<span class="w">Diverged.</span><span>${esc(DIVERGED_TIP.replace(/^Its copies differ: t/, 'T'))}</span>` + (s.behind ? '' : '<button type="button" class="tbtn go" data-act="reterm">Reload terminal</button>');
}
/** A failed quick reply as the server reported it: its error text trimmed, and the Terminal hint only when the run exited non-zero with no output (replyExit); null when the last reply did not fail. @param {Session} s */
export function replyFailure(s) {
  const text = String(s.replyError ?? '').trim(), code = s.replyExit == null || s.replyExit === '' ? 0 : Number(s.replyExit), silent = !text && Number.isFinite(code) && code !== 0;
  return text || silent ? { text, hint: silent } : null;
}

// ---------- first-run setup and waiting news (page only) ----------
/** The health answer's setup object with every field filled; a missing or partial one counts as fine. @param {any} health @returns {{ dataDir: string, sessions: number, cli: string, stateDir: string, hint: string }} */
export function setupOf(health) {
  const s = health && typeof health.setup === 'object' && health.setup ? health.setup : {}, str = (/** @type {unknown} */ v) => typeof v === 'string' && v ? v : 'ok';
  return { dataDir: str(s.dataDir), sessions: Math.max(0, Math.floor(Number(s.sessions) || 0)), cli: str(s.cli), stateDir: str(s.stateDir), hint: typeof s.hint === 'string' ? s.hint.replace(/\s+/g, ' ').trim() : '' };
}
/** One plain sentence saying what is wrong with the setup, '' when all is fine: the server's hint, else a sentence per problem. @param {any} health */
export function setupHint(health) {
  const s = setupOf(health);
  if (s.dataDir === 'ok' && s.cli === 'ok' && s.stateDir === 'ok') return '';
  if (s.hint) return s.hint;
  if (s.dataDir === 'missing') return 'No Claude Code data found: run `claude` once, then reload.';
  if (s.dataDir !== 'ok') return 'The Claude Code data folder cannot be read: check its permissions, then reload.';
  if (s.cli === 'missing') return 'The `claude` command was not found: install Claude Code or set DESK_CLAUDE_BIN.';
  if (s.cli !== 'ok') return 'The `claude` command cannot be run: check that it is executable.';
  return 'The app folder is read-only: move it somewhere writable or set DESK_STATE_DIR.';
}
export const DOCTOR_LINE = 'Run `python3 server.py doctor` to check the setup.';  // second line of every setup notice
/** What the page says about the setup: the server's sentence for the empty lists (only with no sessions listed; also its "no sessions yet" one), and the quiet line under the search box when sessions exist but terminals or replies cannot run. @param {any} health @param {number} listed */
export function setupNotes(health, listed) {
  const s = setupOf(health), hint = setupHint(health), off = setupOff(health);
  const empty = listed ? '' : hint || (!s.sessions && s.hint ? s.hint : '');
  return { empty, cliOff: listed ? off : '' };
}
/** What the setup turns off on the page, the page's few words before the server's own sentence: terminals and quick replies (the CLI cannot run) or page terminals only (read-only app folder); '' when nothing is off. @param {any} health */
export function setupOff(health) {
  const s = setupOf(health), hint = setupHint(health);
  return s.dataDir !== 'ok' ? '' : s.cli !== 'ok' ? `Terminals and quick replies are off: ${hint}` : s.stateDir !== 'ok' ? `Page terminals are off: ${hint}` : '';
}
/** Text with `code` spans, everything escaped first. @param {string} t */
export const codeHtml = t => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');
/** Sessions someone typed into that wait now (sent-home ones included, automated runs left out), by id. @param {Session[]} S */
export const waitingIds = S => new Set((S || []).filter(s => s && s.status === 'waiting' && !isAuto(s)).map(s => s.id));
/** News for sessions that started waiting since prev (null on page load: none): "<title> needs you", "N sessions need you" or ''. @param {Set<string> | null} prev @param {Session[]} S @returns {{ ids: Set<string>, text: string }} */
export function waitingNews(prev, S) {
  const ids = waitingIds(S); if (!prev) return { ids, text: '' };
  const fresh = (S || []).filter(s => ids.has(s.id) && !prev.has(s.id));
  return { ids, text: !fresh.length ? '' : fresh.length === 1 ? `${nameOf(fresh[0])} needs you` : `${fresh.length} sessions need you` };
}
/** Document title: the count of sessions that need you in brackets, plain name when none. @param {number} n */
export const pageTitle = n => n > 0 ? `(${n}) Session Desk` : 'Session Desk';
