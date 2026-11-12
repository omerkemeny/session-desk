// Contact sheet: renders the gallery's sections and the 80-look grids into one PNG, no browser. Usage: node tools/art_sheet.mjs out.png [--scale 8] [--bg light|dark|grass]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { images, install, rgb } from './canvas_stub.mjs';

install();
const { BACKS, allLooks, anims, catalog } = await import('../web/src/gallery.js');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'art-sheet.png', S = +arg('--scale', 8), BG = arg('--bg', 'light');
const PAGE = rgb('#fafbf8'), INK = rgb('#1f2b1c'), MUTED = rgb('#5a6955'), LINE = rgb('#cbd8be'), W = 1800;

// 3x5 pixel font, rows top to bottom.
const FONT = Object.fromEntries(Object.entries({
  A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.', E: '### #.. ##. #.. ###', F: '### #.. ##. #.. #..', G: '.## #.. #.# #.# .##',
  H: '#.# #.# ### #.# #.#', I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.', K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###', M: '#.# ### ### #.# #.#', N: '##. #.# #.# #.# #.#',
  O: '.#. #.# #.# #.# .#.', P: '##. #.# ##. #.. #..', Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#', S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.', U: '#.# #.# #.# #.# ###',
  V: '#.# #.# #.# #.# .#.', W: '#.# #.# ### ### #.#', X: '#.# #.# .#. #.# #.#', Y: '#.# #.# .#. .#. .#.', Z: '### ..# .#. #.. ###', 0: '### #.# #.# #.# ###', 1: '.#. ##. .#. .#. ###',
  2: '##. ..# .#. #.. ###', 3: '##. ..# .#. ..# ##.', 4: '#.# #.# ### ..# ..#', 5: '### #.. ##. ..# ##.', 6: '.## #.. ### #.# ###', 7: '### ..# .#. .#. .#.', 8: '### #.# ### #.# ###',
  9: '### #.# ### ..# ##.', '-': '... ... ### ... ...', '.': '... ... ... ... .#.', ':': '... .#. ... .#. ...', '/': '..# ..# .#. #.. #..', '(': '.#. #.. #.. #.. .#.', ')': '.#. ..# ..# ..# .#.',
  ',': '... ... ... .#. #..', ';': '... .#. ... .#. #..', '!': '.#. .#. .#. ... .#.', '"': '#.# #.# ... ... ...', '+': '... .#. ### .#. ...', '=': '... ### ... ### ...', '?': '##. ..# .#. ... .#.', ' ': '... ... ... ... ...',
  '[': '##. #.. #.. #.. ##.', ']': '.## ..# ..# ..# .##', '*': '... #.# .#. #.# ...', '_': '... ... ... ... ###', "'": '.#. .#. ... ... ...',
}).map(([k, v]) => [k, v.split(' ')]));

