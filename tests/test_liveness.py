"""The feed's cheap live-process view equals sessions.holders() and sessions.helpers() and costs no subprocess, read or listing when nothing changed."""
import json
import os
import subprocess
import sys
import time
import unittest
from unittest import mock

from helpers import S1, S2, S3, S4, S5, FakeHome
from desk import events, liveness, sessions


def dead_pid():
    """A pid that existed a moment ago and is gone now."""
    p = subprocess.Popen(["/bin/sh", "-c", "exit 0"])
    p.wait()
    return p.pid


class Counter:
    """Counts subprocess starts, folder listings and file opens while active."""

    def __enter__(self):
        self.n = {"spawn": 0, "list": 0, "open": 0}
        real = {"spawn": subprocess.Popen.__init__, "scandir": os.scandir, "listdir": os.listdir, "walk": os.walk, "open": open}

        def spawn(this, *a, **k):
            """Count a subprocess start."""
            self.n["spawn"] += 1
            return real["spawn"](this, *a, **k)

        def count(kind, fn):
            """A counting wrapper."""
            return lambda *a, **k: (self.n.__setitem__(kind, self.n[kind] + 1), fn(*a, **k))[1]
        self.patches = [mock.patch.object(subprocess.Popen, "__init__", spawn), mock.patch("os.scandir", count("list", real["scandir"])),
                        mock.patch("os.listdir", count("list", real["listdir"])), mock.patch("os.walk", count("list", real["walk"])),
                        mock.patch("builtins.open", count("open", real["open"]))]
        for p in self.patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self.patches:
            p.stop()


class HoldersTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.start = sessions.process_starts([os.getpid()]).get(os.getpid(), "")
        sessions._starts.update(pids=(), at=0.0, map={})

    def tearDown(self):
        self.home.close()

    def test_same_answer_as_sessions_holders(self):
        self.assertTrue(self.start, "ps gave no start time for this process")
        self.home.register(S1, procStart=self.start)  # live, start matches
        self.home.register(S2, procStart="Mon Jan  1 00:00:00 2001")  # pid reused by this process: stale entry
        self.home.register(S3)  # live, no recorded start
        self.home.register(S4, pid=dead_pid(), procStart=self.start)  # dead pid
        self.home.register(S5, pid=1, procStart=self.start)  # another user's process: signal 0 is refused
        self.home.register(S5, pid=2 ** 40)  # impossible pid
        self.home.register(S1, status="busy", parkedJobId="j1")  # parked
        want = sessions.holders()
        self.assertEqual(sorted(want), sorted([S1, S3]))
        self.assertEqual(liveness.holders(), want)
        with open(os.path.join(self.home.home, "sessions", "3.json"), "w") as fh:
            json.dump({"pid": os.getpid(), "sessionId": S3, "status": "busy", "statusUpdatedAt": 5, "entrypoint": "cli"}, fh)
        self.assertEqual(liveness.holders(), sessions.holders())
        os.remove(os.path.join(self.home.home, "sessions", "1.json"))
        self.assertEqual(liveness.holders(), sessions.holders())
        self.assertNotIn(S1, liveness.holders())

    def test_idle_pass_spawns_reads_and_lists_nothing(self):
        self.home.register(S1, procStart=self.start)
        self.home.register(S2)
        first = liveness.holders()
        with Counter() as c:
            for _ in range(5):
                self.assertEqual(liveness.holders(), first)
        self.assertEqual(c.n, {"spawn": 0, "list": 0, "open": 0})

    def test_kernel_watched_registry_is_not_even_stat_ed(self):
        self.home.register(S1, procStart=self.start)
        liveness.holders()
        watched = set(liveness._state["regkeys"])
        real, seen = os.stat, []
        with mock.patch("os.stat", side_effect=lambda p, *a, **k: (seen.append(p), real(p, *a, **k))[1]):
            liveness.holders(kernel=True, watched=watched, woke=set())
        self.assertEqual([p for p in seen if "sessions" in str(p)], [])
        self.home.register(S2)
        self.assertNotIn(S2, liveness.holders(kernel=True, watched=watched, woke=set()))  # unseen until the kernel says so
        self.assertIn(S2, liveness.holders(kernel=True, watched=watched, woke={os.path.join(self.home.home, "sessions")}))

    def test_reused_pid_is_caught_by_its_start_token(self):
        self.home.register(S1, procStart=self.start)
        calls = []
        real = sessions.process_starts
        with mock.patch.object(sessions, "process_starts", side_effect=lambda pids: (calls.append(set(pids)), real(pids))[1]):
            self.assertIn(S1, liveness.holders())
            for _ in range(3):
                liveness.holders()
            self.assertEqual(len(calls), 1, "ps asked again although the pid kept its start time")
            with mock.patch.object(liveness, "token", return_value=("other", 1)), \
                    mock.patch.object(sessions, "process_starts", return_value={os.getpid(): "Tue Feb  2 00:00:00 2021"}):
                self.assertNotIn(S1, liveness.holders())  # the pid now names another process

    def test_slow_revalidation_and_ps_failure_retry(self):
        self.home.register(S1, procStart=self.start)
        with mock.patch.object(sessions, "process_starts", return_value={}) as ps:
            self.assertIn(S1, liveness.holders())  # ps did not answer: kept, as holders() keeps it
            liveness.holders()
            self.assertEqual(ps.call_count, 1)
            with mock.patch.object(liveness, "RETRY", 0):
                liveness.holders()
            self.assertEqual(ps.call_count, 2)
        with mock.patch.object(liveness, "RETRY", 0):
            liveness.holders()  # ps answers now
        with mock.patch.object(sessions, "process_starts", return_value={os.getpid(): self.start}) as ps:
            liveness.holders()
            self.assertEqual(ps.call_count, 0)
            with mock.patch.object(liveness, "SLOW", 0), mock.patch.object(liveness, "SLOW_BLIND", 0):
                liveness.holders()
            self.assertEqual(ps.call_count, 1)

    @unittest.skipUnless(sys.platform == "darwin" or sys.platform.startswith("linux"), "no native start time here")
    def test_native_start_token(self):
        me = liveness.token(os.getpid())
        self.assertIsNotNone(me)
        self.assertEqual(liveness.token(os.getpid()), me)
        self.assertIsNone(liveness.token(dead_pid()))
        child = subprocess.Popen(["/bin/sleep", "5"])
        try:
            self.assertNotEqual(liveness.token(child.pid), None)
        finally:
            child.kill()
            child.wait()
        self.assertIsNone(liveness.token(-5))
        self.assertIsNone(liveness.token(2 ** 40))


class HelpersTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()
        self.path = self.home.path(S3)
        self.sub = self.path[:-6] + "/subagents"

    def tearDown(self):
        self.home.close()

    def same(self):
        """The cached list equals the data module's."""
        self.assertEqual(liveness.helpers(self.path), sessions.helpers(self.path))

    def test_follows_every_kind_of_subagent_change(self):
        self.same()
        self.assertTrue(sessions.helpers(self.path))
        os.utime(self.sub + "/agent-a3.jsonl", None)  # a stale helper writes again: it comes back
        self.same()
        with open(self.sub + "/agent-a1.meta.json", "w") as fh:
            json.dump({"agentType": "Explore", "description": "first", "finished": True}, fh)
        self.same()
        os.makedirs(self.sub + "/deep")
        for ext, body in ((".meta.json", '{"description": "nested"}'), (".jsonl", "{}\n")):
            with open(self.sub + "/deep/agent-n" + ext, "w") as fh:
                fh.write(body)
        self.same()
        self.assertIn("nested", liveness.helpers(self.path))
        os.remove(self.sub + "/agent-a2.meta.json")
        self.same()
        other = self.home.path(S1)
        self.assertEqual(liveness.helpers(other), sessions.helpers(other))  # no subagents folder yet
        os.makedirs(other[:-6] + "/subagents")
        for ext, body in ((".meta.json", '{"description": "late"}'), (".jsonl", "{}\n")):
            with open(other[:-6] + "/subagents/agent-l" + ext, "w") as fh:
                fh.write(body)
        self.assertEqual(liveness.helpers(other), ["late"])

    def test_age_cut_off_passes_without_a_file_change(self):
        old = time.time() - liveness.AGE + 0.5
        for name in ("agent-a1", "agent-a2", "agent-a3"):
            os.utime(f"{self.sub}/{name}.jsonl", (old, old))
        first = liveness.helpers(self.path)
        self.same()
        time.sleep(0.7)
        self.assertNotEqual(sessions.helpers(self.path), first)
        self.same()

    def test_idle_pass_lists_and_reads_nothing(self):
        liveness.helpers(self.path)
        with Counter() as c:
            for _ in range(5):
                liveness.helpers(self.path)
        self.assertEqual(c.n, {"spawn": 0, "list": 0, "open": 0})


class FeedTest(unittest.TestCase):
    def setUp(self):
        self.home = FakeHome()

    def tearDown(self):
        self.home.close()

    def test_snapshot_parts_equal_the_data_module(self):
        self.home.register(S3)
        events.snapshot()
        part = events._scan["parts"][S3]
        self.assertIn(repr(sessions.helpers(self.home.path(S3))), part)
        hold = sessions.holders()[S3][0]
        self.assertIn(repr((S3, [(hold["pid"], str(hold["status"]), hold["at"], str(hold["name"]), hold["entry"])])), part)


if __name__ == "__main__":
    unittest.main()
