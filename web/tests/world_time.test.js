// Unit tests for the garden's date and sky maths in src/world_time.js and the pure parts of src/scene_extras.js; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { altAz, ilDay, ilInstant, leafFall, migration, moonLit, moonPhase, moonPx, rainEnded, rainbow, skyStars, smokeCount } from '../src/world_time.js';
import { drawRainbow, sceneInstant, season, sky } from '../src/scene_extras.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} not within ${tol} of ${b}`);
// Distance between two phases on the cycle.
const cyc = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));

test('moon phase matches published new and full moons', () => {
  near(cyc(moonPhase(new Date('2026-11-09T07:02Z')), 0), 0, .02, 'new moon 2026-11-09');
  near(moonPhase(new Date('2026-11-24T14:53Z')), .5, .02, 'full moon 2026-11-24');
  near(moonPhase(new Date('2026-12-24T01:28Z')), .5, .02, 'full moon 2026-12-24');
  near(cyc(moonPhase(new Date('2000-01-06T18:14Z')), 0), 0, .01, 'reference new moon');
  near(cyc(moonPhase(new Date('2024-04-08T18:21Z')), 0), 0, .02, 'eclipse new moon 2024-04-08');
  const p = moonPhase(new Date('1990-05-01T00:00Z')); assert.ok(p >= 0 && p < 1);
});

test('lit fraction and lit pixels follow the phase', () => {
  near(moonLit(0), 0, 1e-9); near(moonLit(.5), 1, 1e-9); near(moonLit(.25), .5, 1e-9);
  const r = 8.4, count = p => { let n = 0; for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++) if (i * i + j * j <= 70 && moonPx(i, j, r, p)) n++; return n; };
  assert.equal(count(.001), 0, 'new moon is dark');
  const full = count(.5); assert.ok(full > 200, `full ${full}`);
  near(count(.25) / full, .5, .08, 'first quarter is half lit');
  assert.ok(moonPx(7, 0, r, .1) && !moonPx(-7, 0, r, .1), 'waxing crescent lit on the right');
  assert.ok(moonPx(-7, 0, r, .9) && !moonPx(7, 0, r, .9), 'waning crescent lit on the left');
});

test('Israel day and instant handle summer and winter time', () => {
  assert.deepEqual(ilDay(new Date('2026-11-11T22:30Z')), { iso:'2026-11-12', y:2026, m:11, d:12 });
  assert.equal(ilInstant('2026-11-11', 23 * 60).toISOString(), '2026-11-11T21:00:00.000Z');
  assert.equal(ilInstant('2026-07-15', 12 * 60).toISOString(), '2026-07-15T09:00:00.000Z');
  assert.equal(ilInstant('2026-01-01', 0).toISOString(), '2025-12-31T22:00:00.000Z');
});

test('scene instant uses the preview date at the scene minute', () => {
  sky.date = new Date('2026-07-15T08:00:00Z');
  try { assert.equal(sceneInstant(600).toISOString(), '2026-07-15T07:00:00.000Z'); } finally { sky.date = null; }
});

test('leaf fall runs October to mid December and peaks in November', () => {
  assert.equal(leafFall(9, 20), 0); assert.equal(leafFall(12, 20), 0); assert.equal(leafFall(6, 1), 0);
  assert.equal(leafFall(11, 11), 1);
  assert.ok(leafFall(10, 10) > 0 && leafFall(10, 10) < 1);
  assert.deepEqual(season(new Date('2026-11-11T10:00Z')), { leaves: 1, flock: 1 });
  assert.deepEqual(season(new Date('2026-07-15T10:00Z')), { leaves: 0, flock: 0 });
});

test('migration flies right in autumn, left in spring, not otherwise', () => {
  assert.equal(migration(9, 1), 1); assert.equal(migration(11, 20), 1); assert.equal(migration(11, 21), 0);
  assert.equal(migration(3, 15), -1); assert.equal(migration(5, 15), -1); assert.equal(migration(5, 16), 0);
  assert.equal(migration(1, 1), 0); assert.equal(migration(7, 1), 0);
});

