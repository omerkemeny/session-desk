// @ts-check
// Scene pacing: the live reduced-motion preference, whether the garden is on screen, and garden timers that wait while the tab is hidden.
import { reduced } from './state.js';

/** Live facts: still is reduced motion now, inView is the garden on screen. */
export const pace = { still: reduced, inView: true };
/** @type {Array<() => void>} */
const subs = [];
/** Work skipped while the tab was hidden, run once when it shows again, by name. @type {Map<string, () => void>} */
const due = new Map();
/** Calls fn whenever motion preference, tab visibility or the garden's visibility changes. @param {() => void} fn */
export const onPace = fn => { subs.push(fn); };
// Tell every listener; on showing the tab, first run what fell due while hidden.
function tell() {
  if (!document.hidden) { const run = [...due.values()]; due.clear(); for (const f of run) f(); }
  for (const f of subs) f();
}
/** True (and fn remembered under key for later) while the tab is hidden; callers then skip their work. @param {string} key @param {() => void} fn */
export const later = (key, fn) => { if (!document.hidden) return false; due.set(key, fn); return true; };
/** Like setInterval, but while the tab is hidden a tick only marks the work due; it runs once on return. @param {number} ms @param {() => void} fn */
export const every = (ms, fn) => { const k = 'every' + nT++; return setInterval(() => { if (!later(k, fn)) fn(); }, ms); };
let nT = 0;
/** True while the scene should move: motion allowed, tab shown, garden on screen. */
export const moving = () => !pace.still && !document.hidden && pace.inView;

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', tell);
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  mq?.addEventListener?.('change', e => { pace.still = e.matches; tell(); });
  const g = document.getElementById('garden');
  if (g && typeof IntersectionObserver === 'function') new IntersectionObserver(es => {
    const on = es[es.length - 1].isIntersecting; if (on === pace.inView) return;
    pace.inView = on; g.classList.toggle('rest', !on); tell();
  }).observe(g);
}
