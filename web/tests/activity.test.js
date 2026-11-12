// Unit tests for src/activity.js: which session state makes a character sit, nap, pan, hammer, carry a pennant or a mini prop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/activity.js';

const MIN = 60000, NOW = 1_800_000_000_000;
/** Minimal session for the rules under test. */
const ses = (more = {}) => ({ id: 'x', title: 'T', project: 'p', status: 'waiting', updated: NOW, ...more });

test('restOf: stands, sits after SIT_MIN, naps after NAP_MIN; only while waiting', () => {
  assert.equal(A.restOf(ses({ updated: NOW - 2 * MIN }), NOW), '');
  assert.equal(A.restOf(ses({ updated: NOW - (A.SIT_MIN - 1) * MIN }), NOW), '');
  assert.equal(A.restOf(ses({ updated: NOW - A.SIT_MIN * MIN }), NOW), 'sit');
  assert.equal(A.restOf(ses({ updated: NOW - 38 * MIN }), NOW), 'sit');
  assert.equal(A.restOf(ses({ updated: NOW - A.NAP_MIN * MIN }), NOW), 'nap');
  assert.equal(A.restOf(ses({ updated: NOW - 600 * MIN }), NOW), 'nap');
  assert.equal(A.restOf(ses({ status: 'running', updated: NOW - 600 * MIN }), NOW), '');
  assert.equal(A.restOf(ses({ status: 'done', updated: NOW - 600 * MIN }), NOW), '');
});

test('restOf: a newer status change wakes the character, and clocks running behind never go negative', () => {
  assert.equal(A.restOf(ses({ updated: NOW - 90 * MIN, statusAt: NOW - 3 * MIN }), NOW), '');
  assert.equal(A.restOf(ses({ updated: NOW - 90 * MIN, statusAt: NOW - 20 * MIN }), NOW), 'sit');
  assert.equal(A.restOf(ses({ updated: NOW - 90 * MIN, statusAt: 0 }), NOW), 'nap');
  assert.equal(A.waitedMin(ses({ updated: NOW + 5 * MIN }), NOW), 0);
  assert.equal(A.restOf(ses({ updated: undefined }), NOW), 'nap', 'no timestamps at all counts as a long wait');
});

test('toolOf: tests pan for gold, builds and installs hammer, everything else digs', () => {
  const t = (/** @type {string | undefined} */ last) => A.toolOf(ses({ status: 'running', last }));
  for (const s of ['Running pytest tests/test_export.py', 'npm test -- checkout --repeat 20', 'Running the suite 20 times', 'Adding a spec for the parser', 'Checking coverage', 'Running the type check']) assert.equal(t(s), 'pan', s);
  for (const s of ['npm run build', 'Compiling the release binary', 'npm install failed with ERESOLVE', 'Bundling the assets with webpack', 'cargo build --release', 'Deploying to staging']) assert.equal(t(s), 'hammer', s);
  for (const s of ['Editing src/cart/delivery-window.ts (file 19 of 31)', 'Running EXPLAIN on daily_active_users', 'Drafting the "Breaking changes" section', 'Make sure dates stay in UTC', '', undefined]) assert.equal(t(s), 'pick', String(s));
  assert.equal(t('Build passes, now running the tests'), 'pan', 'tests win over builds when both are named');
});

test('hasPr: a pull request named in the last words, not the letters pr inside other words', () => {
  for (const s of ['Pull request opened, 12 tests pass', 'Opened PR #182 for review', 'See https://github.com/acme/web/pull/57', 'I created a PR with the fix', 'Updated the PR description', 'PR 301 is ready'])
    assert.ok(A.hasPr(ses({ last: s })), s);
  assert.ok(A.hasPr(ses({ ask: 'The pull request is open. Merge it now?' })));
  for (const s of ['Ready to commit 4 files. Approve?', 'Printing a progress bar', 'The PR template needs a section?', 'Express route added', '']) assert.ok(!A.hasPr(ses({ last: s, ask: s })), s);
});

test('propOf: lens to look, paper to write, crate for everything else', () => {
  for (const s of ['Explore the payment module', 'Find every moment.js call', 'Review the diff for bugs', 'Investigate the slow query', 'Search for flaky tests']) assert.equal(A.propOf(s), 'lens', s);
  for (const s of ['Write release notes', 'Draft the migration plan', 'Summarize the incident', 'Document the API']) assert.equal(A.propOf(s), 'paper', s);
  for (const s of ['Convert cart components', 'Convert checkout components', 'Fix the login bug', '']) assert.equal(A.propOf(s), 'crate', s);
});

