// Headless smoke test in real mode: runs server.py on a free port against a temp copy of the fixture data, checks push refreshes and the poll fallback, exits 1 on any failure.
// Usage: node tools/smoke_real.mjs [--shots DIR]   (SMOKE_REAL_PORT and SMOKE_DEBUG_PORT fix the ports; otherwise free ones are picked so parallel runs never collide)
import { appendFileSync, chmodSync, cpSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from './smoke_lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, '..');
const home = tempDir('desk-home-'), profile = tempDir('desk-chrome-'), state = tempDir('desk-state-');
cpSync(join(APP, 'tests', 'fixtures', 'home'), home, { recursive: true });
// One invented session whose folder exists, and a stub CLI that echoes typed lines, so the Terminal tab runs without the real CLI.
const SID = 'abcdef12-0000-4000-8000-0000000000aa', work = tempDir('desk-work-'), cli = join(state, 'echo-cli');
mkdirSync(join(home, 'projects', '-tmp-smoke'), { recursive: true });
writeFileSync(join(home, 'projects', '-tmp-smoke', SID + '.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), entrypoint: 'cli', cwd: work, message: { role: 'user', content: 'restart smoke' } }) + '\n');
writeFileSync(cli, `#!/usr/bin/env python3\nimport os, sys\nprint("cli ready", flush=True)\nfor line in sys.stdin:\n    print("got " + line.strip(), flush=True)\n`); chmodSync(cli, 0o755);
const ENV = { ...process.env, DESK_CLAUDE_DIR: home, DESK_STATE_DIR: state, DESK_CLAUDE_BIN: cli };
const shots = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : '';  // optional folder for a Terminal tab screenshot
const fails = [], errs = [];
const check = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info === undefined ? '' : ' ' + JSON.stringify(info)}`); if (!cond) fails.push(name); };
// Canned forecast so the page makes no outside request.
const WEATHER = JSON.stringify({ current: { temperature_2m: 21, weather_code: 1, cloud_cover: 10 }, daily: { sunrise: ['2026-06-15T05:30'], sunset: ['2026-06-15T19:45'] } });

let server, chrome, PORT = Number(process.env.SMOKE_REAL_PORT || 0), URL = '';
// Start server.py (first time on port 0 so the OS picks; a restart reuses that port so the page reconnects) and wait until it answers.
async function startServer() {
  server = launch('python3', [join(APP, 'server.py')], { cwd: APP, stdio: ['ignore', 'pipe', 'ignore'], env: { ...ENV, PORT: String(PORT) } });
  const m = await readLine(server, /127\.0\.0\.1:(\d+)/);
  if (!m) throw new Error('server.py did not start');
  PORT = Number(m[1]); URL = `http://127.0.0.1:${PORT}/`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(URL + 'api/health')).ok) return; } catch (e) { /* not yet */ } await sleep(100); }
  throw new Error('server.py does not answer on ' + URL);
}
// Stop server.py with SIGTERM and wait for it to exit.
async function stopServer() { const s = server; server = null; await stop(s, 5000); }
// Another server.py on a free port with its own settings, for the first-run phases; returns the child and its URL once health answers.
async function startOther(/** @type {any} */ env) {
  const p = launch('python3', [join(APP, 'server.py')], { cwd: APP, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, PORT: '0' } });
  const m = await readLine(p, /127\.0\.0\.1:(\d+)/);
  if (!m) throw new Error('server.py did not start for a first-run phase');
  const url = `http://127.0.0.1:${m[1]}/`;
  for (let i = 0; i < 60; i++) { try { await (await fetch(url + 'api/health')).json(); return { p, url }; } catch (e) { /* not yet */ } await sleep(100); }
  throw new Error('server.py does not answer on ' + url);
}
const NO_CLI = join(tempDir('desk-nocli-'), 'claude');  // a CLI path that does not exist
const OTHER = [{ ...ENV, DESK_CLAUDE_DIR: join(tempDir('desk-empty-'), 'claude'), DESK_STATE_DIR: tempDir('desk-state-a-'), DESK_CLAUDE_BIN: NO_CLI },
  { ...ENV, DESK_STATE_DIR: tempDir('desk-state-b-'), DESK_CLAUDE_BIN: NO_CLI }];  // first run: no data folder and no CLI; then sessions but no CLI

