// @ts-check
// Flow checks no smoke test covers: quick reply (ok and failing), Send home and Wake up, Reload terminal when behind, two pages at once,
// search text that needs escaping, HTML and long unbroken strings in session fields, 200 waiting sessions. Real server on invented data.
// Usage: node tools/flows.mjs [--quick] [--only name,name]   (exits 1 only when the tool itself breaks)
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sess, arg, flag, line, makeHome, openPage, sidOf, sleep, startServer, stop, stopTerminals, table } from './qa_lib.mjs';

const QUICK = flag('--quick'), ONLY = arg('--only', '').split(',').filter(Boolean);
const rows = /** @type {any[][]} */ ([]);
const check = (/** @type {string} */ flow, /** @type {string} */ name, /** @type {boolean} */ ok, /** @type {any} */ info = '') => { rows.push([flow, name, ok ? 'PASS' : 'FAIL', typeof info === 'string' ? info : JSON.stringify(info)]); };
// Wait until fn() is truthy; returns ms taken or -1.
const until = async (/** @type {() => Promise<any>} */ fn, ms = 8000, step = 150) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return Date.now() - t; } catch (e) { /* not yet */ } await sleep(step); } return -1; };
const want = (/** @type {string} */ n) => !ONLY.length || ONLY.includes(n);

