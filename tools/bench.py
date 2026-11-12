#!/usr/bin/env python3
"""Benchmark server.py on a synthetic data folder: route timings, change-feed latency and idle CPU, memory; prints counts and timings only."""
import argparse
import glob
import http.client
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import bench_home  # noqa: E402


def ps(pid, field):
    """One ps field of a process, as text."""
    return subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()


def rss_mb(pid):
    """Resident memory of a process in MB."""
    return round(int(ps(pid, "rss") or 0) / 1024, 1)


def cpu_sec(pid):
    """CPU seconds a process used so far (ps time is [[dd-]hh:]mm:ss.cc)."""
    secs = 0.0
    for part in ps(pid, "time").replace("-", ":").split(":"):
        secs = secs * 60 + float(part)
    return secs


def ms(x):
    """Seconds to whole milliseconds."""
    return round(x * 1000)


class Client:
    """GET helper bound to one port."""

    def __init__(self, port):
        self.port = port

    def get(self, path):
        """GET a path; returns (status, seconds, body bytes)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=600)
        t = time.perf_counter()
        conn.request("GET", path, headers={"Host": f"127.0.0.1:{self.port}"})
        r = conn.getresponse()
        body = r.read()
        dt = time.perf_counter() - t
        conn.close()
        return r.status, dt, body

    def feed(self):
        """Open the change feed and read its first event; returns the response."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        conn.request("GET", "/api/events", headers={"Host": f"127.0.0.1:{self.port}"})
        r = conn.getresponse()
        next_event(r)
        return r


def next_event(resp):
    """Block until the next change event of a feed response."""
    while True:
        line = resp.readline()
        if not line:
            raise EOFError
        if line.startswith(b"event: change"):
            return


def append_line(path):
    """Append one invented assistant record to a transcript, as the CLI does while it works."""
    with open(path, "a") as fh:
        fh.write(bench_home.rec("assistant", "bench-" + str(time.time_ns()), None, bench_home.iso(time.time()), "/bench/p0",
                                [{"type": "text", "text": "appended"}], "mb" + str(time.time_ns())))


def busy_big(c, pid, feed, big, sid, seconds=10):
    """Server CPU % while the largest session works (one append a second) and the page refetches the list and its transcript on each change."""
    cpu0, end = cpu_sec(pid), time.monotonic() + seconds
    while time.monotonic() < end:
        append_line(big)
        next_event(feed)
        c.get("/api/sessions")
        c.get(f"/api/session?id={sid}")
        time.sleep(max(0.0, 1.0 - (time.monotonic() % 1.0)))
    return round((cpu_sec(pid) - cpu0) * 100 / seconds, 1)


def measure(c, pid, home, polls):
    """Run every measurement against a started server; returns the report dict."""
    rep = {"rssIdleMb": rss_mb(pid)}
    mains = glob.glob(os.path.join(glob.escape(home), "projects", "*", "*.jsonl"))
    alls = mains + glob.glob(os.path.join(glob.escape(home), "projects", "*", "*", "subagents", "**", "*.jsonl"), recursive=True)
    rep["data"] = {"mainFiles": len(mains), "allFiles": len(alls), "allMb": round(sum(os.path.getsize(p) for p in alls) / 2**20),
                   "largestMb": round(max((os.path.getsize(p) for p in alls), default=0) / 2**20, 1)}
    s, dt, body = c.get("/api/sessions")
    rep["sessionsColdMs"], rep["sessionsCount"] = ms(dt), len(json.loads(body))
    rep["sessionsWarmMs"] = ms(statistics.median(c.get("/api/sessions")[1] for _ in range(10)))
    big = max(mains, key=os.path.getsize)
    sid = os.path.basename(big)[:-6]
    rep["bigOpenColdMs"] = ms(c.get(f"/api/session?id={sid}")[1])
    rep["bigOpenWarmMs"] = ms(c.get(f"/api/session?id={sid}")[1])
    append_line(big)
    rep["bigOpenAfterAppendMs"] = ms(c.get(f"/api/session?id={sid}")[1])
    append_line(big)
    rep["sessionsAfterBigAppendMs"] = ms(c.get("/api/sessions")[1])
    rep["rssAfterOpensMb"] = rss_mb(pid)
    t = time.perf_counter()
    while True:
        d = json.loads(c.get("/api/stats")[2])
        if d.get("ready") and not d.get("updating"):
            break
        time.sleep(0.1)
    rep["statsColdMs"] = ms(time.perf_counter() - t)
    rep["statsWarmMs"] = ms(statistics.median(c.get("/api/stats")[1] for _ in range(5)))
    rep["rssAfterStatsMb"] = rss_mb(pid)
    rep["healthMs"] = ms(statistics.median(c.get("/api/health")[1] for _ in range(5)))
    feed = c.feed()
    time.sleep(2.5)
    cpu0 = cpu_sec(pid)
    time.sleep(10)
    rep["feedIdleCpuPct"] = round((cpu_sec(pid) - cpu0) * 10, 1)
    lat = []
    for _ in range(3):
        t = time.perf_counter()
        append_line(mains[len(mains) // 2])
        next_event(feed)
        lat.append(time.perf_counter() - t)
    rep["feedLatencyMs"] = ms(statistics.median(lat))
    rep["busyBigCpuPct"] = busy_big(c, pid, feed, big, sid)
    feed.close()
    t = time.perf_counter()
    for i in range(polls):
        c.get("/api/sessions")
        if i % 15 == 0:
            c.get("/api/stats")
    rep["pollLoopSec"], rep["polls"] = round(time.perf_counter() - t, 1), polls
    rep["rssAfterPollsMb"] = rss_mb(pid)
    return rep


def main():
    """Build (or reuse) a synthetic folder, start server.py on a free port with a temp state folder, measure, print one JSON report."""
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--count", type=int, default=500, help="transcripts to generate")
    ap.add_argument("--big", type=int, default=3, help="large transcripts among them")
    ap.add_argument("--big-mb", type=int, default=50)
    ap.add_argument("--home", help="reuse a synthetic folder made by bench_home.py (never ~/.claude)")
    ap.add_argument("--polls", type=int, default=150, help="session-list polls to simulate")
    ap.add_argument("--server", default=os.path.join(ROOT, "server.py"), help="server.py to measure (another checkout for a before run)")
    a = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="desk-bench-")
    home = a.home or os.path.join(tmp, "home")
    if os.path.realpath(home) == os.path.realpath(os.path.expanduser("~/.claude")):
        sys.exit("refusing to benchmark the real ~/.claude; use a synthetic folder")
    if a.home:
        bench_home.relive(home)
    else:
        bench_home.build(home, a.count, a.big, a.big_mb)
    env = dict(os.environ, PORT=os.environ.get("BENCH_PORT", "0"), DESK_CLAUDE_DIR=home, DESK_STATE_DIR=tmp, DESK_CLAUDE_BIN="/usr/bin/false")
    t0 = time.perf_counter()
    proc = subprocess.Popen([sys.executable, a.server], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    rep = {"python": sys.version.split()[0], "server": a.server}
    try:
        m = re.search(r"127\.0\.0\.1:(\d+)", proc.stdout.readline())  # PORT=0: the server picks a free port and prints it
        if not m:
            sys.exit("server did not start")
        port = int(m.group(1))
        rep["startMs"] = ms(time.perf_counter() - t0)
        rep.update(measure(Client(port), proc.pid, home, a.polls))
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
