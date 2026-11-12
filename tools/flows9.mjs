// @ts-check
// Flows added in round 8 that no tool covered: grouped tool lines, Details switch, tab title and announcements, first-run states, mine "+N",
// "Show N more" in Working, door notes, partial list against the full list, one server per folder, restart with a group open. Real server, invented data.
// Usage: node tools/flows9.mjs [--quick] [--only transcript,title,firstrun,mine,more,notes,drift,oneserver,restart]   (exits 1 only when the tool breaks)
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { APP, Sess, appCopy, arg, flag, makeHome, toolSession, openPage, sidOf, sleep, startServer, stop, stopTerminals, table } from './qa_lib.mjs';

const QUICK = flag('--quick'), ONLY = arg('--only', '').split(',').filter(Boolean);
const rows = /** @type {any[][]} */ ([]);
const check = (/** @type {string} */ flow, /** @type {string} */ name, /** @type {boolean} */ ok, /** @type {any} */ info = '') => { rows.push([flow, name, ok ? 'PASS' : 'FAIL', typeof info === 'string' ? info : JSON.stringify(info).slice(0, 260)]); };
const note = (/** @type {string} */ flow, /** @type {string} */ name, /** @type {any} */ info) => { rows.push([flow, name, 'INFO', typeof info === 'string' ? info : JSON.stringify(info).slice(0, 260)]); };
const until = async (/** @type {() => Promise<any>} */ fn, ms = 8000, step = 150) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return Date.now() - t; } catch (e) { /* not yet */ } await sleep(step); } return -1; };
const want = (/** @type {string} */ n) => !ONLY.length || ONLY.includes(n);
const realErrs = (/** @type {any} */ pg) => pg.errs.filter((/** @type {string} */ e) => !/Failed to load resource|net::ERR/.test(e));
const live = (/** @type {any} */ pg) => until(() => pg.ev(`return document.getElementById('mode').textContent === 'live' && !/Loading/.test(document.getElementById('lists').textContent);`), 15000, 100);
const key = async (/** @type {any} */ pg, /** @type {string} */ k) => { const code = k === 'Enter' ? 13 : k === 'Tab' ? 9 : 32; for (const type of ['rawKeyDown', 'char', 'keyUp']) { if (type === 'char' && k !== 'Enter') continue; await pg.send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, text: type === 'char' ? '\r' : undefined }); } await sleep(200); };
const says = (/** @type {any} */ pg) => pg.ev(`return { n: (window.__qa && __qa.live['#say']) || 0, text: document.getElementById('say').textContent };`);
// Open a session's sidebar on a tab.
async function openSess(/** @type {any} */ pg, /** @type {string} */ id, /** @type {'log'|'term'} */ view) {
  await pg.ev(`const b = document.querySelector('button.row[data-id="${id}"], button.agent[data-id="${id}"]'); if (!b) throw new Error('no button for ${id}'); b.click(); return 1;`); await sleep(500);
  await pg.ev(`document.querySelector('[data-view="${view}"]')?.click(); return 1;`); await sleep(500);
}
// One plain session, waiting (idle), working (busy) or not live.
const sess = (/** @type {any} */ h, /** @type {number} */ i, title = `Flow9 invented ${i}`, status = /** @type {'idle'|'busy'|null} */ ('idle')) => { const s = new Sess(h.home, '-qa-f9', sidOf(i), h.work, title); s.turn('user', 'invented ask'); s.turn('assistant', status === 'busy' ? 'Working on it.' : 'Invented question?'); if (status) s.live(status); return s; };
const GROUPS = `return [...document.querySelectorAll('#term .grp > details.xp')].map(d => ({ text: d.querySelector('summary').textContent.trim(), open: d.open, tab: d.querySelector('summary').tabIndex, errVisible: [...d.parentElement.querySelectorAll(':scope > .ln.err')].filter(x => x.offsetParent).map(x => x.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)) }));`;
// Accessibility tree nodes whose name matches re: role, name, expanded and pressed states.
async function ax(/** @type {any} */ pg, /** @type {RegExp} */ re) {
  await pg.send('Accessibility.enable'); const t = await pg.send('Accessibility.getFullAXTree');
  return t.nodes.filter((/** @type {any} */ n) => !n.ignored && re.test(n.name?.value || '')).map((/** @type {any} */ n) => ({ role: n.role?.value, name: String(n.name?.value).slice(0, 50), expanded: n.properties?.find((/** @type {any} */ p) => p.name === 'expanded')?.value?.value, pressed: n.properties?.find((/** @type {any} */ p) => p.name === 'pressed')?.value?.value, focusable: n.properties?.find((/** @type {any} */ p) => p.name === 'focusable')?.value?.value }));
}

