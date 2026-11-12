// Truth test for the Legend page: its one table (ROWS, KEYS, QUOTED in src/legend.js) must match what the code exports and does; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { install } from '../../tools/canvas_stub.mjs';

install();
const ROOT = new URL('../../', import.meta.url), read = (/** @type {string} */ f) => readFileSync(new URL(f, ROOT), 'utf8');
const L = await import('../src/legend.js');
const { ART, BODIES, HN, PROPS, TOOLS } = await import('../src/sprites.js');
const A = await import('../src/activity.js');
const { badges, keyAction, termLeave } = await import('../src/logic.js');
const { momentKind } = await import('../src/world_data.js');
const { ENDED, exitText, modeText } = await import('../src/feed.js');
const MODS = ['activity', 'world_data', 'world_time', 'scene_extras', 'garden_layout', 'world_art'];
const EXPORTS = Object.fromEntries(await Promise.all(MODS.map(async m => [m, Object.keys(await import(`../src/${m}.js`))])));
/** Everything the legend says it shows, by kind. @param {string} k */
const shown = k => new Set(L.ROWS.flatMap(r => r.shows?.[k] || []));

test('every rule number comes from the code: no digits in rule text, no literal numbers in rule templates', () => {
  for (const r of L.ROWS) {
    assert.ok(r.rule.text.length > 10 && r.meaning.length > 3, r.id);
    for (const p of r.rule.parts) assert.doesNotMatch(p, /\d/, `${r.id}: a number typed into the rule text: "${p}"`);
    for (const v of r.rule.values) assert.ok(typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.length > 0, `${r.id}: empty value`);
  }
  const src = read('web/src/legend.js');
  assert.doesNotMatch(src, /rule`[^`]*\$\{\s*-?[\d.]/, 'a literal number inside a rule template');
  assert.equal(new Set(L.ROWS.map(r => r.id)).size, L.ROWS.length, 'row ids are unique');
  assert.ok(L.ROWS.every(r => L.GROUPS.some(([g]) => g === r.group)), 'every row sits in a group');
});

test('every export of the rule modules is shown by a row or listed as not shown, and every cited export exists', async () => {
  const cited = new Set(L.ROWS.flatMap(r => r.uses));
  for (const c of [...cited, ...Object.keys(L.NOT_SHOWN)]) { const [m, n] = c.split('.'); if (MODS.includes(m)) assert.ok(EXPORTS[m].includes(n), `legend cites ${c}, which the code no longer exports`); }
  const more = { logic: await import('../src/logic.js'), feed: await import('../src/feed.js'), transcript_view: await import('../src/transcript_view.js') };
  for (const c of cited) { const [m, n] = c.split('.'); if (m in more) assert.ok(n in /** @type {any} */ (more)[m], `legend cites ${c}, which the code no longer exports`); }
  for (const m of MODS) for (const n of EXPORTS[m]) assert.ok(cited.has(`${m}.${n}`) || `${m}.${n}` in L.NOT_SHOWN, `${m}.${n} is new or unexplained: add it to a legend row (uses) or to NOT_SHOWN`);
});

test('every hat, body colour, prop, tool and rest pose the sprite code has appears in the legend', () => {
  assert.deepEqual([...shown('hats')], HN);
  assert.deepEqual([...shown('bodies')], BODIES.map(b => b[2]));
  const frames = new Set([...shown('frames'), ...shown('props')]);
  for (const f of Object.keys(ART.props.frames)) assert.ok(frames.has(f), `props.txt frame ${f} has no legend row`);
  for (const t of Object.keys(TOOLS)) assert.ok(shown('tools').has(t), `tool ${t} has no legend row`);
  assert.deepEqual([...shown('props')].sort(), [...PROPS].sort());
  assert.ok(shown('frames').has('rock') && Object.keys(ART.rock.frames).length > 0);
});

