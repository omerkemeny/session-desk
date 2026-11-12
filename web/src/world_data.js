// @ts-check
// Pure rules that turn today's real sessions into scenery: ore on the mine cart, sunflowers by the town fence, paper boats on the stream, a comet on big days, the mine lantern, a cat on the town fence, a nest of the day streak, sky moments when turns finish.
import { ilDay, ilInstant } from './world_time.js';
import { NAP_MIN, waitedMin } from './activity.js';
import { diverged, openTwice } from './logic.js';

/** @typedef {import('./types.js').Session} Session */
/** @typedef {{ tokens: number, prs: number, runs: number }} DayTotals */

export const ORE_STEPS = [250e3, 1e6, 3e6, 10e6]; // tokens today for each ore step on the cart
export const MAX_BLOOMS = 8; // sunflowers along the fence at most
export const MAX_BOATS = 3; // paper boats on the stream at once
export const COMET_PRS = 5; // pull requests in a day that bring the comet out at night

/** Preview overrides; null takes the value from the sessions. @type {{ tokens: number | null, prs: number | null, runs: number | null, week: boolean[] | null, lantern?: boolean | null, cat?: boolean | null, notes?: number | null, vane?: boolean | null, streak?: number | null }} */
export const world = { tokens: null, prs: null, runs: null, week: null, lantern: null, cat: null, notes: null, vane: null, streak: null };
export const IDLE_MIN = NAP_MIN; // minutes every waiting session must have waited before the cat sleeps on the town fence
/** The mine's lantern is lit while at least one session works. @param {Session[]} S */
export const lanternLit = S => (S || []).some(s => !!s && s.status === 'running');
/** A cat sleeps on the town fence while the garden is truly idle: nothing works and every waiting session has waited IDLE_MIN or more. @param {Session[]} S @param {number} now */
export const catNaps = (S, now) => !(S || []).some(s => !!s && (s.status === 'running' || (s.status === 'waiting' && waitedMin(s, now) < IDLE_MIN)));
export const MAX_NOTES = 3; // paper notes on the mine's door post at most
/** Notes pinned on the mine's door post: one per session whose copies are out of step (its page terminal is behind, it is open in another program too, or its copies diverged), at most MAX_NOTES. @param {Session[]} S */
export const syncNotes = S => Math.min(MAX_NOTES, (S || []).filter(s => !!s && (!!s.behind || openTwice(s) || diverged(s))).length);
export const WEEK = 7; // days in the pull-request constellation, today last

