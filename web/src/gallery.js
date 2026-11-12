// @ts-check
// Art gallery: every sprite sheet the app draws, built by the app's own sprite code; catalog() is shared with tools/art_sheet.mjs.
import { ART, BODIES, COL, HN, MINER, POSES, PROPS, ROD, TOOLS, fishSprite, minerSheet, miniSheet, poseSheet, propSheet, rockSheet, sheet } from './sprites.js';

/** Tile backgrounds: page light, page dark, garden grass. */
export const BACKS = { light: '#f1f6ea', dark: '#172016', grass: '#74c15c' };
export const ORES = [['gold', '#ffd447'], ['ice', '#6fe0ff']];
/** @typedef {{label: string, src: string, sw: number, sh: number, fx: number, fw: number, fh: number, copy: string}} Tile */
/** @typedef {{title: string, note: string, tiles: Tile[]}} Section */

/** One frame of a sheet: label, sheet URL and size, frame x offset and size, text to copy. @returns {Tile} */
const tile = (/** @type {string} */ label, /** @type {string} */ src, /** @type {number} */ sw, /** @type {number} */ sh, /** @type {number} */ fx, /** @type {number} */ fw, /** @type {number} */ fh, copy = '') => ({ label, src, sw, sh, fx, fw, fh, copy });
/** Text of one frame as it appears in its art file. @param {string} file @param {string} frame */
export const gridText = (file, frame) => `[frame ${frame}]\n${ART[file].frames[frame].join('\n')}\n`;
/** Colour-set line as it appears in its art file. @param {string} file @param {number} n */
const setText = (file, n) => { const s = ART[file].colours[n]; return `${s.name} ${Object.entries(s.values).map(([k, v]) => k + '=' + v).join(' ')}\n`; };
/** @type {Record<string, string>} */
const pics = {};
// Data URL of a w x h picture from [x, y, colour] pixels, cached by key.
/** @param {string} k @param {number} w @param {number} h @param {Array<[number, number, string]>} px */
function picture(k, w, h, px) {
  if (pics[k]) return pics[k];
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d'));
  for (const [a, b, col] of px) { x.fillStyle = col; x.fillRect(a, b, 1, 1); }
  return pics[k] = c.toDataURL();
}
/** Pixels of a letter grid in the shared palette. @param {string[]} rows */
const letters = rows => rows.flatMap((r, y) => [...r].flatMap((ch, x) => ch === '.' ? [] : [/** @type {[number, number, string]} */ ([x, y, COL[ch]])]));
/** Fish n in frame f as a data URL. @param {number} n @param {number} f */
export const fishUrl = (n, f) => picture(`fish:${n}:${f}`, 9, 6, fishSprite(n, f));

