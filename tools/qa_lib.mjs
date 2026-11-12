// @ts-check
// QA plumbing on top of smoke_lib: invented data folders, a real server on a free port, a page with probes, and process/page samplers.
import { appendFileSync, chmodSync, cpSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devtools, launch, readLine, sleep, startChrome, stop, tempDir } from './smoke_lib.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url)), APP = join(HERE, '..');
export const arg = (/** @type {string} */ k, /** @type {any} */ d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
export const flag = (/** @type {string} */ k) => process.argv.includes(k);
const WEATHER = JSON.stringify({ current: { temperature_2m: 21, weather_code: 1, cloud_cover: 10 }, hourly: { time: [], precipitation: [] }, utc_offset_seconds: 7200, daily: { sunrise: ['2026-11-11T06:10'], sunset: ['2026-11-11T16:50'] } });

// One transcript line in the CLI's JSON form (user or assistant), invented text only.
export function line(/** @type {string} */ kind, /** @type {string} */ uid, /** @type {string|null} */ parent, /** @type {string} */ cwd, /** @type {any} */ content, extra = {}) {
  const r = { type: kind, uuid: uid, parentUuid: parent, isSidechain: false, timestamp: new Date().toISOString(), entrypoint: 'cli', cwd, sessionId: 'x', gitBranch: 'main', userType: 'external', ...extra };
  r.message = kind === 'user' ? { role: 'user', content } : { id: 'm' + uid, type: 'message', role: 'assistant', model: 'model-x', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 5 } };
  return JSON.stringify(r) + '\n';
}

// Invented session writer: creates a transcript in project dir, appends turns, flips its registry status.
export class Sess {
  constructor(/** @type {string} */ home, /** @type {string} */ proj, /** @type {string} */ sid, /** @type {string} */ cwd, /** @type {string} */ title) {
    Object.assign(this, { home, sid, cwd, n: 0, last: /** @type {string|null} */ (null) });
    this.dir = join(home, 'projects', proj); mkdirSync(this.dir, { recursive: true }); this.file = join(this.dir, sid + '.jsonl');
    if (!existsSync(this.file)) writeFileSync(this.file, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: sid }) + '\n');
  }
  // Append one prompt or one reply.
  turn(/** @type {'user'|'assistant'} */ kind, /** @type {string} */ text) {
    const u = `${this.sid.slice(0, 8)}-${++this.n}`; appendFileSync(this.file, line(kind, u, this.last, this.cwd, text)); this.last = u;
  }
  // Write or remove the live-process registry entry for this session.
  live(/** @type {'busy'|'idle'|null} */ status, pid = process.pid) {
    const d = join(this.home, 'sessions'), f = join(d, `qa-${this.sid}.json`); mkdirSync(d, { recursive: true });
    if (!status) { rmSync(f, { force: true }); return; }
    const tmp = f + '.tmp'; writeFileSync(tmp, JSON.stringify({ pid, sessionId: this.sid, status, statusUpdatedAt: Date.now(), entrypoint: 'cli' }));
    renameSync(tmp, f);
  }
}

// A uuid-shaped id from a number, so runs are repeatable.
export const sidOf = (/** @type {number} */ i) => `aa${String(i).padStart(6, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`;

