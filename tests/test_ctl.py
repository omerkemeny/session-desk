"""server.py start | stop | restart | status | stop-terminals: detached runs, stale pid files, log rotation, terminals kept across restart."""
import contextlib
import hashlib
import http.client
import io
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import unittest
from unittest import mock

from helpers import ROOT, wait_until
from test_termhost import SID, Env, gone, read_until
from desk import ctl

NOBODY = 9  # port written into hand-made records: below 1024, so no test server of this user can be on it


class CtlTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.env["PORT"] = "0"  # every server picks a free port; tests read it from the pid file

    def tearDown(self):
        self.run_ctl("stop")
        left = self.env.close()
        self.assertEqual(left, [], "orphan processes after the test")

    def run_ctl(self, verb, *extra):
        """Run one verb; returns (exit code, output)."""
        r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), verb, *extra], cwd=self.env.tmp, env=self.env.env,
                           capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def pidfile(self):
        """The pid file's record, or None."""
        try:
            with open(os.path.join(self.env.rd, "server.json")) as fh:
                return json.load(fh)
        except OSError:
            return None

    def port(self):
        """Port of the running server, from its pid file."""
        return self.pidfile()["port"]

    def call(self, method, path, body=None, token=""):
        """One request to the running server."""
        port = self.port()
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        h = {"Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}", "X-Desk-Token": token, "Content-Type": "application/json"}
        conn.request(method, path, body=json.dumps(body).encode() if body else None, headers=h)
        r = conn.getresponse()
        out = r.status, r.read()
        conn.close()
        return out

    def test_start_status_restart_stop(self):
        self.assertEqual(self.run_ctl("status")[0], 3)
        code, out = self.run_ctl("start")
        self.assertEqual(code, 0, out)
        first, port = self.pidfile()["pid"], self.port()
        self.assertIn(f"http://127.0.0.1:{port}", out)
        self.assertEqual(json.loads(self.call("GET", "/api/health")[1])["pid"], first)
        code, out = self.run_ctl("start")
        self.assertEqual((code, "already running" in out), (1, True), out)
        code, out = self.run_ctl("status")
        self.assertEqual(code, 0, out)
        self.assertRegex(out, rf"running: pid {first}, up \d+s, http://127\.0\.0\.1:{port}")
        self.assertIn("0 page terminals", out)

        token = re.search(rb'DESK_TOKEN="([^"]+)"', self.call("GET", "/")[1]).group(1).decode()
        self.assertEqual(self.call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24}, token)[0], 200)
        conn = http.client.HTTPConnection("127.0.0.1", self.port(), timeout=10)
        conn.request("GET", f"/api/term/stream?id={SID}", headers={"Host": f"127.0.0.1:{self.port()}"})
        cli = int(re.search(r"cli ready (\d+)", read_until(conn.getresponse(), "cli ready")[0]).group(1))
        conn.close()

        code, out = self.run_ctl("restart")
        self.assertEqual(code, 0, out)
        second = self.pidfile()["pid"]
        self.assertNotEqual(second, first)
        self.assertTrue(gone(first))
        self.assertFalse(gone(cli), "restart ended a page terminal")
        h = json.loads(self.call("GET", "/api/health")[1])
        self.assertEqual((h["pid"], h["terms"]), (second, 1))
        self.assertIn("1 page terminals", self.run_ctl("status")[1])

        code, out = self.run_ctl("stop")
        self.assertEqual((code, f"stopped pid {second}" in out), (0, True), out)
        self.assertTrue(gone(second))
        self.assertIsNone(self.pidfile())
        self.assertFalse(gone(cli), "stop ended a page terminal")
        self.assertEqual(self.run_ctl("stop"), (0, "not running\n"))
        code, out = self.run_ctl("status")
        self.assertEqual(code, 3)
        self.assertIn("terminal host: pid", out)
        self.assertIn("1 terminals ended", self.run_ctl("stop-terminals")[1])
        self.assertTrue(wait_until(lambda: gone(cli)))
        log = os.path.join(self.env.rd, "server.log")
        self.assertEqual(os.stat(log).st_mode & 0o777, 0o600)

    def test_stale_pid_files_are_not_trusted(self):
        dead = subprocess.Popen(["true"])
        dead.wait()
        os.makedirs(self.env.rd, mode=0o700, exist_ok=True)
        for pid in (dead.pid, os.getpid()):  # a gone process, then a live one that is not a server
            with open(os.path.join(self.env.rd, "server.json"), "w") as fh:
                json.dump({"pid": pid, "port": NOBODY, "started": 0}, fh)
            self.assertEqual(self.run_ctl("status")[0], 3)
            self.assertIsNone(self.pidfile())
        with open(os.path.join(self.env.rd, "server.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "port": NOBODY, "started": 0}, fh)
        code, out = self.run_ctl("start")
        self.assertEqual(code, 0, out)
        self.assertNotEqual(self.pidfile()["pid"], os.getpid())

    def test_logs_rotate_by_size(self):
        os.makedirs(self.env.rd, mode=0o700, exist_ok=True)
        log = os.path.join(self.env.rd, "server.log")
        with open(log, "wb") as fh:
            fh.write(b"x" * 1_100_000)
        code, out = self.run_ctl("start")
        self.assertEqual(code, 0, out)  # the output names the cause (it was a port taken by a parallel suite)
        self.assertEqual(os.path.getsize(log + ".1"), 1_100_000)
        self.assertLess(os.path.getsize(log), 10_000)
        self.run_ctl("stop")
        with open(log, "wb") as fh:
            fh.write(b"y" * 1_100_000)
        code = ("import sys; sys.path.insert(0, %r); from desk import ctl; ctl.rotate_now(%r); print('after rotate', flush=True)" % (ROOT, log))
        with open(log, "ab") as out:
            subprocess.run([sys.executable, "-c", code], stdout=out, stderr=out, timeout=30)
        with open(log) as fh:
            self.assertEqual(fh.read(), "after rotate\n")
        self.assertEqual(os.path.getsize(log + ".1"), 1_100_000)

    def test_live_stranger_in_the_record_is_never_signalled(self):
        stranger = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "server.py"])  # alive, ours, and looks like a server
        try:
            os.makedirs(self.env.rd, mode=0o700, exist_ok=True)
            with open(os.path.join(self.env.rd, "server.json"), "w") as fh:
                json.dump({"pid": stranger.pid, "port": NOBODY, "started": 0}, fh)  # pid reuse, or a record edited by hand
            self.assertEqual(self.run_ctl("stop"), (0, "not running\n"))
            self.assertIsNone(stranger.poll(), "stop signalled a process that is not this server")
            self.assertEqual(self.run_ctl("status")[0], 3)
        finally:
            stranger.kill()
            stranger.wait()

    def test_hand_edited_records_are_ignored(self):
        os.makedirs(self.env.rd, mode=0o700, exist_ok=True)
        for text in ('{"pid": -1, "port": %d, "started": 0}' % NOBODY, '{"pid": 0, "port": %d, "started": 0}' % NOBODY,
                     '{"pid": true, "port": %d, "started": 0}' % NOBODY, '{"pid": %d, "port": 70000, "started": 0}' % os.getpid(),
                     '{"pid": %d, "port": "x"}' % os.getpid(), '[1]', '{"pid": 1', '', '{"v": 99, "pid": %d, "port": %d, "started": 0}' % (os.getpid(), NOBODY)):
            with open(os.path.join(self.env.rd, "server.json"), "w") as fh:
                fh.write(text)
            self.assertEqual(self.run_ctl("status")[0], 3, text)
            self.assertEqual(self.run_ctl("stop"), (0, "not running\n"), text)
        code, out = self.run_ctl("start")
        self.assertEqual(code, 0, out)
        rec = self.pidfile()
        self.assertEqual((rec["v"], set(rec)), (1, {"v", "pid", "port", "started"}))
        self.assertEqual(os.stat(os.path.join(self.env.rd, "server.json")).st_mode & 0o777, 0o600)

    def test_secrets_and_terminal_text_stay_out_of_files_and_answers(self):
        self.env.env["DESK_TEST_SECRET"] = "canary-6f1d2"
        self.assertEqual(self.run_ctl("start")[0], 0)
        token = re.search(rb'DESK_TOKEN="([^"]+)"', self.call("GET", "/")[1]).group(1).decode()
        self.assertEqual(self.call("POST", "/api/term/open", {"id": SID, "cols": 80, "rows": 24}, token)[0], 200)
        self.assertEqual(self.call("POST", "/api/term/input", {"id": SID, "data": "typed-4b7e\r"}, token)[0], 200)
        conn = http.client.HTTPConnection("127.0.0.1", self.port(), timeout=10)
        conn.request("GET", f"/api/term/stream?id={SID}", headers={"Host": f"127.0.0.1:{self.port()}"})
        self.assertIn("got typed-4b7e", read_until(conn.getresponse(), "got typed-4b7e")[0])
        conn.close()
        answers = self.call("GET", "/api/health")[1] + self.call("GET", "/api/sessions")[1] + self.run_ctl("status")[1].encode()
        self.run_ctl("stop")
        self.run_ctl("stop-terminals")
        for base, _, names in os.walk(self.env.rd):
            for n in names:
                if os.path.isfile(os.path.join(base, n)):
                    with open(os.path.join(base, n), "rb") as fh:
                        answers += fh.read()
        for word in (b"canary-6f1d2", b"typed-4b7e", token.encode()):
            self.assertNotIn(word, answers)

    def test_bad_verb_prints_usage(self):
        code, out = self.run_ctl("launch")
        self.assertEqual(code, 2)
        self.assertIn("usage:", out)


