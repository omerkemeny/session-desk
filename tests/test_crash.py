"""kill -9 at random points of every writer (server, stats worker, shared writer): the app still starts and every file it wrote parses."""
import glob
import http.client
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import threading
import time
import unittest

from helpers import ROOT
from test_termhost import SID, Env

ROUNDS = 12
WRITER = """
import json, os, sys
sys.path.insert(0, {root!r})
from desk import durable
n = 0
print("go", flush=True)
while True:
    n += 1
    durable.write({path!r}, json.dumps({{"v": 1, "n": n, "pad": "x" * (n % 7 * 40000)}}).encode())
"""


INDEX_ROUNDS = 20
INDEX_FILES = 2000  # transcripts present before the first round; every round adds and changes more
INDEXER = """
import os, sys
sys.path.insert(0, {root!r})
from desk import sessions, summaries
summaries.SAVE_DELAY = 0.005  # write the cache (views and list index) as often as it changes
print("go", flush=True)
while True:
    sessions.sessions()
    summaries.flush()
"""
LISTER = """
import json, os, sys
sys.path.insert(0, {root!r})
from desk import app, sessions, summaries
swept = app.sweep_temps()  # what a starting server does first
rows = sessions.sessions()
summaries.flush()
print(json.dumps({{"rows": rows, "loaded": summaries._state["loaded"], "swept": swept}}, sort_keys=True))
"""


