// @ts-check
// Soak and idle measurements: a compressed working day against the real server on invented data, the demo crowd alone, or an idle page visible then hidden.
// Usage: node tools/soak.mjs [--mode day|crowd|idle|term] [--minutes N] [--cycles N] [--quick] [--every SEC] [--drift-every SEC] [--heap] [--out FILE.json]
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sess, arg, f2, flag, heapClasses, heapDiff, makeHome, openPage, pageSample, procSample, sidOf, slope, sleep, startServer, startStatic, stop, stopTerminals, table, tempDir } from './qa_lib.mjs';

const MODE = arg('--mode', 'day'), QUICK = flag('--quick'), HEAP = flag('--heap');
const MIN = Number(arg('--minutes', QUICK ? 2 : MODE === 'day' ? 15 : MODE === 'crowd' ? 5 : 3)), EVERY = Number(arg('--every', QUICK ? 10 : 15)) * 1000;
const DRIFT_EVERY = Number(arg('--drift-every', 5)) * 1000;  // ms between forced drift checks in day mode (the page alone checks every 10th full poll)
const OUT = arg('--out', join(tempDir('qa-soak-', true), `soak-${MODE}.json`));
const log = (/** @type {string} */ s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const rnd = (/** @type {number} */ n) => Math.floor(Math.random() * n);

// Summary rows (first, last, slope per hour) for the page and server series.
function summarize(/** @type {any[]} */ ps, /** @type {any[]} */ ss) {
  const rows = [];
  const add = (/** @type {string} */ name, /** @type {any[]} */ xs, /** @type {(x: any) => number} */ get) => {
    const pts = xs.map(x => /** @type {[number, number]} */ ([x.t, get(x)])).filter(p => Number.isFinite(p[1]));
    if (!pts.length) return;
    const first = pts[0][1], last = pts[pts.length - 1][1], sl = slope(pts), grows = sl > 0 && Math.abs(sl) > Math.max(Math.abs(first) * 0.1, 1e-9) && last > first * 1.05;
    // Floors: the lowest value in the first and the last quarter of the run, so swings do not hide a rising base.
    const q = Math.max(1, Math.floor(pts.length / 4)), lo = (/** @type {Array<[number, number]>} */ xs) => Math.min(...xs.map(p => p[1]));
    rows.push([name, f2(first), f2(last), `${f2(lo(pts.slice(0, q)))} > ${f2(lo(pts.slice(-q)))}`, f2(sl), grows ? 'GROWS' : '']);
  };
  // Rates between consecutive samples: frames and CPU per wall second.
  const rate = (/** @type {any[]} */ xs, /** @type {string} */ k, /** @type {string} */ same) => xs.slice(1).map((x, i) => ({ t: x.t, v: (!same || x[same] === xs[i][same]) && x[k] >= xs[i][k] ? (x[k] - xs[i][k]) / ((x.t - xs[i].t) / 1000) : NaN }));
  add('page heap MB (after GC)', ps, x => x.heapMB); add('page DOM nodes', ps, x => x.nodes); add('page event listeners', ps, x => x.listeners);
  add('page rAF callbacks / s', rate(ps, 'raf', ''), x => x.v); add('page layouts / s', rate(ps, 'layouts', ''), x => x.v); add('page CPU s / wall s', rate(ps, 'task', ''), x => x.v);
  add('page running CSS animations', ps, x => x.anims); add('page open requests', ps, x => x.reqOpen); add('page console errors (total)', ps, x => x.errs);
  add('page live-region announcements (total)', ps, x => x.live);
  add('page drift (total)', ps, x => x.drift); add('page driftChecks (total)', ps, x => x.driftChecks);
  add('page requests (total)', ps, x => x.reqAll); add('page /api/sessions fetches (total)', ps, x => x.sessFetches);
  if (ss.length) {
    add('server RSS MB', ss, x => x.rssMB); add('server CPU s / wall s', rate(ss, 'cpu', 'pid'), x => x.v); add('server open fds', ss, x => x.fds);
    add('server threads', ss, x => x.threads); add('server TCP established', ss, x => x.tcp);
    const hs = ss.filter(x => x.host); if (hs.length) { add('termhost RSS MB', hs.map(x => ({ t: x.t, ...x.host })), x => x.rssMB); add('termhost open fds', hs.map(x => ({ t: x.t, ...x.host })), x => x.fds); }
  }
  return rows;
}

// Sample loop helper: page plus optional server and host pids.
async function sampleAll(/** @type {any} */ pg, /** @type {any} */ srv, /** @type {any[]} */ ps, /** @type {any[]} */ ss) {
  try { ps.push(await pageSample(pg)); } catch (e) { log('page sample failed: ' + /** @type {Error} */ (e).message); }
  if (srv && srv.proc && srv.proc.pid) {
    const s = procSample(srv.proc.pid); let host = null;
    try { const h = await (await fetch(srv.url + 'api/health')).json(); if (h.termhost && h.termhost.pid) host = procSample(h.termhost.pid); } catch (e) { /* down */ }
    if (s) ss.push({ ...s, pid: srv.proc.pid, host });
  }
}

// The working day: data changes every second, UI actions every 20 s, two server restarts.
async function day() {
  const h = makeHome({ bench: 120, bigMb: 30 });
  const p0 = join(h.home, 'projects', '-bench-p0'), big = readdirSync(p0).filter(f => f.endsWith('.jsonl')).map(f => join(p0, f)).sort((a, b) => statSync(b).size - statSync(a).size)[0];
  const bigS = new Sess(h.home, '-bench-p0', big.split('/').pop().slice(0, -6), '/bench/p0', 'big'); bigS.live('busy');
  const live = /** @type {Sess[]} */ ([]); let next = 0;
  const spawnS = () => { const i = next++, s = new Sess(h.home, '-qa-live', sidOf(i), h.work, `Invented task ${i} for the soak`); s.turn('user', `please do invented step ${i}`); s.turn('assistant', `Done with step ${i}. Shall I go on?`); s.live(i % 3 ? 'idle' : 'busy'); live.push(s); };
  for (let i = 0; i < 10; i++) spawnS();
  let srv = await startServer(h.env);
  log(`server ${srv.url} pid ${srv.proc.pid}; big transcript ${(statSync(big).size / 2 ** 20).toFixed(1)} MB`);
  const pg = await openPage(srv.url, { dark: true });
  await sleep(4000);
  const heap0 = HEAP ? await heapClasses(pg) : null;
  const ps = /** @type {any[]} */ ([]), ss = /** @type {any[]} */ ([]), t0 = Date.now(), end = t0 + MIN * 60000, restarts = [t0 + (end - t0) / 3, t0 + 2 * (end - t0) / 3];
  let tick = 0, nextSample = t0, nextDrift = t0 + DRIFT_EVERY, driftErr = 0, opened = 0, termOpens = 0, actions = { open: 0, term: 0, stats: 0, search: 0, restart: 0, appear: 0, finish: 0, flips: 0 }, actErr = 0;
  const filler = 'invented filler text '.repeat(100);
  while (Date.now() < end) {
    tick++;
    // Data changes: two transcripts get a line, the big one grows by about 2 KB.
    for (let k = 0; k < 2 && live.length; k++) { const s = live[rnd(live.length)]; s.turn(rnd(2) ? 'assistant' : 'user', `invented progress line ${tick}`); }
    bigS.turn('assistant', filler);
    if (tick % 8 === 0 && live.length) { const s = live[rnd(live.length)], busy = rnd(2) === 0; if (!busy) s.turn('assistant', `Finished part ${tick}. Next?`); s.live(busy ? 'busy' : 'idle'); actions.flips++; }
    if (tick % 60 === 0) { spawnS(); actions.appear++; const gone = live.splice(rnd(live.length - 1), 1)[0]; gone.live(null); actions.finish++; }
    // UI: every 20 s open a sidebar on a different session, alternate tabs, sometimes Stats and search.
    try {
      if (tick % 20 === 3) {
        const view = opened % 2 ? 'term' : 'log'; opened++;
        await pg.ev(`const bs = [...document.querySelectorAll('button[data-id]')]; const b = bs[${opened} % Math.max(1, bs.length)]; if (b) b.click(); return !!b;`); await sleep(600);
        await pg.ev(`document.querySelector('[data-view="${view}"]')?.click(); return 1;`); actions.open++;
        if (view === 'term') { actions.term++; termOpens++; }
      }
      if (tick % 20 === 11) {
        if (opened % 2 === 0 && termOpens % 3 === 0) await pg.ev(`document.querySelector('[data-act="endterm"]')?.click(); return 1;`);
        await pg.ev(`document.querySelector('[data-act="close"]')?.click(); return 1;`);
      }
      if (tick % 60 === 14) { await pg.ev(`document.querySelector('.us-btn')?.click(); return 1;`); actions.stats++; }
      if (tick % 60 === 19) await pg.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); const x = document.querySelector('.us .us-x'); if (x && !document.querySelector('.us').hidden) x.click(); return 1;`);
      if (tick % 40 === 15) { await pg.ev(`const s = document.getElementById('search'); s.value = 'invented ${tick % 7}'; s.dispatchEvent(new Event('input', { bubbles: true })); return 1;`); actions.search++; }
      if (tick % 40 === 18) await pg.ev(`const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return 1;`);
    } catch (e) { actErr++; }
    // Drift guard: force the page's whole-list comparison every few seconds; differences the feed does not name within 3 s count as drift.
    if (Date.now() >= nextDrift) { nextDrift += DRIFT_EVERY; try { await pg.ev(`await window.desk.checkDrift(); return 1;`); } catch (e) { driftErr++; } }
    if (restarts.length && Date.now() > restarts[0]) {
      restarts.shift(); const port = srv.port; await stop(srv.proc, 5000); await sleep(1500); srv = await startServer(h.env, port); actions.restart++; log(`server restarted, pid ${srv.proc.pid}`);
    }
    if (Date.now() >= nextSample) { nextSample += EVERY; await sampleAll(pg, srv, ps, ss); const l = ps[ps.length - 1]; if (l) log(`heap ${l.heapMB.toFixed(1)} MB, nodes ${l.nodes}, listeners ${l.listeners}, errs ${l.errs}`); }
    await sleep(1000);
  }
  await sleep(3500); await sampleAll(pg, srv, ps, ss);  // the last check's 3 s wait for the feed ends before the final sample
  const heap = heap0 ? heapDiff(heap0, await heapClasses(pg)) : null;
  const last = ps[ps.length - 1] || {}, drift = { drift: last.drift, driftChecks: last.driftChecks, every: DRIFT_EVERY / 1000, callErrors: driftErr };
  const errs = pg.errs.slice(0, 10), liveBy = ps.length ? ps[ps.length - 1].liveBy : {}, openReqs = ps.length ? ps[ps.length - 1].reqBy : '';
  await pg.close(); await stop(srv.proc, 5000); stopTerminals(h.env);
  return { ps, ss, heap, extra: { actions, actErr, errs, liveBy, openReqs, bigMB: statSync(big).size / 2 ** 20 }, drift };
}

// Demo crowd: the garden alone with ?crowd=14, sampled only.
async function crowd() {
  const st = await startStatic(), pg = await openPage(st.url + '?crowd=14', { dark: true }); await sleep(4000);
  const heap0 = HEAP ? await heapClasses(pg) : null;
  const ps = /** @type {any[]} */ ([]), end = Date.now() + MIN * 60000;
  while (Date.now() < end) { await sampleAll(pg, null, ps, []); await sleep(EVERY); }
  await sampleAll(pg, null, ps, []);
  const heap = heap0 ? heapDiff(heap0, await heapClasses(pg)) : null;
  const errs = pg.errs.slice(0, 10); await pg.close(); await stop(st.proc, 3000);
  return { ps, ss: [], heap, extra: { errs } };
}

// Idle: nothing changes; visible for MIN minutes, then the tab hidden for MIN minutes.
async function idle() {
  const h = makeHome();
  for (let i = 0; i < 6; i++) { const s = new Sess(h.home, '-qa-idle', sidOf(i), h.work, `Idle invented task ${i}`); s.turn('user', 'invented ask'); s.turn('assistant', 'Invented reply. Go on?'); s.live(i < 4 ? 'idle' : 'busy'); }
  const srv = await startServer(h.env), pg = await openPage(srv.url, { dark: true, width: 1280 }); await sleep(5000);
  const phase = async (/** @type {string} */ name) => {
    const ps = /** @type {any[]} */ ([]), ss = /** @type {any[]} */ ([]), end = Date.now() + MIN * 60000;
    while (Date.now() < end) { await sampleAll(pg, srv, ps, ss); await sleep(EVERY); }
    await sampleAll(pg, srv, ps, ss); return { name, ps, ss };
  };
  const heap0 = HEAP ? await heapClasses(pg) : null;
  const vis = await phase('visible');
  const heap = heap0 ? heapDiff(heap0, await heapClasses(pg)) : null;
  const self = (await pg.send('Target.getTargetInfo')).targetInfo.targetId, waiter = new Sess(h.home, '-qa-idle', sidOf(4), h.work, 'Idle invented task 4'); waiter.n = 50;
  // Hide the tab: a second tab in front; falls back to a script-level visibility override when headless keeps both visible.
  let how = 'second tab in front';
  const t = await pg.send('Target.createTarget', { url: 'about:blank', newWindow: false, background: false }); await pg.send('Target.activateTarget', { targetId: t.targetId }); await sleep(1500);
  let hidden = await pg.ev('return document.hidden;');
  if (!hidden) { await pg.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await pg.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {}); hidden = await pg.ev('return document.hidden;'); }
  if (!hidden) { how = 'script override of document.hidden + visibilitychange'; await pg.ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); return 1;`); }
  // While hidden: a working session writes a line every 30 s and turns waiting half-way, so the feed pushes changes.
  let n = 0; const tick = setInterval(() => { n++; waiter.turn('assistant', `invented hidden progress ${n}`); if (n === Math.ceil(MIN * 1)) waiter.live('idle'); }, 30000);
  const title0 = await pg.ev('return document.title;'), hid = await phase('hidden'); clearInterval(tick);
  const title1 = await pg.ev('return document.title;'), before = pg.net.by['/api/sessions'] || 0, rows0 = await pg.ev(`return document.querySelectorAll('.lists .row.running').length;`);
  // Show the tab again: exactly one catch-up fetch is expected.
  if (how === 'second tab in front') { await pg.send('Target.activateTarget', { targetId: self }); await pg.send('Target.closeTarget', { targetId: t.targetId }); }
  else await pg.ev(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); return 1;`);
  await sleep(5000);
  const shown = { hiddenNow: await pg.ev('return document.hidden;'), fetches5s: (pg.net.by['/api/sessions'] || 0) - before, runningRowsHidden: rows0, runningRowsShown: await pg.ev(`return document.querySelectorAll('.lists .row.running').length;`), titleHidden: title0 === title1 ? 'unchanged' : 'changed' };
  const errs = pg.errs.slice(0, 10); await pg.close(); await stop(srv.proc, 5000); stopTerminals(h.env);
  return { phases: [vis, hid], heap, extra: { how, errs, changesWhileHidden: n, shown } };
}

// Terminal cycles: open the Terminal tab, wait for the stub CLI, End terminal, close; heap and DOM nodes after GC every 5 cycles.
async function term() {
  const h = makeHome(), N = Number(arg('--cycles', QUICK ? 10 : 20));
  for (let i = 0; i < 3; i++) { const s = new Sess(h.home, '-qa-term', sidOf(i), h.work, `Term invented task ${i}`); s.turn('user', 'invented ask'); s.turn('assistant', 'Invented reply. Go on?'); if (i < 2) s.live('idle'); }
  const srv = await startServer(h.env), pg = await openPage(srv.url, { dark: true, width: 1280 }); await sleep(4000);
  const until = async (/** @type {string} */ cond, ms = 10000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await pg.ev(`return !!(${cond});`)) return true; await sleep(100); } return false; };
  let slow = 0;
  const cycle = async () => {
    await pg.ev(`document.querySelector('.lists .row[data-id="${sidOf(2)}"]')?.click(); return 1;`); await until(`!document.getElementById('drawer').hidden && !document.querySelector('#drawer.closing') && window.desk.st.open === '${sidOf(2)}' && document.querySelector('#drawer [data-view="term"]')`);
    await pg.ev(`document.querySelector('#drawer [data-view="term"]')?.click(); return 1;`);
    if (!await until(`/cli ready/.test(document.querySelector('#xt .xterm-rows')?.textContent || '')`)) slow++;
    await pg.ev(`document.querySelector('[data-act="endterm"]')?.click(); return 1;`); await until(`document.getElementById('term')`);
    await pg.ev(`document.querySelector('[data-act="close"]')?.click(); return 1;`); await until(`document.getElementById('drawer').hidden`); await sleep(300);
  };
  for (let i = 0; i < 3; i++) await cycle();
  const heap0 = HEAP ? await heapClasses(pg) : null;
  const ps = [await pageSample(pg)];
  for (let i = 1; i <= N; i++) { await cycle(); if (i % 5 === 0) { ps.push(await pageSample(pg)); log(`cycle ${i}: nodes ${ps[ps.length - 1].nodes}, heap ${ps[ps.length - 1].heapMB.toFixed(2)} MB`); } }
  await sleep(1500); const fin = await pageSample(pg); const heap = heap0 ? heapDiff(heap0, await heapClasses(pg)) : null;
  const errs = pg.errs.filter(e => !/Failed to load resource/.test(e)).slice(0, 10); await pg.close(); await stop(srv.proc, 5000); stopTerminals(h.env);
  return { ps, fin, heap, extra: { cycles: N, slow, errs } };
}

// Heap class table: the classes whose self size grew most from start to end.
function printHeap(/** @type {any} */ rows) {
  if (!rows) return;
  console.log('\nheap snapshot, start > end (self size by class, after GC; top growth)');
  console.log(table(['class', 'count 0', 'count 1', 'd count', 'KB 0', 'KB 1', 'd KB'], rows));
}

try {
  log(`mode ${MODE}, ${MIN} min, sample every ${EVERY / 1000} s`);
  if (MODE === 'term') {
    const r = await term();
    console.log(`\nterminal cycles (${r.extra.cycles}, after 3 warm-up cycles; sample every 5)`);
    console.log(table(['after cycles', 'DOM nodes', 'heap MB', 'listeners', 'open requests'], r.ps.map((p, i) => [i * 5, p.nodes, f2(p.heapMB), p.listeners, p.reqOpen])));
    console.log(`DOM nodes per cycle: ${f2((r.ps[r.ps.length - 1].nodes - r.ps[0].nodes) / r.extra.cycles)}, heap KB per cycle: ${f2((r.ps[r.ps.length - 1].heapMB - r.ps[0].heapMB) * 1024 / r.extra.cycles)}; 1.5 s later: nodes ${r.fin.nodes}, open requests ${r.fin.reqOpen}`);
    console.log('extra: ' + JSON.stringify(r.extra));
    printHeap(r.heap); writeFileSync(OUT, JSON.stringify(r));
  } else if (MODE === 'idle') {
    const r = await idle();
    for (const p of r.phases) { console.log(`\n${p.name} (${MIN} min, no data changes)`); console.log(table(['metric', 'first', 'last', 'floor q1 > q4', 'slope/h', ''], summarize(p.ps, p.ss))); }
    console.log('\nhidden by: ' + r.extra.how + `; ${r.extra.changesWhileHidden} data changes while hidden` + (r.extra.errs.length ? '\nerrors: ' + JSON.stringify(r.extra.errs) : ''));
    console.log('shown again: ' + JSON.stringify(r.extra.shown));
    printHeap(r.heap); writeFileSync(OUT, JSON.stringify(r));
  } else {
    const r = MODE === 'crowd' ? await crowd() : await day();
    console.log(`\n${MODE} soak, ${MIN} min, ${r.ps.length} samples`);
    console.log(table(['metric', 'first', 'last', 'floor q1 > q4', 'slope/h', ''], summarize(r.ps, r.ss)));
    console.log('\nextra: ' + JSON.stringify(r.extra));
    printHeap(r.heap); writeFileSync(OUT, JSON.stringify(r));
    // Day mode fails when the patched list drifted from the full one, or when the checks did not run.
    const d = /** @type {any} */ (r).drift;
    if (d) { console.log(`drift ${d.drift}, driftChecks ${d.driftChecks} (forced every ${d.every} s, ${d.callErrors} failed calls)`); if (!(d.drift === 0 && d.driftChecks > 0)) { console.log('FAIL drift above 0 or no drift checks'); console.log('samples: ' + OUT); process.exit(1); } }
  }
  console.log('samples: ' + OUT);
  process.exit(0);
} catch (e) { console.log('FAIL tool error: ' + /** @type {Error} */ (e).stack); process.exit(1); }