test('smoke rises from fewer chimneys as it gets warmer', () => {
  assert.equal(smokeCount(null), 3); assert.equal(smokeCount(5), 3); assert.equal(smokeCount(18), 2); assert.equal(smokeCount(23), 1); assert.equal(smokeCount(30), 0);
});

test('rain end time comes from the last wet hour not after now', () => {
  const t = ['2026-11-11T15:00', '2026-11-11T16:00', '2026-11-11T17:00', '2026-11-11T18:00'], now = Date.parse('2026-11-11T15:30Z');
  assert.equal(rainEnded(t, [0, .4, 0, 0], 7200, now), Date.parse('2026-11-11T14:00Z'));
  assert.equal(rainEnded(t, [.3, 0, 0, 2], 7200, now), Date.parse('2026-11-11T13:00Z'), 'future hour ignored');
  assert.equal(rainEnded(t, [0, .05, 0, 0], 7200, now), 0, 'drizzle under 0.1 mm ignored');
  assert.equal(rainEnded(undefined, undefined, 7200, now), 0);
});

test('rainbow fades after rain and needs sun and a broken sky', () => {
  assert.equal(rainbow(0, 1, false, 40), 1);
  near(rainbow(22.5, 1, false, 40), .5, 1e-9);
  assert.equal(rainbow(45, 1, false, 40), 0);
  assert.equal(rainbow(-5, 1, false, 40), 0);
  assert.equal(rainbow(10, 1, true, 40), 0, 'still raining');
  assert.equal(rainbow(10, .2, false, 40), 0, 'sun down');
  assert.equal(rainbow(10, 1, false, 95), 0, 'overcast');
});

test('rainbow arc tints six bands above the cut line only', () => {
  /** @type {Map<string, string>} */
  const seen = new Map(), G = { tint: (x, y, c) => { seen.set(x + ',' + y, c); } };
  drawRainbow(G, 100, 60, 40, .5, 50);
  assert.ok(seen.size > 100);
  assert.ok([...seen.keys()].every(k => +k.split(',')[1] < 50));
  assert.equal(new Set(seen.values()).size, 6);
});

test('Sirius culminates at the right altitude over Tel Aviv', () => {
  // Find the highest altitude over one sidereal day in 4-minute steps.
  let best = -90; for (let m = 0; m < 1440; m += 4) best = Math.max(best, altAz(6.752, -16.72, new Date(Date.UTC(2026, 0, 15, 0, m))).alt);
  near(best, 90 - 32.0853 - 16.72, .3);
  const { alt, az } = altAz(6.752, -16.72, new Date('2026-01-15T22:00Z')); assert.ok(alt > 0 && az > 150 && az < 270, `${alt} ${az}`);
});

test('sky stars stay inside the sky band', () => {
  for (const iso of ['2026-01-15T20:00Z', '2026-07-15T20:00Z', '2026-11-11T21:00Z']) {
    const st = skyStars(new Date(iso), 574, 64);
    assert.ok(st.length > 3, iso);
    for (const [x, y] of st) assert.ok(x >= 0 && x < 574 && y >= 1 && y < 64, `${iso} ${x},${y}`);
  }
});

test('sunTimes: Tel Aviv sunrise and sunset within 3 minutes of published times, summer and winter clocks', async () => {
  const { sunTimes } = await import('../src/world_time.js');
  const hm = s => +s.slice(0, 2) * 60 + +s.slice(3);
  // Open-Meteo daily sunrise and sunset for 32.0853 N, 34.7818 E, local clock (June and September in summer time).
  for (const [iso, sr, ss] of [['2025-12-21', '06:37', '16:40'], ['2026-03-20', '05:44', '17:52'], ['2026-06-21', '05:35', '19:50'], ['2026-09-23', '06:29', '18:36'], ['2026-11-11', '06:05', '16:43']]) {
    const t = sunTimes(iso); near(t.sr, hm(sr), 3, `${iso} sunrise`); near(t.ss, hm(ss), 3, `${iso} sunset`);
  }
});

