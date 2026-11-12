// @ts-check
// Example data for the page opened without the local server: sessions and usage numbers, no real content.
import { rng } from './util.js';

/** @typedef {import('./types.js').Session} Session */

/** @param {number} m minutes ago */
const ago = m => Date.now() - m * 60000;
// Example sessions, shown when the page is not served by the local server.
/** @type {Session[]} */
export const EXAMPLE = [
 { id:'s1', title:'Fix flaky checkout test', project:'storefront-web', branch:'fix/checkout-flake', status:'waiting', model:'Opus 5.5', updated:ago(2), waitingSince:ago(2), tokens:184000,
   ask:'The test passes with a 200 ms wait, or I can mock the payment client instead. Which do you want?', answers:['Mock the client','Keep the wait'],
   plan:[['Reproduce the failure',1],['Find the race',1],['Apply the fix',2],['Run the suite 20 times',0]],
   tl:[['you','checkout.spec.ts fails about 1 run in 8 on CI. Find out why and fix it.'],
       ['tools','Read 6 files, ran 3 commands',['Read tests/checkout.spec.ts','Read src/payment/client.ts','Grep "waitForResponse" · 14 matches','Bash npm test -- checkout --repeat 20 · 3 failed']],
       ['claude','The test clicks Pay before the payment client finishes loading its config. On slow CI runners the click lands on a disabled button.']],
   files:[['tests/checkout.spec.ts',12,4]] },
 { id:'s2', title:'Add CSV export to invoices page', project:'billing-api', branch:'feat/invoice-csv', status:'waiting', model:'Sonnet 5.5', updated:ago(11), waitingSince:ago(11), tokens:96000,
   ask:'Ready to commit 4 files. Approve?', answers:['Approve','Show diff first'],
   plan:[['Add export endpoint',1],['Stream rows as CSV',1],['Add tests',1],['Commit',2]],
   tl:[['you','Add a CSV export for the invoices list. Same filters as the page.'],
       ['tools','Read 9 files, edited 4, ran 1 command',['Read api/invoices/list.py','Edit api/invoices/export.py','Edit api/routes.py','Edit tests/test_export.py','Bash pytest tests/test_export.py · 7 passed']],
       ['claude','Export endpoint streams rows, so a 200,000-row export stays under 60 MB of memory. All 7 new tests pass.']],
   files:[['api/invoices/export.py',88,0],['api/routes.py',3,0],['api/invoices/filters.py',14,9],['tests/test_export.py',121,0]] },
 { id:'s6', title:'Upgrade ESLint to flat config', project:'storefront-web', branch:'chore/eslint-9', status:'waiting', model:'Sonnet 5.5', updated:ago(38), waitingSince:ago(38), tokens:143000,
   ask:'npm install fails: eslint-plugin-import 2.29 needs eslint ^8. Wait for the plugin, or swap it for eslint-plugin-import-x?', answers:['Swap the plugin','Stay on ESLint 8'],
   plan:[['Convert .eslintrc to eslint.config.js',1],['Upgrade plugins',2],['Fix new lint errors',0]],
   tl:[['you','Move us to ESLint 9 and flat config.'],
       ['tools','Edited 2 files, ran 3 commands',['Edit eslint.config.js','Edit package.json','Bash npm install · exit 1']],
       ['claude','npm install failed with ERESOLVE. Nothing was committed.']],
   files:[['eslint.config.js',74,0],['package.json',6,6]] },
 { id:'s3', title:'Migrate date handling to Temporal', project:'storefront-web', branch:'chore/temporal', status:'running', model:'Opus 5.5', updated:ago(0), tokens:412000, subs:['Convert cart components', 'Convert checkout components'],
   last:'Editing src/cart/delivery-window.ts (file 19 of 31)',
   plan:[['List every moment.js call',1],['Convert utilities',1],['Convert components',2],['Remove moment.js',0],['Run type check and tests',0]],
   tl:[['you','Replace moment.js with Temporal across the app. Keep behaviour identical.'],
       ['tools','Searched 212 files, edited 18',['Grep "from \'moment\'" · 31 files','Read src/utils/dates.ts','Edit src/utils/dates.ts','Edit src/utils/format.ts','… 16 more']],
       ['claude','31 files import moment.js. Converting shared utilities first so components change in one pass.']],
   files:[['src/utils/dates.ts',64,71],['src/utils/format.ts',22,30],['src/cart/summary.tsx',9,11],['15 more files',140,162]] },
 { id:'s4', title:'Investigate slow dashboard query', project:'analytics-jobs', branch:'main', status:'running', model:'Opus 5.5', updated:ago(0), tokens:58000,
   last:'Running EXPLAIN on daily_active_users',
   plan:[['Capture the slow query',1],['Read the query plan',2],['Propose an index or rewrite',0]],
   tl:[['you','The retention dashboard takes 40 s to load. Find the slow query. Read only, change nothing.'],
       ['tools','Read 3 files, ran 2 commands',['Read dashboards/retention.sql','Bash psql -c "EXPLAIN ANALYZE …" · 38.2 s']],
       ['claude','One query takes 38.2 s of the 40 s. It scans the whole events table because the date filter wraps the column in a function.']],
   files:[] },
 { id:'s5', title:'Write release notes for 4.12', project:'docs-site', branch:'release/4.12', status:'running', model:'Haiku 5.5', updated:ago(1), tokens:21000,
   last:'Drafting the "Breaking changes" section',
   plan:[['Collect merged pull requests',1],['Group by area',1],['Draft notes',2]],
   tl:[['you','Draft release notes for 4.12 from the merged pull requests since 4.11.'],
       ['tools','Ran 2 commands',['Bash git log v4.11..HEAD --merges · 47 merges','Read CHANGELOG.md']],
       ['claude','47 pull requests since 4.11. Grouped into 5 areas, 2 breaking changes.']],
   files:[['docs/releases/4.12.md',96,0]] },
 { id:'s7', title:'Add rate limiting to login endpoint', project:'billing-api', branch:'feat/login-rate-limit', status:'done', model:'Opus 5.5', updated:ago(60), tokens:201000,
   last:'Pull request opened, 12 tests pass',
   plan:[['Add limiter middleware',1],['Cover with tests',1],['Open pull request',1]],
   tl:[['you','Limit login attempts to 5 per minute per IP.'],
       ['tools','Read 7 files, edited 3, ran 2 commands',['Edit api/middleware/rate_limit.py','Edit api/auth/login.py','Edit tests/test_login.py','Bash pytest tests/test_login.py · 12 passed']],
       ['claude','Login now returns 429 after 5 attempts per minute per IP. Pull request is open with 12 passing tests.']],
   files:[['api/middleware/rate_limit.py',57,0],['api/auth/login.py',8,1],['tests/test_login.py',66,0]] },
 { id:'s8', title:'Explain the retry logic in the sync job', project:'analytics-jobs', branch:'main', status:'done', model:'Sonnet 5.5', updated:ago(180), tokens:34000,
   last:'Answered: 3 retries with 2, 4, 8 s backoff; no retry on 4xx',
   tl:[['you','How does retry work in jobs/sync.py?'],['tools','Read 2 files',['Read jobs/sync.py','Read jobs/http.py']],
       ['claude','The job retries 3 times with 2, 4 and 8 s waits. It does not retry 4xx responses, only timeouts and 5xx.']], files:[] },
 { id:'s9', title:'Fix broken links in API guide', project:'docs-site', branch:'fix/api-links', status:'done', model:'Haiku 5.5', updated:ago(1500), tokens:18000,
   last:'Fixed 23 links across 6 pages, merged',
   tl:[['you','The link checker reports broken links in the API guide. Fix them.'],['tools','Edited 6 files, ran 1 command',['Bash npm run check-links · 23 broken','Edit docs/api/*.md · 6 files']],
       ['claude','23 broken links fixed across 6 pages. Link checker reports 0 broken.']],
   files:[['docs/api/auth.md',5,5],['docs/api/invoices.md',7,7],['4 more files',11,11]] },
 // Row badges and Markdown previews: open in two places and behind, a pull request, a failed newest tool result.
 { id:'s10', title:'Speed up CI cache restore', project:'storefront-web', branch:'ci/cache-restore', status:'done', model:'Sonnet 5.5', updated:ago(95), tokens:12000,
   also:['desktop app'], behind:true, prOpened:1, kind:'interactive',
   last:'**CI is green.** Cache restore now takes `14 s` instead of 2 min. See [the pull request](https://example.com/pr/118).',
   tl:[['you','CI spends 2 minutes restoring the cache. Make it faster.'],['claude','Cache restore takes 14 s now. Pull request is open.']], files:[['.ci/cache.yml',9,14]] },
 { id:'s11', title:'Rename billing tables to snake case', project:'billing-api', branch:'chore/table-names', status:'done', model:'Opus 5.5', updated:ago(240), tokens:9000, lastError:true,
   last:'## Migration failed\n- `ALTER TABLE invoices` timed out after *30 s*',
   tl:[['you','Rename the billing tables to snake case.'],['claude','The migration timed out on the invoices table.']], files:[] },
 // Automated runs started by hooks through the headless CLI: folded away at the end of Resting.
 ...[[20, 'Save session notes'], [75, 'Save session notes'], [130, 'Summarise the day'], [300, 'Save session notes'], [700, 'Summarise the day'], [1600, 'Save session notes']].map(([m, t], i) => /** @type {Session} */ ({
   id:'h' + (i + 1), title:'/remember ' + t.toLowerCase(), project:'notes', branch:'main', status:'done', model:'Haiku 5.5', updated:ago(m), tokens:1500, kind:'headless',
   last:'Saved **2** key points to `memory/notes.md`', tl:[['you','/remember'],['claude','Saved 2 key points.']], files:[] }))
];
// Example numbers for the page opened without the local server, same shape as /api/stats.
/** @returns {any} */
export function usDemo() {
  /** @type {Array<[string, number, number, number, number]>} */
  const days = [];
  const r = rng(42), hw = [...Array(24)].map((_, h) => h === 10 || h === 15 ? 3 : h >= 8 && h <= 20 ? 2 : h >= 21 ? 1 : 0), ww = [3, 3, 3, 3, .5, 0, 3];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5), off = d.getDay() === 5 || d.getDay() === 6, s = off ? Math.floor(r() * 2) : 2 + Math.floor(r() * 6), p = s * (4 + Math.floor(r() * 8)), t = p * (40000 + Math.floor(r() * 60000));
    days.push([d.toISOString().slice(0, 10), s, p, t, Math.round(t * .07)]);
  }
  /** @param {number[]} w @param {number} n */
  const spread = (w, n) => { const W = w.reduce((a, b) => a + b, 0); return w.map(x => Math.round(n * x / W)); };
  /** @param {number} n */
  const sum = n => {
    /** @param {number} i */
    const ds = days.slice(-n), k = i => ds.reduce((a, d) => a + /** @type {number} */ (d[i]), 0), s = k(1), p = k(2), t = k(3), o = k(4), inp = Math.round(t * .006);
    return { sessions:s, memoryRuns:Math.round(s * 1.6), prompts:p, answered:Math.round(p * .91), planDone:Math.round(p * .17), prs:Math.round(s * .55), commits:Math.round(s * .4),
      tokens:{ input:inp, output:o, cacheWrite:t - o - inp, cacheRead:t * 27 },
      models:[['claude-opus-5-5', Math.round(p * 3.1), Math.round(t * .7)], ['claude-sonnet-5-5', Math.round(p * .8), Math.round(t * .22)], ['claude-haiku-5-5', Math.round(p * .3), Math.round(t * .08)]],
      turn:{ median:19, p90:124, n:p }, active:{ median:236, total:p * 25 }, longest:s ? { active:11820, project:'storefront-web', day:ds[ds.length - 1][0] } : null,
      tools:[['Bash', p * 2], ['Read', Math.round(p * .3)], ['Edit', Math.round(p * .22)], ['Grep', Math.round(p * .12)], ['Write', Math.round(p * .1)], ['Agent', Math.round(p * .04)]],
      toolCalls:Math.round(p * 2.9), filesEdited:Math.round(p * .11), commands:p * 2, subagents:Math.round(p * .04), hours:spread(hw, p), weekdays:spread(ww, p),
      projects:[['storefront-web', Math.ceil(s * .45)], ['billing-api', Math.round(s * .3)], ['analytics-jobs', Math.round(s * .15)], ['docs-site', Math.round(s * .1)]].filter(x => x[1]),
      entry:{ desktop:Math.round(s * .8), terminal:s - Math.round(s * .8), other:0 } };
  };
  return { ready:true, today:days[29][0], since:days[0][0], periods:{ today:sum(1), '7d':sum(7), '30d':sum(30), all:sum(30) }, days, streak:{ current:4, longest:9 } };
}
// Whole example transcripts by session id, in the server's event shapes, so the sidebar shows every kind of line the CLI draws.
/** @type {Record<string, Array<Array<any>>>} */
export const EXAMPLE_FULL = {
  s8: [
    ['you', 'How does retry work in jobs/sync.py?'],
    // Reads fold into the CLI's group line "Read 2 files"; a click shows each call and its result.
    ['tool', 'Read', 'jobs/sync.py', '     1  import time\n     2  from jobs.http import fetch\n     3  \n     4  RETRIES = 3\n… +88 lines', 0, 'Read(jobs/sync.py)', 1],
    ['tool', 'Read', 'jobs/http.py', '     1  import urllib.request\n… +41 lines', 0, 'Read(jobs/http.py)', 1],
    // A subagent call: the CLI prints its line only; its hidden result expands in place.
    ['tool', 'Agent', 'Find callers of send()', 'send() is called from jobs/sync.py:52 and jobs/backfill.py:18. Both pass a full URL.', 0, 'Explore(Find callers of send())', 1],
    ['claude', '## Retry in `jobs/sync.py`\n\nThe job retries **3 times** with *exponential* backoff:\n\n1. wait 2 s\n2. wait 4 s\n3. wait 8 s\n\nIt never retries a `4xx` response:\n\n- timeouts and `5xx` are retried\n- `429` is retried after `Retry-After`\n  when the header is present\n\n```python\nfor attempt in range(RETRIES):\n    try:\n        return fetch(url)\n    except Transient:\n        time.sleep(2 ** (attempt + 1))\n```\n\n> The wait is fixed, with no jitter.\n\n| attempt | wait |\n|---|---|\n| 1 | 2 s |\n| 2 | 4 s |\n\nSee [urllib errors](https://docs.python.org/3/library/urllib.error.html) for the exception types.'],
    ['you', 'Add jitter and run the tests'],
    // Task-list update: the CLI prints no line for it (empty display), so neither does the page.
    ['tool', 'TodoWrite', '3 todos', 'Todos have been modified successfully.', 0, '', 1],
    ['tool', 'Edit', 'jobs/sync.py', 'Added 2 lines, removed 1 line\n 41 -        time.sleep(2 ** (attempt + 1))\n 41 +        wait = 2 ** (attempt + 1)\n 42 +        time.sleep(wait + random.uniform(0, 1))', 0, 'Update(jobs/sync.py)', 0],
    ['interrupt'],
    ['you', 'Only add jitter to the 5xx path, then run the tests'],
    // Five drawn lines fold into one; inside, the search and shell calls form one group line; the silent task-list update is not counted; the failed edit reads "Error: ...".
    ['tool', 'Edit', 'jobs/sync.py', '<tool_use_error>String to replace not found in file.</tool_use_error>', 1, 'Update(jobs/sync.py)', 0],
    ['tool', 'Read', 'jobs/sync.py', '    40  def send(url):\n    41      for attempt in range(RETRIES):\n… +12 lines', 0, 'Read(jobs/sync.py)', 1],
    ['tool', 'Edit', 'jobs/sync.py', 'Added 3 lines, removed 1 line', 0, 'Update(jobs/sync.py)', 0],
    ['tool', 'TodoWrite', '3 todos', 'Todos have been modified successfully.', 0, '', 1],
    ['tool', 'Write', 'tests/test_jitter.py', 'Wrote 12 lines to tests/test_jitter.py\n  1 from jobs.sync import backoff\n  2 \n  3 def test_jitter_only_on_5xx():\n… +9 lines', 0, 'Write(tests/test_jitter.py)', 0],
    ['tool', 'Grep', 'Retry-After', 'Found 2 files\njobs/sync.py\njobs/http.py', 0, 'Search(pattern: "Retry-After", path: "jobs")', 1],
    ['tool', 'Bash', 'pytest tests/ -q', '13 passed in 0.91s', 0, 'Bash(pytest tests/ -q)', 1],
    ['tool', 'Bash', 'ruff check jobs/', 'All checks passed!', 0, 'Bash(ruff check jobs/)', 1],
    ['claude', 'Jitter is added on the `5xx` path only. 13 tests pass and lint is clean.'],
    ['compact'],
    // An older ! output arrives cut to 3 lines by the server; the newest one further down arrives whole.
    ['you', '! git log --oneline -12'],
    ['out', 'a41c2e9 Add jitter to 5xx retries\n7d03b1f Retry 429 after Retry-After\n19ce5a2 Move fetch into jobs/http.py\n… +9 lines', 0],
    ['you', '/model sonnet'],
    ['out', 'Set model to Sonnet 5.5', 0],
    ['you', 'This chart shows the retries piling up at 02:00. Is jitter enough?'],
    ['you', '[Image]'],
    // A connector call: the CLI's group line "Called metrics".
    ['tool', 'mcp__metrics__query', 'sync_retries_total by hour', 'hour=02 retries=184\nhour=03 retries=12', 0, 'metrics - query (MCP)(query: "sync_retries_total by hour")', 1],
    ['claude', 'API Error: 529 overloaded. Retrying in 4 seconds…'],
    ['claude', 'Jitter spreads the 02:00 burst. The chart shows 184 retries in that hour against 12 in the next.'],
    // A failed call stays visible even when the CLI line is empty.
    ['tool', 'TodoWrite', '1 todo', 'Invalid input: todos[0].status must be one of pending, in_progress, completed', 1, '', 0],
    ['you', 'Also open a draft pull request'],
    ['elsewhere', 'desktop app', 2],
    // "Ran 2 shell commands": the push's output stays folded, the failed call shows its error under the group line.
    ['tool', 'Bash', 'git push -u origin jitter', 'Everything up-to-date', 0, 'Bash(git push -u origin jitter)', 1],
    ['tool', 'Bash', 'gh pr create --draft --fill', 'gh: not logged in', 1, 'Bash(gh pr create --draft --fill)', 0],
    ['claude', 'Opening the pull request failed: `gh` is not logged in. Run `gh auth login`, then ask again.'],
    ['you', '! git status --short'],
    ['out', ' M jobs/sync.py\n M jobs/http.py\n M tests/test_sync.py\n M tests/test_http.py\n?? notes/jitter.md\n?? notes/retry-chart.png', 0]
  ]
};