test('server facts win over text: lastTool picks the miner tool, prOpened the pennant, lastError the red bubble', () => {
  const run = (/** @type {object} */ more) => A.toolOf(ses({ status: 'running', ...more }));
  assert.equal(run({ lastTool: 'Bash', last: 'npm test' }), 'pan', 'shell commands still go by their text');
  assert.equal(run({ lastTool: 'Bash', last: 'cargo build' }), 'hammer');
  assert.equal(run({ lastTool: 'Bash', last: 'ls' }), 'pick');
  assert.equal(run({ lastTool: 'Edit', last: 'running the tests' }), 'hammer', 'an edit is building, whatever it said');
  assert.equal(run({ lastTool: 'Read', last: 'pytest failed' }), 'pick');
  assert.equal(run({ lastTool: 'run_tests' }), 'pan', 'test runners by tool name');
  assert.equal(run({ lastTool: '', last: 'pytest' }), 'pan', 'no tool yet: text rules');
  assert.equal(run({ last: 'pytest' }), 'pan', 'field missing: text rules');
  assert.equal(A.hasPr(ses({ prOpened: 0, last: 'opened PR #12' })), false);
  assert.equal(A.hasPr(ses({ prOpened: 2 })), true);
  assert.equal(A.hasPr(ses({ last: 'opened PR #12' })), true, 'field missing: text rules');
  assert.equal(A.troubled(ses({ lastError: true })), true);
  assert.equal(A.troubled(ses({ lastError: true, status: 'running' })), false);
  assert.equal(A.troubled(ses({})), false);
});

test('waitLabel: waitingSince wins when set, else the status/message rule; minutes, hours, days', () => {
  assert.equal(A.waitLabel(ses({ updated: NOW - 3 * MIN, waitingSince: NOW - 12 * MIN }), NOW), 'waiting 12 min');
  assert.equal(A.waitLabel(ses({ updated: NOW - 3 * MIN, waitingSince: 0 }), NOW), 'waiting 3 min');
  assert.equal(A.waitLabel(ses({ updated: NOW - 20 * 1000 }), NOW), 'waiting under a minute');
  assert.equal(A.waitLabel(ses({ updated: NOW - 125 * MIN }), NOW), 'waiting 2 h 5 min');
  assert.equal(A.waitLabel(ses({ updated: NOW - 180 * MIN }), NOW), 'waiting 3 h');
  assert.equal(A.waitLabel(ses({ updated: NOW - 26 * 60 * MIN }), NOW), 'waiting 1 day');
  assert.equal(A.waitLabel(ses({ updated: NOW - 72 * 60 * MIN }), NOW), 'waiting 3 days');
  assert.equal(A.restOf(ses({ updated: NOW - 2 * MIN, waitingSince: NOW - 20 * MIN }), NOW), 'sit', 'waitingSince drives sitting too');
});

test('a day of waiting brings the blanket; working or shorter waits do not', () => {
  assert.equal(A.staleOf(ses({ waitingSince: NOW - 1440 * MIN }), NOW), true);
  assert.equal(A.staleOf(ses({ waitingSince: NOW - 1439 * MIN }), NOW), false);
  assert.equal(A.staleOf(ses({ status: 'running', waitingSince: NOW - 3000 * MIN }), NOW), false);
  assert.equal(A.restOf(ses({ waitingSince: NOW - 1440 * MIN }), NOW), 'nap');
});

test('freshOf: a wait is fresh for its first FRESH_MIN minutes only, and only while waiting', () => {
  assert.equal(A.freshOf(ses({ waitingSince: NOW }), NOW), true);
  assert.equal(A.freshOf(ses({ waitingSince: NOW - (A.FRESH_MIN - .1) * MIN }), NOW), true);
  assert.equal(A.freshOf(ses({ waitingSince: NOW - A.FRESH_MIN * MIN }), NOW), false);
  assert.equal(A.freshOf(ses({ status: 'running', waitingSince: NOW }), NOW), false);
  assert.equal(A.freshOf(ses({ updated: NOW - 2 * MIN }), NOW), true, 'no waitingSince: the last update counts');
  assert.equal(A.freshOf(ses({ updated: NOW - 2 * MIN, statusAt: NOW - 9 * MIN }), NOW), true, 'the newer of statusAt and updated');
});
