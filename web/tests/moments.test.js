// Unit tests for the pure rules in src/world_data.js: which sessions just finished a turn and which sky moment shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { finished, momentKind, GAP } from '../src/world_data.js';

test('finished: only running-to-waiting changes count, never the first look', () => {
  const S = [{ id: 'a', status: 'waiting' }, { id: 'b', status: 'running' }];
  const first = finished(null, S); assert.equal(first.done, 0, 'already waiting on page load');
  const next = finished(first.next, [{ id: 'a', status: 'waiting' }, { id: 'b', status: 'waiting' }, { id: 'c', status: 'waiting' }]);
  assert.equal(next.done, 1, 'b finished; a was waiting, c is new');
  assert.equal(finished(next.next, [{ id: 'b', status: 'done' }]).done, 0);
});

test('momentKind: star by night, bird by day, at most one per GAP, none under reduced motion', () => {
  const night = { done: 2, now: 100000, last: -Infinity, still: false, starA: 1, L: 0, clear: true, dry: true }, day = { ...night, starA: 0, L: 1 };
  assert.equal(momentKind(night), 'star');
  assert.equal(momentKind(day), 'bird');
  assert.equal(momentKind({ ...night, done: 0 }), '');
  assert.equal(momentKind({ ...night, still: true }), '', 'reduced motion');
  assert.equal(momentKind({ ...night, last: 100000 - GAP + 1 }), '', 'too soon after the last one');
  assert.equal(momentKind({ ...night, last: 100000 - GAP }), 'star');
  assert.equal(momentKind({ ...night, clear: false }), '', 'clouded night');
  assert.equal(momentKind({ ...day, dry: false }), '', 'rainy day');
  assert.equal(momentKind({ ...night, starA: .3, L: .4 }), '', 'twilight in between');
});