VERSION_CLI = """#!/bin/sh
[ "$1" = "--version" ] && { echo "9.9.9 (stub)"; exit 0; }
exit 1
"""


class DoctorTest(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.env.env["PORT"] = "0"
        cli = os.path.join(self.env.tmp, "version-cli")
        with open(cli, "w") as fh:
            fh.write(VERSION_CLI)
        os.chmod(cli, 0o755)
        self.env.env["DESK_CLAUDE_BIN"] = cli

    def tearDown(self):
        subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "stop"], env=self.env.env, capture_output=True, timeout=60)
        self.assertEqual(self.env.close(), [], "orphan processes after the test")

    def doctor(self, **env):
        """Run the doctor verb; returns (exit code, output)."""
        r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "doctor"], cwd=self.env.tmp, env=dict(self.env.env, **env),
                           capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def test_all_pass_on_a_fresh_folder_and_nothing_is_created(self):
        before = sorted(os.listdir(self.env.tmp))
        code, out = self.doctor()
        self.assertEqual(code, 0, out)
        for name in ("python", "cli", "data folder", "state folder", "run folder", "port", "stats cache", "terminal host"):
            self.assertRegex(out, rf"(?m)^ok +{name} ")
        self.assertIn("9.9.9 (stub)", out)
        self.assertIn("all checks passed", out)
        self.assertEqual(sorted(os.listdir(self.env.tmp)), before, "doctor wrote files")

    def test_failures_are_listed_and_exit_one(self):
        busy = socket.socket()
        busy.bind(("127.0.0.1", 0))
        busy.listen(1)
        stats = os.path.join(self.env.tmp, ".stats-cache-%s.json" % hashlib.sha1(os.path.realpath(self.env.home).encode()).hexdigest()[:12])
        with open(stats, "w") as fh:
            fh.write('{"half":')
        try:
            code, out = self.doctor(PORT=str(busy.getsockname()[1]), DESK_CLAUDE_BIN=os.path.join(self.env.tmp, "missing-cli"))
        finally:
            busy.close()
        self.assertEqual(code, 1, out)
        self.assertRegex(out, r"(?m)^FAIL +port .*PORT=9000")
        for name in ("cli", "stats cache"):
            self.assertRegex(out, rf"(?m)^warn +{name} ")  # the app still runs: not a failure
        self.assertIn("1 check(s) failed, 2 warning(s)", out)
        self.assertRegex(out, r"(?m)^ +setup +data folder ok, \d+ sessions, cli missing, state folder ok$")
        self.assertIn("The `claude` command was not found", out)
        self.assertNotIn('"half"', out)

    def test_port_of_our_own_server_passes(self):
        self.assertEqual(subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "start"], cwd=self.env.tmp, env=self.env.env,
                                        capture_output=True, timeout=60).returncode, 0)
        with open(os.path.join(self.env.rd, "server.json")) as fh:
            rec = json.load(fh)
        code, out = self.doctor(PORT=str(rec["port"]))
        self.assertEqual(code, 0, out)
        self.assertIn(f"used by this app (pid {rec['pid']})", out)

    def test_own_server_on_another_port_passes_without_port_set(self):
        self.assertEqual(subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "start"], cwd=self.env.tmp, env=self.env.env,
                                        capture_output=True, timeout=60).returncode, 0)
        with open(os.path.join(self.env.rd, "server.json")) as fh:
            rec = json.load(fh)
        env = {k: v for k, v in self.env.env.items() if k != "PORT"}
        r = subprocess.run([sys.executable, os.path.join(ROOT, "server.py"), "doctor"], cwd=self.env.tmp, env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertRegex(r.stdout, rf"(?m)^ok +port +{rec['port']} used by this app \(pid {rec['pid']}\)")


class StopIdentityTest(unittest.TestCase):
    """stop reads the server's exact start time and checks it again right before each signal, so a pid reused meanwhile is never signalled."""

    def run_stop(self, idents):
        """Run stop against a fake live server whose start time reads as idents, one per check; returns (signals sent, output)."""
        rec, sent = {"v": 1, "pid": 4242, "port": NOBODY, "started": 1, "health": {"pid": 4242, "started": 1}}, []
        with mock.patch.object(ctl, "running", return_value=rec), mock.patch.object(ctl, "health", return_value={"pid": 4242, "started": 1}), \
                mock.patch.object(ctl, "proc_start", side_effect=idents, create=True), mock.patch.object(ctl, "alive", return_value=True), \
                mock.patch.object(ctl.os, "kill", side_effect=lambda pid, sig: sent.append((pid, sig))), mock.patch.object(ctl, "STOP_WAIT", 0.2), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            ctl.stop()
        return [sig for _, sig in sent], out.getvalue()

    def test_pid_reused_during_the_wait_gets_no_forced_kill(self):
        sent, out = self.run_stop(["Mon 1", "Mon 1", "Mon 2"] + ["Mon 2"] * 50)
        self.assertEqual(sent, [signal.SIGTERM])
        self.assertIn("stopped pid 4242", out)

    def test_pid_reused_before_the_first_signal_gets_none(self):
        sent, out = self.run_stop(["Mon 1", "Mon 2"] + ["Mon 2"] * 50)
        self.assertEqual(sent, [])
        self.assertIn("not running", out)

    def test_same_server_is_killed_after_the_wait(self):
        sent, out = self.run_stop(["Mon 1"] * 50)
        self.assertEqual(sent, [signal.SIGTERM, signal.SIGKILL])
        self.assertIn("killed", out)

    def test_start_time_reads(self):
        self.assertTrue(ctl.proc_start(os.getpid()))
        dead = subprocess.Popen(["true"])
        dead.wait()
        self.assertIsNone(ctl.proc_start(dead.pid))


if __name__ == "__main__":
    unittest.main()