// Stub CLI: interactive mode registers itself idle and echoes lines; -p mode appends a reply to the transcript, or fails when the text contains FAIL.
export function stubCli(/** @type {string} */ dir) {
  const p = join(dir, 'stub-cli');
  writeFileSync(p, `#!/usr/bin/env python3
import glob, json, os, sys, time
log, home = os.environ.get("QA_STUB_LOG"), os.environ.get("DESK_CLAUDE_DIR", "")
sid = sys.argv[sys.argv.index("--resume") + 1] if "--resume" in sys.argv else ""
if "-p" in sys.argv:
    text = sys.stdin.read()
    if log:
        open(log, "a").write("reply:" + sid + ":" + text + "\\n")
    if "FAIL" in text:
        print("stub refused: invented failure", flush=True); sys.exit(3)
    for f in glob.glob(os.path.join(home, "projects", "*", sid + ".jsonl")):
        ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
        for kind, body in (("user", text), ("assistant", [{"type": "text", "text": "stub answer " + text[:30]}])):
            msg = {"role": kind, "content": body} if kind == "user" else {"id": "m" + str(time.time()), "type": "message", "role": "assistant", "model": "model-x", "content": body, "usage": {"input_tokens": 1, "output_tokens": 1}}
            open(f, "a").write(json.dumps({"type": kind, "uuid": kind + str(time.time()), "parentUuid": None, "isSidechain": False, "timestamp": ts, "entrypoint": "sdk-cli", "cwd": os.getcwd(), "message": msg}) + "\\n")
    print("stub answer", flush=True); sys.exit(0)
reg = os.path.join(home, "sessions", "stub-%d.json" % os.getpid())
if home and sid:
    os.makedirs(os.path.dirname(reg), exist_ok=True)
    json.dump({"pid": os.getpid(), "sessionId": sid, "status": "idle", "statusUpdatedAt": int(time.time() * 1000), "entrypoint": "cli"}, open(reg, "w"))
print("cli ready", os.getpid(), flush=True)
try:
    for line in sys.stdin:
        if line.strip() == "EXIT3":
            sys.exit(3)
        print("got " + line.strip(), flush=True)
finally:
    try:
        os.remove(reg)
    except OSError:
        pass
`); chmodSync(p, 0o755); return p;
}

// Fresh data folder: fixture copy plus optional bench data; returns paths and env for server.py.
export function makeHome({ bench = 0, bigMb = 0 } = {}) {
  const home = tempDir('qa-home-'), state = tempDir('qa-state-'), work = tempDir('qa-work-');
  cpSync(join(APP, 'tests', 'fixtures', 'home'), home, { recursive: true });
  if (bench) {
    const r = spawnSync('python3', [join(HERE, 'bench_home.py'), home, '--count', String(bench), '--big', bigMb ? '1' : '0', '--big-mb', String(bigMb || 1), '--turns', '4'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('bench_home failed: ' + r.stderr);
    rmSync(join(home, 'sessions'), { recursive: true, force: true });
  }
  const cli = stubCli(state), log = join(state, 'stub.log');
  const env = { ...process.env, DESK_CLAUDE_DIR: home, DESK_STATE_DIR: state, DESK_CLAUDE_BIN: cli, QA_STUB_LOG: log };
  return { home, state, work, cli, log, env };
}

// server.py on a free port (or the given one), waiting until health answers; app is another copy of the app folder.
export async function startServer(/** @type {any} */ env, port = 0, app = APP) {
  const proc = launch('python3', [join(app, 'server.py')], { cwd: app, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, PORT: String(port) } });
  const m = await readLine(proc, /127\.0\.0\.1:(\d+)/, 15000);
  if (!m) throw new Error('server.py did not start');
  const url = `http://127.0.0.1:${m[1]}/`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + 'api/health')).ok) return { proc, port: Number(m[1]), url }; } catch (e) { /* not yet */ } await sleep(100); }
  throw new Error('server.py does not answer');
}

// End the terminal host for this data folder.
export function stopTerminals(/** @type {any} */ env, app = APP) { spawnSync('python3', [join(app, 'server.py'), 'stop-terminals'], { cwd: app, env, timeout: 30000 }); }

// A private copy of the app (server.py, desk/, web/) so a flow can change page files on disk without touching the checkout.
export function appCopy() { const d = tempDir('qa-app-'); for (const x of ['server.py', 'desk', 'web']) cpSync(join(APP, x), join(d, x), { recursive: true }); return d; }

