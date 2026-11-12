"""Round 9 verbs: restart with nothing running, ctl.lock mode, doctor's own setup wording, `logs` and `status --json`."""
import contextlib
import http.client
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from helpers import ROOT
from test_termhost import SID, Env, read_until
from desk import config, ctl, doctor, firstrun


class InProcessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="desk-verbs-")
        self.patches = [mock.patch.object(config, "STATE_DIR", self.tmp), mock.patch.object(config, "HOME", os.path.join(self.tmp, "home"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def restart(self, env):
        """Run restart with nothing running and start replaced; returns (port passed to start, printed text)."""
        got, out = [], io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False), mock.patch.object(ctl, "running", return_value=None), \
                mock.patch.object(ctl, "start", side_effect=lambda port=None: got.append(port) or 0), contextlib.redirect_stdout(out):
            if "PORT" not in env:
                os.environ.pop("PORT", None)
            self.assertEqual(ctl.restart(), 0)
        return got[0], out.getvalue()

    def test_restart_with_nothing_running_uses_the_default_and_says_so(self):
        port, out = self.restart({})
        self.assertEqual(port, config.PORT)
        self.assertEqual(out, f"nothing was running and no port is recorded; starting on the default port {config.PORT}\n")

    def test_restart_with_nothing_running_uses_the_last_recorded_port(self):
        with open(ctl._path(ctl.LAST_PORT), "w") as fh:
            fh.write("9123\n")
        port, out = self.restart({})
        self.assertEqual(port, 9123)
        self.assertEqual(out, "nothing was running; starting on port 9123, the last one this data folder used\n")

    def test_restart_with_port_set_says_so(self):
        with mock.patch.object(config, "PORT", 9124):
            port, out = self.restart({"PORT": "9124"})
        self.assertEqual((port, out), (9124, "nothing was running; starting on port 9124 (PORT)\n"))

    def test_bad_last_port_records_are_ignored(self):
        for text in ("", "x", "0", "70000", "-5"):
            with open(ctl._path(ctl.LAST_PORT), "w") as fh:
                fh.write(text)
            self.assertIsNone(ctl.last_port(), text)

    def test_ctl_lock_is_private(self):
        with ctl.lock_file():
            pass
        path = ctl._path(ctl.CTL_LOCK)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        os.chmod(path, 0o644)  # an older version left it readable: the next use tightens it
        with ctl.lock_file():
            pass
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)

    def test_doctor_has_its_own_words_for_every_setup_hint(self):
        hints = [firstrun.DATA_MISSING, firstrun.DATA_UNREADABLE, firstrun.NO_SESSIONS, firstrun.READ_ONLY] + list(firstrun.CLI_HINTS.values())
        for h in hints:
            self.assertNotIn("reload", doctor.terminal_hint(h).lower(), h)
        self.assertEqual(doctor.terminal_hint(""), "")

    def test_logs_counts(self):
        self.assertEqual(ctl.log_count([]), ctl.LOG_LINES)
        self.assertEqual(ctl.log_count(["-n", "5"]), 5)
        self.assertEqual(ctl.log_count(["-n", "999999999"]), ctl.LOG_MAX_LINES)
        for bad in (["-n"], ["-n", "x"], ["-n", "-1"], ["5"], ["-n", "5", "6"]):
            self.assertIsNone(ctl.log_count(bad), bad)

    def test_logs_with_no_run_folder_creates_nothing(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(ctl.main(["logs"]), 0)
        self.assertIn("no logs yet", out.getvalue())
        self.assertFalse(os.path.exists(config.run_dir()))

    def test_logs_never_follow_a_link(self):
        rd = ctl._path(ctl.LOGFILE)
        secret = os.path.join(self.tmp, "secret.txt")
        with open(secret, "w") as fh:
            fh.write("linked-9c1\n")
        os.symlink(secret, rd)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ctl.logs(10)
        self.assertNotIn("linked-9c1", out.getvalue())


class VerbServerTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.env["PORT"] = "0"

    def tearDown(self):
        self.run_ctl("stop")
        self.assertEqual(self.env.close(), [], "orphan processes after the test")

    def run_ctl(self, *argv, env=None):
        """Run one verb; returns (exit code, output)."""
        r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), *argv], cwd=self.env.tmp, env=env or self.env.env,
                           capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def record(self):
        """The pid file's record."""
        with open(os.path.join(self.env.rd, "server.json")) as fh:
            return json.load(fh)

    def test_restart_after_stop_reuses_the_last_port_and_status_json(self):
        self.assertEqual(self.run_ctl("start")[0], 0)
        port = self.record()["port"]
        code, out = self.run_ctl("status", "--json")
        rec = json.loads(out)
        self.assertEqual(code, 0, out)
        self.assertEqual((rec["running"], rec["answering"], rec["port"], rec["url"]), (True, True, port, f"http://127.0.0.1:{port}"))
        self.assertEqual(set(rec), {"v", "running", "answering", "pid", "port", "url", "uptime", "codeVersion", "reloads", "terms", "host", "hint"})
        self.assertIsInstance(rec["uptime"], int)
        self.assertEqual(set(rec["host"]), {"running", "pid", "protocol", "terms", "note"})
        self.assertEqual(self.run_ctl("stop")[0], 0)
        self.assertEqual(os.stat(os.path.join(self.env.rd, "ctl.lock")).st_mode & 0o777, 0o600)
        code, out = self.run_ctl("status", "--json")
        rec = json.loads(out)
        self.assertEqual((code, rec["running"], rec["pid"], rec["url"]), (3, False, None, None), out)
        env = dict(self.env.env)
        env.pop("PORT")
        code, out = self.run_ctl("restart", env=env)
        self.assertEqual(code, 0, out)
        self.assertIn(f"nothing was running; starting on port {port}, the last one this data folder used", out)
        self.assertEqual(self.record()["port"], port)

    def test_logs_print_both_logs_without_terminal_text_or_keys(self):
        self.env.env["DESK_TEST_SECRET"] = "canary-77a1"
        self.assertEqual(self.run_ctl("start")[0], 0)
        port = self.record()["port"]

        def call(method, path, body=None, token=""):
            """One request to the running server."""
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            h = {"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}", "X-Desk-Token": token, "Content-Type": "application/json"}
            conn.request(method, path, body=json.dumps(body).encode() if body else None, headers=h)
            r = conn.getresponse()
            out = r.status, r.read()
            conn.close()
            return out

        token = re.search(rb'DESK_TOKEN="([^"]+)"', call("GET", "/")[1]).group(1).decode()
        self.assertEqual(call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24}, token)[0], 200)
        self.assertEqual(call("POST", "/api/term/input", {"id": SID, "data": "typed-5d2c\r"}, token)[0], 200)
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", f"/api/term/stream?id={SID}", headers={"Host": f"127.0.0.1:{port}"})
        self.assertIn("got typed-5d2c", read_until(conn.getresponse(), "got typed-5d2c")[0])
        conn.close()
        code, out = self.run_ctl("logs")
        self.assertEqual(code, 0, out)
        self.assertIn(f"== {os.path.join(self.env.rd, 'server.log')} (last 40 lines)", out)
        self.assertIn(os.path.join(self.env.rd, "termhost.log"), out)
        self.assertIn(f"127.0.0.1:{port}", out)  # the server's start line is in its log
        code, short = self.run_ctl("logs", "-n", "1")
        self.assertEqual(code, 0, short)
        self.assertIn("(last 1 line)", short)
        self.assertEqual(self.run_ctl("logs", "-n")[0], 2)
        for word in ("canary-77a1", "typed-5d2c", token):
            self.assertNotIn(word, out + short)



class BadPortTest(unittest.TestCase):
    """A PORT that is not a port gives one sentence and exit 1 for every verb, before anything is created."""

    def test_every_verb(self):
        tmp = tempfile.mkdtemp(prefix="desk-port-")
        try:
            state = os.path.join(tmp, "state")
            os.makedirs(state)
            base = {"HOME": tmp, "PATH": "/usr/bin:/bin", "DESK_STATE_DIR": state, "DESK_CLAUDE_DIR": os.path.join(tmp, "data")}
            for raw in ("abc", "99999", "-1", ""):
                for argv in ([], ["start"], ["stop"], ["restart"], ["status"], ["status", "--json"], ["stop-terminals"], ["doctor"], ["logs"]):
                    with self.subTest(port=raw, argv=argv):
                        r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), *argv], env=dict(base, PORT=raw), cwd=tmp,
                                           capture_output=True, text=True, timeout=30)
                        self.assertEqual((r.returncode, (r.stdout + r.stderr).strip()), (1, f"Session Desk: PORT must be a number from 0 to 65535, not {raw!r}"))
            self.assertEqual(os.listdir(state), [], "a bad PORT created files")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