/** Every section of the gallery for one look (hat, body colour). @param {{hat: string, c: number}} [lk] @returns {Section[]} */
export function catalog(lk = { hat: HN[0], c: 0 }) {
  const { hat, c } = lk, cn = BODIES[c][2], mw = ART.miner.frames.raise[0].length;
  return [
    { title: 'Hats', note: `every hat on ${cn}; hats.txt`, tiles: [...HN, 'none'].map(h => tile(h, poseSheet(h, c), 160, 15, 0, 16, 15, h === 'none' ? '' : gridText('hats', h))) },
    { title: 'Body colours', note: 'bare head; body.txt [colours]', tiles: BODIES.map((b, n) => tile(b[2], poseSheet('none', n), 160, 15, 0, 16, 15, setText('body', n))) },
    { title: 'Garden poses', note: `${hat} on ${cn}; frame order of the pose sheet; body.txt + legs.txt`, tiles: POSES.map(([l, body], n) => tile(l, poseSheet(hat, c), 160, 15, n * 16, 16, 15, gridText('body', body))) },
    { title: 'List sprites', note: 'two-frame sheets for list rows, sleeping and glad', tiles: [['', 'list'], ['sleep', 'asleep'], ['glad', 'glad']].flatMap(([st, l]) =>
      ['stand', 'step'].map((leg, f) => tile(`${l} ${leg}`, sheet(hat, st, c), 32, 15, f * 16, 16, 15, gridText(f ? 'legs' : 'body', f ? leg : st === 'glad' ? 'glad' : st ? 'shut' : 'stand')))) },
    { title: 'Subagent minis', note: 'hatless, glad, every body colour', tiles: BODIES.map((b, n) => tile(b[2], sheet('none', 'glad', n), 32, 15, 0, 16, 15)) },
    { title: 'Miners', note: 'pickaxe from miner.txt over the character', tiles: [...MINER.map(([p], f) => tile(p, minerSheet(hat, c), 2 * mw, 15, f * mw, mw, 15, gridText('miner', p))),
      ...HN.map((h, i) => tile(h, minerSheet(h, i % BODIES.length), 2 * mw, 15, 0, mw, 15))] },
    { title: 'Ore rock', note: 'rock.txt in both ore colours', tiles: ORES.flatMap(([n, o]) => ['glint', 'sparkle'].map((fr, f) => tile(`${n} ${fr}`, rockSheet(o), 20, 8, f * 10, 10, 8, gridText('rock', fr)))) },
    { title: 'Fish', note: 'fish.txt in four colours', tiles: ART.fish.colours.flatMap((s, n) => ['swim', 'flick'].map((fr, f) => tile(`${s.name} ${fr}`, fishUrl(n, f), 9, 6, 0, 9, 6, gridText('fish', fr)))) },
    { title: 'Long wait', note: `sits on a stump after a while, naps after an hour; legs.txt [frame sit], props.txt`, tiles: [tile('stump', propSheet(['stump']), 12, 4, 0, 12, 4, gridText('props', 'stump')),
      ...(/** @type {const} */ (['sit', 'nap'])).map(r => tile(r, poseSheet(hat, c, r), 160, 15, 0, 16, 15, r === 'sit' ? gridText('legs', 'sit') : ''))] },
    { title: 'Miner tools', note: 'tests pan for gold, builds swing a mallet; miner.txt', tiles: ['hammer', 'pan'].flatMap(t => TOOLS[t].map(([p], f) => tile(p, minerSheet(hat, c, t), 2 * mw, 15, f * mw, mw, 15, gridText('miner', p)))) },
    { title: 'Pull request pennant', note: `small and still, in the session's body colour (${cn} here); props.txt`, tiles: [tile('flag-a', propSheet(['flag-a'], c), 5, 7, 0, 5, 7, gridText('props', 'flag-a'))] },
    { title: 'Day-old wait', note: 'body greyed, hat in full colour, under a grey-blue blanket; props.txt', tiles: [tile('nap muted', poseSheet(hat, c, 'nap', '', true), 160, 15, 0, 16, 15), tile('blanket', propSheet(['blanket']), 16, 4, 0, 16, 4, gridText('props', 'blanket'))] },
    { title: 'Umbrella', note: 'held in rain or snow by waiting characters (not anglers or miners), canopy in the body colour; props.txt', tiles: BODIES.map((b, n) => tile(b[2], propSheet(['umbrella'], n), 11, 14, 0, 11, 14, n ? '' : gridText('props', 'umbrella'))) },
    { title: 'Mini props', note: 'lens to look, paper to write, crate for the rest; props.txt', tiles: PROPS.map(p => tile(p, miniSheet(p, c), 32, 15, 0, 16, 15, gridText('props', p))) },
    { title: 'Rod parts', note: 'rod.txt; the pole and line are drawn along a curve', tiles: /** @type {const} */ (['float', 'reel', 'bang']).map(k => { const g = ROD[k]; return tile(k, picture('rod:' + k, g[0].length, g.length, letters(g)), g[0].length, g.length, 0, g[0].length, g.length, gridText('rod', k)); }) },
  ];
}
/** All 80 looks as rows of body colours by columns of hats. */
export const allLooks = () => BODIES.map((b, c) => HN.map(h => ({ hat: h, c, name: `${h} / ${b[2]}`, src: poseSheet(h, c) })));
/** Animated previews at the app's speeds (classic motion): frames of a sheet, ms per frame, optional 1px bob period. @param {{hat: string, c: number}} lk */
export function anims(lk) {
  const { hat, c } = lk, P = poseSheet(hat, c), mw = ART.miner.frames.raise[0].length;
  return [
    { label: 'standing (bob 1.4 s)', src: P, sw: 160, sh: 15, fw: 16, fh: 15, frames: [0], ms: 1400, bob: 1400 },
    { label: 'hover (cheer, bob .5 s)', src: P, sw: 160, sh: 15, fw: 16, fh: 15, frames: [6], ms: 500, bob: 500 },
    { label: 'walking (.32 s)', src: P, sw: 160, sh: 15, fw: 16, fh: 15, frames: [0, 1], ms: 160 },
    { label: 'glad walk (.32 s)', src: P, sw: 160, sh: 15, fw: 16, fh: 15, frames: [8, 9], ms: 160 },
    { label: 'fish caught', src: P, sw: 160, sh: 15, fw: 16, fh: 15, frames: [8], ms: 1000 },
    { label: 'list row, working (.32 s)', src: sheet(hat, '', c), sw: 32, sh: 15, fw: 16, fh: 15, frames: [0, 1], ms: 160 },
    { label: 'mining (.7 s)', src: minerSheet(hat, c), sw: 2 * mw, sh: 15, fw: mw, fh: 15, frames: [0, 1], ms: 350 },
    { label: 'sitting (bob 2 s)', src: poseSheet(hat, c, 'sit'), sw: 160, sh: 15, fw: 16, fh: 15, frames: [0], ms: 2000, bob: 2000 },
    { label: 'napping (bob 3 s)', src: poseSheet(hat, c, 'nap'), sw: 160, sh: 15, fw: 16, fh: 15, frames: [0], ms: 3000, bob: 3000 },
    { label: 'hammering (.7 s)', src: minerSheet(hat, c, 'hammer'), sw: 2 * mw, sh: 15, fw: mw, fh: 15, frames: [0, 1], ms: 350 },
    { label: 'panning (1.2 s)', src: minerSheet(hat, c, 'pan'), sw: 2 * mw, sh: 15, fw: mw, fh: 15, frames: [0, 1], ms: 600 },
    { label: 'fish on the line (70 ms)', src: fishUrl(c % 4, 0), alt: fishUrl(c % 4, 1), sw: 9, sh: 6, fw: 9, fh: 6, frames: [0, 1], ms: 70 },
  ];
}

