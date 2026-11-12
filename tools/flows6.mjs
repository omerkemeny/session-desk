// @ts-check
// Flows added since QA round 4 that no tool covered: update pill, Legend from Stats, F6 at 390 px, exit texts in two pages, reply box when open
// elsewhere, diverged badge, restart with Stats open and a search typed, odd titles, midnight rollover, 0/1/500 sessions. Real server on invented data.
// Usage: node tools/flows6.mjs [--quick] [--only pill,legend,f6,exits,elsewhere,diverged,restart,titles,midnight,counts]   (exits 1 only when the tool breaks)
import { appendFileSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP, Sess, appCopy, arg, flag, launch, line, makeHome, openPage, sidOf, sleep, startServer, stop, stopTerminals, table } from './qa_lib.mjs';
import { readLine } from './smoke_lib.mjs';

const QUICK = flag('--quick'), ONLY = arg('--only', '').split(',').filter(Boolean);
const rows = /** @type {any[][]} */ ([]);
const check = (/** @type {string} */ flow, /** @type {string} */ name, /** @type {boolean} */ ok, /** @type {any} */ info = '') => { rows.push([flow, name, ok ? 'PASS' : 'FAIL', typeof info === 'string' ? info : JSON.stringify(info).slice(0, 260)]); };
const until = async (/** @type {() => Promise<any>} */ fn, ms = 8000, step = 150) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return Date.now() - t; } catch (e) { /* not yet */ } await sleep(step); } return -1; };
const want = (/** @type {string} */ n) => !ONLY.length || ONLY.includes(n);
const termText = (/** @type {any} */ pg) => pg.ev(`return document.querySelector('#xt .xterm-rows')?.innerText ?? '';`);
const realErrs = (/** @type {any} */ pg) => pg.errs.filter((/** @type {string} */ e) => !/Failed to load resource|net::ERR/.test(e));
const key = async (/** @type {any} */ pg, /** @type {string} */ k, mods = 0) => { const code = k === 'F6' ? 117 : k === 'Tab' ? 9 : 13; for (const type of ['rawKeyDown', 'keyUp']) await pg.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods }); await sleep(150); };
const focused = (/** @type {any} */ pg) => pg.ev(`const e = document.activeElement; return e ? (e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + [...e.classList].join('.')) + (e.dataset.view ? '[' + e.dataset.view + ']' : e.dataset.act ? '[' + e.dataset.act + ']' : '') + (e.closest('#drawer') ? ' in drawer' : '') : '';`);
// Open a session's sidebar on a tab.
async function openSess(/** @type {any} */ pg, /** @type {string} */ id, /** @type {'log'|'term'} */ view) {
  await pg.ev(`const b = document.querySelector('button.row[data-id="${id}"], button.agent[data-id="${id}"]'); if (!b) throw new Error('no button for ${id}'); b.click(); return 1;`); await sleep(500);
  await pg.ev(`document.querySelector('[data-view="${view}"]')?.click(); return 1;`); await sleep(400);
}
// One plain waiting session.
const waiting = (/** @type {any} */ h, /** @type {number} */ i, title = `Flow invented ${i}`, status = /** @type {'idle'|'busy'|null} */ ('idle')) => { const s = new Sess(h.home, '-qa-f6', sidOf(i), h.work, title); s.turn('user', 'invented ask'); s.turn('assistant', 'Invented question?'); if (status) s.live(status); return s; };

// "updated · reload": a page file changes on disk, the pill appears (health is asked at most once a minute), click reloads, pill gone.
async function pill() {
  const h = makeHome(), app = appCopy(); waiting(h, 1);
  const srv = await startServer(h.env, 0, app), pg = await openPage(srv.url); await sleep(3000);
  try {
    check('update pill', 'hidden at start', await pg.ev(`return document.getElementById('upd').hidden;`));
    const f = join(app, 'web', 'styles', 'base.css'); appendFileSync(f, '\n/* qa touch */\n'); const t = new Date(); utimesSync(f, t, t);
    const shown = await until(() => pg.ev(`return !document.getElementById('upd').hidden;`), 75000, 500);
    check('update pill', 'appears after a page file changes (<= 80 s: health is asked once a minute, plus the tick)', shown >= 0 && shown < 80000, { ms: shown });
    const reqs0 = pg.net.by['/'] || 0;
    await pg.ev(`document.getElementById('upd').click(); return 1;`); await sleep(3500);
    check('update pill', 'click reloads and the pill is gone', (pg.net.by['/'] || 0) > reqs0 && await pg.ev(`return document.getElementById('upd').hidden && document.getElementById('mode').textContent === 'live';`), { reloads: (pg.net.by['/'] || 0) - reqs0 });
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env, app); }
}