test('wind leans smoke and rain in three coarse steps, by the cross-screen part of the wind', async () => {
  const { windLean, smokeDrift } = await import('../src/world_time.js');
  assert.equal(windLean(null, 90), 0, 'unknown wind: calm');
  assert.equal(windLean(8, 90), 0, 'light air');
  assert.equal(windLean(20, 90), 1, 'east wind pushes right (scene looks south)');
  assert.equal(windLean(20, 270), -1, 'west wind pushes left');
  assert.equal(windLean(40, 270), -2);
  assert.equal(windLean(40, 0), 0, 'north wind blows into the screen');
  assert.equal(smokeDrift(0, false), 6, 'calm keeps the approved drift'); assert.equal(smokeDrift(0, true), 16);
  assert.ok(smokeDrift(-1, false) < 0 && smokeDrift(2, false) > smokeDrift(1, false));
});

test('moonFull is 1 at full moon and 0 from a day and a half away', async () => {
  const { moonFull } = await import('../src/world_time.js');
  assert.equal(moonFull(.5), 1);
  assert.equal(moonFull(.5 + 1.6 / 29.53), 0);
  assert.equal(moonFull(0), 0);
  near(moonFull(.5 - .75 / 29.530588853), .5, 1e-9, 'half a day and a quarter');
  near(moonFull(moonPhase(new Date('2026-11-24T20:00:00Z'))), 1, .35, 'full moon night');
  assert.equal(moonFull(moonPhase(new Date('2026-11-11T20:00:00Z'))), 0);
});

test('fireflies flash for FIREFLY_MIN after sunset; the backdrop repaint gap follows what moves', async () => {
  const W = await import('../src/world_time.js'), calm = { events: 0, hooks: 0, wet: false, snow: false, L: .1, flies: false, clouds: 0, fog: false, boats: 0 };
  assert.equal(W.fireflyTime(1004 + 60, 1004), true); const after = t => (t - 1004 + 1440) % 1440 <= W.FIREFLY_MIN; assert.equal(W.fireflyTime(1004 + W.FIREFLY_MIN + 1, 1004), after(1004 + W.FIREFLY_MIN + 1)); assert.equal(W.fireflyTime(1004 - 10, 1004), after(1004 - 10));
  assert.equal(W.repaintMs(calm), 0);
  assert.equal(W.repaintMs({ ...calm, clouds: 2 }), W.SLOW_MS); assert.equal(W.repaintMs({ ...calm, boats: 1 }), W.SLOW_MS); assert.equal(W.repaintMs({ ...calm, fog: true }), W.SLOW_MS);
  for (const o of [{ events: 1 }, { hooks: 1 }, { wet: true }, { flies: true }, { L: .9 }]) assert.equal(W.repaintMs({ ...calm, ...o }), W.FAST_MS, JSON.stringify(o));
  assert.equal(W.repaintMs({ ...calm, wet: true, snow: true, L: .9 }), 0);
});

test('weather vane: head into the wind as seen looking south, shortened toward or away, still at the sea breeze until the wind is known', async () => {
  const { vanePose, VANE_REST } = await import('../src/world_time.js');
  assert.deepEqual(vanePose(90), { x: -1, z: 0 });   // from the east: head left
  assert.deepEqual(vanePose(270), { x: 1, z: 0 });   // from the west: head right
  assert.deepEqual(vanePose(180), { x: 0, z: 1 });   // from the south: toward the viewer
  assert.deepEqual(vanePose(0), { x: 0, z: -1 });    // from the north: away
  assert.deepEqual(vanePose(225), { x: 1, z: 1 });   // south-west
  assert.deepEqual(vanePose(45), { x: -1, z: -1 });  // north-east
  assert.deepEqual(vanePose(360 + 90), vanePose(90));
  assert.deepEqual(vanePose(null), vanePose(VANE_REST));
  for (let d = 0; d < 360; d += 5) { const p = vanePose(d); assert.ok(p.x || p.z, `pose at ${d}`); }
});
