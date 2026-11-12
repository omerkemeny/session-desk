// Unit tests for src/garden_layout.js: spread-out spots, tag placement in crowds, the camp fire rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../src/garden_layout.js';
import { FISH, SLOTS } from '../src/logic.js';

const W = 1148, H = 500;

test('pickSpot: the first three meadow sessions keep the original spots', () => {
  const used = new Set();
  for (const want of [6, 7, 8]) { const i = G.pickSpot(used, false, W, H); assert.equal(i, want); used.add(i); }
  assert.equal(G.pickSpot(new Set(), true, W, H), 0, 'Airflow goes to the pond first');
});

test('pickSpot: twenty characters all find a spot, extra spots stay on open grass, and bodies never stack', () => {
  const used = new Set();
  for (let n = 0; n < 20; n++) { const i = G.pickSpot(used, n % 5 === 0, W, H); assert.ok(i >= 0); used.add(i); }
  const at = [...used].map(i => G.SPOTS[i]);
  for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) assert.ok(Math.abs(at[a][0] - at[b][0]) * W >= 40 || Math.abs(at[a][1] - at[b][1]) * H >= 40, `spots ${at[a]} and ${at[b]} overlap`);
  for (const [x, y] of G.MORE) assert.ok(x >= .04 && x <= .77 && y >= .44 && y <= .86);
  assert.equal(G.SPOTS.length, SLOTS.length + G.MORE.length);
  assert.equal(G.pickSpot(new Set(G.SPOTS.map((_, i) => i)), false, W, H), -1, 'full garden');
});

test('tagSafe: side by side, stacked or staggered far enough', () => {
  assert.equal(G.tagSafe([.1, .5], [.2, .5], W, H), false);
  assert.equal(G.tagSafe([.1, .5], [.25, .5], W, H), true);
  assert.equal(G.tagSafe([.1, .5], [.1, .76], W, H), true);
  assert.equal(G.tagSafe([.1, .5], [.18, .6], W, H), true);
});

const item = (id, x, y, more = {}) => ({ id, x, y: y + 10, body: { l: x - 32, t: y - 60, r: x + 32, b: y }, two: { w: 130, h: 34 }, one: { w: 110, h: 20 }, ...more });
const garden = { l: 0, t: 0, r: W, b: H };

test('placeTags: a lone character gets the full tag; neighbours slide, shrink, move aside or hide, never overlapping', () => {
  assert.deepEqual(G.placeTags([item('a', 300, 300)], [], garden).get('a'), { mode: 'two', dx: 0, dy: 0 });
  const items = [item('a', 300, 300), item('b', 400, 300), item('c', 350, 330), item('d', 352, 332)];
  const blocks = items.map(i => i.body), got = G.placeTags(items, blocks, garden), boxes = [];
  for (const it of items) { const p = got.get(it.id); if (p.mode === 'hide') continue; const box = G.candidates(it).find(([s]) => s.mode === p.mode && s.dx === p.dx && s.dy === p.dy)[1]; for (const b of [...boxes, ...blocks]) assert.ok(!G.hits(box, b), it.id); boxes.push(box); }
  assert.equal(G.placeTags([item('e', 300, 300)], [garden], garden).get('e').mode, 'hide', 'no room anywhere: hidden until hover or focus');
});

test('placeTags: tags stay inside the garden and drop to one line in a crowd', () => {
  assert.notEqual(G.placeTags([item('a', 60, 300)], [], garden).get('a').dx, 0, 'slides in from the left edge');
  assert.equal(G.placeTags([item('a', 300, 480)], [], garden).get('a').mode, 'r', 'no room below the bottom edge: beside the body');
  const many = Array.from({ length: G.CROWD + 1 }, (_, i) => item('x' + i, 80 + i * 120, 200));
  assert.ok([...G.placeTags(many, [], garden).values()].every(p => p.mode !== 'two'));
});

