"""A stranger's first run: health `setup` in each situation, the start line's hint, a read-only app folder, a missing CLI, an old Python,
a second server for one folder, plain one-line failures, and the opt-in memory probe."""
import http.client
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from helpers import FIXTURE, ROOT, FakeHome, Served, wait_until
from test_terms import TermBase, host_pids
from test_termhost import SID, Env, Server
from desk import config, firstrun, messages, termhost, terms

STUB = "#!/bin/sh\nexit 0\n"


def load_entry():
    """server.py as a module, without running it."""
    spec = importlib.util.spec_from_file_location("desk_entry", os.path.join(ROOT, "server.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def get(port, path):
    """GET a JSON route of a running server."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("GET", path, headers={"Host": f"127.0.0.1:{port}"})
    r = conn.getresponse()
    body = json.loads(r.read())
    conn.close()
    return body


def read_only(path):
    """Make a folder read-only for its owner (the test runs as that owner)."""
    os.chmod(path, stat.S_IRUSR | stat.S_IXUSR)


class SetupValuesTest(unittest.TestCase):
    """The exact `setup` answer and `ok` for a fresh machine, no CLI, a read-only folder and all fine."""

    def setUp(self):
        self.home = FakeHome()
        self.cli = os.path.join(self.home.tmp, "cli")
        with open(self.cli, "w") as fh:
            fh.write(STUB)
        os.chmod(self.cli, 0o755)
        self.saved = config.CLAUDE
        config.CLAUDE = self.cli
        self.env = mock.patch.dict(os.environ, {"DESK_CLAUDE_BIN": self.cli})
        self.env.start()
        firstrun._cache["key"] = None
        self.srv = Served()

    def tearDown(self):
        self.srv.close()
        self.env.stop()
        config.CLAUDE = self.saved
        os.chmod(self.home.tmp, 0o700)
        self.home.close()

    def health(self):
        """Health with a fresh setup answer."""
        firstrun._cache["key"] = None
        h = self.srv.json("/api/health")[1]
        self.assertIsInstance(h["setup"].pop("warming"), bool)
        return h

    def test_all_fine(self):
        h = self.health()
        n = len([f for p in os.listdir(os.path.join(self.home.home, "projects"))
                 for f in os.listdir(os.path.join(self.home.home, "projects", p)) if f.endswith(".jsonl")])
        self.assertEqual(h["setup"], {"dataDir": "ok", "sessions": n, "cli": "ok", "stateDir": "ok", "hint": ""})
        self.assertGreater(n, 0)
        self.assertIs(h["ok"], True)

    def test_fresh_machine(self):
        config.HOME = os.path.join(self.home.tmp, "no-such-folder")
        h = self.health()
        self.assertEqual(h["setup"], {"dataDir": "missing", "sessions": 0, "cli": "ok", "stateDir": "ok", "hint": firstrun.DATA_MISSING})
        self.assertIs(h["ok"], False)

    def test_no_sessions_yet(self):
        config.HOME = os.path.join(self.home.tmp, "empty-claude")
        os.makedirs(config.HOME)
        h = self.health()
        self.assertEqual(h["setup"], {"dataDir": "ok", "sessions": 0, "cli": "ok", "stateDir": "ok", "hint": firstrun.NO_SESSIONS})
        self.assertIs(h["ok"], True)

    def test_unreadable_data_folder(self):
        os.chmod(self.home.home, 0)
        try:
            h = self.health()
        finally:
            os.chmod(self.home.home, 0o700)
        self.assertEqual((h["setup"]["dataDir"], h["setup"]["hint"], h["ok"]), ("unreadable", firstrun.DATA_UNREADABLE, False))

    def test_no_cli(self):
        config.CLAUDE = os.path.join(self.home.tmp, "missing-cli")
        h = self.health()
        self.assertEqual(h["setup"]["cli"], "missing")
        self.assertEqual(h["setup"]["hint"], "The `claude` command was not found: install Claude Code or set DESK_CLAUDE_BIN.")
        self.assertIs(h["ok"], True)  # sessions still show

    def test_cli_not_executable(self):
        os.chmod(self.cli, 0o644)
        h = self.health()
        self.assertEqual((h["setup"]["cli"], h["ok"]), ("notExecutable", True))
        self.assertIn("cannot be run", h["setup"]["hint"])

    def test_read_only_state_folder(self):
        read_only(self.home.tmp)
        h = self.health()
        self.assertEqual(h["setup"]["stateDir"], "readOnly")
        self.assertEqual(h["setup"]["hint"], "This folder is read-only: start with DESK_STATE_DIR=<a folder you can write>.")
        self.assertIs(h["ok"], False)

    def test_answer_is_reused_for_a_few_seconds(self):
        self.health()
        config.CLAUDE = os.path.join(self.home.tmp, "cli")
        os.chmod(self.cli, 0o644)
        self.assertEqual(self.srv.json("/api/health")[1]["setup"]["cli"], "ok")  # cached
        firstrun._cache["at"] -= firstrun.TTL
        self.assertEqual(self.srv.json("/api/health")[1]["setup"]["cli"], "notExecutable")


class MissingCliLocalTest(TermBase):
    """Terminal open and quick reply refuse before spawning when the CLI is missing (terminals as children of the server)."""
    HOSTED = False

    def test_open_and_reply_refuse(self):
        config.CLAUDE = os.path.join(self.home.tmp, "missing-cli")
        self.assertEqual(terms.open_term(self.sids[0], 80, 24), (termhost.CLI_MISSING, False))
        self.assertEqual(terms.send_reply(self.sids[1], "hello"), messages.say("reply", "cliMissing"))
        self.assertEqual((terms.live_count(), terms._replies), (0, {}))
        self.assertEqual(host_pids(self.home.tmp), [])

    def test_route_returns_the_text(self):
        config.CLAUDE = os.path.join(self.home.tmp, "missing-cli")
        srv = Served()
        try:
            page = srv.request("GET", "/")[2]
            token = re.search(rb'DESK_TOKEN="([^"]+)"', page).group(1).decode()
            h = {"Origin": f"http://{srv.host}", "X-Desk-Token": token, "Content-Type": "application/json"}
            status, _, body = srv.request("POST", "/api/term/open", {"id": self.sids[0], "cols": 80, "rows": 24}, h)
            self.assertEqual((status, json.loads(body)["error"]), (409, termhost.CLI_MISSING))
            status, _, body = srv.request("POST", "/api/reply", {"id": self.sids[0], "text": "hi"}, h)
            self.assertEqual((status, json.loads(body)["error"]), (409, messages.say("reply", "cliMissing")))
        finally:
            srv.close()


class MissingCliHostTest(TermBase):
    """The same in host mode: no terminal host is started, and a host asked directly refuses too."""
    HOSTED = True

    def test_open_refuses_without_starting_a_host(self):
        config.CLAUDE = os.path.join(self.home.tmp, "missing-cli")
        self.assertEqual(terms.open_term(self.sids[0], 80, 24), (termhost.CLI_MISSING, False))
        self.assertEqual(terms.send_reply(self.sids[1], "hello"), messages.say("reply", "cliMissing"))
        self.assertEqual(host_pids(self.home.tmp), [])
        self.assertFalse(os.path.exists(config.run_dir()))

    def test_host_refuses_a_missing_command(self):
        host = termhost.Host()
        req = {"id": self.sids[0], "cwd": self.home.tmp, "env": {"PATH": "/usr/bin:/bin"}}
        self.assertEqual(host.open(dict(req, argv=[os.path.join(self.home.tmp, "missing-cli"), "--resume"])), {"error": termhost.CLI_MISSING})
        self.assertEqual(host.open(dict(req, argv=["no-such-command-desk"])), {"error": termhost.CLI_MISSING})
        self.assertEqual(host.terms, {})


class EntryTest(unittest.TestCase):
    """server.py's own checks: Python version, one-line failures."""

    def test_old_python_gets_one_sentence(self):
        entry = load_entry()
        self.assertEqual(entry.version_problem((3, 8, 10, "final", 0)), "Session Desk needs Python 3.9 or newer; this is 3.8")
        self.assertIsNone(entry.version_problem((3, 9, 0, "final", 0)))
        self.assertIsNone(entry.version_problem())
        with mock.patch.object(entry, "version_problem", return_value="Session Desk needs Python 3.9 or newer; this is 3.8"), \
                mock.patch.object(entry.sys, "stderr") as err:
            self.assertEqual(entry.run([]), 1)
        self.assertEqual(err.write.call_args[0][0], "Session Desk needs Python 3.9 or newer; this is 3.8\n")

    def test_entry_imports_nothing_before_the_check(self):
        with open(os.path.join(ROOT, "server.py")) as fh:
            top = [ln for ln in fh if ln.startswith(("import ", "from "))]
        self.assertEqual(top, ["import os\n", "import sys\n"])

    def test_start_failure_is_one_line_with_the_log(self):
        tmp = tempfile.mkdtemp(prefix="desk-entry-")
        try:
            with open(os.path.join(tmp, "sitecustomize.py"), "w") as fh:  # a planted failure when the server binds its port
                fh.write("import socketserver\n\n\ndef boom(self):\n    raise RuntimeError('planted failure')\n\n\nsocketserver.TCPServer.server_bind = boom\n")
            env = dict(os.environ, PORT="0", PYTHONPATH=tmp, DESK_STATE_DIR=tmp, DESK_CLAUDE_DIR=os.path.join(tmp, "claude"))
            env.pop("DESK_DEBUG", None)
            bad = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], env=dict(env, PORT="not-a-port"), cwd=tmp, capture_output=True, text=True, timeout=30)
            self.assertEqual((bad.returncode, (bad.stdout + bad.stderr).strip()), (1, "Session Desk: PORT must be a number from 0 to 65535, not 'not-a-port'"))
            r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], env=env, cwd=tmp, capture_output=True, text=True, timeout=30)
            out = r.stdout + r.stderr
            self.assertEqual(r.returncode, 1, out)
            self.assertNotIn("Traceback", out)
            self.assertEqual(len(out.strip().splitlines()), 1, out)
            log = re.search(r"details in (\S+)$", out.strip()).group(1)
            with open(log) as fh:
                self.assertIn("Traceback", fh.read())
            os.unlink(log)
            r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], env=dict(env, DESK_DEBUG="1"), cwd=tmp, capture_output=True,
                               text=True, timeout=30)
            self.assertIn("Traceback", r.stderr)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class ForegroundTest(unittest.TestCase):
    """Real servers as a stranger starts them."""

    def setUp(self):
        self.env = Env()
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.terminate()
                p.wait(15)
            if p.stdout:
                p.stdout.close()
        for d, _, _ in os.walk(self.env.tmp):
            os.chmod(d, 0o700)
        self.assertEqual(self.env.close(), [], "processes left behind")

    def serve(self, env):
        """Start `python3 server.py` with env; returns (process, port, the lines after the URL line until the first request answers)."""
        p = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py")], env=env, cwd=self.env.tmp, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True)
        self.procs.append(p)
        line = p.stdout.readline()
        m = re.search(r"127\.0\.0\.1:(\d+)", line)
        self.assertTrue(m, line)
        port = int(m.group(1))
        extra = []
        h = get(port, "/api/health")
        return p, port, h, extra

    def next_lines(self, p, n):
        """The next n output lines of a server."""
        return [p.stdout.readline().rstrip("\n") for _ in range(n)]

    def test_fresh_machine_says_what_to_do(self):
        home = os.path.join(self.env.tmp, "home")
        os.makedirs(home)
        env = {"HOME": home, "PATH": "/usr/bin:/bin", "PORT": "0", "DESK_STATE_DIR": os.path.join(self.env.tmp, "state")}
        os.makedirs(env["DESK_STATE_DIR"])
        p, port, h, _ = self.serve(env)
        self.assertEqual(self.next_lines(p, 1), ["  " + firstrun.DATA_MISSING])
        self.assertIsInstance(h["setup"].pop("warming"), bool)
        self.assertEqual(h["setup"], {"dataDir": "missing", "sessions": 0, "cli": "missing", "stateDir": "ok", "hint": firstrun.DATA_MISSING})
        self.assertIs(h["ok"], False)
        self.assertFalse(os.path.exists(os.path.join(home, ".claude")))

    def test_read_only_folder_runs_without_terminals_or_writes(self):
        state = os.path.join(self.env.tmp, "ro")
        os.makedirs(state)
        read_only(state)
        env = dict(self.env.env, PORT="0", DESK_STATE_DIR=state)
        p, port, h, _ = self.serve(env)
        note = self.next_lines(p, 1)[0]
        self.assertEqual(note, "  " + messages.say("startLine", "readOnly"))
        self.assertEqual((h["setup"]["stateDir"], h["ok"]), ("readOnly", False))
        page = Server.__new__(Server)
        page.port = port
        page.token = re.search(rb'DESK_TOKEN="([^"]+)"', page.call("GET", "/")[1]).group(1).decode()
        status, body = page.call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24})
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)["error"], messages.say("termOpen", "readOnly"))
        self.assertTrue(wait_until(lambda: get(port, "/api/stats").get("ready"), timeout=20))  # stats still count
        self.assertEqual(os.listdir(state), [], "the read-only folder was written")
        for verb, code, text in (("start", 1, "cannot run in the background"), ("restart", 1, "cannot run in the background"), ("status", 3, "not running")):
            r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), verb], env=env, cwd=self.env.tmp, capture_output=True, text=True,
                               timeout=60)
            out = r.stdout + r.stderr
            self.assertEqual(r.returncode, code, out)
            self.assertIn(text, out)
            self.assertNotIn("Traceback", out)
        r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "doctor"], env=env, cwd=self.env.tmp, capture_output=True, text=True,
                           timeout=60)
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertRegex(r.stdout, r"(?m)^FAIL +state folder .*: This folder is read-only: start with DESK_STATE_DIR=")
        self.assertRegex(r.stdout, r"(?m)^FAIL +run folder +cannot create .*: This folder is read-only")
        self.assertEqual(os.listdir(state), [])
        p.terminate()
        p.wait(15)
        self.assertEqual([n for n in os.listdir(tempfile.gettempdir()) if n.startswith(f"session-desk-cache-{p.pid}-")], [], "temp caches left")

    def test_second_server_for_one_folder_is_refused(self):
        a, port, _, _ = self.serve(dict(self.env.env, PORT="0"))
        r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py")], env=dict(self.env.env, PORT="0"), cwd=self.env.tmp,
                           capture_output=True, text=True, timeout=30)
        out = r.stdout + r.stderr
        self.assertEqual(r.returncode, 1, out)
        self.assertIn(f"already runs for this data folder: pid {a.pid}, http://127.0.0.1:{port}", out)
        self.assertNotIn("Traceback", out)

    def test_memory_probe_is_opt_in(self):
        _, port, h, _ = self.serve(dict(self.env.env, PORT="0"))
        self.assertNotIn("memTop", h)
        os.makedirs(os.path.join(self.env.tmp, "two"))
        _, port, h, _ = self.serve(dict(self.env.env, PORT="0", DESK_TRACEMALLOC="1", DESK_STATE_DIR=os.path.join(self.env.tmp, "two")))
        top = h["memTop"]
        self.assertTrue(0 < len(top) <= 10, top)
        for row in top:
            self.assertEqual(set(row), {"file", "line", "size", "count"})
            self.assertFalse(row["file"].startswith("/"), row)
        self.assertEqual([r["size"] for r in top], sorted((r["size"] for r in top), reverse=True))


if __name__ == "__main__":
    unittest.main()
