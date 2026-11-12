// Unit tests for the small helpers in src/util.js; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, fmt, hash, mix, rel, rng } from '../src/util.js';

test('esc escapes markup characters and tolerates null', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc("it's"), "it's");
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

test('hash is a stable unsigned 32-bit number', () => {
  assert.equal(hash(''), 7);
  assert.equal(hash('a'), 7 * 31 + 97);
  assert.equal(hash('session-1'), hash('session-1'));
  assert.notEqual(hash('s1'), hash('s2'));
  const h = hash('x'.repeat(1000));
  assert.ok(Number.isInteger(h) && h >= 0 && h < 2 ** 32);
});

test('fmt shortens counts', () => {
  assert.deepEqual([0, 999, 1000, 1499, 1500, 184000, 999499, 1e6, 1167000].map(fmt), ['0', '999', '1k', '1k', '2k', '184k', '999k', '1.0M', '1.2M']);
});

test('fmt rolls 999,500 to 999,999 over to 1.0M instead of 1000k', () => {
  assert.deepEqual([999500, 999999].map(fmt), ['1.0M', '1.0M']);
});

test('rel turns a timestamp into an age', () => {
  const now = Date.now(), min = 60000;
  assert.equal(rel(now), 'now');
  assert.equal(rel(now - 29 * 1000), 'now');
  assert.equal(rel(now - 5 * min), '5 min ago');
  assert.equal(rel(now - 59 * min), '59 min ago');
  assert.equal(rel(now - 60 * min), '1 h ago');
  assert.equal(rel(now - 1409 * min), '23 h ago');
  assert.equal(rel(now - 1440 * min), '1 d ago');
  assert.equal(rel(now - 3 * 1440 * min), '3 d ago');
});

test('rel shows 1 d ago instead of 24 h ago from 1,410 minutes', () => {
  const now = Date.now(), min = 60000;
  assert.equal(rel(now - 1410 * min), '1 d ago');
  assert.equal(rel(now - 1439 * min), '1 d ago');
});

test('mix blends two hex colours', () => {
  assert.equal(mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mix('#000000', '#ffffff', .5), '#808080');
  assert.equal(mix('#ff0000', '#0000ff', .25), '#bf0040');
});

test('rng is seeded, repeatable and stays in 0..1', () => {
  const a = rng(42), b = rng(42), c = rng(43);
  const xs = Array.from({ length: 200 }, a), ys = Array.from({ length: 200 }, b);
  assert.deepEqual(xs, ys);
  assert.notEqual(c(), rng(42)());
  for (const x of xs) assert.ok(x >= 0 && x < 1);
});
