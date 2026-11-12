// Unit tests for the page-only rules of round 7: setup notices, waiting announcements, tab title, partial list patching, CLI-missing text; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alsoWords, codeHtml, liveCopies, pageTitle, replyBlock, setupHint, setupNotes, setupOf, setupOff, syncLineHtml, waitingNews } from '../src/logic.js';
import { cliMissing, cliMissingText, createFeed, MAX_IDS, patchList, sessionsEvent } from '../src/feed.js';

test('setup: a missing or partial setup object counts as fine', () => {
  for (const h of [null, undefined, {}, { ok: true }, { setup: null }, { setup: {} }, { setup: { dataDir: 'ok', cli: 'ok', stateDir: 'ok', sessions: 4, hint: '' } }]) {
    assert.equal(setupHint(h), ''); assert.deepEqual(setupNotes(h, 0), { empty: '', cliOff: '' }); assert.deepEqual(setupNotes(h, 3), { empty: '', cliOff: '' });
  }
  assert.deepEqual(setupOf({ setup: { sessions: -3, hint: ' a\n b ' } }), { dataDir: 'ok', sessions: 0, cli: 'ok', stateDir: 'ok', hint: 'a b' });
});

test('setup: the server hint wins, else one plain sentence per problem', () => {
  assert.equal(setupHint({ setup: { dataDir: 'missing', hint: 'Server words.' } }), 'Server words.');
  assert.match(setupHint({ setup: { dataDir: 'missing' } }), /^No Claude Code data found: run `claude` once, then reload\.$/);
  assert.match(setupHint({ setup: { dataDir: 'unreadable' } }), /cannot be read/);
  assert.match(setupHint({ setup: { cli: 'missing' } }), /`claude` command was not found/);
  assert.match(setupHint({ setup: { cli: 'notExecutable' } }), /cannot be run/);
  assert.match(setupHint({ setup: { stateDir: 'readOnly' } }), /DESK_STATE_DIR/);
});

test('setup notes: empty lists only with nothing listed; the CLI line only with sessions listed and the CLI not ok', () => {
  const nodata = { setup: { dataDir: 'missing', sessions: 0, cli: 'missing', stateDir: 'ok', hint: 'No data.' } }, nocli = { setup: { dataDir: 'ok', sessions: 9, cli: 'missing', stateDir: 'ok', hint: 'No CLI.' } };
  assert.deepEqual(setupNotes(nodata, 0), { empty: 'No data.', cliOff: '' });
  assert.deepEqual(setupNotes(nocli, 0), { empty: 'No CLI.', cliOff: '' });
  assert.deepEqual(setupNotes(nocli, 5), { empty: '', cliOff: 'Terminals and quick replies are off: No CLI.' });
  assert.deepEqual(setupNotes({ setup: { stateDir: 'readOnly', hint: 'Read-only.' } }, 5), { empty: '', cliOff: 'Page terminals are off: Read-only.' });
  assert.deepEqual(setupNotes({ setup: { stateDir: 'readOnly', hint: 'Read-only.' } }, 0), { empty: 'Read-only.', cliOff: '' }, 'read-only with nothing listed: the empty lists carry the server\'s sentence, as for a missing data folder');
  assert.deepEqual(setupNotes({ setup: { dataDir: 'ok', sessions: 0, cli: 'ok', stateDir: 'ok', hint: 'No sessions yet.' } }, 0), { empty: 'No sessions yet.', cliOff: '' }, 'no sessions yet: the server\'s own sentence');
  assert.deepEqual(setupNotes({ setup: { dataDir: 'ok', sessions: 4, cli: 'ok', stateDir: 'ok', hint: '' } }, 0), { empty: '', cliOff: '' });
  assert.equal(setupOff({ setup: { cli: 'missing', hint: 'No CLI.' } }), 'Terminals and quick replies are off: No CLI.');
  assert.equal(setupOff({ setup: { stateDir: 'readOnly', hint: 'Read-only.' } }), 'Page terminals are off: Read-only.');
  assert.equal(setupOff({ setup: { dataDir: 'missing', hint: 'No data.' } }), '', 'no data folder: nothing to turn off, the lists say it');
  assert.equal(setupOff(null), '');
});

test('codeHtml escapes first, then marks `code`', () => {
  assert.equal(codeHtml('run `claude` <b>&'), 'run <code>claude</code> &lt;b&gt;&amp;');
  assert.equal(codeHtml('`<img src=x onerror=1>`'), '<code>&lt;img src=x onerror=1&gt;</code>');
});

