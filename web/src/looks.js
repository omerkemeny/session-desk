// @ts-check
// Session looks (hat and body colour) kept in this browser; garden, mine, lists and drawer all draw from them.
import { assignLooks, lookOf } from './logic.js';
import { sheet } from './sprites.js';
import { state } from './state.js';

/** A session's look: hat plus body colour. @param {string} id */
export const look = id => lookOf(state.looks, id);
/** Gives every active session a look no other active session wears, and remembers it in this browser. */
export function syncLooks() {
  const looks = state.looks;
  if (assignLooks(looks, state.S)) try { localStorage.setItem('looks', JSON.stringify(Object.fromEntries(Object.entries(looks).slice(-400)))); } catch (e) {}
}
/** Two-frame list sprite for a session, as markup. @param {string} id */
export const sprite = id => { const l = look(id); return `<span class="sprite" style="background-image:url(${sheet(l.hat, '', l.c)})"></span>`; };
