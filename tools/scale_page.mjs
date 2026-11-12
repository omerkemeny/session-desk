// @ts-check
// Page at scale: first usable render, DOM, heap, frame rate and CPU idle and busy, sidebar, search, Stats, garden and list caps; prints one JSON line.
import { appendFileSync } from 'node:fs';
import { arg, flag, openPage, pageSample, sleep } from './qa_lib.mjs';

const url = arg('--url', ''), appendTo = arg('--append', ''), bigId = arg('--big', ''), medId = arg('--median', ''), quick = flag('--quick');
const secs = quick ? 4 : 8;

// One invented row appended to a transcript, as a working session writes.
const touch = () => { if (appendTo) appendFileSync(appendTo, JSON.stringify({ type: 'system', subtype: 'turn_duration', uuid: 'pg-' + Date.now(), parentUuid: null, timestamp: new Date().toISOString(), sessionId: 'x', entrypoint: 'cli', cwd: '/scale' }) + '\n'); };

// Frames per second and page CPU share over a window, optionally with one change a second.
async function window_(/** @type {any} */ pg, busy) {
  const m0 = await pg.send('Performance.getMetrics'), r0 = await pg.ev('return __qa.raf;'), t0 = Date.now();
  for (let i = 0; i < secs; i++) { if (busy) touch(); await sleep(1000); }
  const m1 = await pg.send('Performance.getMetrics'), r1 = await pg.ev('return __qa.raf;'), dt = (Date.now() - t0) / 1000;
  const get = (/** @type {any} */ m, k) => m.metrics.find((/** @type {any} */ x) => x.name === k).value;
  return { fps: Math.round((r1 - r0) / dt), cpu: Math.round((get(m1, 'TaskDuration') - get(m0, 'TaskDuration')) / dt * 1000) / 10 };
}

// Milliseconds until a page condition holds (polled every 10 ms), or -1.
async function until(/** @type {any} */ pg, /** @type {string} */ cond, ms = 60000) {
  const r = await pg.ev(`const t0 = performance.now(); while (performance.now() - t0 < ${ms}) { if (${cond}) return Math.round(performance.now() - t0); await new Promise(r => setTimeout(r, 10)); } return -1;`);
  return r;
}

// Open the sidebar on one session (Transcript tab) and time until its lines are drawn; closes it again.
async function openSide(/** @type {any} */ pg, /** @type {string} */ id) {
  await pg.ev(`if (!document.querySelector('.lists .row[data-id="${id}"]')) document.querySelector('.lists .showmore:not([hidden])')?.click(); return 1;`); await sleep(600);
  const ok = await pg.ev(`const b = document.querySelector('.lists .row[data-id="${id}"]'); if (!b) return false; window.__t0 = performance.now(); b.click(); return true;`);
  if (!ok) return { ms: -2, lines: 0 };
  const done = await until(pg, `(() => { const t = document.getElementById('term'); return t && !/Loading whole session/.test(t.textContent) && t.children.length > 1; })()`);
  const lines = await pg.ev(`const t = document.getElementById('term'); return t ? t.querySelectorAll('*').length : 0;`);
  const total = await pg.ev('return Math.round(performance.now() - window.__t0);');
  await pg.ev(`document.getElementById('close')?.click(); return 1;`); await sleep(400);
  return { ms: done < 0 ? -1 : total, lines };
}

async function main() {
  const t0 = Date.now(), pg = await openPage(url, { width: 1440, height: 1000 });
  const out = /** @type {any} */ ({});
  try {
    const first = await until(pg, `document.querySelectorAll('.lists .row[data-id]').length > 0 && document.getElementById('sign').textContent.length > 0`, 120000);
    out.firstRenderMs = first < 0 ? -1 : Date.now() - t0;
    await sleep(3000);
    const s = await pageSample(pg);
    out.nodes = s.nodes; out.heapMb = Math.round(s.heapMB * 10) / 10;
    const idle = await window_(pg, false), busy = await window_(pg, true);
    Object.assign(out, { idleFps: idle.fps, idleCpuPct: idle.cpu, busyFps: busy.fps, busyCpuPct: busy.cpu });
    const g = await pg.ev(`const S = await (await fetch('/api/sessions')).json();
      return { chars: document.querySelectorAll('#actors .agent:not(.miner)').length, miners: document.querySelectorAll('#actors .agent.miner').length, sign: document.getElementById('sign').textContent.trim(),
        running: S.filter(x => x.status === 'running').length, waiting: S.filter(x => x.status === 'waiting').length, rowsHeld: S.length,
        rowsDrawn: document.querySelectorAll('.lists .row[data-id]').length, more: [...document.querySelectorAll('.lists .more, .lists .showmore, .lists .amore, .lists .fold')].filter(x => !x.hidden && x.offsetParent).map(x => x.textContent.trim()).join(' | ') };`);
    Object.assign(out, g);
    const big = await openSide(pg, bigId), med = await openSide(pg, medId);
    Object.assign(out, { openBigMs: big.ms, bigLines: big.lines, openMedianMs: med.ms });
    out.searchMs = await pg.ev(`const q = document.getElementById('search'), h = document.getElementById('hits'), before = document.querySelectorAll('.lists .row[data-id]').length;
      const t0 = performance.now(); q.focus(); q.value = 'zzqx'; q.dispatchEvent(new Event('input', { bubbles: true }));
      while (performance.now() - t0 < 10000) { await new Promise(r => requestAnimationFrame(r)); if (document.querySelectorAll('.lists .row[data-id]:not(.gone)').length !== before || !h.hidden) break; }
      const ms = Math.round(performance.now() - t0); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); return ms;`);
    await sleep(500);
    out.statsMs = await pg.ev(`const b = document.querySelector('.us-btn'); const t0 = performance.now(); b.click();
      while (performance.now() - t0 < 30000) { await new Promise(r => setTimeout(r, 10)); if (document.querySelector('.us-card')) break; } const ms = Math.round(performance.now() - t0); b.click(); return ms;`);
    out.errs = pg.errs.length; out.errList = pg.errs.slice(0, 3);
  } finally { await pg.close(); }
  console.log(JSON.stringify(out));
}
main().catch(e => { console.log(JSON.stringify({ error: String(e && e.stack || e) })); process.exit(1); });