// Extra waiting sessions for the crowded-garden preview (?crowd=N on the demo page); invented titles, no transcripts.
/** @type {Session[]} */
export const CROWD = [
 ['c01', 'Backfill orders_daily for October', 'data-pipelines', 4, 'The backfill for 31 days is ready. Run it oldest first?', { lastTool:'Bash' }],
 ['c02', 'Rename user_id column in events schema', 'analytics-jobs', 7, 'Three views still read user_id. Update them in the same change?', { lastTool:'Edit' }],
 ['c03', 'Add dark mode toggle to settings page', 'storefront-web', 21, 'Store the choice per device or per account?', { lastTool:'Read', prOpened:1 }],
 ['c04', 'Fix DAG import error in nightly_rollup', 'data-pipelines', 2, 'The import fails on a removed operator. Swap it for the new one?', { lastTool:'Bash', lastError:true }],
 ['c05', 'Speed up image thumbnail worker', 'media-service', 9, 'Resizing in batches of 50 halves the time. Keep the old path as a fallback?', { lastTool:'Bash' }],
 ['c06', 'Draft onboarding guide for new engineers', 'docs-site', 75, 'Draft is ready with 6 sections. Add a glossary?', { lastTool:'Write' }],
 ['c07', 'Bump Node to 24 in CI images', 'infra', 3, 'Two jobs pin Node 20. Update them too?', { lastTool:'Bash', lastError:true }],
 ['c08', 'Investigate memory leak in websocket gateway', 'realtime-gateway', 30, 'Listeners pile up on reconnect. Patch it here or open an issue upstream?', { lastTool:'Grep' }],
 ['c09', 'Clean up unused feature flags', 'storefront-web', 12, 'Found 14 flags with no readers. Remove all of them?', { lastTool:'Grep', prOpened:2 }],
 ['c10', 'Port scheduler settings to Airflow 3', 'data-pipelines', 5, 'Two settings have no Airflow 3 match. Drop them?', { lastTool:'Read' }],
 ['c11', 'Add retry to webhook sender', 'billing-api', 16, 'Retry 3 times with backoff, or hand failures to the queue?', { lastTool:'Edit' }],
 ['c12', 'Write migration for invoice totals', 'billing-api', 1, 'The migration locks the table for about 40 s. Run it at night?', { lastTool:'Bash', kind:'headless' }],
 ['c13', 'Tidy README', 'docs-site', 95, 'Shortened from 300 to 120 lines. Commit?', { lastTool:'Edit' }],
 ['c14', 'Profile slow search endpoint under load', 'search-api', 6, 'The slowest part is JSON encoding. Try a faster encoder?', { lastTool:'Bash' }]
].map(([id, title, project, m, ask, more]) => /** @type {Session} */ ({ id, title, project, status:'waiting', model:'Sonnet 5.5', updated:ago(/** @type {number} */ (m)), statusAt:ago(/** @type {number} */ (m)), waitingSince:ago(/** @type {number} */ (m)), tokens:40000, ask, kind:'interactive', ...(/** @type {object} */ (more)) }));

/** Demo switch for the first-run notices: ?setup=nodata (no data folder, nothing listed), ?setup=nocli (sessions, no CLI), ?setup=readonly and ?setup=readonly-empty (read-only app folder with and without sessions) gives a health answer with that setup; null otherwise. @param {string} search */
export function demoSetup(search) {
  const v = new URLSearchParams(search).get('setup');
  if (v === 'nodata') return { setup: { dataDir: 'missing', sessions: 0, cli: 'ok', stateDir: 'ok', hint: 'No Claude Code data found: run `claude` once, then reload.' } };
  if (v === 'nocli') return { setup: { dataDir: 'ok', sessions: 14, cli: 'missing', stateDir: 'ok', hint: 'The `claude` command was not found: install Claude Code or set DESK_CLAUDE_BIN.' } };
  const ro = 'This folder is read-only: start with DESK_STATE_DIR=<a folder you can write>.';
  if (v === 'readonly') return { setup: { dataDir: 'ok', sessions: 14, cli: 'ok', stateDir: 'readOnly', hint: ro } };
  if (v === 'readonly-empty') return { setup: { dataDir: 'ok', sessions: 0, cli: 'ok', stateDir: 'readOnly', hint: ro } };
  return null;
}
