// Unit tests for the change-feed scheduling in src/feed.js; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeed, fetchPlan, modeText, pollPeriod, retryDelay } from '../src/feed.js';

/** Fake clock with setTimeout/clearTimeout that only moves when told. */
function clock() {
  let t = 1000, seq = 0; const due = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { due.set(++seq, { at: t + ms, fn }); return seq; },
    clearTimeout: id => { due.delete(id); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, d]) => d.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        due.delete(next[0]); t = next[1].at; next[1].fn(); await flush();
      }
      t = end; await flush();
    },
  };
}
const flush = () => new Promise(r => setImmediate(r));

/** Fake EventSource that records every instance. */
function fakeES() {
  const all = [];
  class ES {
    constructor(url) { this.url = url; this.closed = false; this.on = {}; all.push(this); }
    addEventListener(type, fn) { this.on[type] = fn; }
    close() { this.closed = true; }
    open() { this.onopen?.(); }
    change() { this.on.change?.({ data: '1' }); }
    fail() { this.onerror?.(); }
  }
  return { ES, all };
}

/** Feed wired to fakes; refresh resolves only when the test says so. */
function rig({ withES = true } = {}) {
  const c = clock(), es = fakeES(), modes = [], calls = [], pending = [], vis = { hidden: false };
  const refresh = () => { calls.push(c.now()); return new Promise(r => pending.push(r)); };
  const feed = createFeed({ refresh, setMode: m => modes.push(m), ES: withES ? es.ES : undefined, timers: c, now: c.now, hidden: () => vis.hidden });
  const settle = async (ok = true) => { while (pending.length) pending.shift()(ok); await flush(); };
  return { c, es, modes, calls, feed, settle, vis, mode: () => modes.at(-1) };
}

test('retryDelay backs off 5 s, 15 s, then 60 s for good', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map(retryDelay), [5000, 15000, 60000, 60000, 60000]);
});

test('pollPeriod is a 30 s safety net while live, 4 s otherwise', () => {
  assert.equal(pollPeriod(true), 30000);
  assert.equal(pollPeriod(false), 4000);
});

test('modeText names the feed state', () => {
  assert.equal(modeText(true, true), 'live');
  assert.equal(modeText(false, true), 'live · polling');
  assert.equal(modeText(true, false), 'offline · retrying');
  assert.equal(modeText(false, null), 'loading…');
});

test('fetchPlan coalesces: one in flight, one queued, 300 ms apart', () => {
  const idle = { busy: false, queued: false, waiting: false, last: -Infinity };
  assert.equal(fetchPlan(idle, 0), 0);
  assert.equal(fetchPlan({ ...idle, last: 1000 }, 1100), 200);
  assert.equal(fetchPlan({ ...idle, last: 1000 }, 1500), 0);
  assert.equal(fetchPlan({ ...idle, busy: true }, 0), 'queue');
  assert.equal(fetchPlan({ ...idle, busy: true, queued: true }, 0), 'none');
  assert.equal(fetchPlan({ ...idle, waiting: true }, 0), 'none');
});

test('start opens one feed and fetches on its first change event, not before; open feed means live with a 30 s poll', async () => {
  const r = rig();
  r.feed.start(); r.feed.start();
  assert.equal(r.es.all.length, 1);
  assert.equal(r.es.all[0].url, 'api/events');
  assert.equal(r.calls.length, 0, 'waits for the feed');
  r.es.all[0].open();
  assert.equal(r.mode(), 'loading…', 'live only once the first load answered');
  r.es.all[0].change();
  assert.equal(r.calls.length, 1);
  await r.settle();
  assert.equal(r.mode(), 'live');
  await r.c.advance(29000);
  assert.equal(r.calls.length, 1, 'no 4 s poll while live');
  await r.c.advance(1000);
  assert.equal(r.calls.length, 2, 'safety poll at 30 s');
});

test('a burst of change events makes one queued fetch, at least 300 ms after the last', async () => {
  const r = rig();
  r.feed.start(); r.es.all[0].open();
  for (let i = 0; i < 5; i++) r.es.all[0].change();
  assert.equal(r.calls.length, 1, 'never two in flight');
  await r.c.advance(50); await r.settle();
  await r.c.advance(200);
  assert.equal(r.calls.length, 1, 'waits out the 300 ms gap');
  await r.c.advance(100);
  assert.deepEqual(r.calls, [1000, 1300]);
  for (let i = 0; i < 5; i++) r.es.all[0].change();
  await r.settle(); await r.c.advance(1000);
  assert.equal(r.calls.length, 3, 'one more for the second burst');
});

test('a change while a fetch waits out the gap joins it', async () => {
  const r = rig();
  r.feed.start(); r.es.all[0].open(); await r.settle();
  r.es.all[0].change(); r.es.all[0].change();
  await r.c.advance(300); await r.settle(); await r.c.advance(1000);
  assert.equal(r.calls.length, 2);
});

