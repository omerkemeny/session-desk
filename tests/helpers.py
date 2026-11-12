"""Shared test helpers: a temporary copy of the fixture data folder wired into the package, and a server on a free port."""
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from desk import app, config, events, liveness, sessions, stats, summaries, terms, transcripts  # noqa: E402

FIXTURE = os.path.join(ROOT, "tests", "fixtures", "home")
S1, S2, S3, S4, S5, S6 = (f"{d * 8}-{d * 4}-4{d * 3}-8{d * 3}-{d * 12}" for d in "123456")
T1, T2, T3 = (f"7{d * 7}-7777-4777-8777-777777777777" for d in "abc")
NOW = 1781514000.0  # 2026-06-15 09:00 UTC, 12:00 in Israel


def reset():
    """Forget every cache and every page terminal or reply between tests."""
    sessions._cache.clear()
    sessions._full.clear()
    sessions._views.clear()
    transcripts._found.clear()
    summaries.reset()
    terms._terms.clear()
    terms._replies.clear()
    terms._host.update(error="", gen=-1, closing=False, token=None, watch=None, rd=None, hello=None)
    terms._host["synced"].clear()
    transcripts._states.clear()
    with transcripts._lock:
        transcripts._checks.clear()
        transcripts._registry.update(files=0, bad=0, missing=transcripts.Counter(), odd=transcripts.Counter())
    stats.stop_worker()
    stats._stats.update(proc=None, result=None, busy=False, done=0, total=0, at=0.0, error="", runs=0, errors=0, errorType=None, errorAt=None)
    events._scan.update(at=0.0, dirs=None, files={}, acc=0, hot=set(), home=None, changed=set(), parts=None, watched=set(), order=[], woke=set(), wlist=None, seen=set(), complete=False, found={}, lver=None, cold=None, rot=0, rotf=0)
    liveness._state.clear()
    liveness._state["home"] = None
    sessions._starts.update(pids=(), at=0.0, map={})


def wait_until(cond, timeout=5.0, step=0.02):
    """Poll a condition until it holds or the timeout passes; returns its last value."""
    end = time.monotonic() + timeout
    while True:
        v = cond()
        if v or time.monotonic() > end:
            return v
        time.sleep(step)


def read_event(resp, kinds=("change",)):
    """Next server-sent event of one of these kinds (None: any) as a list of lines, skipping keep-alive comments."""
    lines = []
    while True:
        line = resp.readline()
        if not line:
            raise EOFError
        line = line.decode().rstrip("\n")
        if line == "":
            if lines and (kinds is None or any(x == "event: " + k for x in lines for k in kinds)):
                return lines
            lines = []
        elif not line.startswith(":"):
            lines.append(line)


def open_events(port, host=None):
    """Open the change feed; returns (connection, response)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", "/api/events", headers={"Host": host or f"127.0.0.1:{port}"})
    return conn, conn.getresponse()


class FakeTerm:
    """Stand-in for a running page terminal: pid, start time, no exit code."""

    def __init__(self, pid, t0):
        self.pid, self.t0, self.code = pid, t0, None


class FakeHome:
    """A copy of the fixture folder in a temp dir, set as the data folder; registry files are added per test."""

    def __init__(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-test-")
        self.home = os.path.join(self.tmp, "claude")
        shutil.copytree(FIXTURE, self.home)
        os.makedirs(os.path.join(self.home, "sessions"))
        now = time.time()
        for base, _, files in os.walk(self.home):
            for f in files:
                os.utime(os.path.join(base, f), (now, now))
        stale = self.path(S3)[:-6] + "/subagents/agent-a3.jsonl"
        os.utime(stale, (now - 7200, now - 7200))
        self.saved = (config.HOME, config.STATS_FILE, config.WEB, config.STATE_DIR)
        config.HOME, config.STATS_FILE, config.WEB = self.home, os.path.join(self.tmp, "stats.json"), os.path.join(self.tmp, "web")
        config.STATE_DIR = self.tmp  # terminal host socket, pid and log files stay inside the temp folder
        # Stub page and terminal-library files, so no test depends on the real web/ folder.
        os.makedirs(os.path.join(config.WEB, "vendor"), exist_ok=True)
        for name, text in (("index.html", "<h1>Session Desk</h1>"), ("vendor/xterm.js", "// stub"), ("vendor/xterm.css", "/* stub */")):
            with open(os.path.join(config.WEB, name), "w") as fh:
                fh.write(text)
        self.n = 0
        reset()

    def path(self, sid):
        """Transcript path of a fixture session."""
        for project in os.listdir(os.path.join(self.home, "projects")):
            p = os.path.join(self.home, "projects", project, sid + ".jsonl")
            if os.path.exists(p):
                return p
        raise KeyError(sid)

    def register(self, sid, pid=None, status="idle", at=None, name=None, entry="cli", **extra):
        """Add a live-process registry file for a session; extra fields (procStart, nameSource, parkedJobId) are written as given."""
        self.n += 1
        entry_ = dict({"pid": os.getpid() if pid is None else pid, "sessionId": sid, "status": status,
                       "statusUpdatedAt": int(time.time() * 1000) if at is None else at, "name": name, "entrypoint": entry}, **extra)
        with open(os.path.join(self.home, "sessions", f"{self.n}.json"), "w") as fh:
            json.dump(entry_, fh)

    def close(self):
        """Restore the settings and delete the copy."""
        terms.stop_host(2)
        config.HOME, config.STATS_FILE, config.WEB, config.STATE_DIR = self.saved
        reset()
        shutil.rmtree(self.tmp, ignore_errors=True)


class Served:
    """The real server on a free port of 127.0.0.1, serving in a background thread."""

    def __init__(self, module=app):
        self.server = module.make_server(0)
        self.port = self.server.server_address[1]
        self.host = f"127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def request(self, method, path, body=None, headers=None):
        """Send one request; returns (status, headers, body bytes)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": self.host}
        h.update(headers or {})
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        out = (r.status, dict(r.getheaders()), r.read())
        conn.close()
        return out

    def json(self, path):
        """GET a JSON route."""
        status, _, body = self.request("GET", path)
        return status, json.loads(body)

    def close(self):
        """Stop serving and free the port."""
        self.server.closing = True
        self.server.shutdown()
        self.server.server_close()