test('every activity the rules can produce has a row', () => {
  const now = Date.now(), at = (/** @type {number} */ m) => ({ id: 'x', status: 'waiting', waitingSince: now - m * 60000 });
  const rests = new Set([A.SIT_MIN + 1, A.NAP_MIN + 1, 1e5].map(m => A.restOf(/** @type {any} */ (at(m)), now)));
  for (const r of rests) assert.ok(shown('rest').has(r), `rest pose ${r}`);
  assert.ok(A.staleOf(/** @type {any} */ (at(A.STALE_MIN + 1)), now) && shown('frames').has('blanket'), 'day-old wait under a blanket');
  const tools = new Set(['ran pytest', 'npm run build', 'thinking', ''].map(t => A.toolOf(/** @type {any} */ ({ last: t }))));
  for (const t of tools) assert.ok(shown('tools').has(t), `tool ${t}`);
  for (const p of new Set(['search the code', 'write the summary', 'move files'].map(A.propOf))) assert.ok(shown('props').has(p), `prop ${p}`);
  const kinds = new Set([{ starA: 1, L: 0, clear: true, dry: true }, { starA: 0, L: 1, clear: true, dry: true }].map(o => momentKind({ done: 1, now: 1e9, last: 0, still: false, ...o })));
  for (const k of kinds) assert.ok(shown('moments').has(k), `sky moment ${k}`);
});

test('every list badge and status pill the code draws has a row', () => {
  const all = [{ lastError: true, prOpened: 3, automated: true, behind: true, consistency: 'diverged' }, { also: ['desktop app'] }];
  for (const s of all) for (const [k] of badges(/** @type {any} */ ({ id: 'x', title: 't', ...s }))) assert.ok(shown('badges').has(k), `badge ${k} has no legend row`);
  for (const live of [true, false]) for (const ok of [true, false, null]) assert.ok(shown('modes').has(modeText(live, ok)), `pill ${modeText(live, ok)}`);
  const norm = (/** @type {string} */ t) => t.replace(/\(code -?\d+\)/, '(code N)'), ends = new Set([...shown('ends')].map(norm));
  for (const c of [-1, ...ENDED, 0, 1, 127, 255]) assert.ok(ends.has(norm(exitText(c))), `terminal end text for code ${c}: ${exitText(c)}`);
});

test('rules quoted from modules that do not export them still match the source', () => {
  for (const [k, q] of Object.entries(L.QUOTED)) {
    const m = q.re.exec(read(q.file)); assert.ok(m, `${k}: ${q.file} no longer matches ${q.re}`);
    const v = q.read === 'len' ? Function(`return ${m[1]}`)().length : Number(m[1]);
    assert.equal(v, q.value, `${k} in ${q.file} is now ${v}; the legend says ${q.value}`);
  }
});

test('every key the code handles has a Keys row', () => {
  const codes = new Set(L.KEYS.flatMap(k => k.codes)), found = new Set();
  for (const t of [keyAction.toString(), termLeave.toString()]) for (const m of t.matchAll(/k\.key === '([^']+)'/g)) found.add(m[1]);
  for (const f of ['terminal.js', 'drawer.js', 'stats.js', 'main.js', 'lists.js']) {
    const src = read('web/src/' + f);
    for (const m of src.matchAll(/\be\.key\s*[!=]==?\s*'([^']+)'/g)) found.add(m[1]);
    for (const m of src.matchAll(/\(\{ ([^}]*) \}\)\[e\.key\]/g)) for (const p of m[1].split(',')) found.add(p.split(':')[0].trim());
  }
  assert.ok(found.size >= 10, 'key scan found too little: ' + [...found]);
  for (const k of found) assert.ok(codes.has(k), `the code handles key ${k}, but the Keys table has no row for it`);
  for (const k of L.KEYS) for (const p of k.term || []) assert.equal(termLeave(p), k.to, `${JSON.stringify(p)} in the Terminal tab`);
});

test('every key on the Keys table is still handled by the code', () => {
  for (const k of L.KEYS) assert.match(read(k.src.file), k.src.re, `${k.keys.join('+')} (${k.where})`);
  assert.equal(keyAction({ key: '/' }, {}), 'search');
  assert.equal(keyAction({ key: 'j' }, {}), 'down');
  assert.equal(keyAction({ key: 'k' }, {}), 'up');
  assert.equal(keyAction({ key: 'ArrowDown' }, { onRow: true }), 'down');
  assert.equal(keyAction({ key: 'ArrowDown' }, { typing: true, search: true }), 'down');
  assert.equal(keyAction({ key: 'Escape' }, { typing: true, search: true, empty: true }), 'blur');
});

test('the page is static: base sheet linked, no outside requests but the fonts the main page uses', () => {
  const html = read('web/legend.html'), main = read('web/index.html');
  assert.match(html, /href="styles\/base\.css"/);
  for (const u of html.match(/https?:\/\/[^"' )]+/g) || []) assert.ok(main.includes(u), `outside request ${u}`);
  assert.doesNotMatch(read('web/src/legend.js'), /https?:|fetch\(|\/api\//);
});