test('feed error falls back to the 4 s poll and retries after 5 s, 15 s, 60 s, 60 s', async () => {
  const r = rig();
  r.feed.start(); r.es.all[0].open(); r.es.all[0].change(); await r.settle();
  r.es.all[0].fail();
  assert.equal(r.es.all[0].closed, true);
  assert.equal(r.mode(), 'live · polling');
  await r.c.advance(300); assert.equal(r.calls.length, 2, 'one fetch right after feed loss');
  await r.settle(); await r.c.advance(3700); await r.settle();
  assert.equal(r.calls.length, 3, 'then polls every 4 s');
  await r.c.advance(999); assert.equal(r.es.all.length, 1, 'no retry before 5 s');
  await r.c.advance(1); assert.equal(r.es.all.length, 2, 'retry after 5 s');
  r.es.all[1].fail();
  for (const wait of [15000, 60000, 60000]) {
    const n = r.es.all.length;
    await r.c.advance(wait - 1); await r.settle(); assert.equal(r.es.all.length, n, 'not before ' + wait);
    await r.c.advance(1); assert.equal(r.es.all.length, n + 1, 'retry after ' + wait);
    r.es.all.at(-1).fail(); await r.settle();
  }
  assert.equal(r.es.all.filter(e => !e.closed).length, 0);
});

test('a feed that opens again goes live and resets the backoff', async () => {
  const r = rig();
  r.feed.start(); await r.settle();
  r.es.all[0].fail(); await r.c.advance(5000); r.es.all[1].fail();
  await r.c.advance(15000); await r.settle();
  r.es.all[2].open();
  assert.equal(r.mode(), 'live');
  r.es.all[2].fail();
  await r.c.advance(5000);
  assert.equal(r.es.all.length, 4, 'back to 5 s after a good connection');
});

test('a refused feed (error before open) is a failure too', async () => {
  const r = rig();
  r.feed.start(); await r.settle();
  r.es.all[0].fail(); await r.settle();
  assert.equal(r.mode(), 'live · polling');
  await r.c.advance(5000);
  assert.equal(r.es.all.length, 2);
});

test('without EventSource the page just polls every 4 s', async () => {
  const r = rig({ withES: false });
  r.feed.start(); await r.settle();
  assert.equal(r.mode(), 'live · polling');
  for (let i = 0; i < 3; i++) { await r.c.advance(4000); await r.settle(); }
  assert.equal(r.calls.length, 4);
  assert.equal(r.mode(), 'live · polling');
});

test('an unreachable server shows the error text, recovery shows the feed state again', async () => {
  const r = rig();
  r.feed.start(); r.es.all[0].open(); r.es.all[0].change(); await r.settle(false);
  assert.equal(r.mode(), 'offline · retrying');
  await r.c.advance(30000); await r.settle(true);
  assert.equal(r.mode(), 'live');
});

test('stop closes the feed and every timer; start opens a fresh feed and refreshes', async () => {
  const r = rig();
  r.feed.start(); r.es.all[0].open(); r.es.all[0].change(); await r.settle();
  r.feed.stop();
  assert.equal(r.es.all[0].closed, true);
  await r.c.advance(120000);
  assert.equal(r.calls.length, 1, 'nothing runs while stopped');
  assert.equal(r.es.all.length, 1);
  r.feed.start();
  assert.equal(r.es.all.length, 2);
  r.es.all[1].open(); r.es.all[1].change();
  assert.equal(r.calls.length, 2);
});

test('stop during a pending retry cancels it', async () => {
  const r = rig();
  r.feed.start(); await r.settle(); r.es.all[0].fail();
  r.feed.stop();
  await r.c.advance(60000);
  assert.equal(r.es.all.length, 1);
});

test('a server that answers again reopens the feed at once, not after the backoff', async () => {
  const r = rig();
  r.feed.start(); r.es.all[0].open(); await r.settle();
  r.es.all[0].fail(); await r.c.advance(300); await r.settle(false);
  assert.equal(r.mode(), 'offline · retrying');
  await r.c.advance(4000); await r.settle(true);
  assert.equal(r.es.all.length, 2, 'reopened on the first good fetch');
  r.es.all[1].open();
  assert.equal(r.mode(), 'live');
  await r.c.advance(4000); await r.settle(true);
  assert.equal(r.es.all.length, 2, 'no second reopen while healthy');
});

test('boot fetches once: the first change event loads, a quiet feed falls back after 1.5 s, a refused one at once', async () => {
  const r = rig();
  r.feed.start(); r.es.all[0].open(); r.es.all[0].change(); await r.settle();
  await r.c.advance(2000);
  assert.equal(r.calls.length, 1, 'no second boot fetch');
  const q = rig();
  q.feed.start(); q.es.all[0].open();
  await q.c.advance(1499); assert.equal(q.calls.length, 0);
  await q.c.advance(1); assert.equal(q.calls.length, 1, 'fallback when no change event came');
  const x = rig();
  x.feed.start(); x.es.all[0].fail();
  assert.equal(x.calls.length, 1, 'a refused feed fetches at once');
  await x.settle(); await x.c.advance(1500); assert.equal(x.calls.length, 1);
});

