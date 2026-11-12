// Headless smoke test in demo mode: starts dev_static.py and a throwaway Chrome, checks the page end to end, exits 1 on any failure.
// Usage: node tools/smoke.mjs [--root DIR] [--shots DIR] [--legacy]   (--legacy: the old single-file page, window-leak check is informational)
// Ports are free ones picked at run time (SMOKE_PORT and SMOKE_DEBUG_PORT fix them), so parallel runs from different folders never collide.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from './smoke_lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = arg('--root', join(HERE, '..', 'web')), LEGACY = process.argv.includes('--legacy');
const shots = arg('--shots', null) || tempDir('desk-shots-', true); mkdirSync(shots, { recursive: true });
const profile = tempDir('desk-chrome-');
const fails = [], errs = [];
const check = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info === undefined ? '' : ' ' + JSON.stringify(info)}`); if (!cond) fails.push(name); };

// dev_static.py binds the port it is given (0: the OS picks) and prints the one it got.
const server = launch('python3', [join(HERE, 'dev_static.py'), '--root', ROOT, '--port', process.env.SMOKE_PORT || '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
let chrome, URL = '';
try {
  const m = await readLine(server, /http:\/\/\[::1\]:(\d+)\//);
  if (!m) throw new Error('dev_static.py did not start');
  URL = `http://[::1]:${m[1]}/`;
  let up = false; for (let i = 0; i < 40 && !up; i++) { try { up = (await fetch(URL)).ok; } catch (e) { await sleep(150); } }
  if (!up) throw new Error('dev_static.py does not answer on ' + URL);
  let wsUrl; ({ chrome, wsUrl } = await startChrome(profile));
  const { send, on } = await devtools(wsUrl);
  // Page helpers: D is window.desk, or the old page's global bindings when testing the single file.
  const D = 'const D = window.desk ?? { st, get S() { return S; }, reel, drawGarden, looks, look, BODIES };';
  const ev = async (body, raw) => { const r = await send('Runtime.evaluate', { expression: `(async () => { ${raw ? '' : D} ${body} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const shot = async name => writeFileSync(join(shots, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  const click = async sel => {
    const p = await ev(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2];`);
    if (!p) return false;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p[0], y: p[1] });
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: p[0], y: p[1], button: 'left', clickCount: 1 });
    return true;
  };
  const esc = async () => { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }); };
  // One key press as a person types it: '/', 'j', 'k' or 'Enter'.
  const press = async k => { const enter = k === 'Enter', vk = enter ? 13 : k.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: enter ? 'Enter' : k === '/' ? 'Slash' : 'Key' + k.toUpperCase(), text: enter ? '\r' : k, windowsVirtualKeyCode: k === '/' ? 191 : vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, windowsVirtualKeyCode: k === '/' ? 191 : vk }); };
  // Replace the search text the way typing does (input event), then let the lists settle.
  const search = async q => { await ev(`const s = document.getElementById('search'); s.value = ${JSON.stringify(q)}; s.dispatchEvent(new Event('input', { bubbles: true })); return 1;`); await sleep(120); };

  on.set('Runtime.exceptionThrown', p => errs.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  on.set('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'assert') errs.push('console.' + p.type + ': ' + p.args.map(a => a.value ?? a.description).join(' ')); });
  on.set('Log.entryAdded', p => { if (p.entry.level === 'error' && !/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|api\.open-meteo\.com)\//.test(p.entry.url || '') && !/\/legend\.html$/.test(p.entry.url || '')) errs.push('log: ' + p.entry.text + (p.entry.url ? ' ' + p.entry.url : '')); });  // the page works offline: failed font and weather requests are not errors, nor is the Legend check while legend.html is missing
  // Focus emulation keeps headless Chrome from marking the page hidden after a screenshot, which pauses the page's timers and catches.
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Baseline globals from an empty page on the same origin (about:blank is not a secure context, so it lacks some built-ins).
  await send('Page.navigate', { url: URL + '__blank' }); await sleep(500);
  const base = await ev('return Object.keys(window);', true);

  // Loading state: before the page script runs, the lists say they are loading.
  await send('Emulation.setScriptExecutionDisabled', { value: true }); await send('Page.navigate', { url: URL });
  let ld = null; for (let i = 0; i < 30 && !ld; i++) { await sleep(100); ld = await ev(`const l = document.getElementById('lists'); return l ? l.textContent.trim() : null;`, true); }
  check('loading state before the script runs', ld === 'Loading sessions…', ld);
  await send('Emulation.setScriptExecutionDisabled', { value: false });

  await send('Page.navigate', { url: URL }); let t0 = Date.now(); const until = ms => sleep(Math.max(0, t0 + ms - Date.now()));
  if (!LEGACY) { for (let i = 0; i < 400 && !(await ev('return !!window.desk;', true)); i++) await sleep(50); t0 = Math.max(t0, Date.now() - 250); }
  await until(2000);
  await ev('D.st.clock = 720; D.drawGarden(); return 1;'); await sleep(400);

  // Garden, lists and header for the example data.
  const g = await ev(`const c = document.getElementById('bg'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3]) seen.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]);
    const q = s => document.querySelectorAll(s).length, t = id => document.getElementById(id).textContent;
    return { w: c.width, h: c.height, colors: seen.size, agents: q('.agent:not(.miner)'), miners: q('.agent.miner'), minis: q('.mini'), running: q('.row.running'), resting: q('.row.resting'),
      sign: t('sign'), sum: document.getElementById('sum').innerText.replace(/\u00a0/g, ' '), mode: t('mode'), wx: t('wx'), heads: [...document.querySelectorAll('.col h3')].map(h => h.textContent.trim()), quiet: document.getElementById('quiet').hidden, stats: q('.us-btn') };`);
  check('garden canvas sized', g.w > 0 && g.h > 0 && !(g.w === 300 && g.h === 150), [g.w, g.h]);
  check('garden canvas painted', g.colors > 40, g.colors);
  check('3 garden characters', g.agents === 3, g.agents);
  check('3 miners', g.miners === 3, g.miners);
  check('2 subagent minis', g.minis === 2, g.minis);
  check('3 Working rows, 5 Resting rows', g.running === 3 && g.resting === 5, [g.running, g.resting]);
  check('list headings', g.heads.join('|') === 'Working 3|Resting 5', g.heads);
  check('sign text', g.sign === '3 need you', g.sign);
  check('summary text', g.sum === '3 need you · 3 working · 5 resting · 6 automated · 1.2M tokens', g.sum);
  check('demo tagline', g.mode === 'demo · example data', g.mode);
  check('weather plaque', /^Tel Aviv \d\d:\d\d$/.test(g.wx), g.wx);
  check('quiet note hidden, Stats button present', g.quiet && g.stats === 1);
  const t0x = await ev(`return { title: document.title, say: document.getElementById('say').textContent, setup: document.getElementById('setup').hidden };`);
  check('tab title counts who waits; nothing announced on load; no setup line', t0x.title === '(3) Session Desk' && t0x.say === '' && t0x.setup, t0x);
  await shot('1-garden.png');

  // Automated runs fold away at the end of Resting; one click opens them in place and the browser remembers it.
  const fd = () => ev(`const f = document.querySelector('.fold:not([hidden])'); return { text: f && !f.hidden ? f.textContent : null, exp: f?.getAttribute('aria-expanded'), auto: document.querySelectorAll('.row.auto:not(.gone)').length, last: f?.previousElementSibling?.classList.contains('more'), saved: localStorage.getItem('autoRunsOpen') };`);
  const f0 = await fd();
  check('automated runs folded', f0.text === '▸ 6 automated runs' && f0.exp === 'false' && f0.auto === 0, f0);
  await ev(`document.querySelector('.fold:not([hidden])').scrollIntoView({ block: 'center' }); return 1;`);
  check('click the fold', await click('.fold:not([hidden])')); await sleep(350);
  const f1 = await fd();
  check('fold opens in place and is remembered', f1.text === '▾ 6 automated runs' && f1.exp === 'true' && f1.auto === 6 && f1.saved === '1', f1);
  await shot('1b-fold-open.png'); await ev(`scrollTo(0, 0); return 1;`);
  await ev(`document.querySelector('.fold:not([hidden])').scrollIntoView({ block: 'center' }); return 1;`);
  check('click the fold again', await click('.fold:not([hidden])')); await sleep(350); await ev(`scrollTo(0, 0); return 1;`);
  const f2 = await fd();
  check('fold closes again', f2.auto === 0 && f2.saved === '0', f2);

  // Row badges and plain-text previews.
  const bd = await ev(`const r = id => document.querySelector('.row[data-id="' + id + '"]'), a = r('s10'), b = r('s11'), c = r('s1');
    return { s10: [...a.querySelectorAll('.chip')].map(x => x.className + ':' + x.textContent), tip: a.querySelector('.chip.behind')?.title, last10: a.querySelector('.last').textContent,
      s11: [...b.querySelectorAll('.chip')].map(x => x.className), last11: b.querySelector('.last').textContent, plainRows: document.querySelectorAll('.row:not(.auto) .chip').length };`);
  check('badges: PR and behind on s10', bd.s10.join('|') === 'chip pr:PR|chip behind:behind' && /Also open in desktop app/.test(bd.tip), bd);
  check('badges: failed tool dot on s11', bd.s11.join('|') === 'chip err', bd.s11);
  check('previews are plain text', bd.last10 === 'CI is green. Cache restore now takes 14 s instead of 2 min. See the pull request.' && bd.last11 === 'Migration failed ALTER TABLE invoices timed out after 30 s', [bd.last10, bd.last11]);

  // Multi-word search: every word must hit, hits are marked, the match line counts them (automated ones said apart) and names garden matches.
  await press('/');
  check('/ focuses the search box', await ev(`return document.activeElement.id === 'search';`));
  await search('green cache');
  const s1 = await ev(`return { rows: [...document.querySelectorAll('.lists .row:not(.gone)')].map(r => r.dataset.id), marks: [...document.querySelectorAll('.row mark')].map(m => m.textContent.toLowerCase()), hits: document.getElementById('hits').textContent };`);
  check('multi-word search narrows and marks', s1.rows.join() === 's10' && s1.marks.includes('green') && s1.marks.includes('cache') && s1.hits === '1 match below', s1);
  await search('remember notes');
  const s2 = await ev(`return { auto: document.querySelectorAll('.row.auto:not(.gone)').length, hits: document.getElementById('hits').textContent, fold: document.querySelector('.fold:not([hidden])').textContent };`);
  check('search finds automated runs and says so', s2.auto === 6 && s2.hits === '6 matches below (6 automated)' && s2.fold === '▾ 6 automated runs match', s2);
  await search('flaky checkout');
  const s3 = await ev(`return { hits: document.getElementById('hits').textContent, g: document.querySelectorAll('#hits .ghit[data-id="s1"] mark').length };`);
  check('match line names garden matches', s3.hits.startsWith('0 matches below · in the garden: ') && s3.g === 2, s3);
  await search(''); await ev(`document.activeElement.blur(); return 1;`);

  // j and k step through rows in page order, Enter opens the focused one, Esc closes it.
  await press('j'); await press('j'); await press('k');
  const kj = await ev(`const rows = [...document.querySelectorAll('.lists .row:not(.gone)')]; return { at: rows.indexOf(document.activeElement), id: document.activeElement.dataset.id };`);
  check('j j k lands on the first row', kj.at === 0, kj);
  await press('Enter'); await sleep(450);
  check('Enter opens the focused row', await ev(`return !document.getElementById('drawer').hidden && D.st.open === ${JSON.stringify(kj.id)};`));
  await esc(); await sleep(350);
  check('Esc closes it again', await ev(`return document.getElementById('drawer').hidden && D.st.open === null;`));

  // The demo event at about 9 s: a working session turns waiting and walks in.
  await until(10300);
  for (let i = 0; i < 40 && !(await ev(`return !!document.querySelector('.agent[data-id="s3"]:not(.miner)') && !document.querySelector('.agent.miner[data-id="s3"]');`)); i++) await sleep(250);  // under load the event can be late
  const e9 = await ev(`return { s3: !!document.querySelector('.agent[data-id="s3"]:not(.miner)'), mined: !!document.querySelector('.agent.miner[data-id="s3"]'), toast: document.getElementById('toast').textContent, sign: document.getElementById('sign').textContent };`);
  check('demo event: s3 walks into the garden', e9.s3 && !e9.mined, e9);
  check('demo event: toast and sign', e9.toast === 'An agent walked in with a question.' && e9.sign === '4 need you', [e9.toast, e9.sign]);
  const say = await ev(`return { say: document.getElementById('say').textContent, live: document.getElementById('say').getAttribute('aria-live'), title: document.title };`);
  check('demo event: one polite announcement and the title count', say.say === 'Migrate date handling to Temporal needs you' && say.live === 'polite' && say.title === '(4) Session Desk', say);
  await until(13000);

  // Drawer opens by click on a character, closes on Esc.
  check('click character s1', await click('.agent[data-id="s1"]'));
  await sleep(450);
  const dr = await ev(`const d = document.getElementById('drawer'); return { open: !d.hidden && !document.getElementById('shade').hidden, title: d.querySelector('h2')?.textContent, lines: d.querySelectorAll('.term > .ln').length, answers: d.querySelectorAll('[data-answer]').length, focus: document.activeElement?.id, st: D.st.open };`);
  check('drawer open with transcript', dr.open && dr.title === 'Fix flaky checkout test' && dr.lines === 7 && dr.answers === 2 && dr.focus === 'term' && dr.st === 's1', dr);
  await shot('2-drawer.png');
  await esc(); await sleep(350);
  const dc = await ev(`return { hidden: document.getElementById('drawer').hidden && document.getElementById('shade').hidden, st: D.st.open };`);
  check('Esc closes the drawer', dc.hidden && dc.st === null, dc);
  check('focus returns to the character that opened it', await ev(`return document.activeElement?.dataset?.id === 's1';`));
  // Hover bubble on a waiting character: title, question, then how long it has waited.
  const hp = await ev(`const a = document.querySelector('.agent[data-id="s1"]:not(.miner)'), b = a.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2];`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hp[0], y: hp[1] }); await sleep(300);
  const hv = await ev(`const s = document.querySelector('.agent[data-id="s1"]:not(.miner) .say'); return { vis: getComputedStyle(s).visibility, wt: s.querySelector('.wt')?.textContent };`);
  check('hover bubble shows a waiting line', hv.vis === 'visible' && /^waiting (under a minute|\d+ min)$/.test(hv.wt || ''), hv);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });

  // Sidebar header: waiting time and the row badges; copy buttons leave the Tab order until their line has focus; Esc closes Stats before the sidebar.
  check('click character s1 for the keyboard pass', await click('.agent[data-id="s1"]')); await sleep(450);
  const hk = await ev(`const d = document.getElementById('drawer'); return { waited: d.querySelector('.thead .waited')?.textContent, tab0: d.querySelectorAll('.cbtn[tabindex="0"]').length, cbtn: d.querySelectorAll('.cbtn').length };`);
  check('header says how long it waits', /^waiting (under a minute|\d+ min)$/.test(hk.waited || ''), hk);
  check('copy buttons are not Tab stops', hk.cbtn > 0 && hk.tab0 === 0, hk);
  await press('j'); await press('j');
  const jk = await ev(`const a = document.activeElement; return { line: a.matches('.ln[tabindex]'), i: a.dataset.i, own: a.querySelectorAll('.cbtn[tabindex="0"]').length, all: document.querySelectorAll('#drawer .cbtn[tabindex="0"]').length };`);
  check('j steps through messages; only the focused one offers copy', jk.line && jk.own === jk.all, jk);
  await ev(`document.getElementById('reply').focus(); return 1;`); await press('k');
  check('k while typing in the reply box stays in the box', await ev(`const r = document.getElementById('reply'); return document.activeElement === r && r.value === 'k';`));
  await ev(`const r = document.getElementById('reply'); r.value = ''; document.getElementById('term').focus(); document.querySelector('.us-btn').click(); return 1;`); await sleep(200);
  await esc(); await sleep(250);
  check('Esc closes Stats first, sidebar stays', await ev(`return document.querySelector('.us').hidden && !document.getElementById('drawer').hidden;`));
  await ev(`document.getElementById('term').focus(); return 1;`); await esc(); await sleep(350);
  check('second Esc closes the sidebar', await ev(`return document.getElementById('drawer').hidden;`));
  check('row s10 opens with its badges in the header', await click('.row[data-id="s10"]')); await sleep(450);
  const hb = await ev(`return [...document.querySelectorAll('#drawer .thead .chip')].map(c => c.className + ':' + c.textContent);`);
  check('header badges match the row', hb.join('|') === 'chip pr:PR|chip behind:behind', hb);
  await shot('2b-drawer-badges.png');
  await esc(); await sleep(350);
  check('focus returns to the row', await ev(`return document.activeElement?.matches('.row[data-id="s10"]');`));

  // Stats panel: six tiles, period switch, Esc closes.
  check('click Stats', await click('.us-btn'));
  await sleep(900);
  const us = await ev(`const b = document.querySelector('.us'); return { open: !b.hidden && !document.querySelector('.us-shade').hidden, tiles: b.querySelectorAll('.us-tile').length, title: b.querySelector('h2')?.textContent, sub: b.querySelector('.us-sub')?.textContent, per: b.querySelector('[aria-pressed="true"]')?.dataset.usp, big: b.querySelector('.us-big')?.textContent };`);
  check('Stats panel open with six tiles', us.open && us.tiles === 6 && us.title === 'Usage' && us.sub === 'example data' && us.per === '7d' && /\d/.test(us.big), us);
  await shot('3-stats.png');
  check('click 30 days', await click('.us [data-usp="30d"]')); await sleep(200);
  check('period switches', await ev(`return document.querySelector('.us [aria-pressed="true"]').dataset.usp === '30d' && document.querySelectorAll('.us-tile').length === 6;`));
  // Charts take focus; arrow keys pick a bar and read its numbers in the line under the axis.
  await ev(`document.querySelector('.us .us-cols').focus(); return 1;`);
  for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  const ck = await ev(`const c = document.querySelector('.us .us-cols'); return { sel: [...c.querySelectorAll('i')].findIndex(i => i.classList.contains('sel')), n: c.querySelectorAll('i').length, tip: c.parentElement.querySelector('.us-tip').textContent };`);
  check('chart keys pick a bar and show its numbers', ck.sel === ck.n - 1 && /tokens$/.test(ck.tip), ck);
  // Legend link: shown exactly when legend.html answers, opens in a new tab.
  const lg = await ev(`const ok = await fetch('legend.html', { cache: 'no-store' }).then(r => r.ok, () => false); const a = document.querySelector('.us .us-legend'); return { ok, link: !!a, target: a ? a.target : '', href: a ? a.getAttribute('href') : '' };`);
  check('Legend link only when legend.html answers', lg.ok ? lg.link && lg.target === '_blank' && lg.href === 'legend.html' : !lg.link, lg);
  await esc(); await sleep(200);
  check('Esc closes Stats', await ev(`return document.querySelector('.us').hidden && document.querySelector('.us-shade').hidden && document.getElementById('drawer').hidden;`));

  // Answer in demo mode: the character leaves for the mine and a Working row appears; an Airflow session walks in and fishes.
  const pre = await ev(`D.S.push({ id: 't-airflow', title: 'Rerun the Airflow DAG for March', project: 'data-dags', branch: 'main', status: 'waiting', model: 'Opus 5.5', updated: Date.now() - 300000, tokens: 1000,
      ask: 'Clear the failed task instance?', answers: ['Clear it', 'Leave it'], tl: [['you', 'Rerun March.']], files: [] });
    return { running: document.querySelectorAll('.row.running').length, miners: document.querySelectorAll('.agent.miner').length };`);
  check('click character s1 again', await click('.agent[data-id="s1"]')); await sleep(450);
  check('click answer button', await click('#drawer [data-answer="Mock the client"]')); await sleep(250);
  const an = await ev(`const a = document.querySelector('.agent[data-id="s1"]:not(.miner)'); return { leaving: !!a && a.matches('.bye.glad.walking') && a.querySelector('.bubble').textContent === '♥', toast: document.getElementById('toast').textContent,
    running: document.querySelectorAll('.row.running').length, row: !!document.querySelector('.row.running[data-id="s1"]'), closed: document.getElementById('drawer').hidden || document.getElementById('drawer').classList.contains('closing') };`);
  check('answer sends the character off', an.leaving && an.closed && an.toast === 'Answered. Off it goes.', an);
  check('answer adds a Working row', an.running === pre.running + 1 && an.row, [pre.running, an.running]);
  await sleep(2900);
  const af = await ev(`const r = document.querySelector('.rod'); return { gone: !document.querySelector('.agent[data-id="s1"]:not(.miner)'), miner: !!document.querySelector('.agent.miner[data-id="s1"]'), miners: document.querySelectorAll('.agent.miner').length,
    fisher: !!document.querySelector('.agent.fisher[data-id="t-airflow"]'), rods: document.querySelectorAll('.rod').length, frames: !!r && r.querySelector('b').style.backgroundImage.startsWith('url("data:'), cw: r ? r.querySelector('canvas').width : 0 };`);
  check('s1 reaches the mine', af.gone && af.miner && af.miners === pre.miners + 1, af);
  check('fishing rod on the Airflow angler', af.fisher && af.rods >= 1 && af.frames && af.cw > 0, af);

  // Forced catch: reeling and caught classes plus canvas pixels appear, then all clear again.
  await ev(`const r = document.querySelector('.rod'); for (let i = 0; i < 40 && r._run; i++) await new Promise(f => setTimeout(f, 100)); clearTimeout(r._t); D.reel(r); return 1;`);
  await sleep(1500);
  const blank = `const c = r.querySelector('canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;`;
  const c1 = await ev(`const r = document.querySelector('.rod'); ${blank} return { reeling: r.classList.contains('reeling'), caught: !!document.querySelector('.agent.fisher.caught'), px: n };`);
  check('catch in progress', c1.reeling && c1.caught && c1.px > 0, c1);
  await sleep(2400);
  const c2 = await ev(`const r = document.querySelector('.rod'); ${blank} return { reeling: r.classList.contains('reeling'), caught: !!document.querySelector('.agent.fisher.caught'), px: n, timer: !!r._t };`);
  check('catch cleaned up', !c2.reeling && !c2.caught && c2.px === 0 && c2.timer, c2);
  await shot('4-after.png');

  // More sessions need you than the garden has room for: header, sign and garden agree, and the rest are named under the search box.
  const ov = await ev(`for (let i = 0; i < 25; i++) D.S.push({ id: 'w' + i, title: 'Extra question ' + i, project: 'p', branch: 'main', status: 'waiting', updated: Date.now() - 600000 - i * 1000, tokens: 0, ask: 'Go on?', tl: [], files: [] });
    D.render(); await new Promise(r => setTimeout(r, 700));
    const need = D.S.filter(s => s.status === 'waiting').length, drawn = document.querySelectorAll('#actors .agent:not(.miner)').length, h = document.getElementById('hits');
    return { need, drawn, head: +document.querySelector('#sum b').textContent, sign: document.getElementById('sign').textContent, hits: h.hidden ? '' : h.textContent, buttons: h.querySelectorAll('.ghit').length };`);
  check('header, sign and garden agree on who needs you', ov.head === ov.need && ov.sign === `${ov.need} need you +${ov.need - ov.drawn}` && ov.drawn === 24, ov);
  check('overflow named under the search box', ov.hits.startsWith(`${ov.need - ov.drawn} more need you, no room in the garden:`) && ov.buttons === 3, ov.hits);

  // Long Resting list: newest 12, a quiet line unfolds the rest in place, search looks through all of them.
  const lr = await ev(`for (let i = 0; i < 20; i++) D.S.push({ id: 'r' + i, title: 'Old note ' + i, project: 'p', branch: 'main', status: 'done', updated: Date.now() - 86400000 - i * 60000, tokens: 0, kind: 'interactive', tl: [], files: [] });
    D.render(); await new Promise(r => setTimeout(r, 400));
    const col = document.querySelectorAll('.lists .col')[1], b = col.querySelector('.showmore');
    return { rows: col.querySelectorAll('.rows > .row:not(.gone):not(.auto)').length, text: b.hidden ? '' : b.textContent, exp: b.getAttribute('aria-expanded') };`);
  check('Resting shows the newest 12 and offers the rest', lr.rows === 12 && lr.text === '▾ Show 13 more' && lr.exp === 'false', lr);
  await ev(`document.querySelectorAll('.lists .col')[1].querySelector('.showmore').scrollIntoView({ block: 'center' }); return 1;`);
  check('click Show more', await click('.showmore:not([hidden])')); await sleep(450);
  const lo = await ev(`const col = document.querySelectorAll('.lists .col')[1], b = col.querySelector('.showmore'), rows = [...col.querySelectorAll('.rows > .row:not(.gone):not(.auto)')];
    return { rows: rows.length, text: b.textContent, focus: rows.indexOf(document.activeElement) };`);
  check('it unfolds in place and focus lands on the first new row', lo.rows === 25 && lo.text === '▴ Show the newest 12 only' && lo.focus === 12, lo);
  await shot('5-resting-open.png');
  check('click Show fewer', await click('.showmore:not([hidden])')); await sleep(450);
  await search('old note 19');
  const ls = await ev(`const col = document.querySelectorAll('.lists .col')[1]; return { rows: [...col.querySelectorAll('.rows > .row:not(.gone)')].map(r => r.dataset.id), more: col.querySelector('.showmore').hidden };`);
  check('search finds a row beyond the first 12', ls.rows.join() === 'r19' && ls.more, ls);
  await search('');

  // Long Working list: newest 30, then "Show N more" unfolds in place and stays open while the page is; 60 and 200 working rows stay quick; the heading is logic.workingCount.
  for (const n of [60, 200]) {
    const wl = await ev(`const L = await import(new URL('src/logic.js', location.href).href), home = new Set(JSON.parse(localStorage.getItem('sentHome') || '[]'));
      for (let i = 0; i < ${n}; i++) D.S.push({ id: 'k' + i, title: 'Busy job ' + i, project: 'p', branch: 'main', status: 'running', updated: Date.now() - 1000 - i * 1000, tokens: 0, kind: 'interactive', tl: [], files: [] });
      let t0 = performance.now(); D.render(); const first = performance.now() - t0; await new Promise(r => setTimeout(r, 450));
      const col = document.querySelector('.lists .col'), b = col.querySelector('.showmore'), rows = () => [...col.querySelectorAll('.rows > .row:not(.gone)')];
      const out = { n: ${n}, head: col.querySelector('h3 .num').textContent, want: String(L.workingCount(D.S, home)), rows: rows().length, text: b.hidden ? '' : b.textContent, more: col.querySelector('.more').hidden, firstMs: Math.round(first) };
      b.scrollIntoView({ block: 'center' }); t0 = performance.now(); b.click(); out.openMs = Math.round(performance.now() - t0); await new Promise(r => setTimeout(r, 450));
      const r = rows(); out.open = r.length; out.focus = r.indexOf(document.activeElement); out.text2 = b.textContent; out.newest = r.every((x, i) => !i || D.S.find(s => s.id === x.dataset.id).updated <= D.S.find(s => s.id === r[i - 1].dataset.id).updated);
      t0 = performance.now(); D.render(); out.againMs = Math.round(performance.now() - t0); out.kept = rows().length;
      b.click(); await new Promise(r => setTimeout(r, 450)); out.closed = rows().length;
      return out;`);
    const all = Number(wl.want);
    check(`Working with ${n} more: newest 30, heading from workingCount, "Show N more" instead of "search to find"`, wl.head === wl.want && wl.rows === 30 && wl.text === `▾ Show ${all - 30} more` && wl.more, wl);
    check(`Working with ${n} more: unfolds in place, newest first, stays open across a redraw, folds again`, wl.open === all && wl.focus === 30 && wl.newest && wl.kept === all && wl.closed === 30 && wl.text2 === '▴ Show the newest 30 only', wl);
    check(`Working with ${n} more: redraws under 100 ms`, wl.firstMs < 100 && wl.openMs < 100 && wl.againMs < 100, [wl.firstMs, wl.openMs, wl.againMs]);
    if (n === 200) { await ev(`document.querySelector('.lists .col .showmore').click(); return 1;`); await sleep(450); await shot('5b-working-open.png'); await ev(`document.querySelector('.lists .col .showmore').click(); return 1;`); }
    await ev(`D.S = D.S.filter(s => !/^k\\d+$/.test(s.id)); D.render(); return 1;`); await sleep(450);
  }

  // Transcript rules on the example transcript s8: silent calls not drawn, folds count drawn lines, the CLI's group lines, hidden results, errors read "Error: ...", compaction is two lines, output whole.
  await ev(`D.render(); localStorage.removeItem('transcriptDetails'); return 1;`); await search('retry logic'); await sleep(200);
  check('row s8 opens', await click('.row[data-id="s8"]')); await sleep(450);
  const TV = `const t = document.getElementById('term'), txt = t.innerText, f = t.querySelector('.fold > summary'), det = document.querySelector('#drawer [data-details]');
    return { todo: [...t.querySelectorAll('.ln.tool b')].filter(b => b.textContent === 'TodoWrite').length, fold: f ? f.textContent : '', errs: [...t.querySelectorAll('.ln.tool.err .res .txt')].filter(x => !x.closest('.grp > details')).map(x => x.textContent),
      cmp: [...t.querySelectorAll('.cmp .ln .txt')].map(x => x.textContent), hints: /ctrl\\+o/.test(txt), outs: [...t.querySelectorAll('.ln.sub .txt')].map(x => x.textContent.split('\\n').length), update: [...t.querySelectorAll('.ln.tool b')].some(b => b.textContent === 'Update'),
      groups: [...t.querySelectorAll('.grp > .xp > summary')].map(x => x.textContent), xp: t.querySelectorAll('.xp').length, open: t.querySelectorAll('.xp[open]').length,
      push: txt.includes('Everything up-to-date'), agent: txt.includes('send() is called from'), gh: txt.includes('Error: gh: not logged in'),
      det: det ? det.getAttribute('aria-pressed') : null, saved: localStorage.getItem('transcriptDetails'), head: document.querySelector('#drawer .tmeta').textContent };`;
  const tv = await ev(TV);
  check('silent tool calls are not drawn; a failed one is', tv.todo === 1, tv.todo);
  check('fold counts drawn lines, a group line once', /^⏺?7 tool calls · Update ×2, Read, Write, Search, Bash ×2 · 1 failed/.test(tv.fold), tv.fold);
  check('errors read "Error: <text>"', tv.errs.join('|') === 'Error: String to replace not found in file.|Error: Invalid input: todos[0].status must be one of pending, in_progress, completed', tv.errs);
  check('compaction is two lines, no key hints', tv.cmp.join('|') === 'Conversation compacted|Compact summary' && !tv.hints, tv.cmp);
  check('CLI tool lines and whole output', tv.update && tv.outs.join() === '1,4,1,1,6', tv.outs);  // interrupt, cut older ! output, /model output, image, newest ! output whole
  check('group lines in the CLI words', tv.groups.join('|') === 'Read 2 files|Read 1 file|Searched for 1 pattern, ran 2 shell commands|Called metrics|Ran 2 shell commands', tv.groups);
  check('hidden results stay hidden, a failed call in a closed group shows nothing under it; Details off by default', !tv.push && !tv.agent && !tv.gh && tv.open === 0 && tv.det === 'false', tv);
  await shot('2c-transcript-collapsed.png');
  // Expand in place by a click, keep it open across an incremental update, collapse with Enter on the focused line.
  const G = `[...document.querySelectorAll('#term .grp > .xp > summary')].find(x => x.textContent === 'Ran 2 shell commands')`;
  await ev(`${G}.scrollIntoView({ block: 'center' }); return 1;`); await sleep(100);
  const gp = await ev(`const b = ${G}.getBoundingClientRect(); return [b.left + 20, b.top + b.height / 2];`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: gp[0], y: gp[1], button: 'left', clickCount: 1 }); await sleep(150);
  const ex1 = await ev(TV);
  check('a click expands the group line in place: each call and its result', ex1.push && ex1.open === 1 && ex1.gh, ex1);
  await shot('2d-transcript-expanded.png');
  const upd = await ev(`const s = D.S.find(x => x.id === 's8'), t = document.getElementById('term'), keep = t.children[2];
    s.full = [...(s.full || (await import(new URL('src/demo.js', location.href).href)).EXAMPLE_FULL.s8), ['claude', 'One more line.']]; (await import(new URL('src/drawer.js', location.href).href)).drawDrawer(s); await new Promise(r => setTimeout(r, 50));
    return { kept: keep.isConnected, open: !!${G}.parentElement.open, last: t.lastElementChild.innerText.includes('One more line.') };`);
  check('the open line survives an incremental update that appends only the new event', upd.kept && upd.open && upd.last, upd);
  await ev(`${G}.focus(); return 1;`); await press('Enter'); await sleep(120);
  check('Enter on the focused line collapses it', await ev(`return !${G}.parentElement.open && !document.getElementById('term').innerText.includes('Everything up-to-date');`));
  await ev(`const a = document.querySelector('#term > .xp[data-x] > summary'); a.focus(); return 1;`); await press('Enter'); await sleep(120);
  check('Enter expands a single hidden result (subagent call)', await ev(`return document.getElementById('term').innerText.includes('send() is called from');`));
  // Details switch: every call and result at once, remembered by the browser, off again by the same switch.
  check('click Details', await click('#drawer [data-details]')); await sleep(200);
  const dt = await ev(TV);
  check('Details on: no group lines, every hidden result shown, remembered', dt.det === 'true' && dt.groups.length === 0 && dt.xp === 0 && dt.push && dt.agent && dt.saved === '1', dt);
  await shot('2e-transcript-details.png');
  await esc(); await sleep(350); await send('Page.reload'); await sleep(1500);
  await search('retry logic'); await sleep(200); await click('.row[data-id="s8"]'); await sleep(450);
  const dre = await ev(TV);
  check('Details stays on after a reload', dre.det === "true" && dre.groups.length === 0 && dre.push, dre);
  await click('#drawer [data-details]'); await sleep(200);
  const doff = await ev(TV);
  check('Details off again: back to the CLI default view', doff.det === 'false' && doff.groups.length === 5 && !doff.push && doff.saved === '0', doff);
  await esc(); await sleep(350); await search('');

  // Find in a session (s8): / opens it, a word in a closed group's hidden result opens that group and is marked, Esc closes it and restores what it opened.
  await ev(`localStorage.removeItem('transcriptDetails'); return 1;`); await search('retry logic'); await sleep(200);
  check('row s8 opens for Find', await click('.row[data-id="s8"]')); await sleep(450);
  const key = async (k, mods = 0) => { const vk = { Enter: 13, Escape: 27, Tab: 9 }[k]; await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, modifiers: mods }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, modifiers: mods }); };
  await ev(`document.getElementById('term').focus(); return 1;`); await press('/'); await sleep(50);
  const fo = await ev(`return { focus: document.activeElement?.id, bar: !document.getElementById('tfind').hidden, exp: document.querySelector('#drawer [data-find]').getAttribute('aria-expanded') };`);
  check('Find: / in the transcript opens the box and focuses it', fo.focus === 'fq' && fo.bar && fo.exp === 'true', fo);
  // Type a query the way a person does (one input event) after a pause, and wait for the search and the next frame.
  const typeFind = async q => { await sleep(150); return ev(`const q = document.getElementById('fq'), r0 = D.findStats().runs, t0 = performance.now(); q.value = ${JSON.stringify(q)}; q.dispatchEvent(new Event('input', { bubbles: true }));
    for (let n = 0; D.findStats().runs === r0 && n < 1000; n++) await new Promise(r => setTimeout(r, 2)); const ms = performance.now() - t0; await new Promise(r => requestAnimationFrame(() => r())); const frame = performance.now() - t0;
    const t = document.getElementById('term').getBoundingClientRect(), cur = CSS.highlights.get('desk-find-cur'), rs = cur ? [...cur] : [], b = rs[0] ? rs[0].getBoundingClientRect() : null;
    return { ms, frame, ...D.findStats(), cur: rs.length, all: CSS.highlights.get('desk-find')?.size || 0, seen: !!b && b.height > 0 && b.top >= t.top && b.bottom <= t.bottom, word: rs[0] ? rs[0].toString() : '', xpOpen: document.querySelectorAll('#term .xp[open], #term .fold[open]').length };`); };
  const fg1 = await typeFind('UP-TO-DATE');
  check('Find: a word in a closed group line is found, its group opens, the word is marked in view', fg1.label === '1 of 1' && fg1.opened.length === 1 && fg1.xpOpen === 1 && fg1.seen && fg1.word.toLowerCase() === 'up-to-date', fg1);
  await shot('8a-find-in-group.png');
  await key('Escape'); await sleep(100);
  const fc = await ev(`return { bar: document.getElementById('tfind').hidden, focus: document.activeElement?.id, xpOpen: document.querySelectorAll('#term .xp[open]').length, marks: CSS.highlights.get('desk-find-cur')?.size || 0, drawer: !document.getElementById('drawer').hidden };`);
  check('Find: Esc closes the box only; the group it opened closes again, marks go, focus returns', fc.bar && fc.focus === 'term' && fc.xpOpen === 0 && fc.marks === 0 && fc.drawer, fc);
  // A user-opened line stays open when Find closes.
  await ev(`[...document.querySelectorAll('#term .grp > .xp > summary')].find(x => x.textContent === 'Read 2 files').parentElement.open = true; return 1;`); await press('/'); await typeFind('gh: not logged in'); await key('Escape'); await sleep(100);
  check('Find: a line the reader opened stays open after Find closes', await ev(`return [...document.querySelectorAll('#term .grp > .xp > summary')].find(x => x.textContent === 'Read 2 files').parentElement.open;`));

  // 20,000 events: whole-session search, a match above the drawn window is drawn, a match inside a closed group opens it; timing per key.
  const bigN = 20000;
  const bg = await ev(`const s = D.S.find(x => x.id === 's8'), ev = [];
    for (let i = 0; i < ${bigN}; i++) ev.push(i === 60 ? ['you', 'the Zebra prompt'] : i % 4 === 0 ? ['you', 'prompt ' + i] : i % 4 === 1 ? ['claude', 'reply ' + i + ' with **some** words'] : ['tool', 'Bash', 'ls', 'out ' + i + (i === 70 ? ' quokka' : ''), 0, 'Bash(ls)', 1]);
    s.full = ev; const t0 = performance.now(); (await import(new URL('src/drawer.js', location.href).href)).drawDrawer(s); const draw = performance.now() - t0;
    const V = await import(new URL('src/transcript_view.js', location.href).href);
    return { draw, drawn: document.querySelectorAll('#term [data-i]').length, more: document.querySelector('#term > .more')?.textContent, head: document.querySelector('#drawer .tmeta').textContent, lines: V.viewLines(ev, false), linesD: V.viewLines(ev, true) };`);
  check('20,000 events: the header counts drawn lines of this view, not events', bg.head.includes(`${bg.lines.toLocaleString('en-US')} lines`) && bg.lines < bigN, bg);
  check('20,000 events: "Show earlier" says about how many lines are left', /^Show earlier · about [\d,]+ more lines$/.test(bg.more || ''), bg.more);
  await ev(`document.getElementById('term').focus(); return 1;`); await press('/'); await sleep(50);
  const z = await typeFind('zebra');
  check('20,000 events: a match not drawn yet is drawn, scrolled to and marked', z.label === '1 of 1' && z.cur === 1 && z.seen && z.word === 'Zebra' && await ev(`return !!document.querySelector('#term [data-i="60"]');`), z);
  await shot('8b-find-undrawn.png');
  const qk = await typeFind('quokka');
  check('20,000 events: a hidden result in a closed group opens and is marked; the earlier match closes its part again', qk.label === '1 of 1' && qk.seen && qk.opened.length === 1 && qk.xpOpen === 1, qk);
  const one = await typeFind('e'), two = await typeFind('reply 1999');
  check('20,000 events: one letter searches every event in under 50 ms to the first mark', one.hits > 5000 && one.ms < 50 && one.cur > 0, { ms: one.ms, frame: one.frame, hits: one.hits });
  check('20,000 events: two words must sit in the same event', two.hits === 2 && two.label.endsWith(' of 2'), { hits: two.hits, label: two.label, ms: two.ms });
  // Enter and Shift+Enter step and wrap; the count follows.
  await typeFind('zebra prompt'); const fs0 = (await ev(`return D.findStats();`)).label;
  await key('Enter'); await sleep(50); const fs1 = await ev(`return D.findStats();`); await key('Enter', 8); await sleep(50); const fs2 = await ev(`return D.findStats();`);
  check('Find: Enter steps to the next match and wraps, Shift+Enter back', fs0 === '1 of 1' && fs1.label === '1 of 1' && fs2.label === '1 of 1', [fs0, fs1.label, fs2.label]);
  const pz = await typeFind('prompt'); await key('Enter', 8); await sleep(60); const pz1 = await ev(`return D.findStats();`); await key('Enter'); await key('Enter'); await sleep(60); const pz2 = await ev(`return D.findStats();`);
  check('Find: stepping moves one match each press', pz1.k === pz.k - 1 && pz2.k === (pz.k + 1) % pz.hits, [pz.k, pz1.k, pz2.k, pz.hits]);
  // An update under an open Find: new events are searched, the place is kept, the view does not jump.
  await typeFind('zebra');
  const fup = await ev(`const s = D.S.find(x => x.id === 's8'), t = document.getElementById('term'), top = t.scrollTop; s.full = [...s.full, ['claude', 'another zebra here']];
    (await import(new URL('src/drawer.js', location.href).href)).drawDrawer(s); await new Promise(r => setTimeout(r, 30)); return { ...D.findStats(), top: t.scrollTop === top, same: document.getElementById('term') === t, focus: document.activeElement?.id };`);
  check('Find: an incremental update keeps the place and searches the new event', fup.label === '1 of 2' && fup.cur === 60 && fup.top && fup.same && fup.focus === 'fq', fup);
  // Far matches at 20,000 events: a window around the match with a gap line to the newest part; steps move or grow the window; every jump under 50 ms.
  await ev(`const s = D.S.find(x => x.id === 's8'), ev = s.full.slice(0, 20000); ev[0] = ['you', 'a new start']; for (const i of [3000, 9000, 9300, 15000]) ev[i] = ['you', 'far walrus ' + i]; s.full = [...ev, ['claude', 'another zebra here']];
    (await import(new URL('src/drawer.js', location.href).href)).drawDrawer(s); return 1;`);
  const fw = await typeFind('walrus');
  const gapOf = `const g = document.querySelector('#term > .gap'), t = document.getElementById('term'), tr = t.getBoundingClientRect();`;
  const far = await ev(`${gapOf} return { ...D.findStats(), gap: g ? g.textContent : '', drawn: t.querySelectorAll(':scope > [data-i], :scope > [data-at]').length, ticks: document.querySelectorAll('#drawer > .fticks:not([hidden]) i').length, curTick: document.querySelectorAll('#drawer > .fticks i.cur').length };`);
  check('Find far: the match gets a window of its own and a gap line to the newest part, not every event below it', far.win && far.win.lo <= far.cur && far.win.hi > far.cur && far.from - far.cur > 5000 && /^Show later · about [\d,]+ more lines$/.test(far.gap) && far.drawn < 1200 && fw.seen && fw.ms < 50, { ms: fw.ms, cur: far.cur, win: far.win, from: far.from, gap: far.gap, drawn: far.drawn });
  check('Find far: ticks beside the scrollbar for drawn matches, the current one stronger', far.ticks >= 1 && far.curTick === 1, { ticks: far.ticks, cur: far.curTick });
  await shot('8d-find-far-gap.png');
  const jumps = [];
  for (let n = 0; n < 4; n++) { await key('Enter', 8); await sleep(40); jumps.push(await ev(`const r = D.findStats(), cur = CSS.highlights.get('desk-find-cur'), b = cur && [...cur][0] ? [...cur][0].getBoundingClientRect() : null, t = document.getElementById('term').getBoundingClientRect(); return { ms: r.ms, cur: r.cur, win: r.win, seen: !!b && b.top >= t.top && b.bottom <= t.bottom };`)); }
  check('Find far: each step to a far match is drawn, in view and under 50 ms; a near one grows the window', jumps.every(j => j.ms < 50 && j.seen) && jumps.map(j => j.cur).join() === '15000,9300,9000,3000' && jumps[2].win.lo <= 9000 && jumps[2].win.hi > 9300, jumps);
  await shot('8e-find-ticks.png');
  const gb = await ev(`${gapOf} const w = D.findStats().win; t.scrollTop += g.getBoundingClientRect().bottom - tr.bottom + 40; return w;`);
  await shot('8f-find-gap-line.png');
  const gq = await ev(`await new Promise(r => setTimeout(r, 600)); const after = D.findStats(); return { after: after.win, from: after.from, gap: !!document.querySelector('#term > .gap') };`);
  check('Find far: a gap line that stays in view draws the lines it stands for, part by part', gq.after && gq.after.hi > gb.hi && gq.gap, { before: gb, ...gq });
  const gc = await ev(`for (let n = 0; n < 30 && document.querySelector('#term > .gap'); n++) { document.querySelector('#term > .gap').click(); await new Promise(r => setTimeout(r, 20)); } return { gap: !!document.querySelector('#term > .gap'), win: D.findStats().win, from: D.findStats().from };`);
  check('Find far: clicking the gap line until it is gone joins the window to the newest part', !gc.gap && !gc.win, gc);
  await ev(`const s = D.S.find(x => x.id === 's8'); s.full = [['you', 'again'], ...s.full.slice(1)]; (await import(new URL('src/drawer.js', location.href).href)).drawDrawer(s); return 1;`);
  const fw2 = await typeFind('walrus 3000'); const kept = await ev(`const s = D.S.find(x => x.id === 's8'); s.full = [...s.full, ['claude', 'one more walrus']]; (await import(new URL('src/drawer.js', location.href).href)).drawDrawer(s); await new Promise(r => setTimeout(r, 30)); return { ...D.findStats(), gap: !!document.querySelector('#term > .gap') };`);
  check('Find far: an update under a far window keeps the window and searches the new event', fw2.win && kept.win && kept.gap && kept.label === '1 of 1' && kept.cur === 3000, { fw2: fw2.win, kept });
  await key('Escape'); await sleep(100);
  const back = await ev(`const t = document.getElementById('term'); return { gap: !!t.querySelector(':scope > .gap'), win: D.findStats().win, bottom: t.scrollHeight - t.scrollTop - t.clientHeight < 4, ticks: document.querySelectorAll('#drawer > .fticks:not([hidden])').length };`);
  check('Find far: closing Find returns to the newest part (no window, no gap, at the bottom, no ticks)', !back.gap && !back.win && back.bottom && !back.ticks, back);
  // Words as drawn: split by Markdown marks, a link's address, a group line's own words.
  await ev(`const s = D.S.find(x => x.id === 's8'); s.full = [['you', 'start'], ['claude', 'we **re**try now, see [the docs](https://docs.example.org/x) and \`co\`de'], ['tool', 'Bash', 'ls', 'a', 0, 'Bash(ls)', 1], ['tool', 'Bash', 'pwd', 'b', 0, 'Bash(pwd)', 1], ['claude', 'done']];
    (await import(new URL('src/drawer.js', location.href).href)).drawDrawer(s); return 1;`);
  await ev(`document.getElementById('term').focus(); return 1;`); await press('/'); await sleep(50);
  const mw = await typeFind('retry');
  check('Find: a word split by bold marks is marked as one word', mw.label === '1 of 1' && mw.word === 'retry' && mw.cur === 1, mw);
  const mc = await typeFind('code'); check('Find: a word split by inline code is marked as one word', mc.word === 'code', mc.word);
  const ml = await typeFind('docs.example.org');
  const mlc = await ev(`return { line: document.querySelectorAll('#term .fline').length, marks: CSS.highlights.get('desk-find-cur')?.size || 0 };`);
  check('Find: a link address (not drawn) marks the whole line, never other words', ml.label === '1 of 1' && mlc.line === 1 && mlc.marks === 0, { ml: ml.label, ...mlc });
  const gw = await typeFind('ran 2 shell');
  check('Find: a group line\'s own words are found and marked on the line, nothing opened', gw.label === '1 of 1' && gw.cur === 3 && gw.opened.length === 0 && gw.xpOpen === 0 && gw.seen, gw);
  await key('Escape'); await sleep(100);
  check('Find: Esc after a big search leaves nothing open that the reader did not open', await ev(`return document.querySelectorAll('#term .xp[open], #term .fold[open]').length === 0 && document.getElementById('tfind').hidden;`));
  // Details view counts every drawn call.
  await click('#drawer [data-details]'); await sleep(200);
  const hd = await ev(`const V = await import(new URL('src/transcript_view.js', location.href).href); return { head: document.querySelector('#drawer .tmeta').textContent, n: V.viewLines(D.S.find(x => x.id === 's8').full, true).toLocaleString('en-US') };`);
  check('Details: the header counts one line per drawn event', hd.head.includes(`${hd.n} lines`), hd);
  await click('#drawer [data-details]'); await sleep(200);
  await esc(); await sleep(350); await ev(`const s = D.S.find(x => x.id === 's8'); delete s.full; return 1;`); await search('');

  // Reply box keeps its draft: Esc with text leaves the box, a second Esc closes the sidebar, reopening brings the text back.
  const wid = await ev(`return (D.S.find(s => s.status === 'waiting') || {}).id;`);
  check('open a waiting session for the draft check', await click(`button[data-id="${wid}"]`)); await sleep(450);
  await ev(`const r = document.getElementById('reply'); r.focus(); r.value = 'half a reply'; r.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  await key('Escape'); await sleep(80);
  const d1 = await ev(`return { open: !document.getElementById('drawer').hidden, focus: document.activeElement?.id, text: document.getElementById('reply').value };`);
  check('Reply: Esc with text leaves the box and keeps the text', d1.open && d1.focus === 'term' && d1.text === 'half a reply', d1);
  await key('Escape'); await sleep(350);
  check('Reply: a second Esc closes the sidebar', await ev(`return document.getElementById('drawer').hidden;`));
  await click(`button[data-id="${wid}"]`); await sleep(450);
  check('Reply: the draft is back when the sidebar opens again', await ev(`return document.getElementById('reply').value === 'half a reply';`));
  await ev(`const r = document.getElementById('reply'); r.value = ''; r.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
  await esc(); await sleep(350);

  // QA round 9 item 3: every control left in a closed sidebar's markup is clicked; nothing throws and nothing opens.
  await search('retry logic'); await sleep(200); await click('.row[data-id="s8"]'); await sleep(450); await esc(); await sleep(350);
  const e3 = errs.length, stale = await ev(`const bs = [...document.querySelectorAll('#drawer button, #drawer summary')]; for (const b of bs) b.click(); await new Promise(r => setTimeout(r, 200)); return { n: bs.length, open: D.st.open, hidden: document.getElementById('drawer').hidden, find: D.findStats().open };`);
  check('a closed sidebar\'s leftover controls: each clicked, no exception, nothing opens', stale.n >= 5 && !stale.open && stale.hidden && !stale.find && errs.length === e3, { ...stale, errs: errs.slice(e3) });
  await search('');

  // Phone width: Find and Details reachable by Tab in reading order; the box fits.
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(300);
  await search('retry logic'); await sleep(200); await click('.row[data-id="s8"]'); await sleep(450);
  check('390 px: the Find control opens the box', await click('#drawer [data-find]') && await ev(`return document.activeElement?.id === 'fq';`));
  await typeFind('up-to-date');
  const order = []; await ev(`document.querySelector('#drawer [data-find]').focus(); return 1;`);
  for (let i = 0; i < 8; i++) { order.push(await ev(`const a = document.activeElement; return a.id || a.dataset.find && 'find' || a.dataset.details && 'details' || a.dataset.fstep && 'step' + a.dataset.fstep || a.dataset.fclose && 'fclose' || a.dataset.act || a.tagName.toLowerCase();`)); await key('Tab'); await sleep(30); }
  const nw = await ev(`const d = document.getElementById('drawer'), f = document.getElementById('tfind').getBoundingClientRect(); return { over: d.scrollWidth - d.clientWidth, right: f.right <= innerWidth + 0.5 };`);
  check('390 px: Tab goes Find, Details, close, the find box, its buttons, then the transcript', order.slice(0, 8).join() === 'find,details,close,fq,step-1,step1,fclose,term', order);
  check('390 px: the find bar fits without sideways scrolling', nw.over === 0 && nw.right, nw);
  await shot('8c-find-390.png');
  await ev(`document.getElementById('fq').focus(); return 1;`); await key('Escape'); await esc(); await sleep(350); await search('');
  await send('Emulation.clearDeviceMetricsOverride'); await sleep(300);

  // Today card in Stats: the scenery's numbers from the garden's own rules, reachable by Tab.
  check('click Stats for the Today card', await click('.us-btn')); await sleep(900);
  const td = await ev(`const c = document.querySelector('.us .us-today'); return c ? { facts: [...c.querySelectorAll('.us-facts > div')].map(d => d.querySelector('b').textContent + ' | ' + d.querySelector('.us-lbl').textContent), tab: c.tabIndex, title: c.querySelector('h3').firstChild.textContent.trim() } : null;`);
  check('Today card explains the scenery', !!td && td.title === 'Today in the garden' && td.facts.length === 5 && /ore on the cart: step \d of 4/.test(td.facts[0]) && /sunflower/.test(td.facts[1]) && /paper boat/.test(td.facts[2]) && /^(yes|no) \| comet tonight/.test(td.facts[3]) && /^\d+ \| need you · longest has waited (under a minute|\d+ min)/.test(td.facts[4]) && td.tab === 0, td);
  await ev(`document.querySelector('.us .us-today').scrollIntoView({ block: 'center' }); return 1;`); await sleep(100);
  await shot('3b-stats-today.png');
  await esc(); await sleep(200);

  check('window.desk.drift is a count for the soak tools (0 in the demo)', await ev(`return D.drift === 0 && typeof D.driftChecks === 'number' && typeof D.checkDrift === 'function';`));
  // Nothing new on window except the deliberate ones.
  const now = await ev('return Object.keys(window);', true), allowed = new Set(['desk', 'DESK_TOKEN', 'Terminal', 'FitAddon', 'WebLinksAddon']);
  const extra = now.filter(k => !base.includes(k) && !allowed.has(k));
  if (LEGACY) console.log(`INFO window keys added by the old page: ${extra.length} (${extra.slice(0, 12).join(', ')}${extra.length > 12 ? ', …' : ''})`);
  else check('no globals beyond window.desk', extra.length === 0 && now.includes('desk'), extra);
  check('no console errors or exceptions', errs.length === 0, errs);

  // Preview addresses: rain puts umbrellas on the waiting characters; big-day numbers load cleanly and the Today card uses them.
  await send('Page.navigate', { url: URL + '?wx=61' }); await sleep(1500);
  const um = await ev(`return { umb: document.querySelectorAll('#actors .agent:not(.miner) .umb').length, agents: document.querySelectorAll('#actors .agent:not(.miner)').length };`);
  check('?wx=61 shows umbrellas', um.umb > 0 && um.umb === um.agents, um);
  const before = errs.length;
  await send('Page.navigate', { url: URL + '?tokens=12e6&prs=6&runs=3' }); await sleep(1500);
  await ev(`document.querySelector('.us-btn').click(); return 1;`); await sleep(300);
  const big = await ev(`return [...document.querySelectorAll('.us .us-today .us-facts b')].map(b => b.textContent);`);
  check('?tokens=12e6&prs=6&runs=3 loads with no console errors', errs.length === before, errs.slice(before));
  check('Today card follows the preview numbers', big.join('|') === '12.0M|6|3|yes|' + big[4], big);
  await shot('6-preview-bigday.png');

  // First-run notices: ?setup=nodata says what is wrong in the empty lists; ?setup=nocli lists sessions and says under the search box that terminals and replies are off.
  await send('Page.navigate', { url: URL + '?setup=nodata' }); await sleep(1200);
  const nd = await ev(`const n = [...document.querySelectorAll('.lists .none')].filter(x => !x.hidden).map(x => x.innerText.trim()); return { none: n, code: document.querySelectorAll('.lists .none code').length, setup: document.getElementById('setup').hidden, rows: document.querySelectorAll('.lists .row').length, title: document.title };`);
  check('?setup=nodata: the empty Working list says what is wrong and how to check', nd.rows === 0 && /^No Claude Code data found: run claude once, then reload\.\nRun python3 server\.py doctor to check the setup\.$/.test(nd.none[0] || '') && nd.code === 2 && !/No agent is working/.test(nd.none.join()) && nd.setup && nd.title === 'Session Desk', nd);
  await send('Page.navigate', { url: URL + '?setup=nocli' }); await sleep(1200);
  const nc = await ev(`const s = document.getElementById('setup'), b = s.getBoundingClientRect(), q = document.getElementById('search').getBoundingClientRect(); return { hidden: s.hidden, text: s.innerText, below: b.top >= q.bottom - 1, rows: document.querySelectorAll('.lists .row').length, none: [...document.querySelectorAll('.lists .none')].filter(x => !x.hidden).map(x => x.textContent) };`);
  check('?setup=nocli: one quiet line under the search box, lists as usual', !nc.hidden && nc.text === 'Terminals and quick replies are off: The claude command was not found: install Claude Code or set DESK_CLAUDE_BIN. Run python3 server.py doctor to check the setup.' && nc.below && nc.rows > 0, nc);
  await shot('7-setup-nocli.png');
  // Read-only app folder (QA round 9 item 5): with sessions the line under the search box, with none the empty lists, both in the server's words.
  await send('Page.navigate', { url: URL + '?setup=readonly' }); await sleep(1200);
  const ro = await ev(`const s = document.getElementById('setup'); return { hidden: s.hidden, text: s.innerText, rows: document.querySelectorAll('.lists .row').length };`);
  check('?setup=readonly: the line under the search box says page terminals are off, in the server\'s words', !ro.hidden && ro.text === 'Page terminals are off: This folder is read-only: start with DESK_STATE_DIR=<a folder you can write>. Run python3 server.py doctor to check the setup.' && ro.rows > 0, ro);
  await send('Page.navigate', { url: URL + '?setup=readonly-empty' }); await sleep(1200);
  const ro0 = await ev(`const n = [...document.querySelectorAll('.lists .none')].filter(x => !x.hidden).map(x => x.innerText.trim()); return { none: n, setup: document.getElementById('setup').hidden, rows: document.querySelectorAll('.lists .row').length };`);
  check('?setup=readonly-empty: the empty lists carry the server\'s sentence, as for a missing data folder', ro0.rows === 0 && ro0.setup && ro0.none[0] === 'This folder is read-only: start with DESK_STATE_DIR=<a folder you can write>.\nRun python3 server.py doctor to check the setup.', ro0);
  await send('Page.navigate', { url: URL }); await sleep(1200);
  check('no setup switch: no setup line', await ev(`return document.getElementById('setup').hidden && document.getElementById('setup').textContent === '';`));

  // Throttled frames (an occluded window or an embedded pane): requestAnimationFrame fires every 500 ms while the page stays visible; header, lists and Stats must be final within 1 s of the data.
  const slowRaf = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const q = new Map(); let n = 0, t = 0;
    window.requestAnimationFrame = cb => { q.set(++n, cb); if (!t) t = setTimeout(() => { t = 0; const now = performance.now(), run = [...q.values()]; q.clear(); for (const f of run) f(now); }, 500); return n; };
    window.cancelAnimationFrame = id => { q.delete(id); }; })();` });
  await send('Page.navigate', { url: URL });
  const T0 = Date.now(); let rowsAt = 0;
  for (let i = 0; i < 100 && !rowsAt; i++) { if (await ev(`return document.querySelectorAll('.lists .row').length;`).catch(() => 0)) rowsAt = Date.now(); else await sleep(20); }
  // Header numbers and Working rows against the page's own rules, read at once and again 1 s later.
  const finalNow = `const L = await import(new URL('src/logic.js', location.href).href), U = await import(new URL('src/util.js', location.href).href), home = new Set(JSON.parse(localStorage.getItem('sentHome') || '[]'));
    const c = L.tally(D.S, home), want = [c.need, c.working, c.resting, c.auto, U.fmt(c.tokens)].map(String), got = [...document.querySelectorAll('#sum .num')].map(e => e.textContent);
    const col = document.querySelector('.lists .col'), shown = [col.querySelector('h3 .num').textContent, col.querySelectorAll('.rows > .row:not(.gone)').length], running = D.S.filter(s => L.group(s, home) === 'running').length;
    return { ok: got.join() === want.join() && shown[0] === String(running) && shown[1] === running, got, want, shown, running };`;
  const th0 = await ev(finalNow); await sleep(Math.max(0, 1000 - (Date.now() - rowsAt)));
  const th1 = await ev(finalNow);
  check('throttled frames: header and Working list final when the data lands', !!rowsAt && th0.ok, { ms: rowsAt - T0, ...th0 });
  check('throttled frames: still final 1 s later', th1.ok, th1);
  // A change while frames are slow: one session starts working; the header and its row move in the same task.
  const thc = await ev(`const s = D.S.find(x => x.status !== 'running' && x.status !== 'waiting'); s.status = 'running'; s.updated = Date.now(); D.render(); const row = !!document.querySelector('.lists .col .row.running[data-id="' + s.id + '"]:not(.gone)'); ${finalNow.replace('return { ok:', 'return { row, ok:')}`);
  check('throttled frames: a change shows in the same task', thc.ok && thc.row, thc);
  await sleep(1000); const thc1 = await ev(finalNow); check('throttled frames: the change is still final 1 s later', thc1.ok, thc1);
  // Stats tiles show their final numbers from the first draw; counting is decoration a late frame ends.
  await ev(`document.querySelector('.us-btn').click(); return 1;`); const ts = Date.now();
  const tiles = `const L = await import(new URL('src/logic.js', location.href).href), t = [...document.querySelectorAll('.us [data-n][data-f="i"]')]; return { n: t.length, bad: t.filter(e => e.textContent !== L.usInt(+e.dataset.n)).map(e => e.textContent + ' != ' + e.dataset.n) };`;
  const st0 = await ev(tiles); await sleep(Math.max(0, 1000 - (Date.now() - ts))); const st1 = await ev(tiles);
  check('throttled frames: Stats tiles final when drawn and 1 s later', st0.n > 0 && !st0.bad.length && !st1.bad.length, { first: st0, later: st1 });
  await esc(); await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slowRaf.identifier });

  // Opened as a file (modules cannot load from file://): one plain panel that says how to open the app; no garden, no pill, no spinner.
  if (!LEGACY) {
    await send('Page.navigate', { url: 'file://' + join(ROOT, 'index.html') }); await sleep(300);
    for (let i = 0; i < 200 && !(await ev(`return location.protocol === 'file:' && !!document.querySelector('.fileopen');`, true).catch(() => false)); i++) await sleep(100);
    const fo = await ev(`return { text: document.querySelector('.fileopen')?.innerText || '', garden: !!document.getElementById('garden'), pill: !!document.getElementById('mode'), loading: document.body.innerText.includes('Loading') };`, true);
    check('opened as a file: one panel says how to open the app, nothing else', fo.text.replace(/\n+/g, ' ') === 'Session Desk Open this page through the app: run python3 server.py in the app folder and open the address it prints.' && !fo.garden && !fo.pill && !fo.loading, fo);
    await shot('9-opened-as-file.png');
  }
} catch (e) {
  fails.push('crash'); console.log('FAIL crash ' + e.message); if (errs.length) console.log('errors so far: ' + JSON.stringify(errs));
} finally {
  await stop(chrome, 3000); await stop(server, 3000);
}
console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}; screenshots in ${shots}`);
process.exit(fails.length ? 1 : 0);