// Legend from the Stats panel: link present, opens legend.html, every section renders, no console error, fits at 390 px.
async function legend() {
  const h = makeHome(); waiting(h, 2);
  const srv = await startServer(h.env);
  try {
    const pg = await openPage(srv.url); await sleep(3000);
    await pg.ev(`document.querySelector('.us-btn').click(); return 1;`); await sleep(1500);
    const link = await pg.ev(`const a = [...document.querySelectorAll('.us a')].find(a => /legend/i.test(a.textContent)); return a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel, visible: !!a.offsetParent } : null;`);
    check('legend', 'Stats panel has a visible Legend link', !!link && link.visible && /legend\.html$/.test(link.href), link);
    await pg.close();
    for (const w of QUICK ? [390] : [1280, 390]) for (const dark of [true, false]) {
      const lg = await openPage(srv.url + 'legend.html', { width: w, height: w < 600 ? 844 : 1000, dark }); await sleep(3000);
      const m = await lg.ev(`const hs = [...document.querySelectorAll('h1,h2,h3')].map(x => +x.tagName[1]); let jump = 0; for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) jump++;
        const cv = [...document.querySelectorAll('canvas')], blank = cv.filter(c => { try { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; for (let i = 3; i < d.length; i += 16) if (d[i]) return false; return true; } catch (e) { return false; } }).length;
        return { sections: document.querySelectorAll('section, h2').length, h1: hs.filter(x => x === 1).length, jumps: jump, canvases: cv.length, blank, overflow: document.documentElement.scrollWidth - innerWidth, bg: getComputedStyle(document.body).backgroundColor };`);
      const errs = realErrs(lg);
      check(`legend ${w}px ${dark ? 'dark' : 'light'}`, 'renders, one h1, no heading jumps, no blank canvas, no overflow, no errors', m.h1 === 1 && !m.jumps && !m.blank && m.overflow <= 0 && !errs.length, { ...m, errs: errs.slice(0, 2) });
      await lg.close();
    }
  } finally { await stop(srv.proc); stopTerminals(h.env); }
}