test('update check: a later health answer with other code versions means the page is old', async () => {
  const { codeMoved, healthDue, versionsOf } = await import('../src/feed.js');
  const a = versionsOf({ codeVersion: 100, webVersion: 200 });
  assert.deepEqual(a, { code: 100, web: 200 });
  assert.deepEqual(versionsOf({ codeVersion: 100 }), { code: 100, web: null });
  assert.equal(codeMoved(a, versionsOf({ codeVersion: 100, webVersion: 200 })), false);
  assert.equal(codeMoved(a, versionsOf({ codeVersion: 101, webVersion: 200 })), true, 'server code changed');
  assert.equal(codeMoved(a, versionsOf({ codeVersion: 100, webVersion: 201 })), true, 'page files changed');
  assert.equal(codeMoved(versionsOf({ codeVersion: 100 }), versionsOf({ codeVersion: 100, webVersion: 5 })), false, 'webVersion is optional: compared only when both have it');
  assert.equal(codeMoved(a, versionsOf({ codeVersion: 100 })), false);
  assert.equal(codeMoved(a, versionsOf({})), false, 'a broken answer is not an update');
  assert.equal(codeMoved(null, a), false);
  assert.equal(healthDue(0, 59999, false), false);
  assert.equal(healthDue(0, 60000, false), true);
  assert.equal(healthDue(0, 10, true), true, 'a feed reconnect checks at once');
});

test('sseEvents splits complete events and keeps the rest', async () => {
  const { sseEvents } = await import('../src/feed.js');
  const r = sseEvents('id: 12\ndata: aGk=\n\n: ping\n\nevent: exit\ndata: -1\n\nid: 30\ndata: b');
  assert.deepEqual(r.events, [{ event: 'message', id: '12', data: 'aGk=' }, { event: 'exit', id: '', data: '-1' }]);
  assert.equal(r.rest, 'id: 30\ndata: b');
  assert.deepEqual(sseEvents('data: a\r\ndata: b\r\n\r\n').events, [{ event: 'message', id: '', data: 'a\nb' }]);
});

test('hidden page: changes and safety polls only mark a refresh due; showing it runs exactly one', async () => {
  const r = rig(); r.feed.start(); r.es.all[0].open(); r.es.all[0].change(); await r.c.advance(400); await r.settle();
  assert.equal(r.calls.length, 1);
  r.vis.hidden = true;
  for (let i = 0; i < 5; i++) { r.es.all[0].change(); await r.c.advance(1000); }
  await r.c.advance(120000);
  assert.equal(r.calls.length, 1, 'no fetch while hidden');
  assert.equal(r.feed.state.due, true);
  r.feed.wake(); await r.c.advance(400);
  assert.equal(r.calls.length, 1, 'wake while still hidden does nothing');
  r.vis.hidden = false; r.feed.wake(); r.feed.wake(); await r.c.advance(400); await r.settle();
  assert.equal(r.calls.length, 2, 'one catch-up fetch');
  r.feed.wake(); await r.c.advance(400);
  assert.equal(r.calls.length, 2, 'nothing more due');
  assert.equal(r.es.all.length, 1, 'feed kept open');
});

test('hidden page at boot: the first load waits for the page to show', async () => {
  const r = rig(); r.vis.hidden = true; r.feed.start(); r.es.all[0].open(); r.es.all[0].change(); await r.c.advance(5000);
  assert.equal(r.calls.length, 0);
  r.vis.hidden = false; r.feed.wake(); await r.c.advance(400); await r.settle();
  assert.equal(r.calls.length, 1); assert.equal(r.mode(), 'live');
});

test('exitText tells a stopped host from an ended terminal and an ended CLI; reattachDelay caps at 3 s', async () => {
  const { exitText, reattachDelay } = await import('../src/feed.js');
  assert.match(exitText(-1), /^Terminal host stopped/);
  for (const c of [129, 130, 143]) assert.match(exitText(c), /^Terminal ended\./);
  assert.match(exitText(0), /^CLI ended \(code 0\)\./);
  assert.match(exitText(1), /^CLI ended \(code 1\)\./);
  assert.match(exitText(137), /^CLI ended \(code 137\)\./);
  assert.match(exitText(/** @type {any} */ ('x')), /^CLI ended\. /);
  assert.match(exitText(/** @type {any} */ ('129')), /^Terminal ended/);
  assert.deepEqual([0, 1, 2, 3, 8].map(reattachDelay), [500, 1000, 2000, 3000, 3000]);
});
