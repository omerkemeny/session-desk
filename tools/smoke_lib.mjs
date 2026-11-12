// @ts-check
// Shared smoke-test plumbing: ports chosen free at run time, per-run temp folders, child processes that never outlive the run.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const kids = new Set(), dirs = new Set();

// A port the OS reports free right now on host; a fixed number from env var `name` wins when set.
export function freePort(name, host = '127.0.0.1') {
  const fixed = Number(process.env[name] || 0);
  if (fixed) return Promise.resolve(fixed);
  return new Promise((res, rej) => {
    const s = createServer(); s.unref(); s.on('error', rej);
    s.listen(0, host, () => { const a = s.address(); s.close(() => res(typeof a === 'object' && a ? a.port : 0)); });
  });
}

// A new folder under the system temp folder, removed when the run ends unless kept.
export function tempDir(/** @type {string} */ prefix, keep = false) { const d = mkdtempSync(join(tmpdir(), prefix)); if (!keep) dirs.add(d); return d; }

// Start a child in its own process group so it and every process it starts can be killed together.
export function launch(/** @type {string} */ cmd, /** @type {string[]} */ args, opts = {}) {
  const c = spawn(cmd, args, { stdio: 'ignore', ...opts, detached: true });
  kids.add(c); c.once('exit', () => kids.delete(c)); c.on('error', () => kids.delete(c));
  return c;
}

// Signal a child's whole process group (falls back to the child alone).
export function kill(/** @type {any} */ c, sig = 'SIGTERM') {
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  try { process.kill(-c.pid, sig); } catch (e) { try { c.kill(sig); } catch (e2) { /* already gone */ } }
}

// Wait for a child to exit after SIGTERM, then SIGKILL it after `ms`.
export async function stop(/** @type {any} */ c, ms = 5000) {
  if (!c || c.exitCode !== null || c.signalCode !== null) return;
  const done = new Promise(r => c.once('exit', r)); kill(c, 'SIGTERM');
  await Promise.race([done, sleep(ms)]); if (c.exitCode === null && c.signalCode === null) { kill(c, 'SIGKILL'); await Promise.race([done, sleep(2000)]); }
}

// Kill every child and remove every temp folder; synchronous so it also runs from the exit handler.
export function cleanup() {
  for (const c of kids) kill(c, 'SIGKILL');
  kids.clear();
  for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  dirs.clear();
}
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { console.log(`FAIL interrupted by ${s}`); process.exit(130); });
process.on('uncaughtException', e => { console.log('FAIL crash ' + (e && e.message)); process.exit(1); });

// First stdout line of a child matching re, or null after ms; the child's stdout must be piped.
export function readLine(/** @type {any} */ c, /** @type {RegExp} */ re, ms = 8000) {
  return new Promise(res => {
    let buf = '';
    const t = setTimeout(() => { c.stdout.off('data', on); res(null); }, ms);
    const on = (/** @type {Buffer} */ d) => { buf += d; const m = buf.match(re); if (m) { clearTimeout(t); c.stdout.off('data', on); c.stdout.resume(); res(m); } };
    c.stdout.on('data', on);
  });
}

// Headless Chrome on a debugging port it picks itself (or SMOKE_DEBUG_PORT); returns the child and the first page's websocket URL.
export async function startChrome(/** @type {string} */ profile) {
  const fixed = Number(process.env.SMOKE_DEBUG_PORT || 0);
  const chrome = launch(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${fixed}`, `--user-data-dir=${profile}`,
    '--window-size=1280,1000', 'about:blank']);
  let port = fixed, tabs;
  for (let i = 0; i < 60 && !tabs; i++) {
    await sleep(250);
    if (!port) { const f = join(profile, 'DevToolsActivePort'); if (existsSync(f)) port = Number(readFileSync(f, 'utf8').split('\n')[0]) || 0; }
    if (port) try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch (e) { /* not up yet */ }
  }
  const page = tabs && tabs.find((/** @type {any} */ t) => t.type === 'page');
  if (!page) throw new Error('Chrome did not open a debugging port');
  return { chrome, port, wsUrl: page.webSocketDebuggerUrl };
}

// Minimal DevTools protocol client: send(method, params) and on(method, handler).
export async function devtools(/** @type {string} */ wsUrl) {
  const ws = new WebSocket(wsUrl); await new Promise((r, no) => { ws.onopen = r; ws.onerror = no; });
  let id = 0; const wait = new Map(), on = new Map();
  ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else if (on.has(m.method)) on.get(m.method)(m.params); };
  const send = (/** @type {string} */ method, params = {}) => new Promise((r, no) => { wait.set(++id, (/** @type {any} */ m) => m.error ? no(new Error(method + ': ' + m.error.message)) : r(m.result)); ws.send(JSON.stringify({ id, method, params })); });
  return { ws, send, on };
}
