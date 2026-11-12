#!/usr/bin/env python3
"""Scale test: build a synthetic data folder of a given shape, start server.py on it and print one table of timings, memory, CPU, descriptors and caps."""
import argparse
import http.client
import json
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import scale_home  # noqa: E402

BASE = os.environ.get("SCALE_BASE") or os.path.join(tempfile.gettempdir(), "desk-scale")  # where synthetic folders live between runs
STUB = "#!/bin/sh\necho stub cli\nexit 0\n"


def ps(pid, field):
    """One ps field of a process, as text."""
    return subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()


def rss_mb(pid):
    """Resident memory in MB."""
    return round(int(ps(pid, "rss") or 0) / 1024, 1)


def cpu_sec(pid):
    """CPU seconds used so far."""
    secs = 0.0
    for part in ps(pid, "time").replace("-", ":").split(":"):
        secs = secs * 60 + float(part)
    return secs


def lsof_count(pid):
    """Open descriptors of a process as lsof lists them."""
    out = subprocess.run(["lsof", "-n", "-P", "-p", str(pid)], capture_output=True, text=True).stdout.splitlines()[1:]
    return sum(1 for ln in out if re.match(r"^\S+\s+\d+\s+\S+\s+\d+", ln))


def ms(x):
    """Seconds to whole milliseconds."""
    return round(x * 1000)


