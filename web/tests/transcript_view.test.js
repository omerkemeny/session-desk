// Unit tests for transcript lines in src/transcript_view.js: event kinds, folds, change detection; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aroundMatch, drawnCount, findFrom, findLabel, findMatches, findSpans, findText, groupStart, mdText, segAt, findWords, firstChange, foldRuns, groupEnd, groupKind, groupWords, kindOf, lineHtml, quietResult, resultText, segHtml, segments, silentTool, startMatch, stepMatch, toolLabel, toolLine, toolName, viewLines } from '../src/transcript_view.js';

test('kinds of old and new event shapes', () => {
  assert.equal(kindOf(['you', 'hi']), 'you');
  assert.equal(kindOf(['you', '! ls -la']), 'bash');
  assert.equal(kindOf(['you', '[Image]']), 'image');
  assert.equal(kindOf(['claude', 'API Error: 500']), 'apierr');
  assert.equal(kindOf(['tool', 'Bash', 'ls', '', 0]), 'tool');
  for (const k of ['out', 'interrupt', 'compact', 'image', 'elsewhere']) assert.equal(kindOf([k]), k);
  assert.equal(kindOf(['someday-new', 'x']), '');
  assert.equal(kindOf(null), '');
});

test('lines read like the CLI', () => {
  const ev = [['you', '! git status'], ['out', ' M a.py', 0], ['you', 'look'], ['you', '[Image]'], ['you', '[Image]'], ['interrupt'], ['compact'], ['tool', 'mcp__slack__send', 'hi', 'ok', 0], ['someday-new']];
  assert.match(lineHtml(ev, 0), /class="ln you bash".*<span class="g">!<\/span><div class="txt">git status</);
  assert.match(lineHtml(ev, 1), /class="ln sub".*⎿.* M a\.py/);
  assert.match(lineHtml(ev, 3), /\[Image #1\]/);
  assert.match(lineHtml(ev, 4), /\[Image #2\]/);
  assert.match(lineHtml(ev, 5), /Interrupted · What should Claude do instead\?/);
  assert.match(lineHtml(ev, 6), /Conversation compacted/);
  assert.match(lineHtml(ev, 7), /<b>slack - send \(MCP\)<\/b>/);
  assert.equal(lineHtml(ev, 8), '');
  assert.equal(toolName('Read'), 'Read');
});

test('user text is escaped, never rendered as Markdown', () => {
  assert.match(lineHtml([['you', '<b>**x**</b>']], 0), /&lt;b&gt;\*\*x\*\*&lt;\/b&gt;/);
  assert.match(lineHtml([['tool', '<i>', '<x>', '<y>', 1]], 0), /&lt;i&gt;.*&lt;x&gt;.*&lt;y&gt;/);
});

test('segments: one per drawn line or fold, unknown kinds left out', () => {
  const t = ['tool', 'Read', 'a', '', 0], ev = [['you', 'q'], t, t, t, t, t, ['claude', 'done'], ['mystery'], ['interrupt']];
  const g = segments(ev, false);
  assert.deepEqual(g.map(x => [x.s, x.e, x.fold]), [[0, 1, false], [1, 6, true], [6, 7, false], [8, 9, false]]);
  assert.match(segHtml(ev, g[1], new Set([1])), /^<details class="fold" data-at="1" open>.*5 tool calls/);
  assert.equal(segments([['you', 'q'], t, t, t, t, t], true).length, 6);
});

test('firstChange finds the first differing event near the end', () => {
  const a = [['you', '1'], ['claude', '2'], ['tool', 'R', '', '', 0]];
  assert.equal(firstChange(a, [...a, ['claude', 'x']]), 3);
  assert.equal(firstChange(a, [a[0], a[1], ['tool', 'R', '', 'result', 0]]), 2);
  assert.equal(firstChange(a, [['you', 'other'], a[1], a[2]]), -1);
  const long = Array.from({ length: 1000 }, (_, i) => ['you', String(i)]);
  assert.equal(firstChange(long, [['you', 'x'], ...long.slice(1)]), -1);
  assert.equal(firstChange(long, long.slice(0, 990)), 990);
});

test('toolLabel prefers the display name the server sends, else the raw name', () => {
  assert.equal(toolLabel('Read'), 'Read');
  assert.equal(toolLabel('Read', ''), 'Read');
  assert.equal(toolLabel('Read', '  '), 'Read');
  assert.equal(toolLabel('Read', 42), 'Read');
  assert.equal(toolLabel('mcp__slack__send'), 'slack - send (MCP)');
  assert.equal(toolLabel('X', 'Shown name'), 'Shown name');
  assert.match(lineHtml([['tool', 'X', '', '', 0, 'Shown <name>']], 0), /<b>Shown &lt;name&gt;<\/b>/);
  assert.match(lineHtml([['tool', 'mcp__a__b', '', '', 0]], 0), /<b>a - b \(MCP\)<\/b>/);
  const run = Array.from({ length: 5 }, () => ['tool', 'X', '', '', 0, 'Shown']);
  assert.match(segHtml(run, { s: 0, e: 5, fold: true }, new Set()), /Shown ×5/);
});

test('copy buttons stay out of the Tab order; prompts and replies can take focus', () => {
  assert.match(lineHtml([['claude', 'hi']], 0), /class="ln claude" data-i="0" tabindex="-1".*class="cbtn"[^>]*tabindex="-1"/s);
  assert.match(lineHtml([['you', 'hi']], 0), /class="ln you" data-i="0" tabindex="-1"/);
  assert.doesNotMatch(lineHtml([['tool', 'Read', '', '', 0]], 0), /tabindex/);
});

test('toolLine splits the CLI line into name and arguments, else uses raw name and hint', () => {
  assert.deepEqual(toolLine('Edit', '/a.txt', 'Update(/a.txt)'), { name: 'Update', args: '(/a.txt)' });
  assert.deepEqual(toolLine('mcp__srv__do', 'q', 'srv - do (MCP)(query: "q")'), { name: 'srv - do (MCP)', args: '(query: "q")' });
  assert.deepEqual(toolLine('Bash', 'ls (x)', 'Bash(ls (x))'), { name: 'Bash', args: '(ls (x))' });
  assert.deepEqual(toolLine('Read', '/b.txt'), { name: 'Read', args: '(/b.txt)' });
  assert.deepEqual(toolLine('TodoWrite', '', ''), { name: 'TodoWrite', args: '' });
  assert.equal(toolLabel('Edit', 'Update(/a.txt)'), 'Update');
});

test('a call with an empty CLI line is not drawn and not counted; a failed one stays; an older server (5 items) still draws', () => {
  const todo = ['tool', 'TodoWrite', '', 'Todos updated', 0, ''], bad = ['tool', 'TodoWrite', '', 'bad input', 1, ''], old = ['tool', 'TodoWrite', '', '', 0];
  assert.equal(silentTool(todo), true);
  assert.equal(silentTool(bad), false);
  assert.equal(silentTool(old), false);
  assert.equal(kindOf(todo), '');
  assert.equal(lineHtml([todo], 0), '');
  assert.match(lineHtml([bad], 0), /<b>TodoWrite<\/b>.*Error: bad input/);
  assert.match(lineHtml([old], 0), /<b>TodoWrite<\/b>/);
  assert.equal(drawnCount([['you', 'q'], todo, bad, old]), 3);
  assert.deepEqual(segments([['you', 'q'], todo, ['claude', 'ok']], false).map(g => g.s), [0, 2]);
});

test('folds count drawn calls only: silent calls ride along but never make a fold or add to "N tool calls"', () => {
  const t = ['tool', 'Read', 'a', '', 0, 'Read(a)'], todo = ['tool', 'TodoWrite', '', '', 0, ''];
  assert.equal(foldRuns([t, t, t, t, todo, todo], 5).size, 0, 'four drawn calls plus two silent ones do not fold');
  assert.equal(segments([t, t, t, t, todo, todo], false).length, 4);
  const ev = [['you', 'q'], t, todo, t, t, t, t, ['claude', 'done']], g = segments(ev, false);
  assert.deepEqual(g.map(x => [x.s, x.e, x.fold]), [[0, 1, false], [1, 7, true], [7, 8, false]]);
  const h = segHtml(ev, g[1], new Set());
  assert.match(h, /<b>5 tool calls<\/b>/);
  assert.match(h, /Read ×5/);
  assert.doesNotMatch(h, /TodoWrite/);
  assert.equal(foldRuns([t, t, t, t, t], 5, true).size, 0, 'a live trailing run stays open');
});

test('an error result reads "Error: <text>" under the call, once, without the tool_use_error wrapper', () => {
  assert.equal(resultText(['tool', 'Bash', 'x', 'Exit code 1', 1, 'Bash(x)']), 'Error: Exit code 1');
  assert.equal(resultText(['tool', 'Edit', 'a', '<tool_use_error>File has not been read yet.</tool_use_error>', 1, 'Update(a)']), 'Error: File has not been read yet.');
  assert.equal(resultText(['tool', 'Bash', 'x', 'Error: already said', 1, 'Bash(x)']), 'Error: already said');
  assert.equal(resultText(['tool', 'Bash', 'x', '', 1, 'Bash(x)']), 'Error');
  assert.equal(resultText(['tool', 'Bash', 'x', '12 passed', 0, 'Bash(x)']), '12 passed');
  assert.match(lineHtml([['tool', 'Bash', 'x', 'Exit code 1', 1, 'Bash(x)']], 0), /class="ln tool err".*⎿<\/span><div class="txt">Error: Exit code 1</);
  assert.doesNotMatch(lineHtml([['tool', 'Read', 'a', '', 0, 'Read(a)']], 0), /⎿/);
});

test('command output arrives cut by the server and is drawn whole, never folded or cut again', () => {
  const long = Array.from({ length: 400 }, (_, i) => 'line ' + i).join('\n'), ev = [['you', '! seq 400'], ['out', long, 0], ['you', '! ls'], ['out', 'a\nb\nc\n… +9 lines', 0]];
  const h = lineHtml(ev, 1);
  assert.ok(h.includes('line 0\nline 1') && h.includes('line 399'));
  assert.match(lineHtml(ev, 3), /a\nb\nc\n… \+9 lines/);
  assert.deepEqual(segments(ev, false).map(g => g.fold), [false, false, false, false]);
});

test('compaction draws the two CLI lines without its key hints, as one part', () => {
  const h = lineHtml([['compact']], 0);
  assert.match(h, /^<div class="cmp" data-i="0">.*✻.*Conversation compacted<\/div>.*⏺.*Compact summary<\/div><\/div><\/div>$/);
  assert.doesNotMatch(h, /ctrl\+o/);
});

test('quiet tool results: the call line draws without its result block; errors and a missing 7th item still show the result', () => {
  const q = ['tool', 'Edit', 'a.txt', 'The file a.txt has been updated.', 0, 'Update(a.txt)', 1];
  assert.equal(quietResult(q), true);
  const h = lineHtml([q], 0);
  assert.match(h, /^<details class="xp" data-i="0" data-x="0"><summary class="ln tool">.*<b>Update<\/b>.*<\/summary><div class="ln res">.*has been updated/s, 'the hidden result sits in the closed line, shown only when it is expanded');
  assert.doesNotMatch(h, / open/);
  assert.match(lineHtml([q.slice(0, 6)], 0), /class="ln res".*has been updated/);
  assert.match(lineHtml([[...q.slice(0, 6), 0]], 0), /class="ln res"/);
  const bad = ['tool', 'Edit', 'a.txt', 'no such file', 1, 'Update(a.txt)', 1];
  assert.equal(quietResult(bad), false); assert.match(lineHtml([bad], 0), /Error: no such file/);
  assert.equal(kindOf(q), 'tool'); assert.equal(drawnCount([q]), 1);
});

test('compact draws its summary line only when the server says the CLI shows one', () => {
  assert.match(lineHtml([['compact', 1]], 0), /Compact summary/);
  assert.doesNotMatch(lineHtml([['compact', 0]], 0), /Compact summary/);
  assert.match(lineHtml([['compact', 0]], 0), /Conversation compacted/);
  assert.equal(quietResult(['tool', 'Read', '/a', 'text', 0, 'Read(/a)', 1]), true);
});

const sh = (c, out = 'ok', err = 0) => ['tool', 'Bash', c, out, err, `Bash(${c})`, err ? 0 : 1];
const rd = f => ['tool', 'Read', f, 'text', 0, `Read(${f})`, 1];
const gp = p => ['tool', 'Grep', p, 'hit', 0, `Search(pattern: "${p}")`, 1];

test('shell output follows the CLI: quiet like any other result, no stopgap', () => {
  assert.equal(quietResult(sh('ls', 'a.txt')), true);
  assert.equal(quietResult(sh('false', 'Exit code 1', 1)), false);
});

test('group words follow the CLI: fixed order search, read, ran; singular and plural; later parts lower case', () => {
  assert.equal(groupWords(['bash', 'bash', 'bash']), 'Ran 3 shell commands');
  assert.equal(groupWords(['bash']), 'Ran 1 shell command');
  assert.equal(groupWords(['read']), 'Read 1 file');
  assert.equal(groupWords(['read', 'search']), 'Searched for 1 pattern, read 1 file', 'screen case 15: Read then Grep');
  assert.equal(groupWords(['bash', 'search', 'search']), 'Searched for 2 patterns, ran 1 shell command', 'screen case 27: Bash, Grep, Glob');
  assert.equal(groupWords(['mcp:srv', 'mcp:srv']), 'Called srv 2 times', 'screens/mcp 60');
  assert.equal(groupWords(['mcp:alpha']), 'Called alpha', 'screens/mcp 57: no count for one call');
  assert.equal(groupWords(['mcp:alpha', 'mcp:beta']), 'Called alpha, beta 2 times', 'screens/mcp 56: servers joined, calls counted in all');
  assert.equal(groupWords(['read', 'mcp:alpha', 'bash']), 'Read 1 file, called alpha, ran 1 shell command', 'screens/mcp 58: called sits before ran');
  assert.equal(groupWords(['bash', 'bash', 'mcp:forge', 'bash']), 'Called forge, ran 3 shell commands', 'screens/mcp 16');
  assert.equal(groupKind(['tool', 'Glob', '*', '', 0, 'Search(pattern: "*")', 1]), 'search');
  assert.equal(groupKind(['tool', 'Edit', 'a', '', 0, 'Update(a)', 0]), '');
  assert.equal(groupKind(['tool', 'Bash', 'ls', 'x', 0, 'Bash(ls)']), '', 'an older server without the quiet item keeps one line per call');
  assert.equal(groupKind(['tool', 'TodoWrite', '', '', 0, '', 1]), '');
});

test('consecutive grouped calls draw as one group line; other calls end it, silent calls ride along', () => {
  const todo = ['tool', 'TodoWrite', '', '', 0, '', 1], ed = ['tool', 'Edit', 'a', 'Added 1 line', 0, 'Update(a)', 0];
  const ev = [['you', 'q'], sh('a'), rd('/x'), todo, gp('p'), ed, sh('b'), ['claude', 'done']];
  assert.equal(groupEnd(ev, 1), 5); assert.equal(groupEnd(ev, 5), 5); assert.equal(groupEnd(ev, 6), 7);
  const g = segments(ev, false);
  assert.deepEqual(g.map(x => [x.s, x.e, !!x.grp]), [[0, 1, false], [1, 5, true], [5, 6, false], [6, 7, true], [7, 8, false]]);
  const h = segHtml(ev, g[1], new Set());
  assert.match(h, /^<div class="grp" data-i="1"><details class="xp" data-x="1"><summary class="ln tool"><span class="g"><\/span><div class="txt">Searched for 1 pattern, read 1 file, ran 1 shell command<\/div><\/summary>/);
  assert.match(h, /<b>Bash<\/b><span class="dim">\(a\)<\/span><div class="ln res">.*ok/, 'expanded, each call shows its result');
  assert.match(segHtml(ev, g[1], new Set(), { xp: new Set([1]) }), /<details class="xp" data-x="1" open>/);
  assert.doesNotMatch(h, /TodoWrite/);
});

test('a failed call in a closed group shows nothing under the group line (screen case 54); expanded and in Details it shows its error', () => {
  const ev = [sh('a'), sh('false', 'Exit code 1', 1), sh('b')], g = segments(ev, false);
  assert.equal(g.length, 1);
  const h = segHtml(ev, g[0], new Set());
  assert.match(h, /Ran 3 shell commands/);
  assert.match(h, /<\/summary>.*Error: Exit code 1.*<\/details><\/div>$/s, 'the error sits only inside the expandable part');
  assert.match(segments(ev, false, true).map(x => segHtml(ev, x, new Set(), { detail: true })).join(''), /Error: Exit code 1/);
});

test('a branch marker between grouped calls rides along: one group line, the marker after it (screen case 15)', () => {
  const ev = [['you', 'q'], rd('/a'), ['elsewhere', 'desktop app', 1], gp('needle'), ['claude', 'done'], rd('/b'), ['elsewhere', 'desktop app', 2]];
  assert.equal(groupEnd(ev, 1), 4); assert.equal(groupEnd(ev, 5), 6, 'a marker after the last call is not part of the group');
  assert.deepEqual([1, 3, 5].map(i => groupStart(ev, i)), [true, false, true]);
  const g = segments(ev, false);
  assert.deepEqual(g.map(x => [x.s, x.e, !!x.grp]), [[0, 1, false], [1, 4, true], [4, 5, false], [5, 6, true], [6, 7, false]]);
  assert.match(segHtml(ev, g[1], new Set()), /<div class="txt">Searched for 1 pattern, read 1 file<\/div><\/summary>.*<\/details><div class="gnote"><div class="ln note other" data-i="2">/s);
  assert.equal(viewLines(ev, false), 6, 'you, group, marker, reply, group, marker');
  assert.equal(findFrom(ev, 3), 1, 'a change after the marker re-indexes from the group start');
  assert.match(findText(ev, 1), /^searched for 1 pattern, read 1 file\n/);
});

test('expandable lines: only hidden results with text expand; the open set keeps them open', () => {
  const ag = ['tool', 'Agent', 'Helper', 'Found three files.', 0, 'Agent(Helper)', 1];
  assert.match(lineHtml([ag], 0, { xp: new Set([0]) }), /^<details class="xp" data-i="0" data-x="0" open>/);
  assert.doesNotMatch(lineHtml([['tool', 'Agent', 'H', '', 0, 'Agent(H)', 1]], 0), /details/, 'nothing to show: a plain line');
  assert.doesNotMatch(lineHtml([['tool', 'Edit', 'a', 'Added 1 line', 0, 'Update(a)', 0]], 0), /details/, 'a shown result needs no expand');
});

test('detail view (the app\'s ctrl+o): every call on its own line with its result, nothing grouped', () => {
  const ev = [sh('a'), sh('b'), rd('/x'), ['tool', 'Agent', 'H', 'Done.', 0, 'Agent(H)', 1]];
  const g = segments(ev, false, true);
  assert.deepEqual(g.map(x => [x.s, x.e, !!x.grp, x.fold]), [[0, 1, false, false], [1, 2, false, false], [2, 3, false, false], [3, 4, false, false]]);
  const h = g.map(x => segHtml(ev, x, new Set(), { detail: true })).join('');
  assert.doesNotMatch(h, /details|Ran /);
  assert.equal((h.match(/class="ln res"/g) || []).length, 4);
});

test('folds count a group line once: five shell calls are one group line, not a fold', () => {
  assert.equal(foldRuns([sh('a'), sh('b'), sh('c'), sh('d'), sh('e')], 5).size, 0);
  assert.equal(foldRuns([sh('a'), sh('b'), sh('c'), sh('d'), sh('e')], 5, false, true).size, 1, 'detail view counts calls');
  const ed = n => ['tool', 'Edit', n, 'Added 1 line', 0, `Update(${n})`, 0];
  const ev = [ed('a'), sh('x'), ed('b'), rd('/r'), ed('c'), ed('d')], f = foldRuns(ev, 5);
  assert.deepEqual([...f], [[0, 6]]);
  const h = segHtml(ev, segments(ev, false)[0], new Set());
  assert.match(h, /<b>6 tool calls<\/b>/); assert.match(h, /Ran 1 shell command/); assert.match(h, /Read 1 file/);
});

test('hostile text in a group or an expanded result is escaped', () => {
  const ev = [['tool', 'Bash', '<img>', '<script>x</script>', 0, 'Bash(<img>)', 1], ['tool', 'mcp__<b>__t', '', 'r', 0, 'x', 1]];
  const h = segHtml(ev, segments(ev, false)[0], new Set());
  assert.doesNotMatch(h, /<img>|<script>|<b>__/); assert.match(h, /&lt;script&gt;/); assert.match(h, /Called &lt;b&gt;, ran 1 shell command/);
});

// Find in a session: what is searched, how words match, where stepping starts and goes.
const FIND_EV = [
  ['you', 'Fix the Login bug'],
  ['tool', 'Read', 'a.py', 'def login(): pass', 0, 'Read(a.py)', 1],
  ['tool', 'TodoWrite', '', 'todos updated', 0, '', 1],
  ['tool', 'Bash', 'pytest', 'secret word in hidden output', 0, 'Bash(pytest)', 1],
  ['claude', 'The **login** bug is fixed.'],
  ['tool', 'Edit', 'a.py', '<tool_use_error>String not found</tool_use_error>', 1, 'Update(a.py)', 0],
  ['compact', 1],
  ['you', '[Image]'],
];
test('find text: every drawn event with its hidden result, lower case; silent calls are not searchable', () => {
  const t = FIND_EV.map((_, i) => findText(FIND_EV, i));
  assert.equal(t[0], 'fix the login bug');
  assert.equal(t[1], 'read 1 file, ran 1 shell command\nread(a.py)\ndef login(): pass', 'the group line\'s words belong to its first call');
  assert.equal(findText(FIND_EV, 1, true), 'read(a.py)\ndef login(): pass', 'Details draws no group line');
  assert.equal(findText(FIND_EV, 3), 'bash(pytest)\nsecret word in hidden output', 'a later call of the group has only its own words');
  assert.equal(t[2], '', 'a silent call is never drawn, so never found');
  assert.match(t[3], /secret word in hidden output/);
  assert.equal(t[5], 'update(a.py)\nerror: string not found');
  assert.equal(t[6], 'conversation compacted\ncompact summary');
  assert.equal(t[7], '[image #1]');
  assert.equal(findText([['tool', 'mcp__srv__get', 'x', 'ok', 0, '', 1]], 0), '', 'silent MCP call');
  assert.equal(findText([['mystery', 'x']], 0), '');
});
test('find words: case-insensitive plain text, several words all in the same event, any order', () => {
  assert.deepEqual(findWords('  Login   BUG login '), ['login', 'bug']);
  assert.deepEqual(findWords(''), []);
  const t = FIND_EV.map((_, i) => findText(FIND_EV, i));
  assert.deepEqual(findMatches(t, findWords('LOGIN')), [0, 1, 4]);
  assert.deepEqual(findMatches(t, findWords('bug login')), [0, 4]);
  assert.deepEqual(findMatches(t, findWords('login secret')), [], 'words in different events do not match');
  assert.deepEqual(findMatches(t, findWords('secret')), [3], 'a hidden result is searched');
  assert.deepEqual(findMatches(t, findWords('**login**')), [4], 'plain text: Markdown signs are not patterns');
  assert.deepEqual(findMatches(t, findWords('.*')), [], 'no regular expressions');
  assert.deepEqual(findMatches(t, []), []);
});
test('find text: group line words, reply text as drawn, where an update must re-index', () => {
  const t = FIND_EV.map((_, i) => findText(FIND_EV, i));
  assert.deepEqual(findMatches(t, findWords('ran 1 shell')), [1], 'a person can look for the words a group line shows');
  assert.deepEqual([0, 1, 2, 3, 4].map(i => groupStart(FIND_EV, i)), [false, true, false, false, false]);
  const md = [['claude', '**re**try and [the docs](https://x.io/a) and `co`de']];
  assert.equal(mdText(md[0][1]), 'retry and the docs and code');
  assert.deepEqual(findMatches([findText(md, 0)], findWords('retry')), [0], 'a word split by bold marks is found as shown');
  assert.deepEqual(findMatches([findText(md, 0)], findWords('code')), [0], 'and by inline code');
  assert.deepEqual(findMatches([findText(md, 0)], findWords('x.io')), [0], 'a link address is still found (the line is marked)');
  assert.equal(findText([['claude', 'plain words']], 0), 'plain words', 'no Markdown signs: one copy');
  assert.equal(mdText('```\na < b\n```'), 'a < b', 'code blocks: copy button left out, entities read back');
  assert.equal(findFrom(FIND_EV, 4), 1, 'a change at the end of a tool run re-indexes from its first call');
  assert.equal(findFrom(FIND_EV, 5), 5);
  assert.equal(findFrom(FIND_EV, 0), 0);
});
test('find spans: words across Markdown marks map to the drawn text nodes; missing words are named', () => {
  const parts = [{ t: '**' }, { t: 'Re' }, { t: 'try' }, { t: ' now' }, { t: 'next', br: true }];
  assert.deepEqual(findSpans(parts.slice(1), ['retry']), { spans: [[0, 0, 1, 3]], missing: [] }, 'one word over two nodes');
  assert.deepEqual(findSpans(parts, ['wnext']).missing, ['wnext'], 'no word runs across a block');
  assert.deepEqual(findSpans(parts, ['**retry']).spans, [[0, 0, 2, 3]]);
  assert.deepEqual(findSpans([{ t: 'ab' }, { t: '' }, { t: 'cd' }], ['bc']).spans, [[0, 1, 2, 1]], 'empty nodes are skipped over');
  assert.deepEqual(findSpans([{ t: 'İx' }, { t: 'x' }], ['x']).spans, [[1, 0, 1, 1]], 'a node whose lower case changes length is not marked');
  assert.deepEqual(findSpans([{ t: 'aaa' }], ['a'], 2).spans.length, 2, 'at most max spans');
});
test('far matches: the window around a match never reaches the newest part', () => {
  const segs = Array.from({ length: 1000 }, (_, i) => ({ s: i * 2, e: i * 2 + 2, fold: false }));
  assert.equal(segAt(segs, 0), 0); assert.equal(segAt(segs, 5), 2); assert.equal(segAt(segs, 1999), 999); assert.equal(segAt(segs, 5000), 1000);
  assert.deepEqual(aroundMatch(segs, 500, 900, 100), [200, 300], '100 events either side');
  assert.deepEqual(aroundMatch(segs, 1750, 900, 100), [825, 900], 'cut at the newest part: they are one');
  assert.deepEqual(aroundMatch(segs, 3, 900, 100), [0, 51]);
});
test('find stepping: start at the last match at or before the anchor, wrap at both ends', () => {
  const hits = [3, 10, 40];
  assert.equal(startMatch(hits, 50), 2, 'at the bottom: the newest match');
  assert.equal(startMatch(hits, 10), 1, 'the previous match is kept while it still matches');
  assert.equal(startMatch(hits, 12), 1);
  assert.equal(startMatch(hits, 1), 0, 'nothing above: the first match below');
  assert.equal(startMatch([], 5), -1);
  assert.equal(stepMatch(2, 3, 1), 0, 'Enter after the last wraps to the first');
  assert.equal(stepMatch(0, 3, -1), 2, 'Shift+Enter before the first wraps to the last');
  assert.equal(stepMatch(1, 3, 1), 2);
  assert.equal(stepMatch(-1, 3, 1), 0); assert.equal(stepMatch(-1, 3, -1), 2);
  assert.equal(stepMatch(0, 0, 1), -1);
  assert.equal(findLabel(2, 17, 'x'), '3 of 17');
  assert.equal(findLabel(0, 20000, 'x'), '1 of 20,000');
  assert.equal(findLabel(-1, 0, 'x'), 'No match');
  assert.equal(findLabel(-1, 0, '  '), '');
});
test('find is fast on 20,000 events: index and a one-letter search', () => {
  const ev = [];
  for (let i = 0; i < 20000; i++) ev.push(i % 4 === 0 ? ['you', `prompt ${i} about item ${i % 97}`] : i % 4 === 1 ? ['claude', `reply ${i} `.repeat(20)] : ['tool', 'Bash', 'ls', `out ${i}\n`.repeat(30), 0, 'Bash(ls)', 1]);
  let t0 = performance.now(); const texts = ev.map((_, i) => findText(ev, i)); const index = performance.now() - t0;
  t0 = performance.now(); const a = findMatches(texts, findWords('e')); const one = performance.now() - t0;
  t0 = performance.now(); const b = findMatches(texts, findWords('item 42')); const two = performance.now() - t0;
  assert.ok(a.length > 5000 && b.length > 0);
  assert.ok(index < 400 && one < 40 && two < 40, JSON.stringify({ index, one, two }));
});
test('line counts follow the view: a group line once, errors hidden inside it; Details one line per drawn event', () => {
  assert.equal(viewLines(FIND_EV, true), drawnCount(FIND_EV));
  assert.equal(drawnCount(FIND_EV), 7);
  // grouped: you, group(Read+silent+Bash) = 1, claude, Update, compact, image
  assert.equal(viewLines(FIND_EV, false), 6);
  const err = [['tool', 'Read', 'a', 'x', 0, 'Read(a)', 1], ['tool', 'Read', 'b', 'gone', 1, 'Read(b)', 0]];
  assert.equal(viewLines(err, false), 1, 'only the group line: the failed call shows when it is expanded');
  assert.equal(viewLines([], false), 0);
});
