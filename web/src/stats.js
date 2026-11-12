// @ts-check
// Usage statistics: Stats button in the header and a scoreboard panel fed by /api/stats, or by example numbers in demo mode.
import { $, esc, LATE } from './util.js';
import { dayScene, usB, usDay, usDur, usInt, usTop } from './logic.js';
import { isReduced, REAL, state } from './state.js';
import { world } from './world_data.js';
import { usDemo } from './demo.js';

/** @type {{ data: any, per: string, open: boolean, anim: boolean, timer: any, ov: string, legend: boolean | null, gen: number }} */
const us = { data:null, per:'7d', open:false, anim:false, timer:0, ov:'', legend:null, gen:0 };
try { const p = localStorage.getItem('statsPeriod'); if (p && ['today', '7d', '30d', 'all'].includes(p)) us.per = p; } catch (e) {}
const LEGEND = 'legend.html';  // what the garden's signs mean, a page of its own
const US_PERS = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']];
const usBtn = document.createElement('button'), usShade = document.createElement('div'), usBox = document.createElement('section');
usBtn.type = 'button'; usBtn.className = 'us-btn'; usBtn.textContent = 'Stats'; usBtn.title = 'Usage statistics'; usBtn.setAttribute('aria-haspopup', 'dialog');
usShade.className = 'us-shade'; usShade.hidden = true;
usBox.className = 'us'; usBox.hidden = true; usBox.tabIndex = -1;
usBox.setAttribute('role', 'dialog'); usBox.setAttribute('aria-modal', 'true'); usBox.setAttribute('aria-labelledby', 'usTitle');
/** @param {number} done @param {number} total */
const usWait = (done, total) => `<div class="us-wait" role="status">Counting your sessions… <span class="num">${usInt(done)} / ${usInt(total || 0)}</span> transcripts
  <div class="us-prog"><i style="width:${total ? Math.round(done / total * 100) : 3}%"></i></div></div>`;
