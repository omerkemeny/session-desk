// @ts-check
// Accessibility audit without libraries: names, Tab order and focus rings, keyboard traps (the terminal's F6 way out tried), text contrast, live regions, reduced motion, garden labels.
// Since round 9 also: grouped tool lines and the Details switch in the Transcript tab, the mine's "+N" plaque, "Show N more" and door notes (32 working sessions, two open twice).
// Usage: node tools/a11y.mjs [--quick] [--order all] [--out FILE.json]   (real server on invented data, free ports)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sess, arg, flag, makeHome, media, toolSession, openPage, sidOf, sleep, startServer, stop, stopTerminals, table, tempDir } from './qa_lib.mjs';

const QUICK = flag('--quick'), ORDER_ALL = arg('--order', '') === 'all', OUT = arg('--out', join(tempDir('qa-a11y-', true), 'a11y.json'));
const ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'combobox', 'tab', 'menuitem', 'switch', 'slider', 'spinbutton', 'radio', 'option', 'listbox', 'img', 'dialog']);

// In-page helpers: element description and the contrast walk.
const LIB = `
const desc = e => { if (!e || e === document.body) return 'body'; const c = [...(e.classList || [])].slice(0, 3).join('.'); const lab = e.getAttribute && (e.getAttribute('aria-label') || '');
  const txt = (lab || e.textContent || e.placeholder || '').replace(/\\s+/g, ' ').trim().slice(0, 38); return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (c ? '.' + c : '') + (e.dataset && e.dataset.id ? '[data-id]' : '') + (txt ? ' "' + txt + '"' : ''); };
const rgba = s => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
const over = (a, b) => { const al = a[3] + b[3] * (1 - a[3]); if (!al) return [0, 0, 0, 0]; return [0, 1, 2].map(i => (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / al).concat(al); };
const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c[0]) + .7152 * f(c[1]) + .0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const bgOf = el => { let layers = [], note = ''; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage !== 'none' && !note) note = 'image-bg'; if (e.id === 'garden' && !layers.some(l => l[3] >= 1)) note = note || 'over-canvas'; const c = rgba(cs.backgroundColor); if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; } }
  let bg = [255, 255, 255, 1]; if (!layers.length || layers[layers.length - 1][3] < 1) { const r = rgba(getComputedStyle(document.documentElement).backgroundColor); bg = r && r[3] ? r : bg; } for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg); return { bg, note }; };
const vis = e => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 1 && r.height > 1 && !(cs.position === 'absolute' && cs.clip !== 'auto' && cs.clip !== '') && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05 && !e.closest('[hidden],[inert]'); };
`;

// Contrast failures of every visible text node; canvas text is out of scope.
const CONTRAST = (/** @type {string} */ scope) => `(() => { ${LIB}
  const out = [], seen = new Set(), w = document.createTreeWalker(document.querySelector(${JSON.stringify(scope)}) || document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const el = n.parentElement; if (!el || !n.textContent.trim() || seen.has(el) || !vis(el) || el.closest('.xterm, [aria-hidden=true], script, style')) continue; seen.add(el);
    const cs = getComputedStyle(el), fg0 = rgba(cs.color); if (!fg0) continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
    const { bg, note } = bgOf(el), fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bg), size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    const large = size >= 24 || (bold && size >= 18.66), need = large ? 3 : 4.5, r = ratio(fg, bg);
    if (r < need) out.push({ sel: desc(el), ratio: Math.round(r * 100) / 100, need, fg: fg.slice(0, 3).map(Math.round).join(','), bg: bg.slice(0, 3).map(Math.round).join(','), size, note });
  }
  return out; })()`;

// Interactive elements, the focusable ones, and which are visible.
const INTERACTIVE = (/** @type {string} */ scope) => `(() => { ${LIB}
  const all = [...(document.querySelector(${JSON.stringify(scope)}) || document).querySelectorAll('a[href], button, input, textarea, select, summary, [tabindex], [role=button], [role=tab], [contenteditable=""], [contenteditable=true]')].filter(vis);
  window.__qaEls = all; return all.map((e, i) => { e.__qaN = i; return { d: desc(e), k: i, ti: e.tabIndex, dis: !!e.disabled }; }); })()`;