// F6 and Shift+F6 in the Terminal tab at 390 px: out to the tabs, to the footer, back into the terminal.
async function f6() {
  const h = makeHome(); waiting(h, 3);
  const srv = await startServer(h.env), pg = await openPage(srv.url, { width: 390, height: 844 }); await sleep(3000);
  try {
    await openSess(pg, sidOf(3), 'term'); await until(async () => /cli ready/.test(await termText(pg)), 8000);
    await pg.ev(`document.querySelector('#xt textarea')?.focus(); return 1;`);
    const a = await focused(pg); await key(pg, 'F6'); const b = await focused(pg);
    check('F6 390px', 'F6 leaves the terminal for the sidebar tabs', /textarea/.test(a) && /\[(term|log)\]|tab/.test(b), { from: a, to: b });
    await key(pg, 'F6'); const c = await focused(pg);
    check('F6 390px', 'F6 on the tabs goes back into the terminal', /xterm-helper-textarea/.test(c), { to: c });
    await key(pg, 'F6', 8); const d = await focused(pg);
    check('F6 390px', 'Shift+F6 from the terminal goes to the footer', /endterm|home|xtnote|tfoot/.test(d), { to: d });
    await pg.ev(`document.querySelector('#xt textarea')?.focus(); return 1;`); await key(pg, 'ArrowLeft', 2 + 8);
    check('F6 390px', 'Ctrl+Shift+Left also leaves', !/xterm-helper-textarea/.test(await focused(pg)), { to: await focused(pg) });
    const over = await pg.ev(`return document.documentElement.scrollWidth - innerWidth;`);
    check('F6 390px', 'no horizontal overflow with the terminal open', over <= 0, { overflow: over });
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Exit texts in two pages: End terminal, CLI exit code 3, terminal host killed.
async function exits() {
  const h = makeHome(); waiting(h, 4);
  const srv = await startServer(h.env), a = await openPage(srv.url), b = await openPage(srv.url); await sleep(3000);
  const tail = async (/** @type {any} */ pg) => (await termText(pg)).split('\n').filter(l => l.trim()).slice(-1)[0] || '';
  const both = async () => { for (const pg of [a, b]) { await openSess(pg, sidOf(4), 'term'); await until(async () => /cli ready/.test(await termText(pg)), 8000); } };
  try {
    await both();
    await a.ev(`document.querySelector('#drawer [data-act="endterm"]').click(); return 1;`);
    await until(async () => /ended|stopped/i.test(await tail(b)), 8000);
    const e1 = [await a.ev(`return document.getElementById('drawer').innerText.replace(/\\s+/g, ' ').slice(0, 140);`), await tail(b)];
    check('exit texts', 'End terminal: other page says "Terminal ended"', /Terminal ended/.test(e1[1]), { pageB: e1[1] });
    for (const pg of [a, b]) await pg.ev(`document.querySelector('[data-act="close"]')?.click(); return 1;`);
    await sleep(800); await both();
    await a.ev(`document.querySelector('#xt textarea')?.focus(); return 1;`); await a.send('Input.insertText', { text: 'EXIT3' }); await key(a, 'Enter');
    await until(async () => /code 3/.test(await tail(a)) && /code 3/.test(await tail(b)), 8000);
    const e2 = [await tail(a), await tail(b)];
    check('exit texts', 'CLI exit 3: both pages say "CLI ended (code 3)"', e2.every(t => /CLI ended \(code 3\)/.test(t)), { a: e2[0], b: e2[1] });
    for (const pg of [a, b]) await pg.ev(`document.querySelector('[data-act="close"]')?.click(); return 1;`);
    await sleep(800); await both();
    const hp = (await (await fetch(srv.url + 'api/health')).json()).termhost.pid; if (hp) process.kill(hp, 'SIGKILL');
    await until(async () => /host stopped|ended/i.test(await tail(a)) && /host stopped|ended/i.test(await tail(b)), 12000);
    const e3 = [await tail(a), await tail(b)];
    check('exit texts', 'host killed: both pages say "Terminal host stopped"', !!hp && e3.every(t => /Terminal host stopped/.test(t)), { hostPid: hp, a: e3[0], b: e3[1] });
    check('exit texts', 'no script errors', !realErrs(a).length && !realErrs(b).length, [...realErrs(a), ...realErrs(b)].slice(0, 3));
  } finally { await a.close(); await b.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Quick reply while the session is open in another program: box off with its reason.
async function elsewhereReply() {
  const h = makeHome(), s = waiting(h, 5, 'Open elsewhere invented', null);
  const reg = join(h.home, 'sessions'); mkdirSync(reg, { recursive: true });
  writeFileSync(join(reg, 'qa-desktop.json'), JSON.stringify({ pid: process.pid, sessionId: s.sid, status: 'idle', statusUpdatedAt: Date.now(), entrypoint: 'claude-desktop' }));
  const srv = await startServer(h.env), pg = await openPage(srv.url); await sleep(3000);
  try {
    await openSess(pg, sidOf(5), 'log'); await sleep(600);
    const r = await pg.ev(`const t = document.getElementById('reply'); return { disabled: t ? t.disabled : null, why: t ? t.placeholder : '', badge: [...document.querySelectorAll('#drawer .chip, #drawer .badge, #drawer [class*=twice]')].map(x => x.textContent.trim()).join(' | '), warn: document.getElementById('drawer').innerText.match(/Also open[^.]*\\./)?.[0] || '' };`);
    check('reply elsewhere', 'reply box off with a reason naming the other program', r.disabled === true && /elsewhere|desktop|another|open/i.test(r.why), r);
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Diverged: a desktop-app branch off an early row, then the CLI continues; the row shows the badge and the sidebar the sync line.
async function divergedFlow() {
  const h = makeHome(), s = new Sess(h.home, '-qa-f6', sidOf(6), h.work, 'Diverged invented');
  s.turn('user', 'invented ask one'); s.turn('assistant', 'Invented answer one.'); const fork = s.last;
  appendFileSync(s.file, line('user', 'desk-b1', fork, h.work, 'typed in the desktop app', { entrypoint: 'claude-desktop' }));
  appendFileSync(s.file, line('assistant', 'desk-b2', 'desk-b1', h.work, 'desktop answer', { entrypoint: 'claude-desktop' }));
  s.last = fork; s.turn('user', 'cli continues'); s.turn('assistant', 'CLI answer. Next?');
  const srv = await startServer(h.env), pg = await openPage(srv.url); await sleep(3000);
  try {
    const api = (await (await fetch(srv.url + 'api/sessions')).json()).find((/** @type {any} */ x) => x.id === sidOf(6));
    const badge = await pg.ev(`const r = document.querySelector('.lists .row[data-id="${sidOf(6)}"]'); return r ? r.innerText.replace(/\\s+/g, ' ').slice(0, 120) : '';`);
    check('diverged', 'server says diverged and the row shows the badge', api?.consistency === 'diverged' && /diverged/.test(badge), { consistency: api?.consistency, row: badge });
    await openSess(pg, sidOf(6), 'log'); await sleep(800);
    const sync = await pg.ev(`const e = document.getElementById('sync'); return { hidden: e?.hidden, text: e?.innerText.trim().slice(0, 160) || '', inLog: /desktop app|elsewhere/i.test(document.getElementById('term')?.innerText || '') };`);
    check('diverged', 'sidebar shows the sync line or the left-out branch', !sync.hidden && !!sync.text || sync.inLog, sync);
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Server restart while the Stats panel is open and while a search is typed.
async function restart() {
  const h = makeHome(); for (let i = 7; i < 10; i++) waiting(h, i);
  let srv = await startServer(h.env); const pg = await openPage(srv.url); await sleep(3000);
  try {
    await pg.ev(`const s = document.getElementById('search'); s.value = 'Flow invented 8'; s.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.us-btn').click(); return 1;`); await sleep(2500);
    const m0 = await pg.ev(`return { hits: document.getElementById('hits').textContent, rows: [...document.querySelectorAll('.lists .row[data-id]')].filter(r => r.offsetParent).length };`);
    const port = srv.port; await stop(srv.proc, 5000); await sleep(1500);
    const off = await until(() => pg.ev(`return /offline/.test(document.getElementById('mode').textContent);`), 8000);
    srv = await startServer(h.env, port);
    const back = await until(() => pg.ev(`return document.getElementById('mode').textContent === 'live';`), 15000, 250);
    await sleep(1500);
    const m = await pg.ev(`const us = document.querySelector('.us'); return { search: document.getElementById('search').value, rows: [...document.querySelectorAll('.lists .row[data-id]')].filter(r => r.offsetParent).length, stats: us ? !us.hidden : false, statsText: us ? us.innerText.replace(/\\s+/g, ' ').slice(0, 80) : '', hits: document.getElementById('hits').textContent, toast: document.getElementById('toast').textContent };`);
    check('restart', 'offline shown, then live again', off >= 0 && back >= 0, { offlineMs: off, backMs: back });
    check('restart', 'search text and its filter survive', m.search === 'Flow invented 8' && m.hits === m0.hits && m.rows === m0.rows, { before: m0.hits, after: m.hits, rows: m.rows });
    check('restart', 'Stats panel still open and filled', m.stats && /Sessions|Today/.test(m.statsText), { stats: m.stats, text: m.statsText });
    check('restart', 'no script errors', !realErrs(pg).length, realErrs(pg).slice(0, 3));
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Titles made only of a pasted block, a slash command, empty, right-to-left, emoji, 300 characters (first prompt, no custom title).
async function titles() {
  const h = makeHome(), dir = join(h.home, 'projects', '-qa-titles'); mkdirSync(dir, { recursive: true });
  const cases = [['pasted block', Array.from({ length: 40 }, (_, i) => `pasted line ${i} of an invented log`).join('\n')], ['slash command', '<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args></command-args>'],
    ['empty', ''], ['right-to-left', 'תקן את הבאג בדף ההתחברות שלנו'], ['emoji', '🚀🎉 ship it 👩‍💻'], ['300 characters', 'Long invented title '.repeat(15)]];
  cases.forEach(([, text], i) => { const id = sidOf(20 + i); writeFileSync(join(dir, id + '.jsonl'), line('user', 'u' + i, null, h.work, text) + line('assistant', 'a' + i, 'u' + i, h.work, 'Invented answer?'));
    const reg = join(h.home, 'sessions'); mkdirSync(reg, { recursive: true }); writeFileSync(join(reg, `qa-t${i}.json`), JSON.stringify({ pid: process.pid, sessionId: id, status: 'idle', statusUpdatedAt: Date.now(), entrypoint: 'cli' })); });
  const srv = await startServer(h.env); const api = await (await fetch(srv.url + 'api/sessions')).json();
  for (const w of QUICK ? [390] : [1280, 390]) {
    const pg = await openPage(srv.url, { width: w, height: w < 600 ? 844 : 1000 }); await sleep(4000);
    try {
      for (const [name] of cases) {
        const i = cases.findIndex(c => c[0] === name), id = sidOf(20 + i), t = (api.find((/** @type {any} */ x) => x.id === id) || {}).title;
        const m = await pg.ev(`const r = document.querySelector('.lists .row[data-id="${id}"]'), a = document.querySelector('#actors .agent[data-id="${id}"]'), g = document.getElementById('garden').getBoundingClientRect();
          const tag = a?.querySelector('.tag')?.getBoundingClientRect(); return { row: r ? r.innerText.split('\\n')[0].slice(0, 50) : null, tag: a?.querySelector('.tag')?.innerText.slice(0, 40) ?? null, tagOut: tag ? tag.left < g.left - 1 || tag.right > g.right + 1 : false, label: (a?.getAttribute('aria-label') || '').slice(0, 60), overflow: document.documentElement.scrollWidth - innerWidth };`);
        const ok = typeof t === 'string' && t.trim().length > 0 && t.length <= 200 && !/<command-|\n/.test(t) && (!!m.row || !!m.label) && !/^\s*:/.test(m.label) && !m.tagOut && m.overflow <= 0;
        check(`titles ${w}px`, name, ok, { api: String(t).slice(0, 50), apiLen: String(t).length, ...m });
      }
    } finally { await pg.close(); }
  }
  await stop(srv.proc); stopTerminals(h.env);
}

// Midnight: page and server clocks move to 23:59:40 Israel time (server through a time.time offset); sessions carry real token counts today and yesterday,
// so the Today card must read non-zero before midnight and zero after, with no data change; the header's tokens are all-time and stay.
async function midnight() {
  const h = makeHome(), big = { input_tokens: 600000, output_tokens: 150000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  // An assistant row with a large usage, written at time `at`.
  const heavy = (/** @type {any} */ s, /** @type {Date} */ at) => { const r = JSON.parse(line('assistant', `${s.sid.slice(0, 8)}-${++s.n}`, s.last, h.work, 'Invented heavy answer.')); r.timestamp = at.toISOString(); r.sessionId = s.sid; r.message.usage = big; s.last = r.uuid; appendFileSync(s.file, JSON.stringify(r) + '\n'); };
  const today = waiting(h, 30, 'Midnight invented today'); heavy(today, new Date()); heavy(today, new Date());
  const y = new Sess(h.home, '-qa-f6', sidOf(31), h.work, 'Midnight invented yesterday'), then = new Date(Date.now() - 26 * 3600e3);
  y.turn('user', 'old ask'); heavy(y, then); heavy(y, then); utimesSync(y.file, then, then);
  // Offset so both clocks read 23:59:40 Israel time of today's Israel date.
  const il = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const p = Object.fromEntries(il.map(x => [x.type, x.value])), secs = +p.hour * 3600 + +p.minute * 60 + +p.second, off = (86380 - secs) * 1000;
  const wrap = join(h.state, 'clock_shift.py');
  writeFileSync(wrap, `import os, runpy, sys, time\noff = float(os.environ["QA_CLOCK_OFFSET"]) / 1000\n_t = time.time\ntime.time = lambda: _t() + off\nsys.argv = sys.argv[1:]\nsys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[0])))\nrunpy.run_path(sys.argv[0], run_name="__main__")\n`);
  const proc = launch('python3', [wrap, join(APP, 'server.py')], { cwd: APP, stdio: ['ignore', 'pipe', 'ignore'], env: { ...h.env, PORT: '0', QA_CLOCK_OFFSET: String(off) } });
  const m = await readLine(proc, /127\.0\.0\.1:(\d+)/, 15000); if (!m) throw new Error('server.py did not start under the clock shift');
  const url = `http://127.0.0.1:${m[1]}/`; await until(async () => (await fetch(url + 'api/health')).ok, 10000, 100);
  const pg = await openPage('about:blank', { probes: true });
  await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const D = Date, off = ${off}; class FD extends D { constructor(...a) { if (a.length) super(...a); else super(D.now() + off); } static now() { return D.now() + off; } } window.Date = FD; })();` });
  await pg.send('Page.navigate', { url }); await until(() => pg.ev(`return document.getElementById('mode').textContent === 'live';`), 10000, 100);
  try {
    const read = () => pg.ev(`document.querySelector('.us-btn').click(); await new Promise(r => setTimeout(r, 1500)); const c = document.querySelector('.us-today'); const t = c ? c.innerText.replace(/\\s+/g, ' ').slice(0, 200) : ''; const tok = c ? c.querySelector('.us-facts b')?.textContent : ''; document.querySelector('.us .us-x')?.click(); return { today: t, tokens: tok, sum: document.getElementById('sum').textContent, clock: document.getElementById('wx').textContent.slice(0, 20) };`);
    const before = await read(); await sleep(QUICK ? 60000 : 80000); const after = await read();
    check('midnight', 'clock crosses midnight on the page', /00:0\d/.test(after.clock), { before: before.clock, after: after.clock });
    check('midnight', 'Today card tokens non-zero before midnight', !!before.tokens && before.tokens !== '0', before.tokens);
    check('midnight', 'Today card tokens zero after midnight, with no data change', after.tokens === '0', { before: before.tokens, after: after.tokens, card: after.today.slice(0, 100) });
    check('midnight', 'header tokens are all-time and stay the same', before.sum === after.sum && /token/.test(after.sum), { before: before.sum, after: after.sum });
  } finally { await pg.close(); await stop(proc); stopTerminals(h.env); }
}

// 0, 1 and 500 sessions: no errors, the right empty texts, answer and render times.
async function counts() {
  for (const n of QUICK ? [0, 1] : [0, 1, 500]) {
    const h = makeHome(); if (n === 0) { const { rmSync } = await import('node:fs'); rmSync(join(h.home, 'projects'), { recursive: true, force: true }); rmSync(join(h.home, 'sessions'), { recursive: true, force: true }); }
    for (let i = 0; i < n; i++) waiting(h, 1000 + i, `Count invented ${i}`, i % 5 === 4 ? 'busy' : 'idle');
    const srv = await startServer(h.env), t0 = Date.now(), api = await (await fetch(srv.url + 'api/sessions')).json(), apiMs = Date.now() - t0;
    const pg = await openPage(srv.url), nav = Date.now();
    const ready = await until(() => pg.ev(`return document.getElementById('mode').textContent === 'live' && !/Loading/.test(document.getElementById('lists').textContent);`), 20000, 50);
    await sleep(2500);
    const m = await pg.ev(`return { chars: document.querySelectorAll('#actors .agent:not(.miner)').length, miners: document.querySelectorAll('#actors .agent.miner').length, sign: document.getElementById('sign').textContent, quiet: !document.getElementById('quiet').hidden, sum: document.getElementById('sum').textContent, rows: document.querySelectorAll('.lists .row[data-id]').length, none: [...document.querySelectorAll('.lists .none')].filter(x => x.offsetParent).map(x => x.textContent).join(' | ').slice(0, 100) };`);
    check(`${n} sessions`, 'page live, no script errors', ready >= 0 && !realErrs(pg).length, { apiRows: api.length, apiMs, readyMs: ready >= 0 ? Date.now() - nav : -1, errs: realErrs(pg).slice(0, 2) });
    check(`${n} sessions`, n === 0 ? 'quiet garden and empty texts' : n === 1 ? 'one character, sign says 1' : 'garden capped, sign counts the rest', n === 0 ? m.quiet && m.chars === 0 : n === 1 ? m.chars === 1 : m.chars <= 24 && /\+\d+/.test(m.sign), m);
    await pg.close(); await stop(srv.proc); stopTerminals(h.env);
  }
}

const FLOWS = /** @type {Array<[string, () => Promise<void>]>} */ ([['pill', pill], ['legend', legend], ['f6', f6], ['exits', exits], ['elsewhere', elsewhereReply], ['diverged', divergedFlow], ['restart', restart], ['titles', titles], ['midnight', midnight], ['counts', counts]]);
let broke = 0;
for (const [n, fn] of FLOWS) if (want(n)) { try { await fn(); } catch (e) { broke++; rows.push([n, 'tool error', 'ERROR', /** @type {Error} */ (e).message.slice(0, 160)]); } }
console.log(table(['flow', 'check', 'result', 'measured'], rows));
console.log(`\n${rows.filter(r => r[2] === 'FAIL').length} failed, ${rows.filter(r => r[2] === 'PASS').length} passed${broke ? `, ${broke} flows could not run` : ''}`);
process.exit(broke ? 1 : 0);
