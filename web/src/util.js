// @ts-check
// Small helpers with no page state; safe to import from node tests ($ only touches the DOM when called).

export const LATE = 100; // ms between animation frames after which a counting animation jumps to its final value
/** @param {string} id @returns {any} */
export const $ = id => document.getElementById(id);
/** HTML-escape text for markup built from strings. @param {unknown} s */
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/** Stable 32-bit string hash. @param {string} s */
export const hash = s => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
/** Short count: 1.2M, 18k, 950. @param {number} n */
export const fmt = n => n >= 999500 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
/** Age of a timestamp in words. @param {number} t */
export const rel = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 60 ? m + ' min ago' : Math.round(m / 60) < 24 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
/** Blend two #rrggbb colours by k in 0..1. @param {string} a @param {string} b @param {number} k */
export const mix = (a, b, k) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k) + parseInt(b.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
/** Seeded random generator in 0..1. @param {number} a */
export function rng(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
