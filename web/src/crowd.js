// @ts-check
// Demo-page preview switches in the address: ?crowd=N waiting characters, ?clock=HH:MM sky time, ?wx=CODE weather, ?cloud=N cloud cover %, ?stale=N day-old waits, ?working=N working sessions in all, ?titles=hard title shapes that strain the name tags.
import { CROWD, EXAMPLE } from './demo.js';
import { REAL, state } from './state.js';
import { wx } from './backdrop.js';

// Crowd sessions folded into five projects, with two shared branches, so the preview garden has a few teams.
/** @type {Record<string, [string, string]>} */
const TEAM = { c01:['data-pipelines', 'airflow-3'], c02:['analytics-jobs', 'chore/user-id'], c03:['storefront-web', 'feat/settings'], c04:['data-pipelines', 'fix/rollup'],
  c05:['storefront-web', 'perf/thumbs'], c06:['docs-site', 'docs/onboarding'], c07:['data-pipelines', 'ci/node-24'], c08:['billing-api', 'fix/ws-leak'], c09:['storefront-web', 'feat/settings'],
  c10:['data-pipelines', 'airflow-3'], c11:['billing-api', 'feat/webhook-retry'], c12:['billing-api', 'feat/invoice-totals'], c13:['docs-site', 'docs/readme'], c14:['analytics-jobs', 'perf/search'] };
/** Invented titles in the shapes real ones take (long underscored word, ticket id, Hebrew, mixed direction, emoji, "(session)", id prefix, slash command, long path, quote, brace, empty), handed out by waiting order with ?titles=hard. */
export const HARD_TITLES = ['refactor_nightly_rollup_partitions_by_region for the new scheduler', 'PROJ-4821 fix flaky checkout totals on retry', 'תקן את דוח ההכנסות היומי לפני ההרצה',
  'בדיקת DAG של orders_daily אחרי השינוי', '🚀 ship the release notes 🎉 before Friday', '(session)', '3f2a9c1e', '/review-pr 482 --comments',
  'src/storefront/components/checkout/PaymentSummaryTotalsBreakdownPanel.tsx', '"why does the cache miss on a cold start?"', '{"task": "rename columns", "table": "orders"}', '',
  'Fix the login redirect loop when the session cookie expires mid-checkout', 'ABC-12 ABC-13 ABC-14 merge the three hotfixes', 'Ünïcödé façade naïve résumé cleanup', '[WIP] split the giant utils module', 'x'];
/** Waiting characters wanted from ?crowd=N, 0 when unset. @param {string} q */
export const crowdOf = q => Math.max(0, Math.min(40, Number((/[?&]crowd=(\d+)/.exec(q) || [])[1] || 0)));
// Demo only: pad the example data with waiting sessions and apply the sky overrides before the first render.
if (!REAL) {
  const q = location.search, n = crowdOf(q), have = EXAMPLE.filter(s => s.status === 'waiting').length;
  if (n > have) EXAMPLE.push(...CROWD.slice(0, n - have).map(s => TEAM[s.id] ? { ...s, project: TEAM[s.id][0], branch: TEAM[s.id][1] } : s));
  const c = /[?&]clock=(\d\d):(\d\d)/.exec(q); if (c) state.st.clock = +c[1] * 60 + +c[2];
  const w = /[?&]wx=(\d+)/.exec(q); if (w) wx.code = +w[1];
  const cl = /[?&]cloud=(\d+)/.exec(q); if (cl) wx.cloud = Math.min(100, +cl[1]);
  // ?stale=N: the first N waiting sessions have waited 26 hours.
  const st = Math.min(40, Number((/[?&]stale=(\d+)/.exec(q) || [])[1] || 0)), old = Date.now() - 26 * 3600e3;
  EXAMPLE.filter(s => s.status === 'waiting').slice(0, st).forEach(s => Object.assign(s, { updated: old, waitingSince: old }));
  // ?working=N: invented working sessions until N work in all, every third with a running subagent.
  const wk = Math.min(60, Number((/[?&]working=(\d+)/.exec(q) || [])[1] || 0)), busy = EXAMPLE.filter(s => s.status === 'running').length, P = ['data-pipelines', 'storefront-web', 'billing-api', 'docs-site'];
  for (let i = 0; i < wk - busy; i++) EXAMPLE.push(/** @type {any} */ ({ id: 'w' + String(i + 1).padStart(2, '0'), title: `Example working task ${i + 1}`, project: P[i % 4], branch: 'main', status: 'running', model: 'Opus 5.5',
    updated: Date.now() - i * 45000, tokens: 9000 + i * 1000, last: 'Reading files', subs: i % 3 === 2 ? ['Check the tests'] : [], tl: [], files: [] }));
  // ?titles=hard: every waiting session takes one of HARD_TITLES in turn.
  if (/[?&]titles=hard/.test(q)) EXAMPLE.filter(s => s.status === 'waiting').forEach((s, i) => { s.title = HARD_TITLES[i % HARD_TITLES.length]; });
}