// Grouped tool lines, expanding by click and Enter, failed call visible, hostile text inert, Details switch and its persistence, a live update.
async function transcript() {
  const h = makeHome(), s = toolSession(h, 1);
  const srv = await startServer(h.env), pg = await openPage(srv.url, { width: 1280 }); await live(pg);
  try {
    await openSess(pg, s.sid, 'log'); await until(() => pg.ev(`return document.querySelectorAll('#term .grp').length >= 4;`), 8000);
    const g = await pg.ev(GROUPS);
    check('transcript', 'group lines in the CLI words', g.length === 4 && g[0].text === 'Ran 3 shell commands' && g[1].text === 'Read 2 files' && g[2].text === 'Ran 2 shell commands' && /ran 1 shell command/i.test(g[3].text) && /read 1 file/i.test(g[3].text), g.map((/** @type {any} */ x) => x.text));
    check('transcript', 'groups closed at first, summaries reachable by Tab', g.every((/** @type {any} */ x) => !x.open && x.tab === 0), g.map((/** @type {any} */ x) => [x.open, x.tab]));
    check('transcript', 'failed call and its error visible under its closed group', g[2] && g[2].errVisible.length === 1 && /boom/.test(g[2].errVisible[0]), g[2] && g[2].errVisible);
    await pg.ev(`document.querySelectorAll('#term .grp > details.xp > summary')[0].click(); return 1;`); await sleep(300);
    const c1 = await pg.ev(`const d = document.querySelectorAll('#term .grp > details.xp')[0]; return { open: d.open, results: [...d.querySelectorAll('.ln.res')].filter(x => x.offsetParent).map(x => x.textContent.trim().slice(0, 20)) };`);
    check('transcript', 'click opens a group with every result', c1.open && c1.results.length === 3, c1);
    await pg.ev(`document.querySelectorAll('#term .grp > details.xp > summary')[1].focus(); return 1;`); await key(pg, 'Enter');
    const e1 = await pg.ev(`const d = document.querySelectorAll('#term .grp > details.xp')[1]; return { open: d.open, focus: document.activeElement === d.querySelector('summary') };`);
    check('transcript', 'Enter on a focused group opens it, focus stays', e1.open && e1.focus, e1);
    const open2 = await pg.ev(`const d = document.querySelectorAll('#term .grp > details.xp')[2]; d.querySelector('summary').click(); return [...d.parentElement.querySelectorAll('.ln.err')].filter(x => x.offsetParent).length;`);
    note('transcript', 'failed call lines visible with its group open (inside + under it)', { errLines: open2 });
    await pg.ev(`document.querySelectorAll('#term .grp > details.xp > summary')[2].click(); return 1;`);
    const a = (await ax(pg, /Ran 3 shell commands|Read 2 files/)).filter(x => !/StaticText|InlineTextBox/.test(x.role));
    check('transcript', 'group line: disclosure role, expanded state, name is the group words only (no glyph)', a.length === 2 && a.every(x => x.role === 'DisclosureTriangle' && x.expanded === true && /^(Ran 3 shell commands|Read 2 files)$/.test(x.name)), a);
    // Hostile results: opened, stay inert and inside the box.
    await pg.ev(`document.querySelectorAll('#term .grp > details.xp > summary')[3].click(); return 1;`); await sleep(400);
    const hz = await pg.ev(`const t = document.getElementById('term'), d = document.getElementById('drawer'), tr = t.getBoundingClientRect(), wide = [...t.querySelectorAll('.ln.res .txt')].map(x => x.getBoundingClientRect().right - tr.right);
      return { pwn: window.__pwn ?? null, imgs: t.querySelectorAll('img, script, b[style]').length, textShown: /onerror/.test(t.textContent), boxOverflow: t.scrollWidth - t.clientWidth, drawerOverflow: d.scrollWidth - d.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth, maxRightPastBox: Math.round(Math.max(...wide)) };`);
    check('transcript', 'hostile result text inert (no element, no script run, shown as text)', hz.pwn === null && hz.imgs === 0 && hz.textShown, hz);
    check('transcript', '20,000-character line stays inside the box (no horizontal overflow)', hz.boxOverflow <= 0 && hz.drawerOverflow <= 0 && hz.pageOverflow <= 0 && hz.maxRightPastBox <= 1, hz);
    // Live update with groups open and focus on a group line.
    await pg.ev(`document.querySelectorAll('#term .grp > details.xp > summary')[1].focus(); return 1;`);
    const before = await pg.ev(`return [...document.querySelectorAll('#term .grp > details.xp')].map(d => d.open);`);
    s.turn('user', 'go on please'); s.turn('assistant', 'Invented live update arrived.'); s.live('idle');
    const upd = await until(() => pg.ev(`return /Invented live update arrived/.test(document.getElementById('term').textContent);`), 10000, 200);
    const after = await pg.ev(`const ds = [...document.querySelectorAll('#term .grp > details.xp')], a = document.activeElement; return { open: ds.map(d => d.open), focus: a ? (a.tagName + ' ' + a.textContent.trim().slice(0, 30)) : '', inDrawer: !!(a && a.closest('#drawer')) };`);
    check('transcript', 'open groups survive a live update', upd >= 0 && JSON.stringify(after.open) === JSON.stringify(before), { ms: upd, before, after: after.open });
    check('transcript', 'focus on a group line survives a live update', /SUMMARY Read 2 files/.test(after.focus), after);
    // Details switch: pressed state, nothing grouped, every result shown, remembered over a reload.
    const d0 = await pg.ev(`const b = document.querySelector('[data-details]'); return { pressed: b.getAttribute('aria-pressed'), name: b.textContent.trim() };`);
    await pg.ev(`document.querySelector('[data-details]').click(); return 1;`); await sleep(600);
    const d1 = await pg.ev(`const b = document.querySelector('[data-details]'); return { pressed: b?.getAttribute('aria-pressed'), groups: document.querySelectorAll('#term .grp').length, results: [...document.querySelectorAll('#term .ln.res')].filter(x => x.offsetParent).length, focus: document.activeElement?.dataset?.details ? 'details button' : document.activeElement?.tagName, stored: localStorage.getItem('transcriptDetails') };`);
    check('transcript', 'Details on: pressed, nothing grouped, every result shown, stored', d0.pressed === 'false' && d1.pressed === 'true' && d1.groups === 0 && d1.results === 9 && d1.stored === '1', { d0, d1 });
    const ad = await ax(pg, /^Details$/); check('transcript', 'Details switch announces its pressed state', ad.some(x => x.pressed === 'true' || x.pressed === true), ad);
    note('transcript', 'focus after clicking Details', d1.focus);
    await pg.send('Page.reload'); await live(pg); await openSess(pg, s.sid, 'log'); await sleep(800);
    const d2 = await pg.ev(`const b = document.querySelector('[data-details]'); return { pressed: b?.getAttribute('aria-pressed'), groups: document.querySelectorAll('#term .grp').length };`);
    check('transcript', 'Details stays on after a reload', d2.pressed === 'true' && d2.groups === 0, d2);
    await pg.ev(`document.querySelector('[data-details]').click(); return 1;`); await sleep(500);
    const d3 = await pg.ev(`return { pressed: document.querySelector('[data-details]').getAttribute('aria-pressed'), groups: document.querySelectorAll('#term .grp').length };`);
    check('transcript', 'Details off again: groups back', d3.pressed === 'false' && d3.groups === 4, d3);
    check('transcript', 'no script errors', !realErrs(pg).length, realErrs(pg).slice(0, 3));
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Tab title follows the count and goes back to plain; one announcement for one new wait, one for three at once, none for a loss.
async function title() {
  const h = makeHome(), ss = [sess(h, 20, 'Title invented A', 'idle')]; for (let i = 21; i < 26; i++) ss.push(sess(h, i, `Title invented ${i}`, 'busy'));
  const srv = await startServer(h.env), pg = await openPage(srv.url); await live(pg); await sleep(1500);
  const T = () => pg.ev('return document.title;');
  try {
    const t0 = await T(), a0 = await says(pg);
    check('title', 'one waiting: "(1) Session Desk", nothing announced on load', t0 === '(1) Session Desk' && a0.n === 0, { title: t0, say: a0 });
    ss[1].turn('assistant', 'Finished. Next?'); ss[1].live('idle');
    const w1 = await until(async () => (await T()) === '(2) Session Desk', 8000, 100); await sleep(2500); const a1 = await says(pg);
    check('title', 'one more waits: title (2) and exactly one announcement naming it', w1 >= 0 && a1.n === 1 && /Title invented 21 needs you/.test(a1.text), { ms: w1, say: a1 });
    for (const s of ss.slice(2, 5)) { s.turn('assistant', 'Finished. Next?'); s.live('idle'); }
    const w3 = await until(async () => (await T()) === '(5) Session Desk', 8000, 100); await sleep(2500); const a3 = await says(pg);
    check('title', 'three wait at once: title (5) and exactly one more announcement', w3 >= 0 && a3.n === 2 && /3 sessions need you/.test(a3.text), { ms: w3, say: a3, title: await T() });
    for (const s of ss.slice(0, 5)) { s.turn('user', 'go'); s.live('busy'); }
    const w0 = await until(async () => (await T()) === 'Session Desk', 8000, 100); await sleep(2500); const a4 = await says(pg);
    check('title', 'none waiting: plain "Session Desk", no announcement for the loss', w0 >= 0 && a4.n === 2, { ms: w0, say: a4 });
    ss[0].turn('assistant', 'Again?'); ss[0].live('idle'); await until(async () => (await T()) === '(1) Session Desk', 8000, 100); await sleep(2500);
    check('title', 'waiting again after working: announced again', (await says(pg)).n === 3, await says(pg));
    check('title', 'no script errors', !realErrs(pg).length, realErrs(pg).slice(0, 3));
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// First-run states on the real server: no data folder, data but no CLI, read-only app folder, old Python.
async function firstrun() {
  const notice = (/** @type {any} */ pg) => pg.ev(`const v = x => x && !x.hidden && x.offsetParent ? x.textContent.replace(/\\s+/g, ' ').trim() : ''; return { quiet: v(document.getElementById('quiet')), setup: v(document.getElementById('setup')), none: [...document.querySelectorAll('.lists .none')].map(v).filter(Boolean).join(' | ').slice(0, 160), announced: window.__qa ? __qa.liveTotal : -1 };`);
  // No data folder.
  {
    const h = makeHome(), env = { ...h.env, DESK_CLAUDE_DIR: join(h.home, 'missing') };
    const srv = await startServer(env), pg = await openPage(srv.url); await live(pg); await sleep(1500);
    try {
      const hl = await (await fetch(srv.url + 'api/health')).json(), n1 = await notice(pg); await sleep(QUICK ? 6000 : 35000); const n2 = await notice(pg);
      check('first run: no data', 'health not ok, hint says what to do', hl.ok === false && /No Claude Code data found/.test(hl.setup?.hint || ''), { ok: hl.ok, setup: hl.setup });
      check('first run: no data', 'page shows the same sentence (quiet note and Working column)', /No Claude Code data found/.test(n1.quiet) && /No Claude Code data found/.test(n1.none), n1);
      check('first run: no data', 'notice not re-announced across polls', n2.announced === n1.announced, { first: n1.announced, later: n2.announced, waitedS: QUICK ? 6 : 35 });
    } finally { await pg.close(); await stop(srv.proc); stopTerminals(env); }
  }
  // Data, no CLI.
  {
    const h = makeHome(); sess(h, 30, 'No CLI invented'); const env = { ...h.env, DESK_CLAUDE_BIN: join(h.state, 'no-such-cli'), PATH: '/usr/bin:/bin' };
    const srv = await startServer(env), pg = await openPage(srv.url); await live(pg); await sleep(1500);
    try {
      const n1 = await notice(pg); check('first run: no CLI', 'line under the search box says terminals are off and why', /Terminals and quick replies are off/.test(n1.setup) && /not found/.test(n1.setup), n1);
      await openSess(pg, sidOf(30), 'term'); const t = await until(() => pg.ev(`return /not found/.test(document.getElementById('drawer').innerText);`), 8000);
      const msg = await pg.ev(`return (document.getElementById('drawer').innerText.match(/[^\\n]*not found[^\\n]*/) || [''])[0];`);
      check('first run: no CLI', 'Terminal tab says the CLI was not found', t >= 0, msg);
      await sleep(QUICK ? 5000 : 32000); const n2 = await notice(pg);
      check('first run: no CLI', 'notice not re-announced across polls', n2.announced === n1.announced, { first: n1.announced, later: n2.announced });
    } finally { await pg.close(); await stop(srv.proc); stopTerminals(env); }
  }
  // Read-only app folder: page terminals off with the message.
  {
    const h = makeHome(); sess(h, 31, 'Read-only invented'); const app = appCopy(), env = { ...h.env }; delete env.DESK_STATE_DIR;
    spawnSync('chmod', ['-R', 'a-w', app]);
    let srv = null, pg = null;
    try {
      srv = await startServer(env, 0, app); pg = await openPage(srv.url); await live(pg); await sleep(1500);
      const hl = await (await fetch(srv.url + 'api/health')).json(), n1 = await notice(pg);
      check('first run: read-only', 'server runs; health stateDir not ok', hl.setup && hl.setup.stateDir !== 'ok', { ok: hl.ok, setup: hl.setup });
      note('first run: read-only', 'page notice with sessions listed', n1);
      await openSess(pg, sidOf(31), 'term'); await sleep(2500);
      const msg = await pg.ev(`return (document.getElementById('drawer').innerText.match(/[^\\n]*(read-only|terminals are off)[^\\n]*/i) || [''])[0];`);
      check('first run: read-only', 'Terminal tab says page terminals are off because the folder is read-only', /read-only/i.test(msg), msg);
    } finally { if (pg) await pg.close(); if (srv) await stop(srv.proc); spawnSync('chmod', ['-R', 'u+w', app]); stopTerminals(env, app); }
  }
  // Old Python, when one is installed.
  const old = ['/usr/local/bin/python3.8', '/usr/bin/python3.8', '/opt/homebrew/bin/python3.8'].find(p => existsSync(p));
  if (old) { const h = makeHome(), r = spawnSync(old, [join(APP, 'server.py')], { env: { ...h.env, PORT: '0' }, encoding: 'utf8', timeout: 10000 }); const out = (r.stdout + r.stderr).trim();
    check('first run: Python 3.8', 'one line, exit non-zero', r.status !== 0 && out.split('\n').length === 1 && /needs Python 3\.9 or newer/.test(out), { status: r.status, out: out.slice(0, 120) }); }
  else note('first run: Python 3.8', 'skipped', 'no Python 3.8 here');
}

// Mine "+N" with 12 working sessions: drawn miners plus the plaque equal the Working heading; the plaque has a name.
async function mine() {
  const h = makeHome(); for (let i = 40; i < 52; i++) sess(h, i, `Mine invented ${i}`, 'busy'); sess(h, 52, 'Mine waiting invented', 'idle');
  const srv = await startServer(h.env), pg = await openPage(srv.url); await live(pg); await sleep(3000);
  try {
    const m = await pg.ev(`const p = document.getElementById('minemore'); return { miners: document.querySelectorAll('#actors .agent.miner').length, plaque: p ? p.textContent.trim() : '', label: p ? p.getAttribute('aria-label') : '', role: p ? p.getAttribute('role') : '', heading: document.querySelector('.lists .col h3')?.textContent.trim(), rows: document.querySelectorAll('.lists .col:first-child .row[data-id]').length };`);
    const n = Number((m.plaque.match(/\d+/) || ['0'])[0]), head = Number((m.heading.match(/\d+/) || ['0'])[0]);
    check('mine +N', 'miners + plaque = Working heading = 12', m.miners + n === head && head === 12, m);
    check('mine +N', 'plaque has a role and a name', m.role === 'img' && !!m.label, { role: m.role, label: m.label });
    const a = await ax(pg, /working|mine/i); note('mine +N', 'plaque in the accessibility tree', a.filter(x => /room|mine|\+|more/i.test(x.name)).slice(0, 2));
    for (let i = 40; i < 46; i++) { const s = new Sess(h.home, '-qa-f9', sidOf(i), h.work, ''); s.n = 10; s.turn('assistant', 'Finished. Next?'); s.live('idle'); }
    await sleep(4000);
    const m2 = await pg.ev(`const p = document.getElementById('minemore'); return { miners: document.querySelectorAll('#actors .agent.miner').length, plaque: p ? p.textContent.trim() : '', heading: document.querySelector('.lists .col h3')?.textContent.trim() };`);
    check('mine +N', 'after 6 stop working: plaque gone or smaller, still agrees', m2.miners + Number((m2.plaque.match(/\d+/) || ['0'])[0]) === Number((m2.heading.match(/\d+/) || ['0'])[0]), m2);
    check('mine +N', 'no script errors', !realErrs(pg).length, realErrs(pg).slice(0, 3));
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// "Show N more" in Working with 60 working sessions: 30 shown, the line unfolds the rest by click and Enter, and folds back.
async function more() {
  const h = makeHome(); for (let i = 100; i < 160; i++) sess(h, i, `More invented ${i}`, 'busy');
  const srv = await startServer(h.env), pg = await openPage(srv.url); await live(pg); await sleep(2500);
  try {
    const R = `const c = document.querySelector('.lists .col'), b = c.querySelector('.showmore'); return { rows: c.querySelectorAll('.rows > .row:not(.gone)').length, line: b && !b.hidden ? b.textContent.trim() : '', exp: b ? b.getAttribute('aria-expanded') : '', head: c.querySelector('h3').textContent.trim(), focus: document.activeElement?.dataset?.id ? 'row' : document.activeElement?.className };`;
    const m0 = await pg.ev(R);
    check('show more', '30 rows and "Show 30 more", collapsed', m0.rows === 30 && /Show 30 more/.test(m0.line) && m0.exp === 'false' && /60/.test(m0.head), m0);
    await pg.ev(`document.querySelector('.lists .col .showmore').click(); return 1;`); await sleep(800); const m1 = await pg.ev(R);
    check('show more', 'click unfolds 60, expanded, focus to the first new row', m1.rows === 60 && m1.exp === 'true' && m1.focus === 'row', m1);
    await pg.ev(`document.querySelector('.lists .col .showmore').focus(); return 1;`); await key(pg, 'Enter'); await sleep(800); const m2 = await pg.ev(R);
    check('show more', 'Enter folds back to 30', m2.rows === 30 && m2.exp === 'false', m2);
    const a = await ax(pg, /Show 30 more/); check('show more', 'line is a button with its expanded state', a.some(x => x.role === 'button' && x.expanded === false), a);
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Door notes: sessions open twice give one note each (rule from world_data), row badges agree, and whether anything names the notes.
async function notes() {
  const h = makeHome(), reg = join(h.home, 'sessions'); for (let i = 60; i < 63; i++) sess(h, i, `Twice invented ${i}`, i === 62 ? 'busy' : 'idle');
  mkdirSync(reg, { recursive: true }); for (const i of [60, 62]) writeFileSync(join(reg, `qa-desktop-${i}.json`), JSON.stringify({ pid: process.pid, sessionId: sidOf(i), status: 'idle', statusUpdatedAt: Date.now(), entrypoint: 'claude-desktop' }));
  const srv = await startServer(h.env), pg = await openPage(srv.url); await live(pg); await sleep(2500);
  try {
    const m = await pg.ev(`const wd = await import('/src/world_data.js'), S = window.desk.S, by = id => S.find(x => x.id === id) || {}; return { notes: wd.syncNotes(S), withAlso: S.filter(x => (x.also || []).some(Boolean)).length, also60: by('${sidOf(60)}').also, also61: by('${sidOf(61)}').also, also62: by('${sidOf(62)}').also, badge62: [...document.querySelectorAll('.lists .row')].some(r => r.dataset.id === '${sidOf(62)}' && /open twice/.test(r.textContent)), named: [...document.querySelectorAll('#garden [aria-label], #garden [title]')].filter(x => !x.classList.contains('agent') && /note|out of step/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))).length, canvasHidden: document.getElementById('bg').getAttribute('aria-hidden') };`);
    check('door notes', 'open in the CLI and the desktop app: also names both, row says "open twice"', (m.also60 || []).length === 2 && (m.also62 || []).length === 2 && m.badge62, m);
    const t61 = await pg.ev(`const s = window.desk.S.find(x => x.id === '${sidOf(61)}') || {}, L = await import('/src/logic.js'); return { copies: s.copies, twice: L.openTwice(s), chips: L.badges(s).map(b => b[0]) };`);
    check('door notes', 'open in one terminal only: not "open twice" (one live copy, no badge)', t61.copies === 1 && !t61.twice && !t61.chips.includes('also'), t61);
    const want = await pg.ev(`const L = await import('/src/logic.js'); return window.desk.S.filter(x => x.behind || L.openTwice(x) || L.diverged(x)).length;`);
    check('door notes', 'notes follow the rule: min(3, sessions behind, open twice or diverged)', m.notes === Math.min(3, want), { notes: m.notes, want });
    note('door notes', 'notes drawn on the aria-hidden canvas; non-character garden elements naming them', { named: m.named, canvasHidden: m.canvasHidden });
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// Partial list refresh equals the full list after 200 random changes: forced drift check gives 0; the page's list equals /api/sessions.
async function drift() {
  const h = makeHome(), ss = /** @type {any[]} */ ([]); for (let i = 200; i < 240; i++) ss.push(sess(h, i, `Drift invented ${i}`, i % 3 ? 'idle' : 'busy'));
  const srv = await startServer(h.env), pg = await openPage(srv.url); await live(pg); await sleep(2000);
  const rnd = (/** @type {number} */ n) => Math.floor(Math.random() * n); let next = 240; const N = QUICK ? 80 : 200, kinds = { line: 0, flip: 0, add: 0, gone: 0, title: 0 };
  try {
    for (let k = 0; k < N; k++) {
      const r = rnd(10), s = ss[rnd(ss.length)];
      if (r < 4) { s.turn(rnd(2) ? 'assistant' : 'user', `invented change ${k}`); kinds.line++; }
      else if (r < 7) { if (rnd(2)) { s.turn('assistant', `Done ${k}. Next?`); s.live('idle'); } else s.live('busy'); kinds.flip++; }
      else if (r < 8) { ss.push(sess(h, next++, `Drift new ${next}`, rnd(2) ? 'idle' : 'busy')); kinds.add++; }
      else if (r < 9 && ss.length > 10) { const g = ss.splice(rnd(ss.length), 1)[0]; g.live(null); kinds.gone++; }
      else { appendFileSync(s.file, JSON.stringify({ type: 'custom-title', customTitle: `Drift renamed ${k}`, sessionId: s.sid }) + '\n'); kinds.title++; }
      await sleep(40 + rnd(60));
    }
    await sleep(4000);
    await pg.ev(`await window.desk.checkDrift(); return 1;`); await sleep(3800);
    const d = await pg.ev(`const lg = await import('/src/logic.js'); const fresh = await (await fetch('/api/sessions')).json(); const x = lg.listDrift(window.desk.S, fresh); return { drift: window.desk.drift, checks: window.desk.driftChecks, raced: window.desk.driftRaced, pageRows: window.desk.S.length, apiRows: fresh.length, diffFields: x.fields, diffIds: x.ids.length };`);
    check('drift', `${N} random changes: forced check finds drift 0`, d.drift === 0 && d.checks >= 1, { ...d, kinds });
    check('drift', 'page list equals a fresh /api/sessions', d.pageRows === d.apiRows && !d.diffFields.length, d);
    check('drift', 'no script errors or drift warnings', !realErrs(pg).length && !pg.errs.some((/** @type {string} */ e) => /differed/.test(e)), pg.errs.slice(0, 3));
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

// One server per folder: a second foreground start is refused with the first one's address.
async function oneserver() {
  const h = makeHome(), srv = await startServer(h.env);
  try {
    const r = spawnSync('python3', [join(APP, 'server.py')], { cwd: APP, env: { ...h.env, PORT: '0' }, encoding: 'utf8', timeout: 12000 }), out = (r.stdout + r.stderr).trim();
    check('one server', 'second start refused with the first address, exit non-zero', r.status !== 0 && r.status !== null && out.includes(srv.url.replace(/\/$/, '')), { status: r.status, out: out.slice(0, 200) });
    const r2 = spawnSync('python3', [join(APP, 'server.py')], { cwd: APP, env: { ...h.env, PORT: String(srv.port) }, encoding: 'utf8', timeout: 12000 }), out2 = (r2.stdout + r2.stderr).trim();
    check('one server', 'same port: the same refusal, not the port-in-use line', /already runs/.test(out2), { status: r2.status, out: out2.slice(0, 200) });
  } finally { await stop(srv.proc); stopTerminals(h.env); }
}

// Server restart while a group is expanded and a search is typed: offline then live, group still open, search kept, no errors.
async function restart() {
  const h = makeHome(), s = toolSession(h, 70, 'Restart groups invented'); sess(h, 71, 'Restart other invented');
  let srv = await startServer(h.env); const pg = await openPage(srv.url); await live(pg);
  try {
    await pg.ev(`const s = document.getElementById('search'); s.value = 'Restart groups'; s.dispatchEvent(new Event('input', { bubbles: true })); return 1;`); await sleep(800);
    const hits0 = await pg.ev(`return document.getElementById('hits').textContent;`);
    await openSess(pg, s.sid, 'log'); await until(() => pg.ev(`return document.querySelectorAll('#term .grp').length >= 4;`), 8000);
    await pg.ev(`const x = document.querySelectorAll('#term .grp > details.xp > summary'); x[0].click(); x[2].click(); x[1].focus(); return 1;`); await sleep(300);
    const port = srv.port; await stop(srv.proc, 5000); await sleep(1500);
    const off = await until(() => pg.ev(`return /offline/.test(document.getElementById('mode').textContent);`), 8000);
    srv = await startServer(h.env, port);
    const back = await until(() => pg.ev(`return document.getElementById('mode').textContent === 'live';`), 15000, 250); await sleep(2500);
    const m = await pg.ev(`const a = document.activeElement; return { open: [...document.querySelectorAll('#term .grp > details.xp')].map(d => d.open), drawer: !document.getElementById('drawer').hidden, search: document.getElementById('search').value, hits: document.getElementById('hits').textContent, focus: a ? a.tagName + ' ' + a.textContent.trim().slice(0, 20) : '' };`);
    check('restart', 'offline shown, then live again', off >= 0 && back >= 0, { offlineMs: off, backMs: back });
    check('restart', 'sidebar open, expanded groups still open', m.drawer && JSON.stringify(m.open) === JSON.stringify([true, false, true, false]), m);
    check('restart', 'search text and its result kept', m.search === 'Restart groups' && m.hits === hits0 && /Restart groups/.test(hits0), { search: m.search, before: hits0, after: m.hits });
    note('restart', 'focus after the restart', m.focus);
    check('restart', 'no script errors', !realErrs(pg).length, realErrs(pg).slice(0, 3));
  } finally { await pg.close(); await stop(srv.proc); stopTerminals(h.env); }
}

const FLOWS = /** @type {Array<[string, () => Promise<void>]>} */ ([['transcript', transcript], ['title', title], ['firstrun', firstrun], ['mine', mine], ['more', more], ['notes', notes], ['drift', drift], ['oneserver', oneserver], ['restart', restart]]);
let broke = 0;
for (const [n, fn] of FLOWS) if (want(n)) { try { await fn(); } catch (e) { broke++; rows.push([n, 'tool error', 'ERROR', /** @type {Error} */ (e).message.slice(0, 160)]); } }
console.log(table(['flow', 'check', 'result', 'measured'], rows));
console.log(`\n${rows.filter(r => r[2] === 'FAIL').length} failed, ${rows.filter(r => r[2] === 'PASS').length} passed${broke ? `, ${broke} flows could not run` : ''}`);
process.exit(broke ? 1 : 0);
