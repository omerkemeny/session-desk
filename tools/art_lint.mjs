// Checks the art files in web/art/: grid shapes, palette letters, sizes, hat slot, colour-set roles. Run: node tools/art_lint.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArt } from '../web/src/sprites.js';

export const ART_DIR = fileURLToPath(new URL('../web/art/', import.meta.url));
/** Frames and colour-set roles the sprite code reads from each file. */
const NEEDS = { body: ['stand', 'shut', 'glad', 'look-right', 'look-left', 'wave', 'cheer'], legs: ['stand', 'step', 'step2', 'sit'], miner: ['raise', 'strike', 'hammer-up', 'hammer-down', 'pan-a', 'pan-b'], props: ['stump', 'flag-a', 'lens', 'paper', 'crate'], rock: ['glint', 'sparkle'], fish: ['swim', 'flick'], rod: ['float', 'reel', 'bang'], hats: [], palette: [] };
const SETS = { body: 1, fish: 4, rock: 1, rod: 1 }, ROD_KEYS = ['pole', 'pole2', 'node', 'grip', 'grip2', 'tip', 'line', 'ring', 'drop'];

/** Lints the .txt files in dir; returns error and warning messages. @param {string} [dir] */
export function lintArt(dir = ART_DIR) {
  const errors = [], warnings = [], files = {};
  for (const f of readdirSync(dir).filter(f => f.endsWith('.txt')).sort()) {
    try { files[f.slice(0, -4)] = parseArt(readFileSync(dir + f, 'utf8'), f); } catch (e) { errors.push(e.message); }
  }
  for (const k of Object.keys(NEEDS)) if (!files[k]) errors.push(`${k}.txt is missing`);
  const shared = files.palette?.palette || {}, used = new Set();
  for (const [name, a] of Object.entries(files)) {
    const pal = a.palette || shared, mine = new Set(), roles = new Set();
    for (const fr of NEEDS[name] || []) if (!a.frames[fr]) errors.push(`${name}.txt: frame ${fr} is missing (the app draws it)`);
    for (const [fr, rows] of Object.entries(a.frames)) {
      const at = `${name}.txt [frame ${fr}]`, w = rows[0]?.length ?? 0;
      rows.forEach((r, i) => { if (r.length !== w) errors.push(`${at} row ${i + 1}: ${r.length} wide, row 1 is ${w}`); });
      for (const ch of new Set(rows.join(''))) if (ch !== '.') { mine.add(ch); if (!pal[ch]) errors.push(`${at}: letter '${ch}' is not in the ${a.palette ? 'file' : 'shared'} palette`); else if (pal[ch].role) roles.add(pal[ch].role); }
      if (a.size && (w !== a.size[0] || rows.length !== a.size[1])) errors.push(`${at}: ${w}x${rows.length}, file says size ${a.size.join('x')}`);
      if (a.fit && rows.length && (w !== a.fit[0] || rows.length > a.fit[1])) errors.push(`${at}: ${w}x${rows.length} does not fit ${a.fit.join('x')} (width ${a.fit[0]}, at most ${a.fit[1]} rows)`);
    }
    if (a.colours.length < (SETS[name] || 0)) errors.push(`${name}.txt: needs at least ${SETS[name]} colour sets, has ${a.colours.length}`);
    for (const s of a.colours) for (const r of roles) if (!s.values[r]) errors.push(`${name}.txt colour set ${s.name}: no ${r}= (the frames use @${r})`);
    if (name === 'palette') continue;
    if (a.palette) { for (const ch of Object.keys(a.palette)) if (!mine.has(ch)) warnings.push(`${name}.txt: palette letter '${ch}' is unused`); } else for (const ch of mine) used.add(ch);
  }
  for (const ch of Object.keys(shared)) if (!used.has(ch)) warnings.push(`palette.txt: letter '${ch}' (${shared[ch].note}) is not used by any grid`);
  const { body, legs, hats, rod } = files;
  if (body?.size && legs?.size && hats?.fit) {
    if (hats.fit[0] !== body.size[0] || legs.size[0] !== body.size[0]) errors.push('hats, body and legs must be equally wide');
    if (hats.fit[1] + body.size[1] + legs.size[1] !== 15) errors.push(`hat slot ${hats.fit[1]} + body ${body.size[1]} + legs ${legs.size[1]} rows must make the 15-row character`);
    if (!hats.fit[1] || !Object.keys(hats.frames).length) errors.push('hats.txt needs a fit line and at least one hat');
  }
  if (files.miner?.size && files.miner.size[1] !== 15) errors.push('miner frames must be 15 rows, the character height');
  if (rod?.colours[0]) for (const k of ROD_KEYS) if (!rod.colours[0].values[k]) errors.push(`rod.txt colour set ${rod.colours[0].name}: no ${k}=`);
  return { errors, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { errors, warnings } = lintArt();
  for (const w of warnings) console.log('warn  ' + w);
  for (const e of errors) console.log('ERROR ' + e);
  console.log(errors.length ? `${errors.length} errors` : 'art files OK');
  process.exit(errors.length ? 1 : 0);
}
