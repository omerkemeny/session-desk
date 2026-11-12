// @ts-check
// Transcript events to CLI-style lines: kinds, folded tool runs, one top-level element per segment; no DOM, unit-tested in node.
import { esc } from './util.js';
import { toolSummary } from './logic.js';
import { renderMd } from './markdown.js';

export const FOLD_MIN = 5;  // consecutive tool calls that fold into one summary line
const IMAGE = '[Image]';  // server's text for a prompt that held only images

/**
 * Kind of one server event, old and new shapes alike; '' for kinds this page does not know (never drawn as a tool call).
 * Old: ['you', text], ['claude', text], ['tool', name, hint, result, isError, display?, quiet?] (display: the CLI's name for the tool; quiet: 1 when the CLI prints no result line; both optional).
 * New: ['out', text, isError] (output of a ! or / command), ['interrupt'], ['compact'], ['image'], ['elsewhere', program, count].
 * @param {any[]} e @returns {string}
 */
export function kindOf(e) {
  const k = Array.isArray(e) ? e[0] : '';
  if (k === 'you') { const t = String(e[1] ?? ''); return t === IMAGE ? 'image' : t.startsWith('! ') ? 'bash' : 'you'; }
  if (k === 'claude') return /^API Error\b/.test(String(e[1] ?? '')) ? 'apierr' : 'claude';
  if (k === 'tool') return silentTool(e) ? '' : 'tool';
  return ['tool', 'out', 'interrupt', 'compact', 'image', 'elsewhere'].includes(k) ? k : '';
}