test('fire: lit at dusk and night when dry; beside two meadow spots, clear of the pond', () => {
  assert.equal(G.fireLit('night', false), true);
  assert.equal(G.fireLit('dusk', false), true);
  assert.equal(G.fireLit('day', false), false);
  assert.equal(G.fireLit('dawn', false), false);
  assert.equal(G.fireLit('night', true), false);
  for (const i of G.BY_FIRE) assert.ok(i >= FISH.length && i < SLOTS.length);
  assert.deepEqual(G.BY_FIRE.map(G.fireFace), ['look-left', 'look-right'], 'sitters by the fire look toward it');
});

test('shortTitle: keeps short titles, drops filler and task verbs, keeps ticket ids and names, never cuts a word', () => {
  assert.equal(G.shortTitle('Tidy README'), 'Tidy README');
  assert.equal(G.shortTitle('Add dark mode toggle to settings page'), 'dark mode toggle');
  assert.equal(G.shortTitle('Bump Node to 24 in CI images'), 'Node 24 CI');
  assert.equal(G.shortTitle('Fix DAG import error in nightly_rollup'), 'nightly_rollup');
  assert.equal(G.shortTitle('CONNECT-7098 fix popslots sensor to ExternalTaskSensor'), 'CONNECT-7098');
  assert.equal(G.shortTitle('Fix flaky checkout test for ABC-12', 20), 'flaky ABC-12');
  assert.equal(G.shortTitle('Supercalifragilisticexpialidocious'), 'Supercalifragil…');
  for (const t of ['Investigate memory leak in websocket gateway', 'Port scheduler settings to Airflow 3', 'Explain the retry logic in the sync job']) {
    const s = G.shortTitle(t); assert.ok(s.length <= G.SHORT && s.length > 0, s);
    for (const w of s.split(' ')) assert.ok(t.includes(w), `${w} is a whole word of the title`);
  }
});

test('pickSpot: seventeen characters on a narrow garden leave most modelled crowd tags readable', () => {
  for (const [w, want] of [[768, 11], [1148, 14]]) {
    const used = new Set(), pond = [0, 4, 9];
    for (let n = 0; n < 17; n++) used.add(G.pickSpot(used, pond.includes(n), w, H));
    const ids = [...used], items = ids.filter(i => i >= FISH.length).map(i => G.modelItem(String(i), G.SPOTS[i], w, H)), all = ids.map(i => G.modelItem(String(i), G.SPOTS[i], w, H));
    const shown = [...G.placeTags(items, all.map(it => it.body), { l: 0, t: 0, r: w, b: H }, true).values()].filter(p => p.mode !== 'hide').length;
    assert.ok(shown >= want, `${shown} of ${items.length} at ${w} px`);
  }
});

test('matesOf: same project pulls, same branch pulls harder, unknown projects never group', () => {
  const others = [{ slot: 6, project: 'a', branch: 'x' }, { slot: 7, project: 'a', branch: 'y' }, { slot: 8, project: 'b', branch: 'x' }];
  assert.deepEqual(G.matesOf({ project: 'a', branch: 'x' }, others), [[6, 1], [7, .8]]);
  assert.deepEqual(G.matesOf({ project: 'unknown' }, [{ slot: 1, project: 'unknown' }]), []);
  assert.deepEqual(G.matesOf({ project: 'c' }, others), []);
  assert.equal(G.pull(6, [], W, H), 0, 'no teammates, no pull');
  assert.ok(G.pull(6, [[7, 1]], W, H) > G.pull(6, [[7, .8]], W, H) * 0 && G.pull(6, [[7, 1]], W, H) < G.pull(6, [[7, .8]], W, H), 'same branch pulls harder than same project');
  assert.ok(G.pull(6, [[11, 1]], W, H) <= G.PULL);
});

