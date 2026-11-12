// Unit tests for the data-driven scenery rules in src/world_data.js and the drying puddles in src/world_time.js; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blooms, boats, catNaps, COMET_PRS, cometOn, dayTotals, IDLE_MIN, lanternLit, MAX_BLOOMS, MAX_BOATS, oreStep, parseWorld, world, worldNow } from '../src/world_data.js';
import { ilInstant, puddleLeft } from '../src/world_time.js';
import { comet, oreHeap, sunflowers } from '../src/world_art.js';

const NOON = ilInstant('2026-11-11', 720).getTime(), H = 3600e3;
const S = [
  { id: 'a', status: 'waiting', updated: NOON - H, tokens: 400e3, prOpened: 2, kind: 'interactive' },
  { id: 'b', status: 'done', updated: NOON - 2 * H, tokens: 1500, kind: 'headless' },
  { id: 'c', status: 'done', updated: NOON - 11.5 * H, tokens: 2e6, prOpened: 1 },  // 00:30 today
  { id: 'd', status: 'done', updated: NOON - 12.5 * H, tokens: 9e6, prOpened: 4, kind: 'headless' },  // 23:30 yesterday
];

test('day totals count only sessions updated today in Israel', () => {
  assert.deepEqual(dayTotals(S, NOON), { tokens: 400e3 + 1500 + 2e6, prs: 3, runs: 1 });
  assert.deepEqual(dayTotals([], NOON), { tokens: 0, prs: 0, runs: 0 });
  assert.deepEqual(dayTotals(/** @type {any} */ ([null, { updated: NaN }, { updated: NOON, tokens: -5, prOpened: 'x' }]), NOON), { tokens: 0, prs: 0, runs: 0 });
  assert.deepEqual(dayTotals(S, NOON + 12.1 * H), { tokens: 0, prs: 0, runs: 0 }, 'empties after midnight');
});

test('day totals take exact tokensToday and prsToday when a session sends them, else the whole-session rule', () => {
  const X = [
    { id: 'a', status: 'waiting', updated: NOON - H, tokens: 400e3, prOpened: 2, tokensToday: 120e3, prsToday: 1 },  // today: exact figures win
    { id: 'd', status: 'done', updated: NOON - 12.5 * H, tokens: 9e6, prOpened: 4, tokensToday: 0, prsToday: 0 },  // yesterday, exact zero
    { id: 'e', status: 'running', updated: NOON - 13 * H, tokens: 5e6, prOpened: 3, tokensToday: 2e6, prsToday: 2 },  // started yesterday, worked today
    { id: 'c', status: 'done', updated: NOON - 11.5 * H, tokens: 2e6, prOpened: 1 },  // no exact figures: whole session, updated today
  ];
  assert.deepEqual(dayTotals(X, NOON), { tokens: 120e3 + 2e6 + 2e6, prs: 1 + 2 + 1, runs: 0 });
  assert.deepEqual(dayTotals(/** @type {any} */ ([{ updated: NOON, tokens: 5, tokensToday: -3, prsToday: NaN, prOpened: 2 }]), NOON), { tokens: 0, prs: 2, runs: 0 }, 'bad exact values: negative counts as 0, NaN falls back');
  const w = worldNow(/** @type {any} */ (X), NOON); assert.equal(w.ore, 3); assert.equal(w.blooms, 4); assert.equal(w.prs, 4);
});

test('ore steps, blooms and boats are coarse and capped', () => {
  assert.deepEqual([0, 249e3, 250e3, 1e6, 2.9e6, 3e6, 10e6, 1e9].map(oreStep), [0, 0, 1, 2, 2, 3, 4, 4]);
  assert.deepEqual([0, 1, 3.7, 8, 50, -2].map(blooms), [0, 1, 3, MAX_BLOOMS, MAX_BLOOMS, 0]);
  assert.deepEqual([0, 1, 2, 3, 30].map(boats), [0, 1, 2, MAX_BOATS, MAX_BOATS]);
});

test('comet needs a big day and a clear dark sky', () => {
  assert.equal(cometOn(COMET_PRS, 1, true), true);
  assert.equal(cometOn(COMET_PRS - 1, 1, true), false);
  assert.equal(cometOn(COMET_PRS, .2, true), false, 'not by day');
  assert.equal(cometOn(COMET_PRS, 1, false), false, 'not behind cloud or rain');
});

