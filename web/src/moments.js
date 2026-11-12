// @ts-check
// Sky moments for real events: when a working session finishes its turn, one shooting star by night or one bird leaving the big tree by day.
import { REAL } from './state.js';
import { moving, pace } from './pace.js';
import { bgMoment, bgs, wx } from './backdrop.js';
import { isSnow, isWet } from './logic.js';
import { finished, momentKind } from './world_data.js';

/** @typedef {import('./types.js').Session} Session */
/** @type {Map<string, string> | null} */
let seen = null, last = -Infinity;
/** Checks the sessions for finished turns and starts at most one sky moment. @param {Session[]} S */
export function watchMoments(S) {
  const f = finished(seen, S); seen = f.next;
  const wet = isWet(wx.code) || isSnow(wx.code), fog = wx.code === 45 || wx.code === 48;
  const k = momentKind({ done: f.done, now: Date.now(), last, still: !moving(), starA: bgs.starA || 0, L: bgs.L ?? 1, clear: wx.cloud < 70 && !wet && !fog, dry: !wet && !fog });
  if (k) { last = Date.now(); bgMoment(k); }
}
// Demo preview: ?moment=star or ?moment=bird starts one two seconds after load.
if (!REAL && typeof location !== 'undefined') { const m = /[?&]moment=(star|bird)/.exec(location.search); if (m && !pace.still) setTimeout(() => bgMoment(/** @type {'star' | 'bird'} */ (m[1])), 2000); }
