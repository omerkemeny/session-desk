// Pixel equality: every sheet the app draws must match the fixture captured from the sprite code before the art moved to data files.
// Refresh the fixture only for an intended art change: UPDATE_PIXELS=1 node --test web/tests/pixels.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { hashJson, hashOf, renderAll } from './sheets.mjs';
import * as S from '../src/sprites.js';

const FIX = new URL('./fixtures/pixels.json', import.meta.url);

test('every sprite sheet is pixel-identical to the fixture', () => {
  const now = Object.fromEntries([...renderAll(S, S.ROD)].map(([k, b]) => [k, hashOf(b)]));
  Object.assign(now, { 'const:COL': hashJson(S.COL), 'const:BODIES': hashJson(S.BODIES), 'const:HN': hashJson(S.HN), 'const:ROD': hashJson(S.ROD) });
  if (process.env.UPDATE_PIXELS) writeFileSync(FIX, JSON.stringify(now, null, 0).replace(/,"/g, ',\n"') + '\n');
  const want = JSON.parse(readFileSync(FIX, 'utf8'));
  assert.deepEqual(Object.keys(now).sort(), Object.keys(want).sort(), 'sheet list changed');
  const diff = Object.keys(want).filter(k => want[k] !== now[k]);
  assert.deepEqual(diff, [], `${diff.length} of ${Object.keys(want).length} sheets differ`);
});