def port_of(rd):
    """Port of the server recorded in a run folder, or None before one wrote its record."""
    try:
        with open(os.path.join(rd, "server.json")) as fh:
            return json.load(fh)["port"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def get(port, path, timeout=1.0):
    """GET a route of a test server; None when it does not answer."""
    if not port:
        return None
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        conn.request("GET", path, headers={"Host": f"127.0.0.1:{port}"})
        r = conn.getresponse()
        out = r.status, r.read()
        conn.close()
        return out
    except OSError:
        return None


class CrashTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.env["PORT"] = "0"  # servers pick a free port and record it in server.json
        self.rng = random.Random(int(os.environ.get("DESK_CRASH_SEED", "7")))

    def tearDown(self):
        self.ctl("stop")
        self.assertEqual(self.env.close(), [], "orphan processes after the test")

    def ctl(self, verb):
        """Run one verb; returns (exit code, output)."""
        r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), verb], cwd=self.env.tmp, env=self.env.env, capture_output=True, text=True,
                           timeout=60)
        return r.returncode, r.stdout + r.stderr

    def files(self):
        """Every JSON file the app keeps in its state folder and run folder."""
        return glob.glob(os.path.join(self.env.tmp, ".stats-cache*.json")) + glob.glob(os.path.join(self.env.rd, "*.json"))

    def check_files(self):
        """Each kept file parses as a JSON object."""
        for path in self.files():
            with open(path) as fh:
                self.assertIsInstance(json.load(fh), dict, path)

    def test_random_kills_never_break_a_start(self):
        for i in range(ROUNDS):
            proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], cwd=self.env.tmp, env=self.env.env, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL, start_new_session=True)
            stop = threading.Event()

            def poke():
                """Keep the stats worker busy so it writes the cache while the kill may land."""
                while not stop.is_set():
                    get(port_of(self.env.rd), "/api/stats", 0.5)
                    time.sleep(0.02)
            t = threading.Thread(target=poke, daemon=True)
            t.start()
            time.sleep(self.rng.uniform(0.0, 1.5))
            try:
                os.killpg(proc.pid, signal.SIGKILL)  # the server and its stats worker, wherever they are
            except (ProcessLookupError, PermissionError):
                proc.kill()  # macOS refuses killpg once only a zombie leader is left
            proc.wait()
            stop.set()
            t.join()
            self.check_files()
            self.assertIn(self.ctl("status")[0], (1, 3), f"round {i}")
        cache = os.path.join(self.env.tmp, "cache.json")
        for i in range(ROUNDS):
            w = subprocess.Popen([sys.executable, "-c", WRITER.format(root=ROOT, path=cache)], stdout=subprocess.PIPE, text=True)
            self.assertEqual(w.stdout.readline().strip(), "go")
            time.sleep(self.rng.uniform(0.0, 0.2))
            w.kill()
            w.wait()
            w.stdout.close()
            if os.path.exists(cache):
                with open(cache) as fh:
                    self.assertEqual(json.load(fh)["v"], 1)
        dead = subprocess.Popen(["true"])
        dead.wait()
        for name in ("server.json", "termhost.pid"):
            with open(os.path.join(self.env.rd, f"{name}.{dead.pid}-1.tmp"), "w") as fh:
                fh.write('{"pid": ')  # what a writer killed mid-write leaves
        code, out = self.ctl("start")
        self.assertEqual(code, 0, out)
        port = port_of(self.env.rd)
        token = get(port, "/")[1].split(b'DESK_TOKEN="')[1].split(b'"')[0].decode()
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("POST", "/api/term/open", body=json.dumps({"id": SID, "cols": 80, "rows": 24}),
                     headers={"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}", "X-Desk-Token": token, "Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 200)  # the terminal host starts and writes its pid file too
        conn.close()
        for path in ("/", "/api/sessions", "/api/stats", "/api/health"):
            self.assertEqual(get(port, path, 5)[0], 200, path)
        self.check_files()
        self.assertEqual(self.ctl("stop")[0], 0)
        self.assertEqual(glob.glob(os.path.join(self.env.rd, "*.tmp")), [])


class IndexCrashTest(unittest.TestCase):
    """kill -9 while the summary cache (views plus the per-file list index) is written under load: the next start reads a list equal to a cold one."""

    def setUp(self):
        from test_index import rows
        self.rows = rows
        self.env = Env()
        self.state = os.path.join(self.env.tmp, "state")
        os.makedirs(self.state)
        self.proj = os.path.join(self.env.home, "projects", "-work-crash")
        os.makedirs(self.proj)
        self.rng = random.Random(int(os.environ.get("DESK_CRASH_SEED", "11")))
        self.n = 0
        for _ in range(INDEX_FILES):
            self.add()

    def tearDown(self):
        self.assertEqual(self.env.close(), [], "orphan processes after the test")

    def add(self):
        """A new invented transcript (some automated) with a time of its own."""
        self.n += 1
        sid = "%08x-0000-4000-8000-%012x" % (self.n, self.n)
        path = os.path.join(self.proj, sid + ".jsonl")
        with open(path, "w") as fh:
            fh.write(self.rows(sid, 1 + self.n % 3, self.n % 4 == 0, "2026-06-%02dT08:00:00Z" % (1 + self.n % 14)))
        t = 1781000000 + self.n * 7
        os.utime(path, (t, t))

    def change(self):
        """Append a turn to a random transcript, or add a new one."""
        if self.rng.random() < 0.4:
            return self.add()
        i = self.rng.randint(1, self.n)
        sid = "%08x-0000-4000-8000-%012x" % (i, i)
        with open(os.path.join(self.proj, sid + ".jsonl"), "a") as fh:
            fh.write(self.rows(sid, 1, False, "2026-06-15T08:00:00Z"))

    def env_for(self, state):
        """Environment of a process that keeps its caches in this state folder."""
        return dict(self.env.env, DESK_STATE_DIR=state)

    def listing(self, state):
        """A fresh process's list answer from this state folder (sweep, list, flush) as parsed JSON."""
        r = subprocess.run([sys.executable, "-c", LISTER.format(root=ROOT)], env=self.env_for(state), capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        return json.loads(r.stdout)

    def temps(self):
        """Temp files left in the state folder (the caches are dot files, which a plain glob skips)."""
        return [n for n in os.listdir(self.state) if n.endswith(".tmp")]

    def test_kills_while_the_index_is_written_never_change_the_next_list(self):
        warm_loads = swept = 0
        for i in range(INDEX_ROUNDS):
            w = subprocess.Popen([sys.executable, "-c", INDEXER.format(root=ROOT)], env=self.env_for(self.state), stdout=subprocess.PIPE, text=True)
            self.assertEqual(w.stdout.readline().strip(), "go")
            end, mid = time.monotonic() + self.rng.uniform(0.05, 1.2), i % 2 == 1  # odd rounds kill as soon as a temp file shows a write under way
            while time.monotonic() < end:
                for _ in range(10):
                    self.change()
                time.sleep(0.01)
            last = 0.0
            while mid and time.monotonic() < end + 3 and not self.temps():
                if time.monotonic() - last > 0.05:
                    self.change()  # keeps the writer dirty, so writes keep coming
                    last = time.monotonic()
                time.sleep(0.0002)
            w.kill()
            w.wait()
            w.stdout.close()
            cold = os.path.join(self.env.tmp, f"cold{i}")
            os.makedirs(cold)
            warm = self.listing(self.state)
            want = self.listing(cold)
            self.assertEqual(warm["rows"], want["rows"], f"round {i}: the list read with the crashed cache differs from a cold start")
            self.assertEqual(self.temps(), [], f"round {i}: temp files left after the next start")
            warm_loads += warm["loaded"] > 0
            swept += warm["swept"]
            shutil.rmtree(cold)
        self.assertGreater(warm_loads, INDEX_ROUNDS // 2, "the crashed cache was rarely read back: the kills missed the writes")
        if os.environ.get("DESK_CRASH_REPORT"):
            sys.stderr.write(f"\nindex crash: {INDEX_ROUNDS} rounds, {self.n} transcripts, cache read back {warm_loads} times, {swept} temp files swept\n")
        server = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], cwd=self.env.tmp, env=dict(self.env_for(self.state), PORT="0"),
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            port = int(server.stdout.readline().split("127.0.0.1:")[1].split()[0])
            self.assertEqual(get(port, "/api/sessions", 30)[0], 200)
        finally:
            server.terminate()
            server.wait(30)
            server.stdout.close()
        self.assertEqual(self.temps(), [])


if __name__ == "__main__":
    unittest.main()