class Client:
    """GET helper bound to one port; counts non-200 answers."""

    def __init__(self, port):
        self.port, self.bad = port, {}

    def get(self, path, timeout=600):
        """GET a path; returns (status, seconds, body)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        t = time.perf_counter()
        conn.request("GET", path, headers={"Host": f"127.0.0.1:{self.port}"})
        r = conn.getresponse()
        body = r.read()
        dt = time.perf_counter() - t
        conn.close()
        if r.status != 200:
            k = f"{path.split('?')[0]} {r.status}"
            self.bad[k] = self.bad.get(k, 0) + 1
        return r.status, dt, body

    def json(self, path):
        """GET and parse."""
        return json.loads(self.get(path)[2])


class Feed:
    """Change-feed reader on its own thread: records the arrival time of every change event."""

    def __init__(self, port):
        self.conn = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
        self.conn.request("GET", "/api/events", headers={"Host": f"127.0.0.1:{port}"})
        self.resp = self.conn.getresponse()
        self.times, self.ids, self.lock = [], [], threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        """Read events until the stream ends."""
        try:
            while True:
                line = self.resp.readline()
                if not line:
                    return
                if line.startswith(b"data: {"):
                    with self.lock:
                        self.ids.append(json.loads(line[6:]))
                if line.startswith(b"event: change"):
                    with self.lock:
                        self.times.append(time.monotonic())
        except (OSError, ValueError):
            return

    def count(self):
        """Change events seen so far."""
        with self.lock:
            return len(self.times)

    def wait_after(self, k, timeout):
        """Seconds until change event number k+1 arrives, or None on timeout."""
        t0, end = time.monotonic(), time.monotonic() + timeout
        while time.monotonic() < end:
            with self.lock:
                if len(self.times) > k:
                    return self.times[k] - t0
            time.sleep(0.005)
        return None

    def close(self):
        """Drop the stream."""
        sock = getattr(getattr(self.resp.fp, "raw", None), "_sock", None) if self.resp.fp else None
        try:
            if sock is not None:
                sock.shutdown(2)
        except OSError:
            pass


def append(path, tag="scale"):
    """Append one invented assistant row, as the CLI does while it works."""
    ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
    u = f"{tag}-{time.time_ns()}"
    with open(path, "a") as fh:
        fh.write(json.dumps({"parentUuid": None, "isSidechain": False, "type": "system", "subtype": "turn_duration", "uuid": u, "timestamp": ts, "cwd": "/scale",
                             "sessionId": "x", "entrypoint": "cli"}, separators=(",", ":")) + "\n")


def path_of(home, sid):
    """Transcript path of an id."""
    for d in os.listdir(os.path.join(home, "projects")):
        p = os.path.join(home, "projects", d, sid + ".jsonl")
        if os.path.exists(p):
            return p
    return None


def pct(xs, q):
    """q-th percentile of a list."""
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q / 100 * (len(xs) - 1))))]


def start(home, state, env_extra=None):
    """Start server.py on a free port; returns (process, port, seconds to the printed address)."""
    stub = os.path.join(state, "stub-cli")
    if not os.path.exists(stub):
        with open(stub, "w") as fh:
            fh.write(STUB)
        os.chmod(stub, 0o755)
    env = dict(os.environ, PORT="0", DESK_CLAUDE_DIR=home, DESK_STATE_DIR=state, DESK_CLAUDE_BIN=stub, **(env_extra or {}))
    t0 = time.perf_counter()
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, cwd=ROOT)
    m = re.search(r"127\.0\.0\.1:(\d+)", proc.stdout.readline() or "")
    if not m:
        proc.kill()
        sys.exit("server did not start")
    threading.Thread(target=lambda: [None for _ in proc.stdout], daemon=True).start()
    return proc, int(m.group(1)), t0


def stop(proc):
    """Stop a server and wait for it."""
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(5)


def summary_write(home, state):
    """(bytes, ms) of the summary cache file: its size and the time one flush of it takes, measured in a child process on the same files."""
    files = [f for f in os.listdir(state) if f.endswith("-summaries.json")]
    if not files:
        return 0, -1
    size = os.path.getsize(os.path.join(state, files[0]))
    code = ("import time,sys;sys.path.insert(0,%r);from desk import summaries as s;s.attach();s._state['dirty']=True;t=time.perf_counter();s.flush();"
            "print(round((time.perf_counter()-t)*1000,1), len(s._state['entries']))") % ROOT
    out = subprocess.run([sys.executable, "-c", code], env=dict(os.environ, DESK_CLAUDE_DIR=home, DESK_STATE_DIR=state), capture_output=True, text=True, cwd=ROOT).stdout.split()
    return size, (float(out[0]) if out else -1), (int(out[1]) if len(out) > 1 else -1)


def measure(home, shape, state, quick, page):
    """Every server measure on one started server; returns (report dict, list order) ."""
    rep, ids = {}, shape["ids"]
    proc, port, t0 = start(home, state)
    c = Client(port)
    pid = proc.pid
    try:
        s, dt0, body = c.get("/api/sessions")
        rep["coldStartMs"] = ms(time.perf_counter() - t0)
        rep["coldListMs"] = ms(dt0)
        lst = json.loads(body)
        rep["listRows"], rep["listBytes"] = len(lst), len(body)
        rep["listLive"] = sum(1 for o in lst if o["status"] != "done")
        rep["listWaiting"] = sum(1 for o in lst if o["status"] == "waiting")
        rep["rssStartMb"] = rss_mb(pid)
        warm = [c.get("/api/sessions")[1] for _ in range(8 if quick else 20)]
        rep["warmListMedMs"], rep["warmListP95Ms"] = ms(statistics.median(warm)), ms(pct(warm, 95))
        order = [o["id"] for o in lst]
        typed = sorted((os.path.getsize(path_of(home, o["id"])), o["id"]) for o in lst if o["status"] == "done" and not o["automated"])
        ids["listedMedian"] = typed[len(typed) // 2][1] if typed else ids["median"]
        rep["ids1Ms"] = ms(statistics.median(c.get(f"/api/sessions?ids={order[0]}")[1] for _ in range(5)))
        rep["ids10Ms"] = ms(statistics.median(c.get("/api/sessions?ids=" + ",".join(order[:10]))[1] for _ in range(5)))
        for name in ("small", "median", "big"):
            st, d1, b = c.get(f"/api/session?id={ids[name]}")
            d2 = c.get(f"/api/session?id={ids[name]}")[1]
            rep[f"open_{name}"] = {"coldMs": ms(d1), "warmMs": ms(d2), "kb": len(b) // 1024, "fileMb": round(os.path.getsize(path_of(home, ids[name])) / 2**20, 2)}
        t = time.perf_counter()
        while True:
            d = c.json("/api/stats")
            if d.get("ready") and not d.get("updating"):
                break
            if time.perf_counter() - t > 600:
                break
            time.sleep(0.1)
        rep["statsColdMs"] = ms(time.perf_counter() - t)
        rep["statsWarmMs"] = ms(statistics.median(c.get("/api/stats")[1] for _ in range(5)))
        rep["healthMs"] = ms(statistics.median(c.get("/api/health")[1] for _ in range(5)))
        rep["rssRoutesMb"] = rss_mb(pid)
        feed = Feed(port)
        time.sleep(3)
        cpu0, w0 = cpu_sec(pid), time.monotonic()
        time.sleep(6 if quick else 15)
        rep["idleCpuPct"] = round((cpu_sec(pid) - cpu0) * 100 / (time.monotonic() - w0), 1)
        for name in ("live", "recent", "cold"):
            p, lat = path_of(home, ids[name]), []
            for _ in range((1 if quick else 2) if name != "cold" else (3 if quick else 5)):
                time.sleep(0.5)
                k = feed.count()
                append(p)
                d = feed.wait_after(k, 25)
                lat.append(ms(d) if d is not None else -1)
            rep[f"feed_{name}Ms"] = max(lat)
            rep[f"feed_{name}All"] = lat
        bigp = path_of(home, ids["big"])
        k = feed.count()
        append(bigp)
        d = feed.wait_after(k, 25)
        rep["feed_bigMs"] = ms(d) if d is not None else -1
        rep["listAfterBigAppendMs"] = ms(c.get("/api/sessions")[1])
        append(bigp)
        rep["openBigAfterAppendMs"] = ms(c.get(f"/api/session?id={ids['big']}")[1])
        livep = path_of(home, ids["live"])
        secs = 6 if quick else 15
        cpu0, w0 = cpu_sec(pid), time.monotonic()
        while time.monotonic() - w0 < secs:
            k = feed.count()
            append(livep)
            feed.wait_after(k, 3)
            ev = feed.ids[-1] if feed.ids else {"ids": []}
            c.get("/api/sessions?ids=" + ",".join(ev.get("ids") or [ids["live"]])) if not ev.get("all") else c.get("/api/sessions")
            time.sleep(max(0.0, 1.0 - ((time.monotonic() - w0) % 1.0)))
        rep["busyCpuPct"] = round((cpu_sec(pid) - cpu0) * 100 / (time.monotonic() - w0), 1)
        if page:
            rep["page"] = run_page(port, home, shape, quick)
        r = random.Random(3)
        n, all_ids = shape["n"], None
        hot = [path_of(home, scale_home.sid_of(i)) for i in range(min(n, max(1, shape["live"])))]
        t = time.perf_counter()
        for i in range(200 if quick else 500):
            x = r.random()
            if x < 0.7:
                p = r.choice(hot)
            else:
                p = path_of(home, scale_home.sid_of(r.randrange(n)))
            append(p, "churn")
            if i % 10 == 0:
                c.get("/api/sessions")
        rep["churnSec"] = round(time.perf_counter() - t, 1)
        time.sleep(2)
        rep["rssChurnMb"] = rss_mb(pid)
        h = c.json("/api/health")
        feed.close()
        rep["fds"] = {**h.get("fds", {}), "lsof": lsof_count(pid)}
        rep["healthOk"], rep["formatWarnings"] = h.get("ok"), h.get("formatWarnings")
        rep["formatFiles"] = (h.get("formatChecked") or {}).get("files")
        nfold = len({os.path.dirname(p) for p in [os.path.join(home, "projects", d) for d in os.listdir(os.path.join(home, "projects"))]})
        rep["watchWant"] = nfold + 2 + shape["n"] + shape["live"]
        time.sleep(6)  # the summary cache writes SAVE_DELAY after a change
        rep["summaryBytes"], rep["summaryWriteMs"], rep["summaryEntries"] = summary_write(home, state)
        rep["bad"] = c.bad
    finally:
        stop(proc)
    return rep


def run_page(port, home, shape, quick):
    """Drive the page through scale_page.mjs; returns its JSON report."""
    args = ["node", os.path.join(ROOT, "tools", "scale_page.mjs"), "--url", f"http://127.0.0.1:{port}/", "--append", path_of(home, shape["ids"]["live"]),
            "--big", shape["ids"]["big"], "--median", shape["ids"]["listedMedian"]] + (["--quick"] if quick else [])
    r = subprocess.run(args, capture_output=True, text=True, timeout=600)
    last = [ln for ln in r.stdout.splitlines() if ln.startswith("{")]
    return json.loads(last[-1]) if last else {"error": (r.stderr or r.stdout)[-400:]}


def shape_key(a):
    """Folder name for a shape."""
    return f"n{a.sessions}-l{a.live}-b{a.big}-p{a.projects}-s{a.subagents}-a{int(a.auto * 100)}"


def ensure_home(a):
    """Build the folder for this shape, or reuse a finished one; returns (home, shape, build seconds)."""
    home = os.path.join(BASE, shape_key(a))
    marker = os.path.join(home, scale_home.SHAPE_FILE)
    if os.path.exists(marker) and not a.fresh:
        with open(marker) as fh:
            shape = json.load(fh)
        return home, shape, 0.0
    shutil.rmtree(home, ignore_errors=True)
    os.makedirs(home)
    t = time.perf_counter()
    shape = scale_home.build(home, a.sessions, a.live, a.waiting, a.big, a.projects, a.subagents, a.auto)
    return home, shape, round(time.perf_counter() - t, 1)


def table(rep):
    """The report as aligned label/value lines."""
    rows = []

    def add(k, v):
        rows.append((k, v))
    add("data", f"{rep['shape']['n']} sessions, {rep['shape']['live']} live ({rep['shape']['waiting']} waiting), {rep['shape']['projects']} projects, "
               f"{rep['shape']['subagents']} subagents, {round(rep['shape']['bytes'] / 2**20)} MB, biggest {rep['shape']['bigMb']} MB")
    add("cold start to first list", f"{rep['coldStartMs']} ms (list itself {rep['coldListMs']} ms)")
    add("list rows / live / waiting", f"{rep['listRows']} / {rep['listLive']} / {rep['listWaiting']}")
    add("warm /api/sessions", f"median {rep['warmListMedMs']} ms, p95 {rep['warmListP95Ms']} ms, {rep['listBytes'] // 1024} KB")
    add("/api/sessions?ids= 1 / 10", f"{rep['ids1Ms']} / {rep['ids10Ms']} ms")
    for name in ("small", "median", "big"):
        o = rep[f"open_{name}"]
        add(f"/api/session {name} ({o['fileMb']} MB)", f"cold {o['coldMs']} ms, warm {o['warmMs']} ms, {o['kb']} KB")
    add("/api/stats cold / warm", f"{rep['statsColdMs']} / {rep['statsWarmMs']} ms")
    add("/api/health", f"{rep['healthMs']} ms")
    add("feed latency live / recent / cold (max)", f"{rep['feed_liveMs']} / {rep['feed_recentMs']} / {rep['feed_coldMs']} ms (cold all {rep['feed_coldAll']})")
    add("feed latency big append; list after it", f"{rep['feed_bigMs']} ms; {rep['listAfterBigAppendMs']} ms")
    add("open big after append", f"{rep['openBigAfterAppendMs']} ms")
    add("RSS start / routes / 500 changes", f"{rep['rssStartMb']} / {rep['rssRoutesMb']} / {rep['rssChurnMb']} MB")
    add("CPU idle / 1 append per s", f"{rep['idleCpuPct']} % / {rep['busyCpuPct']} %")
    add("churn (changes + list every 10)", f"{rep['churnSec']} s")
    f = rep["fds"]
    add("fds open / limit / lsof; watches (wanted, est.)", f"{f.get('open')} / {f.get('limit')} / {f.get('lsof')}; {f.get('watches')} ({rep['watchWant']})")
    add("summary cache file", f"{rep['summaryBytes'] // 1024} KB, {rep['summaryEntries']} entries, write {rep['summaryWriteMs']} ms")
    add("health ok / warnings / non-200", f"{rep['healthOk']} / {rep['formatWarnings']} / {rep['bad'] or 'none'}")
    if "page" in rep:
        p = rep["page"]
        if "error" in p:
            add("page", "error: " + p["error"][-200:])
        else:
            add("page first usable render", f"{p['firstRenderMs']} ms; DOM {p['nodes']} nodes, heap {p['heapMb']} MB")
            add("page idle fps / CPU", f"{p['idleFps']} / {p['idleCpuPct']} %")
            add("page busy fps / CPU", f"{p['busyFps']} / {p['busyCpuPct']} %")
            add("sidebar open big / median", f"{p['openBigMs']} ms ({p['bigLines']} lines drawn) / {p['openMedianMs']} ms")
            add("search keystroke to result; Stats open", f"{p['searchMs']} ms; {p['statsMs']} ms")
            add("garden chars / miners / working", f"{p['chars']} / {p['miners']} / {p['running']}; sign '{p['sign']}'")
            add("list rows drawn / held", f"{p['rowsDrawn']} / {p['rowsHeld']}; more: {p['more']}")
            add("page errors", str(p.get("errs", 0)))
    w = max(len(k) for k, _ in rows)
    return "\n".join(f"{k.ljust(w)}  {v}" for k, v in rows)


def main():
    """Command line: scale.py --sessions N --live L --waiting W --big MB [--projects P] [--subagents S] [--quick] [--page] [--json]."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sessions", type=int, default=2000)
    ap.add_argument("--live", type=int, default=20)
    ap.add_argument("--waiting", type=int, default=10)
    ap.add_argument("--big", type=int, default=30, help="MB of the largest transcript")
    ap.add_argument("--projects", type=int, default=40)
    ap.add_argument("--subagents", type=int, default=50)
    ap.add_argument("--auto", type=float, default=0.6, help="share of finished sessions that are automated (real data: 0.63)")
    ap.add_argument("--quick", action="store_true", help="shorter idle, busy and churn phases")
    ap.add_argument("--page", action="store_true", help="also drive the page in headless Chrome")
    ap.add_argument("--fresh", action="store_true", help="rebuild the folder even when one of this shape exists")
    ap.add_argument("--drop", action="store_true", help="delete the folder afterwards")
    ap.add_argument("--json", help="also write the report to this file")
    a = ap.parse_args()
    a.waiting = min(a.waiting, a.live)
    home, shape, built = ensure_home(a)
    shape["waiting"] = a.waiting
    if os.path.realpath(home).startswith(os.path.realpath(os.path.expanduser("~/.claude"))):
        sys.exit("refusing to use ~/.claude")
    procs = scale_home.relive(home, a.live, a.waiting)
    state = tempfile.mkdtemp(prefix="desk-scale-state-")
    rep = {"shape": {k: v for k, v in shape.items() if k != "ids"}, "buildSec": built, "python": sys.version.split()[0]}
    try:
        rep.update(measure(home, shape, state, a.quick, a.page))
    finally:
        for p in procs:
            p.kill()
            p.wait()
        shutil.rmtree(state, ignore_errors=True)
        if a.drop:
            shutil.rmtree(home, ignore_errors=True)
    print(table(rep))
    if a.json:
        with open(a.json, "w") as fh:
            json.dump(rep, fh, indent=1)


if __name__ == "__main__":
    main()