const S = (id, status, more = {}) => ({ id, title: 'Task ' + id, project: 'p', branch: 'main', status, updated: 1, ...more });
test('waiting news: nothing on page load, once per session that starts waiting, batched, never repeated, never for automated runs', () => {
  let r = waitingNews(null, [S('a', 'waiting'), S('b', 'running')]);
  assert.equal(r.text, ''); assert.deepEqual([...r.ids], ['a']);
  r = waitingNews(r.ids, [S('a', 'waiting'), S('b', 'waiting')]); assert.equal(r.text, 'Task b needs you');
  r = waitingNews(r.ids, [S('a', 'waiting'), S('b', 'waiting')]); assert.equal(r.text, '', 'a later poll says nothing');
  r = waitingNews(r.ids, [S('a', 'running'), S('b', 'waiting'), S('c', 'running')]); assert.equal(r.text, '', 'leaving the wait says nothing');
  r = waitingNews(r.ids, [S('a', 'waiting'), S('b', 'waiting'), S('c', 'waiting'), S('d', 'waiting')]); assert.equal(r.text, '3 sessions need you');
  r = waitingNews(r.ids, [S('a', 'waiting'), S('b', 'waiting'), S('c', 'waiting'), S('d', 'waiting'), S('e', 'waiting', { automated: true }), S('f', 'waiting', { kind: 'headless' })]);
  assert.equal(r.text, '', 'automated runs are never announced');
  r = waitingNews(new Set(), [S('x', 'waiting', { title: '(session)', project: 'proj', branch: 'dev' })]); assert.equal(r.text, 'proj · dev needs you', 'a bare title is named like the list row');
});

test('page title shows the count only while someone waits', () => {
  assert.equal(pageTitle(0), 'Session Desk'); assert.equal(pageTitle(1), '(1) Session Desk'); assert.equal(pageTitle(3), '(3) Session Desk');
});

test('CLI-missing text: server words without control characters, the doctor hint once, no "open again" advice', () => {
  const t = cliMissingText('The `claude` command was not found.\x1b[2J');
  assert.equal(t, 'The `claude` command was not found. Run `python3 server.py doctor` to check the setup.');
  assert.doesNotMatch(t, /again/);
  assert.equal(cliMissingText('Run python3 server.py doctor.'), 'Run python3 server.py doctor.');
  assert.match(cliMissingText(''), /^The `claude` command was not found or could not run\./);
  assert.ok(cliMissing('The `claude` command was not found') && cliMissing('/x/claude is not executable'));
  assert.ok(!cliMissing('session not found') && !cliMissing('terminal limit reached'));
});

test('sessions event: ids read, odd input or too many ids mean all', () => {
  assert.deepEqual(sessionsEvent('{"n":3,"ids":["a-1","b"],"all":false}'), { ids: ['a-1', 'b'], all: false });
  assert.equal(sessionsEvent('{"n":3,"ids":[],"all":true}').all, true);
  assert.equal(sessionsEvent('{"ids":["a b"]}').all, true);
  assert.equal(sessionsEvent(JSON.stringify({ ids: Array.from({ length: MAX_IDS + 1 }, (_, i) => 'x' + i) })).all, true);
  assert.equal(sessionsEvent('nope'), null); assert.equal(sessionsEvent('{"ids":1}'), null);
});

// Invented server: the full list (live first, then finished by updated, newest RECENT finished only) and the partial answer as docs/api.md describes it.
const RECENT = 4;
function server() {
  const w = new Map(); let day = '2026-11-12';
  const full = () => { const all = [...w.values()].sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1)); const live = all.filter(s => s.status !== 'done'), done = all.filter(s => s.status === 'done').slice(0, RECENT); return [...live, ...done].sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1)); };
  const wire = (/** @type {any[]} */ l) => JSON.parse(JSON.stringify(l));
  const partial = (/** @type {string[]} */ ids) => { const f = wire(full()), held = new Set(f.map(s => s.id)), named = new Set(ids);
    return { rows: f.filter(s => named.has(s.id) || s.status !== 'done'), gone: ids.filter(id => !held.has(id)), order: f.map(s => s.id), today: day, n: 1 }; };
  return { w, full: () => wire(full()), partial, setDay: (/** @type {string} */ d) => { day = d; } };
}
/** Tiny seeded random numbers, so a failing sequence repeats. @param {number} seed */
const rnd = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