// Mean px from each character to its nearest same-project character, for projects dealt round-robin to n arrivals.
const spread = (n, w, group) => {
  const used = new Set(), who = [];
  for (let k = 0; k < n; k++) { const p = k % 4, mates = group ? who.filter(o => o.p === p).map(o => [o.slot, 1]) : [], i = G.pickSpot(used, false, w, H, 4, mates); used.add(i); who.push({ slot: i, p }); }
  const d = (a, b) => Math.hypot((G.SPOTS[a][0] - G.SPOTS[b][0]) * w, (G.SPOTS[a][1] - G.SPOTS[b][1]) * H);
  return { mean: who.reduce((t, o) => t + Math.min(...who.filter(q => q !== o && q.p === o.p).map(q => d(o.slot, q.slot))), 0) / n, used };
};
test('pickSpot: teammates stand closer together, without losing modelled tags or stacking bodies', () => {
  for (const [w, n] of [[1148, 12], [1148, 17], [768, 12]]) {
    const off = spread(n, w, false), on = spread(n, w, true);
    assert.ok(on.mean <= off.mean * (n > 12 ? 1 : .85), `${w} px, ${n}: ${on.mean.toFixed(0)} vs ${off.mean.toFixed(0)}`);
    assert.ok(G.crowdHidden([...on.used], w, H) <= G.crowdHidden([...off.used], w, H), `${w} px, ${n}: no extra hidden tags`);
    const at = [...on.used].map(i => G.SPOTS[i]);
    for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) assert.ok(Math.abs(at[a][0] - at[b][0]) * w >= 40 || Math.abs(at[a][1] - at[b][1]) * H >= 40);
  }
});

test('planSpots places a crowd like pickSpot one by one; bestPlan keeps the first order unless another loses fewer tags or none with more teammates side by side', async () => {
  const L = await import('../src/garden_layout.js');
  const list = [{ pond: false, project: 'a' }, { pond: false, project: 'b' }, { pond: false, project: 'a' }, { pond: false, project: 'b' }];
  const slots = L.planSpots(list, 1148, 500);
  assert.equal(new Set(slots).size, 4); assert.ok(slots.every(i => i >= FISH.length));
  const used = new Set(); assert.equal(slots[0], L.pickSpot(used, false, 1148, 500));
  const team = [list[0], list[2], list[1], list[3]], best = L.bestPlan([list, team], 1148, 500);
  assert.ok(best.list === list || best.list === team);
  assert.ok(L.matesNear(best.list, best.slots, 1148, 500) >= L.matesNear(list, slots, 1148, 500) || L.crowdHidden(best.slots, 1148, 500) < L.crowdHidden(slots, 1148, 500));
  assert.equal(L.matesNear([{ project: 'unknown' }, { project: 'unknown' }], [12, 13], 1148, 500), 0);
});

test('shortTitle never keeps a bare separator as a word', () => {
  const t = G.shortTitle('storefront-web · feature/login-rate-limit-rework', 16);
  assert.ok(!/(^|\s)[·|—-](\s|$)/.test(t), t);
  assert.ok(t.length > 0 && t.length <= 16, t);
});

