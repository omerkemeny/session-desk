// Unit tests for the list-row rules in src/logic.js: plain previews, badges, header counts, garden overflow; run with: node --test web/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/logic.js';

const ses = (id, status = 'done', more = {}) => ({ id, title: 'T ' + id, project: 'p', status, updated: 0, ...more });

test('plain drops Markdown marks and keeps the words on one line', () => {
  assert.equal(L.plain('**Server up.** http://127.0.0.1:8790/ ready'), 'Server up. http://127.0.0.1:8790/ ready');
  assert.equal(L.plain('# Done\n\n- item `one`\n- [x] two\n1. three'), 'Done item one two three');
  assert.equal(L.plain('```py\nprint(1)\n```\nSee [the PR](https://x.example/1).'), 'print(1) See the PR.');
  assert.equal(L.plain('> quoted __bold__ ~~old~~ and *soft*'), 'quoted bold old and soft');
  assert.equal(L.plain('| a | b |\n|---|:---:|\n| 1 | 2 |'), 'a · b 1 · 2');
  assert.equal(L.plain('---'), '');
});

test('plain leaves snake_case, globs, arithmetic and slash commands alone', () => {
  assert.equal(L.plain('a3_dags/daily_user_snapshot.py'), 'a3_dags/daily_user_snapshot.py');
  assert.equal(L.plain('src/*.js and 2 * 3 * 4'), 'src/*.js and 2 * 3 * 4');
  assert.equal(L.plain('/remember the session'), '/remember the session');
  assert.equal(L.plain(null), '');
  assert.equal(L.plain(42), '42');
});

test('isAuto only for headless; a missing kind is interactive', () => {
  assert.equal(L.isAuto(ses('a', 'done', { kind: 'headless' })), true);
  assert.equal(L.isAuto(ses('b', 'done', { kind: 'interactive' })), false);
  assert.equal(L.isAuto(ses('c')), false);
});

test('badges: missing fields mean off', () => {
  assert.deepEqual(L.badges(ses('a')), []);
  assert.deepEqual(L.badges(ses('a', 'done', { also: [], behind: false, lastError: false, prOpened: 0, consistency: 'ok' })), []);
});

test('badges: each field gives one quiet badge with a tooltip', () => {
  const kinds = s => L.badges(s).map(b => b[0] + ':' + b[1]);
  assert.deepEqual(kinds(ses('a', 'done', { lastError: true })), ['err:']);
  assert.deepEqual(kinds(ses('a', 'done', { prOpened: 1 })), ['pr:PR']);
  assert.deepEqual(kinds(ses('a', 'done', { prOpened: 3 })), ['pr:PR 3']);
  assert.deepEqual(kinds(ses('a', 'done', { kind: 'headless' })), ['auto:auto']);
  assert.deepEqual(kinds(ses('a', 'done', { also: ['desktop app'] })), ['also:open twice']);
  assert.deepEqual(kinds(ses('a', 'done', { consistency: 'diverged' })), ['diverged:diverged']);
  assert.deepEqual(kinds(ses('a', 'done', { consistency: { state: 'diverged' } })), ['diverged:diverged']);
  for (const [, , tip] of L.badges(ses('a', 'done', { lastError: true, prOpened: 2, kind: 'headless', also: ['x'], consistency: 'forked' }))) assert.ok(tip.length > 10);
});

test('badges: behind folds the open-twice note into one badge', () => {
  const b = L.badges(ses('a', 'running', { also: ['desktop app'], behind: true }));
  assert.equal(b.length, 1);
  assert.equal(b[0][0], 'behind');
  assert.match(b[0][2], /Also open in desktop app/);
});

test('tally counts with the list rules: automated resting runs apart, need-you as the garden counts', () => {
  const S = [ses('w1', 'waiting', { tokens: 5 }), ses('w2', 'waiting', { statusAt: 7 }), ses('r1', 'running', { kind: 'headless' }),
    ses('d1'), ses('d2', 'done', { kind: 'headless', tokens: 10 }), ses('d3', 'done', { kind: 'headless' })];
  const home = new Set([L.sentKey(S[1])]);
  assert.deepEqual(L.tally(S, home), { need: 1, working: 1, resting: 2, auto: 2, tokens: 15 });
  assert.equal(L.tally(S, home).need, S.filter(s => L.needsYou(s, home)).length, 'same rule as the garden');
});

