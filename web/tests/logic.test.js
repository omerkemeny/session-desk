// Unit tests for the pure page rules in src/logic.js; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/logic.js';
import { BODIES, HN } from '../src/sprites.js';

const N = HN.length * BODIES.length;
/** Minimal session for the rules under test. */
const ses = (id, status = 'waiting', more = {}) => ({ id, title: 'T ' + id, project: 'p', status, updated: 0, ...more });
const ids = n => Array.from({ length: n }, (_, i) => 'sess-' + String(i).padStart(3, '0'));

test('lookOf maps a stored number to hat and colour, and falls back to the id hash', () => {
  assert.deepEqual(L.lookOf({ a: 0 }, 'a'), { hat: HN[0], c: 0 });
  assert.deepEqual(L.lookOf({ a: HN.length + 2 }, 'a'), { hat: HN[2], c: 1 });
  const fresh = L.lookOf({}, 'never-seen');
  assert.ok(HN.includes(fresh.hat) && fresh.c >= 0 && fresh.c < BODIES.length);
  assert.deepEqual(L.lookOf({}, 'never-seen'), fresh, 'same id, same look');
});

test('assignLooks gives every active session its own look', () => {
  const looks = {}, S = ids(30).map(id => ses(id));
  assert.equal(L.assignLooks(looks, S), true);
  const nums = S.map(s => looks[s.id]);
  assert.equal(new Set(nums).size, 30);
  for (const n of nums) assert.ok(Number.isInteger(n) && n >= 0 && n < N);
});

test('assignLooks spreads hats first, then colours', () => {
  const looks = {}, S = ids(HN.length).map(id => ses(id));
  L.assignLooks(looks, S);
  const got = S.map(s => L.lookOf(looks, s.id));
  assert.equal(new Set(got.map(l => l.hat)).size, HN.length, 'no hat twice while hats are free');
  assert.equal(new Set(got.map(l => l.c)).size, BODIES.length, 'every colour in use');
});

test('assignLooks keeps existing looks when sessions come and go', () => {
  const looks = {}, first = ids(6).map(id => ses(id));
  L.assignLooks(looks, first);
  const before = { ...looks };
  const next = [...first.slice(2), ses('new-1'), ses('new-2'), ses('new-3')];
  assert.equal(L.assignLooks(looks, next), true);
  for (const s of first) assert.equal(looks[s.id], before[s.id], 'kept ' + s.id);
  assert.equal(new Set(next.map(s => looks[s.id])).size, next.length);
  assert.equal(L.assignLooks(looks, next), false, 'nothing new to save');
});

test('assignLooks skips finished sessions and resolves clashes by id order', () => {
  const looks = { a: 5, b: 5, z: 7 };
  L.assignLooks(looks, [ses('b'), ses('a'), ses('z', 'done'), ses('y')]);
  assert.equal(looks.a, 5, 'first id keeps the clashing look');
  assert.notEqual(looks.b, 5);
  assert.equal(looks.z, 7, 'done session untouched');
  assert.ok(looks.y !== undefined);
  assert.equal(new Set([looks.a, looks.b, looks.y]).size, 3);
});

test('assignLooks survives more sessions than there are looks', () => {
  const looks = {}, S = ids(N + 20).map(id => ses(id));
  assert.doesNotThrow(() => L.assignLooks(looks, S));
  const nums = S.map(s => looks[s.id]);
  for (const n of nums) assert.ok(Number.isInteger(n) && n >= 0 && n < N);
  assert.equal(new Set(nums).size, N, 'every look used once the set is full');
});

test('isAirflow spots Airflow work in title, topic, ask or last line', () => {
  for (const t of ['Rerun the Airflow job', 'fix the DAG', 'two dags broke', 'rename dag_id', 'edit a3_dags/mgms.py', 'Backfill March', 'scheduler is stuck', 'clear the task instance'])
    assert.equal(L.isAirflow(ses('x', 'waiting', { title: t })), true, t);
  assert.equal(L.isAirflow(ses('x', 'waiting', { title: 'x', topic: 'please BACKFILL it' })), true);
  assert.equal(L.isAirflow(ses('x', 'waiting', { title: 'x', ask: 'clear the DAG run?' })), true);
  assert.equal(L.isAirflow(ses('x', 'waiting', { title: 'x', last: 'airflow import check passed' })), true);
  for (const t of ['Fix the dagger animation', 'sandbag the estimate', 'Fix flaky checkout test', 'airport lounge'])
    assert.equal(L.isAirflow(ses('x', 'waiting', { title: t })), false, t);
});