test('patchList: entering, leaving, changing and reordering rows give exactly the full list', () => {
  const sv = server(), r = rnd(7); let t = 100;
  for (let i = 0; i < 8; i++) sv.w.set('s' + i, { id: 's' + i, status: i < 3 ? 'running' : 'done', updated: t++, title: 'T' + i, tokens: i });
  let page = sv.full(), patched = 0, fulls = 0;
  for (let step = 0; step < 400; step++) {
    const named = new Set();
    for (let k = 0, n = 1 + Math.floor(r() * 3); k < n; k++) {
      const pick = r(), ids = [...sv.w.keys()], id = ids[Math.floor(r() * ids.length)];
      if (pick < .2) { const nid = 'n' + step + '-' + k; sv.w.set(nid, { id: nid, status: r() < .5 ? 'running' : 'waiting', updated: t++, title: 'New', tokens: 0 }); named.add(nid); }
      else if (pick < .3 && id) { sv.w.delete(id); named.add(id); }
      else if (pick < .6 && id) { const s = sv.w.get(id); s.status = ['running', 'waiting', 'done'][Math.floor(r() * 3)]; s.updated = t++; named.add(id); }
      else if (id) { const s = sv.w.get(id); s.tokens += 10; s.title = 'T' + step; named.add(id); }
    }
    const next = patchList(page, sv.partial([...named]), '2026-11-12');
    if (next) { page = next; patched++; } else { page = sv.full(); fulls++; }
    assert.deepEqual(page, sv.full(), `step ${step}`);
  }
  assert.ok(patched > 300, `most changes patch in place (patched ${patched}, full ${fulls})`);
});

test('patchList: a session that enters the list without changing itself forces a full fetch', () => {
  const sv = server();
  for (let i = 0; i < 6; i++) sv.w.set('d' + i, { id: 'd' + i, status: 'done', updated: 10 + i });
  const page = sv.full(); assert.equal(page.length, RECENT);
  sv.w.delete('d5');  // d1 moves up into the list although nobody named it
  assert.equal(patchList(page, sv.partial(['d5']), '2026-11-12'), null);
});

test('patchList: day change, bad answers and unknown ids mean a full fetch', () => {
  const sv = server(); sv.w.set('a', { id: 'a', status: 'running', updated: 1 }); const page = sv.full();
  assert.ok(patchList(page, sv.partial(['a']), '2026-11-12'));
  sv.setDay('2026-11-13'); assert.equal(patchList(page, sv.partial(['a']), '2026-11-12'), null, 'today moved on');
  for (const bad of [null, {}, { error: 'x' }, { rows: [], gone: [], order: 'a', today: '2026-11-12' }, { rows: [{}], gone: [], order: [], today: '2026-11-12' }]) assert.equal(patchList(page, bad, '2026-11-12'), null);
  assert.equal(patchList(page, { rows: [], gone: [], order: ['a', 'zz'], today: '2026-11-12' }, '2026-11-12'), null, 'order names an id with no row');
  assert.deepEqual(patchList(page, { rows: [], gone: ['a'], order: [], today: '2026-11-12' }, '2026-11-12'), []);
});

/** Feed on fakes that records what each refresh asked for. */
function feedRig() {
  let t = 0, seq = 0; const due = new Map(), asks = [], all = [];
  class ES { constructor() { this.on = {}; all.push(this); } addEventListener(k, fn) { this.on[k] = fn; } close() {} }
  const timers = { setTimeout: (fn, ms) => { due.set(++seq, { at: t + ms, fn }); return seq; }, clearTimeout: id => { due.delete(id); } };
  const advance = async ms => { const end = t + ms; for (;;) { const n = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!n) break; due.delete(n[0]); t = n[1].at; n[1].fn(); await new Promise(r => setImmediate(r)); } t = end; await new Promise(r => setImmediate(r)); };
  const feed = createFeed({ refresh: async ids => { asks.push(ids); return true; }, setMode: () => {}, ES, timers, now: () => t });
  return { feed, asks, es: () => all[all.length - 1], advance };
}

test('feed: first change and reconnects fetch all; named changes fetch only their ids; the safety poll fetches all', async () => {
  const g = feedRig(); g.feed.start(); g.es().onopen();
  g.es().on.change(); await g.advance(10); assert.deepEqual(g.asks, [null], 'first change on connect: whole list');
  g.es().on.sessions({ data: '{"n":2,"ids":["a","b"],"all":false}' }); g.es().on.change(); await g.advance(400);
  assert.deepEqual(g.asks[1], ['a', 'b']);
  g.es().on.sessions({ data: '{"n":3,"ids":[],"all":true}' }); g.es().on.change(); await g.advance(400);
  assert.equal(g.asks[2], null, 'all: whole list');
  g.es().on.change(); await g.advance(400); assert.equal(g.asks[3], null, 'a change with no sessions event: whole list');
  g.es().on.sessions({ data: '{"n":5,"ids":["c"],"all":false}' }); g.es().on.change(); g.es().on.sessions({ data: '{"n":6,"ids":["d"],"all":false}' }); g.es().on.change(); await g.advance(400);
  assert.deepEqual(g.asks.slice(4).map(a => a && [...a].sort()), [['c'], ['d']], 'a change during the coalescing gap waits, then fetches its own ids');
  await g.advance(30000); assert.equal(g.asks[g.asks.length - 1], null, 'safety poll: whole list');
  g.es().onerror(); await g.advance(10); assert.equal(g.asks[g.asks.length - 1], null, 'feed lost: whole list');
  g.feed.stop();
});