// dev_static.py on a free port; returns its child and base URL.
export async function startStatic() {
  const proc = launch('python3', [join(HERE, 'dev_static.py'), '--port', '0'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const m = await readLine(proc, /http:\/\/\[::1\]:(\d+)\//); if (!m) throw new Error('dev_static.py did not start');
  const url = `http://[::1]:${m[1]}/`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(url)).ok) break; } catch (e) { await sleep(150); } }
  return { proc, url };
}

// In-page probes installed before any page script: rAF callback count, live-region announcement count.
const PROBE = `(() => {
  const q = window.__qa = { raf: 0, live: {}, liveTotal: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(t => { q.raf++; cb(t); });
  const last = new WeakMap();  // weak, so the probe never keeps removed live regions alive
  const sel = '[aria-live]:not([aria-live="off"]), [role=status], [role=alert], [role=log], [role=marquee], [role=timer]';
  const name = e => e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + [...e.classList].join('.');
  const seen = () => { for (const r of document.querySelectorAll(sel)) { if (r.closest('[hidden]') || r.closest('[aria-hidden=true]')) { last.set(r, ''); continue; }
    const t = r.textContent.trim(), k = name(r); if (!last.has(r)) { last.set(r, t); continue; } if (t && t !== last.get(r)) { q.live[k] = (q.live[k] || 0) + 1; q.liveTotal++; } last.set(r, t); } };
  new MutationObserver(seen).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden'] });
})();`;

// Headless Chrome page with probes, offline fonts and weather, error collection; returns helpers.
export async function openPage(/** @type {string} */ url, { width = 1280, height = 1000, dark = true, reduced = false, probes = true } = {}) {
  const { chrome, wsUrl, port } = await startChrome(tempDir('qa-chrome-'));
  const cdp = await devtools(wsUrl), { send, on } = cdp;
  const errs = /** @type {string[]} */ ([]), net = { open: new Map(), all: 0, by: /** @type {Record<string, number>} */ ({}) };
  on.set('Runtime.exceptionThrown', p => errs.push('exception: ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  on.set('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'assert') errs.push('console.' + p.type + ': ' + p.args.map(a => a.value ?? a.description).join(' ')); });
  on.set('Log.entryAdded', p => { if (p.entry.level === 'error') errs.push('log: ' + p.entry.text + (p.entry.url ? ' ' + p.entry.url : '')); });
  on.set('Network.requestWillBeSent', p => { const u = new URL(p.request.url).pathname; net.open.set(p.requestId, u); net.all++; net.by[u] = (net.by[u] || 0) + 1; });
  on.set('Network.loadingFinished', p => net.open.delete(p.requestId));
  on.set('Network.loadingFailed', p => net.open.delete(p.requestId));
  on.set('Fetch.requestPaused', p => {
    const u = p.request.url, css = /fonts\.googleapis/.test(u), body = /open-meteo/.test(u) ? WEATHER : '';
    send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: css ? 'text/css' : 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(body).toString('base64') }).catch(() => {});
  });
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable', 'Performance.enable']) await send(m);
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Fetch.enable', { patterns: [{ urlPattern: '*fonts.googleapis.com*' }, { urlPattern: '*fonts.gstatic.com*' }, { urlPattern: '*api.open-meteo.com*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await media(send, { dark, reduced });
  if (probes) await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  await send('Page.navigate', { url });
  const ev = async (/** @type {string} */ body) => { const r = await send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const shot = async () => Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64');
  return { chrome, port, send, on, ev, errs, net, shot, close: () => stop(chrome, 3000) };
}

// Emulated colour scheme and motion preference.
export function media(/** @type {any} */ send, { dark = true, reduced = false } = {}) {
  return send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }, { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
}