test('shortTitle on the title shapes real sessions have', () => {
  const S = (/** @type {string} */ t) => G.shortTitle(t);
  assert.equal(S('refactor_nightly_rollup_partitions_by_region for the new scheduler'), 'refactor_nightl…', 'a long underscored first word is cut, not dropped');
  assert.equal(S('PROJ-4821 fix flaky checkout totals on retry'), 'PROJ-4821 flaky');
  assert.equal(S('תקן את דוח ההכנסות היומי לפני ההרצה'), 'תקן את דוח', 'Hebrew keeps its words in title order');
  assert.equal(S('בדיקת DAG של orders_daily אחרי השינוי'), 'DAG orders_daily');
  assert.equal(S('🚀 ship the release notes 🎉 before Friday'), 'ship release', 'emoji-only words are dropped');
  assert.equal(S('🎉'.repeat(20)), '🎉'.repeat(G.SHORT - 1) + '…', 'an emoji-only title is cut by characters, never mid-pair');
  assert.equal(S('(session)'), '(session)');
  assert.equal(S('3f2a9c1e'), '3f2a9c1e');
  assert.equal(S('/review-pr 482 --comments'), '/review-pr 482');
  assert.equal(S('src/storefront/components/checkout/PaymentSummaryTotalsBreakdownPanel.tsx'), 'src/storefront/…');
  assert.equal(S('"why does the cache miss on a cold start?"'), 'why does cache');
  assert.equal(S('{"task": "rename columns", "table": "orders"}'), 'task columns', 'braces and quotes are trimmed');
  assert.equal(S('[WIP] split the giant utils module'), 'WIP giant utils');
  assert.equal(S('Ünïcödé façade naïve résumé cleanup'), 'Ünïcödé façade');
  for (const t of ['', 'x', 'a'.repeat(200), '· · ·', '—']) { const s = S(t); assert.ok([...s].length <= G.SHORT, s); }
});

test('shortTitle of an untitled session at 390 px ends without a dangling separator (QA round 6 item 10)', () => {
  const t = G.shortTitle('qa-work-aHuu2J · feature/login-rate-limit-rework');
  assert.equal(t, 'qa-work-aHuu2J');
  assert.doesNotMatch(t, /[\s·:\-|—]$/);
});

test('pickMiners keeps drawn miners, then running subagents, then the most recently active', () => {
  const w = (id, updated, subs = []) => ({ id, updated, subs });
  const S = [w('a', 9), w('b', 8), w('c', 7, ['x']), w('d', 6), w('e', 5), w('f', 4, ['y']), w('g', 3)];
  assert.deepEqual(G.pickMiners(S, new Set()), ['c', 'f', 'a', 'b', 'd']);
  // Stable: the same input after a poll that only bumps times keeps the same five.
  const drawn = new Set(G.pickMiners(S, new Set())), bumped = S.map(s => ({ ...s, updated: s.updated + (s.id === 'g' ? 100 : 0) }));
  assert.deepEqual(new Set(G.pickMiners(bumped, drawn)), drawn);
  // A drawn miner that stops working frees its spot for the best of the rest.
  assert.deepEqual(G.pickMiners(S.filter(s => s.id !== 'a'), drawn), ['b', 'c', 'd', 'f', 'e']);
  assert.equal(G.pickMiners(S, new Set(), 0).length, 0);
  assert.equal(G.MINE_SPOTS, 5);
  assert.match(G.mineMoreText(17, 5), /^17 working, 12 not drawn/);
});

test('tagOrder serves fresh waits first and day-old ones last, so a tag with no room is never a fresh wait', () => {
  const it = (id, wait, x) => ({ ...G.modelItem(id, [x, .5], 300, 200), wait });
  // Three characters side by side in a garden with room for two tags under them: the day-old one loses, wherever it stands.
  for (const order of [['s', 'f', 'n'], ['f', 's', 'n'], ['n', 'f', 's']]) {
    const xs = { s: .3, f: .5, n: .7 }, waits = { s: 'stale', f: 'fresh', n: '' }, items = order.map(k => it(k, waits[k], xs[k]));
    const got = G.placeTags(G.tagOrder(items), [], { l: 0, t: 0, r: 300, b: 200 }, true), hidden = [...got].filter(([, p]) => p.mode === 'hide').map(([id]) => id);
    assert.ok(!hidden.includes('f'), `fresh hidden in ${order}`);
    if (hidden.length) assert.deepEqual(hidden, ['s']);
  }
  assert.deepEqual(G.tagOrder([{ id: 1, wait: 'stale' }, { id: 2, wait: 'long' }, { id: 3 }, { id: 4, wait: 'fresh' }, { id: 5 }]).map(x => x.id), [4, 3, 5, 2, 1]);
});