/** Totals for today in Israel: tokens and pull requests from a session's exact tokensToday and prsToday when it sends them, else its whole tokens and prOpened when its newest message is from today; automated (headless) runs active today. @param {Session[]} S @param {number} now @returns {DayTotals} */
export function dayTotals(S, now) {
  const day = ilDay(new Date(now)).iso, t0 = ilInstant(day, 0).getTime(), t1 = ilInstant(day, 1440).getTime(), out = { tokens: 0, prs: 0, runs: 0 };
  /** @param {unknown} v */
  const n = v => Math.max(0, Number(v) || 0), exact = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
  for (const s of S || []) {
    if (!s) continue;
    const today = s.updated >= t0 && s.updated < t1, x = /** @type {Session & { tokensToday?: number, prsToday?: number }} */ (s);
    out.tokens += exact(x.tokensToday) ? n(x.tokensToday) : today ? n(s.tokens) : 0;
    out.prs += Math.floor(exact(x.prsToday) ? n(x.prsToday) : today ? n(s.prOpened) : 0);
    if (today && (s.automated === true || s.kind === 'headless')) out.runs++;
  }
  return out;
}
/** Ore step 0..4 for tokens used today. @param {number} tokens */
export const oreStep = tokens => ORE_STEPS.filter(t => tokens >= t).length;
/** Sunflowers by the fence: one per pull request, capped. @param {number} prs */
export const blooms = prs => Math.max(0, Math.min(MAX_BLOOMS, Math.floor(prs)));
/** Paper boats drifting down the stream: one per automated run, capped. @param {number} runs */
export const boats = runs => Math.max(0, Math.min(MAX_BOATS, Math.floor(runs)));
/** Comet in a clear night sky after a day with COMET_PRS or more pull requests. @param {number} prs @param {number} starA @param {boolean} clear */
export const cometOn = (prs, starA, clear) => prs >= COMET_PRS && starA > .3 && clear;
/** Scene facts for today with the preview overrides applied. @param {Session[]} S @param {number} now */
export function worldNow(S, now) {
  const d = dayTotals(S, now), t = world.tokens ?? d.tokens, p = world.prs ?? d.prs, r = world.runs ?? d.runs;
  return { ore: oreStep(t), blooms: blooms(p), boats: boats(r), prs: p, week: world.week ?? weekPrs(S, now), lantern: world.lantern ?? lanternLit(S), cat: world.cat ?? catNaps(S, now), notes: world.notes ?? syncNotes(S), vane: world.vane ?? true, eggs: eggs(world.streak ?? statStreak ?? streakDays(S, now)) };
}
/** The last WEEK days in Israel, oldest first, true where a session that opened a pull request was last active that day (today also counts prsToday). @param {Session[]} S @param {number} now @returns {boolean[]} */
export function weekPrs(S, now) {
  const day = ilDay(new Date(now)).iso, t1 = ilInstant(day, 1440).getTime(), out = Array(WEEK).fill(false);
  for (const s of S || []) {
    const x = /** @type {Session & { prsToday?: number }} */ (s); if (!s || !(Number(s.prOpened) > 0 || Number(x.prsToday) > 0) || !(s.updated < t1)) continue;
    const back = Math.round((ilInstant(ilDay(new Date(s.updated)).iso, 0).getTime() - ilInstant(day, 0).getTime()) / 864e5) + WEEK - 1;
    if (back >= 0 && back < WEEK) out[back] = true;
  }
  return out;
}
/** Overrides from a demo address: tokens=N, prs=N, runs=N, rainago=MIN (minutes since rain ended), week=0101101 (days with a pull request, oldest first), lantern=0|1, cat=0|1, notes=N (sessions out of step), vane=0|1 (the weather vane) and streak=N (days in a row with a session). @param {string} q */
export function parseWorld(q) {
  /** @param {string} k */
  const num = k => { const m = new RegExp('[?&]' + k + '=([0-9.e+]+)').exec(q); return m ? Math.max(0, Number(m[1]) || 0) : null; };
  const w = /[?&]week=([01]{1,7})/.exec(q);
  const flag = (/** @type {string} */ k) => { const m = new RegExp('[?&]' + k + '=([01])').exec(q); return m ? m[1] === '1' : null; };
  return { tokens: num('tokens'), prs: num('prs'), runs: num('runs'), rainAgo: num('rainago'), week: w ? [...w[1].padStart(WEEK, '0')].map(c => c === '1') : null, lantern: flag('lantern'), cat: flag('cat'), notes: num('notes'), vane: flag('vane'), streak: num('streak') };
}
export const MAX_EGGS = 5; // eggs in the cliff nest at most
let statStreak = null; // the day streak as the usage statistics count it; null until they answer
/** Remember the Stats panel's day streak so the nest shows the same number. @param {number | null} n */
export const setStreak = n => { statStreak = typeof n === 'number' && Number.isFinite(n) ? n : null; };
/** Days in a row with a session last active on them, counted back from today (from yesterday while today has none yet), Israel days; at most MAX_EGGS are counted. @param {Session[]} S @param {number} now */
export function streakDays(S, now) {
  const t0 = ilInstant(ilDay(new Date(now)).iso, 0).getTime(), ago = new Set();
  for (const s of S || []) if (s && s.updated < now + 864e5) ago.add(Math.round((t0 - ilInstant(ilDay(new Date(s.updated)).iso, 0).getTime()) / 864e5));
  let d = ago.has(0) ? 0 : 1, n = 0; while (ago.has(d) && n < MAX_EGGS) { n++; d++; }
  return n;
}
/** Eggs in the cliff nest: one per day of the streak, capped; no nest at 0. @param {number} days */
export const eggs = days => Math.max(0, Math.min(MAX_EGGS, Math.floor(days)));
export const GAP = 20000; // ms between sky moments at least, however many sessions finish

/** Sessions that went from running to waiting since the last look, and the statuses to remember; nothing on the first look. @param {Map<string, string> | null} prev @param {Session[]} S */
export function finished(prev, S) {
  const next = new Map((S || []).map(s => [s.id, s.status]));
  return { done: prev ? (S || []).filter(s => s.status === 'waiting' && prev.get(s.id) === 'running').length : 0, next };
}
/** Which moment shows: 'star' in a dark clear sky, 'bird' in daylight without rain, snow or fog, '' when none finished, motion is reduced, the last one was under GAP ago or the sky is in between. @param {{ done: number, now: number, last: number, still: boolean, starA: number, L: number, clear: boolean, dry: boolean }} o @returns {'' | 'star' | 'bird'} */
export const momentKind = o => !o.done || o.still || o.now - o.last < GAP ? '' : o.starA > .5 && o.clear ? 'star' : o.L > .6 && o.dry ? 'bird' : '';