test('gardenOverflow lists sessions that need you without a character, newest first', () => {
  const S = [ses('a', 'waiting', { updated: 1 }), ses('b', 'waiting', { updated: 3 }), ses('c', 'waiting', { updated: 2 }), ses('d', 'running')];
  assert.deepEqual(L.gardenOverflow(S, new Set(), new Set(['a'])).map(s => s.id), ['b', 'c']);
  assert.deepEqual(L.gardenOverflow(S, new Set([L.sentKey(S[1])]), new Map([['a', 1]])).map(s => s.id), ['c']);
  assert.deepEqual(L.gardenOverflow(S, new Set(), new Set(['a', 'b', 'c'])), []);
});

test('waitedFor: only for waiting sessions with a known start', () => {
  const now = 10 * 86400000;
  assert.equal(L.waitedFor(ses('a', 'waiting', { waitingSince: now - 20000 }), now), 'under a minute');
  assert.equal(L.waitedFor(ses('a', 'waiting', { waitingSince: now - 12 * 60000 }), now), '12 min');
  assert.equal(L.waitedFor(ses('a', 'waiting', { waitingSince: now - 125 * 60000 }), now), '2 h 5 min');
  assert.equal(L.waitedFor(ses('a', 'waiting', { waitingSince: now - 120 * 60000 }), now), '2 h');
  assert.equal(L.waitedFor(ses('a', 'waiting', { waitingSince: now - 3 * 86400000 }), now), '3 d');
  assert.equal(L.waitedFor(ses('a', 'waiting', { waitingSince: 0 }), now), '');
  assert.equal(L.waitedFor(ses('a', 'waiting'), now), '');
  assert.equal(L.waitedFor(ses('a', 'running', { waitingSince: now - 60000 }), now), '');
});

test('rowTip adds the waiting time between title and latest request', () => {
  const now = 10 * 86400000;
  assert.equal(L.rowTip(ses('a', 'waiting', { waitingSince: now - 5 * 60000, topic: '**Go** on' }), now), 'T a\nWaiting for you for 5 min\nYou: Go on');
  assert.equal(L.rowTip(ses('a'), now), 'T a');
});

test('chipsHtml draws the row badges with escaped tooltips', () => {
  assert.equal(L.chipsHtml(ses('a')), '');
  const h = L.chipsHtml(ses('a', 'done', { prOpened: 2, lastError: true, also: ['<app>'] }));
  assert.match(h, /^<span class="chip err" title="Its newest tool result failed"><span class="sr">/);
  assert.match(h, /<span class="chip pr" title="Opened 2 pull requests">PR 2<\/span>/);
  assert.match(h, /Also open in &lt;app&gt;/);
});

test('shownRows: newest few unless unfolded; searching shows up to the cap', () => {
  assert.equal(L.shownRows(30, { q: false, open: false, few: 12, cap: 30 }), 12);
  assert.equal(L.shownRows(8, { q: false, open: false, few: 12, cap: 30 }), 8);
  assert.equal(L.shownRows(45, { q: false, open: true, few: 12, cap: 30 }), 45);
  assert.equal(L.shownRows(45, { q: true, open: false, few: 12, cap: 30 }), 30);
});

test('replyBlock names why the quick reply is off; replyErrorText points refused tools to the Terminal tab', () => {
  assert.equal(L.replyBlock(ses('a'), 'resting'), '');
  assert.match(L.replyBlock(ses('a', 'running'), 'running'), /^Agent is working/);
  assert.match(L.replyBlock(ses('a', 'done', { also: ['desktop app'] }), 'resting'), /^Open in desktop app\./);
  assert.match(L.replyBlock(ses('a', 'done', { kind: 'headless' }), 'resting'), /^Automated run/);
  assert.match(L.replyErrorText('Claude requested permissions to use Bash, but you have not granted it yet'), /needs your approval/);
  assert.equal(L.replyErrorText('exit 1'), 'Last reply failed: exit 1');
});

test('termLeave: F6 and Ctrl+Shift+Left leave the terminal, Shift+F6 goes to the footer, CLI keys stay', () => {
  assert.equal(L.termLeave({ key: 'F6' }), 'tabs');
  assert.equal(L.termLeave({ key: 'F6', shift: true }), 'foot');
  assert.equal(L.termLeave({ key: 'ArrowLeft', ctrl: true, shift: true }), 'tabs');
  for (const k of [{ key: 'Tab' }, { key: 'Tab', shift: true }, { key: 'Escape' }, { key: 'c', ctrl: true }, { key: 'ArrowLeft', ctrl: true }, { key: 'ArrowLeft', shift: true }, { key: 'F6', ctrl: true }, { key: 'F6', alt: true }, { key: 'F6', meta: true }, { key: 'Tab', ctrl: true }])
    assert.equal(L.termLeave(k), '', JSON.stringify(k));
});