// Name, bar and value per item; bars scale to the largest item.
/** @param {Array<[string, number]>} list @param {(n: number) => string} val */
function usRows(list, val) {
  const max = Math.max(1, ...list.map(x => x[1]));
  return `<div class="us-rows">${list.map(x => `<div class="us-row"><span class="n" title="${esc(x[0])}">${esc(x[0])}</span><span class="us-bar" aria-hidden="true"><i style="width:${x[1] / max * 100}%"></i></span><span class="num">${val(x[1])}</span></div>`).join('') || '<span class="us-lbl">Nothing yet.</span>'}</div>`;
}
// Pixel column chart: one div per bar, highlighted bar marked "now"; focusable, arrow keys read bars out in the line below; empty periods say so.
/** @param {Array<{ v: number, now: boolean, tip: string }>} bars @param {string} label @param {string[]} axis */
function usCols(bars, label, axis) {
  if (!bars.some(b => b.v)) return `<div class="us-empty">Nothing in this period yet.</div>`;
  const max = Math.max(1, ...bars.map(b => b.v));
  return `<div class="us-cols" role="img" tabindex="0" aria-label="${esc(label)}: ${esc(bars.map(b => b.tip).join('; '))}" title="Arrow keys step through the bars">${bars.map(b => `<i class="${b.now ? 'now' : ''}${b.v ? '' : ' zero'}" style="height:${Math.max(2, b.v / max * 100)}%" title="${esc(b.tip)}" data-tip="${esc(b.tip)}"></i>`).join('')}</div><div class="us-axis">${axis.map(a => `<span>${esc(a)}</span>`).join('')}</div><div class="us-tip" aria-hidden="true"></div>`;
}
// Arrow keys on a focused chart move the selected bar and show its numbers under the axis; hovering a bar shows them too.
/** @param {HTMLElement} chart @param {number} step @param {HTMLElement | null} [to] */
function usPick(chart, step, to) {
  const bars = /** @type {HTMLElement[]} */ ([...chart.querySelectorAll('i')]); if (!bars.length) return;
  const cur = bars.findIndex(b => b.classList.contains('sel')), i = to ? bars.indexOf(to) : step === Infinity ? bars.length - 1 : step === -Infinity ? 0 : cur < 0 ? (step > 0 ? 0 : bars.length - 1) : Math.max(0, Math.min(bars.length - 1, cur + step));
  bars.forEach((b, k) => b.classList.toggle('sel', k === i));
  const tip = /** @type {HTMLElement | null} */ (chart.parentElement && chart.parentElement.querySelector('.us-tip')); if (tip) tip.textContent = bars[i].dataset.tip || '';
}
/** Panel title, data note, period switch and close button. @param {any} d */
function usHead(d) {
  const sub = !REAL ? 'example data' : d && d.ready ? `Israel time · since ${usDay(d.since)}${d.updating ? ' · updating…' : ''}` : '';
  return `<div class="us-head"><h2 id="usTitle">Usage</h2><span class="us-sub">${esc(sub)}</span>
    <div class="us-per" role="group" aria-label="Period">${US_PERS.map(([k, l]) => `<button type="button" data-usp="${k}" aria-pressed="${us.per === k}">${l}</button>`).join('')}</div>
    <button type="button" class="us-x" data-us="close" aria-label="Close statistics">✕<span class="esck"> esc</span></button></div>`;
}
/** "Today" card: what the garden's quiet signals stand for, with today's numbers from the listed sessions and the garden's own rules. */
function todayHtml() {
  const t = dayScene(state.S, Date.now(), state.sentHome, world), n = (/** @type {number} */ v, /** @type {string} */ one, /** @type {string} */ many) => `${v} ${v === 1 ? one : many}`;
  /** @param {string} label @param {string} v */
  const fact = (label, v) => `<div><b>${v}</b><span class="us-lbl">${label}</span></div>`;
  const ore = t.ore ? `ore on the cart: step ${t.ore} of ${t.steps}${t.next ? `, next at ${usB(t.next)}` : ', the cart is full'}` : `no ore on the cart yet, first step at ${usB(t.next)}`;
  const comet = t.comet ? `comet tonight: ${t.prs} pull requests, shows on a clear night` : `comet tonight: needs ${t.cometPrs} pull requests, ${t.cometPrs - t.prs} to go`;
  const wait = t.waiting ? (t.longest ? `need you · longest has waited ${t.longest}` : 'need you') : 'need you · nobody is waiting';
  return `<div class="us-card wide us-today" tabindex="0" role="group" aria-labelledby="usToday"><h3 id="usToday">Today in the garden <span>from the sessions listed · Israel day</span></h3><div class="us-facts">
      ${fact(`tokens today · ${ore}`, usB(t.tokens))}
      ${fact(`pull requests opened today · ${n(t.blooms, 'sunflower', 'sunflowers')} by the fence (${t.maxBlooms} at most)`, usInt(t.prs))}
      ${fact(`automated runs today · ${n(t.boats, 'paper boat', 'paper boats')} on the stream (${t.maxBoats} at most)`, usInt(t.runs))}
      ${fact(comet, t.comet ? 'yes' : 'no')}
      ${fact(wait, usInt(t.waiting))}
    </div></div>`;
}
/** Tiles, charts and facts for the chosen period, or the counting progress. @param {any} d */
function usBody(d) {
  if (!d) return usWait(0, 0) + todayHtml();
  if (!d.ready) return (d.error ? `<div class="us-wait">${esc(d.error)}</div>` : usWait(d.progress.done, d.progress.total)) + todayHtml();
  /** @type {Record<string, (n: number) => string>} */
  const F = { i:usInt, b:usB, d:usDur };
  const p = d.periods[us.per], T = p.tokens;
  /** @param {number} v @param {string} f @param {string} label @param {string} sub */
  const tile = (v, f, label, sub) => `<div class="us-tile"><div class="us-big num" data-n="${v}" data-f="${f}">${F[f](v)}</div><span class="us-lbl">${label}</span><span class="us-lbl">${sub}</span></div>`;
  /** @type {any[]} */
  const days = d.days.slice(-(/** @type {Record<string, number>} */ ({ today:7, '7d':7, '30d':30 })[us.per] || d.days.length));
  const perDay = usCols(days.map(x => ({ v:x[3], now:x[0] === d.today, tip:`${usDay(x[0])}: ${x[1]} sessions, ${x[2]} requests, ${usB(x[3])} tokens` })),
    `Tokens per day, ${days.length} days`, days.length ? [usDay(days[0][0]), usDay(days[days.length - 1][0])] : []);
  const hb = usTop(p.hours), hours = usCols(p.hours.map((/** @type {number} */ v, /** @type {number} */ h) => ({ v, now:v && h === hb, tip:`${String(h).padStart(2, '0')}:00: ${v} requests` })), 'Requests by hour of day', ['00', '06', '12', '18', '23']);
  /** @param {number} v */
  const ent = p.entry, en = ent.desktop + ent.terminal + ent.other, pc = v => en ? Math.round(v / en * 100) + '%' : '-';
  /** @param {string} label @param {string} v */
  const fact = (label, v) => `<div><b>${v}</b><span class="us-lbl">${label}</span></div>`;
  const anyHour = p.hours.some(Boolean), fav = p.models[0];
  return `<div class="us-tiles">
      ${tile(p.sessions, 'i', 'Sessions', `${usInt(p.memoryRuns)} memory-save runs left out`)}
      ${tile(p.answered, 'i', 'Requests answered', `of ${usInt(p.prompts)} prompts`)}
      ${tile(p.planDone, 'i', 'Plan steps done', 'task-list steps checked off')}
      ${tile(p.prs, 'i', 'PRs opened', `${usInt(p.commits)} commit runs (est.)`)}
      ${tile(T.input + T.output + T.cacheWrite, 'b', 'Tokens', `+ ${usB(T.cacheRead)} cache reads`)}
      ${tile(p.turn.median, 'd', 'Usual turn', `p90 ${usDur(p.turn.p90)}`)}
    </div>
    <div class="us-grid">
      ${todayHtml()}
      <div class="us-card"><h3>Tokens per day <span>${us.per === 'today' ? 'last 7 days' : days.length + ' days'} · today in orange</span></h3>${perDay}</div>
      <div class="us-card"><h3>Requests by hour <span>Israel time · busiest in orange</span></h3>${hours}</div>
      <div class="us-card"><h3>Token split</h3>${usRows([['Output', T.output], ['Input', T.input], ['Cache write', T.cacheWrite], ['Cache read', T.cacheRead]], usB)}</div>
      <div class="us-card"><h3>Models <span>tokens</span></h3>${usRows(p.models.map((/** @type {any[]} */ m) => [m[0].replace(/^claude-/, ''), m[2]]), usB)}</div>
      <div class="us-card"><h3>Top tools <span>${usInt(p.toolCalls)} calls</span></h3>${usRows(p.tools, usInt)}</div>
      <div class="us-card"><h3>Top projects <span>sessions</span></h3>${usRows(p.projects, usInt)}</div>
      <div class="us-card wide"><h3>Odds and ends</h3><div class="us-facts">
        ${fact('median active time per session', usDur(p.active.median))}
        ${fact('longest session' + (p.longest ? ` · ${esc(p.longest.project)}, ${usDay(p.longest.day)}` : ''), p.longest ? usDur(p.longest.active) : '-')}
        ${fact('files edited', usInt(p.filesEdited))}
        ${fact('commands run', usInt(p.commands))}
        ${fact('subagents launched', usInt(p.subagents))}
        ${fact('busiest hour', anyHour ? String(hb).padStart(2, '0') + ':00' : '-')}
        ${fact('busiest weekday', anyHour ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][usTop(p.weekdays)] : '-')}
        ${fact(`day streak now · longest ${d.streak.longest}`, d.streak.current + (d.streak.current === 1 ? ' day' : ' days'))}
        ${fact('favourite model, by replies', fav ? esc(fav[0].replace(/^claude-/, '')) : '-')}
        ${fact('sessions in desktop app / terminal', `${pc(ent.desktop)} / ${pc(ent.terminal)}`)}
      </div></div>
    </div>
    <p class="us-note">Sessions: conversations with at least one prompt from you; automatic memory-save runs are left out. Requests answered: your prompts that got a text reply and were not interrupted. Plan steps: task-list steps marked done. PRs: <span class="mono">gh pr create</span> calls that returned a PR link. Commit runs (est.): <span class="mono">git commit</span> commands that did not fail. Tokens: input + output + cache writes, subagents included; cache reads shown apart. Turn: prompt to last reply, any pause over 30 min counted as 30 min. Days and hours in Israel time; streaks count days with a prompt.</p>`;
}
// Tiles already show their final numbers; as decoration they count up from zero over 0.7 s, and a late frame (throttled page) ends the count.
function usCount() {
  /** @type {Record<string, (n: number) => string>} */
  const F = { i:usInt, b:usB, d:usDur };
  const els = /** @type {HTMLElement[]} */ ([...usBox.querySelectorAll('[data-n]')]), t0 = performance.now(), gen = ++us.gen;
  let prev = t0;
  /** @param {number} now */
  const step = now => {
    if (gen !== us.gen || !us.open) return;
    let k = Math.max(0, Math.min(1, (now - t0) / 700)); if (now - prev > LATE) k = 1; prev = now;
    const e = 1 - (1 - k) ** 3; els.forEach(el => el.textContent = F[/** @type {string} */ (el.dataset.f)](+(/** @type {string} */ (el.dataset.n)) * e)); if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
/** Redraw the panel, keeping focus on the same control. */
function usRender() {
  const f = /** @type {HTMLElement | null} */ (document.activeElement), keep = f && usBox.contains(f) ? f.dataset.usp || f.dataset.us : null, d = us.data;
  usBox.innerHTML = usHead(d) + usBody(d) + (us.legend ? `<p class="us-foot"><a href="${LEGEND}" target="_blank" rel="noopener" class="us-legend">Legend</a></p>` : '');
  if (keep) { const el = /** @type {HTMLElement | null} */ (usBox.querySelector(`[data-usp="${keep}"], [data-us="${keep}"]`)); if (el) el.focus(); }
  if (us.anim && d && d.ready) { us.anim = false; if (!isReduced()) usCount(); }
}
/** The day streak the panel shows, for the garden's nest; null while the server is still counting or cannot be reached. */
export async function streakNow() {
  if (!REAL) return usDemo().streak.current;
  try { const d = await (await fetch('api/stats')).json(); return d && d.ready && d.streak ? d.streak.current : null; } catch (e) { return null; }
}
// Fetch the numbers; poll every second while the server is still counting, once more while it refreshes.
async function usLoad() {
  clearTimeout(us.timer);
  if (!REAL) { us.data = usDemo(); return usRender(); }
  let d;
  try { const r = await fetch('api/stats'); d = await r.json(); if (r.status === 404) d = { error:'Restart the local server to turn on statistics.' }; }
  catch (e) { d = { error:'Local server not reachable.' }; }
  if (!us.open) return;
  const same = us.data && us.data.ready && d.ready && us.data.computedAt === d.computedAt && us.data.updating === d.updating;
  if (!(d.error && us.data && us.data.ready)) us.data = d;
  if (!same) usRender();
  if (!d.error && !d.ready) us.timer = setTimeout(usLoad, 1000);
  else if (d.updating) us.timer = setTimeout(usLoad, 3000);
}
function usOpen() {
  us.open = true; us.anim = true; us.ov = document.body.style.overflow; document.body.style.overflow = 'hidden';
  usShade.hidden = usBox.hidden = false; usRender(); usBox.focus(); usLoad(); legendCheck();
}
// The Legend link shows once its page answers; asked once per page load.
async function legendCheck() {
  if (us.legend !== null) return; us.legend = false;
  try { const r = await fetch(LEGEND, { cache:'no-store' }); us.legend = r.ok; if (r.body) r.body.cancel().catch(() => {}); } catch (e) { us.legend = false; }
  if (us.legend && us.open) usRender();
}
function usClose() {
  us.open = false; clearTimeout(us.timer); usShade.hidden = usBox.hidden = true; document.body.style.overflow = us.ov; usBtn.focus();
}
/** Put the Stats button after the header summary, add the panel to the page and wire its controls. */
export function initStats() {
  $('sum').after(usBtn); document.body.append(usShade, usBox);
  usBtn.addEventListener('click', usOpen);
  usShade.addEventListener('click', usClose);
  usBox.addEventListener('keydown', e => {
    const c = /** @type {HTMLElement} */ (e.target); if (!c.matches || !c.matches('.us-cols')) return;
    const step = /** @type {Record<string, number>} */ ({ ArrowRight:1, ArrowLeft:-1, Home:-Infinity, End:Infinity })[e.key]; if (!step) return;
    e.preventDefault(); usPick(c, step);
  });
  usBox.addEventListener('mouseover', e => { const b = /** @type {HTMLElement} */ (e.target); if (b.matches && b.matches('.us-cols i')) usPick(/** @type {HTMLElement} */ (b.parentElement), 0, b); });
  usBox.addEventListener('click', e => {
    const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button')); if (!b) return;
    if (b.dataset.us === 'close') usClose();
    else if (b.dataset.usp && b.dataset.usp !== us.per) { us.per = b.dataset.usp; try { localStorage.setItem('statsPeriod', us.per); } catch (e) {} us.anim = true; usRender(); }
  });
  // Esc closes the panel before the drawer sees it; Tab stays inside the panel.
  document.addEventListener('keydown', e => {
    if (!us.open) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); usClose(); return; }
    if (e.key !== 'Tab') return;
    const f = /** @type {HTMLElement[]} */ ([...usBox.querySelectorAll('button, a[href], [tabindex="0"]')]), a = document.activeElement; if (!f.length) return;
    if (!usBox.contains(a) || (e.shiftKey && (a === f[0] || a === usBox))) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); }
    else if (!e.shiftKey && a === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }, true);
}
