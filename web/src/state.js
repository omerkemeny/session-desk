// @ts-check
// Shared page state in one object: modules read and write state.S, state.st and friends instead of each other's variables.
import * as L from './logic.js';

/** @typedef {import('./types.js').Session} Session */
/** @typedef {import('./types.js').DeskState} DeskState */

/** True only when served by the local server; otherwise the page shows example data and never calls it. */
export const REAL = ['127.0.0.1', 'localhost'].includes(location.hostname);
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
/** Reduced-motion preference at load; kept for older callers, isReduced() follows changes. */
export const reduced = motionQuery.matches;
/** Reduced-motion preference now: follows a change while the page is open. */
export const isReduced = () => motionQuery.matches;
/** Calls fn(reduced) whenever the reduced-motion preference changes. @param {(reduced: boolean) => void} fn */
export const onReducedChange = fn => motionQuery.addEventListener('change', e => fn(e.matches));

/** @type {Record<string, number>} */
let looks = {};
try { looks = JSON.parse(localStorage.getItem('looks') || '{}'); } catch (e) {}
/** @type {Set<string>} */
let sentHome = new Set();
try { sentHome = new Set(JSON.parse(localStorage.getItem('sentHome') || '[]')); } catch (e) {}

/** S is replaced on every poll; st, looks ('looks' in localStorage) and sentHome ('sentHome') keep their identity; health is the last /api/health answer (null before one; logic.setupHint reads it). @type {{ S: Session[], st: DeskState, looks: Record<string, number>, sentHome: Set<string>, health: any }} */
export const state = { S: [], st: { q:'', open:null, first:true }, looks, sentHome, health: null };

// Status helpers bound to the sent-home set.
export const key = L.sentKey;
/** @param {Session} s */
export const needsYou = s => L.needsYou(s, state.sentHome);
/** @param {Session} s */
export const group = s => L.group(s, state.sentHome);
/** @param {Session} s */
export const asleep = s => L.asleep(s, state.sentHome);
