// @ts-check
// Pure rules from session state to what a character does: sit or nap after a long wait, the miner's tool, a PR pennant, a mini's prop.

/** @typedef {import('./types.js').Session} Session */
/** Session plus the optional server facts: newest tool, whether it failed, pull requests opened, interactive or headless. @typedef {Session & { lastTool?: string, lastError?: boolean, prOpened?: number, kind?: string }} Rich */
const EDITS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;  // tools that build files: hammer
const SHELL = /^(Bash|Shell|PowerShell)$/;  // tools whose command text says what runs

export const FRESH_MIN = 5, SIT_MIN = 15, NAP_MIN = 60, STALE_MIN = 1440;  // minutes of waiting: a fresh wait stands out until FRESH_MIN, then sits, dozes off, recedes under a blanket
const TESTS = /\b(tests?|testing|pytest|jest|vitest|mocha|unittest|spec|specs|suite|coverage|e2e|lint\w*|type ?check\w*)\b/i;  // work that checks things: panning for gold
const BUILD = /\b(build|builds|building|compil\w*|install\w*|bundl\w*|webpack|vite|cargo|gradle|maven|docker\w*|deploy\w*)\b/i;  // work that builds things: hammer
const PR = /\bpull request\b|\bPR\s?#?\d+|\/pull\/\d+|\b(opened|open|created|raised|updated)\s+(a|the|draft)?\s*PR\b|\bgh pr create\b/i;  // a pull request was opened or named
const LOOK = /\b(search\w*|find\w*|explor\w*|investigat\w*|look\w*|read\w*|review\w*|audit\w*|check|checks|checking|locat\w*|scan\w*|trace|tracing|inspect\w*)\b/i;  // subagent hunts for something: lens
const WRITE = /\b(writ\w*|draft\w*|doc\w*|summar\w*|report\w*|plan\w*|note\w*|explain\w*|describ\w*|outline\w*)\b/i;  // subagent writes something: paper

/** How long a waiting session has waited, in minutes: since waitingSince when the server sends it, else its last status change or message, whichever is newer. @param {Session & { waitingSince?: number }} s @param {number} now */
export const waitedMin = (s, now) => Math.max(0, (now - (s.waitingSince && s.waitingSince > 0 ? s.waitingSince : Math.max(s.statusAt || 0, s.updated || 0))) / 60000);
/** Plain waiting time for the hover bubble and the accessible label: "waiting 12 min", "waiting 2 h 5 min", "waiting 3 days". @param {Session} s @param {number} now */
export const waitLabel = (s, now) => {
  const m = Math.floor(waitedMin(s, now)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return 'waiting ' + (m < 1 ? 'under a minute' : m < 60 ? m + ' min' : h < 24 ? h + ' h' + (m % 60 ? ' ' + m % 60 + ' min' : '') : d + (d === 1 ? ' day' : ' days'));
};
/** Resting pose of a waiting character: '' stands, 'sit' on a stump after SIT_MIN, 'nap' after NAP_MIN. @param {Session} s @param {number} now @returns {'' | 'sit' | 'nap'} */
export const restOf = (s, now) => { if (s.status !== 'waiting') return ''; const m = waitedMin(s, now); return m >= NAP_MIN ? 'nap' : m >= SIT_MIN ? 'sit' : ''; };
/** True while a waiting session started waiting less than FRESH_MIN minutes ago: the newest waits are the easiest to spot. @param {Session} s @param {number} now */
export const freshOf = (s, now) => s.status === 'waiting' && waitedMin(s, now) < FRESH_MIN;
/** True when a waiting session has waited a day or more: it naps under a blanket, so stale sessions read as stale. @param {Session} s @param {number} now */
export const staleOf = (s, now) => s.status === 'waiting' && waitedMin(s, now) >= STALE_MIN;
/** Tool a working session holds: 'pan' for tests and lint, 'hammer' for builds and file edits, else 'pick'; by lastTool when the server sends it (shell commands by their text), else by what it last said. @param {Rich} s @returns {'pick' | 'pan' | 'hammer'} */
export const toolOf = s => {
  const t = String(s.last || ''), byText = TESTS.test(t) ? 'pan' : BUILD.test(t) ? 'hammer' : 'pick', tool = typeof s.lastTool === 'string' ? s.lastTool : null;
  if (tool === null || !tool) return byText;
  return SHELL.test(tool) ? byText : TESTS.test(tool.replace(/[_-]/g, ' ')) ? 'pan' : EDITS.test(tool) ? 'hammer' : 'pick';
};
/** True when the session opened a pull request: prOpened when the server sends it, else its last words name one. @param {Rich} s */
export const hasPr = s => typeof s.prOpened === 'number' ? s.prOpened > 0 : PR.test([s.ask, s.last].join(' '));
/** True when a waiting session's newest tool result was an error, so its bubble shows a calm red "!". @param {Rich} s */
export const troubled = s => s.status === 'waiting' && s.lastError === true;
/** Prop a subagent mini holds, from its task: 'lens' to look, 'paper' to write, else 'crate'. @param {string} task @returns {'lens' | 'paper' | 'crate'} */
export const propOf = task => LOOK.test(task) ? 'lens' : WRITE.test(task) ? 'paper' : 'crate';