// The focused element and whether focus changes how it looks.
const FOCUSED = `(async () => { ${LIB}
  const e = document.activeElement; if (!e || e === document.body) return { d: 'body' };
  const pick = cs => [cs.outlineStyle + cs.outlineWidth + cs.outlineColor, cs.boxShadow, cs.backgroundColor, cs.borderColor, cs.color, cs.textDecorationLine].join('|');
  const cs = getComputedStyle(e), on = pick(cs), r = e.getBoundingClientRect(), fv = e.matches(':focus-visible');
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
  const ae = document.activeElement; ae.blur(); const off = pick(getComputedStyle(e)); ae.focus({ preventScroll: true });
  return { d: desc(e), k: e.__qaN ?? -1, ring, changes: on !== off, fv, inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth, zero: r.width < 2 || r.height < 2, xterm: !!e.closest('.xterm') }; })()`;

// One key press (down and up) through the DevTools protocol.
async function press(/** @type {any} */ pg, /** @type {string} */ key, /** @type {number} */ code, shift = false) {
  for (const type of ['rawKeyDown', 'keyUp']) await pg.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0 });
  await sleep(60);
  return pg.send('Runtime.evaluate', { expression: FOCUSED, awaitPromise: true, returnByValue: true }).then((/** @type {any} */ r) => r.result.value);
}
// Walk Tab through the page from the top; stops when focus returns to the first stop or stays put. A stop inside the terminal tries the documented way out (F6) and is a trap only when focus stays; after the first way out the walk goes on backwards (Shift+Tab) so the controls after the terminal count too.
async function tabWalk(/** @type {any} */ pg, max = 120) {
  await pg.ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); return 1;`);
  const stops = []; let back = false;
  for (let i = 0; i < max; i++) {
    const f = await press(pg, 'Tab', 9, back);
    if (f.xterm) {
      const g = await press(pg, 'F6', 117);
      if (g.xterm) { stops.push({ ...f, stuck: true }); break; }
      stops.push({ ...f, escaped: g.d }); if (back) break; back = true; continue;
    }
    if (!back && stops.length && f.d === stops[0].d && stops.length > 1) break;
    if (back && stops.some(s => s.d === f.d && s.back)) break;
    if (stops.length && f.d === stops[stops.length - 1].d) { stops.push({ ...f, stuck: true }); break; }
    stops.push({ ...f, back });
  }
  return stops;
}

// Interactive roles with an empty computed name, from Chrome's accessibility tree.
async function unnamed(/** @type {any} */ pg) {
  const { nodes } = await pg.send('Accessibility.getFullAXTree');
  const bad = [];
  for (const n of nodes) {
    const role = n.role && n.role.value; if (n.ignored || !ROLES.has(role)) continue;
    if (n.name && String(n.name.value || '').trim()) continue;
    let d = role;
    try { const o = await pg.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId }); const r = await pg.send('Runtime.callFunctionOn', { objectId: o.object.objectId, functionDeclaration: `function () { ${LIB} return desc(this); }`, returnByValue: true }); d = role + ' ' + r.result.value; } catch (e) { /* detached */ }
    bad.push(d);
  }
  return bad;
}

// One context: page state set up by `open`, then names, Tab walk, contrast.
async function audit(/** @type {any} */ pg, /** @type {string} */ name, /** @type {() => Promise<void>} */ open, scope = 'body') {
  await open(); await sleep(900);
  const inter = await pg.ev(`return ${INTERACTIVE(scope)};`), names = await unnamed(pg), stops = await tabWalk(pg), contrast = await pg.ev(`return ${CONTRAST(scope)};`);
  // Reached by element identity (an expando set during the inventory), so a label that changes between inventory and walk is not counted as unreachable.
  const reached = new Set(stops.map(s => s.k)), reachedText = new Set(stops.map(s => s.d));
  const gone = await pg.ev(`return (window.__qaEls || []).map(e => !e.isConnected);`);
  const miss = inter.filter((/** @type {any} */ e) => e.ti >= 0 && !e.dis && !reached.has(e.k));
  const unreachable = miss.filter((/** @type {any} */ e) => !gone[e.k]).map((/** @type {any} */ e) => e.d), replaced = miss.filter((/** @type {any} */ e) => gone[e.k]).map((/** @type {any} */ e) => e.d);
  const byText = inter.filter((/** @type {any} */ e) => e.ti >= 0 && !e.dis && !reachedText.has(e.d)).map((/** @type {any} */ e) => e.d);
  return { name, interactive: inter.length, unnamed: names, stops, noRing: stops.filter(s => s.d !== 'body' && !s.ring && !s.changes).map(s => s.d), offscreen: stops.filter(s => s.d !== 'body' && (!s.inView || s.zero)).map(s => s.d),
    trap: stops.filter(s => s.stuck || (s.xterm && !s.escaped)).map(s => s.d), exits: stops.filter(s => s.escaped).map(s => 'F6 to ' + s.escaped), unreachable, replaced, byText, contrast };
}

const h = makeHome();
// Invented sessions: four waiting (one with a pull request link in its last reply), two working.
for (let i = 0; i < 6; i++) { const s = new Sess(h.home, '-qa-a11y', sidOf(i), h.work, `Audit invented task ${i}`); s.turn('user', `invented request ${i}`); s.turn('assistant', `Invented answer ${i}. Continue?`); s.live(i < 4 ? 'idle' : 'busy'); }
// Round 9: one waiting session with grouped tool lines, 30 more working (mine plaque, "Show N more"), two of them also open in the desktop app (door notes).
toolSession(h, 6, 'Audit invented task 6 groups');
for (let i = 10; i < 40; i++) { const s = new Sess(h.home, '-qa-a11y', sidOf(i), h.work, `Audit invented task ${i}`); s.turn('user', `invented request ${i}`); s.turn('assistant', 'Working on it.'); s.live('busy'); }
{ const { mkdirSync, writeFileSync: w } = await import('node:fs'); const reg = join(h.home, 'sessions'); mkdirSync(reg, { recursive: true }); for (const i of [10, 11]) w(join(reg, `qa-desktop-${i}.json`), JSON.stringify({ pid: process.pid, sessionId: sidOf(i), status: 'busy', statusUpdatedAt: Date.now(), entrypoint: 'claude-desktop' })); }
// Accessibility tree nodes (role, name, expanded, pressed) whose name matches re.
const axOf = async (/** @type {any} */ p, /** @type {RegExp} */ re) => (await p.send('Accessibility.getFullAXTree')).nodes.filter((/** @type {any} */ n) => !n.ignored && re.test(n.name?.value || '') && !/StaticText|InlineTextBox/.test(n.role?.value)).map((/** @type {any} */ n) => ({ role: n.role?.value, name: String(n.name?.value).slice(0, 60), expanded: n.properties?.find((/** @type {any} */ x) => x.name === 'expanded')?.value?.value, pressed: n.properties?.find((/** @type {any} */ x) => x.name === 'pressed')?.value?.value }));
let srv, pg;
const results = [], extra = /** @type {any} */ ({});
// Wait until the garden's character count and labels stop changing (characters walk in after a load).
const settle = async (/** @type {any} */ p) => { let last = '', same = 0; for (let i = 0; i < 40 && same < 3; i++) { const k = await p.ev(`return [...document.querySelectorAll('#actors .agent')].map(a => a.getAttribute('aria-label')).join('|');`); same = k === last ? same + 1 : 0; last = k; await sleep(250); } };
try {
  srv = await startServer(h.env);
  pg = await openPage(srv.url, { dark: true, width: 1280 }); await sleep(3500);
  await pg.send('DOM.enable'); await pg.send('Accessibility.enable');
  const reload = async () => { await pg.send('Page.reload'); await sleep(3000); };
  const close = async () => { await pg.ev(`document.querySelector('[data-act="close"]')?.click(); document.querySelector('.us:not([hidden]) .us-x')?.click(); return 1;`); await sleep(400); };
  const widths = QUICK ? [1280] : [1280, 390], themes = QUICK ? [true] : [true, false];
  for (const w of widths) for (const dark of themes) {
    await pg.send('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 844 : 1000, deviceScaleFactor: 1, mobile: w < 600 });
    await media(pg.send, { dark }); await reload();
    const tag = `${w}px ${dark ? 'dark' : 'light'}`;
    results.push(await audit(pg, `${tag} main page`, async () => { await settle(pg); }));
    results.push(await audit(pg, `${tag} sidebar Transcript`, async () => { await pg.ev(`document.querySelector('.agent:not(.miner)')?.click(); return 1;`); await sleep(700); await pg.ev(`document.querySelector('[data-view="log"]')?.click(); return 1;`); }, '#drawer'));
    await close();
    const groups = async () => { await pg.ev(`document.querySelector('button.row[data-id="${sidOf(6)}"], button.agent[data-id="${sidOf(6)}"]')?.click(); return 1;`); await sleep(700); await pg.ev(`document.querySelector('[data-view="log"]')?.click(); return 1;`); await sleep(900); await pg.ev(`document.querySelectorAll('#term .grp > details.xp > summary').forEach(x => x.click()); return 1;`); };
    results.push(await audit(pg, `${tag} sidebar Transcript groups open`, groups, '#drawer'));
    if (!extra.round9) extra.round9 = { groups: await axOf(pg, /shell command|Read \d+ file/) };
    results.push(await audit(pg, `${tag} sidebar Transcript Details on`, async () => { await pg.ev(`document.querySelector('[data-details]')?.click(); return 1;`); }, '#drawer'));
    if (!extra.round9.details) extra.round9.details = await axOf(pg, /^Details$/);
    await pg.ev(`document.querySelector('[data-details][aria-pressed="true"]')?.click(); return 1;`); await sleep(300);
    await close();
    if (!extra.round9.more) { extra.round9.more = await axOf(pg, /Show \d+ more/); extra.round9.plaque = await axOf(pg, /room at the mine|working|\+\d/i).then(x => x.filter(n => n.role === 'image' || n.role === 'img').slice(0, 3));
      extra.round9.notes = await pg.ev(`return { canvasHidden: document.getElementById('bg').getAttribute('aria-hidden'), named: [...document.querySelectorAll('#garden [aria-label], #garden [title]')].filter(x => /note|twice|out of step/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))).length, rowBadges: [...document.querySelectorAll('.lists .row')].filter(r => /open twice/.test(r.textContent)).length };`); }
    results.push(await audit(pg, `${tag} sidebar Terminal`, async () => { await pg.ev(`document.querySelector('.agent:not(.miner)')?.click(); return 1;`); await sleep(700); await pg.ev(`document.querySelector('[data-view="term"]')?.click(); return 1;`); await sleep(1500); }, '#drawer'));
    await close();
    results.push(await audit(pg, `${tag} Stats panel`, async () => { await pg.ev(`document.querySelector('.us-btn')?.click(); return 1;`); await sleep(2500); }, '.us'));
    await close();
  }
  // Legend page: names, heading order, Tab walk and contrast in both themes and widths, then reduced motion.
  for (const w of widths) for (const dark of themes) {
    const lg = await openPage(srv.url + 'legend.html', { width: w, height: w < 600 ? 844 : 1000, dark }); await sleep(2500); await lg.send('DOM.enable'); await lg.send('Accessibility.enable');
    const r = await audit(lg, `${w}px ${dark ? 'dark' : 'light'} Legend page`, async () => {});
    r.headings = await lg.ev(`const hs = [...document.querySelectorAll('h1,h2,h3,h4')].map(x => +x.tagName[1]); let j = 0; for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) j++; return { count: hs.length, h1: hs.filter(x => x === 1).length, jumps: j, first: hs[0] };`);
    results.push(r); await lg.close();
  }
  { const lg = await openPage(srv.url + 'legend.html', { dark: true, reduced: true }); await sleep(2500); const r0 = await lg.ev(`return __qa.raf;`); await sleep(4000);
    extra.legendReduced = await lg.ev(`return { raf4s: __qa.raf - ${r0}, anims: document.getAnimations().filter(a => a.playState === 'running').length };`); await lg.close(); }
  // Announcements when a working session starts waiting: count live-region changes over 20 s (one polite announcement expected, not one per poll).
  await reload(); await settle(pg);
  const a0 = await pg.ev(`return { n: __qa.liveTotal, by: { ...__qa.live } };`);
  const turner = new Sess(h.home, '-qa-a11y', sidOf(4), h.work, 'Audit invented task 4'); turner.n = 10; turner.turn('assistant', 'Invented finish. Shall I go on?'); turner.live('idle');
  await sleep(20000);
  const said = (/** @type {any} */ a) => pg.ev(`const b = ${JSON.stringify(a.by)}; const d = {}; for (const [k, v] of Object.entries(__qa.live)) if (v - (b[k] || 0)) d[k] = v - (b[k] || 0); return { total: __qa.liveTotal - ${a.n}, by: d, title: document.title, regions: [...document.querySelectorAll('[aria-live]:not([aria-live=off]), [role=status], [role=alert]')].map(e => (e.id ? '#' + e.id : e.className) + '=' + (e.textContent || '').trim().slice(0, 60)) };`);
  extra.announce = await said(a0);
  // Then two quiet minutes with nothing changing: polls and the safety poll must announce nothing.
  const a1 = await pg.ev(`return { n: __qa.liveTotal, by: { ...__qa.live } };`); await sleep(120000);
  extra.quiet = await said(a1);
  // Garden character labels must carry title, state and waiting time.
  await pg.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }); await media(pg.send, { dark: true }); await reload();
  extra.labels = await pg.ev(`return [...document.querySelectorAll('#actors .agent')].map(a => ({ miner: a.classList.contains('miner'), role: a.getAttribute('role') || a.tagName.toLowerCase(), label: a.getAttribute('aria-label') || '', desc: (document.getElementById(a.getAttribute('aria-describedby') || '') || {}).textContent || '' }));`);
  extra.labelProblems = extra.labels.filter((/** @type {any} */ l) => !/Audit invented task \d/.test(l.label) || (l.miner ? !/working/.test(l.label) : !/needs your answer/.test(l.label) || !/(wait|min|hour|second|just now|under a minute|\d)/.test(l.label)));
  extra.liveRegions = await pg.ev(`return [...document.querySelectorAll('[aria-live], [role=status], [role=alert], [role=log]')].map(e => (e.id ? '#' + e.id : e.className) + ' ' + (e.getAttribute('aria-live') || e.getAttribute('role')));`);
  // Reduced motion: CSS animations still running and rAF callbacks over 5 s.
  await media(pg.send, { dark: true, reduced: true }); await reload();
  const r0 = await pg.ev(`return __qa.raf;`); await sleep(5000);
  extra.reduced = await pg.ev(`return { raf5s: __qa.raf - ${r0}, anims: document.getAnimations().filter(a => a.playState === 'running').map(a => (a.animationName || a.id || 'script') + ' on ' + (a.effect && a.effect.target ? (a.effect.target.id ? '#' + a.effect.target.id : a.effect.target.className) : '?')) };`);
  await pg.ev(`document.querySelector('.agent:not(.miner)')?.click(); return 1;`); await sleep(1200);
  const r1 = await pg.ev(`return __qa.raf;`); await sleep(5000);
  extra.reducedSidebar = await pg.ev(`return { raf5s: __qa.raf - ${r1}, anims: document.getAnimations().filter(a => a.playState === 'running').map(a => (a.animationName || a.id || 'script') + ' on ' + (a.effect && a.effect.target ? (a.effect.target.id ? '#' + a.effect.target.id : String(a.effect.target.className)) : '?')) };`);
  // Reduced motion turned on while the page is open (no reload), with the Terminal tab showing.
  await close(); await media(pg.send, { dark: true }); await reload();
  await pg.ev(`document.querySelector('.agent:not(.miner)')?.click(); return 1;`); await sleep(1500);
  const before = await pg.ev(`return document.getAnimations().filter(a => a.playState === 'running').length;`);
  await media(pg.send, { dark: true, reduced: true }); await sleep(1500);
  extra.reducedLive = await pg.ev(`return { before: ${before}, after: document.getAnimations().filter(a => a.playState === 'running').map(a => (a.animationName || a.id || 'script') + ' on ' + (a.effect && a.effect.target ? String(a.effect.target.className) : '?')), terminal: !!document.querySelector('#xt .xterm') };`);
  extra.errs = pg.errs.filter(e => !/Failed to load resource/.test(e)).slice(0, 10);
} catch (e) { console.log('FAIL tool error: ' + /** @type {Error} */ (e).stack); if (pg) await pg.close(); if (srv) await stop(srv.proc); stopTerminals(h.env); process.exit(1); }
await pg.close(); await stop(srv.proc, 5000); stopTerminals(h.env);

console.log(table(['context', 'interactive', 'unnamed', 'tab stops', 'no ring', 'offscreen', 'trap', 'unreachable', 'replaced', 'unreach. by text', 'contrast<min'],
  results.map(r => [r.name, r.interactive, r.unnamed.length, r.stops.length, r.noRing.length, r.offscreen.length, r.trap.length ? 'YES' : '', r.unreachable.length, r.replaced.length, r.byText.length, r.contrast.length])));
const main = results[0];
console.log(`\nTab order, ${main.name}:`); for (const [i, s] of main.stops.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${s.d}${s.ring || s.changes ? '' : '  [no visible focus]'}${s.inView ? '' : '  [off screen]'}`);
for (const r of results) {
  const lines = [];
  if (ORDER_ALL && r !== main) lines.push('  order: ' + r.stops.map(s => s.d).join(' > '));
  if (r.unnamed.length) lines.push('  unnamed: ' + [...new Set(r.unnamed)].join('; '));
  if (r.noRing.length) lines.push('  no visible focus: ' + [...new Set(r.noRing)].join('; '));
  if (r.offscreen.length) lines.push('  focus off screen or zero size: ' + [...new Set(r.offscreen)].join('; '));
  if (r.trap.length) lines.push('  keyboard trap at: ' + [...new Set(r.trap)].join('; '));
  if (r.exits.length) lines.push('  terminal left by: ' + [...new Set(r.exits)].join('; '));
  if (r.unreachable.length) lines.push('  not reachable by Tab: ' + [...new Set(r.unreachable)].join('; '));
  if (r.replaced.length) lines.push('  re-rendered during the walk (not a defect): ' + r.replaced.length);
  if (r.byText.length && !r.unreachable.length) lines.push('  only a text match misses (label changed during the walk): ' + [...new Set(r.byText)].slice(0, 3).join('; '));
  if (r.headings) lines.push('  headings: ' + JSON.stringify(r.headings));
  for (const c of r.contrast) lines.push(`  contrast ${c.ratio} < ${c.need}: ${c.sel} fg ${c.fg} bg ${c.bg} ${c.size}px${c.note ? ' (' + c.note + ')' : ''}`);
  if (lines.length) console.log(`\n${r.name}\n${lines.join('\n')}`);
}
console.log('\ngarden labels: ' + extra.labels.length + ' characters, problems: ' + JSON.stringify(extra.labelProblems));
console.log('example labels: ' + JSON.stringify(extra.labels.slice(0, 3).map((/** @type {any} */ l) => l.label)));
console.log('live regions: ' + JSON.stringify(extra.liveRegions));
console.log('reduced motion, main page: ' + JSON.stringify(extra.reduced));
console.log('reduced motion, sidebar open: ' + JSON.stringify(extra.reducedSidebar));
console.log('reduced motion turned on while open (Terminal tab): ' + JSON.stringify(extra.reducedLive));
console.log('Legend page, reduced motion: ' + JSON.stringify(extra.legendReduced));
console.log('announcements in 20 s after one session started waiting: ' + JSON.stringify(extra.announce));
console.log('announcements over the next 2 quiet minutes: ' + JSON.stringify(extra.quiet));
console.log('round 9 controls (accessibility tree): ' + JSON.stringify(extra.round9));
// QA round 9 item 4: group lines are disclosures named by their words only (CSS alternative text hides the open/closed glyph), with the expanded state.
const grpAx = (extra.round9 && extra.round9.groups) || [], grpOk = grpAx.length > 0 && grpAx.every((/** @type {any} */ n) => /^(Ran|Read|Searched|Called) [^▸▾]*$/.test(n.name) && typeof n.expanded === 'boolean');
console.log(`group line names without the glyph, expanded state present: ${grpOk ? 'PASS' : 'FAIL'} ` + JSON.stringify(grpAx.slice(0, 4)));
console.log('page errors: ' + JSON.stringify(extra.errs));
console.log('canvas-drawn text (sky, scenery) is out of scope for the contrast check; text over the garden canvas is marked over-canvas and measured against the garden colour, so it is approximate.');
writeFileSync(OUT, JSON.stringify({ results, extra }, null, 1)); console.log('details: ' + OUT);
process.exit(0);