try {
  await startServer();
  let wsUrl; ({ chrome, wsUrl } = await startChrome(profile));
  const { send, on } = await devtools(wsUrl);
  const ev = async body => { const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const mode = () => ev(`return document.getElementById('mode')?.textContent ?? '';`);
  // Wait until the tagline reads want; returns ms taken, or -1 after the limit.
  const until = async (want, limit) => { const t = Date.now(); while (Date.now() - t < limit) { if (await mode() === want) return Date.now() - t; await sleep(50); } return -1; };

  on.set('Runtime.exceptionThrown', p => errs.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  on.set('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'assert') errs.push('console.' + p.type + ': ' + p.args.map(a => a.value ?? a.description).join(' ')); });
  on.set('Log.entryAdded', p => { if (p.entry.level === 'error' && !/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|api\.open-meteo\.com)\//.test(p.entry.url || '')) errs.push('log: ' + p.entry.text + (p.entry.url ? ' ' + p.entry.url : '')); });  // the page works offline: failed font and weather requests are not errors
  const hits = [], partial = []; let feeds = 0, opens = 0;
  on.set('Network.requestWillBeSent', p => { const u = new globalThis.URL(p.request.url); if (u.pathname === '/api/sessions') { hits.push(Date.now()); if (u.searchParams.has('ids')) partial.push(u.searchParams.get('ids')); } if (u.pathname === '/api/events') feeds++; if (u.pathname === '/api/term/open') opens++; });
  // Paused requests: the forecast gets the canned answer; /api/health (only while the update check is tested) answers with other code versions.
  let HEALTH = JSON.stringify({ ok: true, codeVersion: 1, webVersion: 1 });
  on.set('Fetch.requestPaused', p => send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(/api\/health/.test(p.request.url) ? HEALTH : WEATHER).toString('base64') }).catch(() => {}));
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable'); await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api.open-meteo.com*' }] });

  // Wait until fn returns something truthy; returns its last value.
  const waitFor = async (/** @type {() => Promise<any>} */ fn, limit) => { const t = Date.now(); let v; while (Date.now() - t < limit) { v = await fn(); if (v) return v; await sleep(50); } return v; };
  const plainHint = (/** @type {string} */ t) => String(t || '').replace(/`/g, '');

  // First run on the real server: no data folder, no CLI. The page's health request is held until the first render is on screen, so the notices must follow a late answer.
  const A = await startOther(OTHER[0]);
  const ha = await (await fetch(A.url + 'api/health')).json();
  check('first run: health is not ok, data folder missing, CLI missing', ha.ok === false && ha.setup?.dataDir === 'missing' && ha.setup?.cli === 'missing' && !!ha.setup?.hint, ha.setup);
  const canned = on.get('Fetch.requestPaused'), held = []; let holding = true;
  on.set('Fetch.requestPaused', p => { if (!/\/api\/health/.test(p.request.url)) return canned(p); if (holding) held.push(p.requestId); else send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api.open-meteo.com*' }, { urlPattern: '*/api/health*' }] });
  await send('Page.navigate', { url: A.url });
  const early = await waitFor(() => ev(`const n = document.querySelector('#lists .none'), q = document.getElementById('quiet'); return n && !/Loading/.test(n.textContent) && q && !q.hidden ? q.textContent : '';`), 8000);
  check('first run: the page drew before its health answer arrived', !!early && held.length > 0, { early, held: held.length });
  holding = false; for (const id of held.splice(0)) await send('Fetch.continueRequest', { requestId: id }).catch(() => {});
  const want = plainHint(ha.setup.hint);
  const quietNote = await waitFor(() => ev(`const q = document.getElementById('quiet'); return q.textContent === ${JSON.stringify(want)} ? q.textContent : '';`), 5000) || await ev(`return document.getElementById('quiet').textContent;`);
  check('first run: the garden\'s quiet note shows the server\'s hint, not "Nobody needs you"', quietNote === want && !/Nobody needs you/.test(quietNote), quietNote);
  const workCol = await ev(`const n = document.querySelector('#lists .none.setup'); return n ? { why: n.querySelector('.setup-why')?.textContent ?? '', how: n.querySelector('.setup-how')?.textContent ?? '' } : null;`);
  check('first run: the Working column shows the hint and the doctor line', !!workCol && workCol.why === want && /python3 server\.py doctor/.test(workCol.how), workCol);
  const title = await ev(`return document.title;`);
  check('first run: the tab title is plain "Session Desk"', title === 'Session Desk', title);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api.open-meteo.com*' }] }); on.set('Fetch.requestPaused', canned);
  await stop(A.p, 5000);

  // Sessions present, CLI missing, real server: the quiet line under the search box, and the Terminal tab says so once with no retry loop.
  const B = await startOther(OTHER[1]);
  await send('Page.navigate', { url: B.url });
  const lineB = await waitFor(() => ev(`const e = document.getElementById('setup'); return e && !e.hidden ? e.textContent : '';`), 8000);
  check('real server, CLI missing: one quiet line under the search box', /^Terminals and quick replies are off: The claude command was not found/.test(lineB) && /doctor/.test(lineB), lineB);
  const o0 = opens;
  await ev(`document.querySelector('.row[data-id="${SID}"]').click(); return 1;`);
  await waitFor(() => ev(`return !!document.querySelector('[data-view="term"]');`), 3000);
  await ev(`document.querySelector('[data-view="term"]').click(); return 1;`);
  const shown = await waitFor(() => ev(`return document.querySelector('#xt .xt-off')?.textContent || document.querySelector('#xt .xterm-rows')?.innerText || '';`), 5000);
  await sleep(1200);  // long enough for a retry loop to show itself
  const tab = await ev(`return { text: document.querySelector('#xt .xt-off')?.textContent || document.querySelector('#xt .xterm-rows')?.innerText || '', xterm: !!document.querySelector('#xt .xterm') };`);
  const times = tab.text.split('command was not found').length - 1;
  check('real server, CLI missing: the Terminal tab prints the server\'s message once, no retry loop', !!shown && times === 1 && /doctor/.test(tab.text) && !/again/.test(tab.text) && opens - o0 <= 1, { times, opens: opens - o0, xterm: tab.xterm });
  await send('Page.navigate', { url: 'about:blank' }); await waitFor(() => ev(`return location.href === 'about:blank';`), 3000);
  await stop(B.p, 5000);
  hits.length = 0; partial.length = 0; feeds = 0; errs.length = 0;

  const tNav = Date.now(); await send('Page.navigate', { url: URL });
  const tLive = await until('live', 8000);
  // Boot loads the sessions once: no second request when the feed opens or sends its first change.
  while (Date.now() - tNav < 2000) await sleep(50);
  const boot = hits.filter(t => t - tNav < 2000).length;
  check('boot fetches the sessions once in its first 2 s', boot === 1, boot);
  check('tagline reaches live', tLive >= 0, { ms: tLive, mode: await mode() });
  const rows = await ev(`return document.querySelectorAll('.row').length + document.querySelectorAll('.agent').length;`);
  check('sessions rendered from the server', rows > 0, rows);
  check('one change feed opened', feeds === 1, feeds);

  // Touching a transcript pushes a change; the page re-fetches well before the 30 s safety poll.
  await sleep(1500);
  const before = hits.length, file = readdirSync(join(home, 'projects', '-work-alpha')).find(f => f.endsWith('.jsonl'));
  const t0 = Date.now(); utimesSync(join(home, 'projects', '-work-alpha', file), new Date(), new Date());
  while (hits.length === before && Date.now() - t0 < 2000) await sleep(25);
  check('touch triggers a re-fetch within 2 s', hits.length > before, { ms: hits.length > before ? hits[before] - t0 : null });
  await sleep(1000);
  check('one fetch per change, no polling while live', hits.length - before === 1, hits.length - before);
  check('a named change fetches only that session', partial.length === 1 && partial[0].split(',').length === 1, partial);

  // A series of changes patched in from partial answers: the page's rows must equal a fresh full fetch.
  const rec = (kind, text, i) => JSON.stringify({ type: kind, uuid: 'pp' + i + kind, parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), entrypoint: 'cli', cwd: work, sessionId: 'x',
    message: kind === 'user' ? { role: 'user', content: text } : { id: 'mpp' + i, type: 'message', role: 'assistant', model: 'model-x', content: [{ type: 'text', text }], usage: { input_tokens: 5, output_tokens: 7 } } }) + '\n';
  const pp0 = partial.length, h0 = hits.length;
  for (let i = 0; i < 6; i++) {
    if (i % 3 === 0) appendFileSync(join(home, 'projects', '-tmp-smoke', SID + '.jsonl'), rec(i % 2 ? 'assistant' : 'user', 'invented step ' + i, i));
    else if (i % 3 === 1) writeFileSync(join(home, 'projects', '-tmp-smoke', `abcdef12-0000-4000-8000-00000000010${i}.jsonl`), rec('user', 'invented new session ' + i, i));
    else utimesSync(join(home, 'projects', '-work-alpha', file), new Date(), new Date());
    const n = hits.length; for (let k = 0; k < 40 && hits.length === n; k++) await sleep(50);
    await sleep(350);
  }
  const same = async () => ev(`const strip = s => { const o = { ...s }; delete o.full; delete o.files; delete o.err; return o; };
    const a = JSON.stringify(window.desk.S.map(strip)), b = JSON.stringify(await (await fetch('api/sessions')).json()); return { ok: a === b, page: window.desk.S.length, fresh: JSON.parse(b).length };`);
  let eq = await same(); for (let k = 0; k < 20 && !eq.ok; k++) { await sleep(200); eq = await same(); }
  check('after a series of changes the page rows equal a fresh full fetch', eq.ok, { ...eq, partial: partial.length - pp0, fetches: hits.length - h0 });
  check('the changes were patched from partial answers', partial.length - pp0 >= 3, partial.slice(pp0));

  // Terminal tab on the stub CLI: type a line and see it echoed.
  const termText = () => ev(`return document.querySelector('#xt .xterm-rows')?.innerText ?? '';`);
  const count = (t, w) => t.split(w).length - 1;
  const waitText = async (want, limit) => { const t = Date.now(); while (Date.now() - t < limit) { if ((await termText()).includes(want)) return Date.now() - t; await sleep(100); } return -1; };
  const type = async text => { await ev(`document.querySelector('#xt textarea')?.focus();`); await send('Input.insertText', { text }); await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); };
  await ev(`document.documentElement.dataset.smoke = 'same page'; document.querySelector('.row[data-id="${SID}"]').click();`);
  await sleep(300); await ev(`document.querySelector('[data-view="term"]').click();`);
  check('stub CLI starts in the Terminal tab', await waitText('cli ready', 8000) >= 0, await termText());
  await type('first');
  check('typed line echoed before the restart', await waitText('got first', 5000) >= 0);

  // Keyboard way out of the terminal: Tab stays with the CLI, F6 reaches the sidebar tabs, Shift+Tab then End terminal, Enter on the open tab goes back in without a new attach.
  const key = async (k, code, mods = 0, text) => { await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods, ...(text ? { text } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code, modifiers: mods }); await sleep(80); };
  const focused = () => ev(`const a = document.activeElement; return a.closest('.xt') ? 'terminal' : a.dataset.view ? 'tab ' + a.dataset.view : a.dataset.act || a.id || a.tagName;`);
  await ev(`document.querySelector('#xt textarea')?.focus();`); await key('Tab', 9);
  check('Tab inside the terminal stays with the CLI', await focused() === 'terminal', await focused());
  await key('F6', 117);
  check('F6 leaves the terminal for the sidebar tabs', await focused() === 'tab term', await focused());
  await key('Tab', 9, 8);
  check('Shift+Tab from the tabs reaches End terminal', await focused() === 'endterm', await focused());
  await key('Tab', 9);
  const back = await focused(); await ev(`document.querySelector('[data-view="term"]').focus();`); await key('Enter', 13, 0, '\r');
  check('Enter on the open Terminal tab returns into the same terminal', back === 'tab term' && await focused() === 'terminal' && count(await termText(), 'cli ready') === 1, { back, now: await focused() });
  await key('F6', 117, 8);
  check('Shift+F6 leaves the terminal for its footer', ['home', 'endterm'].includes(await focused()), await focused());
  await key('F6', 117);
  check('F6 outside the terminal goes back in', await focused() === 'terminal', await focused());
  check('the Terminal footer names the key', /F6/.test(await ev(`return document.getElementById('xtnote').dataset.hint || '';`)));

  // Server restart kills the feed and the terminal stream: offline tagline, then live; the terminal re-attaches by itself.
  const quiet = errs.length; await stopServer();
  const tOff = await until('offline · retrying', 3000);
  check('server down flips the tagline to offline · retrying', tOff >= 0, { ms: tOff, mode: await mode() });
  await startServer();
  const tBack = await until('live', 6000);
  check('tagline returns to live by itself', tBack >= 0, { ms: tBack, mode: await mode() });
  check('feed reopened once', feeds === 2, feeds);
  const noteText = () => ev(`return document.getElementById('xtnote')?.textContent ?? '';`);
  let nt = ''; for (let i = 0; i < 60 && !/re-attached/.test(nt); i++) { await sleep(100); nt = await noteText(); }
  check('terminal says it re-attached', /re-attached/.test(nt), nt);
  await type('second');
  check('typing works again after the restart', await waitText('got second', 6000) >= 0);
  const after = await termText();
  check('earlier output kept, nothing doubled', count(after, 'cli ready') === 1 && count(after, 'got first') === 1 && count(after, 'got second') === 1, after.split('\n').filter(l => /cli ready|got /.test(l)));
  check('no page reload', await ev(`return document.documentElement.dataset.smoke;`) === 'same page');
  const pill = () => ev(`const u = document.getElementById('upd'); return { hidden: u.hidden, text: u.textContent };`);
  const p0 = await pill();
  check('a restart with the same code shows no update pill', p0.hidden, p0);

  // A paste over the server's 100 KB limit is refused (413): the footer says so in plain words.
  await ev(`document.querySelector('#xt textarea')?.focus();`); await send('Input.insertText', { text: 'x'.repeat(110000) });
  nt = ''; for (let i = 0; i < 50 && !/100 KB/.test(nt); i++) { await sleep(100); nt = await noteText(); }
  check('an oversized paste says so in the Terminal footer', /at most 100 KB/.test(nt), nt);

  // New code on disk: once a later health answer has other versions, a feed reconnect shows the quiet "updated · reload" pill.
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api.open-meteo.com*' }, { urlPattern: '*/api/health*' }] });
  await ev(`dispatchEvent(new PageTransitionEvent('pagehide')); dispatchEvent(new PageTransitionEvent('pageshow')); return 1;`);
  let p1 = await pill(); for (let i = 0; i < 40 && p1.hidden; i++) { await sleep(100); p1 = await pill(); }
  check('changed code versions show "updated · reload"', !p1.hidden && p1.text === 'updated · reload', p1);
  if (shots) writeFileSync(join(shots, 'real-update-pill.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api.open-meteo.com*' }] });
  if (shots) { mkdirSync(shots, { recursive: true }); writeFileSync(join(shots, 'real-reattached.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); }

  // Stopping the terminal host ends the stream with exit -1: the tab says so instead of "CLI ended".
  spawnSync('python3', [join(APP, 'server.py'), 'stop-terminals'], { cwd: APP, env: ENV, timeout: 30000 });
  check('stop-terminals prints "Terminal ended"', await waitText('Terminal ended', 8000) >= 0, (await termText()).split('\n').filter(l => /\[/.test(l)));  // the host hangs the CLI up itself, so it reports 129, not a lost terminal

  // A health answer whose setup says the CLI is missing: one quiet line under the search box, the Terminal tab shows the words once instead of a terminal, the reply box is off.
  HEALTH = JSON.stringify({ ok: false, codeVersion: 1, webVersion: 1, setup: { dataDir: 'ok', sessions: 12, cli: 'missing', stateDir: 'ok', hint: 'The `claude` command was not found: install Claude Code or set DESK_CLAUDE_BIN.' } });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api.open-meteo.com*' }, { urlPattern: '*/api/health*' }] });
  await ev(`document.querySelector('[data-act="close"]')?.click(); dispatchEvent(new PageTransitionEvent('pagehide')); dispatchEvent(new PageTransitionEvent('pageshow')); return 1;`);
  let sl = ''; for (let i = 0; i < 50 && !sl; i++) { await sleep(100); sl = await ev(`const e = document.getElementById('setup'); return e.hidden ? '' : e.textContent;`); }
  check('CLI missing: one quiet line under the search box', /^Terminals and quick replies are off: The claude command was not found/.test(sl), sl);
  await ev(`document.querySelector('.row[data-id="${SID}"]').click(); return 1;`); await sleep(400); await ev(`document.querySelector('[data-view="term"]').click(); return 1;`); await sleep(600);
  const off = await ev(`return { text: document.querySelector('#xt .xt-off')?.textContent ?? '', xterm: !!document.querySelector('#xt .xterm'), reply: null };`);
  await ev(`document.querySelector('[data-view="log"]').click(); return 1;`); await sleep(300);
  off.reply = await ev(`const r = document.getElementById('reply'); return r ? { disabled: r.disabled, why: r.placeholder } : null;`);
  check('CLI missing: the Terminal tab says so once, no terminal, no "again" loop', /`claude` command was not found/.test(off.text) && /doctor/.test(off.text) && !/again/.test(off.text) && !off.xterm, off);
  check('CLI missing: the quick reply box is off and says why', !!off.reply && off.reply.disabled && /Quick replies are off/.test(off.reply.why), off.reply);
  await ev(`document.querySelector('[data-act="close"]')?.click(); return 1;`);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api.open-meteo.com*' }] });

  // Refused or rejected requests while the server was down or the host stopped are expected; page errors are not.
  errs.splice(quiet, errs.length - quiet, ...errs.slice(quiet).filter(e => !/^log: Failed to load resource/.test(e)));
  const fav = await fetch(URL + 'favicon.ico');
  check('favicon served', fav.ok && fav.headers.get('content-type') === 'image/x-icon', fav.status);
  check('no console errors or exceptions', errs.length === 0, errs);
} catch (e) {
  fails.push('crash'); console.log('FAIL crash ' + e.message); if (errs.length) console.log('errors so far: ' + JSON.stringify(errs));
} finally {
  await stop(chrome, 3000); await stopServer().catch(() => {});
  for (const env of [ENV, ...OTHER]) spawnSync('python3', [join(APP, 'server.py'), 'stop-terminals'], { cwd: APP, env, timeout: 30000 });
}
console.log(`\n${fails.length ? 'FAILED ' + fails.length : 'ALL PASSED'}`);
process.exit(fails.length ? 1 : 0);