test('overrides from the address replace the session numbers', () => {
  const EGGS = worldNow(S, NOON).eggs; assert.ok(EGGS >= 1);
  assert.deepEqual(parseWorld('?crowd=4&tokens=3e6&prs=6&runs=2&rainago=30&lantern=0&cat=1'), { tokens: 3e6, prs: 6, runs: 2, rainAgo: 30, week: null, lantern: false, cat: true, notes: null, vane: null, streak: null });
  assert.deepEqual(parseWorld(''), { tokens: null, prs: null, runs: null, rainAgo: null, week: null, lantern: null, cat: null, notes: null, vane: null, streak: null });
  Object.assign(world, { tokens: 0, prs: 9, runs: null, week: [true], lantern: true, cat: true });
  try { assert.deepEqual(worldNow(S, NOON), { ore: 0, blooms: 8, boats: 1, prs: 9, week: [true], lantern: true, cat: true, notes: 0, vane: true, eggs: EGGS }); } finally { Object.assign(world, { tokens: null, prs: null, runs: null, week: null, lantern: null, cat: null }); }
  assert.deepEqual(worldNow(S, NOON), { ore: 2, blooms: 3, boats: 1, prs: 3, week: [false, false, false, false, false, true, true], lantern: false, cat: true, notes: 0, vane: true, eggs: EGGS });
});

test('puddles stay while it rains and dry over two hours', () => {
  assert.equal(puddleLeft(1e9, true, false), 1);
  assert.equal(puddleLeft(0, false, false), 1);
  assert.equal(puddleLeft(60, false, false), .5);
  assert.equal(puddleLeft(120, false, false), 0);
  assert.equal(puddleLeft(-5, false, false), 0, 'rain time in the future');
  assert.equal(puddleLeft(10, true, true), 0, 'none under snow');
  assert.equal(puddleLeft((Date.now() - 0) / 60000, false, false), 0, 'never rained');
});

// Records pixels drawn by the art helpers.
const grid = () => { const px = new Map(); return { px, G: { px: (x, y, c) => px.set(`${Math.round(x)},${Math.round(y)}`, c), rect: (c, x, y, w, h) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px.set(`${Math.round(x) + i},${Math.round(y) + j}`, c); }, tint: (x, y, c, a) => { if (a > 0) px.set(`${Math.round(x)},${Math.round(y)}`, c); } } }; };
const K = { stone: '#a88660', blockL: '#e2b47c', dark: '#7a5c44', ore: ['#ffd447', '#6fe0ff'] };
const P = { fl: ['#ff6b8b', '#ffd447', '#ffffff', '#c58bff', '#ff9a4a'], trunkD: '#4a2c2e', stem: '#3f9a4a', leaf2: '#64c05a' };

test('ore heap grows with the step and stays above its base', () => {
  const sizes = [1, 2, 3, 4].map(step => { const { px, G } = grid(), gl = []; oreHeap(G, 50, 40, step, K, gl); assert.equal(gl.length, step);
    for (const k of px.keys()) { const [x, y] = k.split(',').map(Number); assert.ok(y <= 40 && Math.abs(x - 50) <= 7, k); } return px.size; });
  for (let i = 1; i < 4; i++) assert.ok(sizes[i] > sizes[i - 1], sizes.join());
});

test('sunflowers stay by the fence and off the gate', () => {
  const { px, G } = grid(); sunflowers(G, 30, 110, [70], 40, 8, P, 1, 0);
  const xs = [...px.keys()].map(k => k.split(',').map(Number));
  assert.ok(xs.every(([x, y]) => y >= 40 - 2 - 2 && y <= 53 && x >= 30 && x <= 125), 'inside the fence strip');
  assert.equal([...px.entries()].filter(([, c]) => c === P.trunkD).length, 8, 'eight heads');
});

test('comet stays near its head and tails up-left', () => {
  const { px, G } = grid(); comet(G, 100, 30, '#ffffff', 1);
  const pts = [...px.keys()].map(k => k.split(',').map(Number));
  assert.ok(pts.every(([x, y]) => x <= 103 && y <= 33 && x >= 70 && y >= 10), 'tail within 30 px, up and left');
});

test('weekPrs: one star per day of the last seven with a pull-request session active that day', async () => {
  const { weekPrs, WEEK } = await import('../src/world_data.js');
  const D = 864e5, S = [{ id: 'a', status: 'waiting', updated: NOON, prOpened: 1 }, { id: 'b', status: 'waiting', updated: NOON - 2 * D, prOpened: 2 },
    { id: 'c', status: 'waiting', updated: NOON - 3 * D, prOpened: 0 }, { id: 'd', status: 'waiting', updated: NOON - 9 * D, prOpened: 4 }, { id: 'e', status: 'waiting', updated: NOON + 2 * D, prOpened: 1 }];
  assert.equal(WEEK, 7);
  assert.deepEqual(weekPrs(S, NOON), [false, false, false, false, true, false, true]);
  assert.deepEqual(weekPrs([{ id: 'f', status: 'running', updated: NOON, prOpened: 0, prsToday: 1 }], NOON), [false, false, false, false, false, false, true]);
  assert.deepEqual(weekPrs([], NOON), Array(7).fill(false));
  assert.deepEqual(parseWorld('?week=1101011').week, [true, true, false, true, false, true, true]);
  assert.deepEqual(parseWorld('?week=0').week, Array(7).fill(false));
  assert.equal(parseWorld('?prs=2').week, null);
});