// One page sample: heap after GC, DOM counters, task time, rAF callbacks, running CSS animations, open requests, the drift counters (window.desk.drift, driftChecks).
export async function pageSample(/** @type {any} */ pg) {
  await pg.send('HeapProfiler.collectGarbage');
  const heap = await pg.send('Runtime.getHeapUsage'), dom = await pg.send('Memory.getDOMCounters'), pm = await pg.send('Performance.getMetrics');
  const m = Object.fromEntries(pm.metrics.map((/** @type {any} */ x) => [x.name, x.value]));
  const inpage = await pg.ev(`return { raf: window.__qa ? __qa.raf : 0, live: window.__qa ? __qa.liveTotal : 0, liveBy: window.__qa ? __qa.live : {}, anims: document.getAnimations().filter(a => a.playState === 'running').length, hidden: document.hidden, drift: window.desk ? desk.drift : NaN, driftChecks: window.desk ? desk.driftChecks : NaN };`);
  return { t: Date.now(), heapMB: heap.usedSize / 2 ** 20, nodes: dom.nodes, listeners: dom.jsEventListeners, docs: dom.documents, task: m.TaskDuration, script: m.ScriptDuration, layouts: m.LayoutCount,
    raf: inpage.raf, live: inpage.live, liveBy: inpage.liveBy, anims: inpage.anims, hidden: inpage.hidden, reqOpen: pg.net.open.size, reqAll: pg.net.all, sessFetches: pg.net.by['/api/sessions'] || 0, reqBy: Object.entries([...pg.net.open.values()].reduce((/** @type {any} */ a, u) => (a[u] = (a[u] || 0) + 1, a), {})).map(([u, n]) => u + ' ' + n).join(', '), errs: pg.errs.length, drift: inpage.drift, driftChecks: inpage.driftChecks };
}

// One process sample: RSS MB, CPU seconds, open descriptors, threads, established TCP connections.
export function procSample(/** @type {number} */ pid) {
  try {
    const ps = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    const tp = ps[1].split(':').map(Number), cpu = tp.length === 3 ? tp[0] * 3600 + tp[1] * 60 + tp[2] : tp[0] * 60 + tp[1];
    const threads = execFileSync('ps', ['-M', '-p', String(pid)], { encoding: 'utf8' }).trim().split('\n').length - 1;
    const lsof = spawnSync('lsof', ['-n', '-P', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().split('\n').slice(1);
    return { t: Date.now(), rssMB: Number(ps[0]) / 1024, cpu, fds: lsof.filter(l => /^\S+\s+\d+\s+\S+\s+\d+/.test(l)).length, threads, tcp: lsof.filter(l => /ESTABLISHED/.test(l)).length };
  } catch (e) { return null; }
}

// Heap snapshot through DevTools, summed by class: count and self size per constructor (no dominator tree, so self size, not retained).
export async function heapClasses(/** @type {any} */ pg) {
  let buf = ''; const prev = pg.on.get('HeapProfiler.addHeapSnapshotChunk');
  pg.on.set('HeapProfiler.addHeapSnapshotChunk', (/** @type {any} */ p) => { buf += p.chunk; });
  await pg.send('HeapProfiler.collectGarbage'); await pg.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
  if (prev) pg.on.set('HeapProfiler.addHeapSnapshotChunk', prev); else pg.on.delete('HeapProfiler.addHeapSnapshotChunk');
  const s = JSON.parse(buf), f = s.snapshot.meta.node_fields, types = s.snapshot.meta.node_types[0], W = f.length;
  const iT = f.indexOf('type'), iN = f.indexOf('name'), iS = f.indexOf('self_size'), by = /** @type {Record<string, {n: number, kb: number}>} */ ({});
  for (let i = 0; i < s.nodes.length; i += W) {
    const ty = types[s.nodes[i + iT]]; if (ty === 'hidden' || ty === 'synthetic') continue;
    const k = ty === 'object' || ty === 'native' || ty === 'closure' ? `${ty}:${String(s.strings[s.nodes[i + iN]]).slice(0, 60)}` : ty;
    const e = by[k] || (by[k] = { n: 0, kb: 0 }); e.n++; e.kb += s.nodes[i + iS] / 1024;
  }
  return by;
}

// Rows of the classes that grew most between two heapClasses results, by self size then count.
export function heapDiff(/** @type {Record<string, any>} */ a, /** @type {Record<string, any>} */ b, top = 12) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]), z = { n: 0, kb: 0 };
  return [...keys].map(k => { const x = a[k] || z, y = b[k] || z; return [k, x.n, y.n, y.n - x.n, f2(x.kb), f2(y.kb), f2(y.kb - x.kb)]; })
    .sort((p, q) => Number(q[6]) - Number(p[6]) || Number(q[3]) - Number(p[3])).slice(0, top);
}

