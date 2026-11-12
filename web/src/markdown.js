// @ts-check
// Safe Markdown for assistant replies in the CLI's plain style: escape first, then a small fixed set of blocks and inline marks.
import { esc } from './util.js';

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;  // opening or closing code fence
const LIST = /^( *)([-*+]|\d{1,9}[.)]) +(.*)$/;  // bullet or numbered item
const HEAD = /^ {0,3}(#{1,6}) +(.*?)(?: +#+)? *$/;  // ATX heading
const QUOTE = /^ {0,3}&gt; ?(.*)$/;  // block quote line, after escaping
const TABLE = /^ {0,3}\|.*\|\s*$/;  // table row, kept as monospace text
const MAX_QUOTE = 4;  // nested quote depth before the rest stays plain text

/** @param {string} u @param {string} t */
const link = (u, t) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`;

/** Inline marks on already escaped text: code spans, links (http/https only), bold, italic. @param {string} s */
export function inline(s) {
  /** @type {string[]} */
  const keep = [];
  const put = (/** @type {string} */ h) => `${keep.push(h) - 1}`;
  const emph = (/** @type {string} */ x) => x
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w])__(?=\S)([^_\n]*?\S)__(?!\w)/g, '$1<b>$2</b>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])?\*(?![*\w])/g, (m, p, b) => b === undefined ? m : `${p}<i>${b}</i>`)
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])?_(?!\w)/g, (m, p, b) => b === undefined ? m : `${p}<i>${b}</i>`);
  const out = s
    .replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${c}</code>`))
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/g, (_, t, u) => put(link(u, emph(t))))
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+?)(?=[.,;:!?]*(?:[\s<>()]|$))/g, (_, p, u) => p + put(link(u, u)));
  /** @param {string} x @returns {string} */
  const back = x => x.replace(/(\d+)/g, (_, i) => back(keep[+i]));
  return back(emph(out));
}

/** Copy control for a code block; the drawer handles the click. */
const COPY = '<button type="button" class="cbtn" data-copy="pre" tabindex="-1" aria-label="Copy code">copy</button>';

/** Escaped lines to block HTML. @param {string[]} L @param {number} depth */
function blocks(L, depth) {
  let out = '', i = 0;
  /** @type {string[]} */
  let para = [];
  const flush = () => { if (para.length) out += `<p>${inline(para.join('\n'))}</p>`; para = []; };
  while (i < L.length) {
    const line = L[i], f = FENCE.exec(line);
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {
      flush(); const mark = f[1], code = []; i++;
      while (i < L.length) { const c = FENCE.exec(L[i]); if (c && c[1][0] === mark[0] && c[1].length >= mark.length && !c[2].trim()) { i++; break; } code.push(L[i++]); }
      out += `<div class="code">${COPY}<pre><code>${code.join('\n')}</code></pre></div>`; continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    const h = HEAD.exec(line);
    if (h) { flush(); out += `<div class="mh h${h[1].length}">${inline(h[2])}</div>`; i++; continue; }
    if (depth < MAX_QUOTE && QUOTE.test(line)) {
      flush(); const q = [];
      while (i < L.length && QUOTE.test(L[i])) q.push(/** @type {RegExpExecArray} */ (QUOTE.exec(L[i++]))[1]);
      out += `<blockquote>${blocks(q, depth + 1)}</blockquote>`; continue;
    }
    if (TABLE.test(line)) {
      flush(); const t = [];
      while (i < L.length && TABLE.test(L[i])) t.push(L[i++]);
      out += `<pre class="tbl">${t.join('\n')}</pre>`; continue;
    }
    const m = LIST.exec(line);
    if (m) {
      flush(); let items = '';
      for (let x = LIST.exec(L[i]); x && i < L.length; x = i < L.length ? LIST.exec(L[i]) : null) {
        const lvl = Math.min(3, Math.floor(x[1].length / 2)), body = [x[3]]; i++;
        while (i < L.length && L[i].trim() && !LIST.exec(L[i]) && !FENCE.test(L[i]) && /^ {2,}/.test(L[i])) body.push(L[i++].trim());
        items += `<div class="li l${lvl}"><span class="lm">${/\d/.test(x[2]) ? x[2] : "-"}</span><span>${inline(body.join('\n'))}</span></div>`;
      }
      out += `<div class="list">${items}</div>`; continue;
    }
    para.push(line); i++;
  }
  flush();
  return out;
}

/** Assistant text to safe HTML: everything escaped first, markers stripped of private-use characters. @param {unknown} t */
export function renderMd(t) {
  const s = esc(String(t ?? '').replace(/[]/g, '').replace(/\r\n?/g, '\n'));
  return blocks(s.split('\n'), 0);
}