test('bare titles: "(session)", id prefix or empty give way to project and branch, never an empty name', () => {
  const id = 'abcdef12-3456-4000-8000-000000000001';
  assert.equal(L.bareTitle({ id, title: '(session)' }), true);
  assert.equal(L.bareTitle({ id, title: 'abcdef12' }), true);
  assert.equal(L.bareTitle({ id, title: 'ABCDEF12' }), true);
  assert.equal(L.bareTitle({ id, title: '  ' }), true);
  assert.equal(L.bareTitle({ id }), true);
  assert.equal(L.bareTitle({ id, title: 'deadbeef' }), false, 'eight hex letters that are not this id are a real title');
  assert.equal(L.bareTitle({ id, title: 'Fix the login bug' }), false);
  assert.equal(L.nameOf({ id, title: 'Fix the login bug', project: 'web' }), 'Fix the login bug');
  assert.equal(L.nameOf({ id, title: '(session)', project: 'web', branch: 'main' }), 'web · main');
  assert.equal(L.nameOf({ id, title: 'abcdef12', project: 'web' }), 'web');
  assert.equal(L.nameOf({ id, title: '', project: '' }), 'abcdef12');
  assert.equal(L.nameOf({ id: '', title: '' }), '(session)');
  assert.equal(L.bareLabel({ id, title: '(session)' }), 'abcdef12');
  assert.equal(L.bareLabel({ id, title: 'Fix it' }), '');
  assert.match(L.rowTip({ id, title: '(session)', project: 'web', branch: 'main', status: 'done' }, 0), /^web · main\nSession abcdef12$/);
  assert.equal(L.rowTip({ id, title: 'Fix it', status: 'done' }, 0), 'Fix it');
});

test('replyFailure shows the server text as given and the Terminal hint only for a silent non-zero exit', () => {
  assert.equal(L.replyFailure(ses('a')), null);
  assert.equal(L.replyFailure(ses('a', 'done', { replyError: '  ', replyExit: 0 })), null);
  assert.deepEqual(L.replyFailure(ses('a', 'done', { replyError: '  Claude requested permissions to use Bash\n' })), { text: 'Claude requested permissions to use Bash', hint: false });
  assert.deepEqual(L.replyFailure(ses('a', 'done', { replyError: 'stub refused', replyExit: 3 })), { text: 'stub refused', hint: false });
  assert.deepEqual(L.replyFailure(ses('a', 'done', { replyError: '', replyExit: 1 })), { text: '', hint: true });
  assert.equal(L.replyFailure(ses('a', 'done', { replyError: '', replyExit: 'x' })), null);
});

test('diverged rows and the sync line say which copy shows and that Reload terminal loads the newest', () => {
  const d = ses('a', 'done', { consistency: 'diverged' });
  assert.match(L.rowChipsHtml(d), /class="chip diverged" title="Its copies differ: this page shows the conversation the CLI resumes[^"]*Reload terminal loads the newest\."/);
  assert.equal(L.rowChipsHtml(ses('a', 'done', { prOpened: 1 })), L.chipsHtml(ses('a', 'done', { prOpened: 1 })));
  assert.equal((L.syncLineHtml(d).match(/data-act="reterm"/g) || []).length, 1);
  assert.equal((L.syncLineHtml({ ...d, behind: true }).match(/data-act="reterm"/g) || []).length, 1);
  assert.equal(L.syncLineHtml(ses('a')), '');
  assert.equal(L.DIVERGED_TIP.split(/[.;:] [A-Z]/).length <= 2 && /^[^.]*\.$/.test(L.DIVERGED_TIP), true);
});

test('open twice follows the server copy count when it is sent, else the also list', () => {
  const kinds = s => L.badges(s).map(b => b[0]);
  assert.deepEqual(kinds(ses('a', 'running', { also: ['another terminal'], copies: 1 })), []);
  assert.deepEqual(kinds(ses('a', 'running', { also: ['another terminal'], copies: 2 })), ['also']);
  assert.deepEqual(kinds(ses('a', 'running', { also: ['desktop app'] })), ['also']);
  assert.equal(L.openTwice(ses('a', 'done', { also: [], copies: 3 })), true);
});
