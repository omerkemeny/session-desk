"""Two real servers on one state and data folder (normally refused; here each record is dropped to force it): simultaneous opens, the same session from both, restart, SIGKILL mid-open, an older host
replaced meanwhile, and a second start on a taken port. No lost terminal, no duplicate CLI, no orphan, both lists agree."""
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

from helpers import ROOT, wait_until
from test_termhost import SID, Env, Server, read_until

SID2 = "abcdef12-0000-4000-8000-000000000003"


class TwoEnv(Env):
    """The terminal-host test folder with a second session in the same project."""

    def __init__(self):
        super().__init__()
        project = os.path.join(self.home, "projects", "-tmp-host")
        rec = {"type": "user", "uuid": "u2", "parentUuid": None, "isSidechain": False, "timestamp": "2026-01-01T00:00:01Z", "entrypoint": "cli",
               "cwd": self.tmp, "message": {"role": "user", "content": "second"}}
        with open(os.path.join(project, SID2 + ".jsonl"), "w") as fh:
            fh.write(json.dumps(rec) + "\n")


def clis(env):
    """Pids of running stub CLIs of this folder."""
    out = subprocess.run(["pgrep", "-f", env.cli], capture_output=True, text=True).stdout.split()
    return sorted(int(p) for p in out if int(p) != os.getpid())


def terms_of(srv):
    """{session id: term} from a server's full list, or None when it does not answer."""
    try:
        status, body = srv.call("GET", "/api/sessions")
    except OSError:
        return None
    return {r["id"]: r["term"] for r in json.loads(body)} if status == 200 else None