// Terminal text in a page.
const termText = (/** @type {any} */ pg) => pg.ev(`return document.querySelector('#xt .xterm-rows')?.innerText ?? '';`);
// Type a line into the page terminal.
async function typeTerm(/** @type {any} */ pg, /** @type {string} */ text) {
  await pg.ev(`document.querySelector('#xt textarea')?.focus(); return 1;`); await pg.send('Input.insertText', { text });
  await pg.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
// Open a session's sidebar on a tab.
async function openSess(/** @type {any} */ pg, /** @type {string} */ id, /** @type {'log'|'term'} */ view) {
  await pg.ev(`const b = document.querySelector('button.row[data-id="${id}"], button.agent[data-id="${id}"]'); if (!b) throw new Error('no button for ${id}'); b.click(); return 1;`); await sleep(500);
  await pg.ev(`document.querySelector('[data-view="${view}"]')?.click(); return 1;`); await sleep(400);
}

// Quick reply through the stub: text reaches it, the reply shows, a failing run shows its error.
async function quickReply() {
  const h = makeHome(), s = new Sess(h.home, '-qa-reply', sidOf(1), h.work, 'Reply flow invented'); s.turn('user', 'invented ask'); s.turn('assistant', 'Invented question for you?');
  const srv = await startServer(h.env), pg = await openPage(srv.url); await sleep(3000);
  try {
    await openSess(pg, sidOf(1), 'log');
    const box = await pg.ev(`const r = document.getElementById('reply'); return r ? { disabled: r.disabled, ph: r.placeholder } : null;`);
    check('quick reply', 'reply box enabled on a resting session', !!box && !box.disabled, box);
    const send = async (/** @type {string} */ t) => { await pg.ev(`const r = document.getElementById('reply'); r.focus(); r.value = ${JSON.stringify(t)}; r.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
      await pg.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await pg.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
    await send('invented reply one');
    const got = await until(async () => existsSync(h.log) && readFileSync(h.log, 'utf8').includes('invented reply one'), 6000);
    check('quick reply', 'sent text reaches the stub CLI', got >= 0, { ms: got });
    const shown = await until(async () => pg.ev(`await new Promise(r => setTimeout(r, 0)); const s = desk.S.find(x => x.id === '${sidOf(1)}'); return (document.getElementById('term')?.innerText || '').includes('stub answer invented reply one');`), 10000);
    check('quick reply', 'reply shows in the Transcript tab', shown >= 0, { ms: shown, toast: await pg.ev(`return document.getElementById('toast').textContent;`) });
    // A failing run: the stub exits 3 when the text holds FAIL.
    await until(async () => pg.ev(`const r = document.getElementById('reply'); return r && !r.disabled;`), 8000);
    await send('please FAIL now');
    const err = await until(async () => pg.ev(`return [...document.querySelectorAll('#drawer .needs')].some(n => /refused|failed|error|exit/i.test(n.textContent));`), 10000);
    const errText = await pg.ev(`return [...document.querySelectorAll('#drawer .needs')].map(n => n.textContent.trim()).filter(Boolean).join(' | ').slice(0, 200);`);
    check('quick reply', 'error text shows when the CLI exits non-zero', err >= 0, { ms: err, text: errText });
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Send home hides the character in town; Wake up from its Transcript tab brings it back.
async function sendHome() {
  const h = makeHome(), s = new Sess(h.home, '-qa-home', sidOf(2), h.work, 'Home flow invented'); s.turn('user', 'invented ask'); s.turn('assistant', 'Invented question?'); s.live('idle');
  const srv = await startServer(h.env), pg = await openPage(srv.url); await sleep(3500);
  try {
    const id = sidOf(2), inGarden = () => pg.ev(`return !!document.querySelector('#actors .agent:not(.miner):not(.bye)[data-id="${id}"]');`);
    check('send home', 'waiting session stands in the garden', await inGarden());
    await openSess(pg, id, 'log');
    const hb = await pg.ev(`const b = document.querySelector('#drawer [data-act="home"]'); if (b) b.click(); return !!b;`);
    check('send home', 'Send home button in the Transcript tab', hb);
    const gone = await until(async () => !(await inGarden()), 6000);
    const after = await pg.ev(`return { toast: document.getElementById('toast').textContent, saved: localStorage.getItem('sentHome') || '', sign: document.getElementById('sign').textContent, row: !!document.querySelector('button.row[data-id="${id}"]') };`);
    check('send home', 'character leaves the garden and the choice is saved', gone >= 0 && after.saved.includes(id.slice(0, 8)) || gone >= 0 && after.saved.length > 2, { ms: gone, ...after, saved: after.saved.length });
    await sleep(3000);
    // Survives a page reload and the next poll.
    await pg.send('Page.reload'); await sleep(3500);
    check('send home', 'still home after a reload', !(await inGarden()), await pg.ev(`return document.getElementById('sign').textContent;`));
    check('send home', 'listed somewhere so it can be woken', after.row || await pg.ev(`return !!document.querySelector('button[data-id="${id}"]');`));
    await openSess(pg, id, 'log');
    const wb = await pg.ev(`const b = document.querySelector('#drawer [data-act="wake"]'); if (b) b.click(); return !!b;`);
    check('send home', 'Wake up button in the Transcript tab', wb, await pg.ev(`return [...document.querySelectorAll('#drawer .needs button')].map(b => b.textContent);`));
    const back = await until(inGarden, 6000);
    check('send home', 'Wake up brings it back to the garden', back >= 0, { ms: back });
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Reload terminal: the page terminal idles while another program writes; the button restarts it on the newest state.
async function reloadTerm() {
  const h = makeHome(), s = new Sess(h.home, '-qa-behind', sidOf(3), h.work, 'Behind flow invented'); s.turn('user', 'invented ask'); s.turn('assistant', 'Invented question?');
  const srv = await startServer(h.env), pg = await openPage(srv.url); await sleep(3000);
  try {
    const id = sidOf(3);
    await openSess(pg, id, 'term');
    const t1 = await until(async () => /cli ready/.test(await termText(pg)), 8000);
    check('reload terminal', 'stub terminal starts', t1 >= 0);
    const pid1 = ((await termText(pg)).match(/cli ready (\d+)/) || [])[1];
    await sleep(4000);
    appendFileSync(s.file, line('user', 'desk-u1', s.last, h.work, 'typed in the other window', { entrypoint: 'claude-desktop' }));
    appendFileSync(s.file, line('assistant', 'desk-a1', 'desk-u1', h.work, 'answer in the other window', { entrypoint: 'claude-desktop' }));
    const seen = await until(async () => pg.ev(`return !!document.querySelector('#drawer [data-act="reterm"]');`), 10000);
    const sync = await pg.ev(`return document.getElementById('sync')?.textContent?.trim() || '';`);
    check('reload terminal', 'behind note with Reload terminal appears', seen >= 0, { ms: seen, sync });
    if (seen >= 0) {
      await pg.ev(`document.querySelector('#drawer [data-act="reterm"]').click(); return 1;`);
      const re = await until(async () => { const m = (await termText(pg)).match(/cli ready (\d+)/g) || []; return m.some(x => !x.endsWith(' ' + pid1)); }, 10000);
      const after = await pg.ev(`return { toast: document.getElementById('toast').textContent, sync: document.getElementById('sync')?.textContent?.trim() || '', hidden: document.getElementById('sync')?.hidden };`);
      check('reload terminal', 'terminal restarts on a new CLI process', re >= 0, { ms: re, ...after });
      check('reload terminal', 'behind note clears after reload', !!after.hidden || !after.sync, after);
    }
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Two pages on one server: both update, both attach the same terminal, ending it in one ends it in the other.
async function twoPages() {
  const h = makeHome(), s = new Sess(h.home, '-qa-two', sidOf(4), h.work, 'Two pages invented'); s.turn('user', 'invented ask'); s.turn('assistant', 'Invented question?');
  const srv = await startServer(h.env), a = await openPage(srv.url), b = await openPage(srv.url); await sleep(3500);
  try {
    const n = new Sess(h.home, '-qa-two', sidOf(5), h.work, 'Appeared while both open'); n.turn('user', 'invented'); n.turn('assistant', 'invented?');
    const has = (/** @type {any} */ pg) => pg.ev(`return !!document.querySelector('button.row[data-id="${sidOf(5)}"]');`);
    const ta = await until(() => has(a), 8000), tb = await until(() => has(b), 8000);
    check('two pages', 'a new session shows in both pages', ta >= 0 && tb >= 0, { a: ta, b: tb });
    const health = await (await fetch(srv.url + 'api/health')).json();
    check('two pages', 'two change-feed listeners', health.events.clients === 2, health.events);
    await openSess(a, sidOf(4), 'term'); const ra = await until(async () => /cli ready/.test(await termText(a)), 8000);
    await openSess(b, sidOf(4), 'term'); const rb = await until(async () => /cli ready/.test(await termText(b)), 8000);
    check('two pages', 'terminal attaches in both pages', ra >= 0 && rb >= 0, { a: ra, b: rb });
    await typeTerm(a, 'from page a');
    const echoB = await until(async () => /got from page a/.test(await termText(b)), 6000);
    check('two pages', 'typing in one page shows in the other', echoB >= 0, { ms: echoB });
    const procs = (await (await fetch(srv.url + 'api/health')).json()).terms;
    check('two pages', 'one CLI process for the session', procs === 1, { terms: procs });
    await a.ev(`document.querySelector('#drawer [data-act="endterm"]').click(); return 1;`);
    const endB = await until(async () => /Terminal ended|CLI ended|no longer running/.test(await termText(b)), 8000);
    check('two pages', 'End terminal in one page ends it in the other', endB >= 0 && !/Terminal host stopped/.test(await termText(b)), { ms: endB, tail: (await termText(b)).split('\n').filter(l => l.trim()).slice(-2).join(' / ').slice(0, 160) });
    const errs = [...a.errs, ...b.errs].filter(e => !/Failed to load resource/.test(e));
    check('two pages', 'no page errors', errs.length === 0, errs.slice(0, 3));
  } finally { await a.close(); await b.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Search text that needs escaping: no markup injected, counts right, a 2,000-character query stays fast.
async function searchEscape() {
  const h = makeHome(), s = new Sess(h.home, '-qa-search', sidOf(6), h.work, 'Tom & Jerry <b>bold</b> "quoted" it\'s'); s.turn('user', 'invented a < b && c > d'); s.turn('assistant', 'Invented 5 < 6 & "ok"');
  const srv = await startServer(h.env), pg = await openPage(srv.url); await sleep(3000);
  try {
    const q = async (/** @type {string} */ text) => pg.ev(`const s = document.getElementById('search'), t0 = performance.now(); s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event('input', { bubbles: true }));
      const ms = performance.now() - t0; await new Promise(r => setTimeout(r, 150));
      return { ms: Math.round(ms * 10) / 10, rows: [...document.querySelectorAll('.lists .row:not(.gone)')].map(r => r.dataset.id), hits: document.getElementById('hits').textContent, injected: document.querySelectorAll('#lists b:not(.num), #hits b, #lists img, #hits img, #lists script').length,
        none: [...document.querySelectorAll('.lists .none:not([hidden])')].map(n => n.textContent).join(' | ').slice(0, 120), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };`);
    for (const t of ['<b>', 'Tom & Jerry', '"quoted"', "it's", 'a < b && c', '<img src=x onerror=window.__pwn=1>']) {
      const r = await q(t), hit = r.rows.includes(sidOf(6));
      const expect = !/img/.test(t);
      check('search escaping', `query ${JSON.stringify(t)}`, r.injected === 0 && hit === expect && !(await pg.ev('return !!window.__pwn;')), { hit, ms: r.ms, injected: r.injected, hits: r.hits.slice(0, 60) });
    }
    const long = 'x'.repeat(1990) + ' <&>"\'';
    const r = await q(long);
    check('search escaping', '2,000-character query', r.injected === 0 && r.ms < 100 && r.overflow <= 0, { ms: r.ms, overflow: r.overflow, none: r.none.length });
    await q('');
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// HTML and very long unbroken strings in title, project and last message: no markup, no horizontal overflow.
async function hostileFields() {
  const h = makeHome(), long = 'W'.repeat(400), cwd = join(h.work, 'proj_' + 'L'.repeat(180) + '<i>x</i>');
  const ids = [sidOf(7), sidOf(8)];
  const a = new Sess(h.home, '-qa-hostile', ids[0], cwd, `<img src=x onerror="window.__pwn=1"><b>Bold</b> ${long}`); a.turn('user', `<script>window.__pwn=2</script> ${long}`); a.turn('assistant', `<a href="javascript:alert(1)">x</a> ${long} &amp; done?`); a.live('idle');
  const b = new Sess(h.home, '-qa-hostile', ids[1], cwd, `Plain title ${long}`); b.turn('user', 'ok'); b.turn('assistant', `Last ${long}`);
  const srv = await startServer(h.env);
  for (const w of QUICK ? [1280] : [1280, 390]) {
    const pg = await openPage(srv.url, { width: w, height: w < 600 ? 844 : 1000 }); await sleep(3500);
    try {
      const m = await pg.ev(`const doc = document.documentElement, wide = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !e.closest('#garden') && getComputedStyle(e).position !== 'fixed'; }).slice(0, 4).map(e => e.tagName.toLowerCase() + '.' + [...e.classList].join('.') + ' ' + Math.round(e.getBoundingClientRect().right));
        return { overflow: doc.scrollWidth - doc.clientWidth, wide, pwn: window.__pwn || 0, imgs: document.querySelectorAll('#lists img, #actors img, #hits img').length, links: document.querySelectorAll('#lists a, #actors a').length,
          tag: Math.round(document.querySelector('#actors .agent:not(.miner) .tag')?.getBoundingClientRect().width || 0), garden: Math.round(document.getElementById('garden').getBoundingClientRect().width) };`);
      check(`hostile fields ${w}px`, 'no markup from session fields runs or renders', m.pwn === 0 && m.imgs === 0 && m.links === 0, { pwn: m.pwn, imgs: m.imgs, links: m.links });
      check(`hostile fields ${w}px`, 'page has no horizontal overflow', m.overflow <= 0 && !m.wide.length, { overflow: m.overflow, wide: m.wide });
      check(`hostile fields ${w}px`, 'garden name tag fits the garden', m.tag > 0 && m.tag <= m.garden, { tag: m.tag, garden: m.garden });
      await openSess(pg, ids[0], 'log'); await sleep(800);
      const d = await pg.ev(`const dr = document.getElementById('drawer'), r = dr.getBoundingClientRect(), over = [...dr.querySelectorAll('*')].filter(e => { const q = e.getBoundingClientRect(); return q.width && q.right > r.right + 1 && !e.closest('.term pre, .xterm'); }).slice(0, 4).map(e => e.tagName.toLowerCase() + '.' + [...e.classList].join('.') + ' +' + Math.round(e.getBoundingClientRect().right - r.right));
        return { over, sw: dr.scrollWidth - dr.clientWidth, head: Math.round(document.getElementById('thead').scrollWidth - document.getElementById('thead').clientWidth), pwn: window.__pwn || 0, imgs: dr.querySelectorAll('img').length, links: [...dr.querySelectorAll('a')].filter(a => /^javascript:/i.test(a.getAttribute('href') || '')).length };`);
      check(`hostile fields ${w}px`, 'sidebar: no markup runs, no javascript: links', d.pwn === 0 && d.imgs === 0 && d.links === 0, { pwn: d.pwn, imgs: d.imgs, links: d.links });
      check(`hostile fields ${w}px`, 'sidebar: nothing sticks out', !d.over.length && d.sw <= 0 && d.head <= 0, d);
    } finally { await pg.close(); }
  }
  await stop(srv.proc); stopTerminals(h.env);
}

// 200 waiting sessions: time to first usable render, frame rate, search latency, live-region chatter.
async function crowd200() {
  const h = makeHome(), N = QUICK ? 60 : 200;
  for (let i = 0; i < N; i++) { const s = new Sess(h.home, `-qa-many-${i % 10}`, sidOf(100 + i), h.work, `Many waiting invented ${i}`); s.turn('user', `ask ${i}`); s.turn('assistant', `Question ${i}?`); s.live('idle'); }
  const srv = await startServer(h.env);
  const t0 = Date.now(), api = await (await fetch(srv.url + 'api/sessions')).json(), apiMs = Date.now() - t0;
  const pg = await openPage(srv.url, { width: 1280 });
  try {
    const nav = Date.now();
    const ready = await until(async () => pg.ev(`return document.querySelectorAll('#actors .agent:not(.miner)').length >= 24 && document.getElementById('mode').textContent === 'live';`), 20000, 50);
    const usable = ready >= 0 ? Date.now() - nav : -1;
    const lt = await pg.ev(`window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) __lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); return 1;`);
    const r0 = await pg.ev(`return __qa.raf;`), m0 = await pg.send('Performance.getMetrics'), w0 = Date.now(); await sleep(10000);
    const r1 = await pg.ev(`return __qa.raf;`), m1 = await pg.send('Performance.getMetrics'), w1 = Date.now();
    const task = (/** @type {any} */ m) => m.metrics.find((/** @type {any} */ x) => x.name === 'TaskDuration').value;
    const fps = (r1 - r0) / ((w1 - w0) / 1000), cpu = (task(m1) - task(m0)) / ((w1 - w0) / 1000);
    const srch = await pg.ev(`const s = document.getElementById('search'), t = performance.now(); s.value = 'invented 1'; s.dispatchEvent(new Event('input', { bubbles: true })); const ms = performance.now() - t; s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return Math.round(ms);`);
    const g = await pg.ev(`return { chars: document.querySelectorAll('#actors .agent:not(.miner)').length, sign: document.getElementById('sign').textContent, hits: document.getElementById('hits').textContent.slice(0, 80), longTasks: (window.__lt || []).length, maxLong: Math.round(Math.max(0, ...(window.__lt || []))) };`);
    check(`${N} waiting`, `/api/sessions answers (${api.length} rows)`, apiMs < 2000, { ms: apiMs });
    check(`${N} waiting`, 'first usable render (garden full, live) under 5 s', usable >= 0 && usable < 5000, { ms: usable });
    check(`${N} waiting`, 'frames and CPU while idle', cpu < 0.25, { rafPerS: Math.round(fps), cpuPerS: Math.round(cpu * 1000) / 1000 });
    check(`${N} waiting`, 'search input handled under 50 ms', srch < 50, { ms: srch });
    check(`${N} waiting`, 'sign and overflow line', /need you/.test(g.sign), g);
    // Live-region chatter: announcements of #hits and #toast over 70 s with nothing changing.
    const l0 = await pg.ev(`return __qa.liveTotal;`); await sleep(QUICK ? 30000 : 70000); const l1 = await pg.ev(`return { n: __qa.liveTotal, by: __qa.live };`);
    check(`${N} waiting`, 'live regions quiet while nothing changes', l1.n - l0 === 0, { announcements: l1.n - l0, by: l1.by, overMs: QUICK ? 30000 : 70000 });
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

const FLOWS = /** @type {Array<[string, () => Promise<void>]>} */ ([['reply', quickReply], ['home', sendHome], ['reload', reloadTerm], ['two', twoPages], ['search', searchEscape], ['hostile', hostileFields], ['crowd', crowd200]]);
let broke = 0;
for (const [n, fn] of FLOWS) if (want(n)) { try { await fn(); } catch (e) { broke++; rows.push([n, 'tool error', 'ERROR', /** @type {Error} */ (e).message.slice(0, 160)]); } }
console.log(table(['flow', 'check', 'result', 'measured'], rows));
console.log(`\n${rows.filter(r => r[2] === 'FAIL').length} failed, ${rows.filter(r => r[2] === 'PASS').length} passed${broke ? `, ${broke} flows could not run` : ''}`);
process.exit(broke ? 1 : 0);
