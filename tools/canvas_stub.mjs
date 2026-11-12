// Minimal 2D canvas for node: whole-pixel fillRect/clearRect into RGBA buffers; toDataURL returns a key into `images`.
/** @type {Map<string, {w: number, h: number, data: Uint8ClampedArray}>} */
export const images = new Map();
let seq = 0;

/** Parses '#rgb' or '#rrggbb' into [r, g, b]. @param {string} s */
export function rgb(s) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s));
  if (!m) throw new Error('stub canvas: unsupported colour ' + s);
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

export class StubCanvas {
  constructor(w = 300, h = 150) { this._w = w; this._h = h; this.data = new Uint8ClampedArray(w * h * 4); }
  get width() { return this._w; }
  set width(v) { this._w = v | 0; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  get height() { return this._h; }
  set height(v) { this._h = v | 0; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  getContext() {
    const cv = this; let fill = [0, 0, 0];
    /** @param {number} x @param {number} y @param {number} w @param {number} h @param {number[] | null} c */
    const rect = (x, y, w, h, c) => {
      if ([x, y, w, h].some(v => !Number.isInteger(v))) throw new Error('stub canvas: non-integer rect ' + [x, y, w, h]);
      for (let j = Math.max(0, y); j < Math.min(cv._h, y + h); j++) for (let i = Math.max(0, x); i < Math.min(cv._w, x + w); i++) {
        const o = (j * cv._w + i) * 4; if (c) { cv.data[o] = c[0]; cv.data[o + 1] = c[1]; cv.data[o + 2] = c[2]; cv.data[o + 3] = 255; } else cv.data.fill(0, o, o + 4);
      }
    };
    return {
      set fillStyle(v) { fill = rgb(v); }, get fillStyle() { return '#' + fill.map(n => n.toString(16).padStart(2, '0')).join(''); },
      fillRect: (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h) => rect(x, y, w, h, fill),
      clearRect: (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ w, /** @type {number} */ h) => rect(x, y, w, h, null),
      getImageData: () => ({ width: cv._w, height: cv._h, data: cv.data.slice() }),
    };
  }
  toDataURL() { const k = 'data:stub;' + ++seq; images.set(k, { w: this._w, h: this._h, data: this.data.slice() }); return k; }
}

/** Installs a global `document` whose createElement('canvas') returns a StubCanvas. */
export function install() {
  /** @type {any} */ (globalThis).document = { createElement: (/** @type {string} */ t) => { if (t !== 'canvas') throw new Error('stub document: ' + t); return new StubCanvas(); } };
}
