"""Page terminals and replies under races and shutdown: one CLI per session, no writes after exit, no orphans, bounded memory."""
import contextlib
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock

from helpers import ROOT, FakeHome, wait_until
from desk import config, ctl, sessions, termhost, terms

START_WAIT = 20  # seconds a stub CLI may take to start on a loaded machine (two interpreter starts when the host is new)
STUB = """#!{python}
import os, signal, sys, time
d = os.environ["DESK_STUB_DIR"]
open(os.path.join(d, "pid-%d" % os.getpid()), "w").close()
mode = os.environ.get("DESK_STUB_MODE", "")
if mode == "exit":
    sys.exit(0)
signal.signal(signal.SIGHUP, signal.SIG_IGN)
if mode == "family" and os.fork() == 0:
    open(os.path.join(d, "kid-%d" % os.getpid()), "w").close()
    time.sleep(60)
    os._exit(0)
time.sleep(60)
"""


def alive(pid):
    """True while a process exists and is not a zombie of ours."""
    try:
        if os.waitpid(pid, os.WNOHANG)[0]:
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def host_pids(tmp):
    """Terminal host processes whose run folder is inside a test folder."""
    out = subprocess.run(["pgrep", "-f", "desk.termhost --dir " + tmp], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out]


class TermBase(unittest.TestCase):
    """A fake data folder with sessions whose folders exist and a stub CLI; no orphan may be left."""
    HOSTED = False

    def setUp(self):
        self.home = FakeHome()
        self.mode = mock.patch.object(config, "TERMHOST", self.HOSTED)
        self.mode.start()
        self.stub_dir = os.path.join(self.home.tmp, "stub")
        os.makedirs(self.stub_dir)
        cli = os.path.join(self.home.tmp, "fake-cli")
        with open(cli, "w") as fh:
            fh.write(STUB.format(python=sys.executable))
        os.chmod(cli, 0o755)
        self.saved = config.CLAUDE
        config.CLAUDE = cli
        self.env = mock.patch.dict(os.environ, {"DESK_STUB_DIR": self.stub_dir, "DESK_STUB_MODE": ""})
        self.env.start()
        self.sids = [self.session(i) for i in range(terms.MAX_TERMS + 4)]

    def tearDown(self):
        terms.stop_all(1)
        left = [p for p in self.pids() + self.pids("kid-") if alive(p)]
        hosts = host_pids(self.home.tmp)
        for pid in left + hosts:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.mode.stop()
        self.env.stop()
        config.CLAUDE = self.saved
        self.home.close()
        self.assertEqual((left, hosts), ([], []), "orphan processes after stop_all")

    def session(self, i):
        """A transcript whose folder exists, so terminals and replies may start."""
        sid = f"abcdef12-0000-4000-8000-{i:012d}"
        project = os.path.join(self.home.home, "projects", "-tmp-terms")
        os.makedirs(project, exist_ok=True)
        rec = {"type": "user", "uuid": "u1", "parentUuid": None, "isSidechain": False, "timestamp": "2026-01-01T00:00:00Z", "entrypoint": "cli",
               "cwd": self.home.tmp, "message": {"role": "user", "content": "hello"}}
        with open(os.path.join(project, sid + ".jsonl"), "w") as fh:
            fh.write(json.dumps(rec) + "\n")
        return sid

    def pids(self, prefix="pid-"):
        """Process ids the stub CLIs wrote so far."""
        return [int(n.split("-")[1]) for n in os.listdir(self.stub_dir) if n.startswith(prefix)]

    def slow_parse(self):
        """Patch sessions.parse so parallel callers all pass their checks before any CLI starts."""
        real = sessions.parse
        return mock.patch.object(sessions, "parse", side_effect=lambda p: (time.sleep(0.2), real(p))[1])


