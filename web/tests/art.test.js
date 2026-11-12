// Art files: lint rules, the bundled copy in art.generated.js is current, and the parser reports bad input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ART_DIR, lintArt } from '../../tools/art_lint.mjs';
import { ART_TEXT } from '../src/art.generated.js';
import { parseArt } from '../src/sprites.js';

test('art files pass the lint (unused letters are warnings)', t => {
  const { errors, warnings } = lintArt();
  for (const w of warnings) t.diagnostic('warn: ' + w);
  assert.deepEqual(errors, []);
});

test('art.generated.js matches web/art/*.txt (else run python3 tools/art_build.py)', () => {
  const files = readdirSync(ART_DIR).filter(f => f.endsWith('.txt')).sort();
  assert.deepEqual(Object.keys(ART_TEXT).sort(), files);
  for (const f of files) assert.equal(ART_TEXT[f], readFileSync(join(ART_DIR, f), 'utf8'), f + ' changed since the last build');
});

test('lint catches ragged rows, unknown letters, wrong sizes, missing roles and tall hats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'art-lint-')) + '/';
  for (const f of readdirSync(ART_DIR).filter(f => f.endsWith('.txt'))) writeFileSync(dir + f, readFileSync(join(ART_DIR, f), 'utf8'));
  const edit = (/** @type {string} */ f, /** @type {string} */ a, /** @type {string} */ b) => { const s = readFileSync(dir + f, 'utf8'); assert.ok(s.includes(a), a); writeFileSync(dir + f, s.replace(a, b)); };
  edit('legs.txt', '..o.o......o.o..\n..o.o......o.o..', '..o.o......o.o..\n..o.o......o.o.');
  edit('rock.txt', '...lll....', '...lZl....');
  edit('miner.txt', '[frame strike]\n......................\n', '[frame strike]\n');
  edit('fish.txt', 'pink    main=#f29bc0 dark=#c9668f', 'pink    main=#f29bc0');
  edit('hats.txt', '[frame wizard]\n', '[frame wizard]\n................\n');
  const { errors } = lintArt(dir), has = (/** @type {string} */ s) => assert.ok(errors.some(e => e.includes(s)), s + ' in ' + JSON.stringify(errors));
  has('legs.txt [frame stand] row 2: 15 wide'); has("letter 'Z'"); has('[frame strike]: 22x14'); has('colour set pink: no dark='); has('[frame wizard]: 16x6 does not fit');
});

test('parser rejects malformed lines with file and line number', () => {
  assert.throws(() => parseArt('[palette]\nq red', 'x.txt'), /x\.txt:2/);
  assert.throws(() => parseArt('[frame a]\n..\n[frame a]\n..', 'x.txt'), /defined twice/);
  assert.throws(() => parseArt('hello', 'x.txt'), /x\.txt:1/);
  assert.throws(() => parseArt('[frame a]\n. .', 'x.txt'), /spaces/);
  assert.deepEqual(parseArt('size 2x1\n# note\n[palette]\nq #ffffff @main  a note\n[colours]\nc main=#000000\n[frame a]\n  q.\n'),
    { size: [2, 1], fit: null, palette: { q: { hex: '#ffffff', role: 'main', note: 'a note' } }, colours: [{ name: 'c', values: { main: '#000000' } }], frames: { a: ['q.'] } });
});