test('lanternLit: the mine lantern burns while at least one session works', () => {
  assert.equal(lanternLit([]), false);
  assert.equal(lanternLit(/** @type {any} */ ([{ id: 'a', status: 'waiting' }, { id: 'b', status: 'done' }])), false);
  assert.equal(lanternLit(/** @type {any} */ ([{ id: 'a', status: 'waiting' }, { id: 'b', status: 'running' }])), true);
  assert.equal(lanternLit(/** @type {any} */ (null)), false);
});

test('catNaps: the cat sleeps only while nothing works and every wait is IDLE_MIN or older', () => {
  const w = (/** @type {number} */ m) => ({ id: 'w' + m, status: 'waiting', waitingSince: NOON - m * 60000, updated: NOON - m * 60000 });
  assert.equal(catNaps([], NOON), true, 'an empty garden is idle');
  assert.equal(catNaps(/** @type {any} */ ([w(IDLE_MIN), w(26 * 60)]), NOON), true);
  assert.equal(catNaps(/** @type {any} */ ([w(IDLE_MIN - 1), w(26 * 60)]), NOON), false, 'a recent wait wakes it');
  assert.equal(catNaps(/** @type {any} */ ([w(26 * 60), { id: 'r', status: 'running', updated: NOON - 9 * H }]), NOON), false, 'a working session wakes it');
  assert.equal(catNaps(/** @type {any} */ ([w(90), { id: 'd', status: 'done', updated: NOON }]), NOON), true, 'finished sessions do not count');
});

test('syncNotes pins one note per session out of step, at most MAX_NOTES; ?notes=N overrides', async () => {
  const D = await import('../src/world_data.js');
  assert.equal(D.syncNotes([]), 0);
  assert.equal(D.syncNotes([{ id: 'a', behind: true }, { id: 'b', also: ['the desktop app'] }, { id: 'c', also: [''] }, { id: 'd', consistency: 'ok' }]), 2);
  assert.equal(D.syncNotes([{ id: 'e', consistency: 'diverged' }]), 1);
  assert.equal(D.syncNotes(Array.from({ length: 9 }, (_, i) => ({ id: 'x' + i, behind: true }))), D.MAX_NOTES);
  assert.equal(D.parseWorld('?notes=2').notes, 2); assert.equal(D.parseWorld('?x=1').notes, null);
});

test('nest: one egg per day in a row with a session, counted from today or from yesterday while today has none, capped', async () => {
  const { streakDays, eggs, MAX_EGGS } = await import('../src/world_data.js');
  const D = 864e5, at = (/** @type {number} */ d) => ({ id: 'd' + d, status: 'done', updated: NOON - d * D });
  assert.equal(streakDays([], NOON), 0);
  assert.equal(streakDays([at(0)], NOON), 1);
  assert.equal(streakDays([at(0), at(1), at(2), at(4)], NOON), 3);
  assert.equal(streakDays([at(1), at(2)], NOON), 2, 'today not over yet');
  assert.equal(streakDays([at(2), at(3)], NOON), 0, 'a missed day breaks it');
  assert.equal(streakDays([0, 1, 2, 3, 4, 5, 6, 7, 8].map(at), NOON), MAX_EGGS);
  assert.equal(streakDays([at(0), { ...at(0), updated: NOON - 11 * H }], NOON), 1, 'two sessions on one day');
  assert.deepEqual([0, 1, 3, 9, -1].map(eggs), [0, 1, 3, MAX_EGGS, 0]);
  assert.equal(parseWorld('?streak=4&vane=0').streak, 4); assert.equal(parseWorld('?vane=0').vane, false);
});

test('the nest takes the Stats panel streak once it is known', async () => {
  const { setStreak, worldNow } = await import('../src/world_data.js');
  setStreak(3); assert.equal(worldNow([], Date.UTC(2026, 10, 12, 10)).eggs, 3);
  setStreak(9); assert.equal(worldNow([], Date.UTC(2026, 10, 12, 10)).eggs, 5);
  setStreak(null); assert.equal(worldNow([], Date.UTC(2026, 10, 12, 10)).eggs, 0);
});