test('pickSlot puts Airflow sessions at the pond and others in the meadow, then anywhere', () => {
  const pond = L.FISH.length, all = L.SLOTS.length;
  assert.equal(L.pickSlot(new Set(), true), 0);
  assert.equal(L.pickSlot(new Set(), false), pond);
  const meadowFull = new Set(Array.from({ length: all - pond }, (_, i) => pond + i));
  assert.equal(L.pickSlot(meadowFull, false), 0, 'falls back to the pond');
  const pondFull = new Set(Array.from({ length: pond }, (_, i) => i));
  assert.equal(L.pickSlot(pondFull, true), pond, 'falls back to the meadow');
  assert.equal(L.pickSlot(new Set(L.SLOTS.map((_, i) => i)), true), -1);
});

test('md escapes HTML and renders code, bold and links', () => {
  assert.equal(L.md('<script>alert("x")</script> & co'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co');
  assert.equal(L.md('run `ls -la`'), 'run <code>ls -la</code>');
  assert.equal(L.md('**done**'), '<b>done</b>');
  assert.equal(L.md('```sh\necho <b>\n```'), '<pre><code>echo &lt;b&gt;\n</code></pre>');
  assert.equal(L.md('see [docs](https://ex.com/a)'), 'see <a href="https://ex.com/a" target="_blank" rel="noopener">docs</a>');
  assert.equal(L.md('at https://ex.com/x.'), 'at <a href="https://ex.com/x." target="_blank" rel="noopener">https://ex.com/x.</a>');
  assert.equal(L.md('(https://ex.com)'), '(<a href="https://ex.com" target="_blank" rel="noopener">https://ex.com</a>)');
});

test('md never links unsafe schemes and keeps quotes out of attributes', () => {
  assert.equal(L.md('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(L.md('go https://ex.com/"onmouseover="x'), 'go <a href="https://ex.com/&quot;onmouseover=&quot;x" target="_blank" rel="noopener">https://ex.com/&quot;onmouseover=&quot;x</a>');
  assert.ok(!L.md('[<img src=x>](https://ex.com)').includes('<img'));
});

/** Deepest anchor nesting in a string of markup. */
const maxDepth = h => { let d = 0, m = 0; for (const [t] of h.matchAll(/<\/?a[ >]/g)) { d += t[1] === '/' ? -1 : 1; m = Math.max(m, d); } return m; };

test('md leaves inline code and fenced code literal', () => {
  assert.equal(L.md('`**x** [a](https://ex.com) https://ex.com`'), '<code>**x** [a](https://ex.com) https://ex.com</code>');
  assert.equal(L.md('```\n**x** https://ex.com <i>\n```'), '<pre><code>**x** https://ex.com &lt;i&gt;\n</code></pre>');
  assert.equal(L.md('**a** `**b**` **c**'), '<b>a</b> <code>**b**</code> <b>c</b>');
});

test('md never nests anchors and keeps bold and code inside link text', () => {
  const a = (u, t) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`;
  assert.equal(L.md('[see https://a.com/x](https://b.com)'), a('https://b.com', 'see https://a.com/x'));
  assert.equal(L.md('[**big** `c`](https://b.com)'), a('https://b.com', '<b>big</b> <code>c</code>'));
  assert.equal(L.md('**see https://a.com**'), '<b>see ' + a('https://a.com', 'https://a.com') + '</b>');
  assert.equal(L.md('[x](https://a.com) and https://b.com'), a('https://a.com', 'x') + ' and ' + a('https://b.com', 'https://b.com'));
  for (const t of ['[https://a.com](https://b.com)', '[a [https://c.com](https://d.com)](https://b.com)', '[x](https://a.com/**b**)'])
    assert.ok(maxDepth(L.md(t)) <= 1 && !/href="[^"]*</.test(L.md(t)), t + ' -> ' + L.md(t));
  assert.equal(L.md('[x](ftp://a.com) ftp://a.com'), '[x](ftp://a.com) ftp://a.com');
  assert.equal(L.md('a \uE0000\uE001 b'), 'a 0 b');
});

test('flat expands tool summaries into one line per tool and passes other lines through', () => {
  const tl = [['you', 'hi'], ['tools', 'Read 2 files', ['Read a.ts', 'Grep "x y" · 3 matches', 'Bash']], ['claude', 'done']];
  assert.deepEqual(L.flat(tl), [['you', 'hi'], ['tool', 'Read', 'a.ts', '', 0], ['tool', 'Grep', '"x y" · 3 matches', '', 0], ['tool', 'Bash', '', '', 0], ['claude', 'done']]);
  assert.deepEqual(L.flat(undefined), []);
  assert.deepEqual(L.flat([['tools', 'nothing']]), []);
});

test('status grouping: waiting needs you until sent home for that status change', () => {
  const home = new Set();
  const w = ses('a', 'waiting', { statusAt: 100 });
  assert.equal(L.sentKey(w), 'a:100');
  assert.equal(L.sentKey(ses('b')), 'b:0');
  assert.equal(L.needsYou(w, home), true);
  assert.equal(L.group(w, home), 'waiting');
  home.add(L.sentKey(w));
  assert.equal(L.needsYou(w, home), false);
  assert.equal(L.asleep(w, home), true);
  assert.equal(L.group(w, home), 'resting', 'sent home rests');
  const again = { ...w, statusAt: 200 };
  assert.equal(L.needsYou(again, home), true, 'a new question wakes it');
  assert.equal(L.group(ses('r', 'running'), home), 'running');
  assert.equal(L.group(ses('d', 'done'), home), 'resting');
  assert.equal(L.asleep(ses('d', 'done', { statusAt: 100 }), new Set(['d:100'])), false);
  assert.deepEqual(Object.keys(L.LABEL), ['waiting', 'running', 'resting']);
});

test('phase switches at sunrise-40, sunrise+50, sunset-50 and sunset+40', () => {
  const w = { code: 0, cloud: 0, temp: null, sr: 360, ss: 1080, ok: false };
  const cases = [[0, 'night'], [319, 'night'], [320, 'dawn'], [409, 'dawn'], [410, 'day'], [720, 'day'], [1030, 'day'], [1031, 'dusk'], [1120, 'dusk'], [1121, 'night'], [1439, 'night']];
  for (const [t, want] of cases) assert.equal(L.phase(t, w), want, 'minute ' + t);
  assert.equal(L.phase(400, { ...w, sr: 300 }), 'day', 'follows the given sunrise');
});

test('weather names and wet or snowy codes', () => {
  assert.deepEqual([0, 1, 2, 3, 45, 51, 61, 71, 80, 85, 95].map(L.wxName), ['Clear', 'Mostly clear', 'Partly cloudy', 'Overcast', 'Fog', 'Drizzle', 'Rain', 'Snow', 'Showers', 'Snow showers', 'Thunderstorm']);
  assert.deepEqual([71, 77, 85, 86, 70, 78, 61].map(L.isSnow), [true, true, true, true, false, false, false]);
  assert.deepEqual([51, 67, 80, 82, 95, 99, 50, 71, 83].map(L.isWet), [true, true, true, true, true, true, false, false, false]);
});

test('sayPeek keeps one line of at most 70 characters', () => {
  assert.equal(L.sayPeek('  a\n\n b\tc  '), 'a b c');
  assert.equal(L.sayPeek(null), '');
  const seventy = 'x'.repeat(70);
  assert.equal(L.sayPeek(seventy), seventy);
  const long = 'word '.repeat(30);
  assert.equal(L.sayPeek(long), 'word '.repeat(14).slice(0, 68).trimEnd() + '…');
});

test('sayHtml escapes the title, the request and the reply', () => {
  assert.equal(L.sayHtml(ses('a', 'waiting', { title: '<b>x</b>', topic: 'do "it"' }), 'a < b'), '<b>&lt;b&gt;x&lt;/b&gt;</b><u>You: do &quot;it&quot;</u>a &lt; b');
  assert.equal(L.sayHtml(ses('a', 'waiting', { title: 't' })), '<b>t</b>');
});

test('syncHtml says where else the session is open and offers a reload when behind', () => {
  assert.equal(L.syncHtml(ses('a')), '');
  const h = L.syncHtml(ses('a', 'waiting', { also: ['desktop app', '<term>'], behind: true }));
  assert.ok(h.includes('Open in 2 places (desktop app, &lt;term&gt;).'), h);
  assert.ok(h.includes('data-act="reterm"'));
});

test('statistics formatters', () => {
  assert.deepEqual([0, 999, 1000, 999499, 1.2e6, 2.5e9].map(L.usB), ['0', '999', '1k', '999k', '1.2M', '2.5B']);
  assert.equal(L.usInt(1234567.4), '1,234,567');
  assert.deepEqual([0, 59, 60, 61, 3599, 3600, 3661, 7200].map(L.usDur), ['0 s', '59 s', '1 min', '1 min 1 s', '59 min 59 s', '1 h', '1 h 1 min', '2 h']);
  assert.match(L.usDay('2026-11-11'), /^Wed,? 11 Nov$/);
  assert.equal(L.usTop([1, 5, 5, 2]), 1);
  assert.equal(L.usTop([]), 0);
});

test('matches needs every word, in any order and any searched field', () => {
  const s = ses('a', 'running', { title: 'Fix flaky checkout test', project: 'storefront-web', branch: 'fix/flake', topic: 'look at CI', last: 'Editing spec' });
  assert.ok(L.matches(s, ''));
  assert.ok(L.matches(s, '  '));
  assert.ok(L.matches(s, 'checkout STOREFRONT'));
  assert.ok(L.matches(s, 'ci spec fix/flake'));
  assert.ok(!L.matches(s, 'checkout billing'));
  assert.ok(L.matches({ ...s, branch: undefined, last: undefined }, 'flaky'), 'missing fields are skipped');
});

test('markHits wraps every hit, escapes the rest, and merges overlapping words', () => {
  assert.equal(L.markHits('a <b> & c', ''), 'a &lt;b&gt; &amp; c');
  assert.equal(L.markHits('Fix flaky test', 'fla'), 'Fix <mark>fla</mark>ky test');
  assert.equal(L.markHits('Test the tests', 'TEST'), '<mark>Test</mark> the <mark>test</mark>s');
  assert.equal(L.markHits('checkout', 'check out'), '<mark>checkout</mark>');
  assert.equal(L.markHits('<b>', 'b'), '&lt;<mark>b</mark>&gt;', 'markup in the text never becomes tags');
  assert.equal(L.markHits(undefined, 'x'), '');
});

test('keyAction maps list keys and stays out of the way while typing or with an overlay open', () => {
  assert.equal(L.keyAction({ key: '/' }, {}), 'search');
  assert.equal(L.keyAction({ key: 'j' }, {}), 'down');
  assert.equal(L.keyAction({ key: 'k' }, {}), 'up');
  assert.equal(L.keyAction({ key: 'ArrowDown' }, {}), '', 'arrows scroll the page unless a row has focus');
  assert.equal(L.keyAction({ key: 'ArrowDown' }, { onRow: true }), 'down');
  assert.equal(L.keyAction({ key: 'ArrowUp' }, { onRow: true }), 'up');
  assert.equal(L.keyAction({ key: '/' }, { typing: true }), '');
  assert.equal(L.keyAction({ key: 'j' }, { typing: true, search: true }), '');
  assert.equal(L.keyAction({ key: 'ArrowDown' }, { typing: true, search: true }), 'down');
  assert.equal(L.keyAction({ key: 'ArrowDown' }, { typing: true }), '');
  assert.equal(L.keyAction({ key: 'Escape' }, { typing: true, search: true, empty: true }), 'blur');
  assert.equal(L.keyAction({ key: 'Escape' }, { typing: true, search: true }), '', 'Esc first clears the text (browser default)');
  assert.equal(L.keyAction({ key: '/' }, { overlay: true }), '');
  assert.equal(L.keyAction({ key: 'j', meta: true }, {}), '');
  assert.equal(L.keyAction({ key: 'x' }, {}), '');
});

test('toolRuns folds long runs of tool calls only, and keeps a live trailing run open', () => {
  const t = ['tool', 'Read', '', '', 0], you = ['you', 'hi'], me = ['claude', 'ok'];
  const ev = [you, t, t, t, t, t, me, t, t, me, t, t, t, t, t];
  assert.deepEqual([...L.toolRuns(ev)], [[1, 6], [10, 15]]);
  assert.deepEqual([...L.toolRuns(ev, 5, true)], [[1, 6]], 'the run still growing at the end stays unfolded');
  assert.deepEqual([...L.toolRuns(ev, 2)], [[1, 6], [7, 9], [10, 15]]);
  assert.deepEqual([...L.toolRuns([])], []);
  assert.deepEqual([...L.toolRuns([t, t, t, t])], [], 'four calls stay as lines');
});

test('toolSummary counts repeats in order of first use', () => {
  assert.equal(L.toolSummary(['Read', 'Grep', 'Read', 'Bash', 'Read']), 'Read ×3, Grep, Bash');
  assert.equal(L.toolSummary([]), '');
});
