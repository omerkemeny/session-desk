// @ts-check
// Small camp fire in the meadow at dusk and night: two-frame flame over a soft static glow, gone by day and in rain or snow.
import { $ } from './util.js';
import { propSheet } from './sprites.js';
import { isSnow, isWet, phase } from './logic.js';
import { wx } from './backdrop.js';
import { state } from './state.js';
import { FIRE, fireLit } from './garden_layout.js';

/** Minutes after midnight in Israel, or the forced test clock. */
function ilMin() {
  if (state.st.clock != null) return state.st.clock;
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  return (+(p.find(x => x.type === 'hour')?.value || 0) % 24) * 60 + +(p.find(x => x.type === 'minute')?.value || 0);
}
/** True while the fire burns. */
export const fireOn = () => fireLit(phase(ilMin(), wx), isWet(wx.code) || isSnow(wx.code));
/** Lights or puts out the fire for the current sky and weather; true when it changed. */
export function syncFire() {
  const on = fireOn(), el = document.querySelector('#actors .fire');
  if (on === !!el) return false;
  if (!on) { el?.remove(); return true; }
  const f = document.createElement('i'); f.className = 'fire'; f.setAttribute('aria-hidden', 'true');
  f.style.left = `calc(${FIRE.x * 100}% + ${FIRE.dx}px)`; f.style.top = FIRE.y * 100 + '%'; f.style.zIndex = String(Math.round(FIRE.y * 100));
  f.innerHTML = `<b style="background-image:url(${propSheet(['fire-a', 'fire-b'])})"></b>`;
  $('actors').append(f);
  return true;
}