def at_once(*calls):
    """Run the calls in threads released together; returns their results in order."""
    gate, out = threading.Barrier(len(calls)), [None] * len(calls)

    def run(i, fn):
        """Wait for the others, then call."""
        gate.wait()
        try:
            out[i] = fn()
        except Exception as e:  # a server killed mid-request
            out[i] = e
    threads = [threading.Thread(target=run, args=(i, fn)) for i, fn in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    return out


def opener(srv, sid):
    """A call that opens a session's terminal on a server; returns (status, body)."""
    return lambda: srv.call("POST", "/api/term/open", {"id": sid, "cols": 80, "rows": 24})


class TwoServersTest(unittest.TestCase):
    def setUp(self):
        self.env = TwoEnv()
        self.servers = []

    def tearDown(self):
        for s in self.servers:
            if s.proc.poll() is None:
                s.kill(signal.SIGTERM)
        self.assertEqual(self.env.close(), [], "processes left behind")

    def start(self, record=False):
        """One more foreground server; its record is dropped unless `record`, as if two servers passed the one-server check at once."""
        s = Server(self.env)
        self.servers.append(s)
        if not record:
            os.unlink(os.path.join(self.env.rd, "server.json"))
        return s

    def agree(self, want):
        """True once every running server lists `want` ({sid: term})."""
        return all((terms_of(s) or {}).get(k) == v for s in self.servers if s.proc.poll() is None for k, v in want.items())

    def test_different_sessions_at_the_same_instant(self):
        a, b = self.start(), self.start()
        for r in range(20):
            got = at_once(opener(a, SID), opener(b, SID2))
            self.assertEqual([g[0] for g in got], [200, 200], f"round {r}: {got}")
            self.assertTrue(wait_until(lambda: self.agree({SID: True, SID2: True}), timeout=10), f"round {r}: lists disagree")
            self.assertTrue(wait_until(lambda: len(clis(self.env)) == 2, timeout=5), f"round {r}: {clis(self.env)}")  # a CLI may still be exec-ing
            at_once(lambda: a.call("POST", "/api/term/close", {"id": SID}), lambda: b.call("POST", "/api/term/close", {"id": SID2}))
            self.assertTrue(wait_until(lambda: self.agree({SID: False, SID2: False}) and not clis(self.env), timeout=10), f"round {r}: not ended")

    def test_same_session_from_both_gives_one_cli(self):
        a, b = self.start(), self.start()
        got = at_once(opener(a, SID), opener(b, SID))
        self.assertEqual([g[0] for g in got], [200, 200], got)
        self.assertTrue(wait_until(lambda: self.agree({SID: True}), timeout=10))
        wait_until(lambda: clis(self.env), timeout=5)
        time.sleep(0.3)  # a duplicate would show up by now
        pids = clis(self.env)
        self.assertEqual(len(pids), 1)
        for s in (a, b):
            conn, resp = s.stream()
            text = read_until(resp, f"cli ready {pids[0]}")[0]
            conn.close()
            self.assertIn(f"cli ready {pids[0]}", text)

    def test_restart_while_the_other_opens(self):
        a, b = self.start(), self.start()

        def restart():
            """SIGTERM the first server, then start a new one on the same folders."""
            a.kill(signal.SIGTERM)
            return self.start()
        got = at_once(restart, opener(b, SID))
        self.assertEqual(got[1][0], 200, got)
        self.assertTrue(wait_until(lambda: self.agree({SID: True}), timeout=10))
        self.assertTrue(wait_until(lambda: len(clis(self.env)) == 1, timeout=5))

    def test_sigkill_mid_open(self):
        for r in range(3):
            a, b = self.start(), self.start()

            def kill_soon():
                """SIGKILL the first server a moment into its open."""
                time.sleep(random.uniform(0, 0.15))
                a.proc.kill()
                a.proc.wait(10)
                a.proc.stdout.close()
            at_once(lambda: self._try(opener(a, SID)), kill_soon)
            status, body = b.call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24})
            self.assertEqual(status, 200, body)
            self.assertTrue(wait_until(lambda: self.agree({SID: True}), timeout=10))
            self.assertTrue(wait_until(lambda: len(clis(self.env)) == 1, timeout=5), f"round {r}: {clis(self.env)}")
            b.call("POST", "/api/term/close", {"id": SID})
            self.assertTrue(wait_until(lambda: not clis(self.env), timeout=10))
            b.kill(signal.SIGTERM)
            self.servers = []

    def _try(self, fn):
        """Call, swallowing the connection error of a killed server."""
        try:
            return fn()
        except OSError:
            return None

    def test_older_host_replaced_while_the_other_opens(self):
        old = os.path.join(self.env.tmp, "oldcode")
        shutil.copytree(os.path.join(ROOT, "desk"), os.path.join(old, "desk"), ignore=shutil.ignore_patterns("__pycache__"))
        stamp = time.time() - 86400
        os.utime(os.path.join(old, "desk", "termhost.py"), (stamp, stamp))
        host = subprocess.Popen([sys.executable, "-m", "desk.termhost", "--dir", self.env.rd], cwd=old, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        a, b = self.start(), self.start()
        self.assertTrue(wait_until(lambda: json.loads(a.call("GET", "/api/health")[1])["termhost"].get("older"), timeout=10))
        got = at_once(opener(a, SID), opener(b, SID2))
        self.assertEqual([g[0] for g in got], [200, 200], got)
        self.assertEqual(host.wait(15), 0)  # the older host was stopped
        self.assertTrue(wait_until(lambda: self.agree({SID: True, SID2: True}), timeout=10))
        self.assertTrue(wait_until(lambda: len(clis(self.env)) == 2, timeout=5))
        for s in (a, b):
            th = json.loads(s.call("GET", "/api/health")[1])["termhost"]
            self.assertEqual((th["older"], th["terms"]), (False, 2))

    def test_second_start_on_a_taken_port_names_the_running_one(self):
        a = self.start(record=True)
        env = dict(self.env.env, PORT=str(a.port))
        out = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], env=env, cwd=self.env.tmp, capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
        self.assertIn(f"already runs for this data folder: pid {a.proc.pid}, http://127.0.0.1:{a.port}", out.stdout)
        self.assertNotIn("Traceback", out.stdout + out.stderr)
        out = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "start"], env=env, cwd=self.env.tmp, capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 1)
        self.assertIn(f"already running: pid {a.proc.pid}, http://127.0.0.1:{a.port}", out.stdout)


if __name__ == "__main__":
    unittest.main()
