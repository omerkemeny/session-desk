// @ts-check
// One status toast at the bottom of the page.
import { $ } from './util.js';
import { isReduced } from './state.js';

/** @type {ReturnType<typeof setTimeout> | undefined} */
let tt, toastOut;
/** Pop the toast in (re-pop if one is up), slide it out after a while. @param {string} m */
export function toast(m) {
  const t = $('toast'); clearTimeout(tt); clearTimeout(toastOut);
  t.textContent = m; t.classList.remove('out');
  if (!t.hidden) { t.style.animation = 'none'; void t.offsetWidth; t.style.animation = ''; }
  t.hidden = false;
  tt = setTimeout(() => { if (isReduced()) return t.hidden = true; t.classList.add('out'); toastOut = setTimeout(() => { t.hidden = true; t.classList.remove('out'); }, 200); }, 2800);
}
const SAY_FOR = 6000;  // ms an announcement stays in the live region before it is cleared, so the same words can be said again later
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sayT;
/** One polite screen-reader announcement in the hidden #say region; nothing visible. @param {string} m */
export function announce(m) {
  const el = $('say'); if (!el || !m) return; clearTimeout(sayT);
  el.textContent = m; sayT = setTimeout(() => { el.textContent = ''; }, SAY_FOR);
}