test('listDrift names differing fields only, skips times, page-only fields and rows that changed since', async () => {
  const { listDrift } = await import('../src/logic.js');
  const a = { id: 'a', status: 'running', title: 'x', updated: 1, statusAt: 1, waitingSince: 0, full: [['you', 'q']] };
  const b = { id: 'b', status: 'waiting', title: 'y', updated: 2, statusAt: 2, waitingSince: 2 };
  assert.deepEqual(listDrift([a, b], [{ ...a, full: undefined }, b]), { fields: [], ids: [], moved: [] });
  assert.deepEqual(listDrift([a, b], [{ ...a, title: 'secret new title' }, b]), { fields: ['title'], ids: ['a'], moved: [] });
  assert.deepEqual(listDrift([a, b], [{ ...a, status: 'done', updated: 5 }, b]).fields, [], 'a row whose times moved changed after the patch: not drift');
  assert.deepEqual(listDrift([a], [a, b]), { fields: ['ids'], ids: [], moved: ['b'] });
  assert.deepEqual(listDrift([a, b], [a]), { fields: ['ids'], ids: [], moved: ['b'] });
  assert.deepEqual(listDrift([a, b], [a, { ...b, also: ['desktop app'], tokens: 3 }]).fields, ['also', 'tokens']);
  assert.ok(!JSON.stringify(listDrift([a], [{ ...a, title: 'secret new title' }])).includes('secret'));
});

test('the feed reports each sessions event, so a drift check can tell a change on its way from drift', async () => {
  const named = [], es = { listeners: {}, addEventListener(k, fn) { this.listeners[k] = fn; }, close() {} };
  const feed = createFeed({ refresh: async () => true, setMode: () => {}, onNamed: d => named.push(d), ES: function () { return es; }, timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  feed.start(); es.listeners.sessions({ data: JSON.stringify({ ids: ['a', 'b'] }) }); es.listeners.sessions({ data: 'not json' });
  assert.deepEqual(named, [{ ids: ['a', 'b'], all: false }, null]);
});

test('workingCount is the Working heading number and the mine reads its overflow from it', async () => {
  const { workingCount, workingOverflow } = await import('../src/logic.js');
  const S = Array.from({ length: 8 }, (_, i) => ({ id: 'w' + i, status: i < 7 ? 'running' : 'done', updated: i }));
  assert.equal(workingCount(S, new Set()), 7);
  assert.equal(workingOverflow(S, new Set(), 5), 2);
  assert.equal(workingOverflow(S.slice(0, 3), new Set(), 5), 0);
});
test('also open: one other program warns before a second copy; two or more copies are named with their count', () => {
  assert.equal(alsoWords({ also: [] }), null);
  assert.deepEqual(alsoWords({ also: ['desktop app'], copies: 1 }), { head: 'Open in desktop app.', tail: 'Opening a terminal here makes a second copy; type in one place.' });
  assert.deepEqual(alsoWords({ also: ['desktop app'] }), alsoWords({ also: ['desktop app'], copies: 1 }), 'an older server without copies');
  assert.deepEqual(alsoWords({ also: ['desktop app'], copies: 2, term: true }), { head: 'Open in 2 places (this page, desktop app).', tail: 'Messages typed in one do not show in the others.' });
  assert.equal(alsoWords({ also: ['desktop app'], copies: 1 }, true).head, 'Open in 2 places (this page, desktop app).', 'the Terminal tab open here counts before the server knows');
  assert.equal(alsoWords({ also: ['another terminal'], copies: 2 }).head, 'Open in 2 places (2 other terminals).', 'two terminals share one name');
  assert.equal(alsoWords({ also: ['another terminal', 'desktop app'], copies: 2 }).head, 'Open in 2 places (another terminal, desktop app).');
  assert.equal(alsoWords({ also: ['desktop app'], copies: 3 }).head, 'Open in 3 places (desktop app, 2 more).');
  assert.deepEqual(liveCopies({ also: ['x'], copies: 'junk' }), { n: 1, names: ['x'] });
  assert.equal(replyBlock({ also: ['desktop app'], copies: 1 }, 'waiting'), 'Open in desktop app. Reply there; a quick reply here makes a second copy.');
  assert.equal(replyBlock({ also: ['desktop app'], copies: 2, term: true }, 'waiting'), 'Open in 2 places (this page, desktop app). Reply in one of them; messages typed in one do not show in the others.');
  const h = syncLineHtml({ also: ['<app>'], copies: 1 });
  assert.ok(h.includes('Open in &lt;app&gt;.') && h.includes('second copy'), h);
});