// Page: toolbar, sections, animated previews and the 80-look grids, redrawn when a control changes.
/** @param {HTMLElement} root */
export function mount(root) {
  const ui = { bg: 'light', scale: 10, hat: HN[0], c: 0 };
  try { Object.assign(ui, JSON.parse(localStorage.getItem('gallery') || '{}')); } catch (e) {}
  /** @param {string} tag @param {Record<string, any>} [props] @param {Array<Node | string>} [kids] */
  const h = (tag, props = {}, kids = []) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  /** Background-image box showing frame fx of a sheet at scale s. @param {any} t @param {number} s @param {number} fx */
  const pix = (t, s, fx) => h('div', { className: 'pix', style: `width:${t.fw * s}px;height:${t.fh * s}px;background-image:url(${t.src});background-size:${t.sw * s}px ${t.sh * s}px;background-position:${-fx * s}px 0` });
  /** Copies text to the clipboard, with a textarea fallback. @param {string} text @param {HTMLElement} b */
  const copy = async (text, b) => {
    try { await navigator.clipboard.writeText(text); } catch (e) { const ta = h('textarea', { value: text }); document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
    const was = b.textContent; b.textContent = 'copied'; setTimeout(() => { b.textContent = was; }, 1200);
  };
  /** @type {number[]} */
  let timers = [];
  const draw = () => {
    try { localStorage.setItem('gallery', JSON.stringify(ui)); } catch (e) {}
    timers.forEach(clearInterval); timers = [];
    document.body.dataset.bg = ui.bg; document.body.style.setProperty('--tile', BACKS[/** @type {keyof BACKS} */ (ui.bg)]);
    const sel = (/** @type {string} */ k, /** @type {Array<[any, string]>} */ opts) => h('select', { onchange: (/** @type {any} */ e) => { /** @type {any} */ (ui)[k] = isNaN(+e.target.value) ? e.target.value : +e.target.value; draw(); } },
      opts.map(([v, l]) => h('option', { value: v, textContent: l, selected: /** @type {any} */ (ui)[k] === v })));
    const bar = h('div', { className: 'bar' }, [
      h('label', {}, ['Background ', sel('bg', Object.keys(BACKS).map(k => [k, k]))]), h('label', {}, ['Scale ', sel('scale', [8, 10, 12].map(n => [n, n + 'x']))]),
      h('label', {}, ['Hat ', sel('hat', HN.map(n => [n, n]))]), h('label', {}, ['Colour ', sel('c', BODIES.map((b, n) => [n, b[2]]))])]);
    const lk = { hat: ui.hat, c: ui.c };
    const anim = h('section', {}, [h('h2', { textContent: 'In motion' }, [h('small', { textContent: ` ${ui.hat} / ${BODIES[ui.c][2]} at the app's speeds` })]),
      h('div', { className: 'row' }, anims(lk).map(a => {
        const box = pix(a, ui.scale, 0), t0 = performance.now();
        timers.push(setInterval(() => {
          const t = performance.now() - t0, f = a.frames[Math.floor(t / a.ms) % a.frames.length];
          if (a.alt) box.style.backgroundImage = `url(${f ? a.alt : a.src})`; else box.style.backgroundPosition = `${-f * a.fw * ui.scale}px 0`;
          box.style.translate = a.bob && t % a.bob >= a.bob / 2 ? `0 ${-ui.scale}px` : '';
        }, 20));
        return h('figure', {}, [h('div', { className: 'well' }, [box]), h('figcaption', { textContent: a.label })]);
      }))]);
    const secs = catalog(lk).map(s => h('section', {}, [h('h2', { textContent: s.title }, [h('small', { textContent: ' ' + s.note })]),
      h('div', { className: 'row' }, s.tiles.map(t => h('figure', {}, [h('div', { className: 'well' }, [pix(t, ui.scale, t.fx)]), h('figcaption', { textContent: t.label }),
        ...(t.copy ? [h('button', { textContent: t.copy.startsWith('[frame') ? 'copy grid' : 'copy line', title: t.copy, onclick: (/** @type {any} */ e) => copy(t.copy, e.target) })] : [])])))]));
    const looks = allLooks();
    const grids = h('section', {}, [h('h2', { textContent: 'All 80 looks at app size' }, [h('small', { textContent: ' rows: body colours, columns: hats; --px 4 garden, 3 small screens, 2 list rows' })]),
      ...[4, 3, 2].map(px => h('div', { className: 'row' }, Object.entries(BACKS).map(([bn, bg]) => h('figure', {}, [
        h('div', { className: 'looks', style: `background:${bg};grid-template-columns:repeat(${HN.length},${16 * px}px);gap:${2 * px}px ${3 * px}px;padding:${3 * px}px` },
          looks.flat().map(l => { const d = pix({ src: l.src, sw: 160, sh: 15, fw: 16, fh: 15 }, px, 0); d.title = l.name; return d; })),
        h('figcaption', { textContent: `--px ${px} on ${bn}` })]))))]);
    root.replaceChildren(bar, anim, ...secs, grids);
  };
  draw();
}