class TermTest(TermBase):
    """Page terminals as children of the server (DESK_TERMHOST=0)."""

    def test_parallel_opens_start_one_cli(self):
        sid, out = self.sids[0], []
        with self.slow_parse():
            threads = [threading.Thread(target=lambda: out.append(terms.open_term(sid, 80, 24))) for _ in range(3)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(out, [(None, False)] * 3)
        self.assertTrue(wait_until(lambda: self.pids(), timeout=START_WAIT))
        time.sleep(0.5)
        self.assertEqual(self.pids(), [terms.own_pid(sid)])  # the one CLI started is the one the server tracks
        self.assertEqual(terms.live_count(), 1)

    def test_parallel_replies_start_one_cli(self):
        sid, out = self.sids[0], []
        with self.slow_parse():
            threads = [threading.Thread(target=lambda: out.append(terms.send_reply(sid, "hi"))) for _ in range(3)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(sorted(out, key=str), [None, "session is still working", "session is still working"])
        self.assertTrue(wait_until(lambda: self.pids(), timeout=START_WAIT))
        time.sleep(0.5)
        self.assertEqual(len(self.pids()), 1)

    def test_end_kills_the_whole_process_group(self):
        os.environ["DESK_STUB_MODE"] = "family"
        self.assertEqual(terms.open_term(self.sids[0], 80, 24), (None, False))
        self.assertTrue(wait_until(lambda: self.pids() and self.pids("kid-"), timeout=START_WAIT))
        (cli,), (kid,) = self.pids(), self.pids("kid-")
        terms._terms[self.sids[0]].end(0.3)
        self.assertTrue(wait_until(lambda: not alive(cli) and not alive(kid), timeout=3), "CLI or its child still running")

    def test_no_writes_after_exit(self):
        os.environ["DESK_STUB_MODE"] = "exit"
        self.assertEqual(terms.open_term(self.sids[0], 80, 24), (None, False))
        t = terms._terms[self.sids[0]]
        self.assertTrue(wait_until(lambda: t.code is not None))
        self.assertTrue(wait_until(lambda: getattr(t, "fd", -1) == -1))
        self.assertEqual(terms.term_action(self.sids[0], "/api/term/input", {"data": "x"}), "terminal not running")
        self.assertIsNotNone(t.write(b"x"))
        t.resize(80, 24)  # a late resize is ignored, not an error

    def test_finished_terminals_are_dropped(self):
        os.environ["DESK_STUB_MODE"] = "exit"
        for sid in self.sids:
            self.assertEqual(terms.open_term(sid, 80, 24)[0], None)
            self.assertTrue(wait_until(lambda: sid in terms._terms and terms._terms[sid].code is not None))
        self.assertLessEqual(len(terms._terms), terms.KEEP_DONE + 1)
        self.assertIn(self.sids[-1], terms._terms)

    def test_stop_all_ends_replies(self):
        self.assertIsNone(terms.send_reply(self.sids[0], "hi"))
        proc = terms._replies[self.sids[0]]["proc"]
        self.assertTrue(wait_until(lambda: self.pids(), timeout=START_WAIT))
        terms.stop_all(1)
        self.assertIsNotNone(proc.poll())
        self.assertEqual(terms.reply_state(self.sids[0]), "answered")


    def test_model_from_a_session_file_cannot_add_cli_flags(self):
        for model, want in (("--dangerously-skip-permissions", None), ("-x", None), ("a b", None), ("x" * 200, None),
                            ("claude-opus-4-5", "claude-opus-4-5"), ("model-x[1m]", "model-x[1m]")):
            parsed = {"cwd": self.home.tmp, "model": model}
            with mock.patch.object(sessions, "parse", return_value=parsed), mock.patch.object(terms.subprocess, "Popen") as popen:
                terms._replies.clear()
                self.assertIsNone(terms.send_reply(self.sids[0], "hi"))
            cmd = popen.call_args[0][0]
            self.assertEqual(cmd[1:4], ["-p", "--resume", self.sids[0]])
            self.assertEqual(cmd[4:], ["--model", want] if want else [], model[:30])
        terms._replies.clear()


class HostedTermTest(TermTest):
    """The same rules with page terminals in the terminal host (the default)."""
    HOSTED = True

    def test_terminal_outlives_the_server_side_state(self):
        sid = self.sids[0]
        self.assertEqual(terms.open_term(sid, 80, 24), (None, False))
        self.assertTrue(wait_until(lambda: self.pids(), timeout=START_WAIT))
        (cli,) = self.pids()
        terms.shutdown(1)  # what a server does on SIGTERM
        terms._terms.clear()
        terms._host.update(watch=None, token=None, closing=False)
        self.assertTrue(alive(cli))
        self.assertIsNone(terms.attach())
        self.assertTrue(terms.term_alive(sid))
        self.assertEqual(terms.own_pid(sid), cli)
        self.assertEqual(terms.open_term(sid, 80, 24), (None, False))  # re-attach, no second CLI
        self.assertEqual(len(self.pids()), 1)

    def test_host_enforces_the_cap(self):
        for sid in self.sids[:terms.MAX_TERMS]:
            self.assertEqual(terms.open_term(sid, 80, 24), (None, False))
        terms._terms.clear()  # a server that has not seen the list yet still cannot pass the cap
        with mock.patch.object(terms, "attach", return_value=None):
            err, _ = terms.open_term(self.sids[-1], 80, 24)
        self.assertIn("terminals already open", err)

    def test_other_protocol_is_refused_with_how_to_stop(self):
        self.assertEqual(terms.open_term(self.sids[0], 80, 24), (None, False))
        terms._terms.clear()
        terms._host.update(watch=None, token=None)
        terms._host["synced"].clear()
        with mock.patch.object(termhost, "PROTOCOL", termhost.PROTOCOL + 1):
            err, _ = terms.open_term(self.sids[1], 80, 24)
            self.assertIn("stop-terminals", err)
            self.assertIn(f"protocol {termhost.PROTOCOL - 1}", err)
            self.assertIn("stop-terminals", terms.host_status()["error"])
        self.assertTrue(wait_until(lambda: self.pids(), timeout=START_WAIT))
        time.sleep(0.3)
        self.assertEqual(len(self.pids()), 1)


class StaleHostTest(TermBase):
    """A terminal host left running from before an app update: shown in health and status, replaced at the next open when it holds no terminal."""
    HOSTED = True

    def old_host(self):
        """Start a host from a copy of the package whose termhost.py is a day older, as one started before an update."""
        old = os.path.join(self.home.tmp, "old")
        shutil.copytree(os.path.join(ROOT, "desk"), os.path.join(old, "desk"), ignore=shutil.ignore_patterns("__pycache__"))
        then = time.time() - 86400
        os.utime(os.path.join(old, "desk", "termhost.py"), (then, then))
        rd = termhost.private_dir(config.run_dir())
        p = subprocess.Popen([sys.executable, "-m", "desk.termhost", "--dir", rd], cwd=old, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
        self.addCleanup(lambda: (p.poll() is None and p.kill(), p.wait()))
        self.assertTrue(wait_until(terms.host_hello, timeout=START_WAIT))
        return p

    def test_older_host_without_terminals_is_replaced_at_the_next_open(self):
        p = self.old_host()
        st = terms.host_status()
        self.assertEqual((st["older"], st["pid"], st["terms"]), (True, p.pid, 0))
        self.assertLess(st["codeVersion"], termhost.CODE_VERSION)
        self.assertEqual(st["note"], "terminal host is older than this server; it keeps running until its terminals end, "
                                     "or run `python3 server.py stop-terminals`")
        with contextlib.redirect_stdout(io.StringIO()) as out:
            ctl.status()
        self.assertIn(st["note"], out.getvalue())
        self.assertEqual(terms.open_term(self.sids[0], 80, 24), (None, False))
        self.assertEqual(p.wait(10), 0, "the older host was not stopped")
        st = terms.host_status()
        self.assertEqual((st["older"], st["note"], st["codeVersion"], st["terms"]), (False, None, termhost.CODE_VERSION, 1))
        self.assertTrue(wait_until(lambda: self.pids(), timeout=START_WAIT))
        self.assertTrue(terms.term_alive(self.sids[0]))

    def test_older_host_with_a_terminal_keeps_running(self):
        p = self.old_host()
        req = {"op": "open", "id": self.sids[0], "argv": [config.CLAUDE, "--resume", self.sids[0]], "env": terms.child_env(), "cwd": self.home.tmp}
        self.assertIn("term", termhost.call(config.run_dir(), req))
        self.assertEqual(terms.open_term(self.sids[1], 80, 24), (None, False))
        self.assertIsNone(p.poll(), "an older host with a live terminal was stopped")
        st = terms.host_status()
        self.assertEqual((st["pid"], st["older"], st["terms"]), (p.pid, True, 2))
        self.assertTrue(wait_until(lambda: len(self.pids()) == 2, timeout=START_WAIT))


if __name__ == "__main__":
    unittest.main()