// Least-squares slope of y over t (per hour).
export function slope(/** @type {Array<[number, number]>} */ pts) {
  if (pts.length < 2) return 0;
  const n = pts.length, mt = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0; for (const [t, y] of pts) { num += (t - mt) * (y - my); den += (t - mt) ** 2; }
  return den ? num / den * 3600000 : 0;
}

// Fixed-width table printer.
export function table(/** @type {string[]} */ head, /** @type {any[][]} */ rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const fmt = (/** @type {any[]} */ r) => r.map((c, i) => i ? String(c).padStart(w[i]) : String(c).padEnd(w[i])).join('  ');
  return [fmt(head), w.map(x => '-'.repeat(x)).join('  '), ...rows.map(fmt)].join('\n');
}
export const f2 = (/** @type {number} */ x) => (Math.round(x * 100) / 100).toString();
// One tool call and its result, in the CLI's record shape.
let tk = 0;
function tool(/** @type {any} */ s, /** @type {string} */ name, /** @type {any} */ input, /** @type {string} */ out, err = false, /** @type {any} */ tur = undefined) {
  const id = 'toolu_qa' + (++tk), a = `${s.sid.slice(0, 8)}-${++s.n}`, u = `${s.sid.slice(0, 8)}-${++s.n}`;
  appendFileSync(s.file, line('assistant', a, s.last, s.cwd, [{ type: 'tool_use', id, name, input }]));
  appendFileSync(s.file, line('user', u, a, s.cwd, [{ type: 'tool_result', tool_use_id: id, content: out, is_error: err }], tur === undefined ? {} : { toolUseResult: tur }));
  s.last = u;
}
const bash = (/** @type {any} */ s, /** @type {string} */ cmd, /** @type {string} */ out, err = false) => tool(s, 'Bash', { command: cmd, description: 'invented' }, err ? 'Exit code 1\n' + out : out, err, err ? 'Error: Exit code 1\n' + out : { stdout: out, stderr: '', interrupted: false, isImage: false });
const read = (/** @type {any} */ s, /** @type {string} */ f, /** @type {string} */ body) => tool(s, 'Read', { file_path: join(s.cwd, f) }, body, false, { type: 'text', file: { filePath: join(s.cwd, f), content: body, numLines: 1, startLine: 1, totalLines: 1 } });
export const HOSTILE = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script><b style="position:fixed;inset:0">x</b>';
export const LONG = 'L'.repeat(20000);
// A transcript with three groups, a failed call inside a group, and hostile and very long results.
export function toolSession(/** @type {any} */ h, /** @type {number} */ i, title = 'Transcript groups invented') {
  const s = new Sess(h.home, '-qa-f9', sidOf(i), h.work, title); s.turn('user', 'please look around');
  bash(s, 'ls', 'a.txt\nb.txt'); bash(s, 'pwd', '/invented'); bash(s, 'git status', 'clean');
  s.turn('assistant', 'Now reading two files.');
  read(s, 'a.txt', 'alpha invented'); read(s, 'b.txt', 'beta invented');
  s.turn('assistant', 'Running the checks.');
  bash(s, 'make ok', 'ok invented'); bash(s, 'make bad', 'boom invented failure', true);
  s.turn('assistant', 'Looking at odd output.');
  bash(s, 'cat hostile', HOSTILE + '\n' + LONG); read(s, 'hostile.html', HOSTILE + LONG);
  s.turn('assistant', 'Done. Shall I go on?'); s.live('idle'); return s;
}
export { sleep, stop, tempDir, launch, statSync };