/** A tool call the CLI prints nothing for: the server sent an empty CLI line (6th item ""), and the call did not fail. A missing 6th item (older server) still draws. @param {any[]} e */
export const silentTool = e => Array.isArray(e) && e[0] === 'tool' && e.length >= 6 && e[5] === '' && !e[4];
/** A successful call whose result the CLI does not print (7th item `quiet` is 1); a missing 7th item draws the result. @param {any[]} e */
export const quietResult = e => Array.isArray(e) && e[0] === 'tool' && (e[6] === 1 || e[6] === true) && !e[4];
/** @typedef {{ xp?: Set<number>, detail?: boolean }} ViewOpts xp: start index of each line or group the reader expanded; detail: every result shown and nothing grouped, the CLI's ctrl+o view. */
// CLI default-view group words as kind, verb, noun, in the CLI's fixed order search, read, called (MCP), ran; every form backed by stored screens (tests/fixtures/screens, screens/mcp):
// "Read 3 files", "Searched for 1 pattern, read 1 file" (case 15), "Read 1 file, called alpha, ran 1 shell command" (mcp 58), "Called alpha, beta 2 times" (mcp 56).
const GROUP_WORDS = [['search', 'Searched for', 'pattern'], ['read', 'Read', 'file'], ['bash', 'Ran', 'shell command']];
/** Kind of a call the CLI's default view folds into one group line ('search' for Grep and Glob, 'read', 'bash', 'mcp:<server>'); '' for calls drawn on their own line, silent calls and older servers without the quiet item. @param {any[]} e */
export function groupKind(e) {
  if (!Array.isArray(e) || e[0] !== 'tool' || e.length < 7 || silentTool(e)) return '';
  const n = String(e[1] ?? ''), m = /^mcp__(.+?)__./.exec(n);
  return n === 'Grep' || n === 'Glob' ? 'search' : n === 'Read' ? 'read' : n === 'Bash' ? 'bash' : m ? 'mcp:' + m[1] : '';
}
/** The CLI's group line for these call kinds, such as "Searched for 2 patterns, ran 1 shell command". @param {string[]} kinds */
export function groupWords(kinds) {
  /** @type {Map<string, number>} */ const n = new Map(); for (const k of kinds) n.set(k, (n.get(k) || 0) + 1);
  /** @param {number} c @param {string} w */
  const pl = (c, w) => `${c} ${w}${c === 1 ? '' : 's'}`;
  const parts = GROUP_WORDS.filter(([k]) => n.has(k)).map(([k, v, w]) => `${v} ${pl(n.get(k) || 0, w)}`);
  // MCP calls as the CLI draws them with their servers configured: "Called <server>[, <server>…]", plus " N times" only past one call in all (screens/mcp 56, 57, 60).
  const srv = [...n.keys()].filter(k => k.startsWith('mcp:')), calls = srv.reduce((t, k) => t + (n.get(k) || 0), 0);
  if (srv.length) parts.splice(n.has('bash') ? parts.length - 1 : parts.length, 0, `Called ${srv.map(k => k.slice(4)).join(', ')}${calls > 1 ? ` ${calls} times` : ''}`);
  return parts.map((p, i) => i ? p[0].toLowerCase() + p.slice(1) : p).join(', ');
}
/** An event that rides along inside a group without ending it: a silent call, or a branch marker the CLI does not draw (screen case 15). @param {any} e */
const ridesAlong = e => Array.isArray(e) && (e[0] === 'elsewhere' || silentTool(e));
/** End (exclusive) of the group line that starts at i: consecutive grouped calls, silent calls and branch markers riding along inside; i when ev[i] does not group. @param {any[][]} ev @param {number} i */
export function groupEnd(ev, i) {
  if (!groupKind(ev[i])) return i;
  let end = i + 1;
  for (let j = i + 1; j < ev.length && (groupKind(ev[j]) || ridesAlong(ev[j])); j++) if (groupKind(ev[j])) end = j + 1;
  return end;
}
/** Result text under a tool call: an error reads "Error: <text>" as the CLI prints it (the CLI's <tool_use_error> wrapper dropped, no second "Error:"). @param {any[]} e */
export function resultText(e) {
  const t = String(e[3] ?? '');
  if (!e[4]) return t;
  const m = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/.exec(t), x = m ? m[1] : t;
  return /^Error\b/.test(x) ? x : x ? 'Error: ' + x : 'Error';
}
/** Tool name as the CLI prints it: MCP tools as "server - tool (MCP)". @param {unknown} n */
export function toolName(n) {
  const s = String(n ?? ''), m = /^mcp__(.+?)__(.+)$/.exec(s);
  return m ? `${m[1]} - ${m[2]} (MCP)` : s;
}
/** A tool line as name and argument part: from the CLI's own line when the server sends one (6th item, such as "Update(/a.txt)"), else raw name and hint. @param {unknown} name @param {unknown} [hint] @param {unknown} [display] */
export function toolLine(name, hint, display) {
  const d = typeof display === 'string' ? display.trim() : '';
  if (!d) return { name: toolName(name), args: hint ? `(${hint})` : '' };
  const m = /^(.*? \(MCP\))(\(.*)?$/s.exec(d), at = d.indexOf('(');
  return m ? { name: m[1], args: m[2] || '' } : at > 0 ? { name: d.slice(0, at), args: d.slice(at) } : { name: d, args: '' };
}
/** Name of a tool as the CLI prints it, without arguments. @param {unknown} name @param {unknown} [display] */
export function toolLabel(name, display) { return toolLine(name, '', display).name; }

/** Image number shown for the image at i: counts images since the prompt above it, as the CLI's [Image #n]. @param {any[][]} ev @param {number} i */
function imageNo(ev, i) {
  let n = 1;
  for (let j = i - 1; j >= 0; j--) { const k = kindOf(ev[j]); if (k === 'image') n++; else if (k !== 'out') break; }
  return n;
}

/** One event as one terminal line; i is its index, used by copy buttons and image numbers; a call whose result the CLI hides draws as a line that expands to it. @param {any[][]} ev @param {number} i @param {ViewOpts} [o] */
export function lineHtml(ev, i, o = {}) {
  const e = ev[i], k = kindOf(e), at = ` data-i="${i}"`;
  /** @param {string} cls @param {string} g @param {string} body */
  const ln = (cls, g, body) => `<div class="ln ${cls}"${at}${cls === 'you' ? ' tabindex="-1"' : ''}><span class="g">${g}</span><div class="txt">${body}</div></div>`;
  const msgCopy = '<button type="button" class="cbtn" data-copy="msg" tabindex="-1" aria-label="Copy message">copy</button>';
  switch (k) {
    case 'you': return ln('you', '&gt;', esc(e[1]));
    case 'bash': return ln('you bash', '!', esc(String(e[1]).slice(2)));
    case 'image': return ln('sub', '⎿', `[Image #${imageNo(ev, i)}]`);
    case 'claude': return `<div class="ln claude"${at} tabindex="-1"><span class="g">⏺</span><div class="txt md">${renderMd(e[1])}</div>${msgCopy}</div>`;
    case 'apierr': return ln('claude err', '⏺', esc(e[1]));
    case 'out': return ln(`sub${e[2] ? ' err' : ''}`, '⎿', esc(e[1]) || '<span class="dim">(No content)</span>');
    case 'interrupt': return ln('sub err', '⎿', 'Interrupted · What should Claude do instead?');
    case 'compact': return `<div class="cmp"${at}><div class="ln note"><span class="g">✻</span><div class="txt">Conversation compacted</div></div>${e.length < 2 || e[1] === 1 || e[1] === true ? '<div class="ln claude sum"><span class="g">⏺</span><div class="txt">Compact summary</div></div>' : ''}</div>`;
    case 'elsewhere': return ln('note other', '⑂', `${esc(e[2] || 'Some')} message${e[2] === 1 ? '' : 's'} written ${e[1] ? 'in ' + esc(e[1]) + ' ' : ''}after this point sit on another branch; resume does not show them.`);
    case 'tool': { const t = toolLine(e[1], e[2], e[5]), hide = quietResult(e) && !o.detail, r = resultText(e);
      const head = `<span class="g">⏺</span><div class="txt"><b>${esc(t.name)}</b>${t.args ? `<span class="dim">${esc(t.args)}</span>` : ''}`, res = `<div class="ln res"><span class="g">⎿</span><div class="txt">${esc(r)}</div></div>`;
      if (hide && r) return `<details class="xp" data-i="${i}" data-x="${i}"${o.xp && o.xp.has(i) ? ' open' : ''}><summary class="ln tool">${head}</div></summary>${res}</details>`;
      return `<div class="ln tool${e[4] ? ' err' : ''}"${at}>${head}${r && !hide ? res : ''}</div></div>`; }
    default: return '';
  }
}

/** Runs of consecutive tool events holding at least min drawn lines (a group line counts once), as start to end index (exclusive); silent calls ride along but do not count; while live, a run that ends the transcript stays unfolded. @param {any[][]} ev @param {number} min @param {boolean} live @param {boolean} [detail] @returns {Map<number, number>} */
export function foldRuns(ev, min = FOLD_MIN, live = false, detail = false) {
  const out = new Map(); let i = 0;
  while (i < ev.length) {
    if (!Array.isArray(ev[i]) || ev[i][0] !== 'tool') { i++; continue; }
    let j = i, n = 0, grouped = false;
    while (j < ev.length && Array.isArray(ev[j]) && ev[j][0] === 'tool') {
      const g = !detail && !!groupKind(ev[j]);
      if (!silentTool(ev[j]) && !(g && grouped)) n++;
      if (!silentTool(ev[j])) grouped = g;
      j++;
    }
    if (n >= min && !(live && j === ev.length)) out.set(i, j);
    i = j;
  }
  return out;
}
/** Lines the Transcript tab draws for these events: drawn kinds only, silent tool calls left out. @param {any[][]} ev */
export const drawnCount = ev => (ev || []).reduce((n, e) => n + (kindOf(e) ? 1 : 0), 0);
/** Lines the current view draws for these events, folds open: Details draws one per drawn event; the default view draws a group line once plus each branch marker inside it. @param {any[][]} ev @param {boolean} [detail] */
export function viewLines(ev, detail = false) {
  if (detail) return drawnCount(ev);
  let n = 0; ev = ev || [];
  for (let i = 0; i < ev.length; i++) {
    const k = groupEnd(ev, i);
    if (k > i) { n++; for (let j = i; j < k; j++) if (kindOf(ev[j]) === 'elsewhere') n++; i = k - 1; }
    else if (kindOf(ev[i])) n++;
  }
  return n;
}

/** Text the find box searches for one event, lower case: what the Transcript tab can show for it, hidden results included, plus the group line's words at a group's first call and a reply's drawn text when Markdown marks split its words; '' for events it never draws. @param {any[][]} ev @param {number} i @param {boolean} [detail] */
export function findText(ev, i, detail = false) {
  const e = ev[i], k = kindOf(e), gw = !detail && groupStart(ev, i) ? groupLine(ev, i) + '\n' : '';
  switch (k) {
    case 'claude': { const src = String(e[1] ?? ''), vis = /[*_`\[~#|&<>]/.test(src) ? mdText(src) : src; return (vis === src ? src : vis + '\n' + src).toLowerCase(); }
    case 'you': case 'apierr': case 'out': return String(e[1] ?? '').toLowerCase();
    case 'bash': return String(e[1]).slice(2).toLowerCase();
    case 'image': return `[image #${imageNo(ev, i)}]`;
    case 'interrupt': return 'interrupted · what should claude do instead?';
    case 'compact': return 'conversation compacted' + (e.length < 2 || e[1] === 1 || e[1] === true ? '\ncompact summary' : '');
    case 'elsewhere': return `${e[2] || 'some'} message${e[2] === 1 ? '' : 's'} written ${e[1] ? 'in ' + e[1] + ' ' : ''}after this point sit on another branch; resume does not show them.`.toLowerCase();
    case 'tool': { const t = toolLine(e[1], e[2], e[5]); return `${gw}${t.name}${t.args}\n${resultText(e)}`.toLowerCase(); }
    default: return '';
  }
}
/** Drawn text of a reply's Markdown: tags dropped, blocks on their own lines, copy buttons left out, entities read back. @param {string} src */
export function mdText(src) {
  return renderMd(src).replace(/<button\b[^>]*>[\s\S]*?<\/button>/g, '').replace(/<\/?(?:p|div|pre|li|ul|ol|tr|td|th|h[1-6]|blockquote|table)\b[^>]*>/g, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|quot|#39|amp);/g, (_, x) => ({ lt:'<', gt:'>', quot:'"', '#39':"'", amp:'&' })[/** @type {'lt'} */ (x)]).replace(/\n+/g, '\n').replace(/^\n|\n$/g, '');
}
/** True when event i starts a group line in the default view: it groups and the nearest earlier event that does not ride along is not a grouped call. @param {any[][]} ev @param {number} i */
export function groupStart(ev, i) {
  if (!groupKind(ev[i])) return false;
  for (let j = i - 1; j >= 0; j--) { if (ridesAlong(ev[j])) continue; return !groupKind(ev[j]); }
  return true;
}
/** The group line's words for the group that starts at i. @param {any[][]} ev @param {number} i */
export function groupLine(ev, i) { const out = []; for (let j = i, e = groupEnd(ev, i); j < e; j++) if (groupKind(ev[j])) out.push(groupKind(ev[j])); return groupWords(out); }
/** First event whose find text can change when events from d on change: a group line's words cover its whole tool run, so the run's start. @param {any[][]} ev @param {number} d */
export function findFrom(ev, d) { let i = Math.max(0, Math.min(d, ev.length)); while (i > 0 && Array.isArray(ev[i - 1]) && (ev[i - 1][0] === 'tool' || ev[i - 1][0] === 'elsewhere')) i--; return i; }
/**
 * Where the query words sit in drawn text split over text nodes: parts are the nodes' texts in order, br true where a node starts a new block (no word spans it).
 * Spans are [part, offset, part, offset] in reading order (at most max); missing lists the words with no place, which the page then marks by the whole line.
 * @param {{ t: string, br?: boolean }[]} parts @param {string[]} words @param {number} [max] @returns {{ spans: number[][], missing: string[] }}
 */
export function findSpans(parts, words, max = 200) {
  const at = /** @type {number[]} */ ([]); let all = '';
  for (const p of parts) { if (p.br && all) all += '\n'; at.push(all.length); const low = p.t.toLowerCase(); all += low.length === p.t.length ? low : '\0'.repeat(p.t.length); }
  /** Part and offset of a position in the joined text; ends at a part's end stay in that part. @param {number} x @param {boolean} end */
  const where = (x, end) => { let lo = 0, hi = at.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (at[m] < x || (!end && at[m] === x)) lo = m; else hi = m - 1; } return [lo, x - at[lo]]; };
  const spans = [], missing = [];
  for (const w of words) {
    let n = 0;
    for (let i = w ? all.indexOf(w) : -1; i >= 0; i = all.indexOf(w, i + w.length)) { n++; if (spans.length < max) spans.push([...where(i, false), ...where(i + w.length, true)]); }
    if (!n) missing.push(w);
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { spans, missing };
}
/** Words of a find query: lower case, split on spaces, each once. @param {string} q */
export const findWords = q => [...new Set(String(q || '').toLowerCase().split(/\s+/).filter(Boolean))];
/** Indexes of the events whose text holds every word (plain text, any order); the longest word filters first. @param {string[]} texts @param {string[]} words @returns {number[]} */
export function findMatches(texts, words) {
  if (!words.length) return [];
  const [first, ...rest] = [...words].sort((a, b) => b.length - a.length), out = [];
  for (let i = 0; i < texts.length; i++) { const t = texts[i]; if (t && t.includes(first) && rest.every(w => t.includes(w))) out.push(i); }
  return out;
}
/** Position in hits to start at: the last match at or before the anchor event (the previous match, else the bottom of the view), else the first; -1 with no hits. @param {number[]} hits @param {number} anchor */
export function startMatch(hits, anchor) {
  if (!hits.length) return -1;
  let lo = 0, hi = hits.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (hits[m] <= anchor) { at = m; lo = m + 1; } else hi = m - 1; }
  return at < 0 ? 0 : at;
}
/** Next position when stepping dir (1 newer, -1 older) through n matches, wrapping at both ends; -1 with none. @param {number} k @param {number} n @param {number} dir */
export const stepMatch = (k, n, dir) => n ? ((k < 0 ? (dir > 0 ? -1 : 0) : k) + dir + n) % n : -1;
/** Count words beside the find box: "3 of 17", "No match", or nothing for an empty query. @param {number} k @param {number} n @param {string} q */
export const findLabel = (k, n, q) => !findWords(q).length ? '' : n ? `${(k < 0 ? 0 : k) + 1} of ${n.toLocaleString('en-US')}` : 'No match';

/** @typedef {{ s: number, e: number, fold: boolean, grp?: boolean }} Seg */
/** Segments of the transcript, each drawn as one top-level element: a line, a group line, or a folded run of tool calls; unknown kinds are left out; detail draws every call on its own line. @param {any[][]} ev @param {boolean} live @param {boolean} [detail] @returns {Seg[]} */
export function segments(ev, live, detail = false) {
  const runs = foldRuns(ev, FOLD_MIN, live, detail), out = [];
  for (let i = 0; i < ev.length; i++) {
    const j = runs.get(i), k = detail ? i : groupEnd(ev, i);
    if (j) { out.push({ s: i, e: j, fold: true }); i = j - 1; }
    else if (k > i) { out.push({ s: i, e: k, fold: false, grp: true }); i = k - 1; }
    else if (kindOf(ev[i])) out.push({ s: i, e: i + 1, fold: false });
  }
  return out;
}

/** Index of the segment that holds event i, else the first one after it (segs.length past the end). @param {Seg[]} segs @param {number} i */
export function segAt(segs, i) { let lo = 0, hi = segs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].e <= i) lo = m + 1; else hi = m; } return lo; }
/**
 * Segments to draw for a match at event i far above the newest part, which starts at segment tail: about n events either side of it, never reaching the tail.
 * Returns [a, b) as segment indexes; b === tail means the window touches the newest part and both are one.
 * @param {Seg[]} segs @param {number} i @param {number} tail @param {number} n @returns {[number, number]}
 */
export function aroundMatch(segs, i, tail, n) {
  const a = Math.min(segAt(segs, Math.max(0, i - n)), segAt(segs, i)), b = Math.min(tail, Math.max(a + 1, segAt(segs, i + n)));
  return [a, b];
}
/** One group line in the CLI's words; closed it shows only that line, as the CLI does even for failed calls (screen case 54); it expands to every call with its result; branch markers inside follow it. @param {any[][]} ev @param {number} s @param {number} e @param {ViewOpts} [o] */
export function groupHtml(ev, s, e, o = {}) {
  /** @type {number[]} */ const calls = []; let body = '', notes = '';
  for (let j = s; j < e; j++) if (groupKind(ev[j])) { calls.push(j); body += lineHtml(ev, j, { detail: true }); } else if (kindOf(ev[j]) === 'elsewhere') notes += lineHtml(ev, j, o);
  return `<div class="grp" data-i="${s}"><details class="xp" data-x="${s}"${o.xp && o.xp.has(s) ? ' open' : ''}><summary class="ln tool"><span class="g"></span><div class="txt">${esc(groupWords(calls.map(j => groupKind(ev[j]))))}</div></summary>${body}</details>${notes && `<div class="gnote">${notes}</div>`}</div>`;
}
/** Lines and group lines of events s..e. @param {any[][]} ev @param {number} s @param {number} e @param {ViewOpts} o */
function partsHtml(ev, s, e, o) {
  let out = '';
  for (let i = s; i < e; i++) { const k = o.detail ? i : groupEnd(ev, i); if (k > i) { out += groupHtml(ev, i, Math.min(k, e), o); i = k - 1; } else out += lineHtml(ev, i, o); }
  return out;
}
/** HTML of one segment; open holds the start index of each fold the reader opened. @param {any[][]} ev @param {Seg} g @param {Set<number>} open @param {ViewOpts} [o] */
export function segHtml(ev, g, open, o = {}) {
  if (g.grp) return groupHtml(ev, g.s, g.e, o);
  if (!g.fold) return lineHtml(ev, g.s, o);
  const run = ev.slice(g.s, g.e).filter(e => kindOf(e) === 'tool'), bad = run.filter(e => e[4]).length;
  return `<details class="fold" data-at="${g.s}"${open.has(g.s) ? ' open' : ''}><summary class="ln tool${bad ? ' err' : ''}"><span class="g">⏺</span><div class="txt"><b>${run.length} tool calls</b><span class="dim"> · ${esc(toolSummary(run.map(e => toolLabel(e[1], e[5]))))}${bad ? ` · <span class="bad">${bad} failed</span>` : ''}</span></div></summary>${partsHtml(ev, g.s, g.e, o)}</details>`;
}

/** Index of the first event that differs between two transcripts, comparing only the last `tail` shared events plus two anchors; -1 when the head changed too. @param {any[][]} a @param {any[][]} b @param {number} tail */
export function firstChange(a, b, tail = 300) {
  const n = Math.min(a.length, b.length), from = Math.max(0, n - tail);
  /** @param {number} i */
  const same = i => JSON.stringify(a[i]) === JSON.stringify(b[i]);
  if (n && (!same(0) || (from > 0 && !same(from - 1)))) return -1;
  for (let i = from; i < n; i++) if (!same(i)) return i;
  return n;
}