/** @type {Array<(px: (x: number, y: number, c: number[]) => void) => void>} */
const ops = [];
let H = 0;
const rect = (x, y, w, h, c) => ops.push(px => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) px(i, j, c); });
/** Width of text at font scale f. */
const textW = (s, f) => s.length * 4 * f;
const text = (s, x, y, f, c) => [...s.toUpperCase()].forEach((ch, n) => (FONT[ch] || FONT['?']).forEach((r, j) => [...r].forEach((b, i) => { if (b === '#') rect(x + (n * 4 + i) * f, y + j * f, f, f, c); })));
/** Copies frame (fx, 0, fw, fh) of a stub image to (dx, dy) at scale s, skipping transparent pixels. */
const blit = (src, fx, fw, fh, dx, dy, s) => ops.push(px => {
  const im = images.get(src); if (!im) throw new Error('not a stub image ' + src);
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) { const o = (y * im.w + fx + x) * 4; if (im.data[o + 3]) { const c = [im.data[o], im.data[o + 1], im.data[o + 2]]; for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) px(dx + x * s + i, dy + y * s + j, c); } }
});
// Lays tiles left to right, wrapping at W; each tile is a box(w, h) drawn at (x, y); returns the bottom edge.
function flow(y0, items) {
  let x = 24, y = y0, rowH = 0;
  for (const { w, h, draw } of items) { if (x + w > W - 24 && x > 24) { x = 24; y += rowH + 16; rowH = 0; } draw(x, y); x += w + 16; rowH = Math.max(rowH, h); }
  return y + rowH;
}
/** One sprite frame on a tile background with its label under it. */
const tileBox = (t, bg, s) => {
  const fw = t.fw * s, w = Math.max(fw + 16, textW(t.label, 2) + 8, 48), h = 15 * s + 16 + 16;
  return { w, h, draw: (x, y) => { const bh = 15 * s + 16; rect(x - 1, y - 1, w + 2, bh + 2, LINE); rect(x, y, w, bh, bg); blit(t.src, t.fx, t.fw, t.fh, x + Math.floor((w - fw) / 2), y + bh - 8 - t.fh * s, s); text(t.label, x + Math.floor((w - textW(t.label, 2)) / 2), y + bh + 5, 2, MUTED); } };
};

const bg = rgb(BACKS[BG] || BACKS.light);
let y = 20;
text('Session Desk sprites', 24, y, 4, INK); text(`scale ${S}, tiles on ${BG}; from web/art/*.txt via web/src/sprites.js`, 24, y + 28, 2, MUTED); y += 56;
const lk = { hat: 'wizard', c: 0 };
const motion = { title: 'Animated previews (one frame each)', note: 'see gallery.html for motion', tiles: anims(lk).flatMap(a => a.frames.map(f => ({ label: `${a.label.split(' (')[0]} ${f}`, src: a.alt && f ? a.alt : a.src, fx: a.alt ? 0 : f * a.fw, fw: a.fw, fh: a.fh }))) };
for (const sec of [...catalog(lk), motion]) {
  text(sec.title, 24, y, 3, INK); text(sec.note, 24 + textW(sec.title, 3) + 12, y + 4, 2, MUTED); y += 24;
  y = flow(y, sec.tiles.map(t => tileBox(t, bg, S))) + 28;
}
text('All 80 looks at app size: rows body colours, columns hats', 24, y, 3, INK); y += 26;
const looks = allLooks();
for (const p of [4, 3, 2]) {
  y = flow(y, Object.entries(BACKS).map(([bn, c]) => {
    const w = looks[0].length * 19 * p + 3 * p, h = looks.length * 17 * p + 2 * p;
    return { w, h: h + 18, draw: (x, yy) => {
      rect(x - 1, yy - 1, w + 2, h + 2, LINE); rect(x, yy, w, h, rgb(c));
      looks.forEach((row, r) => row.forEach((l, k) => blit(l.src, 0, 16, 15, x + 3 * p + k * 19 * p, yy + 2 * p + r * 17 * p, p)));
      text(`px ${p} on ${bn}`, x, yy + h + 6, 2, MUTED);
    } };
  })) + 24;
}
H = y + 8;

// Rasterise and encode as an RGBA PNG.
const data = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) { data[i * 4] = PAGE[0]; data[i * 4 + 1] = PAGE[1]; data[i * 4 + 2] = PAGE[2]; data[i * 4 + 3] = 255; }
const put = (x, y, c) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; };
for (const op of ops) op(put);
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let r = 0; r < H; r++) data.copy(raw, r * (W * 4 + 1) + 1, r * W * 4, (r + 1) * W * 4);
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, body) => { const t = Buffer.concat([Buffer.from(type), body]), n = Buffer.alloc(4), k = Buffer.alloc(4); n.writeUInt32BE(body.length); k.writeUInt32BE(crc(t)); return Buffer.concat([n, t, k]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr.set([8, 6, 0, 0, 0], 8);
writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${OUT} (${W}x${H})`);
