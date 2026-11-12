// Gallery catalog and the command-line contact sheet: every tile points at a real sheet frame, and the PNG is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { images, install } from '../../tools/canvas_stub.mjs';

install();
const { allLooks, anims, catalog } = await import('../src/gallery.js');

test('every gallery tile is a frame inside a sheet the sprite code drew', () => {
  const tiles = catalog({ hat: 'crown', c: 5 }).flatMap(s => s.tiles);
  assert.equal(tiles.length, 91);
  for (const t of tiles) {
    const im = images.get(t.src); assert.ok(im, t.label);
    assert.deepEqual([im.w, im.h], [t.sw, t.sh], t.label);
    assert.ok(t.fx + t.fw <= im.w && t.fh <= im.h, t.label);
    if (t.copy) assert.match(t.copy, /^(\[frame [\w-]+\]\n([^\s]+\n)+|\w+( \w+=#[0-9a-f]{6})+\n)$/, t.label);
  }
  assert.equal(new Set(allLooks().flat().map(l => l.src)).size, 80);
  for (const a of anims({ hat: 'cap', c: 2 })) assert.ok(images.get(a.src) && a.ms > 0 && a.frames.every(f => (f + 1) * a.fw <= a.sw || a.alt), a.label);
});

test('art_sheet.mjs writes a PNG contact sheet', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'art-sheet-')), 'sheet.png');
  execFileSync(process.execPath, [new URL('../../tools/art_sheet.mjs', import.meta.url).pathname, out]);
  const b = readFileSync(out);
  assert.deepEqual([...b.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(b.readUInt32BE(16), 1800);
  assert.ok(b.readUInt32BE(20) > 3000);
});
